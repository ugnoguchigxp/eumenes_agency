/** Cumulative host-side decision support. Semantic choices stay with the model. */
import { sampleFactory } from "../f-fusion/samples.ts";
import { createBudget } from "../../src/application/budget.ts";
import { ActivityBudget } from "../../src/application/activity-budget.ts";
import {
	selectEvidenceIds,
	interestRef,
} from "../../src/application/prompts.ts";
import { validateParticipation } from "../../src/domains/agency/participation.ts";
import { settleUpdate } from "../../src/domains/agency/settle.ts";
import {
	fromWire,
	participationSchema,
	wireUpdateSchema,
} from "../../src/contracts/proposals.ts";
import {
	defaultBudget,
	defaultLimits,
	type AgencyRuntime,
	type RuntimeDeps,
	type LlmPort,
	type LlmRequest,
	type LlmResult,
	type UpdateModelData,
	type SelectModelData,
} from "../../src/index.ts";

export const stages = ["A0", "A1", "A2", "A3", "A4"] as const;
export type Stage = (typeof stages)[number];
export const descriptions = [
	"改善F基準",
	"＋引用可能な根拠一覧",
	"＋参照・版番号の1回再判断",
	"＋実際に話す本文",
	"＋活動予算と取得済み結果の明示",
] as const;
const repairable = new Set(["unknown_ref", "stale_revision", "unresolved_ref"]);
type Data = UpdateModelData & Partial<SelectModelData>;
export function stageFactory(stage: Stage) {
	const level = stages.indexOf(stage);
	return (deps: RuntimeDeps): AgencyRuntime => {
		const cfg = deps.budget ?? defaultBudget,
			limits = deps.limits ?? defaultLimits;
		const callBudget = createBudget(cfg),
			activity = new ActivityBudget(deps.activityLimits);
		let rt: AgencyRuntime;
		let epoch = 0;
		const repaired = new Set<string>();
		const base = deps.llm;
		const knownEvidence = (data: Data, purpose: string) => [
			...new Set([
				...data.observations.map((o) => o.id),
				...(purpose === "select"
					? [
							...selectEvidenceIds("F", rt.snapshot().state),
							...(data.state.interests ?? [])
								.filter((i) => i.status !== "faded")
								.map((i) => interestRef(i.id)),
						]
					: []),
			]),
		];
		const support = (data: Data, purpose: string) => ({
			...(level >= 1
				? {
						referenceCatalog: {
							evidenceRefs: knownEvidence(data, purpose),
							intentRefs: data.state.intents.map((i) => ({
								id: i.id,
								revision: i.revision,
							})),
							candidateRefs: (data.candidates ?? data.state.candidates).map(
								(c) => ({ id: c.id, revision: c.revision }),
							),
						},
					}
				: {}),
			...(level >= 4
				? {
						executionContext: {
							callBudgetRemaining: callBudget.remaining(data.now),
							activities: data.state.intents.map((i) => ({
								intentId: i.id,
								canIssueTool: activity.canIssueTool(i.id, data.now),
								limits: activity.limits,
								usage: activity.use(i.id) ?? null,
							})),
							returnedResults: data.observations
								.filter(
									(o) =>
										o.kind === "action.observed" || o.kind === "work.returned",
								)
								.map((o) => ({ id: o.id, actor: o.actor, text: o.text })),
						},
					}
				: {}),
		});
		const codesFor = (
			data: Data,
			purpose: string,
			value: unknown,
		): readonly string[] => {
			const snapshot = rt.snapshot();
			if (purpose === "select") {
				const p = participationSchema.safeParse(value);
				if (!p.success) return ["schema"];
				const verdict = validateParticipation({
					condition: "F",
					state: snapshot.state,
					proposal: p.data,
					presentedObservations: new Set(knownEvidence(data, purpose)),
					presentedCandidates: new Map(
						(data.candidates ?? []).map((c) => [c.id, c.revision]),
					),
					tools: deps.tools,
					limits,
					at: data.now,
				});
				return verdict.ok ? [] : verdict.codes;
			}
			if (purpose === "update") {
				const wire = wireUpdateSchema("F", {
					interestFormation: true,
				}).safeParse(value);
				if (!wire.success) return ["schema"];
				const typed = fromWire(wire.data, "F");
				if (!typed.ok) return ["schema"];
				const result = settleUpdate({
					condition: "F",
					state: snapshot.state,
					proposal: typed.proposal,
					presented: data.observations,
					batch: data.observations.filter((o) => data.freshIds.includes(o.id)),
					cursor: snapshot.cursor,
					tools: deps.tools,
					limits,
					now: data.now,
				});
				return result.kind === "rejected" ? result.codes : [];
			}
			return [];
		};
		const adapter: LlmPort = {
			async complete<T>(
				request: LlmRequest<T>,
				signal: AbortSignal,
			): Promise<LlmResult<T>> {
				const data = JSON.parse(request.prompt) as Data,
					startEpoch = epoch;
				const system = [
					request.system,
					level >= 1
						? "referenceCatalog.evidenceRefsが今回引用できる根拠IDの全一覧。intentRefs/candidateRefsは更新・候補選択用で、根拠IDではない。evidenceRefsは根拠一覧だけから選ぶ。"
						: "",
					level >= 3
						? "speakではutteranceに利用者へ実際に話す完成した文を必ず書く。行動案・作業指示をそのまま発話しない。伝える内容や尋ねる質問を実際の説明・問いかけとして書く。"
						: "",
					level >= 4
						? "executionContextはホストの現在の実行制約と取得済み結果。canIssueTool=falseの活動で追加調査はできない。使える取得結果で説明する、必要な条件を質問する、待機する等から、利用者の現在の意図に沿う一手を選ぶ。結果の範囲を超えて断定しない。"
						: "",
				]
					.filter(Boolean)
					.join("\n\n");
				const prompt = JSON.stringify({
					...data,
					...support(data, request.purpose),
				});
				const first = await base.complete(
					{ ...request, system, prompt },
					signal,
				);
				if (level < 2 || signal.aborted || epoch !== startEpoch) return first;
				const codes = codesFor(data, request.purpose, first.value);
				const key = JSON.stringify([
					request.purpose,
					data.now,
					data.opportunity?.id ?? data.freshIds,
				]);
				if (
					codes.length === 0 ||
					!codes.every((c) => repairable.has(c)) ||
					repaired.has(key) ||
					callBudget.check(data.now, false) !== "ok"
				)
					return first;
				repaired.add(key);
				callBudget.record(data.now);
				// The runtime records the first request; the shared meter counts this extra request too.
				const nextData = JSON.parse(request.prompt) as Data;
				const second = await base.complete(
					{
						...request,
						system:
							system +
							"\n参照・版番号の検証に失敗した。最新の提示情報とfeedbackだけを使い、訂正または待機を一度選ぶ。実行・成功したとは扱わない。",
						prompt: JSON.stringify({
							...nextData,
							...support(nextData, request.purpose),
							validationFeedback: { codes, previousProposal: first.value },
						}),
					},
					signal,
				);
				return {
					...second,
					inputTokens: first.inputTokens + second.inputTokens,
					outputTokens: first.outputTokens + second.outputTokens,
					latencyMs: first.latencyMs + second.latencyMs,
				};
			},
		};
		rt = sampleFactory("F-improved")({
			...deps,
			llm: adapter,
			callBudgetMeter: callBudget,
			activityBudgetMeter: activity,
		});
		return {
			...rt,
			observe(input) {
				epoch++;
				return rt.observe(input);
			},
			invalidate(reason, now) {
				epoch++;
				rt.invalidate(reason, now);
			},
			setEnabled(value) {
				epoch++;
				rt.setEnabled(value);
			},
			recordResult(receipt) {
				epoch++;
				return rt.recordResult(receipt);
			},
		};
	};
}
