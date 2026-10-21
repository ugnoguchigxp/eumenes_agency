import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
	fromWire,
	wireOpNames,
	wireUpdateSchema,
} from "../../src/contracts/proposals.ts";
import {
	b1Proposal,
	candidateAddOp,
	candidateCloseOp,
	intentAddOp,
	intentUpdateOp,
	proposal,
	toWire,
} from "./helpers.ts";

const beliefAdd = {
	op: "belief.add",
	localId: "b",
	content: "推定",
	confidence: "low",
	evidenceRefs: ["o1"],
};
const beliefUpdate = {
	op: "belief.update",
	id: "b1",
	expectedRevision: 1,
	status: "disputed",
	content: null,
	confidence: "medium",
	evidenceRefs: ["o3"],
};
const desireAdd = {
	op: "desire.add",
	localId: "d",
	kind: "understand",
	object: "比較結果",
	reason: "未解決",
	evidenceRefs: ["o1"],
	beliefRefs: ["b"],
};
const desireUpdate = {
	op: "desire.update",
	id: "d2",
	expectedRevision: 1,
	status: "satisfied",
	reason: "終えた",
	evidenceRefs: ["o3"],
};
const noteOps = [
	{ op: "note.add", localId: "n", text: "メモ", evidenceRefs: ["o1"] },
	{
		op: "note.update",
		id: "n1",
		expectedRevision: 1,
		text: "改",
		evidenceRefs: [],
	},
	{ op: "note.delete", id: "n1", expectedRevision: 2 },
];

describe("wire update", () => {
	test("every op round-trips through the flat wire shape", () => {
		const b2Ops = [
			intentAddOp("g"),
			intentUpdateOp("i1", 1, {
				transition: "held",
				reviewAfterHours: 3,
				desiredState: "新",
			}),
			candidateAddOp("k", "g", {
				kind: "tool",
				toolName: "run_compare",
				toolInput: "a",
				supersedes: "c1",
			}),
			candidateCloseOp("c1", 2, { reason: "fulfilled", evidenceRefs: ["o3"] }),
		];
		const cases = [
			[
				"B2",
				proposal(b2Ops, {
					reconciliations: [{ candidateId: "c2", observationRef: "o4" }],
					focusRefs: ["i1"],
				}),
			],
			[
				"F",
				proposal([...b2Ops, beliefAdd, beliefUpdate, desireAdd, desireUpdate]),
			],
			["B1", b1Proposal(noteOps, ["n1"])],
		] as const;
		for (const [cond, typed] of cases) {
			const wire = wireUpdateSchema(cond).parse(toWire(typed));
			const back = fromWire(wire, cond);
			expect(back.ok).toBe(true);
			if (back.ok) expect(back.proposal).toEqual(typed as typeof back.proposal);
		}
	});

	test("the op enum is limited per condition and B1 has no reconciliations", () => {
		const intent = toWire(proposal([intentAddOp("g")]));
		expect(wireUpdateSchema("B1").safeParse(intent).success).toBe(false);
		expect(wireUpdateSchema("B2").safeParse(intent).success).toBe(true);
		expect(
			wireUpdateSchema("B2").safeParse(toWire(proposal([beliefAdd]))).success,
		).toBe(false);
		expect(
			wireUpdateSchema("F").safeParse(toWire(proposal([beliefAdd]))).success,
		).toBe(true);
		const withRecon = {
			...toWire(b1Proposal()),
			reconciliations: [{ candidateId: "c1", observationRef: "o1" }],
		};
		expect(wireUpdateSchema("B1").safeParse(withRecon).success).toBe(false);
		expect(wireOpNames.F.length).toBe(8);
	});

	test("missing required parts fail the strict re-validation", () => {
		const bad = toWire(proposal([candidateAddOp("k", "g")]));
		(bad.ops as Record<string, unknown>[])[0]!.text = null;
		const wire = wireUpdateSchema("B2").parse(bad);
		expect(fromWire(wire, "B2")).toEqual({ ok: false });
	});

	const fromOps = (ops: Record<string, unknown>[], cond: "B2" | "F" = "B2") =>
		fromWire(
			wireUpdateSchema(cond).parse(toWire(proposal(ops as never))),
			cond,
		);
	const wireOps = (ops: Record<string, unknown>[]) =>
		wireUpdateSchema("B2").parse(toWire(proposal(ops as never)));

	test("a tool candidate without text takes its content from toolName and toolInput", () => {
		const wire = wireOps([
			candidateAddOp("k", "g", {
				kind: "tool",
				toolName: "run_compare",
				toolInput: "a b",
			}),
		]);
		wire.ops[0]!.text = null;
		const r = fromWire(wire, "B2");
		expect(r.ok).toBe(true);
		if (r.ok)
			expect((r.proposal.ops[0] as { content: string }).content).toBe(
				"run_compare: a b",
			);
	});

	test("missing candidate text is still rejected unless a tool has toolInput", () => {
		for (const o of [
			candidateAddOp("k", "g"),
			candidateAddOp("k", "g", { kind: "question" }),
			candidateAddOp("k", "g", { kind: "tool", toolName: "run_compare" }),
		]) {
			const wire = wireOps([o]);
			wire.ops[0]!.text = null;
			expect(fromWire(wire, "B2")).toEqual({ ok: false });
		}
		const nonTool = wireOps([candidateAddOp("k", "g", { kind: "share" })]);
		nonTool.ops[0]!.text = null;
		nonTool.ops[0]!.toolInput = "x";
		expect(fromWire(nonTool, "B2")).toEqual({ ok: false });
	});

	test("a candidate.add without localId gets a unique placeholder", () => {
		const wire = wireOps([
			candidateAddOp("auto0", "g"),
			candidateAddOp("x", "g"),
			candidateAddOp("y", "g"),
		]);
		wire.ops[1]!.localId = null;
		wire.ops[2]!.localId = null;
		const r = fromWire(wire, "B2");
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		const ids = r.proposal.ops.map((o) => (o as { localId: string }).localId);
		expect(ids[0]).toBe("auto0");
		expect(new Set(ids).size).toBe(3);
		expect(ids[1]).not.toBe("auto0");
	});

	test("a missing localId is still rejected for other add ops", () => {
		const wire = wireOps([intentAddOp("g")]);
		wire.ops[0]!.localId = null;
		expect(fromWire(wire, "B2")).toEqual({ ok: false });
	});

	test("an intent.update without reason gets a fixed marker", () => {
		const wire = wireOps([intentUpdateOp("i1", 1)]);
		wire.ops[0]!.reason = null;
		const r = fromWire(wire, "B2");
		expect(r.ok).toBe(true);
		if (r.ok)
			expect((r.proposal.ops[0] as { reason: string }).reason).toBe(
				"(理由なし)",
			);
	});

	test("intent.add accepts the held initial state", () => {
		const r = fromOps([intentAddOp("g", { initialState: "held" })]);
		expect(r.ok).toBe(true);
		const bad = wireOps([intentAddOp("g")]);
		bad.ops[0]!.state = "completed";
		expect(fromWire(bad, "B2")).toEqual({ ok: false });
	});

	test("the wire schema converts to JSON schema (no transforms, records or refinements)", () => {
		for (const c of ["B1", "B2", "F"] as const) {
			const json = JSON.stringify(z.toJSONSchema(wireUpdateSchema(c)));
			expect(json).not.toContain("oneOf");
			expect(json).not.toContain('anyOf":[{"type":"object"');
		}
	});
});
