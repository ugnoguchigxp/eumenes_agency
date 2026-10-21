import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import {
	type ChatPort,
	LlmCallError,
	LlmOutputError,
	type LlmPort,
	type LlmRequest,
	type LlmResult,
} from "../src/contracts/index.ts";

export interface ClaudeRole {
	/** Model id from settings; never defaulted in code. */
	readonly model: string;
	readonly effort: "low" | "medium" | "high" | "xhigh" | "max";
	/** Room for adaptive thinking on top of the visible answer. */
	readonly thinkingHeadroom: number;
}

export interface UsageMeter {
	record(model: string, usage: Anthropic.Usage): void;
	/** Throws before a call when the spend limit has been reached. */
	assertWithinLimit(): void;
	spentUsd(): number;
}

const maxTokensCap = 16000;
/** Visible answer budget for a main-conversation reply (thinking comes on top). */
const chatAnswerTokens = 1200;

const textOf = (response: Anthropic.Message): string =>
	response.content
		.filter((b): b is Anthropic.TextBlock => b.type === "text")
		.map((b) => b.text)
		.join("");

const billed = (usage: Anthropic.Usage) => ({
	inputTokens: usage.input_tokens + (usage.cache_creation_input_tokens ?? 0),
	outputTokens: usage.output_tokens,
});

/** Records usage first, then maps unusable stop reasons to LlmOutputError. */
function settle(
	response: Anthropic.Message,
	meter: UsageMeter,
): { text: string; model: string } {
	meter.record(response.model, response.usage);
	if (response.stop_reason === "refusal")
		throw new LlmOutputError("refusal", response.model, billed(response.usage));
	if (response.stop_reason === "max_tokens")
		throw new LlmOutputError(
			"max_tokens",
			response.model,
			billed(response.usage),
		);
	return { text: textOf(response), model: response.model };
}

const isAbort = (error: unknown): boolean =>
	error instanceof Anthropic.APIUserAbortError ||
	(error instanceof Error && error.name === "AbortError");

/** Only status and error type reach the core: never message bodies or keys. */
function mapSdkError(error: unknown, signal: AbortSignal): unknown {
	if (signal.aborted || isAbort(error)) return error;
	if (error instanceof Anthropic.APIConnectionError)
		return new LlmCallError("connection", true);
	if (error instanceof Anthropic.APIError && error.status !== undefined)
		return new LlmCallError(
			`api_${error.status}:${error.type ?? "unknown"}`,
			error.status === 429 || error.status >= 500,
		);
	return error;
}

/** Spend gate plus SDK failure mapping around exactly one request. */
async function guarded<R>(
	meter: UsageMeter,
	signal: AbortSignal,
	send: () => Promise<R>,
): Promise<R> {
	try {
		meter.assertWithinLimit();
	} catch {
		throw new LlmCallError("spend_limit", false);
	}
	try {
		return await send();
	} catch (error) {
		throw mapSdkError(error, signal);
	}
}

/** Core calls: the runtime counts its single retry in the budget, so the SDK never retries. */
export const llmClient = (): Anthropic => new Anthropic({ maxRetries: 0 });
/** CLI conversation: no budgeted retry above it, so let the SDK retry transient failures. */
export const chatClient = (): Anthropic => new Anthropic({ maxRetries: 2 });

/** One stateless structured call per request: every call is a fresh context. */
export function createClaudeLlm(
	role: ClaudeRole,
	meter: UsageMeter,
	client: Anthropic = llmClient(),
): LlmPort {
	return {
		async complete<T>(
			request: LlmRequest<T>,
			signal: AbortSignal,
		): Promise<LlmResult<T>> {
			const started = performance.now();
			// create (not parse) so usage is recorded even when the JSON is cut off or malformed.
			const response = await guarded(meter, signal, () =>
				client.messages.create(
					{
						model: role.model,
						max_tokens: Math.min(
							maxTokensCap,
							request.maxOutputTokens + role.thinkingHeadroom,
						),
						system: request.system,
						messages: [{ role: "user", content: request.prompt }],
						output_config: {
							effort: role.effort,
							format: zodOutputFormat(request.schema),
						},
					},
					{ signal },
				),
			);
			const { text, model } = settle(response, meter);
			let parsed: ReturnType<typeof request.schema.safeParse>;
			try {
				parsed = request.schema.safeParse(JSON.parse(text));
			} catch {
				throw new LlmOutputError("parse", model, billed(response.usage));
			}
			if (!parsed.success)
				throw new LlmOutputError("schema", model, billed(response.usage));
			return {
				value: parsed.data,
				model,
				...billed(response.usage),
				cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
				latencyMs: performance.now() - started,
			};
		},
	};
}

/** Free-text reply for the CLI main conversation. */
export function createClaudeChat(
	role: ClaudeRole,
	meter: UsageMeter,
	client: Anthropic = chatClient(),
): ChatPort {
	return {
		async reply(system, turns, signal) {
			const response = await guarded(meter, signal, () =>
				client.messages.create(
					{
						model: role.model,
						max_tokens: Math.min(
							maxTokensCap,
							chatAnswerTokens + role.thinkingHeadroom,
						),
						system,
						messages: turns.map((t) => ({ role: t.role, content: t.text })),
						output_config: { effort: role.effort },
					},
					{ signal },
				),
			);
			return settle(response, meter);
		},
	};
}
