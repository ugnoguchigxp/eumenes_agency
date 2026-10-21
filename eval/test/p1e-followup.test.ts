import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { commandBudgetReached, withCommandBudget } from "../budget.ts";
import { loadSuiteCases } from "../cases.ts";
import {
	caseSchema,
	type Case,
	type OpportunityRecord,
	type RunRecord,
	type StateJudgment,
} from "../contracts.ts";
import {
	assertDigestCompatible,
	judgeDigest,
	judgeSystemPrompt,
	pendingJudgeTasks,
	readJudgments,
	runJudge,
	appendJudgments,
} from "../judge.ts";
import { parseAnswerAction } from "../label.ts";
import { judgeCommand } from "../main.ts";
import { createUpdateWatch, replayCase } from "../replay.ts";
import {
	appendStateJudgments,
	pendingStateTasks,
	readStateJudgments,
	runStateJudge,
	stateDigest,
	stateJudgePrompt,
	stateJudgeSystemPrompt,
} from "../state-judge.ts";
import { openItems } from "../state-check.ts";
import { emptyState } from "../../src/contracts/model.ts";
import { LlmCallError } from "../../src/contracts/errors.ts";
import type { LlmPort, LlmRequest } from "../../src/contracts/ports.ts";
import { outcome, StubRuntime } from "./fixtures.ts";

const fixtures = resolve(import.meta.dir, "fixtures");
const tmp = () => mkdtempSync(join(tmpdir(), "p1e-fu-"));
const causal = (): Case => {
	const c = loadSuiteCases("p1e", "dev", fixtures).find(
		(x) => x.id === "causal-01",
	);
	if (!c) throw new Error("fixture");
	return c;
};
const role = { model: "m", effort: "high" };
const opts = {
	runName: "t",
	settingsDigest: "d",
	instructionVersion: "v",
	spent: () => 0,
};

const fakeLlm = (answer: (r: LlmRequest<unknown>) => unknown) => {
	const requests: LlmRequest<unknown>[] = [];
	const llm: LlmPort = {
		async complete<T>(request: LlmRequest<T>) {
			requests.push(request as LlmRequest<unknown>);
			return {
				value: request.schema.parse(answer(request as LlmRequest<unknown>)),
				model: "fake",
				inputTokens: 1,
				outputTokens: 1,
				cacheReadTokens: 0,
				latencyMs: 1,
			};
		},
	};
	return { llm, requests };
};

describe("state-check exclusions in replay", () => {
	const withOpp = (id: string, patch: Record<string, unknown>): Case => {
		const c = causal();
		return caseSchema.parse({
			...c,
			steps: c.steps.map((s) => (s.id === id ? { ...s, ...patch } : s)),
		});
	};
	const run = (c: Case, background: ReturnType<typeof outcome>[] = []) =>
		replayCase(
			c,
			"B1",
			1,
			() => new StubRuntime({ decisions: {}, background }),
			opts,
		);

	test("records open items only when mustNotHold is set, and no exclusion normally", async () => {
		const rec = await run(causal());
		const [s4, s6] = rec.opportunities;
		expect(s4?.stateExcluded).toBeNull();
		expect(s4?.stateItems).toBeNull();
		expect(s6?.stateExcluded).toBeNull();
		expect(s6?.stateItems).toEqual([]);
	});
	test("blocked presence and empty stateExpect are excluded", async () => {
		const rec = await run(
			withOpp("s4", { presence: "speaking", expect: null, stateExpect: null }),
		);
		// expect null + stateExpect null: not applicable, nothing excluded
		expect(rec.opportunities[0]?.stateExcluded).toBeNull();
		const blocked = await run(withOpp("s4", { presence: "speaking" }));
		expect(blocked.opportunities[0]).toMatchObject({
			stateExcluded: "blocked",
			stateCheck: null,
		});
		const empty = await run(
			withOpp("s4", { stateExpect: { mustHold: [], mustNotHold: [] } }),
		);
		expect(empty.opportunities[0]).toMatchObject({
			stateExcluded: "empty",
			stateCheck: null,
		});
	});
	test("opportunities after an update infra failure are excluded", async () => {
		const rec = await run(causal(), [outcome("llm_call:api_500:x", "update")]);
		expect(rec.opportunities.map((o) => o.stateExcluded)).toEqual([
			"infra",
			"infra",
		]);
		expect(rec.opportunities.every((o) => o.stateCheck === null)).toBe(true);
	});
	test("update watch: infra codes and two failures in a row taint; applied resets", () => {
		const w = createUpdateWatch();
		w.note([outcome("rejected:schema", "update")]);
		expect(w.tainted).toBe(false);
		w.note([
			outcome("applied", "update"),
			outcome("rejected:schema", "update"),
		]);
		expect(w.tainted).toBe(false);
		w.note([
			outcome("skipped:budget", "update"),
			outcome("llm_call:x", "select"),
		]);
		expect(w.tainted).toBe(false);
		w.note([outcome("rejected:schema", "update")]);
		expect(w.tainted).toBe(true);
		const v = createUpdateWatch();
		v.note([outcome("llm:parse", "update")]);
		expect(v.tainted).toBe(true);
	});
});

describe("openItems", () => {
	test("B1 notes and B2 open intents (held included) and open candidates", () => {
		const s = emptyState();
		s.notes.push({ id: "n1", revision: 1, text: "a\nb", evidence: ["s1"] });
		s.intents.push(
			{
				id: "i1",
				state: "held",
				desiredState: "D",
				motive: "M",
				completionCondition: "C",
				resumeCondition: "R",
				withdrawCondition: "W",
				evidence: ["s1"],
			} as never,
			{ id: "i2", state: "abandoned", evidence: [] } as never,
		);
		s.candidates.push({
			id: "c1",
			kind: "question",
			content: "X",
			applyWhen: "Y",
			state: "held",
			holdReason: "deferred",
			evidence: ["s2"],
		} as never);
		expect(openItems("B1", s)).toEqual([
			{
				id: "n1",
				kind: "note",
				text: "a b",
				state: null,
				holdReason: null,
				evidence: ["s1"],
			},
		]);
		const b2 = openItems("B2", s);
		expect(b2.map((i) => [i.id, i.kind, i.state, i.holdReason])).toEqual([
			["i1", "intent", "held", null],
			["c1", "candidate", "held", "deferred"],
		]);
		expect(b2[0]?.text).toContain("再開条件: R");
		expect(openItems("B0", s)).toEqual([]);
	});
});

const items = [
	{
		id: "n1",
		kind: "note" as const,
		text: "取り込み失敗の原因を調べる",
		state: null,
		holdReason: null,
		evidence: ["s1"],
	},
];
const stateRecord = (over: Partial<OpportunityRecord> = {}): RunRecord => ({
	runName: "p1e-t",
	caseId: "causal-01",
	suite: "p1e",
	group: "causal",
	condition: "B1",
	rep: 1,
	labelStatus: "draft",
	settingsDigest: "d",
	instructionVersion: "v",
	opportunities: [
		{
			opportunityId: "s6",
			expect: null,
			action: "wait",
			source: "llm",
			utterance: null,
			toolName: null,
			evidenceRefs: [],
			reason: "r",
			rejectCodes: [],
			agentAuthoredRefs: [],
			stateCheck: { mustHold: [], violations: ["s1"] },
			stateItems: items,
			stateExcluded: null,
			...over,
		},
	],
	calls: [],
	usd: 0,
	finalState: {
		openIntents: 0,
		openCandidates: 0,
		notes: 1,
		beliefs: 0,
		desires: 0,
	},
	safety: [],
	error: null,
	incomplete: false,
});

describe("state judge", () => {
	const verdicts = (v: string) => ({
		verdicts: [{ matter: 1, verdict: v, reason: "n1 は解決済みと書いてある" }],
	});

	test("prompt: matter text, open items and context; never the labels", () => {
		const p = stateJudgePrompt(causal(), "s6", ["s1"], items);
		expect(p).toContain("1. [s1]");
		expect(p).toContain("CSVの取り込みが文字化けで失敗した");
		expect(p).toContain("[n1] note");
		expect(p).toContain("（事項）");
		expect(p).toContain("原因は文字コードの混在だった");
		expect(p).not.toContain("ラベル注記");
		expect(p).not.toContain("mustHold");
		expect(stateJudgeSystemPrompt).toContain("handled");
	});
	test("one call per opportunity, one row per matter; resume skips rows; stats", async () => {
		const dir = tmp();
		const file = join(dir, "state-judgments.jsonl");
		const records = [stateRecord()];
		const tasks = pendingStateTasks(
			records,
			[causal()],
			readStateJudgments(file),
		);
		expect(tasks).toHaveLength(1);
		const { llm, requests } = fakeLlm(() => verdicts("handled"));
		const r = await runStateJudge({
			tasks,
			llm,
			digest: "sd",
			append: appendStateJudgments(file),
		});
		expect(r).toMatchObject({ judged: 1, rows: 1, failed: 0 });
		expect(requests).toHaveLength(1);
		const rows = readStateJudgments(file);
		expect(rows[0]).toMatchObject({
			step: "s1",
			verdict: "handled",
			judgeDigest: "sd",
			opportunityId: "s6",
		});
		expect(pendingStateTasks(records, [causal()], rows)).toHaveLength(0);
	});
	test("no open items: absent without a call; excluded and D records are not judged", async () => {
		const empty = stateRecord({ stateItems: [] });
		const { llm, requests } = fakeLlm(() => verdicts("handled"));
		const out: StateJudgment[][] = [];
		await runStateJudge({
			tasks: pendingStateTasks([empty], [causal()], []),
			llm,
			digest: "sd",
			append: (rows) => out.push([...rows]),
		});
		expect(requests).toHaveLength(0);
		expect(out[0]?.[0]).toMatchObject({ verdict: "absent", model: "none" });
		expect(
			pendingStateTasks(
				[stateRecord({ stateCheck: null, stateItems: null })],
				[causal()],
				[],
			),
		).toHaveLength(0);
		expect(
			pendingStateTasks([{ ...stateRecord(), condition: "D" }], [causal()], []),
		).toHaveLength(0);
	});
	test("a verdict set that misses a matter is not written", async () => {
		const { llm } = fakeLlm(() => ({ verdicts: [] }));
		const out: unknown[] = [];
		const r = await runStateJudge({
			tasks: pendingStateTasks([stateRecord()], [causal()], []),
			llm,
			digest: "sd",
			append: (rows) => out.push(rows),
		});
		expect(r.failed).toBe(1);
		expect(out).toHaveLength(0);
	});
	test("judgeCommand runs content then state pass and stops both on --limit", async () => {
		const root = tmp();
		mkdirSync(join(root, "p1e-t"));
		writeFileSync(
			join(root, "p1e-t", "runs.jsonl"),
			`${JSON.stringify(stateRecord())}\n`,
		);
		const { llm } = fakeLlm(() => verdicts("still_active"));
		const text = await judgeCommand("p1e-t", {
			llm,
			role,
			root,
			casesRoot: fixtures,
		});
		expect(text).toContain(
			"state: 1 pending opportunities, judged 1 (1 matters)",
		);
		const rows = readStateJudgments(
			join(root, "p1e-t", "state-judgments.jsonl"),
		);
		expect(rows[0]?.judgeDigest).toBe(stateDigest(role));
		const again = await judgeCommand("p1e-t", {
			llm,
			role,
			root,
			casesRoot: fixtures,
		});
		expect(again).toContain("state: 0 pending");
		// A different route is refused instead of mixing verdicts.
		await expect(
			judgeCommand("p1e-t", {
				llm,
				role: { model: "other", effort: "high" },
				root,
				casesRoot: fixtures,
			}),
		).rejects.toThrow(/digest/);
	});
});

describe("judge integrity", () => {
	test("digest depends on model, effort and prompt", () => {
		const base = judgeDigest(role, judgeSystemPrompt);
		expect(judgeDigest({ ...role, model: "x" }, judgeSystemPrompt)).not.toBe(
			base,
		);
		expect(judgeDigest({ ...role, effort: "low" }, judgeSystemPrompt)).not.toBe(
			base,
		);
		expect(judgeDigest(role, `${judgeSystemPrompt}!`)).not.toBe(base);
		expect(() =>
			assertDigestCompatible([{ judgeDigest: base }], base, "f"),
		).not.toThrow();
		expect(() =>
			assertDigestCompatible([{ judgeDigest: "old" }], base, "f"),
		).toThrow(/digest "old".*"/);
	});
	test("an edited criterion is judged again; unchanged ones are not repeated", async () => {
		const c = causal();
		const rec: RunRecord = {
			...stateRecord(),
			opportunities: [
				{
					...(stateRecord().opportunities[0] as OpportunityRecord),
					opportunityId: "s4",
					action: "speak",
					utterance: "u",
				},
			],
		};
		const row = (criterion: string) => ({
			runName: "p1e-t",
			caseId: "causal-01",
			condition: "B1" as const,
			rep: 1,
			opportunityId: "s4",
			criterion,
			verdict: "pass" as const,
			reason: "r",
			model: "m",
			judgeDigest: "dg",
		});
		const both = [
			row("経験(s1)を正しく参照している"),
			row("完了したと偽っていない"),
		];
		expect(pendingJudgeTasks([rec], [c], both)).toHaveLength(0);
		// Same text count but one criterion text differs: only that one is pending.
		const edited = [row("経験(s1)を正しく参照している"), row("旧い基準の文言")];
		const tasks = pendingJudgeTasks([rec], [c], edited);
		expect(tasks).toHaveLength(1);
		expect(tasks[0]?.criteria).toEqual(["完了したと偽っていない"]);
		const { llm, requests } = fakeLlm(() => ({
			verdicts: [{ criterion: 1, verdict: "fail", reason: "r" }],
		}));
		const dir = tmp();
		const file = join(dir, "j.jsonl");
		await runJudge({ tasks, llm, digest: "dg", append: appendJudgments(file) });
		expect(requests[0]?.prompt).toContain("1. 完了したと偽っていない");
		expect(requests[0]?.prompt).not.toContain("経験(s1)を正しく参照している\n");
		expect(readJudgments(file)).toHaveLength(1);
	});
});

describe("parseAnswerAction", () => {
	test("takes the first token, not a later mention", () => {
		expect(parseAnswerAction("待つ。ここで speak すると邪魔")).toBe("wait");
		expect(parseAnswerAction("発話するのがよい。tool は使えない")).toBe(
			"speak",
		);
		expect(parseAnswerAction("Speak: 未解決だから wait ではない")).toBe(
			"speak",
		);
		expect(parseAnswerAction("  `tool` rerun_import を使う")).toBe("tool");
		expect(parseAnswerAction("**wait** speak するほどでは")).toBe("wait");
		expect(parseAnswerAction("ツールを使う。speak は不要")).toBe("tool");
		expect(parseAnswerAction("reflect 記録だけ")).toBe("reflect");
		expect(parseAnswerAction("discard")).toBe("discard");
	});
	test("no action word at the start means no answer", () => {
		expect(parseAnswerAction("")).toBeNull();
		expect(parseAnswerAction("たぶん speak")).toBeNull();
		expect(parseAnswerAction("skip")).toBeNull();
		expect(parseAnswerAction("maybe wait")).toBeNull();
	});
});

describe("command budget", () => {
	const inner = (spendBox: { v: number }) =>
		fakeLlm(() => {
			spendBox.v += 0.6;
			return { verdicts: [] };
		});
	test("refuses calls once this command's own spend reached the limit", async () => {
		const box = { v: 5 };
		const { llm } = inner(box);
		const guarded = withCommandBudget(llm, () => box.v, 1);
		const req = {
			purpose: "select" as const,
			system: "",
			prompt: "",
			schema: { parse: (x: unknown) => x } as never,
			maxOutputTokens: 1,
		};
		const signal = new AbortController().signal;
		await guarded.complete(req, signal);
		await guarded.complete(req, signal);
		await expect(guarded.complete(req, signal)).rejects.toBeInstanceOf(
			LlmCallError,
		);
		await expect(guarded.complete(req, signal)).rejects.toMatchObject({
			reasonCode: "spend_limit",
		});
		expect(commandBudgetReached(() => box.v, 5, 1)).toBe(true);
		expect(commandBudgetReached(() => 5.5, 5, 1)).toBe(false);
	});
	test("a runPool stops on it as a spend limit", async () => {
		const box = { v: 0 };
		const { llm } = inner(box);
		const guarded = withCommandBudget(llm, () => box.v, 0.5);
		const records = [stateRecord(), { ...stateRecord(), rep: 2 }];
		const r = await runStateJudge({
			tasks: pendingStateTasks(records, [causal()], []),
			llm: guarded,
			digest: "sd",
			append: () => {},
		});
		// first call spends 0.6 (and fails the coverage check), second is refused
		expect(r.stoppedBy).toBe("spend_limit");
	});
});
