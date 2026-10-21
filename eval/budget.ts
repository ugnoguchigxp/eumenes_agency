/** Per-command spend guard for `run` and `judge` (--budget-usd); the global meter stays as is. */
import { LlmCallError } from "../src/contracts/errors.ts";
import type { LlmPort, LlmRequest, LlmResult } from "../src/contracts/ports.ts";

/**
 * Refuses further calls once this command has spent `limitUsd` (measured as the growth of
 * `spent()` since creation). It raises the same `spend_limit` error as the global meter, so
 * the runtime records the call as `llm_call:spend_limit`, the run as incomplete, and the
 * loops stop with their usual spend-limit exit. The call in flight when the limit is
 * crossed completes, so the overshoot is at most one call.
 */
export function withCommandBudget(
	llm: LlmPort,
	spent: () => number,
	limitUsd: number,
): LlmPort {
	const start = spent();
	return {
		complete<T>(
			request: LlmRequest<T>,
			signal: AbortSignal,
		): Promise<LlmResult<T>> {
			if (spent() - start >= limitUsd)
				return Promise.reject(new LlmCallError("spend_limit", false));
			return llm.complete(request, signal);
		},
	};
}

/** True once the command's own spend has reached the limit. */
export const commandBudgetReached = (
	spent: () => number,
	start: number,
	limitUsd: number,
): boolean => spent() - start >= limitUsd;
