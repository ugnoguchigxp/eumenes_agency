/**
 * Per-intent activity budget (plan §5.4). Counts tool calls, tokens and elapsed time of
 * one autonomous activity and says when to stop. Sits inside the window budget of
 * budget.ts; no LLM. Exceeding any limit ends the activity (the caller holds the intent
 * with reason "budget").
 */
export interface ActivityLimits {
	readonly toolCalls: number;
	readonly tokens: number;
	readonly elapsedMs: number;
}
export const defaultActivityLimits: ActivityLimits = {
	toolCalls: 3,
	tokens: 20_000,
	elapsedMs: 30 * 60_000,
};

export type ActivityStop = "tool_calls" | "tokens" | "elapsed";

export interface ActivityUse {
	readonly startedAt: number;
	toolCalls: number;
	tokens: number;
}

export class ActivityBudget {
	readonly #use = new Map<string, ActivityUse>();
	constructor(readonly limits: ActivityLimits = defaultActivityLimits) {}

	start(intentId: string, now: number) {
		if (!this.#use.has(intentId))
			this.#use.set(intentId, { startedAt: now, toolCalls: 0, tokens: 0 });
	}
	/** Record use; returns why the activity must stop, or null. */
	spend(
		intentId: string,
		now: number,
		d: { toolCalls?: number; tokens?: number },
	) {
		this.start(intentId, now);
		const u = this.#use.get(intentId)!;
		u.toolCalls += d.toolCalls ?? 0;
		u.tokens += d.tokens ?? 0;
		return this.exceeded(intentId, now);
	}
	/** Whether a further tool call may start now (checked before issuing a ticket). */
	canIssueTool(intentId: string, now: number) {
		const u = this.#use.get(intentId);
		if (!u) return true;
		return (
			u.toolCalls < this.limits.toolCalls &&
			u.tokens < this.limits.tokens &&
			now - u.startedAt < this.limits.elapsedMs
		);
	}
	exceeded(intentId: string, now: number): ActivityStop | null {
		const u = this.#use.get(intentId);
		if (!u) return null;
		if (u.toolCalls > this.limits.toolCalls) return "tool_calls";
		if (u.tokens > this.limits.tokens) return "tokens";
		if (now - u.startedAt > this.limits.elapsedMs) return "elapsed";
		return null;
	}
	/** Activity ended (returned, held or closed): forget its use. */
	end(intentId: string) {
		this.#use.delete(intentId);
	}
	use(intentId: string): Readonly<ActivityUse> | undefined {
		return this.#use.get(intentId);
	}
}
