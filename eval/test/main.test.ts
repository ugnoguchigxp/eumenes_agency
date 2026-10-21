import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCases } from "../cases.ts";
import {
	assertResumeCompatible,
	doneKeys,
	evaluateStop,
	parseConditions,
	parseRunsJsonl,
	planRuns,
	runKey,
	scoreCommand,
	skipDone,
	validateCommand,
} from "../main.ts";
import { sampleCase } from "./fixtures.ts";
import type { RunRecord } from "../contracts.ts";

const c2 = { ...sampleCase, id: "resume-02" };

describe("planRuns / skipDone", () => {
	test("B0 runs once, others per rep, rotated per case", () => {
		const plan = planRuns([sampleCase, c2], ["B0", "B1", "B2", "F"], 3);
		expect(plan.filter((p) => p.condition === "B0")).toHaveLength(2);
		expect(plan).toHaveLength(2 * (1 + 9));
		const firsts = new Set(plan.map((p) => `${p.case.id}:${p.rep}`));
		expect(firsts.size).toBe(6);
		const firstOf = (id: string, rep: number) =>
			plan.find((p) => p.case.id === id && p.rep === rep)?.condition;
		expect(firstOf("resume-01", 1)).toBe("B0");
		expect(firstOf("resume-02", 1)).toBe("B1");
		expect(firstOf("resume-01", 2)).toBe("B2");
	});
	test("resume skips done keys only", () => {
		const plan = planRuns([sampleCase], ["B1", "B2"], 2);
		const done = new Set([
			runKey("resume-01", "B1", 1),
			runKey("resume-01", "B2", 2),
		]);
		const rest = skipDone(plan, done);
		expect(rest.map((p) => `${p.condition}${p.rep}`).sort()).toEqual(
			["B1" + 2, "B2" + 1].sort(),
		);
	});
});

describe("jsonl and commands", () => {
	const rec: RunRecord = {
		runName: "t",
		caseId: "resume-01",
		suite: "p0e",
		group: "resume",
		condition: "B1",
		rep: 1,
		labelStatus: "confirmed",
		settingsDigest: "d",
		instructionVersion: "v",
		opportunities: [],
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
		incomplete: false,
		error: null,
	};
	test("parseRunsJsonl validates", () => {
		expect(parseRunsJsonl(`${JSON.stringify(rec)}\n\n`)).toHaveLength(1);
		expect(() => parseRunsJsonl("{}\n", "f")).toThrow(/f:1/);
		expect(() => parseRunsJsonl("nope", "f")).toThrow(/invalid JSON/);
	});
	test("scoreCommand writes summary.md", () => {
		const root = mkdtempSync(join(tmpdir(), "p0e-"));
		mkdirSync(join(root, "t"));
		writeFileSync(join(root, "t", "runs.jsonl"), `${JSON.stringify(rec)}\n`);
		const out = scoreCommand("t", root);
		expect(out).toBe(join(root, "t", "summary.md"));
		expect(readFileSync(out, "utf8")).toContain("P0-E");
	});
	test("doneKeys: incomplete runs are re-run, latest record wins", () => {
		const key = runKey("resume-01", "B1", 1);
		expect(doneKeys([{ ...rec, incomplete: true }]).has(key)).toBe(false);
		expect(doneKeys([{ ...rec, incomplete: true }, rec]).has(key)).toBe(true);
		expect(doneKeys([rec, { ...rec, incomplete: true }]).has(key)).toBe(false);
	});
	test("assertResumeCompatible", () => {
		expect(() => assertResumeCompatible([rec], "d", "v")).not.toThrow();
		expect(() => assertResumeCompatible([rec], "other", "v")).toThrow(
			/cannot --resume/,
		);
		expect(() => assertResumeCompatible([rec], "d", "v2")).toThrow(
			/cannot --resume/,
		);
	});
	test("evaluateStop", () => {
		expect(evaluateStop(rec, 1)).toEqual({ consecutive: 0, stop: null });
		const inc = { ...rec, incomplete: true };
		expect(evaluateStop(inc, 0)).toEqual({ consecutive: 1, stop: null });
		expect(evaluateStop(inc, 1).stop?.message).toContain(
			"consecutive incomplete",
		);
		expect(evaluateStop({ ...rec, safety: ["x"] }, 0).stop?.code).toBe(2);
		const limit = {
			purpose: "update",
			at: 0,
			code: "llm_call:spend_limit",
			model: null,
			inputTokens: 0,
			outputTokens: 0,
			latencyMs: 0,
			rejectCodes: [],
		};
		expect(evaluateStop({ ...rec, calls: [limit] }, 0).stop?.message).toContain(
			"spend limit",
		);
	});
	test("parseConditions", () => {
		expect(parseConditions("B1, F,B1")).toEqual(["B1", "F"]);
		expect(() => parseConditions("X")).toThrow();
	});
	test("loadCases / validateCommand on a temp dir", () => {
		const root = mkdtempSync(join(tmpdir(), "p0e-cases-"));
		mkdirSync(join(root, "dev"));
		writeFileSync(join(root, "dev", "a.json"), JSON.stringify(sampleCase));
		expect(loadCases("dev", root)).toHaveLength(1);
		expect(validateCommand("dev", root)).toContain(
			"resume     cases=1 opportunities=2 draft=1",
		);
		writeFileSync(join(root, "dev", "b.json"), JSON.stringify(sampleCase));
		expect(() => loadCases("dev", root)).toThrow(/duplicate case id resume-01/);
		writeFileSync(
			join(root, "dev", "b.json"),
			JSON.stringify({ ...sampleCase, id: "bad" }),
		);
		expect(() => loadCases("dev", root)).toThrow(/b\.json/);
		expect(() => loadCases("unseen", root)).toThrow(/not found/);
	});
});
