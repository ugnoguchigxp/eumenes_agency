import type {
	AgencyState,
	Attempt,
	Candidate,
	ClosedReason,
	HoldReason,
} from "../../contracts/model.ts";
import { isOpenCandidate } from "../../contracts/model.ts";

export const holdCandidate = (c: Candidate, reason: HoldReason) => {
	c.state = "held";
	c.holdReason = reason;
	c.revision += 1;
};

export const closeCandidate = (c: Candidate, reason: ClosedReason) => {
	c.state = "closed";
	c.closedReason = reason;
	c.holdReason = null;
	c.revision += 1;
};

export const releaseCandidate = (c: Candidate) => {
	c.state = "pending";
	c.holdReason = null;
	c.revision += 1;
};

export const hasUnknownOutcome = (state: AgencyState, candidateId: string) =>
	state.attempts.some(
		(a) => a.candidateId === candidateId && a.status === "outcome_unknown",
	);

/** Reserved or executing: a live ticket may exist, so it cannot be closed from outside. */
export const isInFlight = (c: Candidate) =>
	c.state === "reserved" || c.state === "executing";

const intentOf = (state: AgencyState, c: Candidate) =>
	state.intents.find((i) => i.id === c.intentId);

/** Candidates the select call may be offered; their intent must be proposed or adopted. */
export const isPresentable = (state: AgencyState, c: Candidate): boolean => {
	const intent = intentOf(state, c);
	return (
		(c.state === "pending" ||
			(c.state === "held" &&
				(c.holdReason === "deferred" || c.holdReason === "after_failure"))) &&
		intent !== undefined &&
		(intent.state === "proposed" || intent.state === "adopted") &&
		!hasUnknownOutcome(state, c.id)
	);
};

/** After a failed or interrupted attempt: wait for re-evaluation, unless the goal ended meanwhile. */
export const holdAfterFailure = (state: AgencyState, c: Candidate) => {
	const intent = intentOf(state, c);
	if (intent && (intent.state === "completed" || intent.state === "abandoned"))
		closeCandidate(c, "goal_terminal");
	else holdCandidate(c, "after_failure");
};

export const presentableCandidates = (state: AgencyState): Candidate[] =>
	state.candidates.filter((c) => isPresentable(state, c));

export const findAttempt = (
	state: AgencyState,
	id: string,
): Attempt | undefined => state.attempts.find((a) => a.id === id);

/**
 * Closes every open candidate of an intent that became terminal.
 * `cascaded` records each closed candidate's revision before the close.
 */
export const closeCandidatesOfIntent = (
	state: AgencyState,
	intentId: string,
	touched?: Set<string>,
	cascaded?: Map<string, number>,
) => {
	for (const c of state.candidates) {
		// An in-flight candidate is closed when its receipt arrives.
		if (c.intentId !== intentId || !isOpenCandidate(c) || isInFlight(c))
			continue;
		cascaded?.set(c.id, c.revision);
		closeCandidate(c, "goal_terminal");
		touched?.add(c.id);
	}
};

/** Host holds pending candidates while the user is not in a quiet moment. */
export const blockPending = (state: AgencyState): boolean => {
	let changed = false;
	for (const c of state.candidates)
		if (c.state === "pending") {
			holdCandidate(c, "blocked_physical");
			changed = true;
		}
	if (changed) state.revision += 1;
	return changed;
};

/** Expires stale candidates, then returns blocked_physical ones to pending. */
export const refreshCandidates = (state: AgencyState, at: number): boolean => {
	let changed = false;
	for (const c of state.candidates) {
		if (
			(c.state === "pending" || c.state === "held") &&
			c.expiresAt < at &&
			!hasUnknownOutcome(state, c.id)
		) {
			closeCandidate(c, "expired");
			changed = true;
		} else if (c.state === "held" && c.holdReason === "blocked_physical") {
			releaseCandidate(c);
			changed = true;
		}
	}
	if (changed) state.revision += 1;
	return changed;
};

/** Interrupts live attempts; their candidates wait for re-evaluation. */
export const interruptLive = (state: AgencyState): boolean => {
	let changed = false;
	for (const a of state.attempts) {
		if (a.status !== "running" && a.status !== "not_started") continue;
		a.status = "interrupted";
		changed = true;
		const c = state.candidates.find((x) => x.id === a.candidateId);
		if (c && isInFlight(c)) holdAfterFailure(state, c);
	}
	if (changed) state.revision += 1;
	return changed;
};
