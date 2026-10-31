/** P4-a: delegated work units on intents (workRef) and return ingestion, with H10 scripted returns. */
import { describe, expect, test } from "bun:test";
import { createAgencyRuntime } from "../../src/application/runtime.ts";
import { defaultBudget } from "../../src/contracts/runtime.ts";
import { workStatuses, type WorkStatus } from "../../src/contracts/model.ts";
import { scriptedReturn } from "../../eval/h10.ts";
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
const withDelegate = [
	...tools,
	{ name: "delegate", description: "調査を委譲する", requiresApproval: false },
];

const make = (
	workReturns = true,
	elapsedMs = 1e12,
	restore?: { state: any },
) => {
	const llm = fakeLlm();
	const rt = createAgencyRuntime({
		systemContext: "experimental",
		condition: "B2",
		llm,
		tools: withDelegate,
		budget: { ...defaultBudget, minIntervalMs: 0, batchSize: 1 },
		limits: { ...defaultLimits, outboundIntervalMs: 0 },
		workReturns,
		activityLimits: { toolCalls: 5, tokens: 1e9, elapsedMs },
		...(restore ? { restore } : {}),
	});
	return { llm, rt };
};

const delegateOnce = async (m: ReturnType<typeof make>) => {
	m.rt.observe(
		obsInput("o1", "user.report", "user", 0, "角換わりの定跡を整理したい"),
	);
	m.llm.push(
		"update",
		proposal([
			intentAddOp("g"),
			candidateAddOp("t", "g", {
				kind: "tool",
				toolName: "delegate",
				toolInput: "定跡を調べる",
			}),
			candidateAddOp("u", "g", {
				kind: "tool",
				toolName: "delegate",
				toolInput: "定跡を調べる（再）",
			}),
		]),
	);
	m.llm.push(
		"select",
		participation({ action: "tool", candidateRef: { id: "c2", revision: 1 } }),
	);
	const d = await m.rt.decide(opportunity("op1", 10 * MIN), sig());
	const t = d.decision.ticket!;
	m.rt.recordResult({
		ticketId: t.id,
		status: "succeeded",
		at: 11 * MIN,
		resultText: "accepted",
	});
	return t;
};
const intent = (m: ReturnType<typeof make>) =>
	m.rt.snapshot().state.intents[0]!;

describe("P4-a delegation (workRef)", () => {
	test("an autonomous delegation sets workRef, is tts:false, and blocks a second request until return", async () => {
		const m = make();
		const t = await delegateOnce(m);
		expect(t.action).toBe("tool");
		expect(t.origin).toBe("autonomous");
		expect(t.tts).toBe(false);
		expect(intent(m).workRef).toBe(t.id);
		m.llm.push("update", proposal());
		m.llm.push(
			"select",
			participation({
				action: "tool",
				candidateRef: { id: "c3", revision: 1 },
			}),
		);
		const again = await m.rt.decide(opportunity("op2", 20 * MIN), sig());
		expect(again.decision.ticket).toBeNull();
		expect(again.decision.source).toBe("host_delegation");
	});

	test("a work unit that never returns stops blocking after WORK_STALE_MS (held return:timeout)", async () => {
		const m = make();
		const t = await delegateOnce(m);
		const late = 11 * MIN + 49 * HOUR;
		m.rt.observe(
			obsInput("x2", "external.event", "host", late, "関連ニュース"),
		);
		m.llm.push("update", proposal());
		const w = await m.rt.wake!(late, quiet, sig());
		expect(w.blocked.map((b) => b.code)).not.toContain("delegation_running");
		expect(intent(m).workRef).toBeNull();
		expect(intent(m).lastReason).toBe("return:timeout");
		expect(t.id).toBeTruthy();
	});

	test("stale deadline survives restore (persisted workSince)", async () => {
		const m = make();
		await delegateOnce(m);
		expect(intent(m).workSince).toBe(10 * MIN);
		const late = 11 * MIN + 49 * HOUR;
		const r = make(true, 1e12, { state: m.rt.snapshot().state });
		r.rt.observe(
			obsInput("x2", "external.event", "host", late, "関連ニュース"),
		);
		r.llm.push("update", proposal());
		const w = await r.rt.wake!(late, quiet, sig());
		expect(w.blocked.map((b) => b.code)).not.toContain("delegation_running");
		expect(intent(r).workRef).toBeNull();
		expect(intent(r).lastReason).toBe("return:timeout");
	});

	test("while a work unit is in flight, recall/external wakes are suppressed", async () => {
		const m = make();
		await delegateOnce(m);
		m.rt.observe(
			obsInput("x1", "external.event", "host", 30 * MIN, "関連ニュース"),
		);
		const w = await m.rt.wake!(30 * MIN, quiet, sig());
		expect(w.blocked.map((b) => b.code)).toContain("delegation_running");
	});

	for (const status of workStatuses)
		test(`return "${status}": result, question and reviewAt recorded; no select, no re-request`, async () => {
			const m = make();
			const t = await delegateOnce(m);
			const at = HOUR;
			const before = m.llm.count("select");
			m.rt.observe(scriptedReturn("w1", t.id, status as WorkStatus, at));
			const it = intent(m);
			expect(it.workRef).toBeNull();
			expect(it.lastReturn?.status).toBe(status);
			expect(it.lastReturn?.summary.length).toBeGreaterThan(0);
			expect(it.lastReturn?.question !== null).toBe(status === "question");
			expect(it.reviewAt).toBeGreaterThanOrEqual(at + 24 * HOUR);
			expect(it.state).toBe(status === "succeeded" ? "adopted" : "held");
			m.llm.push("update", proposal());
			const w = await m.rt.wake!(at, quiet, sig());
			expect(w.reasons).toEqual(["work_returned"]);
			expect(w.decision).toBeNull();
			expect(m.llm.count("select")).toBe(before);
		});

	test.each([
		["unbounded", 1e12],
		[
			"30 min activity limit (P4-a reinforcement: a return ends the activity)",
			30 * MIN,
		],
	])(
		"interrupt → resume (%s): held after interruption; once re-adopted a new delegation is allowed",
		async (_n, elapsedMs) => {
			const m = make(true, elapsedMs);
			const t = await delegateOnce(m);
			m.rt.observe(scriptedReturn("w1", t.id, "interrupted", HOUR));
			expect(intent(m).state).toBe("held");
			m.llm.push("update", proposal());
			await m.rt.wake!(HOUR, quiet, sig());
			const it = intent(m);
			m.rt.observe(
				obsInput(
					"u2",
					"user.report",
					"user",
					2 * HOUR,
					"さっきの調べもの、続けていいよ",
				),
			);
			// batchSize 1: the older pending observation gets its own update first
			m.llm.push("update", proposal());
			m.llm.push(
				"update",
				proposal([
					intentUpdateOp(it.id, it.revision, {
						transition: "adopted",
						reason: "ユーザーが続けてよいと言った",
						evidenceRefs: ["u2"],
					}),
				]),
			);
			m.llm.push(
				"select",
				participation({
					action: "tool",
					candidateRef: { id: "c3", revision: 1 },
				}),
			);
			const d = await m.rt.decide(opportunity("op3", 2 * HOUR), sig());
			expect(intent(m).state).toBe("adopted");
			expect(d.decision.ticket?.toolName).toBe("delegate");
			expect(intent(m).workRef).toBe(d.decision.ticket!.id);
		},
	);

	test("before (workReturns:false): a second delegation goes out while the first is in flight", async () => {
		const m = make(false);
		const t = await delegateOnce(m);
		expect(intent(m).workRef ?? null).toBeNull();
		m.llm.push("update", proposal());
		m.llm.push(
			"select",
			participation({
				action: "tool",
				candidateRef: { id: "c3", revision: 1 },
			}),
		);
		const again = await m.rt.decide(opportunity("op2", 20 * MIN), sig());
		expect(again.decision.ticket?.toolName).toBe("delegate");
		m.rt.observe(scriptedReturn("w1", t.id, "question", HOUR));
		expect(intent(m).lastReturn ?? null).toBeNull();
	});
});
