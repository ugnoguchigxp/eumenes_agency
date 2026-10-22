/**
 * Ledger shapes for the P0-E experiment. Conditions:
 * B0 no autonomy, B1 free-text notes, B2 intents + candidates, F adds beliefs/desires.
 */
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
] as const;
export type ObservationKind = (typeof observationKinds)[number];

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
}

export type ObservationInput = Omit<Observation, "seq">;

export type Presence = "quiet" | "speaking" | "unknown";

export interface Opportunity {
	readonly id: string;
	readonly at: number;
	readonly trigger: "turn_end" | "idle" | "result_received";
	readonly presence: Presence;
	readonly foregroundBusy: boolean;
	readonly playerBusy: boolean;
}

export interface ToolCapability {
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
