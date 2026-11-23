/**
 * The validation host's Web researcher, based on Eumenes web.note. It sees the request and
 * returns a Markdown note. Codex is the standard backend, with provider search available
 * when the Codex CLI is missing. The note is reference data for the conversation.
 */
import type Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import {
	createClaudeClient,
	type ClaudeRole,
	type UsageMeter,
} from "./claude.ts";
import { apiKeyFromEnvironment } from "./api-keys.ts";
import { settleOpenAI } from "./openai.ts";
import { openaiUsage } from "./usage.ts";
import {
	codexWebNoteWriter,
	parseNote,
	webNoteSystem,
	type NoteWriter,
} from "../runtime/agenda/web-research.ts";

/** Visible note budget; the role's thinking headroom comes on top. */
const noteTokens = 4000;

/**
 * A note writer backed by web search (the basic tool: with Haiku the dynamic-filtering version
 * failed in the 2026-11-07 probe). It thinks at the role's effort, as every other call does:
 * left at the default, the thinking used up the output budget before the note (2026-11-08 CLI:
 * two empty results, one note cut off). Token usage goes to `meter`; searches are counted apart.
 */
export function webNoteWriter(input: {
	readonly role: Pick<ClaudeRole, "model" | "effort" | "thinkingHeadroom">;
	readonly meter: UsageMeter;
	readonly today: () => string;
	readonly client?: Anthropic;
	readonly maxUses?: number;
}): { writer: NoteWriter; searches: () => number } {
	const client =
		input.client ?? createClaudeClient({ maxRetries: 1, timeout: 180_000 });
	let searches = 0;
	const writer: NoteWriter = async (request) => {
		const messages: Anthropic.MessageParam[] = [
			{ role: "user", content: request },
		];
		// pause_turn: the server's search loop paused; re-send to let it resume.
		for (let round = 0; round < 3; round++) {
			const r = await client.messages.create({
				model: input.role.model,
				max_tokens: noteTokens + input.role.thinkingHeadroom,
				output_config: { effort: input.role.effort },
				system: webNoteSystem(input.today()),
				messages,
				tools: [
					{
						type: "web_search_20250305",
						name: "web_search",
						max_uses: input.maxUses ?? 3,
					},
				],
			});
			input.meter.record(r.model, r.usage);
			searches += r.usage.server_tool_use?.web_search_requests ?? 0;
			if (r.stop_reason === "pause_turn") {
				messages.push({ role: "assistant", content: r.content });
				continue;
			}
			const text = r.content
				.flatMap((b) => (b.type === "text" ? [b.text] : []))
				.join("")
				.trim();
			const cut = r.stop_reason === "max_tokens";
			if (text === "")
				throw new Error(
					cut ? "メモを書く前に出力の上限に達した" : "調べた結果が空だった",
				);
			const note = parseNote(text);
			// A note cut short still holds what was found; say where it stops.
			return cut
				? {
						...note,
						markdown: `${note.markdown}\n\n（メモはここで途切れています）`,
					}
				: note;
		}
		throw new Error("調べものが時間内に終わらなかった");
	};
	return { writer, searches: () => searches };
}

/** The same researcher on the OpenAI Responses API and its web search tool. */
export function openaiWebNoteWriter(input: {
	readonly role: Pick<ClaudeRole, "model" | "effort" | "thinkingHeadroom">;
	readonly meter: UsageMeter;
	readonly today: () => string;
	readonly client?: OpenAI;
	readonly maxUses?: number;
}): { writer: NoteWriter; searches: () => number } {
	const client =
		input.client ??
		new OpenAI({
			apiKey: apiKeyFromEnvironment("openai"),
			maxRetries: 1,
			timeout: 180_000,
		});
	const record = input.meter.recordProvider?.bind(input.meter);
	if (!record) throw new Error("OpenAI requires normalized usage accounting");
	let searches = 0;
	const writer: NoteWriter = async (request) => {
		const r = await client.responses.create({
			model: input.role.model,
			instructions: webNoteSystem(input.today()),
			input: request,
			store: false,
			reasoning: { effort: input.role.effort },
			max_output_tokens: noteTokens + input.role.thinkingHeadroom,
			tools: [{ type: "web_search" }],
			max_tool_calls: input.maxUses ?? 3,
		});
		searches += r.output.filter((i) => i.type === "web_search_call").length;
		const cut =
			r.status === "incomplete" &&
			r.incomplete_details?.reason === "max_output_tokens";
		// A note cut short still holds what was found: read it, where settling would throw.
		let text: string;
		if (cut) {
			if (r.usage) record(openaiUsage(r.model, r.usage, r.id));
			text = r.output
				.flatMap((i) =>
					i.type === "message"
						? i.content.flatMap((c) =>
								c.type === "output_text" ? [c.text] : [],
							)
						: [],
				)
				.join("")
				.trim();
		} else text = settleOpenAI(r, input.role.model, (u) => record(u)).trim();
		if (text === "")
			throw new Error(
				cut ? "メモを書く前に出力の上限に達した" : "調べた結果が空だった",
			);
		const note = parseNote(text);
		return cut
			? {
					...note,
					markdown: `${note.markdown}\n\n（メモはここで途切れています）`,
				}
			: note;
	};
	return { writer, searches: () => searches };
}

/** The researcher on the role's provider. */
export const webNoteWriterFor = (input: {
	readonly role: Pick<
		ClaudeRole,
		"provider" | "model" | "effort" | "thinkingHeadroom"
	>;
	readonly meter: UsageMeter;
	readonly today: () => string;
	readonly claudeClient?: () => Anthropic;
}) =>
	(input.role.provider ?? "anthropic") === "openai"
		? openaiWebNoteWriter(input)
		: webNoteWriter(
				input.claudeClient ? { ...input, client: input.claudeClient() } : input,
			);

/** The interactive CLI and the live evaluation use the same research backend selection. */
export function agendaWebNoteWriter(
	input: Parameters<typeof webNoteWriterFor>[0],
) {
	const command = Bun.which("codex");
	return command
		? {
				backend: "codex" as const,
				...codexWebNoteWriter({ today: input.today, command }),
			}
		: {
				backend: input.role.provider ?? "anthropic",
				...webNoteWriterFor(input),
			};
}
