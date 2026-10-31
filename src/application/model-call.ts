import type { z } from "zod";
import { LlmCallError, LlmOutputError } from "../contracts/errors.ts";
import type { LlmPort, LlmPurpose } from "../contracts/ports.ts";
import type { CallOutcome } from "../contracts/runtime.ts";
import { untilAborted } from "./abort.ts";
import type { Budget, BudgetVerdict } from "./budget.ts";

export interface Usage {
	readonly model: string;
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly latencyMs: number;
}

export type ModelCall<T> =
	| {
			readonly ok: true;
			readonly value: T;
			readonly usage: Usage;
			/** Failed attempts before this one (a retry spends another call). */
			readonly prior: readonly CallOutcome[];
	  }
	| {
			readonly ok: false;
			readonly outcome: CallOutcome;
			readonly prior: readonly CallOutcome[];
	  };

export const makeOutcome = (
	purpose: LlmPurpose,
	at: number,
	code: string,
	usage: Usage | null = null,
	rejectCodes: readonly string[] = [],
): CallOutcome => ({
	purpose,
	at,
	code,
	model: usage?.model ?? null,
	inputTokens: usage?.inputTokens ?? 0,
	outputTokens: usage?.outputTokens ?? 0,
	latencyMs: usage?.latencyMs ?? 0,
	rejectCodes,
});

export const skippedOutcome = (
	purpose: LlmPurpose,
	at: number,
	verdict: Exclude<BudgetVerdict, "ok">,
) => makeOutcome(purpose, at, verdict);

export const isApplied = (o: CallOutcome) =>
	o.code === "applied" || o.code === "no_change";

const isAbort = (e: unknown) => e instanceof Error && e.name === "AbortError";

interface CallSpec<T> {
	readonly purpose: LlmPurpose;
	readonly at: number;
	readonly system: string;
	readonly prompt: string;
	readonly schema: z.ZodType<T>;
	readonly maxOutputTokens: number;
}

/** One attempt. Never throws. */
const attempt = async <T>(
	llm: LlmPort,
	budget: Budget,
	spec: CallSpec<T>,
	signal: AbortSignal,
): Promise<{ call: ModelCall<T>; retryable: boolean }> => {
	const fail = (
		code: string,
		usage: Usage | null = null,
		retryable = false,
	) => ({
		call: {
			ok: false,
			outcome: makeOutcome(spec.purpose, spec.at, code, usage),
			prior: [],
		} satisfies ModelCall<T>,
		retryable,
	});
	if (signal.aborted) return fail("aborted");
	budget.record(spec.at);
	try {
		const r = await untilAborted(
			llm.complete(
				{
					purpose: spec.purpose,
					system: spec.system,
					prompt: spec.prompt,
					schema: spec.schema,
					maxOutputTokens: spec.maxOutputTokens,
				},
				signal,
			),
			signal,
		);
		const usage: Usage = {
			model: r.model,
			inputTokens: r.inputTokens,
			outputTokens: r.outputTokens,
			latencyMs: r.latencyMs,
		};
		// A result that arrives after cancellation is never adopted.
		if (signal.aborted) return fail("aborted", usage);
		const parsed = spec.schema.safeParse(r.value);
		if (!parsed.success) return fail("llm:schema", usage);
		return {
			call: { ok: true, value: parsed.data, usage, prior: [] },
			retryable: false,
		};
	} catch (e) {
		if (signal.aborted || isAbort(e)) return fail("aborted");
		if (e instanceof LlmOutputError)
			return fail(`llm:${e.reasonCode}`, {
				model: e.model,
				inputTokens: e.usage?.inputTokens ?? 0,
				outputTokens: e.usage?.outputTokens ?? 0,
				latencyMs: 0,
			});
		if (e instanceof LlmCallError)
			return fail(`llm_call:${e.reasonCode}`, null, e.retryable);
		return fail(`error:${e instanceof Error ? e.name : "unknown"}`);
	}
};

/**
 * One budgeted model call, retried once when the failure is retryable and the
 * window still has room. Never throws: failures come back as outcomes and the
 * caller leaves state and observations untouched.
 */
export const callModel = async <T>(
	llm: LlmPort,
	budget: Budget,
	spec: CallSpec<T>,
	signal: AbortSignal,
): Promise<ModelCall<T>> => {
	const first = await attempt(llm, budget, spec, signal);
	if (
		first.call.ok ||
		!first.retryable ||
		signal.aborted ||
		budget.check(spec.at, false) !== "ok"
	)
		return first.call;
	const second = await attempt(llm, budget, spec, signal);
	return { ...second.call, prior: [first.call.outcome] };
};
