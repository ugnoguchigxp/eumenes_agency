import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { loadSuiteCases } from "../cases.ts";
import { summarize } from "../score.ts";
import type { Case, OpportunityRecord, RunRecord } from "../contracts.ts";
import {
	criteriaFor,
	factsBefore,
	genericToolCriterion,
	judgeFingerprint,
	judgePrompt,
	JUDGE_PROMPT_VERSION,
	pendingJudgeTasks,
} from "../judge.ts";

const fixtures = resolve(import.meta.dir, "fixtures");
const dev = () => loadSuiteCases("p1e", "dev", fixtures);

const oppRec = (over: Partial<OpportunityRecord> = {}): OpportunityRecord => ({
	opportunityId: "s4",
	expect: null,
	action: "speak",
	source: "llm",
	utterance: "取り込みの件はどうなりましたか。",
	toolName: null,
	evidenceRefs: [],
	reason: "r",
	rejectCodes: [],
	agentAuthoredRefs: [],
	stateCheck: null,
	stateItems: null,
	stateExcluded: null,
	...over,
});
const runRec = (opp: OpportunityRecord): RunRecord => ({
	runName: "p1e-t",
	caseId: "causal-01",
	suite: "p1e",
	group: "causal",
	condition: "B1",
	rep: 1,
	labelStatus: "draft",
	settingsDigest: "d",
	instructionVersion: "v",
	opportunities: [opp],
	calls: [],
	usd: 0,
	finalState: {
		openIntents: 0,
		openCandidates: 0,
		notes: 0,
		beliefs: 0,
		desires: 0,
	},
	safety: [],
	error: null,
	incomplete: false,
});

describe("criteriaFor", () => {
	test("speak uses judge; tool uses judgeTool, else the generic criterion", () => {
		const step = { judge: ["A", "B"] };
		expect(criteriaFor(step, "speak")).toEqual(["A", "B"]);
		expect(criteriaFor(step, "tool")).toEqual([genericToolCriterion]);
		expect(criteriaFor({ ...step, judgeTool: [] }, "tool")).toEqual([
			genericToolCriterion,
		]);
		expect(criteriaFor({ ...step, judgeTool: ["T"] }, "tool")).toEqual(["T"]);
		expect(criteriaFor({ ...step, judgeTool: ["T"] }, "speak")).toEqual([
			"A",
			"B",
		]);
	});
	test("an opportunity without judge criteria judges nothing, tool or speak", () => {
		expect(criteriaFor({ judge: [] }, "tool")).toEqual([]);
		expect(criteriaFor({ judge: [], judgeTool: ["T"] }, "tool")).toEqual([]);
		expect(criteriaFor({ judge: [] }, "speak")).toEqual([]);
	});
});

describe("pendingJudgeTasks by action kind", () => {
	const cases = (judgeTool?: string[]): Case[] =>
		dev().map((c) =>
			c.id !== "causal-01"
				? c
				: {
						...c,
						steps: c.steps.map((s) =>
							s.type === "opportunity" && s.id === "s4"
								? {
										...s,
										...(judgeTool ? { judgeTool } : {}),
									}
								: s,
						),
					},
		);

	test("a tool action gets the generic criterion and sees tool name and input", () => {
		const o = oppRec({
			action: "tool",
			utterance: null,
			toolName: "import_check",
			toolInput: "取り込みの状態を確認する",
		});
		const tasks = pendingJudgeTasks([runRec(o)], cases(), []);
		expect(tasks).toHaveLength(1);
		expect(tasks[0]?.criteria).toEqual([genericToolCriterion]);
		const prompt = judgePrompt(
			factsBefore(tasks[0]!.case, "s4"),
			o,
			tasks[0]!.criteria,
		);
		expect(prompt).toContain("import_check");
		expect(prompt).toContain("取り込みの状態を確認する");
		expect(prompt).toContain(`1. ${genericToolCriterion}`);
	});

	test("a case-given judgeTool replaces the generic criterion; speak is unchanged", () => {
		const tool = oppRec({
			action: "tool",
			toolName: "import_check",
			toolInput: "x",
		});
		const t1 = pendingJudgeTasks(
			[runRec(tool)],
			cases(["取り込みを対象にしている"]),
			[],
		);
		expect(t1[0]?.criteria).toEqual(["取り込みを対象にしている"]);
		const speakTasks = pendingJudgeTasks(
			[runRec(oppRec())],
			cases(["取り込みを対象にしている"]),
			[],
		);
		expect(speakTasks[0]?.criteria).toHaveLength(2);
		expect(speakTasks[0]?.criteria).not.toContain(genericToolCriterion);
	});

	test("a tool verdict row of the generic criterion counts as judged", () => {
		const o = oppRec({ action: "tool", toolName: "t", toolInput: "x" });
		const row = {
			runName: "p1e-t",
			caseId: "causal-01",
			condition: "B1" as const,
			rep: 1,
			opportunityId: "s4",
			criterion: genericToolCriterion,
			verdict: "pass" as const,
			reason: "r",
			model: "m",
			judgeDigest: "dg",
		};
		expect(pendingJudgeTasks([runRec(o)], cases(), [row])).toEqual([]);
	});
});

test("the judge fingerprint carries the bumped prompt version", () => {
	expect(JUDGE_PROMPT_VERSION).toBe("judge-prompt-4");
	expect(judgeFingerprint()).toContain("judge-prompt-4");
});

test("social cases: interests and the opportunity's topics are judge facts", () => {
	const base = dev().find((c) => c.id === "causal-01")!;
	const c: Case = {
		...base,
		interests: [{ id: "i1", text: "マイメロディが好き" }],
		steps: base.steps.map((s) =>
			s.type === "opportunity" && s.id === "s4"
				? { ...s, topics: [{ id: "t1", text: "ユーザーはクロミが好き" }] }
				: s,
		),
	};
	const facts = factsBefore(c, "s4");
	expect(facts[0]).toContain("[interest:i1]");
	expect(facts[0]).toContain("マイメロディが好き");
	expect(facts[1]).toContain("[memory:t1]");
	expect(facts[1]).toContain("クロミ");
	// cases without them render as before
	expect(factsBefore(base, "s4").some((f) => f.includes("interest:"))).toBe(
		false,
	);
});

test("the judge fingerprint includes the generic tool criterion", () => {
	// criteriaFor substitutes this text for a tool action, so it must move the digest.
	expect(judgeFingerprint()).toContain(genericToolCriterion);
	const real = genericToolCriterion;
	const without = judgeFingerprint().split(real).join("");
	expect(without).not.toContain(real);
	expect(without).not.toBe(judgeFingerprint());
});

describe("summary splits speak and tool judgments", () => {
	const judgment = (
		opportunityId: string,
		criterion: string,
		verdict: "pass" | "fail" | "unclear",
	) => ({
		runName: "p1e-t",
		caseId: "causal-01",
		condition: "B1" as const,
		rep: 1,
		opportunityId,
		criterion,
		verdict,
		reason: "r",
		model: "m",
		judgeDigest: "dg",
	});

	test("per-condition table and per-criterion table carry the action kind", () => {
		const record = {
			...runRec(oppRec({ opportunityId: "s4" })),
			opportunities: [
				oppRec({ opportunityId: "s4" }),
				oppRec({ opportunityId: "s5", action: "tool", toolName: "t" }),
			],
		};
		const md = summarize(
			[record],
			[
				judgment("s4", "SPEAK-CRIT", "pass"),
				judgment("s5", genericToolCriterion, "fail"),
			],
		);
		expect(md).toContain("speak (pass/fail/unclear)");
		expect(md).toContain("tool (pass/fail/unclear)");
		expect(md).toContain("| B1 | 1/0/0 | 0/1/0 |");
		expect(md).toContain("| 行動 | 基準 |");
		expect(md).toMatch(/\| speak \| SPEAK-CRIT \| 1\/0\/0 \|/);
		expect(md).toContain(`| tool | ${genericToolCriterion} | 0/1/0 |`);
		expect(md).toContain("直接比べられない");
	});
});
