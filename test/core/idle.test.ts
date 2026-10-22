import { describe, expect, test } from "bun:test";
import {
	type CycleOutcome,
	createIdlePlanner,
	createIdleScheduler,
	defaultIdleSec,
	maxIdleSec,
	maxTimerMs,
} from "../../src/index.ts";

describe("createIdlePlanner", () => {
	const sec = 1000;
	const make = (idleSec = 40, maxUnanswered = 1) =>
		createIdlePlanner({ idleSec, maxUnanswered }, 0);

	test("fires idleSec after the last submitted line", () => {
		const p = make();
		expect(p.delayMs(0)).toBe(40 * sec);
		p.userTurn(10 * sec);
		expect(p.delayMs(10 * sec)).toBe(40 * sec);
		expect(p.delayMs(50 * sec)).toBe(0);
	});

	test("default idle is 10s and backs off 10 -> 20 -> 40 then waits for the user", () => {
		expect(defaultIdleSec).toBe(10);
		const p = make(defaultIdleSec);
		expect(p.delayMs(0)).toBe(10 * sec);
		p.idleSilent(10 * sec);
		expect(p.delayMs(10 * sec)).toBe(20 * sec);
		p.idleSilent(30 * sec);
		expect(p.delayMs(30 * sec)).toBe(40 * sec);
		p.idleSilent(70 * sec);
		expect(p.delayMs(70 * sec)).toBeNull();
		expect(p.blockedBy()).toBe("exhausted");
		p.userTurn(80 * sec);
		expect(p.delayMs(80 * sec)).toBe(10 * sec);
	});

	test("idleSec 0 disables", () => {
		const p = make(0);
		expect(p.delayMs(0)).toBeNull();
		expect(p.blockedBy()).toBe("disabled");
	});

	test("backoff doubles then gives up until the next user turn", () => {
		const p = make();
		p.idleSilent(40 * sec);
		expect(p.delayMs(40 * sec)).toBe(80 * sec);
		p.idleSilent(120 * sec);
		expect(p.delayMs(120 * sec)).toBe(160 * sec);
		p.idleSilent(280 * sec);
		expect(p.delayMs(280 * sec)).toBeNull();
		expect(p.blockedBy()).toBe("exhausted");
		p.userTurn(300 * sec);
		expect(p.delayMs(300 * sec)).toBe(40 * sec);
	});

	test("paused (agency off) neither advances the backoff nor blocks resuming", () => {
		const p = make();
		p.idleSilent(40 * sec);
		p.setPaused(true, 50 * sec);
		expect(p.delayMs(1000 * sec)).toBeNull();
		expect(p.blockedBy()).toBe("paused");
		p.setPaused(false, 100 * sec);
		expect(p.status().level).toBe(1);
		expect(p.delayMs(100 * sec)).toBe(80 * sec);
	});

	test("a proactive line and the end of AI output restart the clock", () => {
		const p = make(40, 2);
		p.proactiveSpoke(30 * sec);
		expect(p.delayMs(30 * sec)).toBe(40 * sec);
		p.enter();
		p.leave(200 * sec);
		expect(p.delayMs(200 * sec)).toBe(40 * sec);
	});

	test("unanswered limit holds until the user replies", () => {
		const p = make(40, 2);
		p.proactiveSpoke(0);
		expect(p.delayMs(0)).toBe(40 * sec);
		p.proactiveSpoke(40 * sec);
		expect(p.delayMs(80 * sec)).toBeNull();
		p.userTurn(90 * sec);
		expect(p.delayMs(90 * sec)).toBe(40 * sec);
	});

	test("busy (reply or cycle running) pauses, and leave restarts the clock", () => {
		const p = make();
		p.enter();
		p.enter();
		expect(p.delayMs(1000 * sec)).toBeNull();
		p.leave(100 * sec);
		expect(p.blockedBy()).toBe("busy");
		p.leave(110 * sec);
		expect(p.delayMs(110 * sec)).toBe(40 * sec);
	});

	test("stop is permanent", () => {
		const p = make();
		p.stop();
		p.userTurn(0);
		expect(p.delayMs(0)).toBeNull();
	});
});

/** A fake clock with timers; advance() runs due timers in order. */
function fakeClock() {
	let t = 0;
	let seq = 0;
	const timers = new Map<number, { at: number; fn: () => void }>();
	return {
		now: () => t,
		setTimer: (fn: () => void, ms: number) => {
			const id = ++seq;
			timers.set(id, { at: t + ms, fn });
			return id;
		},
		clearTimer: (h: unknown) => void timers.delete(h as number),
		pending: () => timers.size,
		async advance(ms: number) {
			const end = t + ms;
			for (;;) {
				const next = [...timers.entries()]
					.filter(([, v]) => v.at <= end)
					.sort((a, b) => a[1].at - b[1].at)[0];
				if (!next) break;
				timers.delete(next[0]);
				t = Math.max(t, next[1].at);
				next[1].fn();
				// let async run() and its continuation settle
				for (let i = 0; i < 5; i++) await Promise.resolve();
			}
			t = end;
		},
	};
}

describe("createIdleScheduler", () => {
	const setup = (
		outcomes: CycleOutcome[],
		cfg = { idleSec: 40, maxUnanswered: 1 },
	) => {
		const clock = fakeClock();
		const planner = createIdlePlanner(cfg, clock.now());
		const runs: number[] = [];
		const scheduler = createIdleScheduler({
			planner,
			now: clock.now,
			setTimer: clock.setTimer,
			clearTimer: clock.clearTimer,
			run: async () => {
				runs.push(clock.now());
				// Like the CLI's runCycle: busy while running, clock restarts on leave.
				planner.enter();
				const outcome = outcomes.shift() ?? "silent";
				planner.leave(clock.now());
				if (outcome === "spoke") planner.proactiveSpoke(clock.now());
				return outcome;
			},
		});
		scheduler.rearm();
		return { clock, planner, runs, scheduler };
	};
	const sec = 1000;

	test("silent cycles retry at 40, +80, +160 then stop", async () => {
		const { clock, runs } = setup([]);
		await clock.advance(1000 * sec);
		expect(runs).toEqual([40 * sec, 120 * sec, 280 * sec]);
		expect(clock.pending()).toBe(0);
	});

	test("after speaking, no further idle until the user replies", async () => {
		const { clock, planner, runs, scheduler } = setup(["spoke"]);
		await clock.advance(500 * sec);
		expect(runs).toEqual([40 * sec]);
		expect(clock.pending()).toBe(0);
		planner.userTurn(clock.now());
		scheduler.rearm();
		await clock.advance(41 * sec);
		expect(runs).toHaveLength(2);
	});

	test("a submitted line postpones the timer", async () => {
		const { clock, planner, runs, scheduler } = setup([]);
		await clock.advance(30 * sec);
		planner.userTurn(clock.now());
		scheduler.rearm();
		await clock.advance(30 * sec);
		expect(runs).toEqual([]);
		await clock.advance(11 * sec);
		expect(runs).toHaveLength(1);
	});

	test("onCycle sees the planner after it absorbed the outcome", async () => {
		const seen: number[] = [];
		const clock = fakeClock();
		const planner = createIdlePlanner({ idleSec: 40, maxUnanswered: 1 }, 0);
		const scheduler = createIdleScheduler({
			planner,
			now: clock.now,
			setTimer: clock.setTimer,
			clearTimer: clock.clearTimer,
			run: async () => "silent",
			onCycle: () => seen.push(planner.status().level),
		});
		scheduler.rearm();
		await clock.advance(41 * sec);
		expect(seen).toEqual([1]);
	});

	test("dispose is permanent: a run finishing afterwards arms nothing", async () => {
		const clock = fakeClock();
		const planner = createIdlePlanner({ idleSec: 40, maxUnanswered: 1 }, 0);
		let finish: (o: CycleOutcome) => void = () => undefined;
		const cycles: CycleOutcome[] = [];
		const scheduler = createIdleScheduler({
			planner,
			now: clock.now,
			setTimer: clock.setTimer,
			clearTimer: clock.clearTimer,
			run: () => new Promise<CycleOutcome>((r) => (finish = r)),
			onCycle: (o) => cycles.push(o),
		});
		scheduler.rearm();
		await clock.advance(41 * sec);
		scheduler.dispose();
		finish("silent");
		for (let i = 0; i < 5; i++) await Promise.resolve();
		scheduler.rearm();
		expect(clock.pending()).toBe(0);
		expect(cycles).toEqual([]);
		await clock.advance(1000 * sec);
		expect(clock.pending()).toBe(0);
	});

	test("a huge delay is clamped to the timer range", () => {
		const delays: number[] = [];
		const clock = fakeClock();
		const make = (idleSec: number) => {
			const planner = createIdlePlanner({ idleSec, maxUnanswered: 1 }, 0);
			createIdleScheduler({
				planner,
				now: clock.now,
				setTimer: (fn, ms) => {
					delays.push(ms);
					return clock.setTimer(fn, ms);
				},
				clearTimer: clock.clearTimer,
				run: async () => "spoke",
			}).rearm();
		};
		make(maxIdleSec);
		make(3_000_000);
		expect(delays).toEqual([maxIdleSec * 1000, maxTimerMs]);
	});

	test("aborted cycles do not count as silent; halted stops for good", async () => {
		const a = setup(["aborted"]);
		await a.clock.advance(41 * sec);
		expect(a.runs).toHaveLength(1);
		expect(a.planner.status().level).toBe(0);
		const h = setup(["halted"]);
		await h.clock.advance(1000 * sec);
		expect(h.runs).toHaveLength(1);
		expect(h.planner.blockedBy()).toBe("stopped");
	});

	test("disabled idle never schedules; dispose clears", async () => {
		const d = setup([], { idleSec: 0, maxUnanswered: 1 });
		expect(d.clock.pending()).toBe(0);
		const e = setup([]);
		expect(e.clock.pending()).toBe(1);
		e.scheduler.dispose();
		expect(e.clock.pending()).toBe(0);
	});
});
