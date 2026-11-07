/**
 * When does the always-on agent think next? One rule (spec §3.2): 10 s after something happens,
 * doubling up to 10 min while nothing does; never while the host is busy; only an explicit stop
 * ends it. Pure planner plus a one-timer scheduler; the host injects clock and timers.
 */
import { TICK_MAX_MS, TICK_MIN_MS, type NextPace } from "./contracts.ts";

export interface HeartbeatConfig {
	readonly minMs: number;
	readonly maxMs: number;
}
export const defaultHeartbeat: HeartbeatConfig = {
	minMs: TICK_MIN_MS,
	maxMs: TICK_MAX_MS,
};

export interface HeartbeatCheckpoint {
	readonly anchor: number;
	readonly intervalMs: number;
}

export function createHeartbeat(
	config: HeartbeatConfig,
	startedAt: number,
	restore?: HeartbeatCheckpoint,
) {
	if (
		!(config.minMs > 0) ||
		!(config.maxMs >= config.minMs) ||
		!Number.isFinite(config.maxMs)
	)
		throw new RangeError("invalid heartbeat config");
	let anchor = restore?.anchor ?? startedAt;
	let intervalMs = Math.min(
		config.maxMs,
		Math.max(config.minMs, restore?.intervalMs ?? config.minMs),
	);
	let busy = 0;
	let stopped = false;
	let events = 0;
	return {
		checkpoint: (): HeartbeatCheckpoint => ({ anchor, intervalMs }),
		/** Counts events, so a tick in flight does not overwrite a reset that came meanwhile. */
		events: () => events,
		/** Something new happened (user input, a reply ended, a result came back). */
		event(now: number): void {
			anchor = now;
			intervalMs = config.minMs;
			events++;
		},
		/** A tick finished; the model's wish moves the next one within the bounds. */
		ticked(now: number, next: NextPace): void {
			anchor = now;
			intervalMs =
				next === "soon"
					? config.minMs
					: Math.min(config.maxMs, intervalMs * (next === "later" ? 4 : 2));
		},
		/** Typing, a reply or a tick in flight (nestable). */
		enter(): void {
			busy++;
		},
		leave(now: number): void {
			busy = Math.max(0, busy - 1);
			anchor = Math.max(anchor, now - intervalMs + config.minMs);
		},
		/**
		 * Something ends at `at` (a quiet period): think then, and start over from the shortest
		 * interval, as after any new situation. Never earlier than already planned.
		 */
		wakeBy(now: number, at: number): void {
			if (at > now && anchor + intervalMs > at) {
				intervalMs = config.minMs;
				anchor = at - config.minMs;
			}
		},
		/** Make the next tick due now (a host command). */
		due(now: number): void {
			anchor = now - intervalMs;
		},
		stop(): void {
			stopped = true;
		},
		resume(now: number): void {
			stopped = false;
			anchor = now;
			intervalMs = config.minMs;
			events++;
		},
		/** Milliseconds until the next tick, or null while busy or stopped. */
		delayMs(now: number): number | null {
			if (stopped || busy > 0) return null;
			return Math.max(0, anchor + intervalMs - now);
		},
		status() {
			return { stopped, busy: busy > 0, intervalSec: intervalMs / 1000 };
		},
	};
}
export type Heartbeat = ReturnType<typeof createHeartbeat>;

export interface HeartbeatSchedulerDeps {
	readonly heartbeat: Heartbeat;
	readonly now: () => number;
	readonly setTimer: (fn: () => void, ms: number) => unknown;
	readonly clearTimer: (handle: unknown) => void;
	/**
	 * Runs one tick; returns the model's wish for the next one and when the agent must think
	 * again at the latest (null: nothing was decided).
	 */
	readonly run: () => Promise<{
		readonly next: NextPace;
		readonly wakeAt: number | null;
	} | null>;
}

/** One timer that always reflects the heartbeat; call rearm() after any change. */
export function createHeartbeatScheduler(deps: HeartbeatSchedulerDeps) {
	const { heartbeat, now, setTimer, clearTimer, run } = deps;
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
		const delay = heartbeat.delayMs(now());
		if (delay === null) return;
		handle = setTimer(() => void fire(), Math.min(delay, 2 ** 31 - 1));
		armed = true;
	};
	const fire = async (): Promise<void> => {
		armed = false;
		if (disposed) return;
		if (heartbeat.delayMs(now()) !== 0) return rearm();
		running = true;
		heartbeat.enter();
		const events = heartbeat.events();
		let result: { next: NextPace; wakeAt: number | null } | null = null;
		try {
			result = await run();
		} finally {
			heartbeat.leave(now());
			// Something new arrived while thinking: its reset to the shortest interval stands.
			if (heartbeat.events() === events)
				heartbeat.ticked(now(), result?.next ?? "normal");
			if (result?.wakeAt != null) heartbeat.wakeBy(now(), result.wakeAt);
			running = false;
			rearm();
		}
	};
	return {
		rearm,
		/** Fire now (e.g. a test command), unless a tick is already running. */
		async fireNow(): Promise<void> {
			if (running || disposed) return;
			clear();
			heartbeat.due(now());
			await fire();
		},
		dispose() {
			disposed = true;
			clear();
		},
	};
}
