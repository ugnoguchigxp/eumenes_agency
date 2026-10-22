/** Evaluation-harness fixes from the 2026-10-22 review (E1/E2 ablation, H1-H7). */
import { describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	assertCaseVersions,
	caseHash,
	loadSuiteCases,
	stableJson,
} from "../cases.ts";
import {
	caseSchema,
	evalConditions,
	runtimeConditionOf,
	type Case,
	type Judgment,
	type OpportunityRecord,
	type RunRecord,
	type StateJudgment,
} from "../contracts.ts";
import {
	describeAction,
	earlierOpportunities,
	factsBefore,
	judgeDigest,
	judgeFingerprint,
	judgePrompt,
	judgeSystemPrompt,
	JUDGE_PROMPT_VERSION,
} from "../judge.ts";
import {
	buildJudgeSheet,
	cohenKappa,
	formatJudgeAgreement,
	judgeAgreement,
	judgedActions,
	labelAgreement,
	parseAnswerAction,
	parseJudgeSheet,
	parseLabelSheet,
	type JudgeKey,
	type LabelKey,
} from "../label.ts";
import {
	allCallsOutputFailures,
	assertResumeCases,
	defaultConditions,
	evaluateStop,
	judgeCommand,
	judgeAgreementCommand,
	judgeExportCommand,
	parseConditions,
	planRuns,
	scoreCommand,
} from "../main.ts";
import { replayCase } from "../replay.ts";
import {
	agreementHeader,
	classify,
	parseAgreementHeader,
	summarize,
	type AgreementInfo,
} from "../score.ts";
import { stateDigest, stateJudgeFingerprint } from "../state-judge.ts";
import { formatTrace, type TraceLine } from "../trace.ts";
import { emptyState } from "../../src/contracts/model.ts";
import type { LlmPort } from "../../src/contracts/ports.ts";
import { decision, outcome, StubRuntime, ticketFor } from "./fixtures.ts";

const fixtures = resolve(import.meta.dir, "fixtures");
const tmp = () => mkdtempSync(join(tmpdir(), "rfix-"));
const causal01 = (): Case => {
	const c = loadSuiteCases("p1e", "dev", fixtures).find(
		(x) => x.id === "causal-01",
	);
	if (!c) throw new Error("no fixture");
	return c;
};

const opp = (over: Partial<OpportunityRecord> = {}): OpportunityRecord => ({
	opportunityId: "s4",
	expect: {
		needed: true,
		accept: ["speak", "tool"],
		evidenceAny: [],
		failureIfOutward: "unnecessary",
		note: "n",
	},
	action: "speak",
	source: "llm",
	utterance: "u",
	toolName: null,
	evidenceRefs: [],
	reason: "r",
	rejectCodes: [],
	agentAuthoredRefs: [],
	stateCheck: { mustHold: [true], violations: [] },
	stateItems: null,
	stateExcluded: null,
	...over,
});
const run = (over: Partial<RunRecord> = {}): RunRecord => ({
	runName: "r",
	caseId: "causal-01",
	suite: "p1e",
	group: "causal",
	condition: "B1",
	rep: 1,
	labelStatus: "draft",
	settingsDigest: "d",
	instructionVersion: "v",
	opportunities: [opp()],
	calls: [],
	usd: 0.01,
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
	...over,
});

describe("B1a ablation condition", () => {
	test("is an eval condition run as B1; part of the p1e default set", () => {
		expect(evalConditions).toContain("B1a");
		expect(runtimeConditionOf("B1a")).toBe("B1");
		expect(runtimeConditionOf("B2")).toBe("B2");
		expect(runtimeConditionOf("D")).toBeNull();
		expect(defaultConditions("p1e")).toBe("B1,B1a,B2,D");
		expect(defaultConditions("p0e")).toBe("B0,B1,B2,F");
		expect(parseConditions("B1,B1a")).toEqual(["B1", "B1a"]);
		const plan = planRuns([causal01()], parseConditions("B1,B1a,B2,D"), 1);
		expect(plan.map((p) => p.condition).sort()).toEqual([
			"B1",
			"B1a",
			"B2",
			"D",
		]);
	});
	test("replay state-checks B1a like B1 (D stays unchecked)", async () => {
		const c = causal01();
		const rtFor = () => new StubRuntime({ decisions: {} });
		const b1a = await replayCase(c, "B1a", 1, rtFor, {
			runName: "r",
			settingsDigest: "d",
			instructionVersion: "v",
			spent: () => 0,
		});
		expect(b1a.condition).toBe("B1a");
		expect(b1a.opportunities[0]?.stateCheck).toEqual({
			mustHold: [false],
			violations: [],
		});
		const d = await replayCase(c, "D", 1, rtFor, {
			runName: "r",
			settingsDigest: "d",
			instructionVersion: "v",
			spent: () => 0,
		});
		expect(d.opportunities[0]?.stateCheck).toBeNull();
	});
	test("summary reports B1a as its own condition, next to B1", () => {
		const md = summarize([
			run({ condition: "B2" }),
			run({ condition: "B1a" }),
			run({ condition: "B1" }),
		]);
		const header = md.split("\n").find((l) => l.startsWith("| 失敗の型 |"));
		expect(header).toBe("| 失敗の型 | B1 | B1a | B2 |");
		expect(md).toContain("| causal | B1a（B1+select常時） |");
	});
});

describe("host-gate visibility", () => {
	test("sources are split per condition, group and need", () => {
		const gate = (source: string, needed: boolean): OpportunityRecord =>
			opp({
				action: "wait",
				source,
				expect: {
					needed,
					accept: needed ? ["speak"] : ["wait"],
					evidenceAny: [],
					failureIfOutward: "unnecessary",
					note: "n",
				},
				stateCheck: null,
			});
		const md = summarize([
			run({
				condition: "B1",
				opportunities: [
					gate("host_no_candidates", true),
					gate("host_no_candidates", false),
					gate("host_no_candidates", false),
					gate("llm", false),
					gate("host_stale", true),
					gate("host_blocked", false),
					gate("rejected", true),
				],
			}),
		]);
		// columns: 条件 | 要否 | 機会 | llm | host_no_candidates | host_stale | その他 host | その他
		expect(md).toContain("| B1 | 要 | 3 | 0 | 1 | 1 | 0 | 1 |");
		expect(md).toContain("| B1 | 不要 | 4 | 1 | 2 | 0 | 1 | 0 |");
		expect(md).toContain("| causal | B1 | 要 | 3 | 0 | 1 | 1 | 0 | 1 |");
		// host_stale scores like any other wait (needed -> FN)
		expect(md).toContain("| B1 | 1 | 7 | 0 | 0 | 3 | 3 | 0 | 1 | 0 |");
	});
});

describe("H1: empty mustHold is not 'all met'", () => {
	test("mustHold columns use only opportunities with a mustHold group", () => {
		const md = summarize([
			run({
				opportunities: [
					opp({ stateCheck: { mustHold: [], violations: [] } }),
					opp({ stateCheck: { mustHold: [], violations: [] } }),
					opp({ stateCheck: { mustHold: [true, false], violations: [] } }),
				],
			}),
		]);
		// cases=1, checked=3, with mustHold=1, groups 1/2, all-met 0/1
		expect(md).toContain(
			"| causal | B1 | 1 | 3 | 1 | 1/2 (50%) | 0/1 (0%) | 0/0/0 |",
		);
		expect(md).toContain("うち mustHold あり（分母）");
	});
});

describe("H2: release judgement without the empty-state case", () => {
	const sj = (
		over: Partial<StateJudgment> & { verdict: StateJudgment["verdict"] },
	): StateJudgment => ({
		runName: "r",
		caseId: "causal-01",
		condition: "B1",
		rep: 1,
		opportunityId: "s4",
		step: "s2",
		reason: "r",
		model: "m",
		judgeDigest: "d",
		...over,
	});
	test("absent from 'none' (no items) is a separate column and not in the rate", () => {
		const md = summarize(
			[run()],
			[],
			[
				sj({ verdict: "absent", model: "none", step: "s3" }),
				sj({ verdict: "absent", model: "none", step: "s5" }),
				sj({ verdict: "absent", step: "s6" }),
				sj({ verdict: "still_active", step: "s7" }),
			],
		);
		// cases, matters, handled, absent(judged), still_active, unclear, rate, empty
		expect(md).toContain(
			"| causal | B1 | 1 | 4 | 0 | 1 | 1 | 0 | 1/2 (50%) | 2 |",
		);
		expect(md).toContain("項目なし（自動）");
	});
});

describe("H3: judge calibration", () => {
	const crit = ["経験(s1)を正しく参照している", "完了したと偽っていない"];
	const withJudge = (verdicts: Judgment["verdict"][][]) => {
		const c = causal01();
		const recs = verdicts.map((_, i) =>
			run({ rep: i + 1, opportunities: [opp({ opportunityId: "s4" })] }),
		);
		const js: Judgment[] = verdicts.flatMap((vs, i) =>
			vs.map((verdict, k) => ({
				runName: "r",
				caseId: "causal-01",
				condition: "B1" as const,
				rep: i + 1,
				opportunityId: "s4",
				criterion: crit[k] ?? "",
				verdict,
				reason: "R",
				model: "m",
				judgeDigest: "d",
			})),
		);
		return judgedActions(recs, [c], js);
	};

	test("judge-export includes all fail/unclear actions up to half the sample", () => {
		const verdicts: Judgment["verdict"][][] = [
			...Array.from(
				{ length: 12 },
				() => ["pass", "pass"] as Judgment["verdict"][],
			),
			["fail", "pass"],
			["pass", "unclear"],
			["fail", "fail"],
		];
		const actions = withJudge(verdicts);
		const { key } = buildJudgeSheet("r", actions, 6, "seed");
		expect(key.items).toHaveLength(6);
		// 3 flagged actions exist, all included (<= half of 6)
		expect(key.sampling).toEqual({ flagged: 3, other: 3 });
		expect(key.items.filter((i) => i.flagged)).toHaveLength(3);
		// capped at half
		const capped = buildJudgeSheet(
			"r",
			withJudge([
				...Array.from(
					{ length: 10 },
					() => ["fail", "pass"] as Judgment["verdict"][],
				),
				...Array.from(
					{ length: 10 },
					() => ["pass", "pass"] as Judgment["verdict"][],
				),
			]),
			4,
			"seed",
		);
		expect(capped.key.sampling).toEqual({ flagged: 2, other: 2 });
	});
	test("criteria without a judge row are skipped, not made up as unclear", () => {
		const actions = withJudge([["pass"]]); // only criterion 1 has a row
		const { sheet, key } = buildJudgeSheet("r", actions, 1, "seed");
		expect(key.items[0]?.verdicts).toHaveLength(1);
		expect(sheet).toContain("1. 経験(s1)を正しく参照している");
		expect(sheet).not.toContain("2. 完了したと偽っていない");
		expect(sheet).not.toContain("回答 2:");
	});
	test("confusion matrix, kappa; both-unclear is not agreement", () => {
		const key: JudgeKey = {
			kind: "judge",
			run: "r",
			seed: "s",
			model: "m",
			items: [
				{
					item: 1,
					caseId: "c",
					condition: "B1",
					rep: 1,
					opportunityId: "s4",
					verdicts: [
						{ criterion: "A", verdict: "pass", reason: "" },
						{ criterion: "B", verdict: "pass", reason: "" },
					],
				},
				{
					item: 2,
					caseId: "c",
					condition: "B1",
					rep: 1,
					opportunityId: "s5",
					verdicts: [
						{ criterion: "A", verdict: "fail", reason: "" },
						{ criterion: "B", verdict: "unclear", reason: "" },
					],
				},
				{
					item: 3,
					caseId: "c",
					condition: "B1",
					rep: 1,
					opportunityId: "s6",
					verdicts: [
						{ criterion: "A", verdict: "pass", reason: "" },
						{ criterion: "B", verdict: "fail", reason: "" },
					],
				},
			],
		};
		const parsed = parseJudgeSheet(
			[
				"## 項目 1\n回答 1: pass\n回答 2: fail",
				"## 項目 2\n回答 1: fail\n回答 2: unclear",
				"## 項目 3\n回答 1: pass\n回答 2: fail",
			].join("\n"),
		);
		const r = judgeAgreement(parsed, key);
		expect(r.answered).toBe(6);
		expect(r.bothUnclear).toBe(1);
		expect(r.compared).toBe(5);
		expect(r.agree).toBe(4);
		expect(r.confusion.pass.pass).toBe(2);
		expect(r.confusion.fail.pass).toBe(1);
		expect(r.confusion.unclear.unclear).toBe(1);
		expect(r.kappa).not.toBeNull();
		const text = formatJudgeAgreement(r);
		expect(text).toContain("4/5 (80%)");
		expect(text).toContain("人も判定器も unclear: 1 件");
		expect(text).toContain("| pass | 2 | 0 | 0 |");
	});
	test("kappa: perfect, chance-level, and undefined", () => {
		const m = (pp: number, pf: number, fp: number, ff: number) => ({
			pass: { pass: pp, fail: pf, unclear: 0 },
			fail: { pass: fp, fail: ff, unclear: 0 },
			unclear: { pass: 0, fail: 0, unclear: 0 },
		});
		expect(cohenKappa(m(5, 0, 0, 5))).toBe(1);
		expect(cohenKappa(m(5, 5, 5, 5))).toBe(0);
		// "always pass" judge: 95% raw agreement but kappa 0
		expect(cohenKappa(m(95, 0, 5, 0))).toBe(0);
		expect(cohenKappa(m(10, 0, 0, 0))).toBeNull();
	});
	test("summary marks the judge as uncalibrated until an agreement file exists", () => {
		const j: Judgment = {
			runName: "r",
			caseId: "causal-01",
			condition: "B1",
			rep: 1,
			opportunityId: "s4",
			criterion: "完了したと偽っていない",
			verdict: "pass",
			reason: "r",
			model: "m",
			judgeDigest: "d",
		};
		expect(summarize([run()], [j])).toContain("判定器は未較正");
		const info = (over: Partial<AgreementInfo> = {}): AgreementInfo => ({
			digest: "d",
			n: 24,
			kappa: 0.6,
			...over,
		});
		const withInfo = (i: AgreementInfo) =>
			summarize([run()], [j], [], { judgeAgreement: i });
		// calibrated only with a matching digest and n >= 20; kappa and n always shown
		const ok = withInfo(info());
		expect(ok).toContain("判定器は較正済み");
		expect(ok).toContain("κ=0.60");
		expect(ok).toContain("n=24");
		expect(ok).not.toContain("判定器は未較正");
		for (const [bad, why] of [
			[info({ digest: "other" }), "digest が judgments の digest と一致しない"],
			[info({ n: 19 }), "n が 20 未満"],
			[info({ digest: "" }), "digest"],
		] as const) {
			const md = withInfo(bad);
			expect(md).toContain("判定器は未較正");
			expect(md).toContain(why);
			expect(md).toContain(`n=${bad.n}`);
			expect(md).toContain("κ=0.60");
		}
		// judgments made with two different digests cannot match one agreement file
		const j2 = { ...j, rep: 2, judgeDigest: "d2" };
		expect(
			summarize([run()], [j, j2], [], { judgeAgreement: info() }),
		).toContain("判定器は未較正");
		// the header line round-trips
		expect(
			parseAgreementHeader(agreementHeader(info({ kappa: null }))),
		).toEqual(info({ kappa: null }));
		expect(parseAgreementHeader("# no header")).toBeNull();
	});
});

describe("H4: negated Japanese answers are errors, not positives", () => {
	test("negations raise, naming the item via the sheet parser", () => {
		for (const t of [
			"話しかけない",
			"伝えない",
			"ツールを使わない",
			"待たない",
			"話さない",
			"声をかけない。まだ早い",
			"don't speak",
			"not wait",
		])
			expect(() => parseAnswerAction(t)).toThrow(/否定形/);
		expect(() =>
			parseLabelSheet("## 項目 7\n\n回答: 話しかけない。邪魔になる\n"),
		).toThrow(/項目 7/);
	});
	test("positives, 何もしない, and negations inside the reason still parse", () => {
		expect(parseAnswerAction("何もしない")).toBe("wait");
		expect(parseAnswerAction("待つ。ここで話しかけない方がよい")).toBe("wait");
		expect(parseAnswerAction("話しかける。邪魔にならない")).toBe("speak");
		expect(parseAnswerAction("ツールを使う")).toBe("tool");
		expect(parseAnswerAction("speak 理由: 待たない")).toBe("speak");
		expect(parseAnswerAction("様子見")).toBe("wait");
	});
});

describe("H5: case versions", () => {
	test("caseHash is stable over key order and changes with content", () => {
		const c = causal01();
		const shuffled = JSON.parse(JSON.stringify(c)) as Case;
		expect(stableJson({ b: 1, a: [{ d: 1, c: 2 }] })).toBe(
			stableJson({ a: [{ c: 2, d: 1 }], b: 1 }),
		);
		expect(caseHash(shuffled)).toBe(caseHash(c));
		expect(caseHash({ ...c, title: `${c.title}!` })).not.toBe(caseHash(c));
	});
	test("replay records the case hash", async () => {
		const c = causal01();
		const rec = await replayCase(
			c,
			"B1",
			1,
			() => new StubRuntime({ decisions: {} }),
			{
				runName: "r",
				settingsDigest: "d",
				instructionVersion: "v",
				spent: () => 0,
			},
		);
		expect(rec.caseHash).toBe(caseHash(c));
	});
	test("--resume refuses a changed case and unhashed records (unless --allow-unverified)", () => {
		const c = causal01();
		const ok = run({ caseHash: caseHash(c) });
		expect(() => assertResumeCases([ok], [c])).not.toThrow();
		expect(() => assertResumeCases([run()], [c])).toThrow(/--allow-unverified/);
		expect(() => assertResumeCases([run()], [c], true)).not.toThrow();
		const edited = { ...c, title: "edited" };
		expect(() => assertResumeCases([ok], [edited])).toThrow(/causal-01/);
		// a changed case is refused even with the flag
		expect(() => assertResumeCases([ok], [edited], true)).toThrow(/causal-01/);
		expect(assertCaseVersions([run()], [c], "x", true)).toEqual({
			unverified: 1,
		});
		// unknown cases are ignored
		expect(() =>
			assertResumeCases([run({ caseId: "gone-01", caseHash: "zz" })], [c]),
		).not.toThrow();
	});
	test("judgeCommand refuses records of another case version", async () => {
		const root = tmp();
		mkdirSync(join(root, "r1"), { recursive: true });
		writeFileSync(
			join(root, "r1", "runs.jsonl"),
			`${JSON.stringify(run({ caseHash: "deadbeef" }))}\n`,
		);
		const llm: LlmPort = {
			async complete() {
				throw new Error("must not be called");
			},
		};
		await expect(
			judgeCommand("r1", {
				llm,
				role: { model: "m", effort: "high" },
				root,
				casesRoot: fixtures,
			}),
		).rejects.toThrow(/case file changed/);
	});
	test("label agreement refuses when a case changed after export", () => {
		const c = causal01();
		const key: LabelKey = {
			kind: "label",
			suite: "p1e",
			split: "dev",
			seed: "s",
			items: [{ item: 1, caseId: "causal-01", opportunityId: "s4" }],
			caseHashes: { "causal-01": caseHash(c) },
		};
		const answers = parseLabelSheet("## 項目 1\n\n回答: speak\n");
		expect(labelAgreement(answers, key, [c]).answered).toBe(1);
		expect(() => labelAgreement(answers, key, [{ ...c, title: "x" }])).toThrow(
			/case file changed/,
		);
	});
});

describe("H6: agent output failures stay in the state denominators", () => {
	const replayWith = (code: string) =>
		replayCase(
			causal01(),
			"B1",
			1,
			() =>
				new StubRuntime({
					decisions: {},
					background: [outcome(code), outcome(code)],
				}),
			{
				runName: "r",
				settingsDigest: "d",
				instructionVersion: "v",
				spent: () => 0,
				batchSize: 1,
			},
		);
	test("schema/rejected update failures do not exclude; infra does", async () => {
		for (const code of ["llm:schema", "rejected:evidence", "llm:max_tokens"]) {
			const rec = await replayWith(code);
			expect(rec.opportunities.every((o) => o.stateExcluded === null)).toBe(
				true,
			);
			expect(rec.opportunities.every((o) => o.stateCheck !== null)).toBe(true);
		}
		const infra = await replayWith("llm_call:timeout");
		expect(infra.opportunities.every((o) => o.stateExcluded === "infra")).toBe(
			true,
		);
	});
});

describe("H7", () => {
	test("infra is not counted twice (call + opportunity)", () => {
		const md = summarize([
			run({
				opportunities: [
					opp({
						action: "wait",
						source: "error",
						rejectCodes: ["call:llm_call:timeout"],
						stateCheck: null,
					}),
				],
				calls: [
					{
						purpose: "select",
						at: 0,
						code: "llm_call:timeout",
						model: null,
						inputTokens: 0,
						outputTokens: 0,
						latencyMs: 0,
						rejectCodes: [],
					},
				],
			}),
		]);
		expect(md).toContain("| infra | 1 |");
	});
	test("summary shows spend including superseded records", () => {
		const md = summarize([run({ usd: 1, incomplete: true }), run({ usd: 2 })]);
		expect(md).toContain("合計費用（最新の記録のみ）: $2.0000");
		expect(md).toContain("実支出）: $3.0000（記録 2 件、うち置き換え 1 件）");
	});
	test("per-group tables show the number of distinct cases", () => {
		const md = summarize([
			run({ rep: 1 }),
			run({ rep: 2 }),
			run({ caseId: "causal-02" }),
		]);
		expect(md).toContain("| causal | B1 | 3 | 2 | ");
	});
	test("judge input carries tool input and the agent's earlier outward actions", () => {
		const c = causal01();
		const earlier = opp({ opportunityId: "s4", utterance: "EARLIER-SPEECH" });
		const facts = factsBefore(c, "s6", [earlier]);
		expect(facts.join("\n")).toContain("EARLIER-SPEECH");
		expect(facts.join("\n")).toContain("[s4]");
		// wait actions are not outward
		expect(
			factsBefore(c, "s6", [opp({ action: "wait", utterance: null })]).join(
				"\n",
			),
		).not.toContain("エージェント自身");
		const tool = opp({
			action: "tool",
			toolName: "search_notes",
			toolInput: '{"q":"TOOL-INPUT"}',
			utterance: null,
		});
		expect(describeAction(tool)).toContain("TOOL-INPUT");
		expect(judgePrompt([], tool, ["c"])).toContain("TOOL-INPUT");
		expect(
			earlierOpportunities({ opportunities: [earlier, tool] }, "s4"),
		).toEqual([]);
		expect(
			earlierOpportunities(
				{ opportunities: [earlier, { ...tool, opportunityId: "s6" }] },
				"s6",
			),
		).toEqual([earlier]);
	});
	test("replay records the tool input", async () => {
		const c = causal01();
		const rt = new StubRuntime({
			decisions: {
				s4: {
					...decision({ opportunityId: "s4", action: "tool" }),
					toolName: "x",
					toolInput: "INPUT",
					ticket: ticketFor("s4", "tool", { toolName: "x" }),
				},
			},
		});
		const rec = await replayCase(c, "B1", 1, () => rt, {
			runName: "r",
			settingsDigest: "d",
			instructionVersion: "v",
			spent: () => 0,
		});
		expect(rec.opportunities[0]?.toolInput).toBe("INPUT");
	});
	test("judge digest covers the prompt-builder shape", () => {
		const role = { model: "m", effort: "high" };
		const fp = judgeFingerprint();
		expect(fp).toContain(JUDGE_PROMPT_VERSION);
		expect(fp).toContain(judgeSystemPrompt);
		expect(fp).toContain("ツールへの入力");
		expect(judgeDigest(role, fp)).not.toBe(
			judgeDigest(role, judgeSystemPrompt),
		);
		expect(stateJudgeFingerprint()).toContain("state-judge-prompt-");
		expect(stateDigest(role)).toBe(judgeDigest(role, stateJudgeFingerprint()));
	});
	test("p1e opportunities need present, needed or not (inline fixture)", () => {
		const base = JSON.parse(JSON.stringify(causal01())) as Record<
			string,
			unknown
		>;
		const steps = base.steps as Record<string, unknown>[];
		const notNeeded = steps.find((s) => s.id === "s6");
		expect(notNeeded).toBeDefined();
		if (!notNeeded) return;
		expect(caseSchema.safeParse(base).success).toBe(true);
		notNeeded.present = [];
		const res = caseSchema.safeParse(base);
		expect(res.success).toBe(false);
		expect(JSON.stringify(res.error?.issues)).toContain("needs present");
		// the rule is p1e only: a p0e case with empty present still loads
		expect(caseSchema.safeParse({ ...base, suite: "p0e" }).success).toBe(true);
	});
	test("mustHold/mustNotHold/present must name observation steps", () => {
		const mk = (patch: (s: Record<string, unknown>) => void) => {
			const base = JSON.parse(JSON.stringify(causal01())) as {
				steps: Record<string, unknown>[];
			};
			const s6 = base.steps.find((s) => s.id === "s6");
			if (s6) patch(s6);
			return caseSchema.safeParse(base);
		};
		// s4 is an opportunity of causal-01
		const hold = mk((s) => {
			s.stateExpect = { mustHold: [["s4"]], mustNotHold: [] };
		});
		expect(hold.success).toBe(false);
		expect(JSON.stringify(hold.error?.issues)).toContain("opportunity");
		const notHold = mk((s) => {
			s.stateExpect = { mustHold: [], mustNotHold: ["s4"] };
		});
		expect(notHold.success).toBe(false);
		expect(mk((s) => (s.present = ["s4"])).success).toBe(false);
		expect(mk(() => undefined).success).toBe(true);
	});
	test("trace: the latest run of the same (case, condition, rep) wins", () => {
		const call = (seq: number, prompt: string): TraceLine => ({
			type: "call",
			runName: "r",
			caseId: "c",
			condition: "B2",
			rep: 1,
			seq,
			purpose: "update",
			system: "S",
			prompt,
			output: { a: 1 },
			model: "m",
			inputTokens: 1,
			outputTokens: 1,
			latencyMs: 1,
		});
		const fin = (): TraceLine => ({
			type: "final",
			runName: "r",
			caseId: "c",
			condition: "B2",
			rep: 1,
			state: emptyState(),
		});
		const lines = [
			call(0, "OLD0"),
			call(1, "OLD1"),
			fin(),
			call(0, "NEW0"),
			fin(),
		];
		const text = formatTrace(lines, { caseId: "c" }, { prompt: true });
		expect(text).toContain("NEW0");
		expect(text).not.toContain("OLD0");
		expect(text).not.toContain("OLD1");
		expect(text.match(/=== r c B2 rep1 ===/g)).toHaveLength(1);
		// a run with no final yet (aborted) followed by a new one
		const aborted = [call(0, "A0"), call(1, "A1"), call(0, "B0")];
		const t2 = formatTrace(aborted, { caseId: "c" }, { prompt: true });
		expect(t2).toContain("B0");
		expect(t2).not.toContain("A1");
	});
});

describe("score command: calibration marker", () => {
	test("judge-agreement.md next to the run flips the note", () => {
		const root = tmp();
		mkdirSync(join(root, "r1"), { recursive: true });
		writeFileSync(join(root, "r1", "runs.jsonl"), `${JSON.stringify(run())}\n`);
		const j: Judgment = {
			runName: "r",
			caseId: "causal-01",
			condition: "B1",
			rep: 1,
			opportunityId: "s4",
			criterion: "c",
			verdict: "pass",
			reason: "r",
			model: "m",
			judgeDigest: "d",
		};
		writeFileSync(
			join(root, "r1", "judgments.jsonl"),
			`${JSON.stringify(j)}\n`,
		);
		const out = scoreCommand("r1", root, undefined, fixtures);
		expect(readFileSync(out, "utf8")).toContain("判定器は未較正");
		// a file without the parseable header does not count
		writeFileSync(join(root, "r1", "judge-agreement.md"), "x");
		scoreCommand("r1", root, undefined, fixtures);
		expect(readFileSync(out, "utf8")).toContain("判定器は未較正");
		writeFileSync(
			join(root, "r1", "judge-agreement.md"),
			`${agreementHeader({ digest: "d", n: 25, kappa: 0.5 })}\n# x\n`,
		);
		scoreCommand("r1", root, undefined, fixtures);
		expect(readFileSync(out, "utf8")).toContain("判定器は較正済み");
		expect(existsSync(join(root, "r1", "judge-agreement.md"))).toBe(true);
	});
});

describe("H6 follow-up: agent output failures are scored, not excluded", () => {
	const needed = opp().expect;
	const notNeeded = {
		...(needed as NonNullable<typeof needed>),
		needed: false,
	};
	const failed = (
		source: string,
		reason: string,
		expectOver = needed,
		rejectCodes: string[] = [],
	) =>
		opp({
			action: "wait",
			source,
			reason,
			expect: expectOver,
			rejectCodes,
			stateCheck: null,
		});

	test("source error from an agent output failure is FN / TN", () => {
		for (const reason of [
			"select_failed:llm:schema",
			"select_failed:llm:refusal",
			"select_failed:llm:max_tokens",
			"update_failed:llm:parse",
		]) {
			expect(classify(failed("error", reason)).bucket).toBe("FN");
			expect(classify(failed("error", reason, notNeeded)).bucket).toBe("TN");
		}
		expect(
			classify(failed("rejected", "update_failed:rejected:evidence", needed))
				.bucket,
		).toBe("FN");
		expect(
			classify(failed("rejected", "r", notNeeded, ["bad_evidence"])).bucket,
		).toBe("TN");
	});
	test("source error from infra stays excluded; unknown reason is infra", () => {
		for (const reason of [
			"select_failed:llm_call:timeout",
			"select_failed:error:boom",
			"update_failed:aborted",
			"r",
		])
			expect(classify(failed("error", reason))).toEqual({
				bucket: "excluded",
				failures: ["infra"],
			});
		// an infra call during a decision that ended in an output failure is still infra
		expect(
			classify(
				failed("error", "select_failed:llm:schema", needed, [
					"call:llm_call:x",
				]),
			).bucket,
		).toBe("excluded");
	});
	test("the failure type stays in the failure table (from the failed call)", () => {
		const call = (code: string) => ({
			purpose: "select" as const,
			at: 0,
			code,
			model: "m",
			inputTokens: 0,
			outputTokens: 0,
			latencyMs: 0,
			rejectCodes: [],
		});
		const md = summarize([
			run({
				opportunities: [failed("error", "select_failed:llm:schema")],
				calls: [call("llm:schema")],
			}),
		]);
		expect(md).toContain("| schema | 1 |");
		expect(md).toContain("| missed | 1 |");
		expect(md).toContain("| infra | 0 |");
	});
	test("consecutive agent-failure runs do not halt; consecutive infra runs do", async () => {
		const agentFail = await replayCase(
			causal01(),
			"B2",
			1,
			() =>
				new StubRuntime({
					decisions: {},
					background: [outcome("llm:schema"), outcome("rejected:x")],
				}),
			{
				runName: "r",
				settingsDigest: "d",
				instructionVersion: "v",
				spent: () => 0,
			},
		);
		expect(agentFail.incomplete).toBe(false);
		let consecutive = 0;
		for (let i = 0; i < 3; i++) {
			const v = evaluateStop(agentFail, consecutive);
			expect(v.stop).toBeNull();
			consecutive = v.consecutive;
		}
		const infraRec = run({
			incomplete: true,
			calls: [
				{
					purpose: "update",
					at: 0,
					code: "llm_call:x",
					model: null,
					inputTokens: 0,
					outputTokens: 0,
					latencyMs: 0,
					rejectCodes: [],
				},
			],
		});
		const first = evaluateStop(infraRec, 0);
		expect(first.stop).toBeNull();
		expect(evaluateStop(infraRec, first.consecutive).stop?.code).toBe(3);
	});
});

describe("review 3: unverified hashes, halts, calibration, negation scope", () => {
	test("labelStatus is outside the hash; label content is inside", () => {
		const c = causal01();
		const confirmed: Case = { ...c, labelStatus: "confirmed" };
		expect(caseHash(confirmed)).toBe(caseHash({ ...c, labelStatus: "draft" }));
		const steps = c.steps.map((st) =>
			st.type === "opportunity" && st.expect
				? { ...st, expect: { ...st.expect, note: `${st.expect.note}!` } }
				: st,
		);
		expect(caseHash({ ...c, steps })).not.toBe(caseHash(c));
	});

	test("judge, judge-export, agreement, judge-agreement refuse unverified input", async () => {
		const root = tmp();
		const dir = join(root, "r1");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "runs.jsonl"), `${JSON.stringify(run())}\n`);
		const llm: LlmPort = {
			async complete() {
				throw new Error("must not be called");
			},
		};
		const role = { model: "m", effort: "high" };
		await expect(
			judgeCommand("r1", { llm, role, root, casesRoot: fixtures }),
		).rejects.toThrow(/--allow-unverified/);
		expect(() =>
			judgeExportCommand({
				name: "r1",
				n: 1,
				out: join(root, "o.md"),
				root,
				casesRoot: fixtures,
			}),
		).toThrow(/--allow-unverified/);
		// with the flag the hash check passes (judge then has nothing to do: no criteria rows)
		const text = await judgeCommand("r1", {
			llm,
			role,
			root,
			casesRoot: fixtures,
			allowUnverified: true,
		});
		expect(text).toContain("--allow-unverified");
		// keys without caseHashes
		const c = causal01();
		const labelKey: LabelKey = {
			kind: "label",
			suite: "p1e",
			split: "dev",
			seed: "s",
			items: [{ item: 1, caseId: "causal-01", opportunityId: "s4" }],
		};
		const answers = parseLabelSheet("## 項目 1\n\n回答: speak\n");
		expect(() => labelAgreement(answers, labelKey, [c])).toThrow(
			/--allow-unverified/,
		);
		expect(labelAgreement(answers, labelKey, [c], true).answered).toBe(1);
		const sheet = join(root, "j.md");
		const judgeKey: JudgeKey = {
			kind: "judge",
			run: "r1",
			seed: "s",
			model: "m",
			items: [],
		};
		writeFileSync(sheet, "");
		writeFileSync(`${sheet}.key.json`, JSON.stringify(judgeKey));
		expect(() =>
			judgeAgreementCommand(sheet, { root, casesRoot: fixtures }),
		).toThrow(/--allow-unverified/);
		expect(
			judgeAgreementCommand(sheet, {
				root,
				casesRoot: fixtures,
				allowUnverified: true,
			}),
		).toContain("回答あり");
	});

	test("score warns about records without a hash and about changed cases", () => {
		const root = tmp();
		const write = (name: string, rec: RunRecord) => {
			mkdirSync(join(root, name), { recursive: true });
			writeFileSync(join(root, name, "runs.jsonl"), `${JSON.stringify(rec)}\n`);
			return readFileSync(
				scoreCommand(name, root, undefined, fixtures),
				"utf8",
			);
		};
		expect(write("a", run())).toContain("1 件の記録に caseHash がない");
		expect(write("b", run({ caseHash: "deadbeef" }))).toContain(
			"記録後にケースが変更されている: causal-01",
		);
		expect(write("c", run({ caseHash: caseHash(causal01()) }))).not.toContain(
			"警告: 1 件",
		);
		expect(write("d", run({ caseId: "gone-01", caseHash: "x" }))).toContain(
			"現行のケースにない id の記録: gone-01",
		);
	});

	test("run halts after 3 consecutive all-llm:* runs, with its own message", () => {
		const call = (code: string) => ({
			purpose: "update" as const,
			at: 0,
			code,
			model: "m",
			inputTokens: 0,
			outputTokens: 0,
			latencyMs: 0,
			rejectCodes: [],
		});
		const bad = run({ condition: "B2", calls: [call("llm:schema")] });
		expect(allCallsOutputFailures(bad)).toBe(true);
		expect(allCallsOutputFailures({ ...bad, condition: "B0" })).toBe(false);
		expect(
			allCallsOutputFailures(
				run({ calls: [call("llm:schema"), call("applied")] }),
			),
		).toBe(false);
		expect(allCallsOutputFailures(run({ calls: [call("rejected:x")] }))).toBe(
			false,
		);
		let n = 0;
		for (let i = 1; i <= 2; i++) {
			const v = evaluateStop(bad, 0, n);
			expect(v.stop).toBeNull();
			n = v.outputFailures;
		}
		const third = evaluateStop(bad, 0, n);
		expect(third.stop?.code).toBe(3);
		expect(third.stop?.message).toContain("agent output failure");
		expect(third.stop?.message).not.toContain("consecutive incomplete");
		// a good run resets the streak
		expect(evaluateStop(run(), 0, 2).outputFailures).toBe(0);
		// scoring is unchanged: the run is not incomplete
		expect(bad.incomplete).toBe(false);
	});

	test("an aborted call marks the opportunity like an infra call", async () => {
		class AbortingRuntime extends StubRuntime {
			override async decide(op: { id: string; at: number }) {
				const base = await super.decide(op);
				return { ...base, calls: [outcome("aborted", "select")] };
			}
		}
		const rec = await replayCase(
			causal01(),
			"B1",
			1,
			() => new AbortingRuntime({ decisions: {} }),
			{
				runName: "r",
				settingsDigest: "d",
				instructionVersion: "v",
				spent: () => 0,
			},
		);
		expect(rec.opportunities[0]?.rejectCodes).toContain("call:aborted");
		expect(classify(rec.opportunities[0] as OpportunityRecord).bucket).toBe(
			"excluded",
		);
	});

	test("negation counts only when attached to the action word", () => {
		for (const t of [
			"話しません",
			"話さず待つ",
			"声をかけない",
			"ツールは使わない",
			"待機しない",
			"話すべきではない",
			"待つ必要はない",
			"don't wait",
			"Do not speak",
		])
			expect(() => parseAnswerAction(t)).toThrow(/否定形/);
		expect(parseAnswerAction("待つ 邪魔にならないように")).toBe("wait");
		expect(parseAnswerAction("待機。邪魔しないため")).toBe("wait");
		expect(parseAnswerAction("話しかける 待たせたくないので")).toBe("speak");
		expect(parseAnswerAction("ツールを使う 手間はかからない")).toBe("tool");
		expect(parseAnswerAction("wait: don't speak yet")).toBe("wait");
		expect(parseAnswerAction("not sure")).toBeNull();
		expect(parseAnswerAction("何もしない。話さない方が良い")).toBe("wait");
	});
});
