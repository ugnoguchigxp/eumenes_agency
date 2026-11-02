/** P4-b: delegation boundary — request builder, host adapter limits, refusal frees the activity. */
import { describe, expect, test } from "bun:test";
import { createAgencyRuntime } from "../../src/application/runtime.ts";
import { delegationRequest } from "../../src/application/delegation.ts";
import { workReturnedObservation } from "../../src/contracts/delegation.ts";
import {
	defaultBudget,
	type ActionTicket,
} from "../../src/contracts/runtime.ts";
import {
	createH11Host,
	h11Violations,
	searchCorpus,
} from "../../eval/h11-host.ts";
import {
	HOUR,
	MIN,
	candidateAddOp,
	defaultLimits,
	fakeLlm,
	intentAddOp,
	obsInput,
	opportunity,
	participation,
	proposal,
	tools,
} from "./helpers.ts";

const sig = () => new AbortController().signal;
const withDelegate = [
	...tools,
	{ name: "delegate", description: "調査を委譲する", requiresApproval: false },
];
const BUDGET = { toolCalls: 3, tokens: 20_000, elapsedMs: 30 * MIN };

const make = () => {
	const llm = fakeLlm();
	const rt = createAgencyRuntime({
		systemContext: "experimental",
		condition: "B2",
		llm,
		tools: withDelegate,
		budget: { ...defaultBudget, minIntervalMs: 0, batchSize: 1 },
		limits: { ...defaultLimits, outboundIntervalMs: 0 },
		workReturns: true,
		activityLimits: BUDGET,
	});
	return { llm, rt };
};

const delegate = async (m: ReturnType<typeof make>) => {
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
	return d.decision.ticket!;
};

const H = 3_600_000;
const limits = {
	dailyCap: 2,
	maxElapsedMs: 3 * H,
	unitMs: 2 * H,
	tzOffsetMs: 9 * H,
};
const req = (
	workRef: string,
	at: number,
	over: Record<string, unknown> = {},
) => ({
	workRef,
	intentId: "i1",
	question: "京都の紅葉の見頃",
	desiredState: "見頃が分かっている",
	motive: "頼まれた",
	acceptance: "見頃を共有する",
	budget: { toolCalls: 3, tokens: 20_000, elapsedMs: 4 * H },
	origin: "autonomous" as const,
	requestedAt: at,
	...over,
});

describe("P4-b delegationRequest", () => {
	test("an autonomous delegate ticket bound to an intent becomes a request with what/why/acceptance", async () => {
		const m = make();
		const t = await delegate(m);
		const r = delegationRequest(t, m.rt.snapshot().state, BUDGET, 10 * MIN)!;
		const it = m.rt.snapshot().state.intents[0]!;
		expect(r.workRef).toBe(t.id);
		expect(r.intentId).toBe(it.id);
		expect(r.question).toBe("定跡を調べる");
		expect(r.acceptance).toBe(it.completionCondition);
		expect(r.motive).toBe(it.motive);
		expect(r.origin).toBe("autonomous");
		const { budget, ...identity } = r;
		expect(budget).toEqual(BUDGET);
		const hostBudget = delegationRequest(t, m.rt.snapshot().state, 10 * MIN)!;
		expect(hostBudget).toEqual(identity);
		expect(hostBudget).not.toHaveProperty("budget");
		expect(
			delegationRequest({ ...t, id: "other" }, m.rt.snapshot().state, 0),
		).toBeNull();
	});
	test("non-delegate, requested, or unbound tickets yield null", async () => {
		const m = make();
		const t = await delegate(m);
		const st = m.rt.snapshot().state;
		expect(
			delegationRequest(
				{ ...t, toolName: "run_compare" } as ActionTicket,
				st,
				BUDGET,
				0,
			),
		).toBeNull();
		expect(
			delegationRequest(
				{ ...t, origin: "requested" } as ActionTicket,
				st,
				BUDGET,
				0,
			),
		).toBeNull();
		expect(
			delegationRequest({ ...t, id: "other" } as ActionTicket, st, BUDGET, 0),
		).toBeNull();
	});
});

describe("P4-b host refusal", () => {
	test("a refused delegation frees the slot and ends the activity, so a later retry is not budget-deferred", async () => {
		const m = make();
		const t = await delegate(m);
		m.rt.recordResult({
			ticketId: t.id,
			status: "failed",
			at: 11 * MIN,
			resultText: "host refused: daily_cap",
		});
		expect(m.rt.snapshot().state.intents[0]!.workRef ?? null).toBeNull();
		m.llm.push("update", proposal());
		m.llm.push(
			"select",
			participation({
				action: "tool",
				candidateRef: { id: "c3", revision: 1 },
			}),
		);
		const d = await m.rt.decide(opportunity("op2", 2 * HOUR), sig());
		expect(d.decision.ticket?.toolName).toBe("delegate");
	});
});

describe("P4-b host adapter (eval/h11-host)", () => {
	const corpus = "eval/fixtures/h11-corpus";
	test("read-only search finds the matching corpus file", () => {
		expect(searchCorpus(corpus, "京都の紅葉の見頃")?.file).toBe("kyoto.md");
		expect(searchCorpus(corpus, "zzzz")).toBeNull();
	});
	test("enforced: daily cap, busy, budget ceiling, interruption", () => {
		const { host, log } = createH11Host(limits, corpus, { enforce: true });
		const s1 = host.start(req("a", 0));
		expect(s1.accepted && s1.budget.elapsedMs).toBe(3 * H);
		expect(host.start(req("b", 10))).toEqual({ accepted: false, code: "busy" });
		host.interrupt("a", H, "user_speaking");
		const [r1] = host.drain(H);
		expect(r1!.status).toBe("interrupted");
		expect(workReturnedObservation(r1!).workRef).toBe("a");
		expect(host.start(req("c", 2 * H)).accepted).toBe(true);
		expect(host.drain(4 * H).map((r) => r.status)).toEqual(["succeeded"]);
		expect(host.start(req("d", 5 * H))).toEqual({
			accepted: false,
			code: "daily_cap",
		});
		expect(host.start(req("e", 5 * H, { acceptance: "" }))).toEqual({
			accepted: false,
			code: "invalid_request",
		});
		expect(h11Violations(log, limits, 1, 1)).toEqual({
			dailyCap: 0,
			budget: 0,
			interruption: 0,
		});
	});
	test("naive host runs everything (cap exceeded)", () => {
		const { host, log } = createH11Host(limits, corpus, { enforce: false });
		for (const [i, ref] of ["a", "b", "c"].entries())
			expect(host.start(req(ref, i)).accepted).toBe(true);
		expect(h11Violations(log, limits, 0, 0).dailyCap).toBe(1);
	});
});
