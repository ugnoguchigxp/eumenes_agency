/** P3-a: wake reasons (plan §5.3, §7.4) and the activity budget, on a virtual clock. */
import { describe, expect, test } from "bun:test";
import { virtualClock } from "../eval/virtual-clock.ts";
import { ActivityBudget } from "../src/application/activity-budget.ts";
import {
	emptyState,
	type AgencyState,
	type Intent,
} from "../src/contracts/model.ts";
import type { Interest } from "../src/contracts/interest.ts";
import {
	commitWake,
	createWakeFlags,
	wake,
	type WakeEvent,
	type WakeHost,
} from "../src/domains/agency/wake.ts";

const H = 3_600_000;
const host: WakeHost = {
	enabled: true,
	presence: "quiet",
	foregroundBusy: false,
	budgetOk: true,
	delegationRunning: false,
	idleDue: false,
};
const intent = (o: Partial<Intent>): Intent => ({
	id: "i1",
	revision: 1,
	state: "held",
	desiredState: "d",
	motive: "m",
	completionCondition: "c",
	resumeCondition: "r",
	withdrawCondition: "w",
	reviewAt: 0,
	evidence: [],
	desireRef: null,
	createdSeq: 0,
	createdAt: 0,
	lastReason: "",
	...o,
});
const interest = (o: Partial<Interest>): Interest => ({
	id: "n1",
	revision: 1,
	topic: "将棋",
	origin: "own",
	status: "active",
	reason: "r",
	evidence: [],
	derivedFrom: null,
	lastEngagedAt: null,
	createdSeq: 0,
	...o,
});
const stateWith = (o: Partial<AgencyState>): AgencyState => ({
	...emptyState(),
	...o,
});

describe("wake: review_due", () => {
	test("not before reviewAt, once after it (plan §7.4)", () => {
		const clock = virtualClock("2026-11-02T09:00+09:00");
		const s = stateWith({
			intents: [intent({ reviewAt: clock.plusHours(24) })],
		});
		const flags = createWakeFlags();
		expect(wake(s, clock.now(), host, [], flags).reasons).toEqual([]);
		clock.advanceHours(25);
		const r = wake(s, clock.now(), host, [], flags);
		expect(r.reasons).toEqual(["review_due"]);
		expect(r.calls).toEqual({ update: 1, select: 1 });
		commitWake(r, flags, clock.now());
		expect(wake(s, clock.now(), host, [], flags).reasons).toEqual([]);
		clock.advanceHours(100);
		expect(wake(s, clock.now(), host, [], flags).reasons).toEqual([]);
	});
	test("an uncommitted (failed) wake stays due", () => {
		const s = stateWith({ intents: [intent({ reviewAt: 0 })] });
		const flags = createWakeFlags();
		wake(s, 10, host, [], flags);
		expect(wake(s, 10, host, [], flags).reasons).toEqual(["review_due"]);
	});
	test("closed intents never wake", () => {
		const s = stateWith({
			intents: [intent({ state: "completed", reviewAt: 0 })],
		});
		expect(wake(s, 10, host, [], createWakeFlags()).reasons).toEqual([]);
	});
});

describe("wake: host gates stop everything", () => {
	const s = stateWith({ intents: [intent({ reviewAt: 0 })] });
	const ev: WakeEvent[] = [
		{ kind: "work.returned", id: "w1" },
		{ kind: "external.event", id: "e1" },
	];
	for (const [name, h, code] of [
		["OFF", { enabled: false }, "host_disabled"],
		["speaking", { presence: "speaking" as const }, "speaking"],
		["foreground", { foregroundBusy: true }, "foreground_busy"],
		["budget", { budgetOk: false }, "budget_exhausted"],
	] as const)
		test(name, () => {
			const r = wake(
				s,
				10,
				{ ...host, ...h, idleDue: true },
				ev,
				createWakeFlags(),
			);
			expect(r.reasons).toEqual([]);
			expect(r.calls).toEqual({ update: 0, select: 0 });
			expect(r.blocked).toEqual([{ reason: "all", code }]);
		});
});

describe("wake: work_returned updates only", () => {
	test("returned work never opens select", () => {
		const r = wake(
			stateWith({}),
			10,
			host,
			[{ kind: "work.returned", id: "w1" }],
			createWakeFlags(),
		);
		expect(r.reasons).toEqual(["work_returned"]);
		expect(r.calls).toEqual({ update: 1, select: 0 });
	});
	test("same return id fires once", () => {
		const flags = createWakeFlags();
		const ev: WakeEvent[] = [{ kind: "work.returned", id: "w1" }];
		commitWake(wake(stateWith({}), 10, host, ev, flags), flags, 10);
		expect(wake(stateWith({}), 20, host, ev, flags).reasons).toEqual([]);
	});
});

describe("wake: recall, cooldown, daily limit", () => {
	const clock = virtualClock("2026-11-02T09:00+09:00");
	test("recall needs an open interest or held intent", () => {
		const s = stateWith({ interests: [interest({ status: "faded" })] });
		const r = wake(
			s,
			clock.now(),
			host,
			[
				{
					kind: "recall.offered",
					id: "m1",
					refs: ["interest:n1", "intent:zz"],
				},
			],
			createWakeFlags(),
		);
		expect(r.reasons).toEqual([]);
		expect(r.blocked[0]?.code).toBe("not_open");
		const dormant = stateWith({ interests: [interest({ status: "dormant" })] });
		expect(
			wake(
				dormant,
				clock.now(),
				host,
				[{ kind: "recall.offered", id: "m1", refs: ["interest:n1"] }],
				createWakeFlags(),
			).reasons,
		).toEqual(["recall"]);
	});
	test("a cooling interest does not wake; after the cooldown it does", () => {
		const s = stateWith({
			interests: [interest({ lastEngagedAt: clock.now() })],
		});
		const ev: WakeEvent[] = [
			{ kind: "recall.offered", id: "m2", refs: ["interest:n1"] },
		];
		const flags = createWakeFlags();
		const r = wake(s, clock.plusHours(2), host, ev, flags);
		expect(r.reasons).toEqual([]);
		expect(r.blocked[0]?.code).toBe("cooldown");
		expect(wake(s, clock.plusHours(13), host, ev, flags).reasons).toEqual([
			"recall",
		]);
		const ext: WakeEvent[] = [
			{ kind: "external.event", id: "x1", interestId: "n1" },
		];
		expect(
			wake(s, clock.plusHours(2), host, ext, createWakeFlags()).blocked[0]
				?.code,
		).toBe("cooldown");
	});
	test("daily limit counts autonomous wakes per local day", () => {
		const flags = createWakeFlags();
		const s = stateWith({});
		const at = clock.now();
		for (let k = 0; k < 3; k++) {
			const r = wake(
				s,
				at + k,
				host,
				[{ kind: "external.event", id: `x${k}` }],
				flags,
			);
			expect(r.reasons).toEqual(["external_event"]);
			commitWake(r, flags, at + k);
		}
		const over = wake(
			s,
			at + 5,
			host,
			[{ kind: "external.event", id: "x9" }],
			flags,
		);
		expect(over.reasons).toEqual([]);
		expect(over.blocked[0]?.code).toBe("daily_limit");
		// next local day (JST)
		expect(
			wake(s, at + 24 * H, host, [{ kind: "external.event", id: "x9" }], flags)
				.reasons,
		).toEqual(["external_event"]);
	});
	test("a daily-limit-blocked event is deferred, not consumed by a coinciding reason", () => {
		const flags = createWakeFlags();
		const s = stateWith({ intents: [intent({ reviewAt: 0 })] });
		const full = { ...host };
		const day = 10 * 24 * H;
		for (let k = 0; k < 3; k++)
			commitWake(
				wake(
					s,
					day + k,
					full,
					[{ kind: "external.event", id: `x${k}` }],
					flags,
				),
				flags,
				day + k,
			);
		const r = wake(
			s,
			day + 10,
			full,
			[{ kind: "external.event", id: "late" }],
			flags,
		);
		expect(r.blocked.some((b) => b.code === "daily_limit")).toBe(true);
		commitWake(r, flags, day + 10);
		expect(flags.events.has("late")).toBe(false);
		expect(
			wake(
				s,
				day + 24 * H,
				full,
				[{ kind: "external.event", id: "late" }],
				flags,
			).reasons,
		).toContain("external_event");
	});
	test("a running delegation blocks recall / external / idle but not review or returns", () => {
		const s = stateWith({
			intents: [intent({ reviewAt: 0 })],
			interests: [interest({})],
		});
		const r = wake(
			s,
			10,
			{ ...host, delegationRunning: true, idleDue: true },
			[
				{ kind: "recall.offered", id: "m1", refs: ["interest:n1"] },
				{ kind: "external.event", id: "x1" },
				{ kind: "work.returned", id: "w1" },
			],
			createWakeFlags(),
		);
		expect(r.reasons).toEqual(["review_due", "work_returned"]);
		expect(r.blocked.map((b) => b.code)).toEqual([
			"delegation_running",
			"delegation_running",
			"delegation_running",
		]);
	});
});

describe("wake: fault", () => {
	test("same code wakes once per quiet window, update only", () => {
		const flags = createWakeFlags();
		const s = stateWith({});
		const r = wake(
			s,
			0,
			host,
			[
				{ kind: "fault.observed", id: "f1", code: "E1" },
				{ kind: "fault.observed", id: "f2", code: "E1" },
			],
			flags,
		);
		expect(r.reasons).toEqual(["fault"]);
		expect(r.calls).toEqual({ update: 1, select: 0 });
		commitWake(r, flags, 0);
		expect(
			wake(
				s,
				H,
				host,
				[{ kind: "fault.observed", id: "f3", code: "E1" }],
				flags,
			).reasons,
		).toEqual([]);
		expect(
			wake(
				s,
				7 * H,
				host,
				[{ kind: "fault.observed", id: "f4", code: "E1" }],
				flags,
			).reasons,
		).toEqual(["fault"]);
	});
});

describe("wake: LLM calls per wake are bounded", () => {
	test("any combination uses at most update 1 + select 1", () => {
		const s = stateWith({
			intents: [intent({ reviewAt: 0 })],
			interests: [interest({})],
		});
		const r = wake(
			s,
			10,
			{ ...host, idleDue: true },
			[
				{ kind: "recall.offered", id: "m1", refs: ["interest:n1"] },
				{ kind: "external.event", id: "x1" },
				{ kind: "work.returned", id: "w1" },
				{ kind: "fault.observed", id: "f1", code: "E" },
			],
			createWakeFlags(),
		);
		expect(r.reasons.length).toBe(6);
		expect(r.calls).toEqual({ update: 1, select: 0 });
	});
});

describe("activity budget", () => {
	test("tool calls, tokens and elapsed time each stop the activity", () => {
		const b = new ActivityBudget({ toolCalls: 2, tokens: 100, elapsedMs: H });
		b.start("i1", 0);
		expect(b.spend("i1", 1, { toolCalls: 1, tokens: 10 })).toBeNull();
		expect(b.canIssueTool("i1", 1)).toBe(true);
		expect(b.spend("i1", 2, { toolCalls: 1 })).toBeNull();
		expect(b.canIssueTool("i1", 2)).toBe(false);
		expect(b.spend("i1", 3, { toolCalls: 1 })).toBe("tool_calls");
		const t = new ActivityBudget({ toolCalls: 9, tokens: 100, elapsedMs: H });
		expect(t.spend("i2", 0, { tokens: 101 })).toBe("tokens");
		expect(t.exceeded("i3", 0)).toBeNull();
		t.start("i3", 0);
		expect(t.exceeded("i3", H + 1)).toBe("elapsed");
		t.end("i3");
		expect(t.use("i3")).toBeUndefined();
	});
});
