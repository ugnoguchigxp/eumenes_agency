import type {
	AgencyState,
	Attempt,
	AttemptStatus,
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

/**
 * A reserved attempt with no receipt and no invalidate is released after this long
 * (see expireStaleAttempts); a ticket the host never answered must not hold a candidate forever.
 */
export const ATTEMPT_RECEIPT_TTL_MS = 10 * 60_000;

/**
 * Attempt status only moves forward: live -> anything; outcome_unknown -> a known result;
 * interrupted -> succeeded/failed (a late receipt says what really happened). succeeded and
 * failed are final, so a late or duplicate receipt never regresses them.
 */
export const canMoveAttempt = (
	from: AttemptStatus,
	to: AttemptStatus,
): boolean => {
	if (from === to) return false;
	switch (from) {
		case "not_started":
		case "running":
			return true;
		case "outcome_unknown":
			return to === "succeeded" || to === "failed" || to === "interrupted";
		case "interrupted":
			return to === "succeeded" || to === "failed";
		default:
			return false;
	}
};

const isLiveAttempt = (a: Attempt) =>
	a.status === "running" || a.status === "not_started";

/** Locked candidates stay open: only the host's receipt moves them (contract section 8). */
export const isLocked = (state: AgencyState, c: Candidate) =>
	isInFlight(c) ||
	c.holdReason === "awaiting_outcome" ||
	hasUnknownOutcome(state, c.id);

/** The candidate is open and `a` is the latest attempt made for it. */
export const isLatestAttempt = (
	state: AgencyState,
	a: Attempt,
	c: Candidate | undefined,
): boolean => {
	if (!c || c.state === "closed" || a.candidateId !== c.id) return false;
	const latest = [...state.attempts]
		.reverse()
		.find((x) => x.candidateId === c.id);
	return latest?.id === a.id;
};

/**
 * A late success of an attempt that was interrupted without a receipt (invalidate or expiry),
 * and not re-reserved since: the delivery really happened, so the candidate must not be offered
 * a second time. Not for an attempt of an older, replaced reservation.
 */
export const isLateSuccessOfInterrupted = (
	state: AgencyState,
	a: Attempt,
	c: Candidate | undefined,
	receiptStatus: AttemptStatus,
): boolean =>
	receiptStatus === "succeeded" &&
	a.status === "interrupted" &&
	isLatestAttempt(state, a, c) &&
	c !== undefined &&
	!isInFlight(c);

/**
 * The attempt a receipt may move the candidate with: the latest attempt of the candidate, and
 * either live while the candidate is in flight, or outcome-unknown while it awaits the outcome.
 * Attempts of superseded, interrupted or re-reserved reservations only update their own record.
 */
export const isCurrentAttempt = (
	state: AgencyState,
	a: Attempt,
	c: Candidate | undefined,
): boolean => {
	if (!isLatestAttempt(state, a, c) || !c) return false;
	return isInFlight(c)
		? isLiveAttempt(a)
		: c.holdReason === "awaiting_outcome" && a.status === "outcome_unknown";
};

/**
 * A tool candidate whose exact effect (tool and input) has an unknown-outcome attempt under
 * another candidate: renaming or recreating it must not allow a second reservation.
 */
const sameEffectUnknown = (state: AgencyState, c: Candidate): boolean =>
	c.kind === "tool" &&
	state.attempts.some((a) => {
		if (a.status !== "outcome_unknown" || a.candidateId === c.id) return false;
		const other = state.candidates.find((x) => x.id === a.candidateId);
		return (
			other !== undefined &&
			other.kind === "tool" &&
			other.toolName === c.toolName &&
			other.toolInput === c.toolInput
		);
	});

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
		!hasUnknownOutcome(state, c.id) &&
		!sameEffectUnknown(state, c)
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
		// An in-flight or unknown-outcome candidate stays open until its receipt reconciles it.
		if (c.intentId !== intentId || !isOpenCandidate(c) || isLocked(state, c))
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

/** Releases unanswered attempts, expires stale candidates, then returns blocked_physical ones to pending. */
export const refreshCandidates = (state: AgencyState, at: number): boolean => {
	// First release attempts nobody answered, so their candidates can expire like any other.
	let changed = expireStaleAttempts(state, at);
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

/**
 * Releases a live attempt without a receipt. A speak attempt is interrupted (stale audio is
 * never replayed) and its candidate waits for re-evaluation. A tool attempt may already have
 * started on the host, so it becomes outcome_unknown (contract section 8): no automatic
 * re-execution, and no new reservation of the same effect until a receipt reconciles it.
 */
const releaseAttempt = (state: AgencyState, a: Attempt) => {
	const c = state.candidates.find((x) => x.id === a.candidateId);
	if (a.action === "tool") {
		a.status = "outcome_unknown";
		if (c && isInFlight(c)) holdCandidate(c, "awaiting_outcome");
	} else {
		a.status = "interrupted";
		if (c && isInFlight(c)) holdAfterFailure(state, c);
	}
};

/** Interrupts live attempts (new input, speech start, settings change). */
export const interruptLive = (state: AgencyState): boolean => {
	let changed = false;
	for (const a of state.attempts) {
		if (!isLiveAttempt(a)) continue;
		releaseAttempt(state, a);
		changed = true;
	}
	if (changed) state.revision += 1;
	return changed;
};

/** Releases attempts that never got a receipt within ATTEMPT_RECEIPT_TTL_MS. */
export const expireStaleAttempts = (
	state: AgencyState,
	at: number,
): boolean => {
	let changed = false;
	for (const a of state.attempts) {
		if (!isLiveAttempt(a) || at - a.startedAt <= ATTEMPT_RECEIPT_TTL_MS)
			continue;
		releaseAttempt(state, a);
		changed = true;
	}
	if (changed) state.revision += 1;
	return changed;
};
