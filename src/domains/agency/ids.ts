import type { AgencyState } from "../../contracts/model.ts";

/** i intent, c candidate, a attempt, b belief, d desire, n note, h host-emitted observation. */
export type IdPrefix = "i" | "c" | "a" | "b" | "d" | "n" | "h";

export const HOUR_MS = 3_600_000;

export const allocId = (state: AgencyState, prefix: IdPrefix): string => {
	const id = `${prefix}${state.nextId}`;
	state.nextId += 1;
	return id;
};

export const unique = (refs: readonly string[]): string[] => [...new Set(refs)];
