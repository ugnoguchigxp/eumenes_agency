/**
 * Contracts of the agenda agent (spec/always-on-agenda-design-2026-11-08.md): code keeps the list
 * of things to do and decides when and which; the model reads words and writes content.
 */
import { z } from "zod";
import { emotionEmojis, type EmotionEmoji } from "../contracts/emotion.ts";

export const AGENDA_VERSION = "agenda-1";

/**
 * The one user setting: the shortest gap between the agent's own utterances (10 s, 1 min, 5 min).
 * It talks about once in ten seconds by default (user, 2026-11-09).
 */
export const speechIntervals = [10, 60, 300] as const;
export type SpeechIntervalSec = (typeof speechIntervals)[number];
export const defaultSpeechIntervalSec: SpeechIntervalSec = 10;
/** Words this long after the user's previous ones start a conversation anew: a reply may end in
 * any question, not only one tied to the talk. */
export const FRESH_TALK_MS = 180_000;
export const TOPIC_RECENT_MS = 300_000;
/** With nothing new for this long, the passing of time itself is new information. */
export const IDLE_PLAN_MS = 3_600_000;
/** The next line is written this long before the agent may speak, and said when it may. */
export const WRITE_AHEAD_MS = 15_000;
/** The user's words this soon after the agent's question or offer are taken as the answer to it. */
export const ANSWER_WINDOW_MS = 600_000;
/**
 * After a failure (a model call failed, the host refused a research or did not deliver a line)
 * the same is tried again after this: enough not to hammer a failing service, no more (it was a
 * minute; user, 2026-11-11: no wait without a reason).
 */
export const RESEARCH_RETRY_MS = 10_000;
/** A research the host never returns stops counting as running after this. */
export const RESEARCH_TTL_MS = 6 * 3_600_000;
/** When the user asks for quiet in so many words («黙って») but names no length. */
export const DEFAULT_QUIET_MIN = 60;
/**
 * Soft words («ちょっと待って», «今はそっとしておいて», «話しかけが続いてる») ask for a short
 * pause, not a long silence (the user's decision 2026-11-10: a 一時停滞).
 */
export const SOFT_QUIET_MIN = 10;

/**
 * How the user asked for quiet, as the reply reads their words: softly with no length, in so many
 * words with no length, with a length or an end time, or closing the conversation to leave.
 */
export const quietKinds = ["soft", "asked", "said", "leaving"] as const;
export type QuietKind = (typeof quietKinds)[number];

/**
 * The quiet's length from how it was asked: the code decides it when no length was said, so the
 * model never turns soft words into hours. 0 ends the quiet, whatever the kind.
 */
export function quietMinutes(kind: QuietKind, minutes: number | null): number {
	if (minutes === 0) return 0;
	if (kind === "soft") return SOFT_QUIET_MIN;
	if (kind === "asked" || minutes === null) return DEFAULT_QUIET_MIN;
	return Math.min(minutes, 1440);
}
/** Recent words kept in the working memory (never saved). */
export const SAID_KEPT = 60;

/** Open items per kind: the state stays small; a plan beyond it adds nothing. */
export const OPEN_LIMITS = { ask: 4, research: 6, talk: 4 } as const;
/** Items one plan may add per kind. */
export const PLAN_ADD_LIMITS = { ask: 2, research: 3, talk: 2 } as const;

export const agendaKinds = ["ask", "research", "talk"] as const;
export type AgendaKind = (typeof agendaKinds)[number];

/** One thing to do. `refs` say what it rests on; forgetting any of them drops it. */
export interface AgendaItem {
	readonly id: string;
	readonly kind: AgendaKind;
	readonly text: string;
	readonly refs: readonly string[];
	readonly value: number;
	readonly reason: string;
	/** The user asked for it. */
	readonly requested: boolean;
	/**
	 * The agent's own reply said it would do this (research started from the reply, asked for
	 * or not): it is not dropped as a duplicate, and its result is reported when ready.
	 */
	readonly promised: boolean;
	/** `talk`: the note it is about. */
	readonly noteId: string | null;
	/**
	 * open: waiting (a research the reply asked for is queued here until the next step issues it);
	 * doing: a research handed to the researcher, an utterance handed to the host;
	 * done: finished; dropped: given up on purpose (covered, repeated, declined, forgotten);
	 * failed: `research` only, the researcher failed or never came back.
	 */
	status: "open" | "doing" | "done" | "dropped" | "failed";
	readonly createdAt: number;
	deferUntil: number | null;
	declines: number;
	endedAt: number | null;
	/** `research`: checked against the notes before it starts (null: not yet). */
	checkedRequest?: string | null;
	/** Work handed to a toolchain found through find_toolchain (the user said yes): its name. */
	delegatedTo?: string;
	/** `research`: the note it became. */
	resultNoteId?: string | null;
	/** Why the utterance was last declined, and when (the plan learns from it). */
	lastDecline?: { readonly reason: string; readonly at: number } | null;
	/** What it is about, as the plan names it: in a talk, said while the user is on that topic. */
	readonly topic?: string;
}

/**
 * What outlives the process (the host saves it and passes it back at start): what was promised to
 * the user and not finished — research asked for or promised (queued or running), results and
 * failures not told yet — and the user's wish for quiet. The rest is working memory and starts
 * anew. Running research comes back queued: its researcher did not survive the restart.
 */
export const AGENDA_SNAPSHOT_VERSION = 1;
export const agendaSnapshotSchema = z.strictObject({
	version: z.literal(AGENDA_SNAPSHOT_VERSION),
	at: z.number(),
	/** The id counter: ids made after a restore never collide with restored ones. */
	n: z.number().int().min(0),
	quiet: z.strictObject({
		speechUntil: z.number().nullable(),
		allUntil: z.number().nullable(),
	}),
	items: z
		.array(
			z.strictObject({
				id: z.string().min(1),
				kind: z.enum(["research", "talk"]),
				text: z.string(),
				refs: z.array(z.string()),
				value: z.number().int().min(1).max(5),
				reason: z.string(),
				requested: z.boolean(),
				promised: z.boolean(),
				noteId: z.string().nullable(),
				createdAt: z.number(),
				declines: z.number().int().min(0),
				checkedRequest: z.string().nullable().optional(),
				delegatedTo: z.string().optional(),
			}),
		)
		.max(200),
});
export type AgendaSnapshot = z.infer<typeof agendaSnapshotSchema>;

/** Words in the conversation: the user's, the agent's reply, the agent's own speech. */
/** A tool the reply called, with what it got back (kept so the next reply sees what it did). */
export interface ReplyCall {
	readonly name: string;
	readonly arguments: string;
	readonly content: string;
}

export interface Said {
	readonly id: string;
	readonly who: "user" | "reply" | "own";
	readonly text: string;
	readonly at: number;
	readonly refs: readonly string[];
	/** `reply`: the tools it called. */
	readonly calls?: readonly ReplyCall[];
}

/** What the host's memory knows about the user (eumenes_memory), cited `memory:<id>`. */
export interface KnownItem {
	readonly id: string;
	readonly text: string;
}

/** A note the researcher wrote (a Markdown document in the host's store), cited `note:<id>`. */
export interface NoteRef {
	readonly id: string;
	readonly title: string;
	readonly summary: string;
	readonly at: number;
	readonly refs: readonly string[];
}

/** The user's wish for quiet: speech only, or everything (research and planning too). */
export type QuietScope = "speech" | "all";
export interface Quiet {
	speechUntil: number | null;
	allUntil: number | null;
}

export type AgendaTicket =
	| {
			readonly id: string;
			readonly kind: "research";
			readonly itemId: string;
			readonly text: string;
			readonly requested: boolean;
			readonly promised: boolean;
			readonly refs: readonly string[];
			readonly at: number;
			/** Work for this toolchain (found through find_toolchain) instead of research. */
			readonly delegatedTo?: string;
	  }
	| {
			readonly id: string;
			readonly kind: "speak";
			readonly itemId: string;
			readonly itemKind: "ask" | "talk";
			readonly utterance: string;
			/** The feeling it is said with (voice tone, motion); null: the host decides. */
			readonly emotion: EmotionEmoji | null;
			readonly noteId: string | null;
			readonly refs: readonly string[];
			readonly at: number;
	  };

export interface StepHost {
	/** Typing, a reply being made or speech being read out: nothing is planned or said. */
	readonly busy: boolean;
}

export interface CallRecord {
	readonly purpose: "plan" | "check" | "ask_check" | "compose";
	readonly at: number;
	readonly model: string;
	readonly latencyMs: number;
	readonly inputTokens: number;
	readonly outputTokens: number;
	/** Did the call change anything (a plan added or dropped, a compose produced speech)? */
	readonly changed: boolean;
	readonly code: "applied" | "stale" | "failed" | "aborted";
}

export interface PlanOutcome {
	readonly added: readonly AgendaItem[];
	readonly dropped: readonly string[];
	readonly rejected: readonly string[];
	readonly reasons: readonly string[];
	readonly call: CallRecord;
}

export interface ComposeOutcome {
	readonly itemId: string;
	readonly declined: string | null;
	readonly rejected: readonly string[];
	readonly call: CallRecord;
}

/** Before a research starts: is its theme new, partly covered (narrowed) or already covered? */
export interface CheckOutcome {
	readonly itemId: string;
	readonly verdict: "new" | "partial" | "covered" | "failed";
	readonly coveredBy: string | null;
	/** What is asked of the researcher (narrowed when partly covered). */
	readonly request: string | null;
	readonly reason: string;
	readonly call: CallRecord;
}

/** A question not asked: in meaning, asked already or answered already (wording aside). */
export interface AskRepeat {
	readonly itemId: string;
	readonly text: string;
	readonly verdict: "asked" | "answered";
	readonly reason: string;
}

export interface StepOutcome {
	readonly at: number;
	readonly skipped: "stopped" | null;
	readonly plan: PlanOutcome | null;
	readonly check: CheckOutcome | null;
	/** Questions dropped as repeats (checked when planned and before they are asked). */
	readonly repeats: readonly AskRepeat[];
	readonly compose: ComposeOutcome | null;
	readonly tickets: readonly AgendaTicket[];
}

// ------------------------------------------------------------------ model outputs

export const planSchema = z.strictObject({
	add: z
		.array(
			z.strictObject({
				kind: z.enum(agendaKinds),
				text: z.string(),
				refs: z.array(z.string()).max(6),
				value: z.number().int().min(1).max(5),
				reason: z.string(),
				/** What it is about, a short name; the same name for the same topic. */
				topic: z.string(),
			}),
		)
		.max(7),
	drop: z.array(z.strictObject({ id: z.string(), reason: z.string() })).max(8),
	/** The topic of the user's latest words, by the same kind of name ("" with no talk). */
	focus: z.string(),
});
export type PlanOutput = z.infer<typeof planSchema>;

export const checkSchema = z.strictObject({
	verdict: z.enum(["new", "partial", "covered"]),
	coveredBy: z.string().nullable(),
	request: z.string().nullable(),
	reason: z.string(),
});
export type CheckOutput = z.infer<typeof checkSchema>;

export const askCheckSchema = z.strictObject({
	verdicts: z.array(
		z.strictObject({
			id: z.string(),
			verdict: z.enum(["new", "asked", "answered"]),
			reason: z.string(),
		}),
	),
});
export type AskCheckOutput = z.infer<typeof askCheckSchema>;

/**
 * Above this share of shared character pairs, a research is the same theme as an earlier one
 * without asking: only near copies. A new angle on a theme (the glycine in milk after its
 * tryptophan, 0.39) goes on to the check, which reads meaning (user, 2026-11-09).
 */
export const SAME_THEME_OVERLAP = 0.6;
/**
 * Notes this new are compared with a new research in code; an older one may be out of date
 * (tomorrow's weather, this week's news, another day's showings), and whether it still answers is
 * for the check to read (review 2026-11-10 evening 3.4).
 */
export const NOTE_FRESH_MS = 24 * 3_600_000;

export const composeSchema = z.strictObject({
	utterance: z.string().nullable(),
	/** The feeling the utterance is said with (null when declining). */
	emotion: z.enum(emotionEmojis).nullable(),
	decline: z.string().nullable(),
	/**
	 * What the writer says of its own utterance (review 2026-11-10 evening: code read "どちら" and
	 * "あと、" as an either-or or a second question, and refused "ご出身はどちらですか？", "そのあと、
	 * どうなりましたか？"): how many things it asks the user (0: none), and whether it has them pick
	 * one of the options it gives (A or B).
	 */
	questions: z.number().int().min(0).max(9),
	choice: z.boolean(),
});
export type ComposeOutput = z.infer<typeof composeSchema>;
