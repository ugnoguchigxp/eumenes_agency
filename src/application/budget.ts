import type { BudgetConfig } from "../contracts/runtime.ts";

export type BudgetVerdict = "ok" | "skipped:budget" | "skipped:interval";

/** Rolling-window call budget. Every model call counts, failed ones included. */
export interface Budget {
	/** Calls still available in the window ending at `now`. */
	remaining(now: number): number;
	/** Window check always; the minimum interval only when `spaced`. */
	check(now: number, spaced: boolean): BudgetVerdict;
	record(now: number): void;
}

export const createBudget = (config: BudgetConfig): Budget => {
	const calls: number[] = [];
	const inWindow = (now: number) =>
		calls.filter((t) => t > now - config.windowMs);
	return {
		remaining: (now) =>
			Math.max(0, config.maxCallsPerWindow - inWindow(now).length),
		check(now, spaced) {
			const recent = inWindow(now);
			if (recent.length >= config.maxCallsPerWindow) return "skipped:budget";
			const last = calls[calls.length - 1];
			if (spaced && last !== undefined && now - last < config.minIntervalMs)
				return "skipped:interval";
			return "ok";
		},
		record(now) {
			calls.push(now);
			// Keep the list bounded: anything older than the window is irrelevant.
			while (calls.length > 0 && (calls[0] ?? now) <= now - config.windowMs)
				calls.shift();
		},
	};
};
