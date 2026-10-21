import type { Candidate, Intent, IntentState } from "../../contracts/model.ts";
import { isOpenCandidate, isOpenIntent } from "../../contracts/model.ts";
import type { B2Update, FUpdate } from "../../contracts/proposals.ts";
import { unique } from "./ids.ts";
import {
	closeCandidate,
	closeCandidatesOfIntent,
	isInFlight,
} from "./lifecycle.ts";
import {
	evidenceOk,
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
		createdSeq: ctx.maxPresentedSeq,
		createdAt: ctx.now,
		lastReason: op.motive,
	});
	ctx.touched.add(id);
};

const hasExternalNewer = (
	ctx: SettleCtx,
	intent: Intent,
	refs: readonly string[],
) =>
	refs.some((r) => {
		const o = ctx.obs.get(r);
		return (
			o !== undefined && isIndependent(ctx, o) && o.seq > intent.createdSeq
		);
	});

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
	if (!ok) return;
	if (transition !== null) intent.state = transition;
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
		closeCandidatesOfIntent(ctx.next, intent.id, ctx.touched);
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
	let old: Candidate | undefined;
	if (op.supersedes !== null) {
		const oldId = resolveRef(ctx, op.supersedes, "c", (x) =>
			ctx.next.candidates.some((c) => c.id === x),
		);
		if (oldId === null) ok = false;
		else {
			old = findCandidate(ctx, oldId);
			if (!old || !isOpenCandidate(old)) {
				reject(ctx, "stale_revision");
				ok = false;
			} else if (isInFlight(old)) {
				reject(ctx, "candidate_in_flight");
				ok = false;
			}
		}
	}
	if (!ok || intentId === null) {
		ctx.failed.add(op.localId);
		return;
	}
	if (old) {
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
		applyWhen: op.applyWhen,
		expiresAt: ctx.now + hoursToMs(op.expireAfterHours),
		evidence: unique(op.evidenceRefs),
		state: "pending",
		holdReason: null,
		closedReason: null,
		supersedes: old?.id ?? null,
	});
	ctx.touched.add(id);
};

export const applyCandidateClose = (
	ctx: SettleCtx,
	op: Of<"candidate.close">,
) => {
	const c = findCandidate(ctx, op.id);
	if (!checkExisting(ctx, c, isOpenCandidate, op.expectedRevision)) return;
	if (isInFlight(c)) {
		reject(ctx, "candidate_in_flight");
		return;
	}
	let ok = evidenceOk(ctx, op.evidenceRefs);
	if (op.reason === "fulfilled" && op.evidenceRefs.length === 0) {
		reject(ctx, "missing_evidence");
		ok = false;
	}
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
	if (c && isInFlight(c)) {
		reject(ctx, "candidate_in_flight");
		return;
	}
	if (
		!c ||
		!isOpenCandidate(c) ||
		!o ||
		o.kind !== "exchange.adopted" ||
		o.actor !== "agent"
	) {
		reject(ctx, "bad_reconciliation");
		return;
	}
	closeCandidate(c, "fulfilled");
	c.evidence = unique([...c.evidence, o.id]);
	ctx.touched.add(c.id);
};
