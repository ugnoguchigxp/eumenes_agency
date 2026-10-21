import type { ActionReceipt, ActionTicket } from "../../contracts/runtime.ts";
import type {
	AgencyState,
	Attempt,
	Candidate,
	ObservationInput,
} from "../../contracts/model.ts";
import { allocId } from "./ids.ts";
import {
	closeCandidate,
	findAttempt,
	holdAfterFailure,
	holdCandidate,
} from "./lifecycle.ts";

/** The receipt names no known ticket. */
export class UnknownTicketError extends Error {
	constructor(readonly ticketId: string) {
		super(`unknown_ticket:${ticketId}`);
		this.name = "UnknownTicketError";
	}
}

/**
 * Applies a host receipt: attempt status, candidate transition, and the
 * observation to append. Mutates `state`; the intent is never completed here.
 */
export const applyReceipt = (
	state: AgencyState,
	receipt: ActionReceipt,
	ticket: ActionTicket | undefined,
): { attempt: Attempt; observation: ObservationInput; changed: boolean } => {
	const attempt = findAttempt(state, receipt.ticketId);
	if (!attempt) throw new UnknownTicketError(receipt.ticketId);
	const changed = attempt.status !== receipt.status;
	attempt.status = receipt.status;
	const candidate: Candidate | undefined = state.candidates.find(
		(c) => c.id === attempt.candidateId,
	);
	if (candidate && candidate.state !== "closed") {
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
