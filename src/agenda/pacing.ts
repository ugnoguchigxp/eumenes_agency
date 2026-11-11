/**
 * When the agenda agent may speak and which item comes first: quiet periods, the shortest gap
 * and its back-off, questions waiting for an answer, and the flow of the conversation. Pure rules
 * over the state; no model call.
 */
import {
	ANSWER_WAIT_MS,
	ANSWER_WINDOW_MS,
	FRESH_TALK_MS,
	RESPONSE_WAIT_MS,
	TOPIC_CHANGE_MS,
	TOPIC_RECENT_MS,
	type AgendaItem,
} from "./contracts.ts";
import { notes, wantPlan, type AgendaState } from "./state.ts";
import { asksQuestion, normalize } from "./text.ts";

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

/**
 * The earliest time the agent may speak on its own (ignoring busy), or null when held; given an
 * item that does not tie into the talk, the earliest time it may change the topic to it.
 */
export const speechOpenAt = (
	st: AgendaState,
	now: number,
	item?: AgendaItem,
): number | null => {
	if (st.stopped) return null;
	let at = now;
	if (st.quiet.allUntil !== null && st.quiet.allUntil > at)
		at = st.quiet.allUntil;
	if (st.quiet.speechUntil !== null && st.quiet.speechUntil > at)
		at = st.quiet.speechUntil;
	// The set gap (user, 2026-11-09: "やや喧しいくらい"), but the user has time to respond first,
	// to answer what the agent asked, and a new topic comes a minute after the last words.
	if (st.lastAgentAt !== null)
		at = Math.max(
			at,
			st.lastAgentAt +
				Math.max(
					st.intervalMs,
					st.ownAskPending
						? ANSWER_WAIT_MS
						: item && !connected(st, item)
							? TOPIC_CHANGE_MS
							: RESPONSE_WAIT_MS,
				),
		);
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

/**
 * Does the item tie into what the user talks about now: the topic of their latest words, as the
 * plan named both (focus), or refs on their latest two lines, the agent's words since, or a note
 * made from them? What the user asked for always does. Any words of the last five minutes let a
 * question on the heater through twenty seconds after the user turned to a cat that had died
 * (the CLI, 2026-11-10 874 s; review 2026-11-10 evening 3.5).
 */
export const connected = (st: AgendaState, i: AgendaItem) =>
	i.requested ||
	i.promised ||
	onFocus(st, i) ||
	tiesToLatest(st, [...i.refs, ...(i.noteId ? [`note:${i.noteId}`] : [])]);

/**
 * Two names the plan gave are one topic: the same, or one inside the other ("猫" and "猫の話"),
 * as the plan names a topic anew at each call.
 */
export const sameTopic = (a: string | undefined, b: string | undefined) => {
	const x = normalize(a ?? "");
	const y = normalize(b ?? "");
	return x !== "" && y !== "" && (x.includes(y) || y.includes(x));
};

/**
 * The item's topic is the one the plan named for the user's latest words, or for the words before
 * them while the plan has not read the latest yet (the reply comes before that plan).
 */
export const onFocus = (st: AgendaState, i: AgendaItem) => {
	if (st.focus === null || !sameTopic(i.topic, st.focus.topic)) return false;
	const users = st.said.filter((s) => s.who === "user").slice(-2);
	return users.some((u) => u.id === st.focus!.userId);
};

/** Refs that tie into words in `recent`, or into a note made from them. */
const tiesTo = (
	st: AgendaState,
	refs: readonly string[],
	recent: ReadonlySet<string>,
) => {
	const fromRecent = (rs: readonly string[]) => rs.some((r) => recent.has(r));
	if (fromRecent(refs)) return true;
	const noteIds = refs.flatMap((r) =>
		r.startsWith("note:") ? [r.slice(5)] : [],
	);
	return notes(st).some((n) => noteIds.includes(n.id) && fromRecent(n.refs));
};

/** Refs on the user's latest two lines or the agent's words since, or a note made from them. */
export const tiesToLatest = (st: AgendaState, refs: readonly string[]) => {
	const users = st.said.filter((s) => s.who === "user");
	const from = users.at(-2) ?? users.at(-1);
	if (!from) return false;
	const since = st.said.slice(st.said.indexOf(from)).map((s) => s.id);
	return tiesTo(st, refs, new Set(since));
};

/** Refs on words of the last few minutes (anyone's), or a note made from them: the talk goes on. */
export const tiesIn = (st: AgendaState, refs: readonly string[], now: number) =>
	tiesTo(
		st,
		refs,
		new Set(
			st.said.filter((s) => now - s.at <= TOPIC_RECENT_MS).map((s) => s.id),
		),
	);

/**
 * A question about something said in the conversation, once that talk is over (its words are
 * older than TOPIC_RECENT_MS): asked now it would come out of nowhere ("モンハンの話に戻りますね").
 */
export const topicGone = (st: AgendaState, i: AgendaItem, now: number) =>
	i.kind === "ask" &&
	i.refs.some((r) => !/^(?:memory|profile|note):/u.test(r)) &&
	!i.requested &&
	!i.promised &&
	!tiesIn(st, [...i.refs, ...(i.noteId ? [`note:${i.noteId}`] : [])], now);

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
		asksQuestion(before.text)
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
	const tied = asks.find((i) => connected(st, i));
	if (tied) return tied;
	const j = lastUser(k);
	const fresh = j < 0 || user.at - st.said[j]!.at >= FRESH_TALK_MS;
	// The first words in a while may get a general question; one drawn from the memory, the
	// interests or a note only when it ties in (the CLI, 2026-11-10: "猫を飼ってるんですよ" got
	// "最近ジョギング以外で休日に楽しみにしていることは？", and "なんでジョギングの話を振りましたか？").
	return fresh ? (asks.find((i) => !drawsOnMemory(i.refs)) ?? null) : null;
};

/** Refs that draw on the memory, the user's plans and interests, or a note. */
export const drawsOnMemory = (refs: readonly string[]) =>
	refs.some((r) => /^(?:memory|profile|note):/u.test(r));

/**
 * A talk is going on (the user spoke within TOPIC_RECENT_MS): what is said ties into it. Topics
 * from elsewhere stay unsaid meanwhile, kept for later or never (user, 2026-11-09: "ユーザーの
 * フォーカスから外れている事をいきなり降ると違和感しかない…死蔵しても構わない"). With nothing that
 * ties in, it digs into the talk at once (canDig). Letting topics from elsewhere come after a dig
 * that found nothing (ag50-elsewhere, 2026-11-10, not adopted) broke into a game the user was
 * talking about, and the user asked for quiet.
 */
export const holdsElsewhere = (st: AgendaState, now: number) =>
	st.lastUserAt !== null && now - st.lastUserAt <= TOPIC_RECENT_MS;

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
				(!holdsElsewhere(st, now) || connected(st, i)),
		)
		.sort(order);

/**
 * Nothing left to say and nothing on the way: no question or topic may be said, no plan is due.
 * Then it digs into one of the user's interests (user, 2026-11-09: "興味を掘り進んでほしい"); a
 * dig that found nothing is not tried again until something new comes (then it idles; digging
 * again every three minutes, ag54-redig, 2026-11-10, not adopted, found the same theme again and
 * again, and the judge's pacing and honesty fell). While
 * speech is quiet (the user asleep, out, busy) nothing may be said, but work goes on: it digs
 * whenever no research runs or waits, to have something ready when the user is back (user,
 * 2026-11-09: "発話はしなくても、やるべき作業があるならやって構わない"). A pause stops it.
 */
export const canDig = (st: AgendaState, now: number) =>
	!st.stopped &&
	!paused(st, now) &&
	!st.planDue &&
	(speechQuiet(st, now)
		? st.researching === null && nextResearch(st, now) === null
		: speakable(st, now).length === 0 && st.ready === null) &&
	(st.dugAt === null || Math.max(st.lastInfoAt, st.lastUserAt ?? 0) > st.dugAt);

/** The research to start next, if any. */
export const nextResearch = (st: AgendaState, now: number) =>
	st.items
		.filter(
			(i) =>
				i.status === "open" &&
				i.kind === "research" &&
				(i.deferUntil === null || i.deferUntil <= now) &&
				// In a talk, only research that ties into it runs; the rest waits for the talk to end
				// (the CLI, 2026-11-10: five of ten looked into Qwen, Bezos, Neuro-sama... while the
				// user talked about the weather and Fable 5.2).
				(!holdsElsewhere(st, now) || connected(st, i)),
		)
		.sort(order)[0] ?? null;
