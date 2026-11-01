/** Experimental host adapters. Both execute through the unchanged native F runtime. */
import { z } from "zod";
import {
	createAgencyRuntime,
	type RuntimeDeps,
	type LlmPort,
	type WireOp,
	type WireUpdate,
	LlmOutputError,
	type LlmRequest,
} from "../../src/index.ts";
import {
	wireInterestOp,
	wireUpdateSchema,
} from "../../src/contracts/proposals.ts";
import { commonPolicy } from "../live-b1-f/protocol.ts";

export type Variant = "F-improved" | "Fusion";
const ref = z.string().min(1).max(64);
const text = (max: number) => z.string().min(1).max(max);
const evidence = z.array(ref).max(12);
const step = z.strictObject({
	localId: ref,
	kind: z.enum(["question", "propose", "share", "tool"]),
	content: text(400),
	toolName: z.string().max(64),
	toolInput: z.string().max(400),
	applyWhen: text(300),
	expireHours: z.int().min(1).max(168),
	evidenceRefs: evidence,
	supersedes: z.string().max(64),
});
export const compactSchema = z.strictObject({
	summary: z.string().max(400),
	missingInfo: z.string().max(300).nullable(),
	focusRefs: z.array(ref).max(7),
	interestOps: z.array(wireInterestOp).max(4),
	/** A question is a native intent; its next step is a native candidate. No second memory. */
	questions: z
		.array(
			z.strictObject({
				change: z.enum(["add", "update"]),
				id: z.string().max(64),
				localId: z.string().max(64),
				revision: z.int().min(0),
				state: z.enum([
					"proposed",
					"adopted",
					"held",
					"completed",
					"abandoned",
					"unchanged",
				]),
				question: text(400),
				reason: text(300),
				doneWhen: text(300),
				resumeWhen: text(300),
				stopWhen: z.string().max(300),
				reviewHours: z.int().min(1).max(168),
				evidenceRefs: evidence,
				nextSteps: z.array(step).max(1),
			}),
		)
		.max(4),
	closeSteps: z
		.array(
			z.strictObject({
				id: ref,
				revision: z.int().min(1),
				state: z.enum(["dismissed", "superseded", "expired", "fulfilled"]),
				evidenceRefs: evidence,
			}),
		)
		.max(4),
	reconciliations: z
		.array(z.strictObject({ candidateId: ref, observationRef: ref }))
		.max(4),
});
export type CompactUpdate = z.infer<typeof compactSchema>;
const emptyOp = (): Omit<WireOp, "op"> => ({
	id: null,
	localId: null,
	expectedRevision: null,
	state: null,
	text: null,
	reason: null,
	completionCondition: null,
	resumeCondition: null,
	withdrawCondition: null,
	applyWhen: null,
	hours: null,
	intentRef: null,
	desireRef: null,
	supersedes: null,
	kind: null,
	confidence: null,
	toolName: null,
	toolInput: null,
	evidenceRefs: [],
	beliefRefs: [],
});
/** Structural encoding only. Every goal, condition, action and state is chosen by the model. */
export function expandCompact(value: CompactUpdate): WireUpdate {
	const ops: WireOp[] = [];
	for (const q of value.questions) {
		if (q.change === "update" && q.stopWhen !== "")
			throw new Error("immutable withdrawCondition");
		ops.push({
			...emptyOp(),
			op: q.change === "add" ? "intent.add" : "intent.update",
			id: q.id || null,
			localId: q.localId || null,
			expectedRevision: q.revision || null,
			state: q.state === "unchanged" ? null : q.state,
			text: q.question,
			reason: q.reason,
			completionCondition: q.doneWhen,
			resumeCondition: q.resumeWhen,
			withdrawCondition: q.stopWhen || null,
			hours: q.reviewHours,
			evidenceRefs: q.evidenceRefs,
		});
		for (const s of q.nextSteps) {
			ops.push({
				...emptyOp(),
				op: "candidate.add",
				localId: s.localId,
				intentRef: (q.change === "add" ? q.localId : q.id) || null,
				kind: s.kind,
				text: s.content,
				toolName: s.toolName || null,
				toolInput: s.toolInput || null,
				applyWhen: s.applyWhen,
				hours: s.expireHours,
				evidenceRefs: s.evidenceRefs,
				supersedes: s.supersedes || null,
			});
		}
	}
	for (const c of value.closeSteps)
		ops.push({
			...emptyOp(),
			op: "candidate.close",
			id: c.id,
			expectedRevision: c.revision,
			state: c.state,
			evidenceRefs: c.evidenceRefs,
		});
	// No repair or omission filling: malformed add/update combinations fail native validation.
	return wireUpdateSchema("F", { interestFormation: true }).parse({
		summary: value.summary,
		missingInfo: value.missingInfo,
		focusRefs: value.focusRefs,
		ops,
		interestOps: value.interestOps,
		reconciliations: value.reconciliations,
	});
}

export const improvementPolicy = [
	"継続する関心と、個別の未解決作業は分ける。関心そのものはinterestOpsへ、問いや次に進める作業はintents/candidatesへ記録し、同じ趣味を問いごとに別の関心として重ねない。",
	"既存の状態を読んでから必要な変更だけ出す。対象は同一でも停止・再開・撤回・解決は状態に反映する。休止はdormant/held、撤回はfaded、解決した問いはcompleted。自発的な行動を止めるだけで未解決の記憶を放置しない。",
	"一度の調査で問い全体が解決しなくてもよい。取得済みの結果が次の問いに十分なら使い、既にした調査を新情報なしに繰り返さない。資料だけでは分からないことは具体的に確認する。",
	"発話・ツールに進める作業があれば、intentとそのcandidateを同じupdateで作れる。既存の有効候補があるなら重ねて作らない。必要な層だけ使い、必ずbelief/desireを先に作る必要はない。",
	"出力契約：intent.addのlocalId/state/text/reason/completionCondition/resumeCondition/withdrawCondition/hours/evidenceRefsは必須でnull不可。各条件はその作業の意味に沿って記述する。常時実行可能な作業でも再開条件を言葉で記す。",
	"intent.updateは既存revisionを参照し、stateは遷移するときだけ。現状態を再送して自己遷移にしない。変更しない任意項目だけnull。candidate.addはlocalId/intentRef/kind/text/applyWhen/hours/evidenceRefsが必要。",
	"interest.updateはid/expectedRevision/reason/evidenceRefsを示す。topicを変えないならnullとし、状態を変えるためだけにtopicを再送しない。各参照はモデル入力にあるIDとその正しい接頭辞を使う。候補の選択はcandidateRefにidとrevisionを入れる。",
].join("\n");
export const compactContract = [
	"出力はsummary/missingInfo/focusRefs/interestOps/questions/closeSteps/reconciliations。関心はFのinterestOpsと同じ契約・同じ証拠ルール。",
	"questionsは記憶する未解決の問いと次の一手。既存state.intentsが保存済みの問い、state.candidatesが保存済みの一手であり、別のメモは作らない。belief/desireの独立項目はこの試験版では作らない。",
	"addではidは空文字、revisionは0、localIdは新規名、stateはproposed/adopted/held。updateではid/revisionは既存値、localIdは空文字、stateは遷移先を選び、遷移しないならunchanged。",
	"question/reason/doneWhen/resumeWhen/reviewHours/evidenceRefsは全て必須。stopWhenはadd時だけ必須で、updateでは既存の撤回条件を変更できないので空文字。その他の内容はupdate時にも完全に再送する。条件の意味はLLMが現在の観測から選ぶ。完了には作成後のユーザーまたはツールの根拠が必要。停止・再開・解決は元の問いの状態で表し、新規複製しない。",
	"nextStepsは今回保存する一手を0件または1件の配列で表す。不要なら[]。localId/kind/content/applyWhen/expireHours/evidenceRefsは必須。toolならtoolName/toolInputを指定し、使わないtoolName/toolInputは空文字。supersedesは提示された既存候補IDまたは空文字。",
	"questionsは既存Fのintent、そのnextStepsの一手はcandidateへそのまま接続され、同じ検証と実行を通る。行動提案は実行成功ではない。実行結果を待つ。closeStepsは既存candidateのid/revision/終了state/根拠。reconciliationsは既存契約通り。",
].join("\n");

/** Shared native interest contract: the compact adapter must not discard these rules. */
export const interestContract = [
	"interestOpsは最大4件。interest.addはlocalId/topic/origin(user_relation/own)/reason/evidenceRefs/derivedFromを指定し、必ずemergingから始まる。addのstatusにdormant/faded等を書いて終了・休止を表すことはできない。",
	"既存関心の変更はinterest.updateにid/expectedRevision/reason/evidenceRefsを示し、statusはemerging/active/dormant/fadedまたは変更なしnull、topicも変更なしならnull。originはaddだけ。",
	"activeへの昇格、topicの変更、派生関心の形成には既存証拠に未使用の独立した非agent観測が必要。自己発話や同じツール結果の反復を独立証拠に数えない。host_seedは新規作成・書換え・終了不可。",
	"表示から消えた終了済み関心も、観測履歴にある撤回を忘れて作り直さない。撤回後の新しい利用者の関与・再開意思がなければ新規作成しない。以前の関与を再引用しただけでは再開の根拠にならない。",
].join("\n");

export function sampleFactory(variant: Variant) {
	return (deps: RuntimeDeps) => {
		const policy = (purpose: "update" | "select", contract: string) =>
			[
				commonPolicy,
				improvementPolicy,
				interestContract,
				purpose === "update"
					? "今回の役割は状態更新案の作成。"
					: "今回の役割は一つの行動または待機を選ぶこと。",
				contract,
			].join("\n\n");
		const base = deps.llm;
		const adapted: LlmPort = {
			async complete<T>(request: LlmRequest<T>, signal: AbortSignal) {
				if (variant !== "Fusion" || request.purpose !== "update")
					return base.complete(request, signal);
				const answer = await base.complete(
					{
						...request,
						system: policy("update", compactContract),
						schema: compactSchema,
					},
					signal,
				);
				try {
					const checked = request.schema.parse(expandCompact(answer.value));
					return { ...answer, value: checked };
				} catch {
					throw new LlmOutputError("schema", answer.model, {
						inputTokens: answer.inputTokens,
						outputTokens: answer.outputTokens,
					});
				}
			},
		};
		return createAgencyRuntime({
			...deps,
			condition: "F",
			interestFormation: true,
			llm: adapted,
			systemContext: {
				update: ({ outputContract }) =>
					policy("update", outputContract.description),
				select: ({ outputContract }) =>
					policy("select", outputContract.description),
			},
		});
	};
}
