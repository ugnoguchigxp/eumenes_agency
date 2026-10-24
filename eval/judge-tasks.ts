/**
 * Content judging without the API: the pending judge tasks are written to a task file with the
 * same system prompt and per-action prompt the API judge uses; a separate judge (a Claude Code
 * subagent with no other context) writes an answer file; the answers are imported as ordinary
 * judgment rows. The route recorded in the digest is `subagentJudgeRole`, so these rows never
 * mix with API-judged rows in one judgments file.
 */
import { z } from "zod";
import type { Judgment } from "./contracts.ts";
import {
	earlierOpportunities,
	factsBefore,
	judgePrompt,
	judgeSystemPrompt,
	type JudgeTask,
} from "./judge.ts";

/** The judge route of subagent-judged rows (folded into the digest like an API route). */
export const subagentJudgeRole = {
	model: "claude-code-subagent",
	effort: "-",
} as const;

export interface JudgeTaskEntry {
	readonly id: number;
	readonly caseId: string;
	readonly condition: string;
	readonly rep: number;
	readonly opportunityId: string;
	readonly criteria: readonly string[];
	readonly prompt: string;
}

export interface JudgeTaskFile {
	readonly runName: string;
	readonly digest: string;
	readonly system: string;
	readonly answerFormat: string;
	readonly tasks: readonly JudgeTaskEntry[];
}

export const answerSchema = z.strictObject({
	digest: z.string(),
	answers: z.array(
		z.strictObject({
			id: z.int().min(1),
			verdicts: z.array(
				z.strictObject({
					criterion: z.int().min(1),
					verdict: z.enum(["pass", "fail", "unclear"]),
					reason: z.string(),
				}),
			),
		}),
	),
});
export type JudgeAnswers = z.infer<typeof answerSchema>;

export function buildJudgeTaskFile(
	runName: string,
	tasks: readonly JudgeTask[],
	digest: string,
): JudgeTaskFile {
	return {
		runName,
		digest,
		system: judgeSystemPrompt,
		answerFormat:
			'{"digest": "<the digest above>", "answers": [{"id": <task id>, "verdicts": [{"criterion": <1-based>, "verdict": "pass"|"fail"|"unclear", "reason": "<1-2 sentences>"}]}]}',
		tasks: tasks.map((t, i) => ({
			id: i + 1,
			caseId: t.record.caseId,
			condition: t.record.condition,
			rep: t.record.rep,
			opportunityId: t.opportunity.opportunityId,
			criteria: t.criteria,
			prompt: judgePrompt(
				factsBefore(
					t.case,
					t.opportunity.opportunityId,
					earlierOpportunities(t.record, t.opportunity.opportunityId),
				),
				t.opportunity,
				t.criteria,
			),
		})),
	};
}

/**
 * Rows for the answered tasks that are still pending exactly as the sheet listed them (same
 * key and criteria). An answer must cover each criterion once; anything else is refused, and
 * a task without an answer stays pending.
 */
export function importJudgeAnswers(
	sheet: JudgeTaskFile,
	answers: JudgeAnswers,
	pending: readonly JudgeTask[],
	digest: string,
): { rows: Judgment[]; skipped: string[] } {
	if (answers.digest !== sheet.digest || sheet.digest !== digest)
		throw new Error(
			`judge answers: digest mismatch (sheet ${sheet.digest}, answers ${answers.digest}, current ${digest})`,
		);
	const byId = new Map(sheet.tasks.map((t) => [t.id, t]));
	const rows: Judgment[] = [];
	const skipped: string[] = [];
	for (const a of answers.answers) {
		const t = byId.get(a.id);
		if (!t) throw new Error(`judge answers: unknown task id ${a.id}`);
		const live = pending.find(
			(p) =>
				p.record.caseId === t.caseId &&
				p.record.condition === t.condition &&
				p.record.rep === t.rep &&
				p.opportunity.opportunityId === t.opportunityId,
		);
		if (!live || JSON.stringify(live.criteria) !== JSON.stringify(t.criteria)) {
			skipped.push(`${a.id} (no longer pending as listed)`);
			continue;
		}
		const numbers = a.verdicts.map((v) => v.criterion).sort((x, y) => x - y);
		if (
			numbers.length !== t.criteria.length ||
			!numbers.every((n, i) => n === i + 1)
		)
			throw new Error(
				`judge answers: task ${a.id} does not cover each criterion once`,
			);
		for (const [i, criterion] of t.criteria.entries()) {
			const v = a.verdicts.find((x) => x.criterion === i + 1)!;
			rows.push({
				runName: live.record.runName,
				caseId: t.caseId,
				condition: live.record.condition,
				rep: t.rep,
				opportunityId: t.opportunityId,
				criterion,
				verdict: v.verdict,
				reason: v.reason,
				model: subagentJudgeRole.model,
				judgeDigest: digest,
			});
		}
	}
	return { rows, skipped };
}
