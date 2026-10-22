/**
 * Regression tests for the 2026-10-22 independent review (spec/review-2026-10-22.md, R1-R7)
 * and the B1a ablation switch. The runtime-level ones use a scripted fake LLM.
 */
import { describe, expect, test } from "bun:test";
import { createAgencyRuntime } from "../../src/application/runtime.ts";
import { LlmCallError } from "../../src/contracts/errors.ts";
import type {
	AgencyState,
	Condition,
	Observation,
} from "../../src/contracts/model.ts";
import { fromWire, wireUpdateSchema } from "../../src/contracts/proposals.ts";
import { defaultBudget } from "../../src/contracts/runtime.ts";
import {
	ATTEMPT_RECEIPT_TTL_MS,
	presentableCandidates,
} from "../../src/domains/agency/lifecycle.ts";
import { settleUpdate } from "../../src/domains/agency/settle.ts";
import {
	MIN,
	applyOrThrow,
	candidateAddOp,
	candidateCloseOp,
	defaultLimits,
	emptyState,
	fakeLlm,
	intentAddOp,
	intentUpdateOp,
	obs,
	obsInput,
	opportunity,
	participation,
	proposal,
	toWire,
	tools,
} from "./helpers.ts";

const sig = () => new AbortController().signal;

const make = (condition: Condition, selectWhenEmpty?: boolean) => {
	const llm = fakeLlm();
	const rt = createAgencyRuntime({
		condition,
		llm,
		tools,
		budget: { ...defaultBudget, minIntervalMs: 0, maxCallsPerWindow: 100 },
		limits: { ...defaultLimits, outboundIntervalMs: 0 },
		...(selectWhenEmpty === undefined ? {} : { selectWhenEmpty }),
	});
	return { llm, rt };
};
type Made = ReturnType<typeof make>;

const user = (id: string, at: number, text = `発言 ${id}`) =>
	obsInput(id, "user.report", "user", at, text);

const toolOps = () =>
	proposal([
		intentAddOp("g"),
		candidateAddOp("k", "g", {
			kind: "tool",
			toolName: "run_compare",
			toolInput: "A B",
		}),
	]);
const reserveRef = (
	action: "speak" | "tool",
	id = "c2",
	revision = 1,
	ev = "o1",
) =>
	participation({
		action,
		candidateRef: { id, revision },
		evidenceRefs: [ev],
	});

/** o1 -> i1 + c2 ; then reserved at 1 min. Returns the first ticket id. */
const reserved = async (m: Made, action: "speak" | "tool") => {
	m.rt.observe(user("o1", 0));
	m.llm.push(
		"update",
		action === "tool"
			? toolOps()
			: proposal([intentAddOp("g"), candidateAddOp("k", "g")]),
	);
	m.llm.push("select", reserveRef(action));
	const d = await m.rt.decide(opportunity("op0", MIN), sig());
	const ticket = d.decision.ticket;
	if (!ticket) throw new Error("no ticket");
	return ticket;
};
const cand = (m: Made, id = "c2") =>
	m.rt.snapshot().state.candidates.find((c) => c.id === id);
const attempts = (m: Made) =>
	m.rt.snapshot().state.attempts.map((a) => [a.id, a.status]);

describe("R1: no select on a stale (quarantined) state", () => {
	/** An accepted first decide, then a declined topic whose update keeps failing. */
	const quarantine = async () => {
		const m = make("B2");
		m.rt.observe(user("o1", 0));
		m.llm.push(
			"update",
			proposal([intentAddOp("g"), candidateAddOp("k", "g")]),
		);
		m.llm.push("select", participation());
		await m.rt.decide(opportunity("op0", MIN), sig());
		m.rt.observe(user("o2", 2 * MIN, "その話はもうしないで"));
		const bad = proposal([intentUpdateOp("i1", 99)]);
		m.llm.push("update", bad, bad);
		const a = await m.rt.runBackground(3 * MIN, sig());
		const b = await m.rt.runBackground(4 * MIN, sig());
		expect(a[0]?.code).toBe("rejected:stale_revision");
		expect(b[0]?.code).toBe("rejected:stale_revision");
		return m;
	};

	test("decide waits with host_stale and never calls select or reserves", async () => {
		const m = await quarantine();
		const selects = m.llm.count("select");
		const updates = m.llm.count("update");
		m.llm.push("select", reserveRef("speak"));
		const r = await m.rt.decide(opportunity("op1", 5 * MIN), sig());
		expect(r.decision).toMatchObject({
			action: "wait",
			source: "host_stale",
			ticket: null,
		});
		expect(r.calls).toEqual([]);
		expect(m.llm.count("select")).toBe(selects);
		expect(m.llm.count("update")).toBe(updates);
		expect(m.rt.snapshot().state.attempts).toEqual([]);
		expect(m.rt.snapshot().cursor).toBe(1);
	});

	test("a new observation lifts the quarantine and decide updates first", async () => {
		const m = await quarantine();
		m.rt.observe(user("o3", 5 * MIN, "やっぱり続けて"));
		m.llm.push("update", proposal([]));
		m.llm.push("select", participation());
		const r = await m.rt.decide(opportunity("op1", 6 * MIN), sig());
		expect(r.decision.source).toBe("llm");
		expect(r.calls.map((c) => c.purpose)).toEqual(["update", "select"]);
	});

	test("quarantine without unprocessed observations is not stale", async () => {
		// Nothing pending: the state has seen everything, so select may proceed.
		const m = make("B2");
		m.rt.observe(user("o1", 0));
		m.llm.push(
			"update",
			proposal([intentAddOp("g"), candidateAddOp("k", "g")]),
		);
		m.llm.push("select", participation());
		const r = await m.rt.decide(opportunity("op0", MIN), sig());
		expect(r.decision.source).toBe("llm");
	});

	test("transient llm_call errors never quarantine; the update is retried", async () => {
		const m = make("B2");
		m.rt.observe(user("o1", 0));
		const transient = () => new LlmCallError("api_429:rate_limit_error", false);
		m.llm.push("update", transient(), transient(), transient());
		for (let i = 1; i <= 3; i++) {
			const out = await m.rt.runBackground(i * MIN, sig());
			expect(out[0]?.code).toBe("llm_call:api_429:rate_limit_error");
		}
		// Not quarantined: the model was called each time.
		expect(m.llm.count("update")).toBe(3);

		// decide fails for the opportunity and never selects on the stale state.
		m.llm.push("update", transient());
		m.llm.push("select", participation());
		const r = await m.rt.decide(opportunity("op0", 5 * MIN), sig());
		expect(r.decision).toMatchObject({ action: "wait", source: "error" });
		expect(m.llm.count("select")).toBe(0);

		// Once the provider recovers the batch is processed normally.
		m.llm.push("update", proposal([]));
		const ok = await m.rt.runBackground(6 * MIN, sig());
		expect(ok[0]?.code).toBe("no_change");
		expect(m.rt.snapshot().cursor).toBe(1);
	});
});

describe("R1: only retryable call errors skip the quarantine", () => {
	const failTwice = async (reason: string, retryable: boolean) => {
		const m = make("B2");
		m.rt.observe(user("o1", 0));
		// A retryable error is retried once inside the call, so script both attempts.
		const err = () => new LlmCallError(reason, retryable);
		m.llm.push("update", err(), err(), err(), err(), err(), err());
		await m.rt.runBackground(MIN, sig());
		await m.rt.runBackground(2 * MIN, sig());
		const calls = m.llm.count("update");
		await m.rt.runBackground(3 * MIN, sig());
		return m.llm.count("update") > calls;
	};

	test("429, 5xx and connection keep retrying", async () => {
		expect(await failTwice("api_429:rate_limit_error", true)).toBe(true);
		expect(await failTwice("api_529:overloaded_error", true)).toBe(true);
		expect(await failTwice("api_500:api_error", true)).toBe(true);
		expect(await failTwice("connection", true)).toBe(true);
	});

	test("auth, 400 and spend_limit count and quarantine", async () => {
		expect(await failTwice("api_401:authentication_error", false)).toBe(false);
		expect(await failTwice("api_400:invalid_request_error", false)).toBe(false);
		expect(await failTwice("spend_limit", false)).toBe(false);
	});
});

describe("R2: completion floor is the processed batch", () => {
	test("a backlog behind the batch does not block a legitimate completion", async () => {
		const m = make("B2");
		for (let i = 1; i <= 6; i++) m.rt.observe(user(`o${i}`, i * MIN));
		// Batch 1 = o1..o4 creates the intent; o5/o6 are only context for it.
		m.llm.push(
			"update",
			proposal([
				intentAddOp("g", { evidenceRefs: ["o1"] }),
				candidateAddOp("k", "g", { evidenceRefs: ["o1"] }),
			]),
		);
		// Batch 2 = o5,o6 completes it with o5, which arrived after the intent's batch.
		m.llm.push(
			"update",
			proposal([
				intentUpdateOp("i1", 1, {
					transition: "completed",
					reason: "ユーザーが終わったと言った",
					evidenceRefs: ["o5"],
				}),
			]),
		);
		const out = await m.rt.runBackground(10 * MIN, sig());
		expect(out.map((o) => o.code)).toEqual(["applied", "applied"]);
		const s = m.rt.snapshot().state;
		expect(s.intents[0]).toMatchObject({ state: "completed", createdSeq: 4 });
	});

	test("settle: createdSeq and stateSeq are the batch max, not the presented max", () => {
		const presented = [1, 2, 3, 4, 5, 6].map((n) =>
			obs(n, "user.report", "user"),
		);
		const batch = presented.slice(0, 4);
		const s1 = settleUpdate({
			condition: "B2",
			state: emptyState(),
			proposal: proposal([
				intentAddOp("g"),
				intentAddOp("h", { initialState: "held" }),
			]),
			presented,
			batch,
			tools,
			limits: defaultLimits,
			now: 1000,
		});
		if (s1.kind === "rejected") throw new Error(s1.codes.join());
		expect(s1.state.intents.map((i) => [i.createdSeq, i.stateSeq])).toEqual([
			[4, 4],
			[4, 4],
		]);
		// Empty batch (review.due): the processed cursor is the floor.
		const s2 = settleUpdate({
			condition: "B2",
			state: s1.state,
			proposal: proposal([
				intentUpdateOp("i1", 1, { transition: "held", reason: "待つ" }),
			]),
			presented,
			batch: [],
			cursor: 4,
			tools,
			limits: defaultLimits,
			now: 2000,
		});
		if (s2.kind === "rejected") throw new Error(s2.codes.join());
		expect(s2.state.intents[0]?.stateSeq).toBe(4);
	});
});

/** A state where c2 (tool or speak) has an outcome-unknown attempt. */
const unknownState = (action: "tool" | "speak" = "tool"): AgencyState => {
	const s = applyOrThrow(
		emptyState(),
		action === "tool"
			? toolOps()
			: proposal([intentAddOp("g"), candidateAddOp("k", "g")]),
		[obs(1, "user.report", "user")],
	);
	const c = s.candidates[0];
	if (!c) throw new Error("no candidate");
	c.state = "held";
	c.holdReason = "awaiting_outcome";
	c.revision = 3;
	s.attempts.push({
		id: "a9",
		candidateId: c.id,
		candidateRevision: 2,
		opportunityId: "op",
		action,
		status: "outcome_unknown",
		startedAt: 0,
	});
	return s;
};
const presentedAll = [1, 2, 3, 4, 5].map((n) =>
	obs(
		n,
		n === 4 ? "exchange.adopted" : "user.report",
		n === 4 ? "agent" : "user",
	),
);
const settle = (state: AgencyState, p: ReturnType<typeof proposal>) =>
	settleUpdate({
		condition: "B2",
		state,
		proposal: p,
		presented: presentedAll,
		tools,
		limits: defaultLimits,
		now: 1000,
	});
const codes = (r: ReturnType<typeof settle>) =>
	r.kind === "rejected" ? r.codes : [];

describe("R3: unknown-outcome candidates cannot be dropped", () => {
	test("settle rejects supersede and close of an awaiting_outcome candidate", () => {
		const s = unknownState();
		expect(
			codes(
				settle(
					s,
					proposal([
						candidateAddOp("n", "i1", {
							kind: "tool",
							toolName: "run_compare",
							toolInput: "A B",
							supersedes: "c2",
							evidenceRefs: ["o3"],
						}),
					]),
				),
			),
		).toEqual(["candidate_awaiting_outcome"]);
		for (const reason of ["dismissed", "superseded", "expired"] as const)
			expect(
				codes(settle(s, proposal([candidateCloseOp("c2", 3, { reason })]))),
			).toEqual(["candidate_awaiting_outcome"]);
		expect(
			codes(
				settle(
					s,
					proposal([
						candidateCloseOp("c2", 3, {
							reason: "fulfilled",
							evidenceRefs: ["o5"],
						}),
					]),
				),
			),
		).toEqual(["candidate_awaiting_outcome"]);
	});

	test("settle rejects reconciliation of an awaiting_outcome candidate", () => {
		const s = unknownState("speak");
		const r = settle(
			s,
			proposal([], {
				reconciliations: [{ candidateId: "c2", observationRef: "o4" }],
			}),
		);
		expect(codes(r)).toEqual(["candidate_awaiting_outcome"]);
	});

	test("a terminal intent's cascade keeps the candidate open for the receipt", () => {
		const s = unknownState();
		const r = settle(
			s,
			proposal([
				intentUpdateOp("i1", 1, {
					transition: "abandoned",
					reason: "不要",
				}),
			]),
		);
		if (r.kind === "rejected") throw new Error(r.codes.join());
		const c = r.state.candidates[0];
		expect(c).toMatchObject({ state: "held", holdReason: "awaiting_outcome" });
		expect(c?.revision).toBe(3);
		expect(r.state.intents[0]?.state).toBe("abandoned");
	});

	test("a tool candidate with the same effect is not presentable while unknown", () => {
		// Another candidate (e.g. renamed by the LLM) for the very same tool and input.
		const s = unknownState();
		const next = applyOrThrow(
			s,
			proposal([
				candidateAddOp("n", "i1", {
					kind: "tool",
					toolName: "run_compare",
					toolInput: "A B",
					evidenceRefs: ["o1"],
				}),
				candidateAddOp("m", "i1", {
					kind: "tool",
					toolName: "run_compare",
					toolInput: "C D",
					evidenceRefs: ["o1"],
				}),
			]),
			presentedAll,
		);
		expect(presentableCandidates(next).map((c) => c.toolInput)).toEqual([
			"C D",
		]);
	});

	test("runtime: superseding an unknown-outcome tool candidate cannot re-reserve the effect", async () => {
		const m = make("B2");
		const t = await reserved(m, "tool");
		m.rt.recordResult({
			ticketId: t.id,
			status: "outcome_unknown",
			at: 2 * MIN,
			resultText: "?",
		});
		expect(cand(m)).toMatchObject({
			state: "held",
			holdReason: "awaiting_outcome",
		});
		m.rt.observe(user("o3", 3 * MIN));
		m.llm.push(
			"update",
			proposal([
				candidateAddOp("n", "i1", {
					kind: "tool",
					toolName: "run_compare",
					toolInput: "A B",
					supersedes: "c2",
					evidenceRefs: ["o3"],
				}),
			]),
		);
		m.llm.push("select", reserveRef("tool", "c5", 1, "o3"));
		const d = await m.rt.decide(opportunity("op1", 4 * MIN), sig());
		expect(d.decision).toMatchObject({ action: "wait", ticket: null });
		expect(d.decision.rejectCodes).toEqual(["candidate_awaiting_outcome"]);
		// Only the first reservation's select was ever called.
		expect(m.llm.count("select")).toBe(1);
		const st = m.rt.snapshot().state;
		expect(st.candidates).toHaveLength(1);
		expect(st.attempts).toHaveLength(1);
		expect(cand(m)).toMatchObject({
			state: "held",
			holdReason: "awaiting_outcome",
		});
	});
});

describe("R4: receipts follow the candidate's current attempt", () => {
	test("a late receipt of an interrupted attempt does not touch the re-reserved candidate", async () => {
		const m = make("B2");
		const t1 = await reserved(m, "speak");
		m.rt.invalidate("input.changed", MIN);
		expect(cand(m)).toMatchObject({
			state: "held",
			holdReason: "after_failure",
		});
		const rev = cand(m)?.revision ?? 0;
		m.llm.push("select", reserveRef("speak", "c2", rev));
		const d2 = await m.rt.decide(opportunity("op1", 2 * MIN), sig());
		expect(d2.decision.ticket).not.toBeNull();
		expect(cand(m)?.state).toBe("reserved");
		const before = cand(m);

		m.rt.recordResult({
			ticketId: t1.id,
			status: "succeeded",
			at: 3 * MIN,
			resultText: "x",
		});
		// The old attempt's record is updated; the live reservation is untouched.
		expect(cand(m)).toEqual(before);
		expect(attempts(m)).toEqual([
			["a3", "succeeded"],
			[d2.decision.ticket?.id ?? "", "running"],
		]);

		// The real receipt for the live attempt still applies.
		m.rt.recordResult({
			ticketId: d2.decision.ticket?.id ?? "",
			status: "succeeded",
			at: 4 * MIN,
			resultText: "y",
		});
		expect(cand(m)).toMatchObject({
			state: "closed",
			closedReason: "fulfilled",
		});
	});

	test("a terminal attempt status is never regressed by a late receipt", async () => {
		const m = make("B2");
		const t = await reserved(m, "speak");
		m.rt.recordResult({
			ticketId: t.id,
			status: "succeeded",
			at: 2 * MIN,
			resultText: "x",
		});
		expect(cand(m)).toMatchObject({
			state: "closed",
			closedReason: "fulfilled",
		});
		const closed = cand(m);
		for (const status of ["failed", "interrupted", "outcome_unknown"] as const)
			m.rt.recordResult({
				ticketId: t.id,
				status,
				at: 3 * MIN,
				resultText: "z",
			});
		expect(attempts(m)).toEqual([[t.id, "succeeded"]]);
		expect(cand(m)).toEqual(closed);
	});

	test("a duplicate failure receipt does not move a candidate that is already re-evaluated", async () => {
		const m = make("B2");
		const t = await reserved(m, "speak");
		m.rt.recordResult({
			ticketId: t.id,
			status: "failed",
			at: 2 * MIN,
			resultText: "x",
		});
		const held = cand(m);
		expect(held).toMatchObject({ state: "held", holdReason: "after_failure" });
		m.rt.recordResult({
			ticketId: t.id,
			status: "interrupted",
			at: 3 * MIN,
			resultText: "x",
		});
		expect(cand(m)).toEqual(held);
		expect(attempts(m)).toEqual([[t.id, "failed"]]);
	});

	test("a tool attempt interrupted by invalidate is outcome-unknown, not re-presentable", async () => {
		const m = make("B2");
		const t = await reserved(m, "tool");
		m.rt.invalidate("input.changed", MIN);
		expect(attempts(m)).toEqual([[t.id, "outcome_unknown"]]);
		expect(cand(m)).toMatchObject({
			state: "held",
			holdReason: "awaiting_outcome",
		});
		expect(presentableCandidates(m.rt.snapshot().state)).toEqual([]);

		// Nothing to select: the host does not offer it again.
		const d = await m.rt.decide(opportunity("op1", 2 * MIN), sig());
		expect(d.decision.source).toBe("host_no_candidates");
		expect(m.llm.count("select")).toBe(1);

		// The host's reconciled receipt settles it.
		m.rt.recordResult({
			ticketId: t.id,
			status: "succeeded",
			at: 3 * MIN,
			resultText: "ok",
		});
		expect(cand(m)).toMatchObject({
			state: "closed",
			closedReason: "fulfilled",
		});
		expect(attempts(m)).toEqual([[t.id, "succeeded"]]);
	});

	test("an invalidated tool attempt reconciled as failed goes to after_failure", async () => {
		const m = make("B2");
		const t = await reserved(m, "tool");
		m.rt.invalidate("settings.changed", MIN);
		m.rt.recordResult({
			ticketId: t.id,
			status: "failed",
			at: 2 * MIN,
			resultText: "no",
		});
		expect(cand(m)).toMatchObject({
			state: "held",
			holdReason: "after_failure",
		});
	});

	test("a late success of an interrupted speak that was not re-reserved closes the candidate", async () => {
		const m = make("B2");
		const t = await reserved(m, "speak");
		m.rt.invalidate("input.changed", MIN);
		expect(cand(m)).toMatchObject({
			state: "held",
			holdReason: "after_failure",
		});
		m.rt.recordResult({
			ticketId: t.id,
			status: "succeeded",
			at: 2 * MIN,
			resultText: "x",
		});
		expect(cand(m)).toMatchObject({
			state: "closed",
			closedReason: "fulfilled",
		});
		expect(attempts(m)).toEqual([[t.id, "succeeded"]]);
		expect(presentableCandidates(m.rt.snapshot().state)).toEqual([]);
	});

	test("the same holds after a re-evaluation deferred the candidate", async () => {
		const m = make("B2");
		const t = await reserved(m, "speak");
		m.rt.invalidate("input.changed", MIN);
		const rev = cand(m)?.revision ?? 0;
		m.llm.push(
			"select",
			participation({ candidateRef: { id: "c2", revision: rev } }),
		);
		await m.rt.decide(opportunity("op1", 2 * MIN), sig());
		expect(cand(m)).toMatchObject({ state: "held", holdReason: "deferred" });
		m.rt.recordResult({
			ticketId: t.id,
			status: "succeeded",
			at: 3 * MIN,
			resultText: "x",
		});
		expect(cand(m)).toMatchObject({
			state: "closed",
			closedReason: "fulfilled",
		});
	});

	test("a late failure of an interrupted attempt leaves the candidate re-evaluable", async () => {
		const m = make("B2");
		const t = await reserved(m, "speak");
		m.rt.invalidate("input.changed", MIN);
		const before = cand(m);
		m.rt.recordResult({
			ticketId: t.id,
			status: "failed",
			at: 2 * MIN,
			resultText: "x",
		});
		expect(cand(m)).toEqual(before);
		expect(attempts(m)).toEqual([[t.id, "failed"]]);
	});

	test("an unanswered reservation is released after the receipt TTL", async () => {
		const speak = make("B2");
		await reserved(speak, "speak");
		// Within the TTL nothing changes.
		await speak.rt.decide(opportunity("op1", 2 * MIN), sig());
		expect(cand(speak)?.state).toBe("reserved");
		await speak.rt.decide(
			opportunity("op2", MIN + ATTEMPT_RECEIPT_TTL_MS + 1),
			sig(),
		);
		expect(attempts(speak)).toEqual([["a3", "interrupted"]]);
		expect(cand(speak)).toMatchObject({
			state: "held",
			holdReason: "after_failure",
		});

		const tool = make("B2");
		await reserved(tool, "tool");
		await tool.rt.decide(
			opportunity("op2", MIN + ATTEMPT_RECEIPT_TTL_MS + 1),
			sig(),
		);
		expect(attempts(tool)).toEqual([["a3", "outcome_unknown"]]);
		expect(cand(tool)).toMatchObject({
			state: "held",
			holdReason: "awaiting_outcome",
		});
	});
});

describe("R5: typed text limits match the wire limits", () => {
	const long = (n: number) => "あ".repeat(n);
	const flat = (ops: unknown[]) => ({
		...toWire(proposal(ops)),
	});

	test("400 characters pass for desiredState, belief content and desire object", () => {
		const ops = [
			intentAddOp("g", { desiredState: long(400) }),
			{
				op: "belief.add",
				localId: "b",
				content: long(400),
				confidence: "low",
				evidenceRefs: ["o1"],
			},
			{
				op: "desire.add",
				localId: "d",
				kind: "understand",
				object: long(400),
				reason: "r",
				evidenceRefs: ["o1"],
				beliefRefs: [],
			},
		];
		const wire = flat(ops);
		expect(wireUpdateSchema("F").safeParse(wire).success).toBe(true);
		expect(fromWire(wire as never, "F").ok).toBe(true);
	});

	test("updates of desiredState and belief content accept 400 too", () => {
		const ops = [
			intentUpdateOp("i1", 1, { desiredState: long(400) }),
			{
				op: "belief.update",
				id: "b2",
				expectedRevision: 1,
				status: "active",
				content: long(400),
				confidence: null,
				evidenceRefs: [],
			},
		];
		expect(fromWire(flat(ops) as never, "F").ok).toBe(true);
	});

	test("401 characters are still rejected by both schemas", () => {
		const wire = flat([intentAddOp("g", { desiredState: long(400) })]);
		const over = {
			...wire,
			ops: (wire.ops as Record<string, unknown>[]).map((o) => ({
				...o,
				text: long(401),
			})),
		};
		expect(wireUpdateSchema("B2").safeParse(over).success).toBe(false);
		expect(fromWire(over as never, "B2").ok).toBe(false);
	});
});

describe("R6: desire.satisfied and high beliefs need newer independent evidence", () => {
	const o = (seq: number) => obs(seq, "user.report", "user");
	const runF = (
		state: AgencyState,
		ops: unknown[],
		presented: Observation[],
		batch: Observation[],
	) =>
		settleUpdate({
			condition: "F",
			state,
			proposal: proposal(ops),
			presented,
			batch,
			tools,
			limits: defaultLimits,
			now: 1000,
		});
	const codesF = (r: ReturnType<typeof runF>) =>
		r.kind === "rejected" ? r.codes : [];
	const seed = () => {
		const r = runF(
			emptyState(),
			[
				{
					op: "belief.add",
					localId: "b",
					content: "信念",
					confidence: "medium",
					evidenceRefs: ["o2"],
				},
				{
					op: "desire.add",
					localId: "d",
					kind: "finish",
					object: "対象",
					reason: "r",
					evidenceRefs: ["o2"],
					beliefRefs: [],
				},
			],
			[o(1), o(2), o(3), o(4)],
			[o(1), o(2)],
		);
		if (r.kind === "rejected") throw new Error(r.codes.join());
		return r.state;
	};
	const later = [o(1), o(2), o(3), o(4)];

	test("created items record the batch max as createdSeq", () => {
		const s = seed();
		expect(s.beliefs[0]?.createdSeq).toBe(2);
		expect(s.desires[0]?.createdSeq).toBe(2);
	});

	test("desire.satisfied: evidence from before the desire is rejected, newer accepted", () => {
		const s = seed();
		const sat = (ref: string) => [
			{
				op: "desire.update",
				id: "d4",
				expectedRevision: 1,
				status: "satisfied",
				reason: "済み",
				evidenceRefs: [ref],
			},
		];
		const id = s.desires[0]?.id ?? "";
		const op = (ref: string) => [{ ...sat(ref)[0], id }];
		expect(codesF(runF(s, op("o1"), later, [o(3)]))).toEqual([
			"missing_evidence",
		]);
		expect(codesF(runF(s, op("o2"), later, [o(3)]))).toEqual([
			"missing_evidence",
		]);
		expect(runF(s, op("o3"), later, [o(3)]).kind).toBe("applied");
	});

	test("belief.update raising confidence needs evidence newer than the belief", () => {
		const s = seed();
		const id = s.beliefs[0]?.id ?? "";
		const up = (ref: string) => [
			{
				op: "belief.update",
				id,
				expectedRevision: 1,
				status: "active",
				content: null,
				confidence: "high",
				evidenceRefs: [ref],
			},
		];
		expect(codesF(runF(s, up("o1"), later, [o(3)]))).toEqual([
			"self_reinforcement",
		]);
		expect(runF(s, up("o4"), later, [o(3), o(4)]).kind).toBe("applied");
	});

	test("belief.add(high) needs independent evidence from the batch being interpreted", () => {
		const add = (ref: string) => [
			{
				op: "belief.add",
				localId: "b",
				content: "確実",
				confidence: "high",
				evidenceRefs: [ref],
			},
		];
		// o1/o2 were processed earlier (context only); o3/o4 are the batch.
		expect(codesF(runF(emptyState(), add("o1"), later, [o(3), o(4)]))).toEqual([
			"missing_evidence",
		]);
		expect(runF(emptyState(), add("o3"), later, [o(3), o(4)]).kind).toBe(
			"applied",
		);
	});
});

describe("R7: reconciliation and fulfilled need evidence newer than the candidate", () => {
	const seqs = [1, 2, 3, 4, 5, 6];
	const kinds = (n: number) =>
		n === 2 || n === 6
			? obs(n, "exchange.adopted", "agent")
			: obs(n, "user.report", "user");
	const presented = seqs.map(kinds);
	// The candidate is created from batch o3..o4: createdSeq 4.
	const created = (): AgencyState => {
		const r = settleUpdate({
			condition: "B2",
			state: emptyState(),
			proposal: proposal([
				intentAddOp("g", { evidenceRefs: ["o3"] }),
				candidateAddOp("k", "g", { evidenceRefs: ["o3"] }),
			]),
			presented,
			batch: presented.slice(2, 4),
			tools,
			limits: defaultLimits,
			now: 0,
		});
		if (r.kind === "rejected") throw new Error(r.codes.join());
		return r.state;
	};
	const run = (s: AgencyState, p: ReturnType<typeof proposal>) =>
		settleUpdate({
			condition: "B2",
			state: s,
			proposal: p,
			presented,
			batch: presented.slice(4),
			tools,
			limits: defaultLimits,
			now: 1000,
		});
	const rejected = (r: ReturnType<typeof run>) =>
		r.kind === "rejected" ? r.codes : [];

	test("candidate records createdSeq", () => {
		expect(created().candidates[0]?.createdSeq).toBe(4);
	});

	test("reconciliation with an older response is rejected; a newer one is accepted", () => {
		const s = created();
		const rec = (ref: string) =>
			proposal([], {
				reconciliations: [{ candidateId: "c2", observationRef: ref }],
			});
		expect(rejected(run(s, rec("o2")))).toEqual(["bad_reconciliation"]);
		const ok = run(s, rec("o6"));
		expect(ok.kind).toBe("applied");
	});

	test("candidate.close(fulfilled) must cite something newer than the candidate", () => {
		const s = created();
		const close = (ref: string) =>
			proposal([
				candidateCloseOp("c2", 1, { reason: "fulfilled", evidenceRefs: [ref] }),
			]);
		expect(rejected(run(s, close("o2")))).toEqual(["stale_evidence"]);
		expect(rejected(run(s, close("o3")))).toEqual(["stale_evidence"]);
		expect(run(s, close("o5")).kind).toBe("applied");
		// Other reasons need no evidence at all.
		expect(
			run(s, proposal([candidateCloseOp("c2", 1, { reason: "dismissed" })]))
				.kind,
		).toBe("applied");
	});

	test("the cascade path applies the same rule", () => {
		const s = created();
		const p = (ref: string) =>
			proposal([
				intentUpdateOp("i1", 1, {
					transition: "completed",
					reason: "済",
					evidenceRefs: ["o5"],
				}),
				candidateCloseOp("c2", 1, { reason: "fulfilled", evidenceRefs: [ref] }),
			]);
		expect(rejected(run(s, p("o2")))).toEqual(["stale_evidence"]);
		expect(run(s, p("o6")).kind).toBe("applied");
	});
});

describe("selectWhenEmpty (B1a)", () => {
	const speak = participation({
		action: "speak",
		utterance: "さっきの件、どうなりましたか",
		evidenceRefs: ["o1"],
	});

	test("default: B1 without notes does not call select", async () => {
		const m = make("B1");
		m.rt.observe(user("o1", 0));
		m.llm.push("update", {
			summary: "s",
			missingInfo: null,
			focusRefs: [],
			ops: [],
		});
		const r = await m.rt.decide(opportunity("op0", MIN), sig());
		expect(r.decision.source).toBe("host_no_candidates");
		expect(m.llm.count("select")).toBe(0);
	});

	test("true: B1 without notes still selects and may speak", async () => {
		const m = make("B1", true);
		m.rt.observe(user("o1", 0));
		m.llm.push("update", {
			summary: "s",
			missingInfo: null,
			focusRefs: [],
			ops: [],
		});
		m.llm.push("select", speak);
		const r = await m.rt.decide(opportunity("op0", MIN), sig());
		expect(m.llm.count("select")).toBe(1);
		expect(r.decision).toMatchObject({ action: "speak", source: "llm" });
		expect(r.decision.ticket).not.toBeNull();
	});

	test("true: other host checks still apply", async () => {
		const m = make("B1", true);
		m.rt.observe(user("o1", 0));
		const r = await m.rt.decide(
			opportunity("op0", MIN, { presence: "speaking" }),
			sig(),
		);
		expect(r.decision.source).toBe("host_blocked");
		expect(m.llm.count()).toBe(0);
		// Speak still needs an evidence ref that was presented.
		m.llm.push("update", {
			summary: "s",
			missingInfo: null,
			focusRefs: [],
			ops: [],
		});
		m.llm.push("select", { ...speak, evidenceRefs: [] });
		const bad = await m.rt.decide(opportunity("op1", 2 * MIN), sig());
		expect(bad.decision).toMatchObject({ action: "wait", source: "rejected" });
		expect(bad.decision.rejectCodes).toContain("missing_evidence");
	});

	test("true is ignored by B2", async () => {
		const m = make("B2", true);
		m.rt.observe(user("o1", 0));
		m.llm.push("update", proposal([]));
		const r = await m.rt.decide(opportunity("op0", MIN), sig());
		expect(r.decision.source).toBe("host_no_candidates");
		expect(m.llm.count("select")).toBe(0);
	});
});

describe("prompts state the new host rules (B2/F only)", () => {
	const sys = async (c: Condition) => {
		const m = make(c);
		m.rt.observe(user("o1", 0));
		m.llm.push(
			"update",
			c === "B1"
				? { summary: "s", missingInfo: null, focusRefs: [], ops: [] }
				: proposal(),
		);
		await m.rt.runBackground(MIN, sig());
		return m.llm.requests[0]?.system ?? "";
	};

	test("B2 and F carry the candidate rules, B1 does not", async () => {
		const [b1, b2, f] = await Promise.all([sys("B1"), sys("B2"), sys("F")]);
		for (const t of [b2, f]) {
			expect(t).toContain("その候補ができた後に届いた観測を少なくとも1件");
			expect(t).toContain("awaiting_outcome");
			expect(t).toContain("その応答は、候補ができた後に届いたもの");
		}
		expect(b2).not.toContain("信念ができた後に届いた観測");
		expect(f).toContain("信念ができた後に届いた観測だけが");
		expect(f).toContain("その欲求ができた後に届いたものを");
		expect(b1).not.toContain("awaiting_outcome");
		expect(b1).not.toContain("信念ができた後");
	});
});
