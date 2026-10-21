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
		const bad = toWire(proposal([intentUpdateOp("i1", 1)]));
		(bad.ops as Record<string, unknown>[])[0]!.reason = null;
		const wire = wireUpdateSchema("B2").parse(bad);
		expect(fromWire(wire, "B2")).toEqual({ ok: false });
	});

	test("the wire schema converts to JSON schema (no transforms, records or refinements)", () => {
		for (const c of ["B1", "B2", "F"] as const) {
			const json = JSON.stringify(z.toJSONSchema(wireUpdateSchema(c)));
			expect(json).not.toContain("oneOf");
			expect(json).not.toContain('anyOf":[{"type":"object"');
		}
	});
});
