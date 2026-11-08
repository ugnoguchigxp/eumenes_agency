/**
 * Forgetting (spec §1.3, S9): an observation the host forgets takes with it everything derived
 * from it, transitively. An item goes when anything it cites, aims at or was shown is gone; its
 * own ref (fact:, gap:, stock:, or the id of an agent-made observation) then counts as gone too,
 * until nothing changes. Agent-made observations (its own speech, returned work) carry the inputs
 * they rest on in `refs`.
 */
import type { Observation } from "../contracts/model.ts";
import type { AlwaysOnState } from "./contracts.ts";

export function forgetDerived(
	state: AlwaysOnState,
	observations: readonly Observation[],
	refs: Iterable<string>,
): { readonly observations: Observation[]; readonly gone: Set<string> } {
	const gone = new Set(refs);
	const hit = (xs: readonly (readonly string[] | undefined)[]) =>
		xs.some((x) => (x ?? []).some((r) => gone.has(r)));
	const mark = (
		ref: string,
		xs: readonly (readonly string[] | undefined)[],
	) => {
		if (gone.has(ref) || !hit(xs)) return false;
		gone.add(ref);
		return true;
	};
	for (let changed = true; changed;) {
		changed = false;
		for (const f of state.facts)
			changed = mark(`fact:${f.id}`, [f.evidence, f.inputs]) || changed;
		for (const g of state.gaps)
			changed = mark(`gap:${g.id}`, [g.evidence, g.inputs]) || changed;
		for (const s of state.stock)
			changed =
				mark(`stock:${s.id}`, [s.targets, s.sourceRefs, s.inputs]) || changed;
		for (const p of state.preparing)
			changed = mark(`prepare:${p.ticketId}`, [p.refs, p.inputs]) || changed;
		for (const o of observations) changed = mark(o.id, [o.refs]) || changed;
	}
	state.facts = state.facts.filter((f) => !gone.has(`fact:${f.id}`));
	state.gaps = state.gaps.filter((g) => !gone.has(`gap:${g.id}`));
	state.stock = state.stock.filter((s) => !gone.has(`stock:${s.id}`));
	state.preparing = state.preparing.filter(
		(p) => !gone.has(`prepare:${p.ticketId}`),
	);
	state.thoughts = state.thoughts.filter(
		(t) => !(t.inputs ?? []).some((i) => gone.has(i)),
	);
	return {
		observations: observations.filter((o) => !gone.has(o.id)),
		gone,
	};
}
