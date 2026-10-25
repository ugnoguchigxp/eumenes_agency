import type { z } from "zod";
import { LlmOutputError } from "../../src/contracts/errors.ts";
import type {
	Actor,
	AgencyState,
	Observation,
	ObservationInput,
	ObservationKind,
	Opportunity,
	ToolCapability,
} from "../../src/contracts/model.ts";
import { emptyState } from "../../src/contracts/model.ts";
import type {
	LlmPort,
	LlmPurpose,
	LlmRequest,
	LlmResult,
} from "../../src/contracts/ports.ts";
import type {
	candidateAdd,
	candidateClose,
	intentAdd,
	intentUpdate,
	participationSchema,
} from "../../src/contracts/proposals.ts";
import { settleUpdate } from "../../src/domains/agency/settle.ts";
import { defaultLimits } from "../../src/contracts/model.ts";
import type { Limits } from "../../src/contracts/model.ts";
import type { UpdateProposal } from "../../src/contracts/proposals.ts";

export const MIN = 60_000;
export const HOUR = 3_600_000;

export const tools: readonly ToolCapability[] = [
	{
		name: "run_compare",
		description: "二つの出力を比較実行する",
		requiresApproval: false,
	},
	{
		name: "delete_files",
		description: "ファイルを削除する",
		requiresApproval: true,
	},
];

type Scripted = unknown | Error | ((req: LlmRequest<unknown>) => unknown);

/** Scripted LlmPort: queued values per purpose, requests recorded. */
export interface FakeLlm extends LlmPort {
	push(purpose: LlmPurpose, ...items: Scripted[]): void;
	readonly requests: LlmRequest<unknown>[];
	count(purpose?: LlmPurpose): number;
}

export const fakeLlm = (): FakeLlm => {
	const queues: Record<LlmPurpose, Scripted[]> = {
		update: [],
		select: [],
		respond: [],
	};
	const requests: LlmRequest<unknown>[] = [];
	return {
		requests,
		push: (purpose, ...items) => {
			queues[purpose].push(...items);
		},
		count: (purpose) =>
			purpose
				? requests.filter((r) => r.purpose === purpose).length
				: requests.length,
		async complete<T>(
			request: LlmRequest<T>,
			signal: AbortSignal,
		): Promise<LlmResult<T>> {
			requests.push(request as LlmRequest<unknown>);
			if (signal.aborted) throw new DOMException("aborted", "AbortError");
			const next = queues[request.purpose].shift();
			if (next === undefined)
				throw new Error(`no scripted ${request.purpose} response`);
			const raw =
				typeof next === "function"
					? (next as (r: LlmRequest<unknown>) => unknown)(
							request as LlmRequest<unknown>,
						)
					: next;
			const item = request.purpose === "update" ? autoWire(raw) : raw;
			if (item instanceof Error) throw item;
			const parsed = request.schema.safeParse(item);
			if (!parsed.success) throw new LlmOutputError("schema", "fake-model");
			return {
				value: parsed.data,
				model: "fake-model",
				inputTokens: 100,
				outputTokens: 20,
				cacheReadTokens: 0,
				latencyMs: 5,
			};
		},
	};
};

export const obsInput = (
	id: string,
	kind: ObservationKind,
	actor: Actor,
	occurredAt: number,
	text: string,
	causationId?: string,
): ObservationInput => ({
	id,
	kind,
	actor,
	occurredAt,
	text,
	...(causationId === undefined ? {} : { causationId }),
});
export const obs = (
	seq: number,
	kind: ObservationKind,
	actor: Actor,
	text = `text${seq}`,
	at = seq * MIN,
): Observation => {
	return { id: `o${seq}`, seq, kind, actor, occurredAt: at, text };
};

type Of<T extends z.ZodType> = z.infer<T>;

export const intentAddOp = (
	localId: string,
	o: Partial<Of<typeof intentAdd>> = {},
): Of<typeof intentAdd> => ({
	op: "intent.add",
	localId,
	initialState: "adopted",
	desiredState: "音声の比較結果を共有する",
	motive: "原因が未解明のまま",
	completionCondition: "比較結果がユーザーに共有される",
	resumeCondition: "ユーザーが作業に戻る",
	withdrawCondition: "不要と言われる",
	reviewAfterHours: 2,
	evidenceRefs: ["o1"],
	desireRef: null,
	...o,
});
export const intentUpdateOp = (
	id: string,
	expectedRevision: number,
	o: Partial<Of<typeof intentUpdate>> = {},
): Of<typeof intentUpdate> => ({
	op: "intent.update",
	id,
	expectedRevision,
	transition: null,
	reason: "更新",
	evidenceRefs: [],
	desiredState: null,
	completionCondition: null,
	resumeCondition: null,
	reviewAfterHours: null,
	...o,
});
export const candidateAddOp = (
	localId: string,
	intentRef: string,
	o: Partial<Of<typeof candidateAdd>> = {},
): Of<typeof candidateAdd> => ({
	op: "candidate.add",
	localId,
	intentRef,
	kind: "share",
	content: "先ほどの比較結果をお伝えしましょうか",
	toolName: null,
	toolInput: null,
	applyWhen: "ユーザーが手空きのとき",
	expireAfterHours: 24,
	evidenceRefs: ["o1"],
	supersedes: null,
	...o,
});
export const candidateCloseOp = (
	id: string,
	expectedRevision: number,
	o: Partial<Of<typeof candidateClose>> = {},
): Of<typeof candidateClose> => ({
	op: "candidate.close",
	id,
	expectedRevision,
	reason: "dismissed",
	evidenceRefs: [],
	...o,
});

export const proposal = (
	ops: unknown[] = [],
	extra: Record<string, unknown> = {},
): UpdateProposal =>
	({
		summary: "要約",
		missingInfo: null,
		focusRefs: [],
		ops,
		reconciliations: [],
		...extra,
	}) as UpdateProposal;
export const b1Proposal = (ops: unknown[] = [], focusRefs: string[] = []) =>
	({
		summary: "要約",
		missingInfo: null,
		focusRefs,
		ops,
	}) as UpdateProposal;

type Participation = Of<typeof participationSchema>;
export const participation = (
	o: Partial<Participation> = {},
): Participation => ({
	action: "wait",
	candidateRef: null,
	utterance: null,
	toolName: null,
	toolInput: null,
	evidenceRefs: [],
	valueNow: "低い",
	userBurden: "小さい",
	lossIfWait: "なし",
	conflicts: null,
	reason: "待つ",
	...o,
});

export const opportunity = (
	id: string,
	at: number,
	o: Partial<Opportunity> = {},
): Opportunity => ({
	id,
	at,
	trigger: "turn_end",
	presence: "quiet",
	foregroundBusy: false,
	playerBusy: false,
	...o,
});

/** Applies a proposal through the settle domain and returns the new state. */
export const applyOrThrow = (
	state: AgencyState,
	p: UpdateProposal,
	presented: readonly Observation[],
	condition: "B1" | "B2" | "F" = "B2",
	now = 0,
	limits: Limits = defaultLimits,
): AgencyState => {
	const r = settleUpdate({
		condition,
		state,
		proposal: p,
		presented,
		tools,
		limits,
		now,
	});
	if (r.kind === "rejected") throw new Error(`rejected: ${r.codes.join(",")}`);
	return r.state;
};

export { emptyState, defaultLimits };

type Json = Record<string, unknown>;
const wireBlank = {
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
};

/** Typed op -> flat wire op (the mirror of fromWire). */
export const toWireOp = (o: Json): Json => {
	const w: Json = { ...wireBlank, op: o.op };
	const copy = (...keys: string[]) => {
		for (const k of keys) if (k in o) w[k] = o[k];
	};
	copy(
		"id",
		"localId",
		"expectedRevision",
		"evidenceRefs",
		"intentRef",
		"desireRef",
		"supersedes",
		"toolName",
		"toolInput",
		"applyWhen",
		"completionCondition",
		"resumeCondition",
		"withdrawCondition",
		"kind",
		"confidence",
		"beliefRefs",
	);
	const map = (from: string, to: string) => {
		if (from in o) w[to] = o[from];
	};
	map("initialState", "state");
	map("transition", "state");
	map("status", "state");
	if (o.op === "candidate.close") map("reason", "state");
	else map("reason", "reason");
	map("motive", "reason");
	map("desiredState", "text");
	map("content", "text");
	map("text", "text");
	map("object", "text");
	map("reviewAfterHours", "hours");
	map("expireAfterHours", "hours");
	return w;
};

export const toWire = (p: UpdateProposal): Json => ({
	summary: p.summary,
	missingInfo: p.missingInfo,
	focusRefs: p.focusRefs,
	ops: (p.ops as unknown as Json[]).map(toWireOp),
	reconciliations: "reconciliations" in p ? p.reconciliations : [],
	// hostTodos updates carry the work items a reply conveyed; kept as given.
	...("reportedTodos" in p ? { reportedTodos: p.reportedTodos } : {}),
});

/** Typed proposals (no `hours` key on any op) are converted; wire-shaped values pass through. */
const autoWire = (raw: unknown): unknown => {
	if (typeof raw !== "object" || raw === null || !("ops" in raw)) return raw;
	const ops = (raw as { ops: Json[] }).ops;
	if (!Array.isArray(ops) || ops.some((o) => "hours" in o)) return raw;
	return toWire(raw as UpdateProposal);
};
