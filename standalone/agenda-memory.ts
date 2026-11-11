/**
 * The memory's model for real: the Memory host's Complete port on the Claude API (or OpenAI's,
 * for evaluation runs while the Claude API is not available). The memory's own instructions go as
 * the system text and its schema as the output format, as the host CLI hands them to its
 * configured model command; nothing here interprets them.
 */
import type Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { jsonSchemaOutputFormat } from "@anthropic-ai/sdk/helpers/json-schema";
import { hostPlanningInstructions } from "eumenes-memory-host/meaning/planning";
import { hostGroundingInstructions } from "eumenes-memory-host/meaning/retrieval";
import type { Complete } from "../examples/virtual-eumenes/agenda/host-memory.ts";
import { apiKeyFromEnvironment } from "./api-keys.ts";
import {
	createClaudeClient,
	type ClaudeRole,
	type UsageMeter,
} from "./claude.ts";
import { settleOpenAI } from "./openai.ts";

/** The host CLI's output budget for one memory call; the role's thinking headroom comes on top. */
const memoryTokens = 4096;

export function claudeMemoryModel(input: {
	readonly role: Pick<ClaudeRole, "model" | "effort" | "thinkingHeadroom">;
	readonly meter: UsageMeter;
	readonly client?: Anthropic;
}): Complete {
	const client =
		input.client ?? createClaudeClient({ maxRetries: 1, timeout: 120_000 });
	return async (prompt, schema, task) => {
		const r = await client.messages.create({
			model: input.role.model,
			max_tokens: memoryTokens + input.role.thinkingHeadroom,
			system:
				task === "decide"
					? hostPlanningInstructions
					: hostGroundingInstructions,
			messages: [{ role: "user", content: prompt }],
			output_config: {
				effort: input.role.effort,
				// The SDK moves constraints the API does not take (maxItems, minimum...) to a check.
				format: jsonSchemaOutputFormat(schema as { type: "object" }),
			},
		});
		input.meter.record(r.model, r.usage);
		if (r.stop_reason === "max_tokens")
			throw new Error("memory model output reached the token limit");
		return {
			raw: r.content
				.flatMap((b) => (b.type === "text" ? [b.text] : []))
				.join(""),
			threadId: null,
			usage: {
				input_tokens: r.usage.input_tokens,
				output_tokens: r.usage.output_tokens,
			},
		};
	};
}

/**
 * The same port on the OpenAI Responses API. The schema is enforced (strict): given loosely, Luna put
 * `groups` and `relations` beside `proposal` instead of inside it, and the host refused every
 * decision (CLI 2026-11-11). The host's schemas fit strict mode: every key required, none extra.
 */
export function openaiMemoryModel(input: {
	readonly role: Pick<ClaudeRole, "model" | "effort" | "thinkingHeadroom">;
	readonly meter: UsageMeter;
	readonly client?: OpenAI;
}): Complete {
	const client =
		input.client ??
		new OpenAI({
			apiKey: apiKeyFromEnvironment("openai"),
			maxRetries: 4,
			timeout: 120_000,
		});
	const record = input.meter.recordProvider?.bind(input.meter);
	if (!record) throw new Error("OpenAI requires normalized usage accounting");
	return async (prompt, schema, task) => {
		const r = await client.responses.create({
			model: input.role.model,
			instructions:
				task === "decide"
					? hostPlanningInstructions
					: hostGroundingInstructions,
			input: prompt,
			store: false,
			reasoning: { effort: input.role.effort },
			max_output_tokens: memoryTokens + input.role.thinkingHeadroom,
			text: {
				format: {
					type: "json_schema",
					name: "memory_result",
					schema: schema as Record<string, unknown>,
					strict: true,
				},
			},
		});
		const raw = settleOpenAI(r, input.role.model, (u) => record(u));
		return {
			raw,
			threadId: null,
			usage: {
				input_tokens: r.usage!.input_tokens,
				output_tokens: r.usage!.output_tokens,
			},
		};
	};
}

/** The memory's model on the role's provider. */
export const memoryModel = (input: {
	readonly role: Pick<
		ClaudeRole,
		"provider" | "model" | "effort" | "thinkingHeadroom"
	>;
	readonly meter: UsageMeter;
	/** The Claude client, when the role is Claude's (its retries at the rate limit). */
	readonly claudeClient?: Anthropic;
}): Complete =>
	input.role.provider === "openai"
		? openaiMemoryModel(input)
		: claudeMemoryModel({
				...input,
				...(input.claudeClient ? { client: input.claudeClient } : {}),
			});
