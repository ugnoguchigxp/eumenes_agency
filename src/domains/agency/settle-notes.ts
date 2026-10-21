import type { B1Update } from "../../contracts/proposals.ts";
import { unique } from "./ids.ts";
import { evidenceOk, reject, type SettleCtx } from "./settle-context.ts";

type Op = B1Update["ops"][number];
type Of<K extends Op["op"]> = Extract<Op, { op: K }>;

export const applyNoteAdd = (ctx: SettleCtx, op: Of<"note.add">) => {
	const id = ctx.local.get(op.localId);
	if (id === undefined) return;
	if (!evidenceOk(ctx, op.evidenceRefs)) {
		ctx.failed.add(op.localId);
		return;
	}
	ctx.next.notes.push({
		id,
		revision: 1,
		text: op.text,
		evidence: unique(op.evidenceRefs),
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
	n.text = op.text;
	// Accumulates like intents: the note keeps every observation it was ever grounded on.
	n.evidence = unique([...n.evidence, ...op.evidenceRefs]);
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
