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
	/** First reserved ticket of this activity; time is not a unique generation key. */
	generation?: string;
	toolCalls: number;
	tokens: number;
}

export class ActivityBudget {
	readonly #use = new Map<string, ActivityUse>();
	readonly limits: ActivityLimits;
	constructor(
		limits: ActivityLimits = defaultActivityLimits,
		restore: readonly (readonly [string, ActivityUse])[] = [],
	) {
		if (
			!Number.isSafeInteger(limits.toolCalls) ||
			limits.toolCalls < 0 ||
			!Number.isSafeInteger(limits.tokens) ||
			limits.tokens < 0 ||
			!Number.isFinite(limits.elapsedMs) ||
			limits.elapsedMs < 0
		)
			throw new RangeError(
				"activityBudgetMeter limits must be finite and non-negative; calls and tokens must be integers",
			);
		for (const [, use] of restore)
			if (
				!Number.isFinite(use.startedAt) ||
				!Number.isSafeInteger(use.toolCalls) ||
				use.toolCalls < 0 ||
				!Number.isSafeInteger(use.tokens) ||
				use.tokens < 0
			)
				throw new RangeError("invalid activityBudgetMeter checkpoint");
		for (const [, use] of restore)
			if (
				use.generation !== undefined &&
				(typeof use.generation !== "string" ||
					!use.generation ||
					use.generation.length > 256)
			)
				throw new RangeError("invalid activity generation");
		for (const [id, use] of restore) this.#use.set(id, { ...use });
		this.limits = Object.freeze({ ...limits });
	}

	snapshot(): readonly (readonly [string, ActivityUse])[] {
		return [...this.#use].map(([id, use]) => [id, { ...use }] as const);
	}

	start(intentId: string, now: number) {
		if (!Number.isFinite(now))
			throw new RangeError("activity time must be finite");
		if (!this.#use.has(intentId))
			this.#use.set(intentId, { startedAt: now, toolCalls: 0, tokens: 0 });
	}
	/** Bind the current activity to its first reserved ticket; subsequent tickets share it. */
	bind(intentId: string, ticketId: string): string {
		const use = this.#use.get(intentId);
		if (!use || !ticketId || ticketId.length > 256)
			throw new RangeError("invalid activity binding");
		use.generation ??= ticketId;
		return use.generation;
	}
	/** Record use; returns why the activity must stop, or null. */
	spend(
		intentId: string,
		now: number,
		d: { toolCalls?: number; tokens?: number },
	) {
		for (const value of [d.toolCalls ?? 0, d.tokens ?? 0])
			if (!Number.isSafeInteger(value) || value < 0)
				throw new RangeError("activity usage must be non-negative integers");
		if (!Number.isFinite(now))
			throw new RangeError("activity time must be finite");
		this.start(intentId, now);
		const u = this.#use.get(intentId)!;
		const toolCalls = u.toolCalls + (d.toolCalls ?? 0);
		const tokens = u.tokens + (d.tokens ?? 0);
		if (!Number.isSafeInteger(toolCalls) || !Number.isSafeInteger(tokens))
			throw new RangeError("activity usage overflow");
		u.toolCalls = toolCalls;
		u.tokens = tokens;
		return this.exceeded(intentId, now);
	}
	/** Whether a further tool call may start now (checked before issuing a ticket). */
	canIssueTool(intentId: string, now: number) {
		if (
			this.limits.toolCalls === 0 ||
			this.limits.tokens === 0 ||
			this.limits.elapsedMs === 0
		)
			return false;
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
		const use = this.#use.get(intentId);
		return use ? { ...use } : undefined;
	}
}
