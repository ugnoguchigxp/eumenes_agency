/**
 * P4-b: the delegation boundary. Agency decides what / why / whether-now and hands a host a
 * DelegationRequest; the host (Eumenes → Pursuit) owns how: execution, daily caps, budgets,
 * interruption. Agency implements no executor; returns come back as work.returned observations.
 */
import type { ObservationInput, WorkStatus } from "./model.ts";

export interface DelegationBudget {
	readonly toolCalls: number;
	readonly tokens: number;
	readonly elapsedMs: number;
}

export interface DelegationRequest {
	/** The delegate ticket id; returns must carry it as workRef. */
	readonly workRef: string;
	readonly intentId: string;
	/** What to find out (ticket tool input). */
	readonly question: string;
	/** Why: the intent's desired state and motive. */
	readonly desiredState: string;
	readonly motive: string;
	/** When the unit counts as done (intent completion condition). */
	readonly acceptance: string;
	/** Agency's proposed ceiling; the host may only lower it. */
	readonly budget: DelegationBudget;
	readonly origin: "autonomous";
	readonly requestedAt: number;
}

export type DelegationRefusalCode = "daily_cap" | "busy" | "invalid_request";
export interface DelegationRefusal {
	readonly accepted: false;
	readonly code: DelegationRefusalCode;
}
export interface DelegationStart {
	readonly accepted: true;
	/** The budget the host will actually enforce (≤ requested). */
	readonly budget: DelegationBudget;
}

export interface DelegationReturn {
	readonly id: string;
	readonly workRef: string;
	readonly status: WorkStatus;
	readonly summary: string;
	readonly at: number;
}

/** Implemented by the host (Eumenes/Pursuit adapter), never by Agency. */
export interface DelegationHost {
	start(req: DelegationRequest): DelegationStart | DelegationRefusal;
	interrupt(workRef: string, at: number, reason: string): void;
	/** Returns that finished by `at`, each delivered once. */
	drain(at: number): readonly DelegationReturn[];
}

export const workReturnedObservation = (
	r: DelegationReturn,
): ObservationInput => ({
	id: r.id,
	kind: "work.returned",
	actor: "tool",
	occurredAt: r.at,
	text: r.summary,
	workRef: r.workRef,
	workStatus: r.status,
});
