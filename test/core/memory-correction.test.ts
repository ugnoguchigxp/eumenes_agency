/**
 * Correction path for self-grounded beliefs (V4 policy: medium/low beliefs may rest on the
 * agent's own output; the user corrects them in conversation). Deterministic; no model calls.
 * Mechanism under test: belief.update with status retracted/disputed citing the user's
 * correction observation (settle-beliefs.ts applyBeliefUpdate; prompts.ts:79 rule text).
 */
import { describe, expect, test } from "bun:test";
import { buildProjection } from "../../src/application/projection.ts";
import { updatePrompt } from "../../src/application/prompts.ts";
import { respondSystem } from "../../src/application/respond-system.ts";
import type { AgencyState, Observation } from "../../src/contracts/model.ts";
import { settleUpdate } from "../../src/domains/agency/settle.ts";
import { defaultLimits, emptyState, obs, proposal, tools } from "./helpers.ts";

const settleF = (
	state: AgencyState,
	ops: unknown[],
	presented: readonly Observation[],
	batch?: readonly Observation[],
) =>
	settleUpdate({
		condition: "F",
		state,
		proposal: proposal(ops),
		presented,
		...(batch ? { batch } : {}),
		tools,
		limits: defaultLimits,
		now: 1000,
	});
const stateOf = (r: ReturnType<typeof settleF>) => {
	if (r.kind === "rejected") throw new Error(`rejected: ${r.codes.join(",")}`);
	return r.state;
};
const codesOf = (r: ReturnType<typeof settleF>) =>
	r.kind === "rejected" ? r.codes : [];
const add = (
	content: string,
	confidence: "low" | "medium",
	refs: string[],
) => ({
	op: "belief.add",
	localId: "x",
	content,
	confidence,
	evidenceRefs: refs,
});
const update = (
	id: string,
	rev: number,
	status: string,
	refs: string[],
	o: Record<string, unknown> = {},
) => ({
	op: "belief.update",
	id,
	expectedRevision: rev,
	status,
	content: null,
	confidence: null,
	evidenceRefs: refs,
	...o,
});

const CLAIM = "ユーザーは毎朝ジョギングしている";
const said = obs(
	1,
	"delivery.observed",
	"agent",
	"毎朝ジョギングしているんですよね？",
);
const fix = obs(
	2,
	"correction",
	"user",
	"いや、ジョギングはしてないよ。散歩だけ。",
);

const selfGrounded = () => {
	const s = stateOf(
		settleF(emptyState(), [add(CLAIM, "medium", ["o1"])], [said]),
	);
	return { s, id: s.beliefs[0]!.id };
};
const corrected = (status: "retracted" | "disputed" = "retracted") => {
	const { s, id } = selfGrounded();
	return {
		id,
		s: stateOf(settleF(s, [update(id, 1, status, ["o2"])], [said, fix], [fix])),
	};
};
const projected = (s: AgencyState, id: string) =>
	buildProjection("F", { ...s, focus: [id] }, 10);

describe("correction of a self-grounded belief", () => {
	test("V4 policy: a medium belief may rest on the agent's own output", () => {
		const { s } = selfGrounded();
		expect(s.beliefs[0]).toMatchObject({
			confidence: "medium",
			status: "active",
			evidence: ["o1"],
		});
	});

	test("(1) the user's correction retracts it", () => {
		const { s, id } = corrected();
		expect(s.beliefs.find((b) => b.id === id)?.status).toBe("retracted");
	});

	test("(1) the correction can instead mark it disputed and downgrade it", () => {
		const { s, id } = selfGrounded();
		const n = stateOf(
			settleF(
				s,
				[update(id, 1, "disputed", ["o2"], { confidence: "low" })],
				[said, fix],
				[fix],
			),
		);
		expect(n.beliefs[0]).toMatchObject({
			status: "disputed",
			confidence: "low",
		});
	});

	test("(1) a retracted belief is terminal: it cannot be reactivated", () => {
		const { s, id } = corrected();
		const r = settleF(s, [update(id, 2, "active", ["o1"])], [said, fix]);
		expect(codesOf(r)).toContain("stale_revision");
	});

	test("(2) a retracted belief is not projected into the reply's reference material", () => {
		const { s, id } = corrected();
		const p = projected(s, id);
		expect(p.items.map((i) => i.id)).not.toContain(id);
		expect(respondSystem({ projection: p })).not.toContain(
			"ジョギングしている",
		);
	});

	test("(2) a retracted belief is not listed in the update prompt's beliefs", () => {
		const { s, id } = corrected();
		const prompt = updatePrompt({
			condition: "F",
			now: 10 * 60_000,
			observations: [fix],
			freshIds: new Set(["o2"]),
			state: s,
			due: { reviewIntentIds: [], pressure: [] },
			delivered: [],
			tools,
			limits: defaultLimits,
			minutesSinceUserInput: 1,
		} as never);
		expect(prompt).not.toContain(`[${id} `);
	});

	test("(2) a disputed belief stays visible but is shown as data (not silently trusted)", () => {
		const { s, id } = corrected("disputed");
		const p = projected(s, id);
		expect(p.items.find((i) => i.id === id)?.evidence).toEqual(["o1", "o2"]);
	});

	// Regression: settle-beliefs.ts applyBeliefAdd rejects re-creation from retracted self-output.
	test("(3): the agent cannot re-assert the retracted belief from its own earlier output", () => {
		const { s } = corrected();
		const r = settleF(s, [add(CLAIM, "medium", ["o1"])], [said, fix]);
		expect(codesOf(r)).toContain("retracted_evidence_reuse");
	});

	test("(3) re-assertion at high confidence from its own output is rejected", () => {
		const { s } = corrected();
		const r = settleF(
			s,
			[{ ...add(CLAIM, "low", ["o1"]), confidence: "high" }],
			[said, fix],
		);
		expect(codesOf(r)).toContain("missing_evidence");
	});

	test("(3) a new user observation lets the agent create a genuinely new belief", () => {
		const { s } = corrected();
		const u = obs(3, "user.report", "user", "最近また走り始めたよ");
		const n = stateOf(
			settleF(
				s,
				[add("ユーザーは最近走り始めた", "medium", ["o1", "o3"])],
				[said, fix, u],
				[u],
			),
		);
		expect(n.beliefs.filter((b) => b.status === "active")).toHaveLength(1);
		// the user's correction itself (independent) can ground a new belief too
		const m = stateOf(
			settleF(
				s,
				[add("ユーザーは散歩している", "medium", ["o2"])],
				[said, fix],
			),
		);
		expect(m.beliefs.some((b) => b.status === "active")).toBe(true);
	});

	test("(3) self-output not tied to a retraction still grounds medium/low beliefs (V4)", () => {
		const { s } = corrected();
		const other = obs(
			4,
			"delivery.observed",
			"agent",
			"週末は山に行くんですね",
		);
		expect(
			settleF(s, [add("週末は山に行く", "low", ["o4"])], [said, fix, other])
				.kind,
		).not.toBe("rejected");
	});

	test("(4) the correction is recorded as evidence with its provenance", () => {
		const { s, id } = corrected();
		const b = s.beliefs.find((x) => x.id === id)!;
		expect(b.evidence).toEqual(["o1", "o2"]);
		expect(b.revision).toBe(2);
		expect(fix).toMatchObject({ id: "o2", kind: "correction", actor: "user" });
	});

	test("(4) a correction citing an unpresented observation is refused", () => {
		const { s, id } = selfGrounded();
		const r = settleF(s, [update(id, 1, "retracted", ["o99"])], [said, fix]);
		expect(codesOf(r)).toContain("unknown_ref");
	});
});
