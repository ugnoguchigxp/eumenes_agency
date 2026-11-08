/**
 * When the agenda agent may speak and which item comes first: quiet periods, the shortest gap
 * and its back-off, questions waiting for an answer, and the flow of the conversation. Pure rules
 * over the state; no model call.
 */
import {
	ANSWER_WINDOW_MS,
	ENGAGED_MS,
	QUESTION_WAIT_MS,
	SPEECH_HOLD_MS,
	TOPIC_RECENT_MS,
	type AgendaItem,
} from "./contracts.ts";
import { notes, wantPlan, type AgendaState } from "./state.ts";
import { endsWithQuestion } from "./text.ts";

export const paused = (st: AgendaState, now: number) =>
	st.quiet.allUntil !== null && now < st.quiet.allUntil;

export const speechQuiet = (st: AgendaState, now: number) =>
	paused(st, now) ||
	(st.quiet.speechUntil !== null && now < st.quiet.speechUntil);

/** Quiet periods that have ended: the plan sees the new situation. */
export const endQuiet = (st: AgendaState, now: number) => {
	if (st.quiet.allUntil !== null && now >= st.quiet.allUntil) {
		st.lastQuietEnd = st.quiet.allUntil;
		st.quiet.allUntil = null;
		wantPlan(st);
	}
	if (st.quiet.speechUntil !== null && now >= st.quiet.speechUntil) {
		st.lastQuietEnd = st.quiet.speechUntil;
		st.quiet.speechUntil = null;
		wantPlan(st);
	}
};

/** The earliest time the agent may speak on its own (ignoring busy), or null when held. */
export const speechOpenAt = (st: AgendaState, now: number): number | null => {
	if (st.stopped) return null;
	let at = now;
	if (st.quiet.allUntil !== null && st.quiet.allUntil > at)
		at = st.quiet.allUntil;
	if (st.quiet.speechUntil !== null && st.quiet.speechUntil > at)
		at = st.quiet.speechUntil;
	const gap = st.intervalMs * 2 ** st.unanswered;
	// No talking to an empty room: past the hold, only the user's next words open it again.
	if (st.unanswered > 0 && gap > Math.max(SPEECH_HOLD_MS, st.intervalMs))
		return null;
	if (st.lastAgentAt !== null) {
		at = Math.max(
			at,
			st.lastAgentAt + (st.unanswered > 0 ? gap : st.intervalMs),
		);
		const waiting =
			st.lastAgentAsked &&
			(st.lastUserAt === null || st.lastUserAt <= st.lastAgentAt);
		if (waiting) at = Math.max(at, st.lastAgentAt + QUESTION_WAIT_MS);
	}
	return at;
};

/**
 * Its own question waits for the user's next words: no other question before them, even with a
 * topic brought up in between.
 */
export const askBlocked = (st: AgendaState) => st.ownAskPending;

export const order = (a: AgendaItem, b: AgendaItem) =>
	Number(b.requested || b.promised) - Number(a.requested || a.promised) ||
	b.value - a.value ||
	a.createdAt - b.createdAt;

/** The user is in the middle of a conversation (spoke a moment ago). */
const engaged = (st: AgendaState, now: number) =>
	st.lastUserAt !== null && now - st.lastUserAt < ENGAGED_MS;

/**
 * Does the item tie into what is being talked about: the user's or the agent's words of the
 * last few minutes, or a note made from them? What the user asked for always does.
 */
const connected = (st: AgendaState, i: AgendaItem, now: number) => {
	if (i.requested || i.promised) return true;
	const recent = new Set(
		st.said.filter((s) => now - s.at <= TOPIC_RECENT_MS).map((s) => s.id),
	);
	const fromRecent = (refs: readonly string[]) =>
		refs.some((r) => recent.has(r));
	if (fromRecent(i.refs)) return true;
	const noteIds = [
		...(i.noteId ? [i.noteId] : []),
		...i.refs.flatMap((r) => (r.startsWith("note:") ? [r.slice(5)] : [])),
	];
	return notes(st).some((n) => noteIds.includes(n.id) && fromRecent(n.refs));
};

/**
 * When an item may be said, as far as the flow of the conversation goes. In a conversation the
 * agent asks nothing on its own (what it wants to know goes into the reply, see replyAsk), and
 * brings up only what ties into it.
 */
export const topicOpenAt = (st: AgendaState, i: AgendaItem, now: number) => {
	if (!engaged(st, now)) return now;
	if (i.kind === "ask") return st.lastUserAt! + ENGAGED_MS;
	return connected(st, i, now) ? now : st.lastUserAt! + ENGAGED_MS;
};

/**
 * A question about something said in the conversation, once that talk is over (its words are
 * older than TOPIC_RECENT_MS): asked now it would come out of nowhere ("モンハンの話に戻りますね").
 */
export const topicGone = (st: AgendaState, i: AgendaItem, now: number) =>
	i.kind === "ask" &&
	i.refs.some((r) => !/^(?:memory|profile|note):/u.test(r)) &&
	!connected(st, i, now);

/**
 * The question the reply to the user's latest words may end with: the best open one that ties
 * into the conversation (any, when the conversation just began). None when those words answer a
 * question of the agent's (one question in two replies), or in a quiet period.
 */
export const replyAsk = (st: AgendaState, now: number): AgendaItem | null => {
	if (st.stopped || speechQuiet(st, now)) return null;
	const lastUser = (end: number) => {
		for (let j = end - 1; j >= 0; j--) if (st.said[j]!.who === "user") return j;
		return -1;
	};
	const k = lastUser(st.said.length);
	if (k < 0) return null;
	const user = st.said[k]!;
	const before = st.said[k - 1];
	if (
		before &&
		before.who !== "user" &&
		user.at - before.at <= ANSWER_WINDOW_MS &&
		endsWithQuestion(before.text)
	)
		return null;
	const asks = st.items
		.filter(
			(i) =>
				i.kind === "ask" &&
				i.status === "open" &&
				(i.deferUntil === null || i.deferUntil <= now) &&
				!topicGone(st, i, now),
		)
		.sort(order);
	const tied = asks.find((i) => connected(st, i, now));
	if (tied) return tied;
	const j = lastUser(k);
	const fresh = j < 0 || user.at - st.said[j]!.at >= ENGAGED_MS;
	return fresh ? (asks[0] ?? null) : null;
};

/** What may be said now, best first. */
export const speakable = (st: AgendaState, now: number) =>
	st.items
		.filter(
			(i) =>
				i.status === "open" &&
				(i.kind === "ask" || i.kind === "talk") &&
				(i.deferUntil === null || i.deferUntil <= now) &&
				!(i.kind === "ask" && askBlocked(st)) &&
				!topicGone(st, i, now) &&
				topicOpenAt(st, i, now) <= now,
		)
		.sort(order);

/** The research to start next, if any. */
export const nextResearch = (st: AgendaState, now: number) =>
	st.items
		.filter(
			(i) =>
				i.status === "open" &&
				i.kind === "research" &&
				(i.deferUntil === null || i.deferUntil <= now),
		)
		.sort(order)[0] ?? null;
