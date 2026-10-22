import type {
	AgencyState,
	Condition,
	Limits,
	Observation,
	ObservationInput,
	Opportunity,
	ToolCapability,
} from "./model.ts";
import type { LlmPort, LlmPurpose } from "./ports.ts";
import type { ParticipationAction } from "./proposals.ts";

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
	/** Background model (update + select). Unused for B0. */
	readonly llm: LlmPort;
	readonly tools: readonly ToolCapability[];
	readonly limits?: Limits;
	readonly budget?: BudgetConfig;
	/**
	 * B1 only (eval ablation "B1a"): call select even when there are no notes,
	 * instead of the host_no_candidates gate. Ignored for other conditions.
	 */
	readonly selectWhenEmpty?: boolean;
	/**
	 * Host delivery style for utterances (e.g. spoken via TTS), appended to the select
	 * instructions. Absent in eval, so the evaluated prompts are unchanged.
	 */
	readonly utteranceStyle?: string;
	/**
	 * Host-configured standing interests of the agent's persona (e.g. a favourite
	 * character). Shown to select with stable ids (`interest:<id>`) that count as known
	 * evidence refs. Absent in eval.
	 */
	readonly standingInterests?: readonly StandingInterest[];
	/**
	 * Social conversation mode (B1 only, host-configured; absent in eval): update also keeps
	 * "topic seed" notes (what the user likes or mentioned that is worth continuing), and
	 * select treats a quiet lull in casual talk as a fitting time to start a short remark
	 * from a topic seed or a standing interest.
	 */
	readonly socialTopics?: boolean;
}

export interface StandingInterest {
	readonly id: string;
	readonly text: string;
}

/** Recent observations shown to update/select (and to eval condition D). */
export const RECENT_OBSERVATION_WINDOW = 30;

/** Bumped whenever host validation/settlement rules change; part of the settings digest. */
export const HOST_RULES_VERSION = "host-rules-3";

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
	| "host_disabled"
	| "rejected"
	| "error";

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
	readonly kind: "intent" | "candidate" | "note" | "belief" | "desire";
	readonly text: string;
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
	/** Records the host's receipt and appends the resulting observation to the ledger. */
	recordResult(receipt: ActionReceipt): Observation;
	/** New input / speech start / settings change: interrupts reserved tickets. */
	invalidate(reason: string, now: number): void;
	setEnabled(enabled: boolean): void;
	projection(maxItems: number): AgencyProjection;
	snapshot(): {
		readonly state: AgencyState;
		readonly observations: readonly Observation[];
		readonly cursor: number;
	};
}
