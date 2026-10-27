import type {
	AgencyState,
	Condition,
	Limits,
	Observation,
	ToolCapability,
} from "../../contracts/model.ts";
import { isOpenCandidate, isOpenIntent } from "../../contracts/model.ts";
import type { UpdateOp, UpdateProposal } from "../../contracts/proposals.ts";
import type { IdPrefix } from "./ids.ts";
import {
	applyBeliefAdd,
	applyBeliefUpdate,
	applyDesireAdd,
	applyDesireUpdate,
	validateBeliefWrites,
} from "./settle-beliefs.ts";
import { assignLocal, reject, type SettleCtx } from "./settle-context.ts";
import {
	applyCandidateAdd,
	applyCandidateClose,
	applyIntentAdd,
	applyIntentUpdate,
	applyReconciliation,
} from "./settle-intents.ts";
import {
	applyNoteAdd,
	applyNoteDelete,
	applyNoteUpdate,
} from "./settle-notes.ts";

export interface SettleInput {
	readonly condition: Condition;
	readonly state: AgencyState;
	readonly proposal: UpdateProposal;
	/** Observations presented in the call that produced the proposal. */
	readonly presented: readonly Observation[];
	/**
	 * The batch this update interprets (a subset of `presented`). Its highest seq is the
	 * "created after" floor for new items. Omitted: the whole presented set is the batch.
	 */
	readonly batch?: readonly Observation[];
	/** Floor when `batch` is empty (e.g. a review.due update): the ledger's processed cursor. */
	readonly cursor?: number;
	readonly tools: readonly ToolCapability[];
	readonly limits: Limits;
	readonly now: number;
}

export type SettleResult =
	| { kind: "applied"; state: AgencyState; touched: string[] }
	| { kind: "no_change"; state: AgencyState }
	| { kind: "rejected"; codes: string[] };

const noteOps = ["note.add", "note.update", "note.delete"];
const b2Ops = [
	"intent.add",
	"intent.update",
	"candidate.add",
	"candidate.close",
];
const fOps = [
	...b2Ops,
	"belief.add",
	"belief.update",
	"desire.add",
	"desire.update",
];
const allowedOps: Record<Condition, ReadonlySet<string>> = {
	B0: new Set(),
	B1: new Set(noteOps),
	B2: new Set(b2Ops),
	F: new Set(fOps),
};

const addPrefix: Record<string, IdPrefix | undefined> = {
	"intent.add": "i",
	"candidate.add": "c",
	"belief.add": "b",
	"desire.add": "d",
	"note.add": "n",
};

const localIdOf = (op: UpdateOp): string | null =>
	"localId" in op ? op.localId : null;

/** localIds of the same proposal that this op depends on. */
const localRefsOf = (op: UpdateOp): string[] => {
	switch (op.op) {
		case "intent.add":
			return op.desireRef === null ? [] : [op.desireRef];
		case "candidate.add":
			return op.supersedes === null
				? [op.intentRef]
				: [op.intentRef, op.supersedes];
		case "desire.add":
			return op.beliefRefs;
		default:
			return [];
	}
};

/** Stable topological order; ops left over form a dependency cycle. */
const orderOps = (
	ops: readonly UpdateOp[],
	skip: ReadonlySet<number>,
): { order: number[]; cyclic: boolean } => {
	const defined = new Map<string, number>();
	ops.forEach((op, i) => {
		const id = localIdOf(op);
		if (id !== null && !skip.has(i)) defined.set(id, i);
	});
	const deps = ops.map((op) =>
		localRefsOf(op).flatMap((r) => {
			const d = defined.get(r);
			return d === undefined ? [] : [d];
		}),
	);
	const done = new Set<number>(skip);
	const order: number[] = [];
	for (;;) {
		const next = ops.findIndex(
			(_, i) => !done.has(i) && (deps[i] ?? []).every((d) => done.has(d)),
		);
		if (next < 0) break;
		done.add(next);
		order.push(next);
	}
	return { order, cyclic: done.size < ops.length };
};

const dispatch = (ctx: SettleCtx, op: UpdateOp) => {
	switch (op.op) {
		case "note.add":
			return applyNoteAdd(ctx, op);
		case "note.update":
			return applyNoteUpdate(ctx, op);
		case "note.delete":
			return applyNoteDelete(ctx, op);
		case "intent.add":
			return applyIntentAdd(ctx, op);
		case "intent.update":
			return applyIntentUpdate(ctx, op);
		case "candidate.add":
			return applyCandidateAdd(ctx, op);
		case "candidate.close":
			return applyCandidateClose(ctx, op);
		case "belief.add":
			return applyBeliefAdd(ctx, op);
		case "belief.update":
			return applyBeliefUpdate(ctx, op);
		case "desire.add":
			return applyDesireAdd(ctx, op);
		case "desire.update":
			return applyDesireUpdate(ctx, op);
	}
};

const existingIds = (s: AgencyState): Set<string> =>
	new Set([
		...s.intents.map((x) => x.id),
		...s.candidates.map((x) => x.id),
		...s.beliefs.map((x) => x.id),
		...s.desires.map((x) => x.id),
		...s.notes.map((x) => x.id),
	]);

const liveBeliefsAndDesires = (s: AgencyState) =>
	s.beliefs.filter((b) => b.status === "active" || b.status === "disputed")
		.length +
	s.desires.filter((d) => d.status === "open" || d.status === "held").length;

const checkCapacity = (ctx: SettleCtx, ops: readonly UpdateOp[]) => {
	const adds = (prefix: string) =>
		ops.filter((o) => addPrefix[o.op] === prefix).length;
	const s = ctx.next;
	const l = ctx.limits;
	const over =
		(adds("i") > 0 && s.intents.filter(isOpenIntent).length > l.openIntents) ||
		(adds("c") > 0 &&
			s.candidates.filter(isOpenCandidate).length > l.openCandidates) ||
		(adds("b") + adds("d") > 0 &&
			liveBeliefsAndDesires(s) > l.beliefsAndDesires) ||
		(adds("n") > 0 && s.notes.length > l.notes);
	if (over) reject(ctx, "capacity");
};

/**
 * Validates one update proposal against the state and applies it atomically:
 * every op and reconciliation, or nothing. All reject codes are collected.
 */
export const settleUpdate = (input: SettleInput): SettleResult => {
	const { proposal } = input;
	const next = structuredClone(input.state);
	const obs = new Map(input.presented.map((o) => [o.id, o]));
	const batch = input.batch ?? input.presented;
	const floorSeq =
		batch.length > 0
			? batch.reduce((m, o) => Math.max(m, o.seq), 0)
			: (input.cursor ??
				input.presented.reduce((m, o) => Math.max(m, o.seq), 0));
	const ctx: SettleCtx = {
		condition: input.condition,
		next,
		obs,
		floorSeq,
		batchIds: new Set(batch.map((o) => o.id)),
		correctedBeliefs: input.state.beliefs.filter((b) => b.status !== "active"),
		tools: input.tools,
		limits: input.limits,
		now: input.now,
		codes: [],
		touched: new Set(),
		local: new Map(),
		failed: new Set(),
		cascaded: new Map(),
	};
	const ops: readonly UpdateOp[] = proposal.ops;
	const reconciliations =
		"reconciliations" in proposal ? proposal.reconciliations : [];
	const reconcileAllowed = input.condition === "B2" || input.condition === "F";

	const skip = new Set<number>();
	const taken = existingIds(next);
	ops.forEach((op, i) => {
		if (!allowedOps[input.condition].has(op.op)) {
			reject(ctx, "op_not_allowed");
			skip.add(i);
			return;
		}
		const localId = localIdOf(op);
		const prefix = addPrefix[op.op];
		if (localId === null || prefix === undefined) return;
		if (ctx.local.has(localId) || taken.has(localId)) {
			reject(ctx, "duplicate_local_id");
			skip.add(i);
			return;
		}
		assignLocal(ctx, localId, prefix);
	});
	if (reconciliations.length > 0 && !reconcileAllowed)
		reject(ctx, "op_not_allowed");

	const { order, cyclic } = orderOps(ops, skip);
	if (cyclic) reject(ctx, "dependency_cycle");
	for (const i of order) {
		const op = ops[i];
		if (op) dispatch(ctx, op);
	}
	validateBeliefWrites(
		ctx,
		input.state.beliefs,
		new Set(
			ops.flatMap((op) =>
				op.op === "belief.update" && op.content !== null ? [op.id] : [],
			),
		),
	);
	if (reconcileAllowed)
		for (const r of reconciliations) applyReconciliation(ctx, r);
	checkCapacity(ctx, ops);

	if (ctx.codes.length > 0) return { kind: "rejected", codes: ctx.codes };

	const exists = existingIds(next);
	next.focus = [...new Set(proposal.focusRefs.filter((f) => exists.has(f)))];
	if (ops.length === 0 && reconciliations.length === 0)
		return { kind: "no_change", state: next };
	next.revision += 1;
	return { kind: "applied", state: next, touched: [...ctx.touched] };
};
