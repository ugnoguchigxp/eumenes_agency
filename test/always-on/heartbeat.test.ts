import { describe, expect, test } from "bun:test";
import {
	createHeartbeat,
	createHeartbeatScheduler,
	defaultHeartbeat,
	speechGate,
	type Pacing,
} from "../../src/index.ts";

describe("heartbeat", () => {
	test("10 s after an event, doubling to 10 min while nothing happens", () => {
		const h = createHeartbeat(defaultHeartbeat, 0);
		h.event(0);
		expect(h.delayMs(0)).toBe(10_000);
		const seen: number[] = [];
		let now = 0;
		for (let i = 0; i < 9; i++) {
			now += h.delayMs(now)!;
			h.ticked(now, "normal");
			seen.push(h.status().intervalSec);
		}
		expect(seen).toEqual([20, 40, 80, 160, 320, 600, 600, 600, 600]);
		h.event(now);
		expect(h.delayMs(now)).toBe(10_000);
	});

	test("the model's wish: soon resets, later jumps further, both bounded", () => {
		const h = createHeartbeat(defaultHeartbeat, 0);
		h.ticked(0, "later");
		expect(h.status().intervalSec).toBe(40);
		h.ticked(0, "soon");
		expect(h.status().intervalSec).toBe(10);
	});

	test("wakes by the end of a quiet period, never earlier than planned", () => {
		const h = createHeartbeat(defaultHeartbeat, 0);
		h.ticked(0, "later");
		h.ticked(0, "later");
		h.ticked(0, "later");
		expect(h.delayMs(0)).toBe(600_000);
		h.wakeBy(0, 120_000);
		expect(h.delayMs(0)).toBe(120_000);
		h.wakeBy(0, 500_000);
		expect(h.delayMs(0)).toBe(120_000);
		// After it, thinking starts over from the shortest interval.
		h.ticked(120_000, "normal");
		expect(h.status().intervalSec).toBe(20);
	});

	test("never while busy or stopped; leaving busy waits at least the minimum", () => {
		const h = createHeartbeat(defaultHeartbeat, 0);
		h.enter();
		expect(h.delayMs(50_000)).toBeNull();
		h.leave(50_000);
		expect(h.delayMs(50_000)).toBe(10_000);
		h.stop();
		expect(h.delayMs(99_000)).toBeNull();
		h.resume(99_000);
		expect(h.delayMs(99_000)).toBe(10_000);
	});

	test("the scheduler runs ticks on its timer and keeps going without input", async () => {
		let now = 0;
		const timers: { at: number; fn: () => void }[] = [];
		const h = createHeartbeat(defaultHeartbeat, 0);
		let runs = 0;
		const s = createHeartbeatScheduler({
			heartbeat: h,
			now: () => now,
			setTimer: (fn, ms) => {
				timers.push({ at: now + ms, fn });
				return timers.length;
			},
			clearTimer: () => {
				timers.length = 0;
			},
			run: async () => {
				runs++;
				return { next: "normal", wakeAt: null };
			},
		});
		s.rearm();
		// One hour of silence.
		while (now < 3_600_000) {
			const t = timers.shift();
			if (!t) break;
			now = t.at;
			t.fn();
			await Promise.resolve();
			await Promise.resolve();
		}
		// 10+20+40+80+160+320 s, then every 600 s: still thinking after an hour.
		expect(runs).toBeGreaterThanOrEqual(10);
		expect(timers.length).toBe(1);
	});
});

const pacing = (p: Partial<Pacing> = {}): Pacing => ({
	lastAgentAt: null,
	lastOwnAt: null,
	unanswered: 0,
	muteUntil: null,
	prepareMuteUntil: null,
	stopped: false,
	lastOwnWasAsk: false,
	...p,
});

describe("speech pacing", () => {
	test("the shortest gap after anything the agent said", () => {
		expect(
			speechGate(pacing({ lastAgentAt: 0 }), 10_000, 5_000, false),
		).toEqual({ allowed: false, block: "interval", inSec: 5 });
		expect(
			speechGate(pacing({ lastAgentAt: 0 }), 10_000, 10_000, false).allowed,
		).toBe(true);
	});

	test("unanswered speech doubles the gap, then is held until the user speaks", () => {
		const gaps = [0, 1, 2, 3, 4, 5, 6].map((u) =>
			speechGate(pacing({ lastAgentAt: 0, unanswered: u }), 10_000, 1, false),
		);
		expect(gaps.map((g) => g.inSec)).toEqual([10, 20, 40, 80, 160, 320, null]);
		expect(gaps[6]!.block).toBe("held");
		// 60 s: held after four unanswered; 10 min: after one.
		expect(
			speechGate(pacing({ lastAgentAt: 0, unanswered: 3 }), 60_000, 1, false)
				.block,
		).toBe("interval");
		expect(
			speechGate(pacing({ lastAgentAt: 0, unanswered: 4 }), 60_000, 1, false)
				.block,
		).toBe("held");
		expect(
			speechGate(pacing({ lastAgentAt: 0, unanswered: 1 }), 600_000, 1, false)
				.block,
		).toBe("held");
	});

	test("busy, muted and stopped block speech", () => {
		expect(speechGate(pacing(), 10_000, 0, true).block).toBe("busy");
		expect(speechGate(pacing({ muteUntil: 60_000 }), 10_000, 0, false)).toEqual(
			{ allowed: false, block: "muted", inSec: 60 },
		);
		expect(speechGate(pacing({ stopped: true }), 10_000, 0, false).block).toBe(
			"stopped",
		);
	});
});
