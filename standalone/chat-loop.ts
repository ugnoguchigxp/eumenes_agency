/**
 * Timing and decision logic of the standalone CLI conversation, kept free of I/O
 * (timers, clocks and file writes are injected) so it can be tested without the API.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { clearScreenDown, cursorTo, moveCursor } from "node:readline";
import {
	type Condition,
	conditions,
	type Decision,
	type Opportunity,
} from "../src/contracts/index.ts";
import {
	defaultIdleSec,
	defaultMaxUnanswered,
	maxIdleSec,
	spokenReplyStyle,
} from "../src/index.ts";
import { defaultInterestText, maxInterestChars } from "./persona.ts";

// ---------------------------------------------------------------- arguments

/** CLI-only alias: B1a is runtime condition B1 with `selectWhenEmpty`. */
export const cliConditions = [...conditions, "B1a"] as const;
export type CliCondition = (typeof cliConditions)[number];
export const defaultCliCondition: CliCondition = "B1a";

export function resolveCondition(condition: CliCondition): {
	readonly condition: Condition;
	readonly selectWhenEmpty: boolean;
} {
	return condition === "B1a"
		? { condition: "B1", selectWhenEmpty: true }
		: { condition, selectWhenEmpty: false };
}

export type LogChoice =
	| { readonly kind: "default" }
	| { readonly kind: "none" }
	| { readonly kind: "path"; readonly path: string };

export interface CliArgs {
	readonly condition: CliCondition;
	readonly off: boolean;
	readonly idleSec: number;
	readonly maxUnanswered: number;
	readonly log: LogChoice;
	/** Spoken-style (TTS) replies and proactive utterances. Default on. */
	readonly tts: boolean;
	/** Persona interest texts (default: one; empty with --no-interest). */
	readonly interests: readonly string[];
	/** Social conversation mode (topic seeds, speak at a lull). Default on; B1/B1a only. */
	readonly social: boolean;
	/** Hide the one-line `[判断]` print of each background decision (the log keeps them). */
	readonly quietWhy: boolean;
}

const nonNegative = (
	flag: string,
	raw: string | undefined,
	integer: boolean,
	max: number,
) => {
	const value =
		raw === undefined || raw.trim() === "" ? Number.NaN : Number(raw);
	if (
		!Number.isFinite(value) ||
		value < 0 ||
		value > max ||
		(integer && !Number.isInteger(value))
	)
		throw new Error(
			`usage: ${flag} <${integer ? "integer" : "number"} 0..${max}>`,
		);
	return value;
};

/** Spoken-style rules for the main reply (--tts): the shared text of src. */
export const ttsReplyStyle = spokenReplyStyle;

export function parseCliArgs(argv: readonly string[]): CliArgs {
	let condition: CliCondition = defaultCliCondition;
	let off = false;
	let idleSec = defaultIdleSec;
	let maxUnanswered = defaultMaxUnanswered;
	let log: LogChoice = { kind: "default" };
	let tts = true;
	let social = true;
	let quietWhy = false;
	const interests: string[] = [];
	let noInterest = false;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--off") off = true;
		else if (arg === "--no-interest") noInterest = true;
		else if (arg === "--interest") {
			const value = argv[++i]?.trim();
			if (!value || value.startsWith("--") || value.length > maxInterestChars)
				throw new Error(
					`usage: --interest "<text>" (1-${maxInterestChars} chars, repeatable)`,
				);
			interests.push(value);
		} else if (arg === "--tts") tts = true;
		else if (arg === "--no-tts") tts = false;
		else if (arg === "--social") social = true;
		else if (arg === "--no-social") social = false;
		else if (arg === "--quiet-why") quietWhy = true;
		else if (arg === "--condition") {
			const value = argv[++i];
			const found = cliConditions.find((c) => c === value);
			if (!found)
				throw new Error(`usage: --condition ${cliConditions.join("|")}`);
			condition = found;
		} else if (arg === "--idle-sec")
			idleSec = nonNegative("--idle-sec", argv[++i], false, maxIdleSec);
		else if (arg === "--max-unanswered")
			maxUnanswered = nonNegative("--max-unanswered", argv[++i], true, 1000);
		else if (arg === "--no-log") log = { kind: "none" };
		else if (arg === "--log") {
			const path = argv[++i];
			if (!path || path.startsWith("--"))
				throw new Error("usage: --log <path>");
			log = { kind: "path", path };
		} else throw new Error(`unknown_argument:${arg}`);
	}
	if (noInterest && interests.length > 0)
		throw new Error("usage: --interest and --no-interest are exclusive");
	return {
		condition,
		off,
		idleSec,
		maxUnanswered,
		log,
		tts,
		social,
		quietWhy,
		interests: noInterest
			? []
			: interests.length > 0
				? interests
				: [defaultInterestText],
	};
}

// ---------------------------------------------------------------- decisions

/** JSONL event for one decision of a background cycle (every action, accepted or not). */
export function decisionEvent(
	trigger: Opportunity["trigger"],
	auto: boolean,
	decision: Decision,
): Record<string, unknown> {
	return {
		type: "decision",
		trigger,
		auto,
		opportunityId: decision.opportunityId,
		action: decision.action,
		source: decision.source,
		reason: decision.reason,
		rejectCodes: decision.rejectCodes,
		evidenceRefs: decision.evidenceRefs,
	};
}

/** Dim-able one-line summary printed after a background decision. */
export function decisionLine(decision: Decision): string {
	const reason = decision.reason.replace(/\s+/g, " ").trim();
	const rejected =
		decision.rejectCodes.length > 0
			? ` [reject: ${decision.rejectCodes.join(",")}]`
			: "";
	return `[判断] ${decision.action}(${decision.source}): ${reason}${rejected}`;
}

// ------------------------------------------------------------ conversation

export interface Turn {
	readonly role: "user" | "assistant";
	readonly text: string;
}

/**
 * Turns for the Messages API: roles alternate and start with user. An assistant
 * line that has no user turn before it (a proactive opener) is kept apart as
 * `opening` and handed to the model through the system prompt instead.
 */
export function createConversation() {
	const turns: Turn[] = [];
	const opening: string[] = [];
	return {
		addUser(text: string): void {
			turns.push({ role: "user", text });
		},
		/** Reply or proactive line. Merged into a preceding assistant turn. */
		addAssistant(text: string): void {
			const last = turns[turns.length - 1];
			if (last === undefined) opening.push(text);
			else if (last.role === "assistant")
				turns[turns.length - 1] = {
					role: "assistant",
					text: `${last.text}\n${text}`,
				};
			else turns.push({ role: "assistant", text });
		},
		/** Undo the last user turn after a failed reply. */
		rollbackUser(): void {
			if (turns[turns.length - 1]?.role === "user") turns.pop();
		},
		/** A copy, so an in-flight request never sees later changes. */
		messages(): Turn[] {
			return [...turns];
		},
		/** Extra system text telling the model what it said before the user spoke. */
		systemAddendum(): string {
			if (opening.length === 0) return "";
			return `\n\n<先に話しかけた内容 label="利用者が発言する前に、あなたが自分から話しかけた言葉">\n${opening.join("\n")}\n</先に話しかけた内容>`;
		},
	};
}

// ------------------------------------------------------------------ logging

export const chatsDir = "data/chats";

export function defaultLogPath(
	condition: CliCondition,
	at: Date,
	dir = chatsDir,
): string {
	const stamp = at.toISOString().replaceAll(":", "-");
	return join(dir, `${stamp}-${condition}.jsonl`);
}

export interface ChatLog {
	readonly path: string | null;
	write(event: Record<string, unknown>): void;
}

/** Append-only JSONL. A write failure is reported once and then ignored. */
export function createChatLog(
	path: string | null,
	now: () => number,
	onError: (message: string) => void = () => undefined,
	append: (path: string, data: string) => void = appendFileSync,
	mkdir: (dir: string) => void = (dir) =>
		void mkdirSync(dir, { recursive: true }),
): ChatLog {
	let failed = false;
	let prepared = false;
	return {
		path,
		write(event) {
			if (path === null || failed) return;
			try {
				if (!prepared) {
					mkdir(dirname(path));
					prepared = true;
				}
				const at = now();
				append(
					path,
					`${JSON.stringify({ at, iso: new Date(at).toISOString(), ...event })}\n`,
				);
			} catch (error) {
				failed = true;
				onError(error instanceof Error ? error.message : String(error));
			}
		},
	};
}

// ------------------------------------------------------------ prompt output

export interface PromptLike {
	getCursorPos(): { readonly rows: number; readonly cols: number };
	prompt(preserveCursor?: boolean): void;
}

export interface TtyOut {
	readonly isTTY?: boolean;
	write(data: string): unknown;
}

/**
 * Print text above the prompt and redraw the partially typed line. Handles an input
 * that wraps over several rows: readline's own refresh only moves up `prevRows`, which
 * goes stale when a line wraps without landing exactly on a column boundary (it would
 * then erase the end of what was just printed), so the rows are cleared here from the
 * real cursor position and readline's bookkeeping is reset before it redraws.
 */
export function printAbove(
	rl: PromptLike,
	stdout: TtyOut & NodeJS.WritableStream,
	text: string,
): void {
	if (stdout.isTTY) {
		moveCursor(stdout, 0, -rl.getCursorPos().rows);
		cursorTo(stdout, 0);
		clearScreenDown(stdout);
	}
	stdout.write(`${text}\n`);
	(rl as { prevRows?: number }).prevRows = 0;
	rl.prompt(true);
}
