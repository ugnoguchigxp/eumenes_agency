import { describe, expect, test } from "bun:test";
import type { AgencyState, Limits } from "../../src/contracts/model.ts";
import { settleUpdate } from "../../src/domains/agency/settle.ts";
import {
	applyOrThrow,
	b1Proposal,
	candidateAddOp,
	candidateCloseOp,
	defaultLimits,
	emptyState,
	intentAddOp,
	intentUpdateOp,
	obs,
	proposal,
	tools,
} from "./helpers.ts";

const o1 = obs(1, "user.report", "user");
const o2 = obs(2, "delivery.observed", "agent");
const o3 = obs(3, "user.report", "user");
const o4 = obs(4, "exchange.adopted", "agent");
const o5 = obs(5, "action.observed", "tool");
const all = [o1, o2, o3, o4, o5];

const run = (
	state: AgencyState,
	p: ReturnType<typeof proposal>,
	opts: {
		condition?: "B1" | "B2" | "F";
		limits?: Limits;
		presented?: typeof all;
	} = {},
) =>
	settleUpdate({
		condition: opts.condition ?? "B2",
		state,
		proposal: p,
		presented: opts.presented ?? all,
		tools,
		limits: opts.limits ?? defaultLimits,
		now: 1000,
	});
const codesOf = (r: ReturnType<typeof run>) =>
	r.kind === "rejected" ? r.codes : [];

// i1 intent (adopted, created after o1), c2 candidate.
const base = () =>
	applyOrThrow(
		emptyState(),
		proposal([intentAddOp("g"), candidateAddOp("k", "g")]),
		[o1],
	);

describe("settle: applying", () => {
	test("applies intent and candidate, forward refs resolve, revisions start at 1", () => {
		const s = applyOrThrow(
			emptyState(),
			proposal([candidateAddOp("k", "g"), intentAddOp("g")]),
			[o1],
		);
		expect(s.revision).toBe(1);
		expect(s.intents.map((i) => [i.id, i.revision, i.createdSeq])).toEqual([
			["i2", 1, 1],
		]);
		expect(s.candidates[0]?.intentId).toBe("i2");
		expect(s.candidates[0]?.state).toBe("pending");
	});

	test("touched items advance their revision, state revision advances once", () => {
		const s0 = base();
		const s = applyOrThrow(
			s0,
			proposal([intentUpdateOp("i1", 1, { desiredState: "別の状態" })]),
			all,
		);
		expect(s.revision).toBe(s0.revision + 1);
		expect(s.intents[0]?.revision).toBe(2);
		expect(s.candidates[0]?.revision).toBe(1);
		expect(s0.intents[0]?.revision).toBe(1);
	});

	test("no_change keeps the revision and filters focus to existing ids", () => {
		const s0 = base();
		const r = run(s0, proposal([], { focusRefs: ["i1", "zzz"] }));
		expect(r.kind).toBe("no_change");
		if (r.kind !== "no_change") return;
		expect(r.state.revision).toBe(s0.revision);
		expect(r.state.focus).toEqual(["i1"]);
	});

	test("focus is stored on apply", () => {
		const r = run(
			emptyState(),
			proposal([intentAddOp("g")], { focusRefs: ["i1"] }),
		);
		expect(r.kind === "applied" && r.state.focus).toEqual(["i1"]);
	});
});

describe("settle: reject codes", () => {
	test("unknown_ref for evidence not presented", () => {
		const r = run(
			emptyState(),
			proposal([intentAddOp("g", { evidenceRefs: ["zz"] })]),
		);
		expect(codesOf(r)).toEqual(["unknown_ref"]);
		const r2 = run(emptyState(), proposal([intentAddOp("g")]), {
			presented: [o3],
		});
		expect(codesOf(r2)).toEqual(["unknown_ref"]);
	});

	test("unknown_ref for a missing existing id", () => {
		expect(codesOf(run(base(), proposal([intentUpdateOp("i9", 1)])))).toEqual([
			"unknown_ref",
		]);
	});

	test("stale_revision on revision mismatch and on closed items", () => {
		const s = base();
		expect(codesOf(run(s, proposal([intentUpdateOp("i1", 7)])))).toEqual([
			"stale_revision",
		]);
		expect(codesOf(run(s, proposal([candidateCloseOp("c2", 5)])))).toEqual([
			"stale_revision",
		]);
		const closed = applyOrThrow(s, proposal([candidateCloseOp("c2", 1)]), all);
		expect(codesOf(run(closed, proposal([candidateCloseOp("c2", 2)])))).toEqual(
			["stale_revision"],
		);
	});

	test("unresolved_ref for intentRef, supersedes", () => {
		expect(
			codesOf(run(emptyState(), proposal([candidateAddOp("k", "nope")]))),
		).toEqual(["unresolved_ref"]);
		expect(
			codesOf(
				run(
					base(),
					proposal([candidateAddOp("k2", "i1", { supersedes: "nope" })]),
				),
			),
		).toEqual(["unresolved_ref"]);
	});

	test("unresolved_ref for desireRef and beliefRefs (F)", () => {
		const r = run(
			emptyState(),
			proposal([
				intentAddOp("g", { desireRef: "nope" }),
				{
					op: "desire.add",
					localId: "d",
					kind: "understand",
					object: "x",
					reason: "y",
					evidenceRefs: ["o1"],
					beliefRefs: ["nope"],
				},
			]),
			{ condition: "F" },
		);
		expect(codesOf(r)).toEqual(["unresolved_ref"]);
	});

	test("duplicate localIds are rejected", () => {
		const r = run(emptyState(), proposal([intentAddOp("g"), intentAddOp("g")]));
		expect(codesOf(r)).toContain("duplicate_local_id");
	});

	test("a dependency cycle is rejected", () => {
		const r = run(
			base(),
			proposal([
				candidateAddOp("a", "i1", { supersedes: "b" }),
				candidateAddOp("b", "i1", { supersedes: "a" }),
			]),
		);
		expect(codesOf(r)).toContain("dependency_cycle");
	});

	test("illegal transitions", () => {
		const s = base();
		expect(
			codesOf(
				run(
					applyOrThrow(
						emptyState(),
						proposal([intentAddOp("g", { initialState: "proposed" })]),
						[o1],
					),
					proposal([
						intentUpdateOp("i1", 1, {
							transition: "completed",
							evidenceRefs: ["o3"],
						}),
					]),
				),
			),
		).toEqual(["illegal_transition"]);
		const held = applyOrThrow(
			s,
			proposal([intentUpdateOp("i1", 1, { transition: "abandoned" })]),
			all,
		);
		// terminal intents cannot change again
		expect(
			codesOf(
				run(
					held,
					proposal([intentUpdateOp("i1", 2, { transition: "adopted" })]),
				),
			),
		).toEqual(["illegal_transition"]);
		// adopted -> adopted
		expect(
			codesOf(
				run(s, proposal([intentUpdateOp("i1", 1, { transition: "adopted" })])),
			),
		).toEqual(["illegal_transition"]);
	});

	test("held can resume to adopted", () => {
		const s = base();
		const held = applyOrThrow(
			s,
			proposal([intentUpdateOp("i1", 1, { transition: "held" })]),
			all,
		);
		const back = run(
			held,
			proposal([intentUpdateOp("i1", 2, { transition: "adopted" })]),
		);
		expect(back.kind).toBe("applied");
	});

	test("completion needs newer evidence from a non-agent actor", () => {
		const s = base();
		const complete = (refs: string[]) =>
			codesOf(
				run(
					s,
					proposal([
						intentUpdateOp("i1", 1, {
							transition: "completed",
							evidenceRefs: refs,
						}),
					]),
				),
			);
		expect(complete([])).toEqual(["completion_without_external_evidence"]);
		expect(complete(["o2"])).toEqual(["completion_without_external_evidence"]);
		expect(complete(["o4"])).toEqual(["completion_without_external_evidence"]);
		// o1 is external but not newer than the intent's createdSeq
		expect(complete(["o1"])).toEqual(["completion_without_external_evidence"]);
		const ok = run(
			s,
			proposal([
				intentUpdateOp("i1", 1, {
					transition: "completed",
					evidenceRefs: ["o3"],
				}),
			]),
		);
		expect(ok.kind).toBe("applied");
		const tool = run(
			s,
			proposal([
				intentUpdateOp("i1", 1, {
					transition: "completed",
					evidenceRefs: ["o5"],
				}),
			]),
		);
		expect(tool.kind).toBe("applied");
	});

	test("terminal intent closes its open candidates in the same settle", () => {
		const s = base();
		const r = run(
			s,
			proposal([
				intentUpdateOp("i1", 1, {
					transition: "completed",
					evidenceRefs: ["o3"],
				}),
			]),
		);
		if (r.kind !== "applied") throw new Error("expected applied");
		const c = r.state.candidates[0];
		expect(c?.state).toBe("closed");
		expect(c?.closedReason).toBe("goal_terminal");
		expect(c?.revision).toBe(2);
		expect(r.touched).toContain("c2");
	});

	test("review and expire hours are capped by limits", () => {
		const limits = {
			...defaultLimits,
			reviewAfterMaxHours: 4,
			expireAfterMaxHours: 6,
		};
		expect(
			codesOf(
				run(
					emptyState(),
					proposal([intentAddOp("g", { reviewAfterHours: 5 })]),
					{ limits },
				),
			),
		).toEqual(["limit_exceeded"]);
		expect(
			codesOf(
				run(
					base(),
					proposal([candidateAddOp("k2", "i1", { expireAfterHours: 7 })]),
					{ limits },
				),
			),
		).toEqual(["limit_exceeded"]);
		expect(
			codesOf(
				run(
					base(),
					proposal([intentUpdateOp("i1", 1, { reviewAfterHours: 9 })]),
					{ limits },
				),
			),
		).toEqual(["limit_exceeded"]);
	});

	test("bad_tool rules", () => {
		const bad = (o: Parameters<typeof candidateAddOp>[2]) =>
			codesOf(run(base(), proposal([candidateAddOp("k2", "i1", o)])));
		expect(bad({ kind: "tool" })).toEqual(["bad_tool"]);
		expect(bad({ kind: "tool", toolName: "unknown", toolInput: "x" })).toEqual([
			"bad_tool",
		]);
		expect(bad({ kind: "tool", toolName: "run_compare" })).toEqual([
			"bad_tool",
		]);
		expect(bad({ kind: "share", toolName: "run_compare" })).toEqual([
			"bad_tool",
		]);
		const ok = run(
			base(),
			proposal([
				candidateAddOp("k2", "i1", {
					kind: "tool",
					toolName: "run_compare",
					toolInput: "a b",
				}),
			]),
		);
		expect(ok.kind).toBe("applied");
	});

	test("candidate on a closed intent is rejected", () => {
		const done = applyOrThrow(
			base(),
			proposal([intentUpdateOp("i1", 1, { transition: "abandoned" })]),
			all,
		);
		expect(codesOf(run(done, proposal([candidateAddOp("k2", "i1")])))).toEqual([
			"intent_not_open",
		]);
	});

	test("supersedes closes the old candidate", () => {
		const r = run(
			base(),
			proposal([candidateAddOp("k2", "i1", { supersedes: "c2" })]),
		);
		if (r.kind !== "applied") throw new Error("expected applied");
		const old = r.state.candidates.find((c) => c.id === "c2");
		expect(old?.closedReason).toBe("superseded");
		expect(r.state.candidates.find((c) => c.id !== "c2")?.supersedes).toBe(
			"c2",
		);
	});

	test("fulfilled close needs evidence", () => {
		expect(
			codesOf(
				run(
					base(),
					proposal([candidateCloseOp("c2", 1, { reason: "fulfilled" })]),
				),
			),
		).toEqual(["missing_evidence"]);
		const ok = run(
			base(),
			proposal([
				candidateCloseOp("c2", 1, {
					reason: "fulfilled",
					evidenceRefs: ["o3"],
				}),
			]),
		);
		expect(ok.kind).toBe("applied");
	});

	test("capacity", () => {
		const limits = { ...defaultLimits, openIntents: 1, openCandidates: 1 };
		expect(
			codesOf(
				run(emptyState(), proposal([intentAddOp("a"), intentAddOp("b")]), {
					limits,
				}),
			),
		).toEqual(["capacity"]);
		expect(
			codesOf(run(base(), proposal([candidateAddOp("k2", "i1")]), { limits })),
		).toEqual(["capacity"]);
		const noteLimits = { ...defaultLimits, notes: 1 };
		const note = (id: string) => ({
			op: "note.add",
			localId: id,
			text: "メモ",
			evidenceRefs: [],
		});
		expect(
			codesOf(
				run(emptyState(), b1Proposal([note("a"), note("b")]), {
					condition: "B1",
					limits: noteLimits,
				}),
			),
		).toEqual(["capacity"]);
		const fLimits = { ...defaultLimits, beliefsAndDesires: 1 };
		const belief = (id: string) => ({
			op: "belief.add",
			localId: id,
			content: "推定",
			confidence: "low",
			evidenceRefs: ["o1"],
		});
		expect(
			codesOf(
				run(emptyState(), proposal([belief("a"), belief("b")]), {
					condition: "F",
					limits: fLimits,
				}),
			),
		).toEqual(["capacity"]);
	});

	test("closing frees capacity inside the same proposal", () => {
		const limits = { ...defaultLimits, openIntents: 1 };
		const s = base();
		const r = run(
			s,
			proposal([
				intentUpdateOp("i1", 1, { transition: "abandoned" }),
				intentAddOp("n"),
			]),
			{ limits },
		);
		expect(r.kind).toBe("applied");
	});

	test("op types per condition", () => {
		const note = {
			op: "note.add",
			localId: "n",
			text: "メモ",
			evidenceRefs: [],
		};
		expect(
			codesOf(
				run(emptyState(), b1Proposal([intentAddOp("g")]), { condition: "B1" }),
			),
		).toEqual(["op_not_allowed"]);
		expect(
			codesOf(run(emptyState(), proposal([note]), { condition: "B2" })),
		).toEqual(["op_not_allowed"]);
		expect(
			codesOf(
				run(
					emptyState(),
					proposal([
						{
							op: "belief.add",
							localId: "b",
							content: "x",
							confidence: "low",
							evidenceRefs: [],
						},
					]),
					{ condition: "B2" },
				),
			),
		).toEqual(["op_not_allowed"]);
		// B2 desireRef must be null
		expect(
			codesOf(
				run(emptyState(), proposal([intentAddOp("g", { desireRef: "d1" })]), {
					condition: "B2",
				}),
			),
		).toEqual(["op_not_allowed"]);
		expect(
			run(emptyState(), b1Proposal([note]), { condition: "B1" }).kind,
		).toBe("applied");
	});

	test("B1 note update and delete check revisions", () => {
		const add = applyOrThrow(
			emptyState(),
			b1Proposal([
				{ op: "note.add", localId: "n", text: "最初", evidenceRefs: ["o1"] },
			]),
			[o1],
			"B1",
		);
		expect(add.notes[0]?.id).toBe("n1");
		const upd = (rev: number) =>
			run(
				add,
				b1Proposal([
					{
						op: "note.update",
						id: "n1",
						expectedRevision: rev,
						text: "更新",
						evidenceRefs: [],
					},
				]),
				{ condition: "B1" },
			);
		expect(codesOf(upd(3))).toEqual(["stale_revision"]);
		const ok = upd(1);
		expect(ok.kind === "applied" && ok.state.notes[0]?.revision).toBe(2);
		const del = run(
			add,
			b1Proposal([{ op: "note.delete", id: "n1", expectedRevision: 1 }]),
			{ condition: "B1" },
		);
		expect(del.kind === "applied" && del.state.notes.length).toBe(0);
	});

	test("self_reinforcement: confidence rises only with new independent evidence", () => {
		const s0 = applyOrThrow(
			emptyState(),
			proposal([
				{
					op: "belief.add",
					localId: "b",
					content: "原因は X",
					confidence: "low",
					evidenceRefs: ["o1"],
				},
			]),
			[o1],
			"F",
		);
		const raise = (refs: string[]) =>
			run(
				s0,
				proposal([
					{
						op: "belief.update",
						id: "b1",
						expectedRevision: 1,
						status: "active",
						content: null,
						confidence: "medium",
						evidenceRefs: refs,
					},
				]),
				{ condition: "F" },
			);
		expect(codesOf(raise([]))).toEqual(["self_reinforcement"]);
		expect(codesOf(raise(["o2"]))).toEqual(["self_reinforcement"]);
		expect(codesOf(raise(["o1"]))).toEqual(["self_reinforcement"]);
		const ok = raise(["o3"]);
		expect(ok.kind === "applied" && ok.state.beliefs[0]?.confidence).toBe(
			"medium",
		);
		// lowering or keeping confidence needs no new evidence
		const keep = run(
			s0,
			proposal([
				{
					op: "belief.update",
					id: "b1",
					expectedRevision: 1,
					status: "disputed",
					content: null,
					confidence: null,
					evidenceRefs: [],
				},
			]),
			{ condition: "F" },
		);
		expect(keep.kind).toBe("applied");
	});
});

describe("settle: reconciliation", () => {
	const recon = (candidateId: string, observationRef: string) =>
		proposal([], { reconciliations: [{ candidateId, observationRef }] });

	test("closes the candidate as fulfilled and does not complete the intent", () => {
		const r = run(base(), recon("c2", "o4"));
		if (r.kind !== "applied") throw new Error("expected applied");
		expect(r.state.candidates[0]?.state).toBe("closed");
		expect(r.state.candidates[0]?.closedReason).toBe("fulfilled");
		expect(r.state.intents[0]?.state).toBe("adopted");
		expect(r.state.revision).toBe(base().revision + 1);
	});

	test("bad_reconciliation: wrong kind/actor, unpresented, closed or unknown candidate", () => {
		expect(codesOf(run(base(), recon("c2", "o3")))).toEqual([
			"bad_reconciliation",
		]);
		expect(codesOf(run(base(), recon("c2", "o2")))).toEqual([
			"bad_reconciliation",
		]);
		expect(codesOf(run(base(), recon("c2", "zz")))).toEqual([
			"bad_reconciliation",
		]);
		expect(codesOf(run(base(), recon("c9", "o4")))).toEqual([
			"bad_reconciliation",
		]);
		const closed = applyOrThrow(base(), recon("c2", "o4"), all);
		expect(codesOf(run(closed, recon("c2", "o4")))).toEqual([
			"bad_reconciliation",
		]);
	});
});

describe("settle: atomicity", () => {
	test("one bad op rejects the whole proposal and every code is reported", () => {
		const s = base();
		const before = structuredClone(s);
		const r = run(
			s,
			proposal([
				intentAddOp("ok-intent"),
				intentUpdateOp("i1", 9),
				candidateAddOp("k2", "nope"),
				candidateCloseOp("c2", 1, { reason: "fulfilled" }),
			]),
		);
		expect(r.kind).toBe("rejected");
		expect(codesOf(r).sort()).toEqual(
			["missing_evidence", "stale_revision", "unresolved_ref"].sort(),
		);
		expect(s).toEqual(before);
	});

	test("a failed op does not cascade into unresolved_ref for its dependants", () => {
		const r = run(
			emptyState(),
			proposal([
				intentAddOp("g", { evidenceRefs: ["zz"] }),
				candidateAddOp("k", "g"),
			]),
		);
		expect(codesOf(r)).toEqual(["unknown_ref"]);
	});
});

describe("settle: independent evidence", () => {
	// c2 is the agent's own candidate; a1 an own attempt.
	const own = (
		seq: number,
		over: Partial<ReturnType<typeof obs>>,
	): ReturnType<typeof obs> => ({
		...obs(seq, "user.report", "user"),
		...over,
	});
	const delivery = own(6, { kind: "delivery.observed", actor: "host" });
	const caused = own(7, { causationId: "c2" });
	const causedAttempt = own(8, {
		kind: "action.observed",
		actor: "host",
		causationId: "a9",
	});
	const toolResult = own(9, {
		kind: "action.observed",
		actor: "tool",
		causationId: "a9",
	});
	const withAttempt = () => {
		const s = base();
		s.attempts.push({
			id: "a9",
			candidateId: "c2",
			candidateRevision: 1,
			opportunityId: "op",
			action: "speak",
			status: "succeeded",
			startedAt: 0,
		});
		return s;
	};
	const pool = [...all, delivery, caused, causedAttempt, toolResult];

	test("a tool result caused by the agent's own attempt completes an intent; a host failure receipt does not", () => {
		const complete = (ref: string) =>
			run(
				withAttempt(),
				proposal([
					intentUpdateOp("i1", 1, {
						transition: "completed",
						evidenceRefs: [ref],
					}),
				]),
				{ presented: pool },
			);
		expect(complete("o9").kind).toBe("applied");
		expect(codesOf(complete("o8"))).toEqual([
			"completion_without_external_evidence",
		]);
	});

	test("own delivery receipts and observations caused by own work never complete an intent", () => {
		for (const ref of ["o6", "o7", "o8"]) {
			const r = run(
				withAttempt(),
				proposal([
					intentUpdateOp("i1", 1, {
						transition: "completed",
						evidenceRefs: [ref],
					}),
				]),
				{ presented: pool },
			);
			expect(codesOf(r)).toEqual(["completion_without_external_evidence"]);
		}
	});

	test("belief confidence cannot rise on delivery receipts or own-caused observations", () => {
		const s0 = applyOrThrow(
			withAttempt(),
			proposal([
				{
					op: "belief.add",
					localId: "b",
					content: "推定",
					confidence: "low",
					evidenceRefs: ["o1"],
				},
			]),
			[o1],
			"F",
		);
		const raise = (ref: string) =>
			codesOf(
				run(
					s0,
					proposal([
						{
							op: "belief.update",
							id: "b3",
							expectedRevision: 1,
							status: "active",
							content: null,
							confidence: "medium",
							evidenceRefs: [ref],
						},
					]),
					{ condition: "F", presented: pool },
				),
			);
		for (const ref of ["o6", "o7", "o8"])
			expect(raise(ref)).toEqual(["self_reinforcement"]);
		expect(raise("o3")).toEqual([]);
	});
});

describe("settle: evidence requirements", () => {
	test("intent.add and candidate.add need at least one evidence ref", () => {
		expect(
			codesOf(
				run(emptyState(), proposal([intentAddOp("g", { evidenceRefs: [] })])),
			),
		).toEqual(["missing_evidence"]);
		expect(
			codesOf(
				run(
					base(),
					proposal([candidateAddOp("k2", "i1", { evidenceRefs: [] })]),
				),
			),
		).toEqual(["missing_evidence"]);
	});

	test("a high-confidence belief needs independent evidence", () => {
		const add = (refs: string[]) =>
			codesOf(
				run(
					emptyState(),
					proposal([
						{
							op: "belief.add",
							localId: "b",
							content: "x",
							confidence: "high",
							evidenceRefs: refs,
						},
					]),
					{ condition: "F" },
				),
			);
		expect(add(["o2"])).toEqual(["missing_evidence"]);
		expect(add([])).toEqual(["missing_evidence"]);
		expect(add(["o1"])).toEqual([]);
	});

	test("a desire is satisfied only on independent evidence", () => {
		const s0 = applyOrThrow(
			emptyState(),
			proposal([
				{
					op: "desire.add",
					localId: "d",
					kind: "understand",
					object: "x",
					reason: "y",
					evidenceRefs: ["o1"],
					beliefRefs: [],
				},
			]),
			[o1],
			"F",
		);
		const sat = (refs: string[]) =>
			codesOf(
				run(
					s0,
					proposal([
						{
							op: "desire.update",
							id: "d1",
							expectedRevision: 1,
							status: "satisfied",
							reason: "r",
							evidenceRefs: refs,
						},
					]),
					{ condition: "F" },
				),
			);
		expect(sat(["o2"])).toEqual(["missing_evidence"]);
		expect(sat([])).toEqual(["missing_evidence"]);
		expect(sat(["o3"])).toEqual([]);
	});
});

describe("settle: in-flight candidates", () => {
	const flying = () => {
		const s = base();
		const c = s.candidates[0];
		if (c) c.state = "reserved";
		return s;
	};

	test("explicit close, supersede and reconcile are refused", () => {
		expect(
			codesOf(run(flying(), proposal([candidateCloseOp("c2", 1)]))),
		).toEqual(["candidate_in_flight"]);
		expect(
			codesOf(
				run(
					flying(),
					proposal([candidateAddOp("k2", "i1", { supersedes: "c2" })]),
				),
			),
		).toEqual(["candidate_in_flight"]);
		expect(
			codesOf(
				run(
					flying(),
					proposal([], {
						reconciliations: [{ candidateId: "c2", observationRef: "o4" }],
					}),
				),
			),
		).toEqual(["candidate_in_flight"]);
	});

	test("a terminal intent leaves the in-flight candidate open", () => {
		const r = run(
			flying(),
			proposal([
				intentUpdateOp("i1", 1, {
					transition: "completed",
					evidenceRefs: ["o3"],
				}),
			]),
		);
		if (r.kind !== "applied") throw new Error("expected applied");
		expect(r.state.candidates[0]?.state).toBe("reserved");
	});
});
