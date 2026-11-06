import { expect, test } from "bun:test";
import { auditTasks } from "../cross-judge.ts";
import { replayCase } from "../replay.ts";
import { decision, sampleCase, StubRuntime, ticketFor } from "./fixtures.ts";
import { runJudge, type JudgeOutput } from "../judge.ts";
import type { Judgment } from "../contracts.ts";
import type { LlmRequest } from "../../src/index.ts";

test("supplementary audit hides labels and conditions, preserves original cases, resumes by criterion", async () => {
	const c = structuredClone(sampleCase);
	c.title = "HIDDEN-TITLE";
	for (const s of c.steps)
		if (s.type === "opportunity" && s.expect)
			s.expect.note = "HIDDEN-EXPECTED-LABEL";
	const before = JSON.stringify(c);
	const rt = new StubRuntime({
		decisions: {
			s4: decision({
				opportunityId: "s4",
				action: "speak",
				utterance: "hello",
				ticket: ticketFor("s4", "speak", { utterance: "hello" }),
			}),
		},
	});
	const r = await replayCase(c, "B1", 1, () => rt, {
		runName: "r",
		settingsDigest: "d",
		instructionVersion: "v",
		spent: () => 0,
	});
	const tasks = auditTasks([r], [c], []);
	expect(tasks).toHaveLength(1);
	const rows: Judgment[] = [];
	const result = await runJudge({
		tasks,
		digest: "d",
		append: (xs) => rows.push(...xs),
		llm: {
			async complete<T>(req: LlmRequest<T>) {
				expect(req.prompt).not.toContain("HIDDEN-TITLE");
				expect(req.prompt).not.toContain("HIDDEN-EXPECTED-LABEL");
				expect(req.prompt).not.toContain("B1");
				const value: JudgeOutput = {
					verdicts: tasks[0]!.criteria.map((_, i) => ({
						criterion: i + 1,
						verdict: "pass",
						reason: "fixture",
					})),
				};
				return {
					value: value as T,
					model: "judge",
					inputTokens: 1,
					outputTokens: 1,
					cacheReadTokens: 0,
					latencyMs: 1,
				};
			},
		},
	});
	expect(result.judged).toBe(1);
	expect(JSON.stringify(c)).toBe(before);
	expect(auditTasks([r], [c], rows)).toHaveLength(0);
	expect(() =>
		auditTasks([{ ...r, caseHash: "changed" }], [c], rows),
	).toThrow();
});
