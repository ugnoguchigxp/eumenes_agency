import { describe, expect, test } from "bun:test";
import type { Interest, InterestOp } from "../src/contracts/interest.ts";
import { iUpdateSchema } from "../src/contracts/interest.ts";
import {
	settleInterests,
	type ObsInfo,
} from "../src/domains/agency/settle-interests.ts";

const obs = new Map<string, ObsInfo>([
	["u1", { actor: "user" }],
	["u2", { actor: "user" }],
	["a1", { actor: "agent" }],
	["t1", { actor: "tool", causationId: "c1" }],
	["t2", { actor: "tool", causationId: "c1" }],
	["t3", { actor: "tool", causationId: "c2" }],
]);
const mk = (p: Partial<Interest> & { id: string }): Interest => ({
	revision: 1,
	topic: "t",
	origin: "own",
	status: "emerging",
	reason: "r",
	evidence: ["u1"],
	derivedFrom: null,
	lastEngagedAt: null,
	createdSeq: 1,
	...p,
});
let n = 0;
const run = (interests: Interest[], ops: InterestOp[], limit = 24) =>
	settleInterests({
		interests,
		ops,
		obs,
		limit,
		seq: 10,
		newId: () => `n${++n}`,
	});
const upd = (
	id: string,
	p: Partial<Extract<InterestOp, { op: "interest.update" }>>,
): InterestOp => ({
	op: "interest.update",
	id,
	expectedRevision: 1,
	status: null,
	topic: null,
	reason: "x",
	evidenceRefs: [],
	...p,
});
const add = (
	p: Partial<Extract<InterestOp, { op: "interest.add" }>>,
): InterestOp => ({
	op: "interest.add",
	localId: "new1",
	topic: "音声",
	origin: "own",
	reason: "x",
	evidenceRefs: ["u1"],
	derivedFrom: null,
	...p,
});

describe("H3 settle-interests", () => {
	test("user_relation needs a non-agent observation; own may start from agent talk", () => {
		const r = run([], [add({ origin: "user_relation", evidenceRefs: ["a1"] })]);
		expect(r.rejects.map((x) => x.code)).toEqual(["relation_needs_user"]);
		const ok = run([], [add({ origin: "own", evidenceRefs: ["a1"] })]);
		expect(ok.interests[0]?.status).toBe("emerging");
	});
	test("promotion needs independent evidence", () => {
		expect(
			run(
				[mk({ id: "i1" })],
				[upd("i1", { status: "active", evidenceRefs: ["a1"] })],
			).rejects[0]?.code,
		).toBe("promotion_needs_independent");
		expect(
			run(
				[mk({ id: "i1" })],
				[upd("i1", { status: "active", evidenceRefs: ["u1"] })],
			).rejects[0]?.code,
		).toBe("promotion_needs_independent");
		const ok = run(
			[mk({ id: "i1" })],
			[upd("i1", { status: "active", evidenceRefs: ["u2"] })],
		);
		expect(ok.rejects).toEqual([]);
		expect(ok.interests[0]?.status).toBe("active");
		expect(ok.interests[0]?.revision).toBe(2);
	});
	test("tool results from one call count once", () => {
		const r = run(
			[mk({ id: "i1", evidence: ["t1"] })],
			[upd("i1", { status: "active", evidenceRefs: ["t2"] })],
		);
		expect(r.rejects).toEqual([]); // t2 is new, though same call as t1 — counted only once within this op
		const r2 = run(
			[mk({ id: "i1", evidence: ["t1", "t2"] })],
			[upd("i1", { status: "active", evidenceRefs: ["t1", "t2"] })],
		);
		expect(r2.rejects[0]?.code).toBe("promotion_needs_independent");
	});
	test("host_seed: model cannot create, rewrite topic or fade; may make dormant", () => {
		expect(
			run([], [add({ origin: "host_seed" as never })]).rejects[0]?.code,
		).toBe("host_seed_forbidden");
		const seed = mk({ id: "s1", origin: "host_seed", status: "active" });
		expect(
			run([seed], [upd("s1", { topic: "別", evidenceRefs: ["u2"] })]).rejects[0]
				?.code,
		).toBe("host_seed_immutable");
		expect(run([seed], [upd("s1", { status: "faded" })]).rejects[0]?.code).toBe(
			"host_seed_immutable",
		);
		expect(run([seed], [upd("s1", { status: "dormant" })]).rejects).toEqual([]);
	});
	test("derivedFrom needs existing parent and independent evidence", () => {
		expect(run([], [add({ derivedFrom: "zz" })]).rejects[0]?.code).toBe(
			"unknown_parent",
		);
		expect(
			run(
				[mk({ id: "i1" })],
				[add({ derivedFrom: "i1", evidenceRefs: ["u1"] })],
			).rejects[0]?.code,
		).toBe("derived_needs_independent");
		const r = run(
			[mk({ id: "i1", status: "faded" })],
			[add({ derivedFrom: "i1", evidenceRefs: ["u2"] })],
		);
		expect(r.rejects).toEqual([]);
		expect(r.interests[1]?.derivedFrom).toBe("i1");
	});
	test("faded is not revived in place", () => {
		expect(
			run(
				[mk({ id: "i1", status: "faded" })],
				[upd("i1", { status: "emerging" })],
			).rejects[0]?.code,
		).toBe("bad_transition");
	});
	test("capacity limit", () => {
		expect(run([mk({ id: "i1" })], [add({})], 1).rejects[0]?.code).toBe(
			"capacity",
		);
		expect(
			run([mk({ id: "i1", status: "faded" })], [add({})], 1).rejects,
		).toEqual([]);
	});
	test("unknown refs and stale revision rejected; no_change keeps revision", () => {
		expect(run([], [add({ evidenceRefs: ["nope"] })]).rejects[0]?.code).toBe(
			"unknown_ref",
		);
		expect(
			run([mk({ id: "i1", revision: 2 })], [upd("i1", {})]).rejects[0]?.code,
		).toBe("stale_revision");
		const r = run([mk({ id: "i1" })], [upd("i1", { evidenceRefs: ["u1"] })]);
		expect(r.interests[0]?.revision).toBe(1);
	});
	test("iUpdateSchema accepts interest ops and F ops", () => {
		const p = iUpdateSchema.safeParse({
			summary: "s",
			focusRefs: [],
			missingInfo: null,
			reconciliations: [],
			ops: [add({})],
		});
		expect(p.success).toBe(true);
	});
});
