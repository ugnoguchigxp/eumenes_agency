/**
 * The host's marks on its records (`AgendaMarks`) as rules over the agent's items: what rests on a
 * corrected record is held until the host clears the mark; what rests on a suppressed record, or
 * speaks of a suppressed topic, is not brought up at all. Pure rules over the state; no model call.
 */
import type { AgendaItem } from "./contracts.ts";
import { notes, type AgendaState } from "./state.ts";
import { normalize } from "./text.ts";

/** `review`: held until the mark is cleared. `suppressed`: not planned, researched or said. */
export type Held = "review" | "suppressed";

/** A topic word shorter than this (normalized) matches too much to mean anything. */
const MIN_TOPIC = 2;

const marksOf = (st: AgendaState) => {
	const m = st.deps.marks?.() ?? {};
	return {
		review: new Set(m.underReview ?? []),
		refs: new Set(m.suppressedRefs ?? []),
		topics: (m.suppressedTopics ?? [])
			.map(normalize)
			.filter((t) => t.length >= MIN_TOPIC),
	};
};

const speaksOf = (topics: readonly string[], ...texts: readonly string[]) => {
	const said = texts.map(normalize);
	return topics.some((t) => said.some((x) => x.includes(t)));
};

/**
 * Why a record the host selected must not be shown to the agent (null: it may). The host leaves
 * such records out already (spec §5.4); this is the second guard.
 */
export function recordHeld(
	st: AgendaState,
	ref: string,
	text: string,
): Held | null {
	const m = marksOf(st);
	if (m.refs.has(ref) || speaksOf(m.topics, text)) return "suppressed";
	return m.review.has(ref) ? "review" : null;
}

/**
 * Why what rests on `refs` and speaks of `texts` must not be written, said or (suppressed only)
 * researched: a ref, or a ref of a note it cites, carries a mark, or a text speaks of a
 * suppressed topic. Suppression wins over review.
 */
export function heldWhy(
	st: AgendaState,
	refs: readonly string[],
	texts: readonly string[],
): Held | null {
	const m = marksOf(st);
	if (m.review.size === 0 && m.refs.size === 0 && m.topics.length === 0)
		return null;
	const noteIds = new Set(
		refs.flatMap((r) => (r.startsWith("note:") ? [r.slice(5)] : [])),
	);
	const cites = notes(st).filter((n) => noteIds.has(n.id));
	const all = [...refs, ...cites.flatMap((n) => n.refs)];
	if (
		all.some((r) => m.refs.has(r)) ||
		speaksOf(m.topics, ...texts, ...cites.flatMap((n) => [n.title, n.summary]))
	)
		return "suppressed";
	return all.some((r) => m.review.has(r)) ? "review" : null;
}

/** Why an item is held: its refs (and its note's), its text or its topic carry a mark. */
export const heldReason = (st: AgendaState, i: AgendaItem): Held | null =>
	heldWhy(
		st,
		[...i.refs, ...(i.noteId ? [`note:${i.noteId}`] : [])],
		[i.text, i.topic ?? ""],
	);

/** An item that may go out as speech (ask, talk, an offer in a reply): not held in any way. */
export const speechHeld = (st: AgendaState, i: AgendaItem) =>
	heldReason(st, i) !== null;

/** An item that may go to the researcher: only a suppressed one does not. */
export const workHeld = (st: AgendaState, i: AgendaItem) =>
	heldReason(st, i) === "suppressed";

/** Does `text` speak of a suppressed topic (for what the plan proposes)? */
export const speaksOfSuppressed = (st: AgendaState, ...texts: string[]) =>
	speaksOf(marksOf(st).topics, ...texts);

/** The suppressed topic words, as the host gave them (shown to the plan: do not raise these). */
export const suppressedTopics = (st: AgendaState) =>
	(st.deps.marks?.().suppressedTopics ?? []).filter(
		(t) => normalize(t).length >= MIN_TOPIC,
	);
