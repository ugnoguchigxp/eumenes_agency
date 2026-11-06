/**
 * Ledger shapes for the P0-E experiment. Conditions:
 * B0 no autonomy, B1 free-text notes, B2 intents + candidates, F adds beliefs/desires.
 */
import { z } from "zod";
export const conditions = ["B0", "B1", "B2", "F"] as const;
export type Condition = (typeof conditions)[number];

export const actors = ["user", "agent", "tool", "host"] as const;
export type Actor = (typeof actors)[number];

export const observationKinds = [
	"exchange.adopted",
	"user.report",
	"action.observed",
	"delivery.observed",
	"source.changed",
	"correction",
	// P3-a wake events (host-recorded; text is material, never an instruction)
	"recall.offered",
	"work.returned",
	"external.event",
	"fault.observed",
] as const;
export type ObservationKind = (typeof observationKinds)[number];

export const deliveryStatuses = [
	"succeeded",
	"failed",
	"interrupted",
	"outcome_unknown",
] as const;
export type DeliveryStatus = (typeof deliveryStatuses)[number];

/** A host-received event. Its text is material, never an instruction. */
export interface Observation {
	readonly id: string;
	readonly seq: number;
	readonly kind: ObservationKind;
	readonly actor: Actor;
	readonly occurredAt: number;
	readonly text: string;
	/** Candidate or attempt that produced it (agent output and its results). */
	readonly causationId?: string;
	/** A successful handoff to a voice destination, distinct from its transcript or playback. */
	readonly speechHandoff?: {
		readonly proposedText: string;
		readonly findingWorkRefs: readonly string[];
	};
	/** delivery.observed only: whether the delivered ticket was marked speakable. */
	readonly tts?: boolean;
	/** Outcome of the attempted delivery; a voice handoff confirms routing only. */
	readonly deliveryStatus?: DeliveryStatus;
	/** recall.offered: `interest:<id>` / `intent:<id>` refs the recalled memory touches. */
	readonly refs?: readonly string[];
	/** external.event: the interest it concerns, if any. */
	readonly interestId?: string;
	/** fault.observed: error code (same code wakes once per quiet window). */
	readonly code?: string;
	/** work.returned: the delegated work unit (ticket id issued for an intent's tool use). */
	readonly workRef?: string;
	/** work.returned: how the work unit ended (host-classified). */
	readonly workStatus?: WorkStatus;
}

export const workStatuses = [
	"succeeded",
	"partial",
	"failed",
	"question",
	"interrupted",
] as const;
export type WorkStatus = (typeof workStatuses)[number];

/** P4-a: what the host recorded when a delegated work unit came back. */
export interface WorkReturn {
	readonly at: number;
	readonly workRef: string;
	readonly status: WorkStatus;
	readonly summary: string;
	/** status "question": the follow-up question the work unit asked. */
	readonly question: string | null;
}

export type ObservationInput = Omit<Observation, "seq">;

export type Presence = "quiet" | "speaking" | "unknown";

export interface Opportunity {
	readonly id: string;
	readonly at: number;
	readonly trigger:
		| "turn_end"
		| "idle"
		| "result_received"
		| "review_due"
		| "recall";
	readonly presence: Presence;
	readonly foregroundBusy: boolean;
	readonly playerBusy: boolean;
	/** Host frequency limit applies to speech, not silent work. */
	readonly speechAllowed?: boolean;
	/**
	 * Host-supplied topic seeds for this opportunity (e.g. what the host's long-term memory
	 * knows the user likes). Shown to select with refs `memory:<id>` that count as known
	 * evidence when presented. Used with deps.hostTopics; absent in eval.
	 */
	readonly topics?: readonly HostTopic[];
	/**
	 * Host-supplied current context worth a remark at a lull (season, today's weather, a news
	 * headline), as plain facts. Shown with refs `context:<id>`; the agent says nothing about
	 * them beyond the text. Used with deps.hostTopics; absent in eval except social cases.
	 */
	readonly ambient?: readonly HostTopic[];
	/**
	 * Host-tracked work the user asked for (e.g. a song generation, a pipeline): open (`todo`),
	 * waiting-for-the-user (`waiting`) and finished-but-unreported (`done`) items. Shown to select with refs `todo:<id>`; the host
	 * archives a done item once an utterance citing it is delivered. Used with deps.hostTodos.
	 */
	readonly todos?: readonly HostTodo[];
}

export interface HostTopic {
	readonly id: string;
	readonly text: string;
	/** All host inputs used to produce this value; never inserted into model data. */
	readonly input?: import("./memory.ts").InputContext;
}

export interface HostTodo {
	readonly input?: import("./memory.ts").InputContext;
	readonly id: string;
	/**
	 * work (default): background work the host does for the user. errand: the user's own task with
	 * a deadline that the user asked to be reminded of (spec/errand-design.md); always `todo`.
	 */
	readonly kind?: "work" | "errand";
	/** work: who started it. self = the agent's own research (spec/self-research-design.md). */
	readonly origin?: "user" | "self";
	/** One line, e.g. 「楽曲の生成（夜のドライブ向け）」. */
	readonly title: string;
	/**
	 * todo: in progress. waiting: the sub-agent asked the user a question (`question`) and the
	 * work is blocked until it is answered. done: finished (see outcome/result).
	 */
	readonly status: "todo" | "waiting" | "done";
	/** For waiting: the sub-agent's question, one line (never invented by the agent). */
	readonly question?: string;
	/** For done: how it ended. */
	readonly outcome?: "succeeded" | "partial" | "failed";
	/** For done: one-line result from the host (never invented by the agent). */
	readonly result?: string;
	/** For done: actions the host can carry out next (e.g. 「再生する」); only these are offered. */
	readonly nextActions?: readonly string[];
	readonly requestedAt: number;
	readonly doneAt?: number;
	/** errand: the deadline. */
	readonly dueAt?: number;
	/**
	 * errand: from when a reminder fits (the host's reminder window, e.g. two hours before the
	 * deadline). Outside [remindFrom, dueAt) the errand is not shown to select.
	 */
	readonly remindFrom?: number;
	/** errand: the deadline as the user would say it, formatted by the host (e.g. 「10時半」). */
	readonly dueLabel?: string;
}

export interface ToolCapability {
	/** Provenance of the host-provided tool description/catalog, not an execution grant. */
	readonly input?: import("./memory.ts").InputContext;
	readonly name: string;
	readonly description: string;
	/** Needs an explicit user grant; autonomous tickets are never issued for it. */
	readonly requiresApproval: boolean;
}

export type IntentState =
	| "proposed"
	| "adopted"
	| "held"
	| "completed"
	| "abandoned";

export interface Intent {
	readonly id: string;
	revision: number;
	state: IntentState;
	desiredState: string;
	motive: string;
	completionCondition: string;
	resumeCondition: string;
	withdrawCondition: string;
	reviewAt: number;
	evidence: string[];
	desireRef: string | null;
	/**
	 * Highest seq of the processed batch that created the intent (not of everything presented);
	 * completion needs evidence received after it.
	 */
	readonly createdSeq: number;
	/**
	 * Highest seq of the processed batch when the state last changed; completing from held needs evidence
	 * newer than this. Absent (older snapshots) means createdSeq.
	 */
	stateSeq?: number;
	readonly createdAt: number;
	lastReason: string;
	/** P4-a: delegated work unit in flight for this intent (one at a time); null when none. */
	workRef?: string | null;
	/** P4-a: when workRef was assigned (persisted so the stale timeout survives restore). */
	workSince?: number | null;
	/** P4-a: the last returned work unit (result, follow-up question). */
	lastReturn?: WorkReturn | null;
}

export type CandidateKind = "question" | "propose" | "share" | "tool";
export type CandidateState =
	| "pending"
	| "held"
	| "reserved"
	| "executing"
	| "closed";
export type HoldReason =
	| "blocked_physical"
	| "deferred"
	| "awaiting_reconcile"
	| "after_failure"
	| "awaiting_outcome";
export type ClosedReason =
	| "fulfilled"
	| "expired"
	| "superseded"
	| "dismissed"
	| "goal_terminal";

export interface Candidate {
	readonly id: string;
	revision: number;
	readonly intentId: string;
	readonly kind: CandidateKind;
	content: string;
	readonly toolName: string | null;
	readonly toolInput: string | null;
	/**
	 * Highest seq of the processed batch that created it; closing it as fulfilled needs
	 * evidence received after it. Absent (older snapshots) means no floor.
	 */
	readonly createdSeq?: number;
	applyWhen: string;
	expiresAt: number;
	evidence: string[];
	state: CandidateState;
	holdReason: HoldReason | null;
	closedReason: ClosedReason | null;
	readonly supersedes: string | null;
	/** P5-b: fault code of the fault.observed this candidate cites (a repair proposal). */
	readonly faultCode?: string;
}

export type AttemptStatus =
	| "not_started"
	| "running"
	| "succeeded"
	| "failed"
	| "interrupted"
	| "outcome_unknown";

export interface Attempt {
	readonly id: string;
	readonly candidateId: string | null;
	readonly candidateRevision: number | null;
	readonly opportunityId: string;
	readonly action: "speak" | "tool";
	status: AttemptStatus;
	readonly startedAt: number;
	/** Host receipt correlation, excluded from model input. Absent on older snapshots. */
	activityId?: string;
}

export type Confidence = "low" | "medium" | "high";
export type BeliefStatus = "active" | "disputed" | "superseded" | "retracted";

export interface Belief {
	readonly id: string;
	revision: number;
	content: string;
	confidence: Confidence;
	evidence: string[];
	status: BeliefStatus;
	/** Highest seq of the processed batch that created it; absent (older snapshots) means no floor. */
	readonly createdSeq?: number;
	/** Highest seq of the batch that last updated it; older snapshots fall back to createdSeq. */
	updatedSeq?: number;
}

export type DesireKind = "understand" | "finish" | "share";
export type DesireStatus = "open" | "held" | "satisfied" | "withdrawn";

export interface Desire {
	readonly id: string;
	revision: number;
	readonly kind: DesireKind;
	object: string;
	reason: string;
	evidence: string[];
	beliefRefs: string[];
	status: DesireStatus;
	/** Highest seq of the processed batch that created it; absent (older snapshots) means no floor. */
	readonly createdSeq?: number;
}

export interface Note {
	readonly id: string;
	revision: number;
	text: string;
	evidence: string[];
}

export interface AgencyState {
	/** Semantic revision; no_change does not advance it. */
	revision: number;
	intents: Intent[];
	candidates: Candidate[];
	attempts: Attempt[];
	beliefs: Belief[];
	desires: Desire[];
	notes: Note[];
	/** Items the latest update chose to keep in focus (projection order). */
	focus: string[];
	/** Monotonic counter for host-assigned ids. */
	nextId: number;
	lastOutboundAt: number | null;
	/** Condition I only (F + interestFormation); absent otherwise. */
	interests?: import("./interest.ts").Interest[];
}

export const emptyState = (): AgencyState => ({
	revision: 0,
	intents: [],
	candidates: [],
	attempts: [],
	beliefs: [],
	desires: [],
	notes: [],
	focus: [],
	nextId: 1,
	lastOutboundAt: null,
});

export interface Limits {
	readonly openIntents: number;
	readonly openCandidates: number;
	readonly beliefsAndDesires: number;
	readonly notes: number;
	readonly reviewAfterMaxHours: number;
	readonly expireAfterMaxHours: number;
	readonly outboundIntervalMs: number;
	readonly capacityPressureRatio: number;
}

/** Execution bounds are finite validated values, independent of any model instructions. */
export const limitsSchema = z.strictObject({
	openIntents: z.int().nonnegative(),
	openCandidates: z.int().nonnegative(),
	beliefsAndDesires: z.int().nonnegative(),
	notes: z.int().nonnegative(),
	reviewAfterMaxHours: z.int().positive(),
	expireAfterMaxHours: z.int().positive(),
	outboundIntervalMs: z.int().nonnegative(),
	capacityPressureRatio: z.number().min(0).max(1),
}) satisfies z.ZodType<Limits>;

export const defaultLimits: Limits = {
	openIntents: 16,
	openCandidates: 32,
	beliefsAndDesires: 64,
	notes: 16,
	reviewAfterMaxHours: 168,
	expireAfterMaxHours: 168,
	outboundIntervalMs: 60_000,
	capacityPressureRatio: 0.8,
};

export const isOpenIntent = (i: Intent) =>
	i.state === "proposed" || i.state === "adopted" || i.state === "held";
export const isOpenCandidate = (c: Candidate) => c.state !== "closed";

/** Finite RAM envelope. Full hosts keep durable source events and retry backpressured input. */
export const retentionLimitsSchema = z.strictObject({
	observations: z.int().positive(),
	observationBytes: z.int().positive(),
	totalObservationBytes: z.int().positive(),
	stateItems: z.int().positive(),
});
export type RetentionLimits = z.infer<typeof retentionLimitsSchema>;
export const defaultRetentionLimits: RetentionLimits = {
	observations: 10_000,
	observationBytes: 65_536,
	totalObservationBytes: 16_777_216,
	stateItems: 10_000,
};
