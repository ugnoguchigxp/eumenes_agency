/**
 * Host-neutral idle timing: when may the AI speak on its own after silence?
 * Pure state machine (planner) plus a one-timer scheduler. The clock and the timers
 * are injected, so any host (CLI, server) supplies its own.
 */

/** Default silence (seconds) before the first automatic idle cycle. */
export const defaultIdleSec = 10;
/** Default unanswered proactive utterances allowed in a row. */
export const defaultMaxUnanswered = 1;
/** Upper bound for an idle interval setting (one day) so interval doubling stays inside timer range. */
export const maxIdleSec = 86_400;

export interface IdleConfig {
	/** 0 disables auto idle. */
	readonly idleSec: number;
	/** Unanswered proactive utterances allowed in a row before auto idle waits for the user. */
	readonly maxUnanswered: number;
	/** Silent idle cycles retried (with doubling interval) before giving up. Default 2. */
	readonly maxRetries?: number;
}

export type IdleBlock =
	| "disabled"
	| "stopped"
	| "busy"
	| "paused"
	| "unanswered"
	| "exhausted";

/** Pure state machine: when may the next automatic idle cycle run? */
export function createIdlePlanner(config: IdleConfig, startedAt: number) {
	const maxRetries = config.maxRetries ?? 2;
	let anchor = startedAt;
	let level = 0;
	let unanswered = 0;
	let exhausted = false;
	let paused = false;
	let stopped = false;
	let busy = 0;

	const block = (): IdleBlock | null => {
		if (config.idleSec <= 0 || config.maxUnanswered <= 0) return "disabled";
		if (stopped) return "stopped";
		if (busy > 0) return "busy";
		if (paused) return "paused";
		if (unanswered >= config.maxUnanswered) return "unanswered";
		if (exhausted) return "exhausted";
		return null;
	};
	const intervalMs = () => config.idleSec * 1000 * 2 ** level;

	return {
		/** The user submitted a line: the conversation is theirs again. */
		userTurn(now: number): void {
			anchor = now;
			level = 0;
			unanswered = 0;
			exhausted = false;
		},
		/** A background cycle or reply is running (nestable). */
		enter(): void {
			busy++;
		},
		leave(now: number): void {
			busy = Math.max(0, busy - 1);
			anchor = now;
		},
		/** The AI spoke on its own (any trigger). */
		proactiveSpoke(now: number): void {
			unanswered++;
			level = 0;
			anchor = now;
		},
		/** An automatic idle cycle finished without speaking: back off, then give up. */
		idleSilent(now: number): void {
			anchor = now;
			level++;
			if (level > maxRetries) exhausted = true;
		},
		/** /off pauses automatic idle without touching the backoff; /on resumes it. */
		setPaused(value: boolean, now: number): void {
			if (paused && !value) anchor = now;
			paused = value;
		},
		/** Spend limit etc.: no more automatic cycles. */
		stop(): void {
			stopped = true;
		},
		blockedBy: block,
		/** Milliseconds until the next automatic idle cycle, or null when none is planned. */
		delayMs(now: number): number | null {
			if (block() !== null) return null;
			return Math.max(0, anchor + intervalMs() - now);
		},
		status() {
			return {
				blockedBy: block(),
				unanswered,
				level,
				nextIntervalSec: intervalMs() / 1000,
			};
		},
	};
}

export type IdlePlanner = ReturnType<typeof createIdlePlanner>;

export type CycleOutcome = "spoke" | "silent" | "aborted" | "halted";

export interface SchedulerDeps {
	readonly planner: IdlePlanner;
	readonly now: () => number;
	readonly setTimer: (fn: () => void, ms: number) => unknown;
	readonly clearTimer: (handle: unknown) => void;
	/** Runs one idle cycle. The planner learns about speech through proactiveSpoke(). */
	readonly run: () => Promise<CycleOutcome>;
	/** Called after the planner has absorbed the outcome of a scheduled cycle. */
	readonly onCycle?: (outcome: CycleOutcome) => void;
}

/** setTimeout overflows (and fires immediately) above this many milliseconds. */
export const maxTimerMs = 2 ** 31 - 1;

/** One timer that always reflects the planner's current answer; call rearm() after any change. */
export function createIdleScheduler(deps: SchedulerDeps) {
	const { planner, now, setTimer, clearTimer, run, onCycle } = deps;
	let handle: unknown;
	let armed = false;
	let running = false;
	let disposed = false;

	const clear = () => {
		if (armed) clearTimer(handle);
		armed = false;
	};
	const rearm = (): void => {
		clear();
		if (disposed || running) return;
		const delay = planner.delayMs(now());
		if (delay === null) return;
		// A clamped timer fires early; fire() then finds a positive delay and waits again.
		handle = setTimer(() => void fire(), Math.min(delay, maxTimerMs));
		armed = true;
	};
	const fire = async (): Promise<void> => {
		armed = false;
		if (disposed) return;
		// Fired early (the timer drifted or state moved): wait again.
		if (planner.delayMs(now()) !== 0) return rearm();
		running = true;
		try {
			const outcome = await run();
			if (outcome === "silent") planner.idleSilent(now());
			else if (outcome === "halted") planner.stop();
			if (!disposed) onCycle?.(outcome);
		} finally {
			running = false;
			rearm();
		}
	};
	return {
		rearm,
		/** Permanent: no timer is armed or fired afterwards, even by a cycle still in flight. */
		dispose() {
			disposed = true;
			clear();
		},
	};
}
