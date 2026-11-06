import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import type {
	Response,
	ResponseInputItem,
	ResponseOutputItem,
} from "openai/resources/responses/responses";
import {
	LlmCallError,
	LlmOutputError,
	type LlmPort,
	type ReplyPort,
} from "../src/index.ts";
import { apiKeyFromEnvironment } from "./api-keys.ts";
import { openaiUsage, type ProviderUsage } from "./usage.ts";
import type { ClaudeRole } from "./claude.ts";

export const createOpenAIClient = () =>
	new OpenAI({
		apiKey: apiKeyFromEnvironment("openai"),
		maxRetries: 0,
		timeout: 60_000,
	});

export function mapOpenAIError(e: unknown, signal: AbortSignal): never {
	if (signal.aborted || (e instanceof Error && e.name === "AbortError"))
		throw e;
	if (e instanceof OpenAI.APIConnectionError)
		throw new LlmCallError("connection", true);
	if (e instanceof OpenAI.APIError)
		throw new LlmCallError(
			`api_${e.status ?? 0}:${e.type ?? "unknown"}`,
			e.status === 429 || (e.status ?? 0) >= 500,
		);
	throw e;
}

const textOf = (r: Response) =>
	r.output
		.flatMap((i) =>
			i.type === "message"
				? i.content.flatMap((c) => (c.type === "output_text" ? [c.text] : []))
				: [],
		)
		.join("");
export function settleOpenAI(
	r: Response,
	requested: string,
	record: (u: ProviderUsage) => void,
): string {
	if (!r.usage) throw new LlmCallError("missing_usage", false);
	record(openaiUsage(r.model, r.usage, r.id));
	const usage = {
		inputTokens: r.usage.input_tokens,
		outputTokens: r.usage.output_tokens,
	};
	if (r.model !== requested)
		throw new LlmOutputError("model_not_confirmed", r.model, usage);
	if (
		r.output.some(
			(i) =>
				i.type === "message" && i.content.some((c) => c.type === "refusal"),
		)
	)
		throw new LlmOutputError("refusal", r.model, usage);
	if (r.status !== "completed")
		throw new LlmOutputError(
			r.incomplete_details?.reason === "max_output_tokens"
				? "max_tokens"
				: "incomplete",
			r.model,
			usage,
		);
	return textOf(r);
}

export function createOpenAILlm(
	role: ClaudeRole,
	record: (u: ProviderUsage) => void,
	client = createOpenAIClient(),
): LlmPort {
	return {
		async complete(req, signal) {
			const start = performance.now();
			try {
				const response = await client.responses.create(
					{
						model: role.model,
						instructions: req.system,
						input: req.prompt,
						store: false,
						service_tier: "default",
						reasoning: { effort: role.effort },
						max_output_tokens: Math.min(
							16000,
							req.maxOutputTokens + role.thinkingHeadroom,
						),
						text: { format: zodTextFormat(req.schema, "agency_result") },
					},
					{ signal },
				);
				const text = settleOpenAI(response, role.model, record);
				let raw: unknown;
				try {
					raw = JSON.parse(text);
				} catch {
					throw new LlmOutputError(
						"parse",
						response.model,
						response.usage
							? {
									inputTokens: response.usage.input_tokens,
									outputTokens: response.usage.output_tokens,
								}
							: null,
					);
				}
				const parsed = req.schema.safeParse(raw);
				if (!parsed.success)
					throw new LlmOutputError(
						"schema",
						response.model,
						response.usage
							? {
									inputTokens: response.usage.input_tokens,
									outputTokens: response.usage.output_tokens,
								}
							: null,
					);
				return {
					value: parsed.data,
					model: response.model,
					inputTokens: response.usage!.input_tokens,
					outputTokens: response.usage!.output_tokens,
					cacheReadTokens: response.usage!.input_tokens_details.cached_tokens,
					latencyMs: performance.now() - start,
				};
			} catch (e) {
				return mapOpenAIError(e, signal);
			}
		},
	};
}

/** Per-conversation opaque reasoning/tool continuity, never stored in ordinary traces. */
export function createOpenAIReply(
	role: ClaudeRole,
	record: (u: ProviderUsage) => void,
	client = createOpenAIClient(),
): ReplyPort {
	type Continuation = Extract<
		ResponseOutputItem,
		{ type: "reasoning" | "message" | "function_call" }
	>;
	const raw = new Map<string, Continuation[]>();
	return {
		async complete(request, onDelta, signal) {
			const input: ResponseInputItem[] = [];
			for (const m of request.messages) {
				if (m.role === "system") continue;
				if (m.role === "tool")
					input.push({
						type: "function_call_output",
						call_id: m.tool_call_id!,
						output: m.content,
					});
				else if (m.role === "assistant" && m.tool_calls?.length) {
					const cached = raw.get(m.tool_calls[0]!.id);
					if (cached) input.push(...cached);
					else {
						if (m.content)
							input.push({ role: "assistant", content: m.content });
						for (const c of m.tool_calls)
							input.push({
								type: "function_call",
								call_id: c.id,
								name: c.function.name,
								arguments: c.function.arguments,
							});
					}
				} else input.push({ role: m.role, content: m.content });
			}
			try {
				const response = await client.responses.create(
					{
						model: role.model,
						instructions: request.messages
							.filter((m) => m.role === "system")
							.map((m) => m.content)
							.join("\n\n"),
						input,
						store: false,
						service_tier: "default",
						reasoning: { effort: role.effort },
						max_output_tokens: Math.min(16000, 1200 + role.thinkingHeadroom),
						tools: request.tools.map((t) => ({
							type: "function" as const,
							name: t.name,
							description: t.description,
							parameters: t.parameters,
							strict: false,
						})),
					},
					{ signal },
				);
				const text = settleOpenAI(response, role.model, record);
				signal.throwIfAborted();
				const toolCalls = response.output.flatMap((i) =>
					i.type === "function_call"
						? [{ id: i.call_id, name: i.name, arguments: i.arguments }]
						: [],
				);
				if (toolCalls[0]) {
					raw.set(
						toolCalls[0].id,
						response.output
							.filter(
								(i): i is Continuation =>
									i.type === "reasoning" ||
									i.type === "message" ||
									i.type === "function_call",
							)
							.map((i) => {
								if (i.type !== "reasoning") return i;
								const { content: _privateContent, ...opaque } = i;
								return opaque;
							}),
					);
					if (raw.size > 64) raw.delete(raw.keys().next().value!);
				}
				if (text) onDelta(text);
				return { text, toolCalls };
			} catch (e) {
				return mapOpenAIError(e, signal);
			}
		},
	};
}
