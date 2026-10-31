import type { Note, NoteStatus } from "../../contracts/model.ts";
import type { B1Update } from "../../contracts/proposals.ts";
import { unique } from "./ids.ts";
import {
	evidenceOk,
	hoursToMs,
	isIndependent,
	reject,
	type SettleCtx,
} from "./settle-context.ts";

type Op = B1Update["ops"][number];
type Of<K extends Op["op"]> = Extract<Op, { op: K }>;

/**
 * Resolves derivation refs to item ids: a localId of this proposal (already assigned)
 * or an item of the current state (notes / intents / beliefs / desires / candidates).
 * Any ref that resolves to nothing rejects the proposal.
 */
const resolveDerivedFrom = (
	ctx: SettleCtx,
	refs: readonly string[],
): string[] | null => {
	const out: string[] = [];
	for (const r of refs) {
		const id = ctx.local.get(r) ?? r;
		const exists =
			ctx.next.notes.some((x) => x.id === id) ||
			ctx.next.intents.some((x) => x.id === id) ||
			ctx.next.beliefs.some((x) => x.id === id) ||
			ctx.next.desires.some((x) => x.id === id) ||
			ctx.next.candidates.some((x) => x.id === id);
		if (!exists) {
			reject(ctx, "unresolved_ref");
			return null;
		}
		if (!out.includes(id)) out.push(id);
	}
	return out;
};

/**
 * A question's interestRef must name a note of kind "interest": an existing one, or
 * one created earlier in this proposal (op ordering applies the interest first).
 */
const resolveInterestRef = (ctx: SettleCtx, ref: string): string | null => {
	const id = ctx.local.get(ref) ?? ref;
	const target = ctx.next.notes.find((x) => x.id === id);
	if (!target || target.kind !== "interest") {
		reject(ctx, "unresolved_ref");
		return null;
	}
	return id;
};

/**
 * Reactivation (interest) and resolution (question) need at least one cited observation
 * that is independent and newer than the note's last change — the same rule pattern as
 * intent completion (completion_without_external_evidence).
 */
const hasNewIndependent = (
	ctx: SettleCtx,
	n: Note,
	refs: readonly string[],
): boolean => {
	const floor = n.updatedSeq ?? n.createdSeq ?? 0;
	return refs.some((r) => {
		const o = ctx.obs.get(r);
		return o !== undefined && isIndependent(ctx, o) && o.seq > floor;
	});
};

export const applyNoteAdd = (ctx: SettleCtx, op: Of<"note.add">) => {
	const id = ctx.local.get(op.localId);
	if (id === undefined) return;
	if (!evidenceOk(ctx, op.evidenceRefs)) {
		ctx.failed.add(op.localId);
		return;
	}
	// Older callers may omit the typed-note fields entirely; absent reads as null / empty.
	const kind = op.kind ?? null;
	const status = op.status ?? null;
	const origin = op.origin ?? null;
	const derivedFromRefs = op.derivedFromRefs ?? [];
	const interestRef = op.interestRef ?? null;
	const reviewAfterHours = op.reviewAfterHours ?? null;
	let ok = true;
	let typedStatus: NoteStatus | undefined;
	let reviewAt: number | undefined;
	let derivedFrom: string[] | undefined;
	let resolvedInterestRef: string | undefined;
	if (kind === null) {
		// A plain memo carries none of the typed-note fields.
		if (
			status !== null ||
			origin !== null ||
			reviewAfterHours !== null ||
			interestRef !== null ||
			derivedFromRefs.length > 0
		) {
			reject(ctx, "note_kind_required");
			ok = false;
		}
	} else {
		if (kind === "interest") {
			if (origin === null) {
				reject(ctx, "missing_origin");
				ok = false;
			}
			if (interestRef !== null) {
				reject(ctx, "op_not_allowed");
				ok = false;
			}
			if (status === null) typedStatus = "active";
			else if (status === "active" || status === "dormant")
				typedStatus = status;
			else {
				reject(ctx, "illegal_transition");
				ok = false;
			}
		} else {
			// question: origin belongs to interests only.
			if (origin !== null) {
				reject(ctx, "op_not_allowed");
				ok = false;
			}
			if (status === null || status === "open") typedStatus = "open";
			else {
				reject(ctx, "illegal_transition");
				ok = false;
			}
			if (interestRef !== null) {
				const resolved = resolveInterestRef(ctx, interestRef);
				if (resolved === null) ok = false;
				else resolvedInterestRef = resolved;
			}
		}
		if (reviewAfterHours === null) {
			reject(ctx, "missing_review");
			ok = false;
		} else if (reviewAfterHours > ctx.limits.reviewAfterMaxHours) {
			reject(ctx, "limit_exceeded");
			ok = false;
		} else reviewAt = ctx.now + hoursToMs(reviewAfterHours);
		const resolved = resolveDerivedFrom(ctx, derivedFromRefs);
		if (resolved === null) ok = false;
		else derivedFrom = resolved;
	}
	if (!ok) {
		ctx.failed.add(op.localId);
		return;
	}
	ctx.next.notes.push({
		id,
		revision: 1,
		text: op.text,
		evidence: unique(op.evidenceRefs),
		...(kind === null
			? {}
			: {
					kind,
					// A typed note that passed validation always has both.
					status: typedStatus!,
					...(kind === "interest" && origin !== null ? { origin } : {}),
					derivedFrom: derivedFrom ?? [],
					...(resolvedInterestRef !== undefined
						? { interestRef: resolvedInterestRef }
						: {}),
					reviewAt: reviewAt!,
				}),
		createdSeq: ctx.floorSeq,
		updatedSeq: ctx.floorSeq,
	});
	ctx.touched.add(id);
};

export const applyNoteUpdate = (ctx: SettleCtx, op: Of<"note.update">) => {
	const n = ctx.next.notes.find((x) => x.id === op.id);
	if (!n) {
		reject(ctx, "unknown_ref");
		return;
	}
	if (n.revision !== op.expectedRevision) {
		reject(ctx, "stale_revision");
		return;
	}
	if (!evidenceOk(ctx, op.evidenceRefs)) return;
	// Older callers may omit the typed-note fields entirely; absent reads as null / empty.
	const status = op.status ?? null;
	const reviewAfterHours = op.reviewAfterHours ?? null;
	const derivedFromRefs = op.derivedFromRefs ?? [];
	const interestRef = op.interestRef ?? null;
	let ok = true;
	if (n.kind === undefined) {
		// A plain memo takes none of the typed-note fields.
		if (
			status !== null ||
			reviewAfterHours !== null ||
			interestRef !== null ||
			derivedFromRefs.length > 0
		) {
			reject(ctx, "note_kind_required");
			ok = false;
		}
	} else {
		if (status !== null && status !== n.status) {
			const from = n.status;
			// interest: active <-> dormant and -> retired are free; dormant/retired -> active
			// is a reactivation and needs new independent evidence. Anything else is illegal.
			// question: open -> retired is free; open -> resolved needs new independent
			// evidence; resolved / retired are terminal.
			const free =
				n.kind === "interest"
					? (from === "active" &&
							(status === "dormant" || status === "retired")) ||
						(from === "dormant" && status === "retired")
					: from === "open" && status === "retired";
			const gated =
				n.kind === "interest"
					? (from === "dormant" || from === "retired") && status === "active"
					: from === "open" && status === "resolved";
			if (gated) {
				if (!hasNewIndependent(ctx, n, op.evidenceRefs)) {
					reject(ctx, "completion_without_external_evidence");
					ok = false;
				}
			} else if (!free) {
				reject(ctx, "illegal_transition");
				ok = false;
			}
		}
		if (reviewAfterHours !== null) {
			if (reviewAfterHours > ctx.limits.reviewAfterMaxHours) {
				reject(ctx, "limit_exceeded");
				ok = false;
			}
		}
	}
	let derivedFrom: string[] | undefined;
	if (n.kind !== undefined && derivedFromRefs.length > 0) {
		const resolved = resolveDerivedFrom(ctx, derivedFromRefs);
		if (resolved === null) ok = false;
		// A note cannot derive from itself (an add cannot name itself either: the
		// note does not exist yet when its refs are resolved).
		else if (resolved.includes(n.id)) {
			reject(ctx, "unresolved_ref");
			ok = false;
		} else derivedFrom = resolved;
	}
	let resolvedInterestRef: string | undefined;
	if (n.kind !== undefined && interestRef !== null) {
		if (n.kind !== "question") {
			reject(ctx, "op_not_allowed");
			ok = false;
		} else {
			const resolved = resolveInterestRef(ctx, interestRef);
			if (resolved === null) ok = false;
			else resolvedInterestRef = resolved;
		}
	}
	if (!ok) return;
	n.text = op.text;
	// Accumulates like intents: the note keeps every observation it was ever grounded on.
	n.evidence = unique([...n.evidence, ...op.evidenceRefs]);
	if (n.kind !== undefined) {
		if (status !== null) n.status = status;
		if (reviewAfterHours !== null)
			n.reviewAt = ctx.now + hoursToMs(reviewAfterHours);
		if (derivedFrom !== undefined)
			n.derivedFrom = unique([...(n.derivedFrom ?? []), ...derivedFrom]);
		if (resolvedInterestRef !== undefined) n.interestRef = resolvedInterestRef;
	}
	n.updatedSeq = ctx.floorSeq;
	n.revision += 1;
	ctx.touched.add(n.id);
};

export const applyNoteDelete = (ctx: SettleCtx, op: Of<"note.delete">) => {
	const idx = ctx.next.notes.findIndex((x) => x.id === op.id);
	const n = ctx.next.notes[idx];
	if (!n) {
		reject(ctx, "unknown_ref");
		return;
	}
	if (n.revision !== op.expectedRevision) {
		reject(ctx, "stale_revision");
		return;
	}
	ctx.next.notes.splice(idx, 1);
	ctx.touched.add(n.id);
};
