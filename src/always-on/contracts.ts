/**
 * Always-on agent contracts (spec/always-on-agency-design-2026-11-07.md). A personal agent that
 * keeps thinking on a heartbeat and may act or speak without being asked. One model call per
 * tick; code enforces references, pacing and tool permission, the model judges meaning.
 */
import { z } from "zod";
import type { DeliveryStatus, ObservationInput } from "../contracts/model.ts";
import type { CallOutcome } from "../contracts/runtime.ts";

/** Bump when the built-in instructions or the think contract change. */
export const ALWAYS_ON_VERSION = "always-on-21";

/** The one user setting: the shortest gap between the agent's own utterances. */
export const speechIntervals = [10, 60, 600] as const;
export type SpeechIntervalSec = (typeof speechIntervals)[number];
export const defaultSpeechIntervalSec: SpeechIntervalSec = 10;

/** Heartbeat bounds: 10 s after something happens, doubling to 10 min while nothing does. */
export const TICK_MIN_MS = 10_000;
export const TICK_MAX_MS = 600_000;
/** Unanswered speech backs off by doubling; once the next gap would exceed this, it is held. */
export const SPEECH_HOLD_MS = 600_000;

export const drives = [
	"know_user",
	"delight",
	"curiosity",
	"presence",
	"care",
	"rest",
] as const;
export type Drive = (typeof drives)[number];

export const nextPaces = ["soon", "normal", "later"] as const;
export type NextPace = (typeof nextPaces)[number];

/** The agent's inner monologue for one tick. Never delivered, never evidence of a fact. */
export interface Thought {
	readonly id: string;
	readonly at: number;
	readonly text: string;
	readonly drive: Drive;
	/** Observation ids the tick was shown: forgetting any of them drops the thought. */
	readonly inputs: readonly string[];
}

export const factAspects = [
	"likes",
	"dislikes",
	"current",
	"routine",
	"style",
	"goal",
	"other",
] as const;
export type FactAspect = (typeof factAspects)[number];
/** stated: the user said it; observed: it shows in what the user did; hypothesis: the agent's guess. */
export const factBases = ["stated", "observed", "hypothesis"] as const;
export type FactBasis = (typeof factBases)[number];

/** What the agent knows (or guesses) about the user. */
export interface UserFact {
	readonly id: string;
	aspect: FactAspect;
	text: string;
	basis: FactBasis;
	/** Observation ids (and fact refs for derived guesses); stated/observed cite a user observation. */
	evidence: string[];
	reason: string | null;
	/** Observation ids the ticks that wrote it were shown: forgetting any of them drops it. */
	inputs: string[];
	readonly at: number;
	updatedAt: number;
}

/** Something the agent wants to know about the user. */
export interface KnowledgeGap {
	readonly id: string;
	question: string;
	why: string | null;
	status: "open" | "answered" | "declined";
	/** When the agent last asked it (null: not yet). */
	askedAt: number | null;
	evidence: string[];
	/** Observation ids the tick that wrote it was shown. */
	inputs: string[];
	readonly at: number;
}

/** What a tool does to the world. Only read and create may be used without being asked. */
export const toolEffects = ["read", "create", "modify", "external"] as const;
export type ToolEffect = (typeof toolEffects)[number];

/** A tool the host offers for preparation; the host executes it, never the agent. */
export interface AlwaysOnTool {
	readonly name: string;
	readonly description: string;
	readonly effect: ToolEffect;
	readonly requiresApproval: boolean;
}

/** Material prepared for a later conversation. */
export interface StockItem {
	readonly id: string;
	/** finding: a returned result (host text, never model-written); idea/question: the agent's own. */
	readonly kind: "finding" | "idea" | "question";
	readonly text: string;
	/** What it is for: `fact:`, `interest:`, `gap:` or observation refs. */
	readonly targets: readonly string[];
	/** finding: the work.returned observation. */
	readonly sourceRefs: readonly string[];
	/** Observation ids the tick that wrote it (or asked for it) was shown. */
	readonly inputs: readonly string[];
	readonly at: number;
	readonly freshUntil: number;
	usedAt: number | null;
}

/** A preparation handed to the host and not back yet. */
export interface Preparing {
	readonly ticketId: string;
	readonly toolName: string;
	readonly toolInput: string;
	readonly refs: readonly string[];
	/** Observation ids the tick that asked for it was shown. */
	readonly inputs: readonly string[];
	readonly at: number;
}

export const STOCK_LIMIT = 16;
/** A preparation with no result after this is given up (its result is ignored if it comes). */
export const PREPARING_TTL_MS = 6 * 3_600_000;
/** Closed questions kept: declined ones say what not to ask again. */
export const DECLINED_KEPT = 24;
export const ANSWERED_KEPT = 8;
export const FINDING_FRESH_MS = 72 * 3_600_000;
export const IDEA_FRESH_MS = 24 * 3_600_000;
export const FINDING_CHARS = 800;
/** A mute without a stated length. */
export const DEFAULT_MUTE_MIN = 60;

export const FACTS_LIMIT = 64;
export const OPEN_GAPS_LIMIT = 8;

export interface Pacing {
	/** Last time anything the agent said reached the user (reply or own speech). */
	lastAgentAt: number | null;
	/** Last time the agent's own (unrequested) speech reached the user. */
	lastOwnAt: number | null;
	/** Own utterances delivered since the user last spoke. */
	unanswered: number;
	/** Speech is muted until this time (null: not muted). */
	muteUntil: number | null;
	/** Preparation is muted until this time (null: not muted). */
	prepareMuteUntil: number | null;
	/** Everything stopped by the user or host until resumed. */
	stopped: boolean;
	/** The last own utterance asked the user something. */
	lastOwnWasAsk: boolean;
}

export interface AlwaysOnState {
	thoughts: Thought[];
	facts: UserFact[];
	gaps: KnowledgeGap[];
	stock: StockItem[];
	preparing: Preparing[];
	pacing: Pacing;
	/** Monotonic counter for agent-assigned ids. */
	nextId: number;
	/** Highest observation seq a completed tick has seen (later ones are shown as new). */
	seenSeq: number;
}

export const emptyAlwaysOnState = (): AlwaysOnState => ({
	thoughts: [],
	facts: [],
	gaps: [],
	stock: [],
	preparing: [],
	pacing: {
		lastAgentAt: null,
		lastOwnAt: null,
		unanswered: 0,
		muteUntil: null,
		prepareMuteUntil: null,
		stopped: false,
		lastOwnWasAsk: false,
	},
	nextId: 1,
	seenSeq: 0,
});

export const THOUGHTS_KEPT = 20;
export const THOUGHTS_SHOWN = 4;
export const OBSERVATIONS_KEPT = 200;
export const OBSERVATIONS_SHOWN = 20;
/** The newest observations are shown in full; older ones are cut to OLDER_CHARS. */
export const OBSERVATIONS_FULL = 8;
export const OLDER_CHARS = 160;

const ref = z.string().min(1).max(64);

export const userOpKinds = [
	"fact.add",
	"fact.update",
	"fact.retract",
	"gap.add",
	"gap.answer",
	"gap.decline",
] as const;
/** One change to the user model. Flat wire shape: unused fields are null. */
export const userOpSchema = z.strictObject({
	op: z.enum(userOpKinds),
	/** fact.update / fact.retract / gap.answer / gap.decline: the existing id (`fact:f1` or `f1`). */
	id: ref.nullable(),
	aspect: z.enum(factAspects).nullable(),
	basis: z.enum(factBases).nullable(),
	/** fact: what is known; gap.add: the question. */
	text: z.string().max(300).nullable(),
	/** hypothesis: why it is guessed; gap.add: why it would help to know. */
	reason: z.string().max(300).nullable(),
	evidenceRefs: z.array(ref).max(6),
});
export type UserOp = z.infer<typeof userOpSchema>;

export const stockOpSchema = z.strictObject({
	/** idea.add / question.add: the agent's own material; stock.drop removes an item. */
	op: z.enum(["idea.add", "question.add", "stock.drop"]),
	/** stock.drop: `stock:s1` or `s1`. */
	id: ref.nullable(),
	text: z.string().max(300).nullable(),
	targets: z.array(ref).max(4),
});
export type StockOp = z.infer<typeof stockOpSchema>;

/** The user's wish about being spoken to or prepared for, read from what they said. */
export const paceSchema = z.strictObject({
	op: z.enum(["none", "mute_speech", "mute_prepare", "mute_all", "unmute"]),
	minutes: z.int().min(1).max(1440).nullable(),
	evidenceRefs: z.array(ref).max(4),
});
export type PaceOp = z.infer<typeof paceSchema>;

/** One tick's output. Every field is present (structured output); unused ones are null/[]. */
export const thinkSchema = z.strictObject({
	thought: z.string().min(1).max(400),
	drive: z.enum(drives),
	userOps: z.array(userOpSchema).max(4),
	stockOps: z.array(stockOpSchema).max(2),
	pace: paceSchema,
	action: z.strictObject({
		kind: z.enum(["wait", "speak", "ask", "prepare"]),
		utterance: z.string().max(300).nullable(),
		toolName: z.string().max(64).nullable(),
		toolInput: z.string().max(1000).nullable(),
		evidenceRefs: z.array(ref).max(8),
	}),
	next: z.enum(nextPaces),
});
export type ThinkOutput = z.infer<typeof thinkSchema>;

/** What the host must not interrupt: the user typing, a reply being generated or played. */
export interface TickHost {
	readonly busy: boolean;
}

export interface AlwaysOnTicket {
	readonly id: string;
	readonly tickId: string;
	readonly action: "speak" | "ask" | "prepare";
	/** speak / ask: what is said. */
	readonly utterance: string | null;
	/** prepare: the tool and its input, for the host to execute. */
	readonly toolName: string | null;
	readonly toolInput: string | null;
	readonly drive: Drive;
	readonly evidenceRefs: readonly string[];
	/** Observation ids the tick was shown; the delivery records them for forgetting. */
	readonly inputs: readonly string[];
	readonly at: number;
}

/** A preparation came back from the host. `summary` is the result text, shown as data. */
export interface AlwaysOnWorkReturn {
	readonly ticketId: string;
	readonly at: number;
	readonly status: "succeeded" | "partial" | "failed";
	readonly summary: string;
}

export interface AlwaysOnReceipt {
	readonly ticketId: string;
	readonly status: DeliveryStatus;
	readonly at: number;
}

export type TickSkip = "busy" | "stopped" | "aborted" | "failed";

export interface TickOutcome {
	readonly tickId: string;
	readonly at: number;
	/** Set when no thought came back (no call, or the call failed / was superseded). */
	readonly skipped: TickSkip | null;
	readonly thought: Thought | null;
	/** The action the model chose, before code checks. */
	readonly chosen: ThinkOutput["action"]["kind"] | null;
	/** State changes applied this tick (e.g. `fact.add f3`, `stock.add s4`, `mute_speech 30`). */
	readonly applied: readonly string[];
	readonly ticket: AlwaysOnTicket | null;
	/** Why a chosen action was refused (empty when accepted or waiting). */
	readonly rejected: readonly string[];
	readonly next: NextPace;
	/** When something the agent waits for ends (a quiet period): the host should think by then. */
	readonly wakeAt: number | null;
	readonly call: CallOutcome | null;
}

export interface AlwaysOnSnapshot {
	readonly version: 1;
	readonly state: AlwaysOnState;
	readonly observations: readonly import("../contracts/model.ts").Observation[];
	readonly forgotten: readonly string[];
	readonly seq: number;
}

export type AlwaysOnObservationInput = Omit<ObservationInput, "id"> & {
	readonly id?: string;
};
