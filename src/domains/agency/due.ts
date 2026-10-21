import type { AgencyState, Limits } from "../../contracts/model.ts";
import { isOpenCandidate, isOpenIntent } from "../../contracts/model.ts";

/** Host events that justify one update call without new observations. */
export interface Due {
	/** review.due: open intents whose reviewAt has passed. */
	readonly reviewIntentIds: readonly string[];
	/** capacity.pressure: collections at or above the pressure ratio. */
	readonly pressure: readonly ("intents" | "candidates")[];
}

/** Which review.due / capacity.pressure events were already issued. */
export interface DueFlags {
	readonly review: Set<string>;
	readonly pressure: Set<string>;
}

export const createDueFlags = (): DueFlags => ({
	review: new Set(),
	pressure: new Set(),
});

const reviewKey = (id: string, reviewAt: number) => `${id}@${reviewAt}`;

export const isDue = (d: Due) =>
	d.reviewIntentIds.length > 0 || d.pressure.length > 0;

/**
 * review.due fires once per (intent, reviewAt); capacity.pressure once per
 * crossing, re-armed when the count falls below the threshold.
 */
export const findDue = (
	state: AgencyState,
	limits: Limits,
	now: number,
	flags: DueFlags,
): Due => {
	const reviewIntentIds = state.intents
		.filter(
			(i) =>
				isOpenIntent(i) &&
				i.reviewAt <= now &&
				!flags.review.has(reviewKey(i.id, i.reviewAt)),
		)
		.map((i) => i.id);
	const counts = {
		intents: [state.intents.filter(isOpenIntent).length, limits.openIntents],
		candidates: [
			state.candidates.filter(isOpenCandidate).length,
			limits.openCandidates,
		],
	} as const;
	const pressure: ("intents" | "candidates")[] = [];
	for (const kind of ["intents", "candidates"] as const) {
		const [count, limit] = counts[kind];
		if (count >= limit * limits.capacityPressureRatio) {
			if (!flags.pressure.has(kind)) pressure.push(kind);
		} else flags.pressure.delete(kind);
	}
	return { reviewIntentIds, pressure };
};

/** Flag keys for the events a call carried; computed before the call changes the state. */
export interface IssuedKeys {
	readonly review: readonly string[];
	readonly pressure: readonly string[];
}

export const issuedKeys = (state: AgencyState, due: Due): IssuedKeys => ({
	review: due.reviewIntentIds.flatMap((id) => {
		const i = state.intents.find((x) => x.id === id);
		return i ? [reviewKey(i.id, i.reviewAt)] : [];
	}),
	pressure: [...due.pressure],
});

/** Call only after the call succeeded; a failed call leaves the event due. */
export const markIssued = (keys: IssuedKeys, flags: DueFlags) => {
	for (const k of keys.review) flags.review.add(k);
	for (const k of keys.pressure) flags.pressure.add(k);
};
