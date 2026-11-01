import { expect, test } from "bun:test";
import {
	compactSchema,
	expandCompact,
	sampleFactory,
	type CompactUpdate,
} from "../f-fusion/samples.ts";
import { scenes } from "../f-fusion/cases.ts";
import { runCell, differences } from "../f-fusion/run.ts";
import {
	judgeData,
	judgePolicy,
	score,
	type Checkpoint,
	type Judgment,
} from "../f-fusion/protocol.ts";
import { fromWire } from "../../src/contracts/proposals.ts";
import { fakeLlm, participation } from "../../test/core/helpers.ts";
import {
	experimentBudget,
	experimentLimits,
	experimentTools,
} from "../live-b1-f/run.ts";

const update = (): CompactUpdate => ({
	summary: "独立した観測から問いと一手を保持",
	missingInfo: null,
	focusRefs: [],
	interestOps: [],
	closeSteps: [],
	reconciliations: [],
	questions: [
		{
			change: "add",
			id: null,
			localId: "q",
			revision: null,
			state: "adopted",
			question: "音の比較条件を調べる",
			reason: "利用者が比較を依頼した",
			doneWhen: "条件の説明が共有された",
			resumeWhen: "利用者が相談できる",
			stopWhen: "利用者が不要と伝える",
			reviewHours: 24,
			evidenceRefs: ["observation-1"],
			nextStep: {
				localId: "step",
				kind: "tool",
				content: "比較条件を資料で調べる",
				toolName: "lookup",
				toolInput: "音の比較に必要な条件",
				applyWhen: "手が空いている",
				expireHours: 24,
				evidenceRefs: ["observation-1"],
				supersedes: null,
			},
		},
	],
});
const select = (id = "c2", revision = 1) =>
	participation({
		action: "tool",
		candidateRef: { id, revision },
		toolName: "lookup",
		toolInput: null,
		evidenceRefs: ["observation-1"],
	});
const runtime = (
	llm: ReturnType<typeof fakeLlm>,
	extra: Record<string, unknown> = {},
) =>
	sampleFactory("Fusion")({
		condition: "F",
		systemContext: "experimental",
		llm,
		tools: experimentTools,
		budget: experimentBudget,
		limits: experimentLimits,
		...extra,
	});
const observe = (
	rt: ReturnType<typeof runtime>,
	id: string,
	at: number,
	text: string,
) =>
	rt.observe({
		id,
		actor: "user",
		kind: "exchange.adopted",
		occurredAt: at,
		text,
	});
const opp = (id: string, at: number) => ({
	id,
	at,
	trigger: "idle" as const,
	presence: "quiet" as const,
	foregroundBusy: false,
	playerBusy: false,
});

test("fusion encodes model-selected meaning into native F operations and keeps a single store", async () => {
	const value = update();
	const wire = expandCompact(value);
	const parsed = fromWire(wire, "F");
	expect(parsed.ok).toBe(true);
	expect(wire.ops.map((o) => o.op)).toEqual(["intent.add", "candidate.add"]);
	expect(wire.ops[0]!.resumeCondition).toBe(value.questions[0]!.resumeWhen);
	const llm = fakeLlm();
	llm.push("update", value);
	const rt = runtime(llm);
	observe(rt, "observation-1", 0, "比較条件が未解決なので調べてほしい");
	await rt.runBackground(0, new AbortController().signal);
	expect(rt.snapshot().state.intents).toHaveLength(1);
	expect(rt.snapshot().state.candidates).toHaveLength(1);
	expect(rt.snapshot().state.notes).toHaveLength(0);
});

test("malformed and omitted meaning is rejected rather than invented by the adapter", () => {
	const v = update();
	v.questions[0]!.resumeWhen = "";
	expect(compactSchema.safeParse(v).success).toBe(false);
	const missing = update();
	missing.questions[0]!.localId = null;
	expect(fromWire(expandCompact(missing), "F").ok).toBe(false);
	const revised = update();
	Object.assign(revised.questions[0]!, {
		change: "update",
		id: "i1",
		revision: 1,
		localId: null,
	});
	expect(() => expandCompact(revised)).toThrow("immutable");
});

test("fusion still rejects approval-required tool proposals before reservation", async () => {
	const llm = fakeLlm(),
		v = update();
	v.questions[0]!.nextStep!.toolName = "delete_files";
	llm.push("update", v);
	const rt = runtime(llm);
	observe(rt, "observation-1", 0, "調査をしてほしい");
	await rt.runBackground(0, new AbortController().signal);
	const c = rt.snapshot().state.candidates[0]!;
	llm.push(
		"select",
		participation({
			action: "tool",
			candidateRef: { id: c.id, revision: c.revision },
			toolName: "delete_files",
			evidenceRefs: ["observation-1"],
		}),
	);
	const r = await rt.decide(opp("approval", 0), new AbortController().signal);
	expect(r.decision.ticket).toBeNull();
	expect(r.decision.rejectCodes).toContain("approval_required");
	expect(rt.snapshot().state.attempts).toHaveLength(0);
});

test("held questions block previously proposed tools and a newer solution completes the same question", async () => {
	const llm = fakeLlm();
	llm.push("update", update());
	const rt = runtime(llm);
	observe(rt, "observation-1", 0, "条件を調べてほしい");
	await rt.runBackground(0, new AbortController().signal);
	const held = update();
	Object.assign(held.questions[0]!, {
		change: "update",
		id: "i1",
		localId: null,
		revision: 1,
		state: "held",
		stopWhen: null,
		evidenceRefs: ["observation-2"],
		nextStep: null,
	});
	llm.push("update", held);
	observe(rt, "observation-2", 1, "今は停止してほしい");
	await rt.runBackground(1, new AbortController().signal);
	expect(rt.snapshot().state.intents[0]!.state).toBe("held");
	const decision = await rt.decide(
		opp("stop", 1),
		new AbortController().signal,
	);
	expect(decision.decision.ticket).toBeNull();
	const done = structuredClone(held);
	Object.assign(done.questions[0]!, {
		revision: rt.snapshot().state.intents[0]!.revision,
		state: "completed",
		evidenceRefs: ["observation-3"],
	});
	llm.push("update", done);
	observe(rt, "observation-3", 2, "自分で条件を確認して解決した");
	await rt.runBackground(2, new AbortController().signal);
	expect(rt.snapshot().state.intents).toHaveLength(1);
	expect(rt.snapshot().state.intents[0]!.state).toBe("completed");
});

test("stale selection and already reserved work are rejected by the native gate", async () => {
	const llm = fakeLlm();
	llm.push("update", update());
	const rt = runtime(llm);
	observe(rt, "observation-1", 0, "調査してほしい");
	await rt.runBackground(0, new AbortController().signal);
	const c = rt.snapshot().state.candidates[0]!;
	llm.push("select", select(c.id, c.revision + 1));
	const stale = await rt.decide(opp("stale", 0), new AbortController().signal);
	expect(stale.decision.ticket).toBeNull();
	llm.push("select", select(c.id, c.revision));
	const accepted = await rt.decide(opp("go", 0), new AbortController().signal);
	expect(accepted.decision.ticket?.toolName).toBe("lookup");
	const again = await rt.decide(opp("again", 0), new AbortController().signal);
	expect(again.decision.ticket).toBeNull();
	expect(rt.snapshot().state.attempts).toHaveLength(1);
});

test("native per-intent tool budget is retained in the fused sample", async () => {
	const llm = fakeLlm();
	llm.push("update", update());
	const rt = runtime(llm, {
		activityLimits: { toolCalls: 1, tokens: 20000, elapsedMs: 100000 },
	});
	observe(rt, "observation-1", 0, "調査してほしい");
	await rt.runBackground(0, new AbortController().signal);
	const c = rt.snapshot().state.candidates[0]!;
	llm.push("select", select(c.id, c.revision));
	const first = await rt.decide(opp("first", 0), new AbortController().signal);
	expect(first.decision.ticket).not.toBeNull();
	rt.recordResult({
		ticketId: first.decision.ticket!.id,
		at: 0,
		status: "succeeded",
		resultText: "部分結果のみ",
	});
	const next = update();
	Object.assign(next.questions[0]!, {
		change: "update",
		id: "i1",
		localId: null,
		revision: rt.snapshot().state.intents[0]!.revision,
		state: null,
		stopWhen: null,
		evidenceRefs: ["observation-2"],
	});
	next.questions[0]!.nextStep!.localId = "step2";
	llm.push("update", next);
	observe(rt, "observation-2", 1, "別の条件も調べたい");
	await rt.runBackground(1, new AbortController().signal);
	const c2 = rt.snapshot().state.candidates.at(-1)!;
	expect(c2.id).not.toBe(c.id);
	llm.push("select", select(c2.id, c2.revision));
	const second = await rt.decide(
		opp("second", 1),
		new AbortController().signal,
	);
	expect(second.decision.ticket).toBeNull();
	expect(second.decision.source).toBe("host_budget");
});

test("both sample paths expose the actual selected query to the judge, without expected labels", async () => {
	const scene = {
		id: "query-test",
		frames: [
			{
				id: "now",
				hour: 0,
				observations: [{ actor: "user" as const, text: "条件を調べてほしい" }],
				interests: [],
				opportunity: true,
				desiredAction: "act" as const,
				rubric: "HIDDEN-LABEL",
			},
		],
	};
	const fake = fakeLlm();
	fake.push("update", update());
	fake.push("select", select());
	const cell = await runCell(
		scene,
		"Fusion",
		1,
		sampleFactory("Fusion"),
		fake,
		() => 0,
	);
	expect(cell.checkpoints[0]!.action?.toolInput).toBe("音の比較に必要な条件");
	expect(
		fake.requests.every((r) => !JSON.stringify(r).includes("HIDDEN-LABEL")),
	).toBe(true);
	const cp = cell.checkpoints[0]!;
	const before = JSON.stringify(judgeData(scene, [cp]));
	cell.snapshot = {
		...cell.snapshot,
		observations: [
			...cell.snapshot.observations,
			{
				id: "future",
				seq: 999,
				occurredAt: 999,
				actor: "user",
				kind: "user.report",
				text: "FUTURE-SECRET",
			},
		],
	};
	expect(JSON.stringify(judgeData(scene, [cp]))).toBe(before);
	expect(before).not.toContain("FUTURE-SECRET");
});

test("new scoring credits relevant grounded actions independently of quiet labels", () => {
	const scene = {
		id: "x",
		frames: [
			{
				id: "a",
				hour: 0,
				observations: [],
				interests: [],
				opportunity: true,
				desiredAction: "quiet" as const,
				rubric: "静かに",
			},
		],
	};
	const cp: Checkpoint = {
		id: "a",
		inventory: [],
		otherMemory: [],
		facts: [],
		action: {
			action: "tool",
			tool: "lookup",
			toolInput: "依頼された調査",
			text: null,
			evidence: [],
			source: "llm",
		},
	};
	const judgment: Judgment = {
		checkpoints: [
			{
				id: "a",
				matches: [],
				epistemicPass: true,
				actionRelevant: true,
				actionGrounded: true,
				policyPass: true,
				reason: "依頼を根拠に開始",
			},
		],
	};
	const m = score(scene, [cp], judgment);
	expect(m.relevantActions).toBe(1);
	expect(m.usefulActions).toBe(0);
	expect(m.quietCorrect).toBe(0);
	expect(judgePolicy).toContain("まだ取得結果が無いこと自体は減点しない");
	const result = {
		cell: {
			key: "x",
			scene: "repeated-hobby",
			rep: 1,
			variant: "Fusion" as const,
			checkpoints: [],
			outcomes: [],
			calls: [],
			rawSelections: [],
			snapshot: cellSnapshot(),
			usd: 0,
		},
		judgment,
		metrics: m,
		error: null,
		judgeUsage: null,
	};
	expect(differences([result]).interestRecall).toEqual({
		low: null,
		high: null,
	});
});
const cellSnapshot = () => ({
	state: {
		revision: 0,
		intents: [],
		candidates: [],
		attempts: [],
		beliefs: [],
		desires: [],
		notes: [],
		focus: [],
		nextId: 1,
		lastOutboundAt: null,
	},
	observations: [],
	cursor: 0,
});

test("revised negative cases have explicit stop requests and new topics are included before inference", () => {
	expect(scenes).toHaveLength(16);
	expect(scenes.filter((s) => s.id.startsWith("new-"))).toHaveLength(4);
	const quiet = scenes
		.find((s) => s.id === "competing-interests")!
		.frames.at(-1)!;
	expect(quiet.observations.at(-1)!.actor).toBe("user");
	expect(quiet.interests.every((i) => i.state === "dormant")).toBe(true);
});

for (const variant of ["F-improved", "Fusion"] as const) {
	test(`${variant} shares native interest withdrawal and action execution`, async () => {
		const llm = fakeLlm();
		const v = update();
		v.interestOps = [
			{
				op: "interest.add",
				id: null,
				localId: "topic",
				expectedRevision: null,
				status: "emerging",
				topic: "ユーザーの継続的な音の比較",
				origin: "user_relation",
				reason: "継続的に試している",
				derivedFrom: null,
				evidenceRefs: ["observation-1"],
			},
		];
		llm.push("update", variant === "Fusion" ? v : expandCompact(v));
		const rt = sampleFactory(variant)({
			condition: "F",
			systemContext: "experimental",
			llm,
			tools: experimentTools,
			budget: experimentBudget,
			limits: experimentLimits,
		});
		observe(
			rt,
			"observation-1",
			0,
			"毎週音を比較している。今は条件を調べてほしい",
		);
		await rt.runBackground(0, new AbortController().signal);
		const first = rt.snapshot();
		expect(first.state.interests).toHaveLength(1);
		const c = first.state.candidates[0]!;
		llm.push("select", select(c.id, c.revision));
		const issued = await rt.decide(opp("go", 0), new AbortController().signal);
		expect(issued.decision.ticket?.toolInput).toBe("音の比較に必要な条件");
		rt.recordResult({
			ticketId: issued.decision.ticket!.id,
			at: 0,
			status: "succeeded",
			resultText: "部分的な条件が判明",
		});
		const interest = rt.snapshot().state.interests![0]!;
		const stop = update();
		Object.assign(stop.questions[0]!, {
			change: "update",
			id: first.state.intents[0]!.id,
			localId: null,
			revision: rt.snapshot().state.intents[0]!.revision,
			state: "abandoned",
			stopWhen: null,
			evidenceRefs: ["observation-2"],
			nextStep: null,
		});
		stop.interestOps = [
			{
				op: "interest.update",
				id: interest.id,
				localId: null,
				expectedRevision: interest.revision,
				status: "faded",
				topic: null,
				origin: null,
				reason: "趣味をやめた",
				derivedFrom: null,
				evidenceRefs: ["observation-2"],
			},
		];
		llm.push("update", variant === "Fusion" ? stop : expandCompact(stop));
		observe(
			rt,
			"observation-2",
			1,
			"音の比較は完全にやめた。今後の調査も話題も不要",
		);
		await rt.runBackground(1, new AbortController().signal);
		expect(rt.snapshot().state.interests![0]!.status).toBe("faded");
		expect(rt.snapshot().state.intents[0]!.state).toBe("abandoned");
		expect(rt.snapshot().state.notes).toHaveLength(0);
	});
}
