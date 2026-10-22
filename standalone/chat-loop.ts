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
import { defaultInterestText, maxInterestChars } from "./persona.ts";

// ---------------------------------------------------------------- arguments

/** CLI-only alias: B1a is runtime condition B1 with `selectWhenEmpty`. */
export const cliConditions = [...conditions, "B1a"] as const;
export type CliCondition = (typeof cliConditions)[number];
export const defaultCliCondition: CliCondition = "B1a";
export const defaultIdleSec = 10;
export const defaultMaxUnanswered = 1;

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

/** Upper bound for --idle-sec (one day) so interval doubling stays inside timer range. */
export const maxIdleSec = 86_400;

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

/** Spoken-style rules for the main reply (--tts). */
export const ttsReplyStyle =
	"音声で読み上げられるので、話し言葉で答えてください。ふつうは1〜3文、長くても100字程度にします。箇条書き、見出し、Markdown、記号の装飾、絵文字、URL、コードは使わないでください。括弧書きや「/」での併記も避けてください。数字や英字、略語は、読み上げて自然に聞こえる形で書いてください。質問は一度に一つまでにしてください。相手を「ユーザーさん」と呼ばないでください。";

/** Same essence for proactive utterances (select instructions, --tts). */
export const ttsUtteranceStyle =
	"音声で読み上げられる。話し言葉で、1〜2文、長くても100字程度にする。箇条書き、見出し、Markdown、記号の装飾、絵文字、URL、コードは使わない。括弧書きや「/」での併記を避ける。数字や英字、略語は読み上げて自然な形にする。質問は一度に一つまで。相手を「ユーザーさん」「ユーザー」と呼ばない。呼びかけは省くか「あなた」を控えめに使う。";

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

// ---------------------------------------------------------------- idle plan

export interface IdleConfig {
	/** 0 disables auto idle. */
	readonly idleSec: number;
	/** Unanswered proactive utterances allowed in a row before auto idle waits for the user. */
	readonly maxUnanswered: number;
	/** Silent idle cycles retried (with doubling interval) before giving up. Default 2. */
	readonly maxRetries?: number;
}

export type IdleBlock =
	| "disabled"
	| "stopped"
	| "busy"
	| "paused"
	| "unanswered"
	| "exhausted";

/** Pure state machine: when may the next automatic idle cycle run? */
export function createIdlePlanner(config: IdleConfig, startedAt: number) {
	const maxRetries = config.maxRetries ?? 2;
	let anchor = startedAt;
	let level = 0;
	let unanswered = 0;
	let exhausted = false;
	let paused = false;
	let stopped = false;
	let busy = 0;

	const block = (): IdleBlock | null => {
		if (config.idleSec <= 0 || config.maxUnanswered <= 0) return "disabled";
		if (stopped) return "stopped";
		if (busy > 0) return "busy";
		if (paused) return "paused";
		if (unanswered >= config.maxUnanswered) return "unanswered";
		if (exhausted) return "exhausted";
		return null;
	};
	const intervalMs = () => config.idleSec * 1000 * 2 ** level;

	return {
		/** The user submitted a line: the conversation is theirs again. */
		userTurn(now: number): void {
			anchor = now;
			level = 0;
			unanswered = 0;
			exhausted = false;
		},
		/** A background cycle or reply is running (nestable). */
		enter(): void {
			busy++;
		},
		leave(now: number): void {
			busy = Math.max(0, busy - 1);
			anchor = now;
		},
		/** The AI spoke on its own (any trigger). */
		proactiveSpoke(now: number): void {
			unanswered++;
			level = 0;
			anchor = now;
		},
		/** An automatic idle cycle finished without speaking: back off, then give up. */
		idleSilent(now: number): void {
			anchor = now;
			level++;
			if (level > maxRetries) exhausted = true;
		},
		/** /off pauses automatic idle without touching the backoff; /on resumes it. */
		setPaused(value: boolean, now: number): void {
			if (paused && !value) anchor = now;
			paused = value;
		},
		/** Spend limit etc.: no more automatic cycles. */
		stop(): void {
			stopped = true;
		},
		blockedBy: block,
		/** Milliseconds until the next automatic idle cycle, or null when none is planned. */
		delayMs(now: number): number | null {
			if (block() !== null) return null;
			return Math.max(0, anchor + intervalMs() - now);
		},
		status() {
			return {
				blockedBy: block(),
				unanswered,
				level,
				nextIntervalSec: intervalMs() / 1000,
			};
		},
	};
}

export type IdlePlanner = ReturnType<typeof createIdlePlanner>;

export type CycleOutcome = "spoke" | "silent" | "aborted" | "halted";

export interface SchedulerDeps {
	readonly planner: IdlePlanner;
	readonly now: () => number;
	readonly setTimer: (fn: () => void, ms: number) => unknown;
	readonly clearTimer: (handle: unknown) => void;
	/** Runs one idle cycle. The planner learns about speech through proactiveSpoke(). */
	readonly run: () => Promise<CycleOutcome>;
	/** Called after the planner has absorbed the outcome of a scheduled cycle. */
	readonly onCycle?: (outcome: CycleOutcome) => void;
}

/** setTimeout overflows (and fires immediately) above this many milliseconds. */
export const maxTimerMs = 2 ** 31 - 1;

/** One timer that always reflects the planner's current answer; call rearm() after any change. */
export function createIdleScheduler(deps: SchedulerDeps) {
	const { planner, now, setTimer, clearTimer, run, onCycle } = deps;
	let handle: unknown;
	let armed = false;
	let running = false;
	let disposed = false;

	const clear = () => {
		if (armed) clearTimer(handle);
		armed = false;
	};
	const rearm = (): void => {
		clear();
		if (disposed || running) return;
		const delay = planner.delayMs(now());
		if (delay === null) return;
		// A clamped timer fires early; fire() then finds a positive delay and waits again.
		handle = setTimer(() => void fire(), Math.min(delay, maxTimerMs));
		armed = true;
	};
	const fire = async (): Promise<void> => {
		armed = false;
		if (disposed) return;
		// Fired early (the timer drifted or state moved): wait again.
		if (planner.delayMs(now()) !== 0) return rearm();
		running = true;
		try {
			const outcome = await run();
			if (outcome === "silent") planner.idleSilent(now());
			else if (outcome === "halted") planner.stop();
			if (!disposed) onCycle?.(outcome);
		} finally {
			running = false;
			rearm();
		}
	};
	return {
		rearm,
		/** Permanent: no timer is armed or fired afterwards, even by a cycle still in flight. */
		dispose() {
			disposed = true;
			clear();
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
