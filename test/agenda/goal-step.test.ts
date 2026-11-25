import { expect, test } from "bun:test";
import {
	asData,
	decideGoalStep,
	type GoalStep,
	type GoalStepContext,
} from "../../src/agenda/index.ts";
import type { LlmPort, LlmRequest } from "../../src/index.ts";

const context: GoalStepContext = {
	version: 1,
	contextId: "goal-test:7",
	goal: {
		id: "goal-test",
		revision: 1,
		desiredState: "掲載手順から指定結果を得る",
		sourceRef: "words",
	},
	progressVersion: 7,
	criteria: [
		{
			id: "root",
			text: "掲載手順から指定結果を得る",
			status: "open",
			evidenceRefs: [],
		},
	],
	evidence: [
		{
			ref: "first-stderr",
			version: "1",
			summary: "実コマンドは未知のオプションで終了2",
		},
	],
	attempts: [
		{
			ref: "first",
			criterionIds: ["root"],
			capabilityRef: "run",
			request: "掲載手順を実行",
			expectedObservation: "指定の結果を出力",
			outcome: "failed",
			observed: "終了2",
			savedReceipt: {
				ownerWorkId: "owner-work",
				ownerRevision: 3,
				resultRef: "result",
			},
			evidenceRefs: ["first-stderr"],
		},
	],
	capabilities: [
		{
			ref: "local-read",
			description: "同梱資料を読む",
			allowedScope: "読み取り",
		},
	],
	watches: [
		{ ref: "pending-document", condition: "許可区画の資料到着", dueAtMs: null },
	],
	checks: [
		{
			ref: "original-output",
			description: "固定の期待値と照合する",
			criterionIds: ["root"],
		},
	],
	openQuestions: [],
	reviewRequired: false,
};
const input = { sources: ["private-host-input"], complete: true };
const common = {
	contextId: context.contextId,
	progressVersion: context.progressVersion,
	criterionIds: ["root"],
	reason: "掲載されたオプションを同梱版が認識しなかった",
	review: null,
};
const act = {
	...common,
	kind: "act",
	capabilityRef: "local-read",
	request: "同梱版のヘルプを読む",
	evidenceRefs: ["first-stderr"],
	expectedObservation: "現在版で使える出力形式の指定を確認する",
} satisfies GoalStep;
const wait = {
	...common,
	kind: "wait",
	watchRef: "pending-document",
} satisfies GoalStep;
const ask = {
	...common,
	kind: "ask",
	missing: "編集の許可",
	question: "対象の文書を編集してよいですか？",
} satisfies GoalStep;
const verify = {
	...common,
	kind: "verify",
	checks: [
		{ criterionId: "root", checkRef: "original-output", evidenceRefs: [] },
	],
} satisfies GoalStep;

async function decide(value: unknown, snapshot = context) {
	const signal = new AbortController().signal;
	const calls: unknown[] = [];
	const llm: LlmPort = {
		async complete<T>(request: LlmRequest<T>, actualSignal: AbortSignal) {
			calls.push(request);
			expect(actualSignal).toBe(signal);
			expect(request.purpose).toBe("think");
			expect(request.prompt).toBe(asData(snapshot));
			expect(request.prompt).not.toContain(input.sources[0]!);
			expect(request.input).toBe(input);
			expect(request.schema.toJSONSchema()).toMatchObject({
				type: "object",
				properties: {
					step: snapshot.verificationRequired
						? { type: "object", properties: { kind: { const: "verify" } } }
						: { anyOf: expect.any(Array) },
				},
			});
			return {
				value: { step: value } as T,
				model: "fixed",
				inputTokens: 1,
				outputTokens: 1,
				cacheReadTokens: 0,
				latencyMs: 0,
			};
		},
	};
	const result = await decideGoalStep(llm, snapshot, input, signal);
	expect(calls).toHaveLength(1);
	return result;
}

for (const step of [act, wait, ask, verify])
	test("selects a supplied " + step.kind + " without running it", async () => {
		expect(await decide(step)).toEqual({ status: "chosen", step });
	});

test("only offered configuration-resolvable questions may be resolved by the model", async () => {
	const configured = {
		...context,
		configuration: { ref: "config/2", summary: "資料の登録先が増えた" },
		openQuestions: [
			{
				ref: "old",
				criterionIds: ["root"],
				question: "資料はありますか？",
				canResolve: true,
				configurationRef: "config/2",
			},
			{
				ref: "owner",
				criterionIds: ["root"],
				question: "承認をお願いします。",
				canResolve: false,
			},
		],
	};
	const selected = { ...act, resolvedQuestionRefs: ["old"] };
	expect(await decide(selected, configured)).toEqual({
		status: "chosen",
		step: selected,
	});
	expect(await decide(act, configured)).toEqual({
		status: "chosen",
		step: act,
	});
	for (const refs of [["owner"], ["unknown"], ["old", "old"]])
		expect(
			await decide({ ...act, resolvedQuestionRefs: refs }, configured),
		).toEqual({ status: "invalid", reason: "unoffered_ref" });
});

test("requires the covered conditions to be independently verified after adopting an artifact", async () => {
	const required = {
		...context,
		verificationRequired: {
			attemptRef: "saved-change",
			criterionIds: ["root"],
		},
	};
	for (const step of [act, wait, ask])
		expect(await decide(step, required)).toEqual({
			status: "invalid",
			reason: "invalid_shape",
		});
	expect(await decide(verify, required)).toEqual({
		status: "chosen",
		step: verify,
	});
});

test("rejects unoffered references, mismatched checks, and stale snapshots", async () => {
	for (const step of [
		{ ...act, capabilityRef: "alien" },
		{ ...act, evidenceRefs: ["forgotten"] },
		{ ...wait, watchRef: "unregistered" },
		{ ...ask, criterionIds: ["different-goal"] },
		{ ...verify, checks: [{ ...verify.checks[0]!, criterionId: "unmatched" }] },
		{ ...verify, checks: [{ ...verify.checks[0]!, checkRef: "other-check" }] },
		{
			...verify,
			checks: [{ ...verify.checks[0]!, evidenceRefs: ["forgotten"] }],
		},
	])
		expect(await decide(step)).toEqual({
			status: "invalid",
			reason: "unoffered_ref",
		});
	expect(await decide({ ...act, progressVersion: 6 })).toEqual({
		status: "invalid",
		reason: "wrong_snapshot",
	});
	expect(await decide({ ...act, contextId: "different-context" })).toEqual({
		status: "invalid",
		reason: "wrong_snapshot",
	});
});

test("rejects extra fields, completion output, missing targets and empty checks", async () => {
	for (const step of [
		{ ...act, unexpected: true },
		{ ...common, kind: "complete" },
		{ ...act, criterionIds: [] },
		{ ...verify, checks: [] },
	])
		expect(await decide(step)).toEqual({
			status: "invalid",
			reason: "invalid_shape",
		});
});

test("the review flag requires an actual reconsideration", async () => {
	const needsReview = { ...context, reviewRequired: true };
	expect(await decide(act, needsReview)).toEqual({
		status: "invalid",
		reason: "review_missing",
	});
	const step = {
		...act,
		review: "掲載手順の再実行を避け、同梱版で有効な操作を調べる",
	};
	expect(await decide(step, needsReview)).toEqual({ status: "chosen", step });
});

test("propagates inference failures and aborts with the original reason", async () => {
	const providerError = new Error("offline");
	const controller = new AbortController();
	let calls = 0;
	const llm: LlmPort = {
		async complete() {
			calls++;
			throw providerError;
		},
	};
	await expect(
		decideGoalStep(llm, context, input, controller.signal),
	).rejects.toBe(providerError);
	const cancelled = new Error("cancelled");
	controller.abort(cancelled);
	await expect(
		decideGoalStep(llm, context, input, controller.signal),
	).rejects.toBe(cancelled);
	expect(calls).toBe(1);
});
