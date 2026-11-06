import type Anthropic from "@anthropic-ai/sdk";
import type OpenAI from "openai";
import {
	createClaudeClient,
	createClaudeLlm,
	createClaudeReply,
	type ClaudeRole,
	type UsageMeter,
} from "./claude.ts";
import {
	createOpenAIClient,
	createOpenAILlm,
	createOpenAIReply,
} from "./openai.ts";
import { anthropicUsage, type ProviderUsage } from "./usage.ts";
import type { LlmPort, ReplyPort } from "../src/index.ts";
import { factoringFetch } from "./schema.ts";
import { LlmOutputError } from "../src/index.ts";

function accounting(
	role: ClaudeRole,
	meter: UsageMeter,
	maxOutput: number,
	cacheWrites?: import("./usage.ts").CacheWritePolicy,
) {
	meter.assertWithinLimit();
	const provider = role.provider ?? "anthropic";
	if (provider === "openai" && !meter.recordProvider)
		throw new Error("OpenAI requires normalized usage accounting");
	const reservation = meter.reserve?.(
		provider,
		role.model,
		Math.min(16000, maxOutput + role.thinkingHeadroom),
		cacheWrites,
	);
	return {
		record: (u: ProviderUsage) => {
			if (!meter.recordProvider)
				throw new Error("normalized usage accounting missing");
			meter.recordProvider(u, reservation);
		},
		claude: {
			assertWithinLimit() {},
			spentUsd: () => meter.spentUsd(),
			record(model: string, usage: Anthropic.Usage) {
				if (meter.recordProvider)
					meter.recordProvider(anthropicUsage(model, usage), reservation);
				else meter.record(model, usage);
				if (model !== role.model)
					throw new LlmOutputError("model_not_confirmed", model, {
						inputTokens: anthropicUsage(model, usage).inputTokens,
						outputTokens: usage.output_tokens,
					});
			},
		},
	};
}

export function createProviderLlm(
	role: ClaudeRole,
	meter: UsageMeter,
	client?: Anthropic | OpenAI,
): LlmPort {
	const provider = role.provider ?? "anthropic";
	const connection =
		client ??
		(provider === "openai"
			? createOpenAIClient()
			: createClaudeClient({
					maxRetries: 0,
					timeout: 60_000,
					fetch: factoringFetch,
				}));
	return {
		async complete(req, signal) {
			signal.throwIfAborted();
			// createClaudeLlm sends only strings/schema, without top-level or block cache_control.
			// Anthropic Messages caching is opt-in; keep the full-context/output bound and margin.
			const a = accounting(
				role,
				meter,
				req.maxOutputTokens,
				provider === "anthropic" ? "disabled" : undefined,
			);
			if (provider === "openai")
				return createOpenAILlm(role, a.record, connection as OpenAI).complete(
					req,
					signal,
				);
			return createClaudeLlm(role, a.claude, connection as Anthropic).complete(
				req,
				signal,
			);
		},
	};
}

/** One port owns one reply flow; a shared concurrent invocation is rejected before billing. */
export function createProviderReply(
	role: ClaudeRole,
	meter: UsageMeter,
	client?: Anthropic | OpenAI,
): ReplyPort {
	let active: ReturnType<typeof accounting> | null = null;
	const provider = role.provider ?? "anthropic";
	const port =
		provider === "openai"
			? createOpenAIReply(
					role,
					(u) => active!.record(u),
					client as OpenAI | undefined,
				)
			: createClaudeReply(
					role,
					{
						assertWithinLimit() {},
						spentUsd: () => meter.spentUsd(),
						record: (model, usage) => active!.claude.record(model, usage),
					},
					(client as Anthropic | undefined) ??
						createClaudeClient({ maxRetries: 0, timeout: 60_000 }),
				);
	return {
		async complete(req, onDelta, signal) {
			signal.throwIfAborted();
			if (active) throw new Error("concurrent use of a reply port");
			active = accounting(role, meter, 1200);
			try {
				return await port.complete(req, onDelta, signal);
			} finally {
				active = null;
			}
		},
	};
}
