import { describe, expect, test } from "bun:test";
import {
	createAgencyRuntime,
	defaultBudget,
	defaultLimits,
	emptyState,
	stateFromRevisions,
	type AgencyState,
	type ItemRevision,
	type RuntimeDeps,
	type UpdateModelData,
	type SelectModelData,
} from "../../src/index.ts";
import type { Interest } from "../../src/contracts/interest.ts";
import { settleInterests } from "../../src/domains/agency/settle-interests.ts";
import {
	applyOrThrow,
	candidateAddOp,
	fakeLlm,
	intentAddOp,
	obs,
	opportunity,
	participation,
	proposal,
} from "./helpers.ts";

const signal = () => new AbortController().signal;
const quiet = { presence: "quiet" as const, foregroundBusy: false };
const interest = (): Interest => ({
	id: "k1",
	revision: 1,
	topic: "自作センサーの測定",
	origin: "own",
	status: "emerging",
	reason: "実験の続きが気になる",
	evidence: ["o1"],
	derivedFrom: null,
	lastEngagedAt: null,
	createdSeq: 1,
});
const make = (over: Partial<RuntimeDeps> = {}) => {
	const llm = fakeLlm();
	const rt = createAgencyRuntime({
		systemContext: "experimental",
		condition: "F",
		interestFormation: true,
		llm,
		tools: [],
		budget: { ...defaultBudget, minIntervalMs: 0 },
		limits: { ...defaultLimits, outboundIntervalMs: 0 },
		...over,
	});
	return { rt, llm };
};
const noChange = () => ({ ...proposal(), interestOps: [] });

describe("interest growth review regressions", () => {
	test("a failed revision write is retried with the original rows and revisions", async () => {
		const rows: ItemRevision[] = [];
		let fail = false;
		let failed: readonly ItemRevision[] = [];
		const { rt, llm } = make({
			revisions: {
				scope: "review",
				append(batch) {
					if (fail) {
						fail = false;
						failed = structuredClone(batch);
						throw new Error("storage unavailable");
					}
					rows.push(...batch);
				},
			},
		});
		const o = obs(1, "user.report", "user");
		rt.observe(o);
		fail = true;
		llm.push("update", {
			...proposal([intentAddOp("g"), candidateAddOp("c", "g")]),
			interestOps: [],
		});
		await expect(rt.runBackground(10, signal())).rejects.toThrow(
			"storage unavailable",
		);
		expect(failed.length).toBeGreaterThan(0);
		rt.observe(o); // Idempotent retry must flush state that was not saved.
		for (const row of failed) expect(rows).toContainEqual(row);
		expect(stateFromRevisions(rows)?.state).toEqual(rt.snapshot().state);
		expect(
			new Set(rows.map((r) => `${r.itemKind}:${r.itemId}:${r.revision}`)).size,
		).toBe(rows.length);
	});

	test("failed history is saved before the next state, preserving both versions", async () => {
		const rows: ItemRevision[] = [];
		let fail = false;
		const { rt, llm } = make({
			revisions: {
				scope: "review",
				append(batch) {
					if (fail) {
						fail = false;
						throw new Error("storage unavailable");
					}
					rows.push(...batch);
				},
			},
		});
		rt.observe(obs(1, "user.report", "user"));
		llm.push("update", {
			...proposal([intentAddOp("g"), candidateAddOp("c", "g")]),
			interestOps: [],
		});
		fail = true;
		await expect(rt.runBackground(10, signal())).rejects.toThrow(
			"storage unavailable",
		);
		const candidate = rt.snapshot().state.candidates[0]!;
		llm.push(
			"select",
			participation({
				action: "speak",
				candidateRef: { id: candidate.id, revision: candidate.revision },
				utterance: "結果",
				evidenceRefs: ["o1"],
			}),
		);
		expect(
			(await rt.decide(opportunity("p", 11), signal())).decision.ticket,
		).not.toBeNull();
		const versions = rows
			.filter((r) => r.itemId === candidate.id)
			.map((r) => JSON.parse(r.stateJson).state);
		expect(versions).toEqual(["pending", "reserved"]);
		expect(stateFromRevisions(rows)?.state).toEqual(rt.snapshot().state);
	});

	for (const kind of [
		"work.returned",
		"fault.observed",
		"external.event",
	] as const) {
		test(`${kind}: events beyond one batch stay eligible for the next wake`, async () => {
			const { rt, llm } = make({
				budget: { ...defaultBudget, minIntervalMs: 0, batchSize: 1 },
			});
			for (let n = 1; n <= 2; n++)
				rt.observe({
					id: `e${n}`,
					kind,
					actor: "host",
					occurredAt: n,
					text: `result ${n}`,
					code: `failure-${n}`,
				});
			llm.push("update", noChange(), noChange());
			llm.push("select", participation(), participation());
			const first = await rt.wake!(10, quiet, signal());
			expect(first.calls.filter((c) => c.purpose === "update")).toHaveLength(1);
			expect(rt.snapshot().cursor).toBe(1);
			const second = await rt.wake!(11, quiet, signal());
			expect(second.reasons.length).toBeGreaterThan(0);
			expect(second.calls.filter((c) => c.purpose === "update")).toHaveLength(
				1,
			);
			expect(rt.snapshot().cursor).toBe(2);
			expect((await rt.wake!(12, quiet, signal())).calls).toEqual([]);
		});
	}

	test("blocked recall does not consume the autonomous daily quota", async () => {
		const { rt, llm } = make({
			wakeConfig: {
				activityCooldownHours: 12,
				dailyLimit: 1,
				faultQuietMs: 1000,
				dayOf: () => "day",
			},
		});
		rt.observe({
			id: "closed",
			kind: "recall.offered",
			actor: "host",
			occurredAt: 1,
			text: "unrelated memory",
			refs: ["interest:missing"],
		});
		rt.observe({
			id: "returned",
			kind: "work.returned",
			actor: "tool",
			occurredAt: 2,
			text: "done",
		});
		llm.push("update", noChange(), noChange());
		await rt.wake!(10, quiet, signal());
		rt.observe({
			id: "event",
			kind: "external.event",
			actor: "host",
			occurredAt: 11,
			text: "new event",
		});
		const r = await rt.wake!(11, quiet, signal());
		expect(r.reasons).toEqual(["external_event"]);
		expect(r.blocked).not.toContainEqual({
			reason: "external_event",
			code: "daily_limit",
		});
	});

	test("tool provenance remains available when old evidence leaves the model window", async () => {
		const { rt, llm } = make({
			restore: {
				state: {
					...emptyState(),
					interests: [{ ...interest(), evidence: ["old"] }],
				},
			},
		});
		rt.observe({
			id: "old",
			kind: "action.observed",
			actor: "tool",
			occurredAt: 1,
			text: "first result",
			causationId: "one-execution",
		});
		for (let n = 0; n < 40; n++)
			rt.observe({
				id: `history-${n}`,
				kind: "user.report",
				actor: "user",
				occurredAt: n + 2,
				text: "other experience",
			});
		llm.push("update", ...Array.from({ length: 6 }, noChange));
		await rt.runBackground(100, signal());
		rt.observe({
			id: "new",
			kind: "action.observed",
			actor: "tool",
			occurredAt: 101,
			text: "another result of the same execution",
			causationId: "one-execution",
		});
		llm.push("update", {
			...proposal(),
			interestOps: [
				{
					op: "interest.update",
					id: "k1",
					localId: null,
					expectedRevision: 1,
					status: "active",
					topic: null,
					origin: null,
					reason: "r",
					derivedFrom: null,
					evidenceRefs: ["new"],
				},
			],
		});
		const results = await rt.runBackground(200, signal());
		expect(results.flatMap((r) => r.rejectCodes)).toContain(
			"interest:promotion_needs_independent",
		);
		expect(rt.snapshot().state.interests?.[0]?.status).toBe("emerging");
	});

	test("the same tool execution cannot promote, rewrite or branch an interest", () => {
		const prior = { ...interest(), evidence: ["t1"] };
		const observations = new Map([
			["t1", { actor: "tool", causationId: "execution-1" }],
			["t2", { actor: "tool", causationId: "execution-1" }],
			["t3", { actor: "tool", causationId: "execution-2" }],
		]);
		const result = settleInterests({
			interests: [prior],
			obs: observations,
			limit: 24,
			seq: 3,
			newId: () => "k2",
			ops: [
				{
					op: "interest.update",
					id: "k1",
					expectedRevision: 1,
					status: "active",
					topic: null,
					reason: "r",
					evidenceRefs: ["t2"],
				},
				{
					op: "interest.update",
					id: "k1",
					expectedRevision: 1,
					status: null,
					topic: "別の対象",
					reason: "r",
					evidenceRefs: ["t2"],
				},
				{
					op: "interest.add",
					localId: "new",
					origin: "own",
					topic: "派生",
					reason: "r",
					derivedFrom: "k1",
					evidenceRefs: ["t2"],
				},
			],
		});
		expect(result.rejects.map((r) => r.code)).toEqual([
			"promotion_needs_independent",
			"topic_needs_independent",
			"derived_needs_independent",
		]);
		expect(result.interests).toEqual([prior]);
		const independent = settleInterests({
			interests: [prior],
			obs: observations,
			limit: 24,
			seq: 3,
			newId: () => "k2",
			ops: [
				{
					op: "interest.update",
					id: "k1",
					expectedRevision: 1,
					status: "active",
					topic: null,
					reason: "new execution",
					evidenceRefs: ["t3"],
				},
			],
		});
		expect(independent.rejects).toEqual([]);
		expect(independent.interests[0]?.status).toBe("active");
	});

	for (const hostOwned of [false, true]) {
		test(`${hostOwned ? "host" : "experimental"} context: formed interests can be cited and begin their cooldown`, async () => {
			const o = obs(1, "user.report", "user");
			const state: AgencyState = applyOrThrow(
				{ ...emptyState(), interests: [interest()] },
				proposal([intentAddOp("g"), candidateAddOp("c", "g")]),
				[o],
				"F",
				0,
			);
			let updated: UpdateModelData | undefined;
			let selected: SelectModelData | undefined;
			const hostContext = {
				update: ({ data }: { data: UpdateModelData }) => {
					updated = structuredClone(data);
					return "HOST UPDATE";
				},
				select: ({ data }: { data: SelectModelData }) => {
					selected = structuredClone(data);
					return "HOST SELECT";
				},
			};
			const { rt, llm } = make({
				restore: { state },
				...(hostOwned ? { systemContext: hostContext } : {}),
			});
			rt.observe(o);
			llm.push("update", noChange());
			const c = state.candidates[0]!;
			llm.push(
				"select",
				participation({
					action: "speak",
					candidateRef: { id: c.id, revision: c.revision },
					utterance: "測定の続きを話そう",
					evidenceRefs: ["interest:k1"],
				}),
			);
			const result = await rt.decide(opportunity("p", 10), signal());
			expect(result.decision.rejectCodes).toEqual([]);
			expect(result.decision.ticket?.action).toBe("speak");
			expect(rt.snapshot().state.interests?.[0]?.lastEngagedAt).toBe(10);
			if (hostOwned) {
				expect(updated?.state.interests).toEqual([interest()]);
				expect(selected?.state.interests).toEqual([interest()]);
				expect(llm.requests.map((r) => r.system)).toEqual([
					"HOST UPDATE",
					"HOST SELECT",
				]);
				updated!.state.interests![0]!.topic = "mutated context";
				expect(rt.snapshot().state.interests?.[0]?.topic).toBe(
					interest().topic,
				);
			} else
				expect(
					llm.requests.find((r) => r.purpose === "select")?.prompt,
				).toContain(interest().topic);
			rt.observe({
				id: "next",
				kind: "external.event",
				actor: "host",
				occurredAt: 11,
				text: "関連資料",
				interestId: "k1",
			});
			const before = llm.count();
			const blocked = await rt.wake!(11, quiet, signal());
			expect(blocked.blocked).toContainEqual({
				reason: "external_event",
				code: "cooldown",
			});
			expect(llm.count()).toBe(before);
		});
	}

	for (const ref of ["interest:missing", "interest:k1"]) {
		test(`an absent or faded interest does not become an allowed citation: ${ref}`, async () => {
			const o = obs(1, "user.report", "user");
			const state = applyOrThrow(
				{ ...emptyState(), interests: [{ ...interest(), status: "faded" }] },
				proposal([intentAddOp("g"), candidateAddOp("c", "g")]),
				[o],
				"F",
				0,
			);
			const { rt, llm } = make({ restore: { state } });
			rt.observe(o);
			llm.push("update", noChange());
			const c = state.candidates[0]!;
			llm.push(
				"select",
				participation({
					action: "speak",
					candidateRef: { id: c.id, revision: c.revision },
					utterance: "話そう",
					evidenceRefs: [ref],
				}),
			);
			const r = await rt.decide(opportunity("p", 10), signal());
			expect(r.decision.ticket).toBeNull();
			expect(r.decision.rejectCodes).toContain("unknown_ref");
		});
	}
});
