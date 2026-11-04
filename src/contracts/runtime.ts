import type {
	AgencyState,
	BeliefStatus,
	Condition,
	HostTodo,
	HostTopic,
	Limits,
	Observation,
	ObservationInput,
	Opportunity,
	ToolCapability,
} from "./model.ts";
import type { LlmPort, LlmPurpose } from "./ports.ts";
import type { EmotionName } from "./emotion.ts";
import type { ParticipationAction } from "./proposals.ts";
import type { BackgroundSystemContext } from "./system-context.ts";
import { z } from "zod";

export interface BudgetConfig {
	/** Background calls (update/select/retries) per rolling window. */
	readonly maxCallsPerWindow: number;
	readonly windowMs: number;
	readonly minIntervalMs: number;
	/** Pending observations per update call. */
	readonly batchSize: number;
	readonly updateMaxOutputTokens: number;
	readonly selectMaxOutputTokens: number;
}

/** Shared by host runtime and standalone settings; invalid limits never become an unlimited budget. */
export const budgetConfigSchema = z.strictObject({
	maxCallsPerWindow: z.int().positive(),
	windowMs: z.int().positive(),
	minIntervalMs: z.int().nonnegative(),
	batchSize: z.int().positive(),
	updateMaxOutputTokens: z.int().positive(),
	selectMaxOutputTokens: z.int().positive(),
}) satisfies z.ZodType<BudgetConfig>;

export const defaultBudget: BudgetConfig = {
	maxCallsPerWindow: 12,
	windowMs: 600_000,
	minIntervalMs: 30_000,
	batchSize: 4,
	updateMaxOutputTokens: 1200,
	selectMaxOutputTokens: 800,
};

export interface RuntimeDeps {
	readonly condition: Condition;
	/** Full host-owned instructions, or explicit opt-in to Agency's experimental prompts. No fallback. */
	readonly systemContext: BackgroundSystemContext | "experimental";
	/** Background model (update + select). Unused for B0. */
	readonly llm: LlmPort;
	readonly tools: readonly ToolCapability[];
	/** Host-owned contexts may plan from an opportunity without inventing an observation. */
	readonly planOnOpportunity?: boolean;
	/** One budgeted correction of rejected update proposals with validation codes. */
	readonly repairUpdates?: boolean;
	/** Bind native toolName fields to this host's advertised tools (keeps the flat wire grammar). */
	readonly constrainToolNames?: boolean;
	readonly limits?: Limits;
	readonly budget?: BudgetConfig;
	/**
	 * Host composition may share meters with a budgeted LlmPort adapter.
	 * The call window must match budget; call/activity limits may only be stricter.
	 * Incompatible meters are rejected at construction.
	 */
	readonly callBudgetMeter?: import("../application/budget.ts").Budget;
	readonly activityBudgetMeter?: import("../application/activity-budget.ts").ActivityBudget;
	/**
	 * B1 only (eval ablation "B1a"): call select even when there are no notes,
	 * instead of the host_no_candidates gate. Ignored for other conditions.
	 */
	readonly selectWhenEmpty?: boolean;
	/**
	 * Host delivery style for utterances (e.g. spoken via TTS), appended to the select
	 * experimental instructions only. Ignored by host-owned SystemContext.
	 */
	readonly utteranceStyle?: string;
	/**
	 * Which tickets may be spoken. Default { autonomous: false, requested: false }.
	 * utteranceStyle (spoken style) is applied to select only when the ticket would be tts.
	 */
	readonly reportTts?: ReportTts;
	/** P4-a: track delegated work units on intents (workRef / lastReturn). Default true. */
	readonly workReturns?: boolean;
	/** P3-a: wake rules (cooldown, daily limit, fault window). Default defaultWakeConfig. */
	readonly wakeConfig?: import("../domains/agency/wake.ts").WakeConfig;
	/** P3-a: per-intent activity budget for autonomous tool use. */
	readonly activityLimits?: import("../application/activity-budget.ts").ActivityLimits;
	/**
	 * Host-configured standing interests of the agent's persona (e.g. a favourite
	 * character). Shown to select with stable ids (`interest:<id>`) that count as known
	 * evidence refs. Absent in eval.
	 */
	readonly standingInterests?: readonly StandingInterest[];
	/**
	 * Experimental social conversation mode (B1 only): the experimental update also keeps
	 * "topic seed" notes (what the user likes or mentioned that is worth continuing), and
	 * select treats a quiet lull in casual talk as a fitting time to start a short remark
	 * from a topic seed or a standing interest.
	 */
	readonly socialTopics?: boolean;
	/**
	 * Topics kept by the host (B1/F): data presentation and select evidence validation. Experimental select gets
	 * the same lull-talk rule as socialTopics, using Opportunity.topics and standing
	 * interests, but update does NOT create topic-seed notes (the host's memory accumulates
	 * them). Takes precedence over socialTopics when both are set.
	 */
	readonly hostTopics?: boolean;
	/** F hostTopics: current topics also shown to the host-owned update SystemContext. */
	readonly topics?: () => readonly HostTopic[];
	/**
	 * Work report data (B1/F), with the reportedTodos reconciliation contract in B1 only. Experimental select sees Opportunity.todos,
	 * reports a done item briefly with one of its nextActions, and never raises open items.
	 */
	readonly hostTodos?: boolean;
	/**
	 * hostTodos mode only: the host's current work items, read at each update call. The update
	 * sees them and may report which done item a normal reply conveyed (see
	 * `AgencyRuntime.takeReportedTodos`). Absent: the update prompt and schema are as before.
	 */
	readonly todos?: () => readonly HostTodo[];
	/**
	 * Utterance emotion (B1/F; absent in eval except condition B1h): select also picks one
	 * emoji for the feeling a speak is said with (spec/emotion-design.md); it reaches the host
	 * as Decision.emotion / ActionTicket.emotion. Absent: the select schema and prompt are as before.
	 */
	readonly utteranceEmotion?: boolean;
	/**
	 * Condition I (F only, Agency Next P2-b): update may form and revise interests
	 * (state.interests) under the independent-evidence rules of settle-interests.
	 */
	readonly interestFormation?: boolean;
	/**
	 * P4-c: host AgencyDb sink for `agency_item_revisions`. Every changed item is appended after
	 * each runtime step (one batch, one transaction). Absent: nothing is emitted.
	 */
	readonly revisions?: import("./revisions.ts").RevisionSink;
	/**
	 * B2/F: select may speak from a presented closed intent with a work return. The host sees
	 * its recorded result, time and status; experimental prompts also describe how to report it.
	 */
	readonly findings?: boolean;
	/**
	 * P5-b repair guard (default true): a candidate citing a fault.observed is a repair
	 * proposal; one per referenced fault code. Target interpretation belongs to the host's
	 * SystemContext; approval-required tools are always blocked before autonomous reservation.
	 */
	readonly repairGuard?: boolean;
	/**
	 * State rebuilt from revisions, or a full checkpoint returned by snapshot().
	 * Observation history and cursor must be provided together. `revs` primes the
	 * revision sink's counters when restoring an existing revision table.
	 */
	readonly restore?: AgencyRestore;
}

export interface StandingInterest {
	readonly id: string;
	readonly text: string;
}

/** Recent observations shown to update/select (and to eval condition D). */
export const RECENT_OBSERVATION_WINDOW = 30;

/** Bumped whenever host validation/settlement rules change; part of the settings digest. */
export const HOST_RULES_VERSION = "host-rules-13";

/** One background model call (or a host decision not to make one). */
export interface CallOutcome {
	readonly purpose: LlmPurpose;
	readonly at: number;
	/**
	 * applied | no_change | rejected:<code> | llm:<reasonCode> (LlmOutputError)
	 * | llm_call:<reasonCode> (LlmCallError) | aborted | skipped:<why> | error:<name>
	 */
	readonly code: string;
	readonly model: string | null;
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly latencyMs: number;
	/** Validation codes when rejected (all of them, not only the first). */
	readonly rejectCodes: readonly string[];
}

export type DecisionSource =
	| "llm"
	| "host_blocked"
	| "host_no_candidates"
	/** Quarantined with unprocessed observations: never select on a stale state. */
	| "host_stale"
	| "host_budget"
	/** P4-a: the intent's delegated work unit has not returned yet. */
	| "host_delegation"
	| "host_disabled"
	| "rejected"
	| "error";

/** Who started the action: the agent on its own, or a user request (plan §3.1, G9). */
export type TicketOrigin = "autonomous" | "requested";

/** Which reports may be spoken (TTS). Decided by the runtime, never by the model. */
export interface ReportTts {
	readonly autonomous: boolean;
	readonly requested: boolean;
}
export const defaultReportTts: ReportTts = {
	autonomous: false,
	requested: false,
};
/** tts for a ticket: from origin and host config only. */
export const ticketTts = (origin: TicketOrigin, cfg: ReportTts | undefined) =>
	origin === "autonomous"
		? (cfg ?? defaultReportTts).autonomous
		: (cfg ?? defaultReportTts).requested;

export interface ActionTicket {
	/** Attempt id. */
	readonly id: string;
	readonly opportunityId: string;
	readonly action: "speak" | "tool";
	readonly candidateId: string | null;
	readonly candidateRevision: number | null;
	readonly stateRevision: number;
	readonly utterance: string | null;
	readonly toolName: string | null;
	readonly toolInput: string | null;
	/** Speak in utteranceEmotion mode: the feeling chosen with the utterance. */
	readonly emotion?: EmotionName;
	readonly origin: TicketOrigin;
	/** May be read aloud. Autonomous defaults to false; a host may turn true→false only. */
	readonly tts: boolean;
}

export interface Decision {
	readonly opportunityId: string;
	readonly action: ParticipationAction;
	readonly source: DecisionSource;
	readonly candidateId: string | null;
	/** Text to deliver (speak) or the candidate content (tool). */
	readonly utterance: string | null;
	readonly toolName: string | null;
	readonly toolInput: string | null;
	readonly evidenceRefs: readonly string[];
	readonly reason: string;
	/** Speak in utteranceEmotion mode: the feeling chosen with the utterance. */
	readonly emotion?: EmotionName;
	/** Issued only for an accepted outward action (speak/tool). */
	readonly ticket: ActionTicket | null;
	readonly rejectCodes: readonly string[];
}

export interface ActionReceipt {
	readonly ticketId: string;
	readonly status: "succeeded" | "failed" | "interrupted" | "outcome_unknown";
	readonly at: number;
	/** Tool result text, or the delivered utterance for speak. */
	readonly resultText: string;
}

export interface ProjectionItem {
	readonly id: string;
	readonly kind:
		| "intent"
		| "candidate"
		| "note"
		| "belief"
		| "desire"
		| "interest"
		| "finding";
	readonly text: string;
	/** Beliefs and desires: the settled confidence. */
	readonly confidence?: "low" | "medium" | "high";
	/** Belief status, so disputed records remain distinguishable from active ones. */
	readonly status?: BeliefStatus | import("./interest.ts").InterestStatus;
	readonly origin?: import("./interest.ts").InterestOrigin;
	/** Observation ids the item rests on (provenance), when the item records them. */
	readonly evidence?: readonly string[];
	/** Source breakdown of `evidence`, e.g. `user×1, self×1` (when observations were available). */
	readonly provenance?: string;
}

export interface AgencyProjection {
	readonly stateRevision: number;
	readonly items: readonly ProjectionItem[];
	readonly hidden: number;
}

/**
 * Host-side agency for one scope. Synchronous methods are the single writer;
 * async methods call the model outside any write and settle afterwards.
 * Time is always passed in (no clock inside the core).
 */
export interface WakeHostInput {
	readonly presence: "quiet" | "speaking" | "unknown";
	readonly foregroundBusy: boolean;
	readonly delegationRunning?: boolean;
	readonly idleDue?: boolean;
	readonly speechAllowed?: boolean;
}
export interface WakeOutcome {
	readonly reasons: readonly import("../domains/agency/wake.ts").WakeReason[];
	readonly blocked: readonly {
		readonly reason: string;
		readonly code: string;
	}[];
	readonly decision: Decision | null;
	readonly calls: CallOutcome[];
}

/** Serializable forms of the existing due/wake flags; not another agency state store. */
export interface SnapshotScheduling {
	readonly review: readonly string[];
	readonly pressure: readonly ("intents" | "candidates")[];
	readonly wake: {
		readonly review: readonly string[];
		readonly recall: readonly string[];
		readonly events: readonly string[];
		readonly faultUntil: readonly (readonly [string, number])[];
		readonly perDay: readonly (readonly [string, number])[];
	};
	readonly wakeCount: number;
}

/**
 * Full checkpoint, including observation identity, processed cursor and scheduling flags.
 * The host owns storage and must apply its forgetting/retention policy before restoring.
 * continuity carries budget windows, activity usage and ticket delivery metadata.
 * Undrained legacy TODO reports and enabled/disabled state remain host-owned.
 */
export interface AgencySnapshot {
	readonly state: AgencyState;
	readonly observations: readonly Observation[];
	readonly cursor: number;
	/** Absent on older snapshots; when present it must match the runtime condition. */
	readonly condition?: Condition;
	/** Absent on older snapshots, whose scheduling flags start fresh. */
	readonly scheduling?: SnapshotScheduling;
	readonly continuity?: {
		readonly calls: readonly number[];
		readonly activities: readonly (readonly [
			string,
			import("../application/activity-budget.ts").ActivityUse,
		])[];
		readonly issued: readonly ActionTicket[];
		readonly receipts: readonly (readonly [string, Observation])[];
		readonly topics: readonly (readonly [string, readonly string[]])[];
		readonly lastUsed: readonly (readonly [string, number])[];
		readonly feelings: readonly (readonly [
			string,
			import("./emotion.ts").EmotionEmoji,
		])[];
		readonly failures: number;
		readonly quarantined: boolean;
		readonly diagnostics: readonly string[];
	};
}

/** Revision-table restores may still provide state only. A full checkpoint restores its ledger too. */
export interface AgencyRestore extends Partial<AgencySnapshot> {
	readonly state: AgencyState;
	readonly revs?: ReadonlyMap<string, number>;
}

export interface AgencyRuntime {
	readonly condition: Condition;
	/** Idempotent by id; same id with different content throws ObservationConflictError. */
	observe(input: ObservationInput): Observation;
	/**
	 * Processes pending observations in batches, plus review.due / capacity.pressure,
	 * within the budget. Returns one outcome per call or skipped call.
	 */
	runBackground(now: number, signal: AbortSignal): Promise<CallOutcome[]>;
	/**
	 * Host checks first (physical presence, disabled, budget, no open items),
	 * updates on observations received before the opportunity, then selects and
	 * reserves. Does not execute anything.
	 */
	decide(
		opportunity: Opportunity,
		signal: AbortSignal,
	): Promise<{ decision: Decision; calls: CallOutcome[] }>;
	/**
	 * P3-a: LLM-free wake check (wake.ts) on the host clock, then at most one update and one
	 * select. A returned work item / fault gets the update only, never a select.
	 */
	wake?(
		now: number,
		host: WakeHostInput,
		signal: AbortSignal,
	): Promise<WakeOutcome>;
	/** Records the host's receipt and appends the resulting observation to the ledger. */
	recordResult(receipt: ActionReceipt): Observation;
	/** New input / speech start / settings change: fences in-flight and queued inference, and interrupts reserved tickets. */
	invalidate(reason: string, now: number): void;
	/**
	 * hostTodos mode: drains the work reports the update settled since the last call. Each is a
	 * done item (`todoId`) that a normal reply (`observationId`, an agent exchange.adopted
	 * observation) conveyed. The host archives the item once that reply's utterance was
	 * delivered in full. Always empty outside hostTodos mode.
	 */
	takeReportedTodos(): { todoId: string; observationId: string }[];
	/** OFF fences old inference/tickets and hides projection; retained state returns on ON. */
	setEnabled(enabled: boolean): void;
	projection(maxItems: number): AgencyProjection;
	snapshot(): AgencySnapshot;
}
