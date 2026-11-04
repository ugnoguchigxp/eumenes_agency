/** P3-a: wake.ts wired into the runtime (plan §5.2, §5.3). LLM is a scripted fake. */
import { describe, expect, test } from "bun:test";
import { createAgencyRuntime } from "../../src/application/runtime.ts";
import { defaultBudget } from "../../src/contracts/runtime.ts";
import type { Condition } from "../../src/contracts/model.ts";
import {
	HOUR,
	MIN,
	candidateAddOp,
	defaultLimits,
	fakeLlm,
	intentAddOp,
	intentUpdateOp,
	obsInput,
	opportunity,
	participation,
	proposal,
	tools,
} from "./helpers.ts";

const sig = () => new AbortController().signal;
const quiet = { presence: "quiet" as const, foregroundBusy: false };

const make = (
	condition: Condition = "B2",
	extra: Record<string, unknown> = {},
) => {
	const llm = fakeLlm();
	const rt = createAgencyRuntime({
		systemContext: "experimental",
		condition,
		llm,
		tools,
		budget: { ...defaultBudget, minIntervalMs: 0, batchSize: 1 },
		limits: { ...defaultLimits, outboundIntervalMs: 0 },
		...extra,
	});
	return { llm, rt };
};
type Made = ReturnType<typeof make>;

const seed = async (m: Made, extra: unknown[] = []) => {
	m.rt.observe(obsInput("o1", "user.report", "user", 0, "比較が未解決のまま"));
	m.llm.push(
		"update",
		proposal([intentAddOp("g"), candidateAddOp("k", "g"), ...extra]),
	);
	m.llm.push("select", participation());
	await m.rt.decide(opportunity("op0", 10 * MIN), sig());
	return m.llm.count();
};

describe("runtime wake (P3-a)", () => {
	test("review_due: nothing before reviewAt; one wake with update ≤1 + select ≤1; fires once", async () => {
		const m = make();
		const base = await seed(m);
		const reviewAt = m.rt.snapshot().state.intents[0]!.reviewAt;
		const early = await m.rt.wake!(reviewAt - 1, quiet, sig());
		expect(early.reasons).toEqual([]);
		expect(m.llm.count()).toBe(base);
		m.llm.push("update", proposal());
		m.llm.push("select", participation());
		const w = await m.rt.wake!(reviewAt + 1, quiet, sig());
		expect(w.reasons).toEqual(["review_due"]);
		expect(
			m.llm.count("update") + m.llm.count("select") - base,
		).toBeLessThanOrEqual(2);
		expect(m.llm.count("select")).toBe(2);
		const again = await m.rt.wake!(reviewAt + 2, quiet, sig());
		expect(again.reasons).toEqual([]);
		expect(m.llm.count()).toBe(base + 2);
	});

	test("work.returned: one update, never a select; fires once", async () => {
		const m = make();
		const base = await seed(m);
		m.rt.observe({
			id: "w1",
			kind: "work.returned",
			actor: "tool",
			occurredAt: 20 * MIN,
			text: "比較結果: A が速い",
		});
		m.llm.push("update", proposal());
		const w = await m.rt.wake!(20 * MIN, quiet, sig());
		expect(w.reasons).toEqual(["work_returned"]);
		expect(w.decision).toBeNull();
		expect(m.llm.count("update")).toBe(2);
		expect(m.llm.count("select")).toBe(1);
		expect(m.llm.count() - base).toBe(1);
		const again = await m.rt.wake!(21 * MIN, quiet, sig());
		expect(again.reasons).toEqual([]);
		expect(m.llm.count() - base).toBe(1);
	});

	test("OFF / speaking / foreground busy: no model call at all", async () => {
		for (const [setup, host] of [
			[(m: Made) => m.rt.setEnabled(false), quiet],
			[() => {}, { presence: "speaking" as const, foregroundBusy: false }],
			[() => {}, { presence: "quiet" as const, foregroundBusy: true }],
		] as const) {
			const m = make();
			const base = await seed(m);
			setup(m);
			m.rt.observe({
				id: "x1",
				kind: "external.event",
				actor: "host",
				occurredAt: 3 * HOUR,
				text: "新しい記事",
			});
			const w = await m.rt.wake!(3 * HOUR, { ...host, idleDue: true }, sig());
			expect(w.reasons).toEqual([]);
			expect(m.llm.count()).toBe(base);
		}
	});

	test("many events and pending observations still use at most update 1 + select 1", async () => {
		const m = make();
		const base = await seed(m);
		for (let k = 0; k < 4; k++)
			m.rt.observe(
				obsInput(`u${k}`, "user.report", "user", HOUR + k, `発言${k}`),
			);
		m.rt.observe({
			id: "x1",
			kind: "external.event",
			actor: "host",
			occurredAt: HOUR,
			text: "e",
		});
		m.rt.observe({
			id: "w1",
			kind: "work.returned",
			actor: "tool",
			occurredAt: HOUR,
			text: "r",
		});
		m.rt.observe({
			id: "f1",
			kind: "fault.observed",
			actor: "host",
			occurredAt: HOUR,
			text: "f",
			code: "E1",
		});
		for (let k = 0; k < 8; k++) m.llm.push("update", proposal());
		m.llm.push("select", participation());
		const w = await m.rt.wake!(3 * HOUR, { ...quiet, idleDue: true }, sig());
		expect(w.reasons.length).toBeGreaterThan(1);
		expect(m.llm.count("update") - 1).toBe(1);
		// the work return defers selection to the next opportunity (P3-b fix)
		expect(m.llm.count("select") - 1).toBe(0);
		expect(m.llm.count() - base).toBe(1);
	});
});

describe("activity budget wired into tickets (P3-a)", () => {
	test("a tool beyond the intent's budget is not issued and the intent is held", async () => {
		const m = make("B2", {
			activityLimits: { toolCalls: 1, tokens: 1e9, elapsedMs: 1e12 },
		});
		await seed(m, [
			candidateAddOp("t", "g", {
				kind: "tool",
				toolName: "run_compare",
				toolInput: "A B",
			}),
			candidateAddOp("u", "g", {
				kind: "tool",
				toolName: "run_compare",
				toolInput: "C D",
			}),
		]);
		m.llm.push(
			"select",
			participation({
				action: "tool",
				candidateRef: { id: "c3", revision: 1 },
			}),
		);
		const first = await m.rt.decide(opportunity("op1", 20 * MIN), sig());
		expect(first.decision.ticket?.action).toBe("tool");
		m.rt.recordResult({
			ticketId: first.decision.ticket!.id,
			status: "succeeded",
			at: 21 * MIN,
			resultText: "ok",
		});
		m.llm.push("update", proposal());
		m.llm.push(
			"select",
			participation({
				action: "tool",
				candidateRef: { id: "c4", revision: 1 },
			}),
		);
		const second = await m.rt.decide(opportunity("op2", 30 * MIN), sig());
		expect(second.decision.ticket).toBeNull();
		expect(second.decision.source).toBe("host_budget");
		expect(second.decision.rejectCodes).toEqual(["activity_budget"]);
		const i = m.rt.snapshot().state.intents[0]!;
		expect(i.state).toBe("held");
		expect(i.lastReason).toBe("budget");
	});
});

describe("H8 fixtures (P3-b)", () => {
	test("work.returned + review_due together: update only, select deferred to the next opportunity", async () => {
		const m = make();
		const base = await seed(m);
		const reviewAt = m.rt.snapshot().state.intents[0]!.reviewAt;
		m.rt.observe({
			id: "w1",
			kind: "work.returned",
			actor: "tool",
			occurredAt: reviewAt + 1,
			text: "比較結果: A が速い",
		});
		m.llm.push("update", proposal());
		const w = await m.rt.wake!(reviewAt + 1, quiet, sig());
		expect(w.reasons).toEqual(["review_due", "work_returned"]);
		expect(w.decision).toBeNull();
		expect(m.llm.count() - base).toBe(1);
		expect(m.llm.count("select")).toBe(1);
		m.llm.push("update", proposal());
		m.llm.push("select", participation());
		const next = await m.rt.wake!(
			reviewAt + 2 * MIN,
			{ ...quiet, idleDue: true },
			sig(),
		);
		expect(next.reasons).toEqual(["idle"]);
		expect(m.llm.count("select")).toBe(2);
	});

	test("budget exhaustion sleeps with zero calls, then resumes the same due event after the window", async () => {
		const m = make("B2", {
			budget: {
				...defaultBudget,
				minIntervalMs: 0,
				batchSize: 1,
				maxCallsPerWindow: 2,
				windowMs: HOUR,
			},
		});
		const base = await seed(m);
		m.rt.observe(
			obsInput("x1", "external.event", "host", 20 * MIN, "関連ニュース"),
		);
		const slept = await m.rt.wake!(20 * MIN, quiet, sig());
		expect(slept.blocked.map((b) => b.code)).toContain("budget_exhausted");
		expect(m.llm.count()).toBe(base);
		m.llm.push("update", proposal());
		m.llm.push("select", participation());
		const resumed = await m.rt.wake!(10 * MIN + HOUR + 1, quiet, sig());
		expect(resumed.reasons).toContain("external_event");
		expect(m.llm.count() - base).toBe(2);
		const again = await m.rt.wake!(10 * MIN + HOUR + 2 * MIN, quiet, sig());
		expect(again.reasons).toEqual([]);
	});
});

test("a bounded review drains queued observations before it can issue a ticket", async () => {
	const m = make("F", { budget: { ...defaultBudget, minIntervalMs: 0 } });
	await seed(m, [
		candidateAddOp("t", "g", {
			kind: "tool",
			toolName: "run_compare",
			toolInput: "A B",
		}),
	]);
	for (let n = 0; n < defaultBudget.batchSize; n++)
		m.rt.observe(
			obsInput("pre" + n, "exchange.adopted", "agent", n + 1, "既読"),
		);
	m.rt.observe(
		obsInput("withdraw", "correction", "user", 20, "この比較は取り消します"),
	);
	for (let n = 0; n < 32; n++)
		m.rt.observe(
			obsInput("extra" + n, "exchange.adopted", "agent", 30 + n, "別件"),
		);
	m.llm.push("update", proposal());
	const at = m.rt.snapshot().state.intents[0]!.reviewAt;
	const first = await m.rt.wake!(at, quiet, sig());
	expect(first.decision?.source).toBe("host_stale");
	expect(first.calls.map((c) => c.purpose)).toEqual(["update"]);
	expect(m.rt.snapshot().state.attempts).toHaveLength(0);
	expect(m.rt.snapshot().cursor).toBe(1 + defaultBudget.batchSize);
	// The review was deferred. Interpret the user's withdrawal on the next wake.
	m.llm.push(
		"update",
		proposal([
			intentUpdateOp("i1", 1, {
				transition: "abandoned",
				evidenceRefs: ["withdraw"],
			}),
		]),
	);
	const next = await m.rt.wake!(at + 1, quiet, sig());
	expect(next.reasons).toContain("review_due");
	expect(m.rt.snapshot().state.intents[0]!.state).toBe("abandoned");
	expect(next.decision?.ticket).toBeNull();
});
