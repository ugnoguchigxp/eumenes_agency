import type { Belief, Confidence } from "../../contracts/model.ts";
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

/**
 * At least one ref that is independent evidence, not already counted, and newer than `floor`
 * (the creation point of the belief or desire, mirroring the intent completion rule).
 */
const hasIndependent = (
	ctx: SettleCtx,
	refs: readonly string[],
	counted: readonly string[],
	floor: number,
) =>
	refs.some((r) => {
		const o = ctx.obs.get(r);
		return (
			o !== undefined &&
			isIndependent(ctx, o) &&
			!counted.includes(r) &&
			o.seq > floor
		);
	});

const freshRefs = (ctx: SettleCtx, refs: readonly string[]) =>
	refs.filter((r) => ctx.batchIds.has(r));

/**
 * High confidence needs corroboration beyond a single tool result: a tool's output can carry
 * injected text (memory poisoning), so tool-only support needs two separate tool results.
 * Any qualifying non-tool observation (e.g. a user report) suffices on its own.
 */
const supportsHigh = (
	ctx: SettleCtx,
	refs: readonly string[],
	counted: readonly string[],
	floor: number,
) => {
	const fresh = [...new Set(refs)].filter((r) =>
		hasIndependent(ctx, [r], counted, floor),
	);
	const tool = fresh.filter((r) => ctx.obs.get(r)?.actor === "tool");
	// Missing call identities cannot establish distinct calls. Separate identified calls with
	// the same query cannot be told apart: observations carry no tool name or query.
	const calls = new Set(
		tool.flatMap((r) => {
			const id = ctx.obs.get(r)?.causationId;
			return id === undefined ? [] : [id];
		}),
	);
	return fresh.length > tool.length || calls.size >= 2;
};

/** Validate the atomic result so a correction cannot be bypassed by placing an add first. */
export const validateBeliefWrites = (
	ctx: SettleCtx,
	before: readonly Belief[],
	rewritten: ReadonlySet<string>,
) => {
	const existing = new Set(before.map((b) => b.id));
	for (const written of ctx.next.beliefs) {
		// Corrective writes must remain possible; the extra guard applies to active rewrites.
		if (
			existing.has(written.id) &&
			(!rewritten.has(written.id) || written.status !== "active")
		)
			continue;
		if (written.status !== "active" && written.status !== "disputed") continue;
		// Compare evidence per belief; a correction of another belief cannot consume fresh support.
		if (
			ctx.correctedBeliefs.some(
				(b) =>
					b.id !== written.id &&
					written.evidence.some((r) => {
						const o = ctx.obs.get(r);
						return (
							o !== undefined &&
							!isIndependent(ctx, o) &&
							b.evidence.includes(r)
						);
					}) &&
					!hasIndependent(ctx, freshRefs(ctx, written.evidence), b.evidence, 0),
			)
		) {
			reject(ctx, "retracted_evidence_reuse");
		}
	}
};

export const applyBeliefAdd = (ctx: SettleCtx, op: Of<"belief.add">) => {
	const id = ctx.local.get(op.localId);
	if (id === undefined) return;
	let ok = evidenceOk(ctx, op.evidenceRefs);
	// A new item has no earlier creation point: high confidence needs independent evidence that
	// came with the batch being interpreted, not an old observation that was already processed.
	if (
		op.confidence === "high" &&
		!supportsHigh(ctx, freshRefs(ctx, op.evidenceRefs), [], 0)
	) {
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
		createdSeq: ctx.floorSeq,
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
	// A disputed belief returns to active only with new independent evidence from this batch.
	if (
		b.status === "disputed" &&
		op.status === "active" &&
		!hasIndependent(ctx, freshRefs(ctx, op.evidenceRefs), b.evidence, 0)
	) {
		reject(ctx, "disputed_reactivation");
		ok = false;
	}
	// Writing a body while retaining high confidence must satisfy the same support rule as a
	// new high-confidence belief; keeping its id or confidence must not bypass that rule.
	if (
		op.status === "active" &&
		op.content !== null &&
		(op.confidence ?? b.confidence) === "high" &&
		!supportsHigh(ctx, freshRefs(ctx, op.evidenceRefs), b.evidence, 0)
	) {
		reject(ctx, "missing_evidence");
		ok = false;
	}
	if (op.confidence !== null && rank[op.confidence] > rank[b.confidence]) {
		if (!hasIndependent(ctx, op.evidenceRefs, b.evidence, b.createdSeq ?? 0)) {
			reject(ctx, "self_reinforcement");
			ok = false;
		} else if (
			op.confidence === "high" &&
			!supportsHigh(ctx, op.evidenceRefs, b.evidence, b.createdSeq ?? 0)
		) {
			reject(ctx, "missing_evidence");
			ok = false;
		}
	}
	if (!ok) return;
	b.status = op.status;
	if (op.content !== null) b.content = op.content;
	if (op.confidence !== null) b.confidence = op.confidence;
	b.evidence = unique([...b.evidence, ...op.evidenceRefs]);
	b.updatedSeq = ctx.floorSeq;
	b.revision += 1;
	if (b.status !== "active") ctx.correctedBeliefs.push(structuredClone(b));
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
		createdSeq: ctx.floorSeq,
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
	if (
		op.status === "satisfied" &&
		!hasIndependent(ctx, op.evidenceRefs, [], d.createdSeq ?? 0)
	) {
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
