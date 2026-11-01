/** Adapted from work/autonomous-interest S4, exercised against the current B1/F contracts. */
import { describe, expect, test } from "bun:test";
import {
	createAgencyRuntime,
	defaultBudget,
	defaultLimits,
	ObservationConflictError,
	type AgencySnapshot,
	type Condition,
} from "../../src/index.ts";
import {
	b1Proposal,
	candidateAddOp,
	fakeLlm,
	intentAddOp,
	obsInput,
	opportunity,
	participation,
	proposal,
	intentUpdateOp,
} from "./helpers.ts";

const signal = () => new AbortController().signal;
const make = (condition: Condition, restore?: AgencySnapshot) => {
	const llm = fakeLlm();
	const rt = createAgencyRuntime({
		condition,
		systemContext: "experimental",
		llm,
		tools: [],
		...(restore === undefined ? {} : { restore }),
		budget: { ...defaultBudget, minIntervalMs: 0 },
		limits: { ...defaultLimits, outboundIntervalMs: 0 },
	});
	return { rt, llm };
};
const build = async () => {
	const m = make("B1");
	m.rt.observe(obsInput("o1", "user.report", "user", 1, "比較が未解決"));
	m.llm.push(
		"update",
		b1Proposal([
			{
				op: "note.add",
				localId: "n",
				text: "比較が未解決",
				evidenceRefs: ["o1"],
			},
		]),
	);
	await m.rt.runBackground(10, signal());
	return m;
};

describe("full snapshot restore", () => {
	test("restored and original runtimes continue with identical state and model input", async () => {
		const a = await build();
		const snapshot = a.rt.snapshot();
		const b = make("B1", snapshot);
		expect(b.rt.snapshot()).toEqual(snapshot);
		const update = b1Proposal([
			{
				op: "note.update",
				id: "n1",
				expectedRevision: 1,
				text: "比較は引き続き未解決",
				evidenceRefs: ["o2"],
			},
		]);
		for (const m of [a, b]) {
			m.rt.observe(obsInput("o2", "user.report", "user", 11, "まだ調べている"));
			m.llm.push("update", update);
			await m.rt.runBackground(20, signal());
		}
		expect(b.rt.snapshot()).toEqual(a.rt.snapshot());
		expect(b.llm.requests.at(-1)?.prompt).toBe(a.llm.requests.at(-1)?.prompt);
		expect(b.llm.requests.at(-1)?.system).toBe(a.llm.requests.at(-1)?.system);
	});

	test("processed observations stay processed, while pending observations survive restart", async () => {
		const a = await build();
		const b = make("B1", a.rt.snapshot());
		await b.rt.runBackground(11, signal());
		expect(b.llm.count()).toBe(0);
		a.rt.observe(obsInput("o2", "user.report", "user", 11, "新しい入力"));
		const c = make("B1", a.rt.snapshot());
		c.llm.push("update", b1Proposal());
		await c.rt.runBackground(20, signal());
		expect(c.llm.count("update")).toBe(1);
		expect(c.llm.requests[0]?.prompt).toContain("新しい入力");
		expect(c.rt.snapshot().cursor).toBe(2);
	});

	test("observation identity and conflict detection survive restore", async () => {
		const a = await build();
		const b = make("B1", a.rt.snapshot());
		expect(
			b.rt.observe(obsInput("o1", "user.report", "user", 1, "比較が未解決"))
				.seq,
		).toBe(1);
		expect(() =>
			b.rt.observe(obsInput("o1", "user.report", "user", 1, "別の内容")),
		).toThrow(ObservationConflictError);
		expect(b.rt.snapshot().observations).toHaveLength(1);
	});

	test("snapshot input and output cannot mutate live observation metadata", () => {
		const a = make("F");
		a.rt.observe({
			id: "memory",
			kind: "recall.offered",
			actor: "host",
			occurredAt: 1,
			text: "memory",
			refs: ["interest:k1"],
		});
		const snapshot = a.rt.snapshot();
		const b = make("F", snapshot);
		(snapshot.observations[0]!.refs as string[]).push("interest:injected");
		expect(a.rt.snapshot().observations[0]?.refs).toEqual(["interest:k1"]);
		expect(b.rt.snapshot().observations[0]?.refs).toEqual(["interest:k1"]);
	});

	for (const changed of [
		{ workRef: "different-job" },
		{ workStatus: "failed" as const },
		{ tts: true },
	]) {
		test(`restored observation identity includes execution and delivery metadata: ${JSON.stringify(changed)}`, () => {
			const a = make("F");
			const input = {
				id: "returned",
				kind: "work.returned" as const,
				actor: "tool" as const,
				occurredAt: 1,
				text: "result",
				workRef: "job",
				workStatus: "partial" as const,
				tts: false,
			};
			a.rt.observe(input);
			const b = make("F", a.rt.snapshot());
			expect(() => b.rt.observe({ ...input, ...changed })).toThrow(
				ObservationConflictError,
			);
		});
	}

	test("consumed wake events and daily limits survive a full checkpoint", async () => {
		const a = make("F");
		for (let n = 1; n <= 3; n++) {
			a.rt.observe(obsInput(`event${n}`, "external.event", "host", n, "event"));
			a.llm.push("update", proposal());
			await a.rt.wake!(
				n * 10,
				{ presence: "quiet", foregroundBusy: false },
				signal(),
			);
		}
		const b = make("F", a.rt.snapshot());
		expect(
			(
				await b.rt.wake!(
					40,
					{ presence: "quiet", foregroundBusy: false },
					signal(),
				)
			).calls,
		).toEqual([]);
		b.rt.observe(obsInput("event4", "external.event", "host", 41, "event"));
		const r = await b.rt.wake!(
			50,
			{ presence: "quiet", foregroundBusy: false },
			signal(),
		);
		expect(r.blocked).toContainEqual({
			reason: "external_event",
			code: "daily_limit",
		});
		expect(b.llm.count()).toBe(0);
	});

	test("review flags prevent repeated inference after restart, and new deadlines still work", async () => {
		const a = make("B2");
		a.rt.observe(obsInput("o1", "user.report", "user", 1, "未解決"));
		a.llm.push(
			"update",
			proposal([intentAddOp("g"), candidateAddOp("c", "g")]),
		);
		await a.rt.runBackground(10, signal());
		const due = a.rt.snapshot().state.intents[0]!.reviewAt;
		a.llm.push("update", proposal());
		await a.rt.runBackground(due, signal());
		const b = make("B2", a.rt.snapshot());
		await b.rt.runBackground(due + 1, signal());
		expect(b.llm.count()).toBe(0);
		const i = b.rt.snapshot().state.intents[0]!;
		b.rt.observe(
			obsInput("o2", "user.report", "user", due + 2, "次の見直しまで保留"),
		);
		b.llm.push(
			"update",
			proposal([
				intentUpdateOp(i.id, i.revision, {
					reviewAfterHours: 1,
					evidenceRefs: ["o2"],
				}),
			]),
		);
		await b.rt.runBackground(due + 3, signal());
		const next = b.rt.snapshot().state.intents[0]!.reviewAt;
		b.llm.push("update", proposal());
		await b.rt.runBackground(next, signal());
		expect(b.llm.count("update")).toBe(2);
		await b.rt.runBackground(next + 1, signal());
		expect(b.llm.count("update")).toBe(2);
	});

	test("F retains the causation of old tool evidence across restart", async () => {
		const a = make("F");
		a.rt.observe(
			obsInput("t1", "action.observed", "tool", 1, "result one", "same-job"),
		);
		a.llm.push("update", proposal());
		await a.rt.runBackground(10, signal());
		const snapshot = a.rt.snapshot();
		snapshot.state.interests = [
			{
				id: "k1",
				revision: 1,
				topic: "sensor",
				origin: "own",
				status: "emerging",
				reason: "r",
				evidence: ["t1"],
				derivedFrom: null,
				lastEngagedAt: null,
				createdSeq: 1,
			},
		];
		const llm = fakeLlm();
		const rt = createAgencyRuntime({
			condition: "F",
			systemContext: "experimental",
			interestFormation: true,
			tools: [],
			llm,
			restore: snapshot,
			budget: { ...defaultBudget, minIntervalMs: 0 },
		});
		rt.observe(
			obsInput("t2", "action.observed", "tool", 11, "result two", "same-job"),
		);
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
					evidenceRefs: ["t2"],
				},
			],
		});
		const r = await rt.runBackground(20, signal());
		expect(r.flatMap((c) => c.rejectCodes)).toContain(
			"interest:promotion_needs_independent",
		);
		expect(rt.snapshot().state.interests?.[0]?.status).toBe("emerging");
	});

	test("mismatched condition, partial ledger, malformed sequence, duplicate ids and invalid cursor are rejected", async () => {
		const a = await build();
		const snapshot = a.rt.snapshot();
		const bad: unknown[] = [
			{ ...snapshot, condition: "F" },
			{ ...snapshot, observations: undefined },
			{ ...snapshot, cursor: undefined },
			{ ...snapshot, cursor: -1 },
			{ ...snapshot, cursor: 100 },
			{ ...snapshot, cursor: Number.NaN },
			{
				...snapshot,
				observations: snapshot.observations.map((o) => ({ ...o, seq: 2 })),
			},
			{
				...snapshot,
				observations: [
					...snapshot.observations,
					{ ...snapshot.observations[0], seq: 2 },
				],
			},
			{ ...snapshot, state: { ...snapshot.state, notes: "bad" } },
			{ ...snapshot, state: { ...snapshot.state, nextId: 0 } },
		];
		for (const value of bad)
			expect(() => make("B1", value as AgencySnapshot)).toThrow(
				/invalid snapshot/,
			);
		const { condition: _, scheduling: _s, ...legacy } = snapshot;
		expect(make("B1", legacy).rt.snapshot().observations).toEqual(
			snapshot.observations,
		);
	});

	for (const requiresApproval of [false, true])
		test(`B1 self research cites a raw note id; approval=${requiresApproval}`, async () => {
			const llm = fakeLlm();
			const rt = createAgencyRuntime({
				condition: "B1",
				systemContext: "experimental",
				hostTopics: true,
				llm,
				tools: [{ name: "lookup", description: "lookup", requiresApproval }],
				budget: { ...defaultBudget, minIntervalMs: 0 },
			});
			rt.observe(
				obsInput("o1", "user.report", "user", 1, "センサーの測定が不安定"),
			);
			llm.push(
				"update",
				b1Proposal([
					{
						op: "note.add",
						localId: "n",
						text: "測定が不安定な原因を知りたい",
						evidenceRefs: ["o1"],
					},
				]),
			);
			llm.push(
				"select",
				participation({
					action: "tool",
					toolName: "lookup",
					toolInput: "測定の原因",
					evidenceRefs: ["n1"],
				}),
			);
			const r = await rt.decide(
				opportunity("p", 10, { trigger: "idle" }),
				signal(),
			);
			if (requiresApproval) {
				expect(r.decision.ticket).toBeNull();
				expect(r.decision.rejectCodes).toContain("approval_required");
			} else {
				expect(r.decision.ticket?.toolName).toBe("lookup");
				expect(r.decision.evidenceRefs).toEqual(["o1"]);
				expect(
					llm.requests.find((r) => r.purpose === "select")?.system,
				).toContain("そのメモの id を前置きなしで入れる");
			}
		});
});
