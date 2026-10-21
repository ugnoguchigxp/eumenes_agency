import type { Confidence } from "../../contracts/model.ts";
import type { FUpdate } from "../../contracts/proposals.ts";
import { unique } from "./ids.ts";
import {
	evidenceOk,
	isIndependent,
	reject,
	resolveRef,
	type SettleCtx,
} from "./settle-context.ts";

type Op = FUpdate["ops"][number];
type Of<K extends Op["op"]> = Extract<Op, { op: K }>;

const rank: Record<Confidence, number> = { low: 0, medium: 1, high: 2 };

/** At least one ref that is independent evidence and not already counted. */
const hasIndependent = (
	ctx: SettleCtx,
	refs: readonly string[],
	counted: readonly string[],
) =>
	refs.some((r) => {
		const o = ctx.obs.get(r);
		return o !== undefined && isIndependent(ctx, o) && !counted.includes(r);
	});

export const applyBeliefAdd = (ctx: SettleCtx, op: Of<"belief.add">) => {
	const id = ctx.local.get(op.localId);
	if (id === undefined) return;
	let ok = evidenceOk(ctx, op.evidenceRefs);
	if (op.confidence === "high" && !hasIndependent(ctx, op.evidenceRefs, [])) {
		reject(ctx, "missing_evidence");
		ok = false;
	}
	if (!ok) {
		ctx.failed.add(op.localId);
		return;
	}
	ctx.next.beliefs.push({
		id,
		revision: 1,
		content: op.content,
		confidence: op.confidence,
		evidence: unique(op.evidenceRefs),
		status: "active",
	});
	ctx.touched.add(id);
};

export const applyBeliefUpdate = (ctx: SettleCtx, op: Of<"belief.update">) => {
	const b = ctx.next.beliefs.find((x) => x.id === op.id);
	if (!b) {
		reject(ctx, "unknown_ref");
		return;
	}
	if (
		b.revision !== op.expectedRevision ||
		b.status === "superseded" ||
		b.status === "retracted"
	) {
		reject(ctx, "stale_revision");
		return;
	}
	let ok = evidenceOk(ctx, op.evidenceRefs);
	if (op.confidence !== null && rank[op.confidence] > rank[b.confidence]) {
		if (!hasIndependent(ctx, op.evidenceRefs, b.evidence)) {
			reject(ctx, "self_reinforcement");
			ok = false;
		}
	}
	if (!ok) return;
	b.status = op.status;
	if (op.content !== null) b.content = op.content;
	if (op.confidence !== null) b.confidence = op.confidence;
	b.evidence = unique([...b.evidence, ...op.evidenceRefs]);
	b.revision += 1;
	ctx.touched.add(b.id);
};

export const applyDesireAdd = (ctx: SettleCtx, op: Of<"desire.add">) => {
	const id = ctx.local.get(op.localId);
	if (id === undefined) return;
	let ok = evidenceOk(ctx, op.evidenceRefs);
	const beliefRefs: string[] = [];
	for (const ref of op.beliefRefs) {
		const resolved = resolveRef(ctx, ref, "b", (x) =>
			ctx.next.beliefs.some((b) => b.id === x),
		);
		if (resolved === null) ok = false;
		else beliefRefs.push(resolved);
	}
	if (!ok) {
		ctx.failed.add(op.localId);
		return;
	}
	ctx.next.desires.push({
		id,
		revision: 1,
		kind: op.kind,
		object: op.object,
		reason: op.reason,
		evidence: unique(op.evidenceRefs),
		beliefRefs: unique(beliefRefs),
		status: "open",
	});
	ctx.touched.add(id);
};

export const applyDesireUpdate = (ctx: SettleCtx, op: Of<"desire.update">) => {
	const d = ctx.next.desires.find((x) => x.id === op.id);
	if (!d) {
		reject(ctx, "unknown_ref");
		return;
	}
	if (
		d.revision !== op.expectedRevision ||
		d.status === "satisfied" ||
		d.status === "withdrawn"
	) {
		reject(ctx, "stale_revision");
		return;
	}
	let ok = evidenceOk(ctx, op.evidenceRefs);
	if (op.status === "satisfied" && !hasIndependent(ctx, op.evidenceRefs, [])) {
		reject(ctx, "missing_evidence");
		ok = false;
	}
	if (!ok) return;
	d.status = op.status;
	d.reason = op.reason;
	d.evidence = unique([...d.evidence, ...op.evidenceRefs]);
	d.revision += 1;
	ctx.touched.add(d.id);
};
