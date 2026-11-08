/**
 * The memory's model for real: the Memory host's Complete port on the Claude API. The memory's own
 * instructions go as the system text and its schema as the output format, as the host CLI hands
 * them to its configured model command; nothing here interprets them.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { jsonSchemaOutputFormat } from "@anthropic-ai/sdk/helpers/json-schema";
import { hostPlanningInstructions } from "eumenes-memory-host/meaning/planning";
import { hostGroundingInstructions } from "eumenes-memory-host/meaning/retrieval";
import type { Complete } from "../examples/virtual-eumenes/agenda/host-memory.ts";
import {
	createClaudeClient,
	type ClaudeRole,
	type UsageMeter,
} from "./claude.ts";

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
