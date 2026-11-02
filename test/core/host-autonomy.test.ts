import { expect, test } from "bun:test";
import {
	createAgencyRuntime,
	defaultBudget,
	defaultLimits,
	agencyOutputContract,
	type AgencySnapshot,
} from "../../src/index.ts";
import {
	fakeLlm,
	obsInput,
	opportunity,
	proposal,
	participation,
	intentAddOp,
	candidateAddOp,
	toWire,
} from "./helpers.ts";
const sig = () => new AbortController().signal;

test("host native contracts enumerate available tool names without changing legacy wire output", () => {
	const wire = toWire(
		proposal([
			candidateAddOp("c", "i1", {
				kind: "tool",
				toolName: "unavailable",
				toolInput: "{}",
			}),
		]),
	);
	const legacy = agencyOutputContract("update", { condition: "F" }).schema;
	const native = agencyOutputContract("update", {
		condition: "F",
		toolNames: ["delegate"],
	}).schema;
	expect(legacy.safeParse(wire).success).toBe(true);
	expect(native.safeParse(wire).success).toBe(false);
	(wire.ops as Record<string, unknown>[])[0]!.toolName = "delegate";
	expect(native.safeParse(wire).success).toBe(true);
	expect(
		agencyOutputContract("update", {
			condition: "F",
			toolNames: [],
		}).schema.safeParse(wire).success,
	).toBe(false);
	const pick = participation({ toolName: "unavailable" });
	expect(
		agencyOutputContract("select", {
			condition: "F",
			toolNames: ["delegate"],
		}).schema.safeParse(pick).success,
	).toBe(false);
});

test("a kind rejected after wire parsing supplies the operation's allowed choices to repair", async () => {
	const m = make();
	m.rt.observe(obsInput("o1", "user.report", "user", 0, "未解決"));
	const bad = toWire(proposal([intentAddOp("g"), candidateAddOp("c", "g")]));
	(bad.ops as Record<string, unknown>[])[1]!.kind = "understand";
	m.llm.push(
		"update",
		bad,
		(request: import("../../src/index.ts").LlmRequest<unknown>) => {
			expect(JSON.parse(request.prompt).validationCodes).toContain(
				"schema_expected:ops.1.kind:question|propose|share|tool",
			);
			return proposal([intentAddOp("g"), candidateAddOp("c", "g")]);
		},
	);
	expect((await m.rt.runBackground(1, sig())).at(-1)?.code).toBe("applied");
});

test("strict wire failures return bounded field diagnostics to the one repair call", async () => {
	const m = make();
	m.rt.observe(obsInput("o1", "user.report", "user", 0, "未解決"));
	const bad = toWire(proposal([intentAddOp("g")]));
	(bad.ops as Record<string, unknown>[])[0]!.resumeCondition = null;
	m.llm.push(
		"update",
		bad,
		(request: import("../../src/index.ts").LlmRequest<unknown>) => {
			expect(JSON.parse(request.prompt).validationCodes).toContain(
				"schema:ops.0.resumeCondition:invalid_type",
			);
			return proposal([intentAddOp("g")]);
		},
	);
	const calls = await m.rt.runBackground(1, sig());
	expect(calls[0]?.code).toBe("rejected:schema");
	expect(calls.at(-1)?.code).toBe("applied");
	expect(m.llm.count()).toBe(2);
	expect(m.rt.snapshot().continuity?.diagnostics).toEqual([]);
});
function make(restore?: AgencySnapshot, maxCallsPerWindow = 12) {
	const llm = fakeLlm();
	const rt = createAgencyRuntime({
		condition: "F",
		systemContext: { update: "host update", select: "host select" },
		llm,
		tools: [],
		planOnOpportunity: true,
		repairUpdates: true,
		budget: { ...defaultBudget, minIntervalMs: 0, maxCallsPerWindow },
		limits: { ...defaultLimits, outboundIntervalMs: 0 },
		...(restore ? { restore } : {}),
	});
	return { llm, rt };
}
test("a quiet opportunity plans from existing evidence without creating an observation", async () => {
	const m = make();
	m.rt.observe(obsInput("o1", "user.report", "user", 0, "比較が気になる"));
	m.llm.push("update", proposal([]));
	await m.rt.runBackground(1, sig());
	m.llm.push("update", proposal([intentAddOp("g"), candidateAddOp("c", "g")]));
	m.llm.push(
		"select",
		participation({
			action: "speak",
			candidateRef: { id: "c2", revision: 1 },
			evidenceRefs: ["o1"],
		}),
	);
	const r = await m.rt.decide(opportunity("idle", 2), sig());
	expect(r.decision.action).toBe("speak");
	expect(JSON.parse(m.llm.requests[1]!.prompt).opportunity.id).toBe("idle");
	expect(m.rt.snapshot().observations).toHaveLength(1);
});
test("a receipt-closed candidate is not reconciled again; rejection is corrected with diagnostics", async () => {
	const m = make();
	m.rt.observe(obsInput("o1", "user.report", "user", 0, "未解決"));
	m.llm.push("update", proposal([intentAddOp("g"), candidateAddOp("c", "g")]));
	m.llm.push(
		"select",
		participation({
			action: "speak",
			candidateRef: { id: "c2", revision: 1 },
			evidenceRefs: ["o1"],
		}),
	);
	const first = await m.rt.decide(opportunity("first", 1), sig());
	const receipt = m.rt.recordResult({
		ticketId: first.decision.ticket!.id,
		status: "succeeded",
		at: 2,
		resultText: "話しました",
	});
	m.llm.push(
		"update",
		{
			...proposal([]),
			reconciliations: [{ candidateId: "c2", observationRef: receipt.id }],
		},
		(request: import("../../src/index.ts").LlmRequest<unknown>) => {
			expect(JSON.parse(request.prompt).validationCodes).toContain(
				"bad_reconciliation",
			);
			return proposal([]);
		},
	);
	const calls = await m.rt.runBackground(3, sig());
	expect(calls[0]?.rejectCodes).toContain("bad_reconciliation");
	expect(calls.at(-1)?.code).toBe("no_change");
	expect(m.rt.snapshot().cursor).toBe(2);
	expect(m.rt.snapshot().state.candidates[0]?.state).toBe("closed");
});
test("formed interests are reference data with their status and provenance", () => {
	const m = make();
	const s = m.rt.snapshot();
	const restored = make({
		...s,
		state: {
			...s.state,
			interests: [
				{
					id: "k1",
					revision: 1,
					topic: "光学",
					origin: "own",
					status: "emerging",
					reason: "経験から",
					evidence: [],
					derivedFrom: null,
					lastEngagedAt: null,
					createdSeq: 0,
				},
			],
		},
	});
	expect(restored.rt.projection(4).items[0]).toMatchObject({
		kind: "interest",
		text: "光学",
		origin: "own",
		status: "emerging",
	});
});
test("restart preserves spent call budget and pending delivery tickets", async () => {
	const a = make(undefined, 2);
	a.rt.observe(obsInput("o1", "user.report", "user", 0, "問い"));
	a.llm.push("update", proposal([intentAddOp("g"), candidateAddOp("c", "g")]));
	a.llm.push(
		"select",
		participation({
			action: "speak",
			candidateRef: { id: "c2", revision: 1 },
			evidenceRefs: ["o1"],
		}),
	);
	const r = await a.rt.decide(opportunity("first", 1), sig());
	const b = make(a.rt.snapshot(), 2);
	const blocked = await b.rt.decide(opportunity("second", 2), sig());
	expect(blocked.calls.some((call) => call.code === "skipped:budget")).toBe(
		true,
	);
	expect(b.llm.count()).toBe(0);
	b.rt.recordResult({
		ticketId: r.decision.ticket!.id,
		status: "succeeded",
		at: 3,
		resultText: "配信",
	});
	expect(b.rt.snapshot().state.candidates[0]?.state).toBe("closed");
});
test("speech limit does not invent delivery or discard a candidate", async () => {
	const m = make();
	m.rt.observe(obsInput("o1", "user.report", "user", 0, "問い"));
	m.llm.push("update", proposal([intentAddOp("g"), candidateAddOp("c", "g")]));
	m.llm.push(
		"select",
		participation({
			action: "speak",
			candidateRef: { id: "c2", revision: 1 },
			evidenceRefs: ["o1"],
		}),
	);
	const r = await m.rt.decide(
		{ ...opportunity("idle", 1), speechAllowed: false },
		sig(),
	);
	expect(r.decision.ticket).toBeNull();
	expect(m.rt.snapshot().state.attempts).toHaveLength(0);
});

// Internal timing is checkpointed independently of whether the agent spoke.
test("idle checkpoint preserves unanswered limits and next opportunity time", async () => {
	const { createIdlePlanner } = await import("../../src/index.ts");
	const config = { idleSec: 20, maxUnanswered: 1 };
	const a = createIdlePlanner(config, 100);
	a.idleSilent(200);
	const b = createIdlePlanner(config, 1000, a.checkpoint());
	expect(b.delayMs(1000)).toBe(a.delayMs(1000));
	a.proactiveSpoke(2000);
	expect(createIdlePlanner(config, 3000, a.checkpoint()).blockedBy()).toBe(
		"unanswered",
	);
});
