import type { Candidate, Intent, IntentState } from "../../contracts/model.ts";
import { isOpenCandidate, isOpenIntent } from "../../contracts/model.ts";
import type { B2Update, FUpdate } from "../../contracts/proposals.ts";
import { unique } from "./ids.ts";
import {
	closeCandidate,
	closeCandidatesOfIntent,
	hasUnknownOutcome,
	isInFlight,
} from "./lifecycle.ts";
import {
	evidenceOk,
	hasNewerThan,
	isIndependent,
	hoursToMs,
	reject,
	resolveRef,
	type SettleCtx,
} from "./settle-context.ts";

type Op = (B2Update | FUpdate)["ops"][number];
type Of<K extends Op["op"]> = Extract<Op, { op: K }>;

const transitions: Record<string, readonly IntentState[]> = {
	proposed: ["adopted", "held", "abandoned", "completed"],
	adopted: ["held", "abandoned", "completed"],
	held: ["adopted", "abandoned", "completed"],
};

const findIntent = (ctx: SettleCtx, id: string) =>
	ctx.next.intents.find((i) => i.id === id);
const findCandidate = (ctx: SettleCtx, id: string) =>
	ctx.next.candidates.find((c) => c.id === id);

/** Existing item must exist, be open, and match expectedRevision. */
const checkExisting = <T extends { revision: number }>(
	ctx: SettleCtx,
	item: T | undefined,
	open: (x: T) => boolean,
	expectedRevision: number,
): item is T => {
	if (!item) {
		reject(ctx, "unknown_ref");
		return false;
	}
	if (!open(item) || item.revision !== expectedRevision) {
		reject(ctx, "stale_revision");
		return false;
	}
	return true;
};

export const applyIntentAdd = (ctx: SettleCtx, op: Of<"intent.add">) => {
	const id = ctx.local.get(op.localId);
	if (id === undefined) return;
	let ok = evidenceOk(ctx, op.evidenceRefs);
	if (op.evidenceRefs.length === 0) {
		reject(ctx, "missing_evidence");
		ok = false;
	}
	if (op.reviewAfterHours > ctx.limits.reviewAfterMaxHours) {
		reject(ctx, "limit_exceeded");
		ok = false;
	}
	let desireRef: string | null = null;
	if (op.desireRef !== null) {
		if (ctx.condition !== "F") {
			reject(ctx, "op_not_allowed");
			ok = false;
		} else {
			desireRef = resolveRef(ctx, op.desireRef, "d", (x) =>
				ctx.next.desires.some((d) => d.id === x),
			);
			if (desireRef === null) ok = false;
		}
	}
	if (!ok) {
		ctx.failed.add(op.localId);
		return;
	}
	ctx.next.intents.push({
		id,
		revision: 1,
		state: op.initialState,
		desiredState: op.desiredState,
		motive: op.motive,
		completionCondition: op.completionCondition,
		resumeCondition: op.resumeCondition,
		withdrawCondition: op.withdrawCondition,
		reviewAt: ctx.now + hoursToMs(op.reviewAfterHours),
		evidence: unique(op.evidenceRefs),
		desireRef,
		createdSeq: ctx.floorSeq,
		stateSeq: ctx.floorSeq,
		createdAt: ctx.now,
		lastReason: op.motive,
	});
	ctx.touched.add(id);
};

/**
 * Completion evidence must be independent and newer than the intent's creation, or, for an
 * intent completed from held, newer than its last state change (the hold itself).
 */
const hasExternalNewer = (
	ctx: SettleCtx,
	intent: Intent,
	refs: readonly string[],
) => {
	const floor =
		intent.state === "held"
			? Math.max(intent.createdSeq, intent.stateSeq ?? 0)
			: intent.createdSeq;
	return refs.some((r) => {
		const o = ctx.obs.get(r);
		return o !== undefined && isIndependent(ctx, o) && o.seq > floor;
	});
};

/**
 * Contract section 8: while a candidate's attempt has an unknown outcome, the same effect must
 * not be reserved again, so the candidate can be neither closed nor superseded from outside.
 * Only the host's receipt reconciliation moves it. Returns the reject code, or null if free.
 */
const lockCode = (ctx: SettleCtx, c: Candidate): string | null => {
	if (isInFlight(c)) return "candidate_in_flight";
	if (c.holdReason === "awaiting_outcome" || hasUnknownOutcome(ctx.next, c.id))
		return "candidate_awaiting_outcome";
	return null;
};

const addedHere = (ctx: SettleCtx) => new Set(ctx.local.values());

export const applyIntentUpdate = (ctx: SettleCtx, op: Of<"intent.update">) => {
	const intent = findIntent(ctx, op.id);
	if (!checkExisting(ctx, intent, () => true, op.expectedRevision)) return;
	if (!isOpenIntent(intent)) {
		reject(ctx, "illegal_transition");
		return;
	}
	// Restating the current state means "no transition"; rejecting would drop the rest of the update.
	const transition = op.transition === intent.state ? null : op.transition;
	let ok = evidenceOk(ctx, op.evidenceRefs);
	if (
		op.reviewAfterHours !== null &&
		op.reviewAfterHours > ctx.limits.reviewAfterMaxHours
	) {
		reject(ctx, "limit_exceeded");
		ok = false;
	}
	if (transition !== null) {
		if (!transitions[intent.state]?.includes(transition)) {
			reject(ctx, "illegal_transition");
			ok = false;
		} else if (
			transition === "completed" &&
			!hasExternalNewer(ctx, intent, op.evidenceRefs)
		) {
			reject(ctx, "completion_without_external_evidence");
			ok = false;
		}
	}
	// A candidate added by this same proposal cannot be closed by it too. Rejecting here keeps
	// the outcome independent of op order (add after a terminal update fails with intent_not_open).
	if (
		(transition === "completed" || transition === "abandoned") &&
		ctx.next.candidates.some(
			(c) =>
				c.intentId === intent.id &&
				isOpenCandidate(c) &&
				addedHere(ctx).has(c.id),
		)
	) {
		reject(ctx, "intent_not_open");
		ok = false;
	}
	if (!ok) return;
	if (transition !== null) {
		intent.state = transition;
		intent.stateSeq = ctx.floorSeq;
	}
	if (op.desiredState !== null) intent.desiredState = op.desiredState;
	if (op.completionCondition !== null)
		intent.completionCondition = op.completionCondition;
	if (op.resumeCondition !== null) intent.resumeCondition = op.resumeCondition;
	if (op.reviewAfterHours !== null)
		intent.reviewAt = ctx.now + hoursToMs(op.reviewAfterHours);
	intent.evidence = unique([...intent.evidence, ...op.evidenceRefs]);
	intent.lastReason = op.reason;
	intent.revision += 1;
	ctx.touched.add(intent.id);
	if (intent.state === "completed" || intent.state === "abandoned")
		closeCandidatesOfIntent(ctx.next, intent.id, ctx.touched, ctx.cascaded);
};

export const applyCandidateAdd = (ctx: SettleCtx, op: Of<"candidate.add">) => {
	const id = ctx.local.get(op.localId);
	if (id === undefined) return;
	let ok = evidenceOk(ctx, op.evidenceRefs);
	if (op.evidenceRefs.length === 0) {
		reject(ctx, "missing_evidence");
		ok = false;
	}
	const intentId = resolveRef(ctx, op.intentRef, "i", (x) =>
		ctx.next.intents.some((i) => i.id === x),
	);
	if (intentId === null) ok = false;
	else {
		const intent = findIntent(ctx, intentId);
		if (!intent || !isOpenIntent(intent)) {
			reject(ctx, "intent_not_open");
			ok = false;
		}
	}
	if (op.kind === "tool") {
		if (
			op.toolName === null ||
			op.toolInput === null ||
			!ctx.tools.some((t) => t.name === op.toolName)
		) {
			reject(ctx, "bad_tool");
			ok = false;
		}
	} else if (op.toolName !== null) {
		reject(ctx, "bad_tool");
		ok = false;
	}
	if (op.expireAfterHours > ctx.limits.expireAfterMaxHours) {
		reject(ctx, "limit_exceeded");
		ok = false;
	}
	const faultCode =
		ctx.repairCodes?.get(op.localId) ??
		op.evidenceRefs
			.map((r) => ctx.obs.get(r))
			.find((o) => o?.kind === "fault.observed" && o.code)?.code;
	let old: Candidate | undefined;
	let oldCascaded = false;
	if (op.supersedes !== null) {
		const oldId = resolveRef(ctx, op.supersedes, "c", (x) =>
			ctx.next.candidates.some((c) => c.id === x),
		);
		if (oldId === null) ok = false;
		else {
			old = findCandidate(ctx, oldId);
			// Already closed by this proposal's goal-terminal cascade: superseding is a no-op close.
			oldCascaded = old !== undefined && ctx.cascaded.has(old.id);
			if (!old || (!isOpenCandidate(old) && !oldCascaded)) {
				reject(ctx, "stale_revision");
				ok = false;
			} else {
				const lock = lockCode(ctx, old);
				if (lock !== null) {
					reject(ctx, lock);
					ok = false;
				}
			}
		}
	}
	if (!ok || intentId === null) {
		ctx.failed.add(op.localId);
		return;
	}
	if (old && oldCascaded) {
		// Closed (and revised) by the cascade already; only the reason becomes more specific.
		ctx.cascaded.delete(old.id);
		old.closedReason = "superseded";
	} else if (old) {
		closeCandidate(old, "superseded");
		ctx.touched.add(old.id);
	}
	ctx.next.candidates.push({
		id,
		revision: 1,
		intentId,
		kind: op.kind,
		content: op.content,
		toolName: op.kind === "tool" ? op.toolName : null,
		toolInput: op.kind === "tool" ? op.toolInput : null,
		createdSeq: ctx.floorSeq,
		applyWhen: op.applyWhen,
		expiresAt: ctx.now + hoursToMs(op.expireAfterHours),
		evidence: unique(op.evidenceRefs),
		state: "pending",
		holdReason: null,
		closedReason: null,
		supersedes: old?.id ?? null,
		...(faultCode !== undefined ? { faultCode } : {}),
	});
	ctx.touched.add(id);
};

/**
 * fulfilled needs evidence, and at least one cited observation must have arrived after the
 * candidate was created (an old response cannot show a later candidate was conveyed).
 */
const fulfilledEvidenceOk = (
	ctx: SettleCtx,
	c: Candidate,
	op: { evidenceRefs: readonly string[] },
): boolean => {
	if (op.evidenceRefs.length === 0) {
		reject(ctx, "missing_evidence");
		return false;
	}
	if (!hasNewerThan(ctx, op.evidenceRefs, c.createdSeq ?? 0)) {
		reject(ctx, "stale_evidence");
		return false;
	}
	return true;
};

export const applyCandidateClose = (
	ctx: SettleCtx,
	op: Of<"candidate.close">,
) => {
	const c = findCandidate(ctx, op.id);
	const cascadedFrom = ctx.cascaded.get(op.id);
	if (c && cascadedFrom !== undefined) {
		// Already closed by this proposal's goal-terminal cascade: expectedRevision is judged
		// against what the model saw. The explicit reason replaces "goal_terminal" (more specific).
		if (op.expectedRevision !== cascadedFrom) {
			reject(ctx, "stale_revision");
			return;
		}
		if (!evidenceOk(ctx, op.evidenceRefs)) return;
		if (op.reason === "fulfilled" && !fulfilledEvidenceOk(ctx, c, op)) return;
		ctx.cascaded.delete(op.id);
		c.closedReason = op.reason;
		c.evidence = unique([...c.evidence, ...op.evidenceRefs]);
		return;
	}
	if (!checkExisting(ctx, c, isOpenCandidate, op.expectedRevision)) return;
	const lock = lockCode(ctx, c);
	if (lock !== null) {
		reject(ctx, lock);
		return;
	}
	let ok = evidenceOk(ctx, op.evidenceRefs);
	if (op.reason === "fulfilled" && !fulfilledEvidenceOk(ctx, c, op)) ok = false;
	if (!ok) return;
	closeCandidate(c, op.reason);
	c.evidence = unique([...c.evidence, ...op.evidenceRefs]);
	ctx.touched.add(c.id);
};

/** A normal response (actor agent, exchange.adopted) already conveyed the candidate. */
export const applyReconciliation = (
	ctx: SettleCtx,
	r: { candidateId: string; observationRef: string },
) => {
	const c = findCandidate(ctx, r.candidateId);
	const o = ctx.obs.get(r.observationRef);
	const lock = c ? lockCode(ctx, c) : null;
	if (lock !== null) {
		reject(ctx, lock);
		return;
	}
	// A candidate already closed by this proposal's goal-terminal cascade is still reconcilable.
	const cascaded = c !== undefined && ctx.cascaded.has(c.id);
	if (
		!c ||
		(!isOpenCandidate(c) && !cascaded) ||
		!o ||
		o.kind !== "exchange.adopted" ||
		o.actor !== "agent" ||
		// The response must have arrived after the candidate was created.
		o.seq <= (c.createdSeq ?? 0)
	) {
		reject(ctx, "bad_reconciliation");
		return;
	}
	if (cascaded) {
		// Closed (and revised) by the cascade already; only the reason changes.
		ctx.cascaded.delete(c.id);
		c.closedReason = "fulfilled";
		c.evidence = unique([...c.evidence, o.id]);
		return;
	}
	closeCandidate(c, "fulfilled");
	c.evidence = unique([...c.evidence, o.id]);
	ctx.touched.add(c.id);
};

/**
 * P5-b: a repair proposal (or approval-gated change) that would change Agency's own limits,
 * grants, approvals, guards or context. The host never accepts these (plan §5.7-5).
 * Only applied to fault-tied or approval-gated candidates, so ordinary talk about a user's
 * budget is never checked. Deterministic and conservative: (1) a deny-list of constraint
 * fields/config names, (2) an object (approval, limit, guard, …) near a weakening verb in
 * either order, Japanese or English. Normalized first (NFKC, lowercase, no spaces). The
 * approval gate on change tools remains the last line of defense.
 */
const constraintFields =
	/(requiresapproval|approval_required|repairguard|activitylimits|wakeconfig|reporttts|dailylimit|faultquietms|work_stale_ms|outboundintervalms|minintervalms|systemcontext|limitsschema|budgetconfig|defaultlimits|defaultbudget|grants?\b|\blimits\b)/;
const constraintObjects =
	"(承認|許可|確認|審査|レビュー|上限|制限|限度|予算|権限|安全|制約|ガード|ゲート|クールダウン|冷却|回数制限|日上限|approval|permission|limit|quota|budget|guard|gate|cooldown|constraint|safety|sandbox|allowlist|denylist)";
const weakening =
	"(不要|なし|無し|なく|無く|外|はず|撤廃|廃止|無効|オフ|切|緩|ゆる|増|上げ|引き上|拡大|広げ|付与|スキップ|省略|飛ば|バイパス|回避|迂回|無視|解除|取り除|削除|消|bypass|skip|disable|remove|raise|increase|relax|lift|loosen|ignore|turnoff|drop|override|without|unlimited|grant)";
const nearA = new RegExp(`${constraintObjects}.{0,12}${weakening}`);
const nearB = new RegExp(`${weakening}.{0,12}${constraintObjects}`);
const ownScope =
	/(自分|自身|agency|エージェント|自己)の?(権限|上限|制約|設定|予算)/;
export const targetsOwnConstraints = (text: string): boolean => {
	const raw = text.normalize("NFKC").toLowerCase();
	const t = raw.replace(/\s+/g, "");
	return (
		constraintFields.test(raw.replace(/\s+/g, " ")) ||
		constraintFields.test(t) ||
		nearA.test(t) ||
		nearB.test(t) ||
		ownScope.test(t)
	);
};
