import type { AgencyState, Condition } from "../contracts/model.ts";
import { isOpenCandidate, isOpenIntent } from "../contracts/model.ts";
import type { AgencyProjection, ProjectionItem } from "../contracts/runtime.ts";

const clip = (text: string, limit = 120) =>
	text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;

/** Live items only: terminal intents, closed candidates and ended beliefs/desires are skipped. */
const allItems = (state: AgencyState): Map<string, ProjectionItem> => {
	const m = new Map<string, ProjectionItem>();
	for (const i of state.intents.filter(isOpenIntent))
		m.set(i.id, { id: i.id, kind: "intent", text: clip(i.desiredState) });
	for (const c of state.candidates.filter(isOpenCandidate))
		m.set(c.id, { id: c.id, kind: "candidate", text: clip(c.content) });
	for (const n of state.notes)
		m.set(n.id, { id: n.id, kind: "note", text: clip(n.text) });
	for (const b of state.beliefs.filter(
		(x) => x.status === "active" || x.status === "disputed",
	))
		m.set(b.id, { id: b.id, kind: "belief", text: clip(b.content) });
	for (const d of state.desires.filter(
		(x) => x.status === "open" || x.status === "held",
	))
		m.set(d.id, { id: d.id, kind: "desire", text: clip(d.object) });
	return m;
};

/** Focus items first, then open intents and candidates (notes for B1). */
export const buildProjection = (
	condition: Condition,
	state: AgencyState,
	maxItems: number,
): AgencyProjection => {
	const base = { stateRevision: state.revision };
	if (condition === "B0") return { ...base, items: [], hidden: 0 };
	const items = allItems(state);
	const openIds =
		condition === "B1"
			? state.notes.map((n) => n.id)
			: [
					...state.intents.filter(isOpenIntent).map((i) => i.id),
					...state.candidates.filter(isOpenCandidate).map((c) => c.id),
				];
	const ordered = [...new Set([...state.focus, ...openIds])]
		.map((id) => items.get(id))
		.filter((x): x is ProjectionItem => x !== undefined);
	const shown = ordered.slice(0, Math.max(0, maxItems));
	return { ...base, items: shown, hidden: ordered.length - shown.length };
};
