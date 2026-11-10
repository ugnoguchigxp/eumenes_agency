/**
 * The utterance for the one item code picked: the model writes it or declines; code refuses
 * repeats, extra questions and either-or questions (as the writer accounts for its words), and
 * says nothing that went stale meanwhile.
 */
import { callModel } from "../application/model-call.ts";
import {
	composeSchema,
	type AgendaItem,
	type AgendaTicket,
	type CallRecord,
	type ComposeOutcome,
	type StepHost,
} from "./contracts.ts";
import { speechQuiet } from "./pacing.ts";
import { profileOf } from "./profile.ts";
import { composeData } from "./prompt.ts";
import {
	clock,
	known,
	nextId,
	notes,
	record,
	unlimited,
	type AgendaState,
} from "./state.ts";
import { normalize, questionMarks, sentences, withoutSaid } from "./text.ts";

export type SpeakTicket = Extract<AgendaTicket, { kind: "speak" }>;

export async function compose(
	st: AgendaState,
	item: AgendaItem,
	now: number,
	host: () => StepHost,
	signal: AbortSignal,
): Promise<{ outcome: ComposeOutcome; ticket: SpeakTicket | null }> {
	const startEpoch = st.epoch;
	const note =
		item.noteId === null
			? null
			: (notes(st).find((x) => x.id === item.noteId) ?? null);
	const done = (
		declined: string | null,
		rejected: string[],
		call: CallRecord,
		ticket: SpeakTicket | null,
	) => ({ outcome: { itemId: item.id, declined, rejected, call }, ticket });
	if (item.kind === "talk" && item.noteId !== null && note === null) {
		// The note is gone (deleted or forgotten): nothing to talk about. A topic without a note
		// (the agent's own thought) is said as it is.
		item.status = "dropped";
		item.endedAt = now;
		return done(
			"note_gone",
			[],
			record("compose", now, null, false, "applied"),
			null,
		);
	}
	const call = await callModel(
		st.deps.llm,
		unlimited,
		{
			purpose: "think",
			at: now,
			system: st.instructions.compose,
			prompt: composeData({
				now,
				clock: clock(st, now),
				item,
				note,
				said: st.said,
				known: known(st),
				profile: profileOf(st),
				quietEndedSecAgo:
					st.lastQuietEnd === null
						? null
						: Math.round((now - st.lastQuietEnd) / 1000),
			}),
			schema: composeSchema,
			maxOutputTokens: 400,
		},
		signal,
	);
	if (!call.ok) {
		// A failed call is tried again at the next turn to speak, not ten minutes later; one
		// called off (the user spoke) at once.
		if (call.outcome.code !== "aborted") item.deferUntil = now + st.intervalMs;
		return done(
			null,
			[],
			record(
				"compose",
				now,
				null,
				false,
				call.outcome.code === "aborted" ? "aborted" : "failed",
			),
			null,
		);
	}
	// New words or the user started typing while it was written, or the plan dropped it
	// meanwhile (they run side by side): say nothing stale.
	if (
		st.epoch !== startEpoch ||
		item.status !== "open" ||
		host().busy ||
		st.stopped ||
		speechQuiet(st, now)
	)
		return done(
			null,
			[],
			record("compose", now, call.usage, false, "stale"),
			null,
		);
	let utterance = (call.value.utterance ?? "").trim();
	const rejected: string[] = [];
	if (utterance !== "") {
		// Whole or in part: a sentence the agent already said is not said again.
		const earlier = new Set(
			st.said
				.filter((s) => s.who !== "user")
				.flatMap((s) => [normalize(s.text), ...sentences(s.text)]),
		);
		// A topic is not held back for one sentence said before (by a reply, say): that sentence
		// goes, the rest is said (user, 2026-11-09: "そこでしらべたのになんで見送りするの？").
		if (item.kind === "talk") {
			const rest = withoutSaid(utterance, earlier);
			if (rest !== "") utterance = rest;
		}
		if (
			earlier.has(normalize(utterance)) ||
			sentences(utterance).some((x) => earlier.has(x))
		)
			rejected.push("repeat");
		// One question per ask; a topic may open with "ご存じでしたか？" and still offer the note.
		// What it asks and whether it makes the user pick are the writer's own account of its
		// words, not read from them here (a list of words caught "そのあと、" and "どちら").
		if (
			questionMarks(utterance) > (item.kind === "ask" ? 1 : 2) ||
			(item.kind === "ask" && call.value.questions > 1)
		)
			rejected.push("too_many_questions");
		// The user does not want to be made to pick one of two.
		if (item.kind === "ask" && call.value.choice) rejected.push("either_or");
	}
	const declined =
		utterance === ""
			? call.value.decline?.trim() || "no_utterance"
			: rejected.length
				? rejected.join(",")
				: null;
	if (declined !== null) {
		item.declines++;
		item.lastDecline = { reason: declined, at: now };
		// The model declines only what was said or answered already, or went stale: it goes. An
		// utterance code refused (a repeat, two questions, either-or) is written once more. Nothing
		// else waits for it (user, 2026-11-09: "見送りばっかりしてる"). Keeping what was declined "for
		// now" until the user's next words (ag52-decline, 2026-11-10, not adopted) brought the same
		// kind of question back again and again: the judge's questions fell (p=0.03).
		if (utterance === "" || item.declines >= 2) {
			item.status = "dropped";
			item.endedAt = now;
		}
		return done(
			declined,
			rejected,
			record("compose", now, call.usage, false, "applied"),
			null,
		);
	}
	// Not handed out here: the step says it (or holds it for the end of the gap) once it is sure
	// the user has not spoken and the plan has not dropped the item meanwhile.
	const ticket: SpeakTicket = {
		id: nextId(st, "t"),
		kind: "speak",
		itemId: item.id,
		itemKind: item.kind === "ask" ? "ask" : "talk",
		utterance,
		emotion: call.value.emotion,
		noteId: item.noteId,
		refs: [...item.refs],
		at: now,
	};
	return done(
		null,
		[],
		record("compose", now, call.usage, true, "applied"),
		ticket,
	);
}
