import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadAllSuiteCases, loadSuiteCases } from "../cases.ts";
import type {
	Case,
	Judgment,
	OpportunityRecord,
	RunRecord,
	StateJudgment,
} from "../contracts.ts";
import {
	createDiagnosticRuntime,
	presentMap,
	selectDiagnosticObservations,
} from "../diagnostic.ts";
import {
	appendJudgments,
	judgeSystemPrompt,
	pendingJudgeTasks,
	readJudgments,
	runJudge,
} from "../judge.ts";
import {
	agreementCommand,
	judgeAgreementCommand,
	judgeCommand,
	judgeExportCommand,
	labelExportCommand,
	parseSuite,
	scoreCommand,
	validateCommand,
} from "../main.ts";
import { replayCase } from "../replay.ts";
import { summarize } from "../score.ts";
import {
	computeStateCheck,
	createSelectProbe,
	openEvidence,
} from "../state-check.ts";
import { emptyState, type AgencyState } from "../../src/contracts/model.ts";
import type { LlmPort, LlmRequest } from "../../src/contracts/ports.ts";
import type { Decision } from "../../src/contracts/runtime.ts";
import { decision, StubRuntime, ticketFor } from "./fixtures.ts";

const role = { model: "m", effort: "high" };

const fixtures = resolve(import.meta.dir, "fixtures");
const tmp = () => mkdtempSync(join(tmpdir(), "p1e-"));
const signal = () => new AbortController().signal;

const dev = () => loadSuiteCases("p1e", "dev", fixtures);
const byId = (id: string): Case => {
	const c = dev().find((x) => x.id === id);
	if (!c) throw new Error(`no fixture ${id}`);
	return c;
};

const pass = (over: Record<string, unknown> = {}) => ({
	action: "wait",
	candidateRef: null,
	utterance: null,
	toolName: null,
	toolInput: null,
	evidenceRefs: [],
	valueNow: "v",
	userBurden: "b",
	lossIfWait: "l",
	conflicts: null,
	reason: "r",
	...over,
});

/** Fake LlmPort: answers each call from `answer`, recording every request. */
const fakeLlm = (answer: (r: LlmRequest<unknown>, n: number) => unknown) => {
	const requests: LlmRequest<unknown>[] = [];
	const llm: LlmPort = {
		async complete<T>(request: LlmRequest<T>) {
			requests.push(request as LlmRequest<unknown>);
			const value = answer(request as LlmRequest<unknown>, requests.length);
			return {
				value: request.schema.parse(value),
				model: "fake",
				inputTokens: 10,
				outputTokens: 5,
				cacheReadTokens: 0,
				latencyMs: 1,
			};
		},
	};
	return { llm, requests };
};

describe("state check", () => {
	const state = (): AgencyState => {
		const s = emptyState();
		s.notes.push({ id: "n1", revision: 1, text: "t", evidence: ["s1"] });
		s.intents.push(
			{
				id: "i1",
				state: "adopted",
				evidence: ["s1"],
			} as AgencyState["intents"][number],
			{
				id: "i2",
				state: "completed",
				evidence: ["s2"],
			} as AgencyState["intents"][number],
		);
		s.candidates.push(
			{
				id: "c1",
				state: "pending",
				evidence: ["s3"],
			} as AgencyState["candidates"][number],
			{
				id: "c2",
				state: "closed",
				evidence: ["s4"],
			} as AgencyState["candidates"][number],
		);
		return s;
	};
	const want = {
		mustHold: [["s1", "s9"], ["s2"], ["s3"]],
		mustNotHold: ["s2", "s4", "s1"],
	};

	test("B1 counts notes only", () => {
		expect(openEvidence("B1", state())).toEqual([["s1"]]);
		expect(computeStateCheck("B1", state(), want)).toEqual({
			mustHold: [true, false, false],
			violations: ["s1"],
		});
	});
	test("B2/F count open intents and open candidates, not closed ones", () => {
		for (const c of ["B2", "F"] as const)
			expect(computeStateCheck(c, state(), want)).toEqual({
				mustHold: [true, false, true],
				violations: ["s1"],
			});
	});
	test("null without stateExpect or for B0", () => {
		expect(computeStateCheck("B2", state(), null)).toBeNull();
		expect(computeStateCheck("B0", state(), want)).toBeNull();
	});

	test("replay checks the state seen at select time, before the decision is applied", async () => {
		const c = byId("causal-01");
		const probe = createSelectProbe();
		const live = emptyState();
		live.notes.push({ id: "n1", revision: 1, text: "t", evidence: ["s1"] });
		const passthrough = {
			complete: async () => ({
				value: {},
				model: "fake",
				inputTokens: 0,
				outputTokens: 0,
				cacheReadTokens: 0,
				latencyMs: 0,
			}),
		} as unknown as LlmPort;
		const wrapped = probe.wrap(passthrough);
		// Fake runtime: calls select through the probed port, then the decision removes the note.
		class Rt extends StubRuntime {
			override async decide(op: { id: string; at: number }) {
				await wrapped.complete(
					{
						purpose: "select",
						system: "",
						prompt: "",
						schema: { parse: (x: unknown) => x } as never,
						maxOutputTokens: 1,
					},
					signal(),
				);
				live.notes.length = 0;
				return super.decide(op);
			}
			override snapshot() {
				return { ...super.snapshot(), state: structuredClone(live) };
			}
		}
		const rec = await replayCase(c, "B1", 1, () => new Rt({ decisions: {} }), {
			runName: "t",
			settingsDigest: "d",
			instructionVersion: "v",
			spent: () => 0,
			probe,
		});
		const s4 = rec.opportunities.find((o) => o.opportunityId === "s4");
		expect(s4?.stateCheck).toEqual({ mustHold: [true], violations: [] });
		// Without the probe the post-decision state (note removed) would be used.
		const rec2 = await replayCase(
			c,
			"B1",
			1,
			() => {
				live.notes.push({ id: "n1", revision: 1, text: "t", evidence: ["s1"] });
				return new Rt({ decisions: {} });
			},
			{
				runName: "t",
				settingsDigest: "d",
				instructionVersion: "v",
				spent: () => 0,
			},
		);
		expect(rec2.opportunities[0]?.stateCheck).toEqual({
			mustHold: [false],
			violations: [],
		});
		expect(rec.suite).toBe("p1e");
	});

	test("D and B0 records carry no stateCheck", async () => {
		const c = byId("causal-01");
		for (const cond of ["D", "B0"] as const) {
			const rec = await replayCase(
				c,
				cond,
				1,
				() => new StubRuntime({ decisions: {} }),
				{
					runName: "t",
					settingsDigest: "d",
					instructionVersion: "v",
					spent: () => 0,
				},
			);
			expect(rec.condition).toBe(cond);
			expect(rec.opportunities.every((o) => o.stateCheck === null)).toBe(true);
		}
	});
});

describe("condition D", () => {
	const longCase = (): Case => {
		const c = byId("causal-01");
		return c;
	};

	test("selectDiagnosticObservations: present + last 4, deduplicated, chronological", () => {
		const all = Array.from({ length: 8 }, (_, i) => ({
			id: `s${i + 1}`,
			seq: i + 1,
			kind: "user.report" as const,
			actor: "user" as const,
			occurredAt: i,
			text: `t${i + 1}`,
		}));
		const ids = selectDiagnosticObservations(all, ["s2", "s7", "s1"]).map(
			(o) => o.id,
		);
		expect(ids).toEqual(["s1", "s2", "s5", "s6", "s7", "s8"]);
		expect(selectDiagnosticObservations(all.slice(0, 2), [])).toHaveLength(2);
	});

	test("prompt shows only present + recent observations and never any label", async () => {
		const c = longCase();
		const { llm, requests } = fakeLlm(() => pass());
		const rt = createDiagnosticRuntime({
			llm,
			tools: c.tools,
			present: presentMap(c),
		});
		const rec = await replayCase(c, "D", 1, () => rt, {
			runName: "t",
			settingsDigest: "d",
			instructionVersion: "v",
			spent: () => 0,
		});
		// No background update calls, one select per opportunity.
		expect(requests.every((r) => r.purpose === "select")).toBe(true);
		expect(requests).toHaveLength(2);
		expect(rec.calls.every((x) => x.purpose === "select")).toBe(true);
		const text = requests.map((r) => `${r.system}\n${r.prompt}`).join("\n");
		const labels = JSON.stringify(
			c.steps.flatMap((s) =>
				s.type === "opportunity"
					? [
							s.expect?.note,
							s.expect?.failureIfOutward,
							...s.judge,
							s.stateExpect ? "mustHold" : null,
						]
					: [],
			),
		);
		for (const secret of JSON.parse(labels) as (string | null)[])
			if (secret) expect(text).not.toContain(secret);
		expect(text).not.toContain("mustNotHold");
		expect(text).not.toContain("evidenceAny");
		expect(text).not.toContain(c.description);
		// First opportunity: present s1 plus observations before it.
		expect(requests[0]?.prompt).toContain("[s1]");
		expect(requests[0]?.prompt).toContain("[s3]");
		expect(requests[0]?.system).toContain("参加判断");
		expect(rec.condition).toBe("D");
		expect(rec.opportunities.every((o) => o.stateCheck === null)).toBe(true);
	});

	test("outward action goes through the ticket/receipt path and validation", async () => {
		const c = longCase();
		const { llm } = fakeLlm((_r, n) =>
			n === 1
				? pass({
						action: "speak",
						utterance: "取り込みの件、原因の調査はどうなりましたか。",
						evidenceRefs: ["s1"],
					})
				: pass({ action: "speak", utterance: "x", evidenceRefs: ["s99"] }),
		);
		const rec = await replayCase(
			c,
			"D",
			1,
			(tools) =>
				createDiagnosticRuntime({ llm, tools, present: presentMap(c) }),
			{
				runName: "t",
				settingsDigest: "d",
				instructionVersion: "v",
				spent: () => 0,
			},
		);
		const [first, second] = rec.opportunities;
		expect(first?.action).toBe("speak");
		expect(first?.source).toBe("llm");
		expect(first?.evidenceRefs).toEqual(["s1"]);
		// An unknown ref is rejected by the shared validation, so no outward action.
		expect(second?.action).toBe("wait");
		expect(second?.rejectCodes).toContain("unknown_ref");
		expect(rec.safety).toEqual([]);
	});

	test("blocked moments never call the model", async () => {
		const { llm, requests } = fakeLlm(() => pass());
		const rt = createDiagnosticRuntime({ llm, tools: [], present: new Map() });
		const out = await rt.decide(
			{
				id: "s4",
				at: 0,
				trigger: "idle",
				presence: "speaking",
				foregroundBusy: false,
				playerBusy: false,
			},
			signal(),
		);
		expect(out.decision.source).toBe("host_blocked");
		expect(requests).toHaveLength(0);
	});
});

describe("suite loading", () => {
	test("loads p1e dev/unseen from a root and checks the suite", () => {
		expect(dev().map((c) => c.id)).toEqual([
			"causal-01",
			"concurrent-01",
			"premise-01",
		]);
		expect(loadAllSuiteCases("p1e", fixtures)).toHaveLength(4);
		const root = tmp();
		mkdirSync(join(root, "p1e", "dev"), { recursive: true });
		const c = byId("causal-01");
		writeFileSync(
			join(root, "p1e", "dev", "x.json"),
			JSON.stringify({ ...c, suite: "p0e" }),
		);
		expect(() => loadSuiteCases("p1e", "dev", root)).toThrow(/suite/);
		expect(loadAllSuiteCases("p1e", join(root, "none"))).toEqual([]);
	});
	test("a p1e opportunity with expect needs stateExpect and present", () => {
		const root = tmp();
		mkdirSync(join(root, "p1e", "dev"), { recursive: true });
		const c = JSON.parse(
			readFileSync(join(fixtures, "p1e", "dev", "causal-01.json"), "utf8"),
		);
		c.steps[3].stateExpect = null;
		writeFileSync(join(root, "p1e", "dev", "x.json"), JSON.stringify(c));
		expect(() => loadSuiteCases("p1e", "dev", root)).toThrow(
			/needs stateExpect/,
		);
	});
	test("validateCommand lists the suite's groups", () => {
		const out = validateCommand("dev", fixtures, "p1e");
		expect(out).toContain("p1e dev: 3 cases");
		expect(out).toContain("causal     cases=1");
		expect(out).toContain("withStateExpect=");
		expect(out).not.toContain("resume");
		expect(() => parseSuite("p9e")).toThrow();
		expect(parseSuite("p1e")).toBe("p1e");
	});
});

const oppRec = (over: Partial<OpportunityRecord> = {}): OpportunityRecord => ({
	opportunityId: "s4",
	expect: {
		needed: true,
		accept: ["speak", "tool"],
		evidenceAny: ["s1"],
		failureIfOutward: "unnecessary",
		note: "n",
	},
	action: "speak",
	source: "llm",
	utterance: "取り込みの件はどうなりましたか。",
	toolName: null,
	evidenceRefs: ["s1"],
	reason: "r",
	rejectCodes: [],
	agentAuthoredRefs: [],
	stateCheck: { mustHold: [true], violations: [] },
	stateItems: null,
	stateExcluded: null,
	...over,
});
const runRec = (over: Partial<RunRecord> = {}): RunRecord => ({
	runName: "p1e-t",
	caseId: "causal-01",
	suite: "p1e",
	group: "causal",
	condition: "B1",
	rep: 1,
	labelStatus: "draft",
	settingsDigest: "d",
	instructionVersion: "v",
	opportunities: [oppRec()],
	calls: [],
	usd: 0.01,
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
	...over,
});

describe("score p1e", () => {
	const records: RunRecord[] = [
		runRec(),
		runRec({
			condition: "B2",
			opportunities: [
				oppRec({ stateCheck: { mustHold: [false, true], violations: ["s2"] } }),
			],
		}),
		runRec({
			condition: "D",
			opportunities: [oppRec({ stateCheck: null })],
		}),
	];
	const judgments: Judgment[] = [
		{
			runName: "p1e-t",
			caseId: "causal-01",
			condition: "B1",
			rep: 1,
			opportunityId: "s4",
			criterion: "完了したと偽っていない",
			verdict: "pass",
			reason: "r",
			model: "m",
			judgeDigest: "dg",
		},
		{
			runName: "p1e-t",
			caseId: "causal-01",
			condition: "D",
			rep: 1,
			opportunityId: "s4",
			criterion: "完了したと偽っていない",
			verdict: "fail",
			reason: "r",
			model: "m",
			judgeDigest: "dg",
		},
	];

	test("p1e sections: group x condition, state trajectory, D as diagnostic", () => {
		const md = summarize(records, judgments);
		expect(md).toContain("# P1-E 結果サマリー");
		expect(md).toContain("## 群 × 条件の行動（P1-E）");
		expect(md).toContain("## 状態の軌跡（P1-E）");
		expect(md).toContain(
			"| causal | B1 | 1 | 1/1 (100%) | 1/1 (100%) | 0/0/0 |",
		);
		expect(md).toContain("| causal | B2 | 1 | 1/2 (50%) | 0/1 (0%) | 0/0/0 |");
		// The id-based violation counts are gone from the summary.
		expect(md).not.toContain("違反");
		expect(md).toContain("D（診断）");
		expect(md).toContain("B1 と B2 の比較には含めない");
		// D has no state-check row.
		expect(md).not.toMatch(/\| causal \| D（診断） \| \d+ \| [\d/]+ \(/);
		expect(md).toContain("## 内容の判定（判定器、条件別）");
		// 全体 excludes D, which is shown on its own.
		expect(md).toContain("| 基準 | B1 | 全体（D除く） | D（診断） |");
		expect(md).toContain("| 完了したと偽っていない | 1/0/0 | 1/0/0 | 0/1/0 |");
	});
	test("excluded opportunities are counted apart from the denominators", () => {
		const md = summarize([
			runRec({
				opportunities: [
					oppRec({ stateCheck: null, stateExcluded: "blocked" }),
					oppRec({ stateCheck: null, stateExcluded: "empty" }),
					oppRec({ stateCheck: null, stateExcluded: "infra" }),
					oppRec({ stateCheck: null, stateExcluded: "infra" }),
					oppRec(),
				],
			}),
		]);
		expect(md).toContain(
			"| causal | B1 | 1 | 1/1 (100%) | 1/1 (100%) | 1/1/2 |",
		);
	});
	test("let-go rates come from state judgments of live runs only", () => {
		const sj = (
			over: Partial<StateJudgment> & { verdict: StateJudgment["verdict"] },
		): StateJudgment => ({
			runName: "p1e-t",
			caseId: "causal-01",
			condition: "B1",
			rep: 1,
			opportunityId: "s4",
			step: "s2",
			reason: "r",
			model: "m",
			judgeDigest: "sd",
			...over,
		});
		const md = summarize(
			[
				runRec(),
				runRec({ condition: "B2" }),
				runRec({ rep: 2, incomplete: true }),
			],
			[],
			[
				sj({ verdict: "handled" }),
				sj({ verdict: "absent", step: "s3" }),
				sj({ verdict: "still_active", step: "s5" }),
				sj({ verdict: "unclear", step: "s6" }),
				sj({ verdict: "still_active", condition: "B2" }),
				// belongs to the incomplete rep 2: ignored
				sj({ verdict: "still_active", rep: 2 }),
				// D is never summarized as a state condition
				sj({ verdict: "handled", condition: "D" }),
			],
		);
		expect(md).toContain("### 手放し（mustNotHold、判定器）");
		expect(md).toContain("| causal | B1 | 4 | 1 | 1 | 1 | 1 | 2/3 (67%) |");
		expect(md).toContain("| causal | B2 | 1 | 0 | 0 | 1 | 0 | 0/1 (0%) |");
		expect(md).not.toContain("| causal | D");
	});
	test("judgments of incomplete or replaced runs are not summarized", () => {
		const j = (rep: number): Judgment => ({
			runName: "p1e-t",
			caseId: "causal-01",
			condition: "B1",
			rep,
			opportunityId: "s4",
			criterion: "基準X",
			verdict: "pass",
			reason: "r",
			model: "m",
			judgeDigest: "dg",
		});
		const md = summarize(
			[runRec(), runRec({ rep: 2, incomplete: true })],
			[j(1), j(2)],
		);
		expect(md).toContain("| 基準X | 1/0/0 | 1/0/0 |");
	});
	test("p0e records keep the old structure", () => {
		const md = summarize([
			runRec({
				suite: "p0e",
				group: "resume",
				opportunities: [oppRec({ stateCheck: null })],
			}),
		]);
		expect(md).toContain("# P0-E 結果サマリー");
		expect(md).not.toContain("P1-E");
		expect(md).not.toContain("内容の判定");
	});
	test("scoreCommand reads judgments.jsonl and checks --suite", () => {
		const root = tmp();
		mkdirSync(join(root, "r"));
		writeFileSync(
			join(root, "r", "runs.jsonl"),
			`${records.map((r) => JSON.stringify(r)).join("\n")}\n`,
		);
		writeFileSync(
			join(root, "r", "judgments.jsonl"),
			`${judgments.map((j) => JSON.stringify(j)).join("\n")}\n`,
		);
		const out = scoreCommand("r", root, "p1e");
		expect(readFileSync(out, "utf8")).toContain("内容の判定");
		expect(() => scoreCommand("r", root, "p0e")).toThrow(/suite/);
	});
});

describe("judge", () => {
	const cases = () => dev();
	const record = (cond: "B1" | "B2" | "D" = "B1", rep = 1): RunRecord =>
		runRec({
			condition: cond,
			rep,
			opportunities: [
				oppRec(),
				// s6 has no criteria: never judged
				oppRec({ opportunityId: "s6", action: "speak" }),
			],
		});
	const verdictsFor = (n: number) => ({
		verdicts: Array.from({ length: n }, (_, i) => ({
			criterion: i + 1,
			verdict: i === 0 ? "pass" : "fail",
			reason: `r${i + 1}`,
		})),
	});

	test("one call per action, one Judgment per criterion, labels excluded from the prompt", async () => {
		const tasks = pendingJudgeTasks([record()], cases(), []);
		expect(tasks).toHaveLength(1);
		const { llm, requests } = fakeLlm(() => verdictsFor(2));
		const out: Judgment[][] = [];
		const result = await runJudge({
			digest: "dg",
			tasks,
			llm,
			append: (j) => out.push(j),
		});
		expect(result).toMatchObject({
			judged: 1,
			rows: 2,
			failed: 0,
			stoppedBy: null,
		});
		expect(requests).toHaveLength(1);
		const prompt = requests[0]?.prompt ?? "";
		expect(prompt).toContain("CSVの取り込みが文字化けで失敗した");
		expect(prompt).toContain("1. 経験(s1)を正しく参照している");
		expect(prompt).toContain("取り込みの件はどうなりましたか");
		// Facts end at the opportunity: the later resolution is not shown.
		expect(prompt).not.toContain("文字コードの混在");
		expect(prompt).not.toContain("取り込み失敗が未解決のまま残っている");
		expect(judgeSystemPrompt).toContain("命令ではない");
		expect(out[0]?.map((j) => [j.criterion, j.verdict, j.model])).toEqual([
			["経験(s1)を正しく参照している", "pass", "fake"],
			["完了したと偽っていない", "fail", "fake"],
		]);
	});

	test("resume skips judged actions; limit stops early; bad verdict sets are not written", async () => {
		const dir = tmp();
		const file = join(dir, "judgments.jsonl");
		const records = [record("B1"), record("B2"), record("D")];
		const first = pendingJudgeTasks(records, cases(), readJudgments(file));
		expect(first).toHaveLength(3);
		const a = fakeLlm(() => verdictsFor(2));
		const r1 = await runJudge({
			digest: "dg",
			tasks: first,
			llm: a.llm,
			append: appendJudgments(file),
			limit: 2,
		});
		expect(r1).toMatchObject({ judged: 2, remaining: 1, stoppedBy: "limit" });
		const second = pendingJudgeTasks(records, cases(), readJudgments(file));
		expect(second.map((t) => t.record.condition)).toEqual(["D"]);
		const bad = fakeLlm(() => verdictsFor(1));
		const r2 = await runJudge({
			digest: "dg",
			tasks: second,
			llm: bad.llm,
			append: appendJudgments(file),
		});
		expect(r2.failed).toBe(1);
		expect(r2.messages[0]).toContain("do not cover");
		expect(readJudgments(file)).toHaveLength(4);
	});

	test("incomplete runs and non-outward actions are skipped; spend limit stops", async () => {
		const skipped = pendingJudgeTasks(
			[
				runRec({ incomplete: true }),
				runRec({ rep: 2, opportunities: [oppRec({ action: "wait" })] }),
			],
			cases(),
			[],
		);
		expect(skipped).toHaveLength(0);
		const { LlmCallError } = await import("../../src/contracts/errors.ts");
		const llm: LlmPort = {
			complete: async () => {
				throw new LlmCallError("spend_limit", false);
			},
		};
		const tasks = pendingJudgeTasks([record("B1"), record("B2")], cases(), []);
		const r = await runJudge({ digest: "dg", tasks, llm, append: () => {} });
		expect(r).toMatchObject({ judged: 0, stoppedBy: "spend_limit" });
	});

	test("judgeCommand end to end with a fake port", async () => {
		const root = tmp();
		mkdirSync(join(root, "p1e-t"));
		writeFileSync(
			join(root, "p1e-t", "runs.jsonl"),
			`${JSON.stringify(record())}\n`,
		);
		const { llm } = fakeLlm(() => verdictsFor(2));
		const text = await judgeCommand("p1e-t", {
			llm,
			role,
			root,
			casesRoot: fixtures,
		});
		expect(text).toContain("content 1 pending actions, judged 1 (2 criteria)");
		expect(text).toContain("state: 0 pending");
		expect(readJudgments(join(root, "p1e-t", "judgments.jsonl"))).toHaveLength(
			2,
		);
		const again = await judgeCommand("p1e-t", {
			llm,
			role,
			root,
			casesRoot: fixtures,
		});
		expect(again).toContain("0 pending");
	});
});

describe("label export and agreement", () => {
	const exportTo = (dir: string, name: string, n: number, seed?: string) =>
		labelExportCommand({
			suite: "p1e",
			split: "dev",
			n,
			out: join(dir, name),
			casesRoot: fixtures,
			...(seed === undefined ? {} : { seed }),
		});

	test("deterministic, blind, stratified", () => {
		const dir = tmp();
		exportTo(dir, "a.md", 4);
		exportTo(dir, "b.md", 4);
		const a = readFileSync(join(dir, "a.md"), "utf8");
		expect(a).toBe(readFileSync(join(dir, "b.md"), "utf8"));
		expect(readFileSync(join(dir, "a.md.key.json"), "utf8")).toBe(
			readFileSync(join(dir, "b.md.key.json"), "utf8"),
		);
		// Nothing of the labels or case identity is in the sheet.
		for (const leak of [
			"取り込み失敗が未解決のまま残っている",
			"B案は断られた",
			"枠の変更で構成の前提が変わった",
			"causal-01",
			"premise",
			"concurrent",
			"mustHold",
			"accept",
			"fixture",
		])
			expect(a).not.toContain(leak);
		const key = JSON.parse(readFileSync(join(dir, "a.md.key.json"), "utf8"));
		// 4 labeled opportunities in total (s4, s6, premise s3, concurrent s4); excluded ones are not offered.
		expect(key.items).toHaveLength(4);
		const needed = key.items.filter(
			(i: { caseId: string; opportunityId: string }) =>
				(i.caseId === "causal-01" && i.opportunityId === "s4") ||
				i.caseId === "premise-01",
		);
		expect(needed).toHaveLength(2);
		// n=2: one needed, one not needed.
		exportTo(dir, "c.md", 2);
		const k2 = JSON.parse(readFileSync(join(dir, "c.md.key.json"), "utf8"));
		const flags = k2.items.map(
			(i: { caseId: string; opportunityId: string }) =>
				(i.caseId === "causal-01" && i.opportunityId === "s4") ||
				i.caseId === "premise-01",
		);
		expect(flags.filter(Boolean)).toHaveLength(1);
		// a different seed may reorder but keeps the same strata
		exportTo(dir, "d.md", 2, "other");
		expect(
			JSON.parse(readFileSync(join(dir, "d.md.key.json"), "utf8")).seed,
		).toBe("other");
	});

	test("agreement parses a filled sheet and lists disagreements", () => {
		const dir = tmp();
		exportTo(dir, "s.md", 4);
		const key = JSON.parse(
			readFileSync(join(dir, "s.md.key.json"), "utf8"),
		) as {
			items: { item: number; caseId: string; opportunityId: string }[];
		};
		let sheet = readFileSync(join(dir, "s.md"), "utf8");
		const answers = new Map<number, string>();
		for (const it of key.items) {
			const neededItem =
				(it.caseId === "causal-01" && it.opportunityId === "s4") ||
				it.caseId === "premise-01";
			// agree everywhere except the concurrent item (answers speak although not needed)
			answers.set(
				it.item,
				it.caseId === "concurrent-01"
					? "speak B案の話をしたい"
					: neededItem
						? "Speak: 未解決だから"
						: "wait 解決済み",
			);
		}
		// skip one item entirely
		const skipItem =
			key.items.find((i) => i.caseId === "premise-01")?.item ?? 0;
		answers.set(skipItem, "skip");
		for (const [item, text] of answers)
			sheet = sheet.replace(
				new RegExp(`(## 項目 ${item}\\n[\\s\\S]*?\\n回答:)`),
				`$1 ${text}`,
			);
		writeFileSync(join(dir, "s.md"), sheet);
		const out = agreementCommand(join(dir, "s.md"), fixtures);
		expect(out).toContain("回答あり: 3/4");
		expect(out).toContain("要否の一致（行動が必要か）: 2/3 (67%)");
		expect(out).toContain("accept 集合の一致");
		expect(out).toContain("concurrent-01/s4");
		expect(out).toContain("[要否が不一致]");
		expect(out).toContain(`未回答・skip: 項目 ${skipItem}`);
	});
});

describe("judge export and agreement", () => {
	test("blind sheet from judged actions, agreement per criterion", () => {
		const root = tmp();
		mkdirSync(join(root, "p1e-t"));
		const recs = [
			runRec(),
			runRec({ condition: "B2" }),
			runRec({ condition: "D" }),
		];
		writeFileSync(
			join(root, "p1e-t", "runs.jsonl"),
			`${recs.map((r) => JSON.stringify(r)).join("\n")}\n`,
		);
		const js: Judgment[] = recs.flatMap((r, i) =>
			["経験(s1)を正しく参照している", "完了したと偽っていない"].map(
				(criterion, k) => ({
					runName: "p1e-t",
					caseId: "causal-01",
					condition: r.condition,
					rep: 1,
					opportunityId: "s4",
					criterion,
					verdict: (k === 0 || i === 0
						? "pass"
						: "fail") as Judgment["verdict"],
					reason: "JUDGE-REASON",
					model: "fake",
					judgeDigest: "dg",
				}),
			),
		);
		writeFileSync(
			join(root, "p1e-t", "judgments.jsonl"),
			`${js.map((j) => JSON.stringify(j)).join("\n")}\n`,
		);
		const out = join(root, "j.md");
		judgeExportCommand({ name: "p1e-t", n: 3, out, root, casesRoot: fixtures });
		const sheet = readFileSync(out, "utf8");
		expect(sheet).not.toContain("JUDGE-REASON");
		expect(sheet).not.toContain("causal-01");
		expect(sheet).toContain("取り込みの件はどうなりましたか");
		expect(sheet).toContain("1. 経験(s1)を正しく参照している");
		expect(sheet).not.toContain("文字コードの混在");
		// Human agrees with the judge on criterion 1 and disagrees on criterion 2 everywhere.
		const filled = sheet
			.replace(/^回答 1:$/gm, "回答 1: pass")
			.replace(/^回答 2:$/gm, "回答 2: unclear 決められない");
		writeFileSync(out, filled);
		const result = judgeAgreementCommand(out);
		expect(result).toContain("判定器との一致: 3/6 (50%)");
		expect(result).toContain("3/3 (100%)  経験(s1)を正しく参照している");
		expect(result).toContain("0/3 (0%)  完了したと偽っていない");
		expect(result).toContain("JUDGE-REASON");
	});
});

describe("decision shape", () => {
	test("helpers used above stay in sync with Decision", () => {
		const d: Decision = decision({ opportunityId: "s4" });
		expect(ticketFor("s4", "speak").opportunityId).toBe(d.opportunityId);
	});
});
