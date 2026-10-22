import type { ActionReceipt, ActionTicket } from "../../contracts/runtime.ts";
import type {
	AgencyState,
	Attempt,
	Candidate,
	ObservationInput,
} from "../../contracts/model.ts";
import { allocId } from "./ids.ts";
import {
	canMoveAttempt,
	closeCandidate,
	findAttempt,
	holdAfterFailure,
	holdCandidate,
	isCurrentAttempt,
	isLateSuccessOfInterrupted,
} from "./lifecycle.ts";

/** The receipt names no known ticket. */
export class UnknownTicketError extends Error {
	constructor(readonly ticketId: string) {
		super(`unknown_ticket:${ticketId}`);
		this.name = "UnknownTicketError";
	}
}

/**
 * Applies a host receipt to its attempt, and to the candidate only when the attempt is the
 * candidate's current one (see isCurrentAttempt). A late receipt for a superseded or re-reserved
 * attempt updates just that attempt's record, and a terminal attempt status is never changed.
 * One exception: a late success of an interrupted attempt that was not re-reserved closes the
 * candidate as fulfilled, so the delivery is not repeated (isLateSuccessOfInterrupted). Always returns the observation to append. Mutates `state`; the intent is never
 * completed here.
 */
export const applyReceipt = (
	state: AgencyState,
	receipt: ActionReceipt,
	ticket: ActionTicket | undefined,
): { attempt: Attempt; observation: ObservationInput; changed: boolean } => {
	const attempt = findAttempt(state, receipt.ticketId);
	if (!attempt) throw new UnknownTicketError(receipt.ticketId);
	const candidate: Candidate | undefined = state.candidates.find(
		(c) => c.id === attempt.candidateId,
	);
	// Decided before the attempt moves: the candidate follows only a receipt for its live attempt.
	const current =
		isCurrentAttempt(state, attempt, candidate) ||
		isLateSuccessOfInterrupted(state, attempt, candidate, receipt.status);
	const changed = canMoveAttempt(attempt.status, receipt.status);
	if (changed) attempt.status = receipt.status;
	if (candidate && current && changed) {
		if (receipt.status === "succeeded") closeCandidate(candidate, "fulfilled");
		else if (receipt.status === "outcome_unknown")
			holdCandidate(candidate, "awaiting_outcome");
		else holdAfterFailure(state, candidate);
	}
	if (changed) state.revision += 1;

	const id = allocId(state, "h");
	const ok = receipt.status === "succeeded";
	const prefix = ok ? "" : `[${receipt.status}] `;
	const base = {
		id,
		occurredAt: receipt.at,
		text: `${prefix}${receipt.resultText || ticket?.utterance || ""}`,
		causationId:
			attempt.action === "speak" && candidate ? candidate.id : attempt.id,
	};
	const observation: ObservationInput =
		attempt.action === "speak"
			? {
					...base,
					kind: "delivery.observed",
					actor: "agent",
				}
			: {
					...base,
					kind: "action.observed",
					actor: ok ? "tool" : "host",
				};
	return { attempt, observation, changed };
};
