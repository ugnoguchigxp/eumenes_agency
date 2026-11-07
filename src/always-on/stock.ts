/**
 * Prepared material (spec §3.4). Findings are made by code from returned results, never written
 * by the model; ideas and questions are the agent's own. Items go stale and are dropped; an item
 * used in speech is marked so it is not repeated.
 */
import {
	FINDING_CHARS,
	FINDING_FRESH_MS,
	IDEA_FRESH_MS,
	PREPARING_TTL_MS,
	STOCK_LIMIT,
	type AlwaysOnState,
	type Preparing,
	type StockItem,
	type StockOp,
} from "./contracts.ts";

const bare = (id: string) => (id.startsWith("stock:") ? id.slice(6) : id);

/** Makes room by dropping used items first, then the oldest; false when nothing can go. */
const makeRoom = (state: AlwaysOnState): boolean => {
	if (state.stock.length < STOCK_LIMIT) return true;
	const victim =
		state.stock.find((s) => s.usedAt !== null) ??
		state.stock.find((s) => s.kind !== "finding") ??
		state.stock[0];
	if (!victim) return false;
	state.stock = state.stock.filter((s) => s !== victim);
	return true;
};

export function applyStockOps(
	state: AlwaysOnState,
	ops: readonly StockOp[],
	ctx: {
		readonly at: number;
		readonly known: (ref: string) => boolean;
		readonly nextId: (prefix: string) => string;
		/** Observation ids the tick was shown. */
		readonly inputs: readonly string[];
	},
): { applied: string[]; rejected: string[] } {
	const applied: string[] = [];
	const rejected: string[] = [];
	for (const op of ops) {
		const refuse = (code: string) => rejected.push(`${op.op}:${code}`);
		if (op.op === "stock.drop") {
			const id = op.id === null ? "" : bare(op.id);
			if (!state.stock.some((s) => s.id === id)) {
				refuse("unknown_stock");
				continue;
			}
			state.stock = state.stock.filter((s) => s.id !== id);
			applied.push(`stock.drop ${id}`);
			continue;
		}
		const text = op.text?.trim() ?? "";
		if (text === "") {
			refuse("missing_field");
			continue;
		}
		if (op.targets.some((r) => !ctx.known(r))) {
			refuse("unknown_ref");
			continue;
		}
		makeRoom(state);
		const id = ctx.nextId("s");
		state.stock.push({
			id,
			kind: op.op === "idea.add" ? "idea" : "question",
			text,
			targets: [...new Set(op.targets)],
			sourceRefs: [],
			inputs: [...ctx.inputs],
			at: ctx.at,
			freshUntil: ctx.at + IDEA_FRESH_MS,
			usedAt: null,
		});
		applied.push(`${op.op} ${id}`);
	}
	return { applied, rejected };
}

/** A returned preparation becomes a finding; its text is the host's result, cut to a bound. */
export function addFinding(
	state: AlwaysOnState,
	job: Preparing,
	observationId: string,
	summary: string,
	at: number,
	nextId: (prefix: string) => string,
): StockItem | null {
	const text = summary.trim().slice(0, FINDING_CHARS);
	if (text === "") return null;
	makeRoom(state);
	const item: StockItem = {
		id: nextId("s"),
		kind: "finding",
		text,
		targets: [...job.refs],
		sourceRefs: [observationId],
		inputs: [...(job.inputs ?? [])],
		at,
		freshUntil: at + FINDING_FRESH_MS,
		usedAt: null,
	};
	state.stock.push(item);
	return item;
}

/** Stale material goes; a preparation that never came back is given up. */
export const pruneStock = (state: AlwaysOnState, now: number) => {
	state.stock = state.stock.filter((s) => s.freshUntil > now);
	state.preparing = state.preparing.filter(
		(p) => p.at + PREPARING_TTL_MS > now,
	);
};

/**
 * What a retracted fact was for goes with it (S7): stock aimed at it and preparations asked for
 * it. Refs to items that no longer exist are orphans; only fact/gap/stock refs can vanish.
 */
export const dropOrphans = (state: AlwaysOnState): string[] => {
	const exists = new Set([
		...state.facts.map((f) => `fact:${f.id}`),
		...state.gaps.map((g) => `gap:${g.id}`),
		...state.stock.map((s) => `stock:${s.id}`),
	]);
	const orphan = (refs: readonly string[]) =>
		refs.some((r) => /^(fact|gap|stock):/.test(r) && !exists.has(r));
	const dropped = [
		...state.stock
			.filter((s) => orphan(s.targets))
			.map((s) => `stock.drop ${s.id}`),
		...state.preparing
			.filter((p) => orphan(p.refs))
			.map((p) => `prepare.drop ${p.ticketId}`),
	];
	state.stock = state.stock.filter((s) => !orphan(s.targets));
	state.preparing = state.preparing.filter((p) => !orphan(p.refs));
	return dropped;
};
