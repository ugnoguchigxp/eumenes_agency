import { describe, expect, test } from "bun:test";
import type { AgencyState, Condition } from "../../src/contracts/model.ts";
import {
	reserveOutward,
	validateParticipation,
} from "../../src/domains/agency/participation.ts";
import { presentableCandidates } from "../../src/domains/agency/lifecycle.ts";
import {
	applyOrThrow,
	candidateAddOp,
	defaultLimits,
	emptyState,
	intentAddOp,
	intentUpdateOp,
	obs,
	participation,
	proposal,
	tools,
} from "./helpers.ts";

const o1 = obs(1, "user.report", "user");

const withCandidates = (): AgencyState =>
	applyOrThrow(
		emptyState(),
		proposal([
			intentAddOp("g"),
			candidateAddOp("k", "g"),
			candidateAddOp("t", "g", {
				kind: "tool",
				toolName: "run_compare",
				toolInput: "a b",
			}),
		]),
		[o1],
	);
// i1, c2 (share), c3 (tool)

const check = (
	p: ReturnType<typeof participation>,
	o: {
		condition?: Condition;
		state?: AgencyState;
		at?: number;
		seen?: [string, number][];
	} = {},
) => {
	const state = o.state ?? withCandidates();
	return validateParticipation({
		condition: o.condition ?? "B2",
		state,
		proposal: p,
		presentedObservations: new Set(["o1", "o2"]),
		presentedCandidates: new Map(
			o.seen ?? state.candidates.map((c) => [c.id, c.revision]),
		),
		tools,
		limits: defaultLimits,
		at: o.at ?? 1_000_000,
	});
};
const codes = (v: ReturnType<typeof check>) => (v.ok ? [] : v.codes);

describe("validateParticipation", () => {
	test("speak with a presented candidate at the same revision is valid", () => {
		const v = check(
			participation({
				action: "speak",
				candidateRef: { id: "c2", revision: 1 },
				evidenceRefs: ["o1"],
			}),
		);
		expect(v.ok && v.utterance).toBe("先ほどの比較結果をお伝えしましょうか");
	});

	test("revision mismatch is stale_revision", () => {
		expect(
			codes(
				check(
					participation({
						action: "speak",
						candidateRef: { id: "c2", revision: 4 },
						evidenceRefs: ["o1"],
					}),
				),
			),
		).toEqual(["stale_revision"]);
		// the model saw r1 but the state moved on
		const state = withCandidates();
		const c = state.candidates[0];
		if (c) c.revision = 2;
		expect(
			codes(
				check(
					participation({
						action: "speak",
						candidateRef: { id: "c2", revision: 1 },
						evidenceRefs: ["o1"],
					}),
					{
						state,
						seen: [["c2", 1]],
					},
				),
			),
		).toEqual(["stale_revision"]);
	});

	test("unknown or unpresented candidates and missing refs", () => {
		expect(codes(check(participation({ action: "speak" })))).toEqual([
			"missing_candidate",
		]);
		expect(
			codes(
				check(
					participation({
						action: "discard",
						candidateRef: { id: "c99", revision: 1 },
					}),
				),
			),
		).toEqual(["unknown_ref"]);
		expect(
			codes(
				check(
					participation({
						action: "speak",
						candidateRef: { id: "c2", revision: 1 },
						evidenceRefs: ["o1"],
					}),
					{
						seen: [],
					},
				),
			),
		).toEqual(["unknown_ref"]);
	});

	test("speak needs a non-tool candidate, tool needs a tool candidate", () => {
		expect(
			codes(
				check(
					participation({
						action: "speak",
						candidateRef: { id: "c3", revision: 1 },
						evidenceRefs: ["o1"],
					}),
				),
			),
		).toEqual(["bad_candidate_kind"]);
		expect(
			codes(
				check(
					participation({
						action: "tool",
						candidateRef: { id: "c2", revision: 1 },
					}),
				),
			),
		).toEqual(["bad_candidate_kind"]);
		const v = check(
			participation({
				action: "tool",
				candidateRef: { id: "c3", revision: 1 },
			}),
		);
		expect(v.ok && [v.toolName, v.toolInput]).toEqual(["run_compare", "a b"]);
	});

	test("evidence must be presented", () => {
		expect(
			codes(check(participation({ action: "wait", evidenceRefs: ["zz"] }))),
		).toEqual(["unknown_ref"]);
	});

	test("outbound interval", () => {
		const state = withCandidates();
		state.lastOutboundAt = 1_000_000 - 10_000;
		const p = participation({
			action: "speak",
			candidateRef: { id: "c2", revision: 1 },
			evidenceRefs: ["o1"],
		});
		expect(codes(check(p, { state }))).toEqual(["outbound_interval"]);
		expect(codes(check(p, { state, at: 1_000_000 + 60_000 }))).toEqual([]);
		// wait is never limited
		expect(codes(check(participation(), { state }))).toEqual([]);
	});

	test("B1: speak needs utterance and evidence, tool needs a real tool and input", () => {
		const b1 = { condition: "B1" as const, state: emptyState() };
		expect(codes(check(participation({ action: "speak" }), b1)).sort()).toEqual(
			["missing_evidence", "missing_utterance"].sort(),
		);
		expect(
			codes(
				check(
					participation({
						action: "speak",
						utterance: "どうぞ",
						evidenceRefs: ["o2"],
					}),
					b1,
				),
			),
		).toEqual([]);
		expect(
			codes(
				check(
					participation({ action: "tool", toolName: "nope", toolInput: "x" }),
					b1,
				),
			),
		).toEqual(["bad_tool"]);
		expect(
			codes(
				check(participation({ action: "tool", toolName: "run_compare" }), b1),
			),
		).toEqual(["bad_tool"]);
		expect(
			codes(
				check(
					participation({
						action: "tool",
						toolName: "run_compare",
						toolInput: "x",
					}),
					b1,
				),
			),
		).toEqual([]);
	});
});

describe("reserveOutward", () => {
	test("reserves the candidate, starts an attempt and sets lastOutboundAt", () => {
		const state = withCandidates();
		const v = check(
			participation({
				action: "speak",
				candidateRef: { id: "c2", revision: 1 },
				evidenceRefs: ["o1"],
			}),
			{ state },
		);
		if (!v.ok) throw new Error("expected ok");
		const ticket = reserveOutward(state, "op1", "speak", v, 5_000);
		expect(ticket.candidateId).toBe("c2");
		expect(ticket.candidateRevision).toBe(1);
		expect(state.candidates[0]?.state).toBe("reserved");
		expect(state.attempts[0]).toMatchObject({
			id: ticket.id,
			status: "running",
		});
		expect(state.lastOutboundAt).toBe(5_000);
		expect(ticket.stateRevision).toBe(state.revision);
	});
});

describe("validateParticipation: guarantees", () => {
	test("speak needs an evidence ref in B2/F too", () => {
		expect(
			codes(
				check(
					participation({
						action: "speak",
						candidateRef: { id: "c2", revision: 1 },
					}),
				),
			),
		).toEqual(["missing_evidence"]);
	});

	test("tools that need approval never get a ticket", () => {
		const state = applyOrThrow(
			emptyState(),
			proposal([
				intentAddOp("g"),
				candidateAddOp("t", "g", {
					kind: "tool",
					toolName: "delete_files",
					toolInput: "tmp",
				}),
			]),
			[o1],
		);
		expect(
			codes(
				check(
					participation({
						action: "tool",
						candidateRef: { id: "c2", revision: 1 },
					}),
					{ state },
				),
			),
		).toEqual(["approval_required"]);
		const b1 = { condition: "B1" as const, state: emptyState() };
		expect(
			codes(
				check(
					participation({
						action: "tool",
						toolName: "delete_files",
						toolInput: "x",
					}),
					b1,
				),
			),
		).toEqual(["approval_required"]);
	});

	test("candidates of a held or terminal intent are not presentable until re-adopted", () => {
		const held = applyOrThrow(
			withCandidates(),
			proposal([intentUpdateOp("i1", 1, { transition: "held" })]),
			[o1],
		);
		const p = participation({
			action: "speak",
			candidateRef: { id: "c2", revision: 1 },
			evidenceRefs: ["o1"],
		});
		expect(codes(check(p, { state: held, seen: [["c2", 1]] }))).toEqual([
			"stale_revision",
		]);
		expect(presentableCandidates(held)).toEqual([]);
		const back = applyOrThrow(
			held,
			proposal([intentUpdateOp("i1", 2, { transition: "adopted" })]),
			[o1],
		);
		expect(presentableCandidates(back).map((c) => c.id)).toEqual(["c2", "c3"]);
	});
});
