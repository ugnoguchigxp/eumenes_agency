import { emotionEmojis, type EmotionEmoji } from "../contracts/emotion.ts";
import {
	SystemContextConfigurationError,
	ReplyOutputError,
} from "../contracts/errors.ts";
import { replyResultSchema } from "../contracts/ports.ts";
import { untilAborted } from "./abort.ts";
import { requireSystemText } from "./system-context.ts";
import type {
	ReplyMessage,
	ReplyPort,
	ReplyToolCall,
	ToolPort,
} from "../contracts/ports.ts";

/** Tool calls one reply may execute before the last chat call is made without tools. */
export const defaultMaxToolCalls = 4;

export interface RespondInput {
	/** Exactly one nonempty system message first, followed by history/data. Snapshotted, not modified. */
	readonly messages: readonly ReplyMessage[];
	readonly chat: ReplyPort;
	readonly tools: ToolPort;
	/** Default {@link defaultMaxToolCalls}. */
	readonly maxToolCalls?: number;
	/** The reply starts with one emoji of the feeling it is said with (see respondSystem). */
	readonly emotion: boolean;
	readonly signal: AbortSignal;
	/** Spoken text as it is produced: preambles and the answer, without the emotion emoji. */
	readonly onDelta: (text: string) => void;
}

export interface RespondResult {
	/** All spoken text (preambles and the answer, in order), without the emotion emoji. */
	readonly text: string;
	/** emotion mode: the leading emoji when it is one of the 15; undefined otherwise. */
	readonly emotion?: EmotionEmoji;
	/** A tool result ended the reply (`end: true`). */
	readonly ended: boolean;
	/** The tool calls that were executed, in order. */
	readonly calls: readonly {
		readonly name: string;
		readonly arguments: string;
		readonly content: string;
	}[];
}

const isEmotion = (s: string): s is EmotionEmoji =>
	(emotionEmojis as readonly string[]).includes(s);

const spaceOnly = /^\s*$/u;
const pictographic = /^\p{Extended_Pictographic}/u;

/**
 * Strips the leading emoji of one chat output from its stream. Only the head is buffered:
 * leading whitespace and a possibly incomplete emoji wait until the first non-space character
 * decides; afterwards text passes straight through.
 */
const createHeadFilter = (
	enabled: boolean,
	emit: (text: string) => void,
	found: (emoji: string) => void,
) => {
	// head: undecided | after: emoji removed, skipping the whitespace after it | body: pass through
	let mode: "head" | "after" | "body" = enabled ? "head" : "body";
	let held = "";
	let seen = false;
	const pass = (text: string) => {
		if (text === "") return;
		seen = true;
		emit(text);
	};
	const afterEmoji = (text: string) => {
		const rest = text.replace(/^[\s️]+/u, "");
		if (rest === "") return;
		mode = "body";
		pass(rest);
	};
	return {
		/** Whether any text has reached `push` (a port that does not stream never calls it). */
		get streamed() {
			return seen || held !== "" || mode === "after";
		},
		push(text: string): void {
			if (mode === "body") return pass(text);
			if (mode === "after") return afterEmoji(text);
			held += text;
			if (spaceOnly.test(held)) return;
			const start = held.search(/\S/u);
			const body = held.slice(start);
			const head = pictographic.exec(body)?.[0];
			if (head === undefined) {
				// A lone high surrogate may be the first half of an emoji: wait for the rest.
				if (/^[\uD800-\uDBFF]$/u.test(body)) return;
				mode = "body";
				const all = held;
				held = "";
				return pass(all);
			}
			held = "";
			mode = "after";
			found(head);
			afterEmoji(body.slice(head.length));
		},
		/** The output ended: a pending head that never became an emoji is released as it is. */
		end(): void {
			if (mode === "head" && !spaceOnly.test(held)) pass(held);
			held = "";
		},
	};
};

const toolCallMessage = (c: ReplyToolCall) => ({
	id: c.id,
	type: "function" as const,
	function: { name: c.name, arguments: c.arguments },
});

const notRun = JSON.stringify({ executed: false, reason: "tool_call_limit" });

/**
 * One normal reply: calls the chat, runs the tool calls it asks for through the ToolPort one
 * by one (results go back as `tool` messages) and calls the chat again, until it answers
 * without tool calls, a result ends the reply, or the signal aborts.
 *
 * Text written in the same output as tool calls is a spoken preamble: it was already streamed
 * and is kept. Once `maxToolCalls` calls have run, the next chat call is made with `tools: []`
 * (calls beyond the limit inside one output are answered as not run). The emotion emoji is
 * removed from the head of every chat output; the first one found is the reply's emotion.
 */
export async function runRespond(input: RespondInput): Promise<RespondResult> {
	const { chat, tools, signal } = input;
	const max = input.maxToolCalls ?? defaultMaxToolCalls;
	if (!Number.isInteger(max) || max < 0)
		throw new Error("maxToolCalls must be a non-negative integer");
	const messages: ReplyMessage[] = structuredClone([...input.messages]);
	if (
		messages[0]?.role !== "system" ||
		messages.slice(1).some((m) => m.role === "system")
	)
		throw new SystemContextConfigurationError("respond");
	requireSystemText(messages[0].content, "respond");
	const callIds = new Set(
		messages.flatMap((m) => m.tool_calls?.map((c) => c.id) ?? []),
	);
	const calls: { name: string; arguments: string; content: string }[] = [];
	const spoken: string[] = [];
	let emotion: EmotionEmoji | undefined;
	let ended = false;

	for (;;) {
		signal.throwIfAborted();
		const limited = calls.length >= max;
		const filter = createHeadFilter(
			input.emotion,
			(text) => {
				spoken.push(text);
				input.onDelta(text);
			},
			(emoji) => {
				if (emotion === undefined && isEmotion(emoji)) emotion = emoji;
			},
		);
		const output = await untilAborted(
			chat.complete(
				{
					messages: structuredClone(messages),
					tools: limited ? [] : tools.tools,
				},
				(text) => {
					if (!signal.aborted) filter.push(text);
				},
				signal,
			),
			signal,
		);
		signal.throwIfAborted();
		const parsed = replyResultSchema.safeParse(output);
		if (!parsed.success) throw new ReplyOutputError("schema");
		const reply = parsed.data;
		for (const call of reply.toolCalls) {
			if (callIds.has(call.id))
				throw new ReplyOutputError("duplicate_tool_call");
			callIds.add(call.id);
		}
		// A port that does not stream returns the text only.
		if (!filter.streamed && reply.text !== "") filter.push(reply.text);
		filter.end();

		if (limited || reply.toolCalls.length === 0) break;
		messages.push({
			role: "assistant",
			content: reply.text,
			tool_calls: reply.toolCalls.map(toolCallMessage),
		});
		for (const call of reply.toolCalls) {
			signal.throwIfAborted();
			if (ended || calls.length >= max) {
				messages.push({ role: "tool", content: notRun, tool_call_id: call.id });
				continue;
			}
			const result = await untilAborted(tools.call(call, signal), signal);
			signal.throwIfAborted();
			calls.push({
				name: call.name,
				arguments: call.arguments,
				content: result.content,
			});
			messages.push({
				role: "tool",
				content: result.content,
				tool_call_id: call.id,
			});
			if (result.end === true) ended = true;
		}
		if (ended) break;
	}

	return {
		text: spoken.join("").trim(),
		...(emotion === undefined ? {} : { emotion }),
		ended,
		calls,
	};
}
