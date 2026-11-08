/**
 * The utterance for the one item code picked: the model writes it or declines; code refuses
 * repeats, extra questions and either-or questions, and says nothing that went stale meanwhile.
 */
import { callModel } from "../application/model-call.ts";
import {
	composeSchema,
	DECLINE_DEFER_MS,
	type AgendaItem,
	type AgendaTicket,
	type CallRecord,
	type ComposeOutcome,
	type StepHost,
} from "./contracts.ts";
import { speechQuiet } from "./pacing.ts";
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
import { normalize, questionMarks, sentences } from "./text.ts";

export async function compose(
	st: AgendaState,
	item: AgendaItem,
	now: number,
	host: () => StepHost,
	signal: AbortSignal,
): Promise<{ outcome: ComposeOutcome; ticket: AgendaTicket | null }> {
	const startEpoch = st.epoch;
	const note =
		item.noteId === null
			? null
			: (notes(st).find((x) => x.id === item.noteId) ?? null);
	const done = (
		declined: string | null,
		rejected: string[],
		call: CallRecord,
		ticket: AgendaTicket | null,
	) => ({ outcome: { itemId: item.id, declined, rejected, call }, ticket });
	if (item.kind === "talk" && note === null) {
		// The note is gone (deleted or forgotten): nothing to talk about.
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
		item.deferUntil = now + DECLINE_DEFER_MS;
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
	// New words or the user started typing while it was written: say nothing stale.
	if (
		st.epoch !== startEpoch ||
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
	const utterance = (call.value.utterance ?? "").trim();
	const rejected: string[] = [];
	if (utterance !== "") {
		// Whole or in part: a sentence the agent already said is not said again.
		const earlier = new Set(
			st.said
				.filter((s) => s.who !== "user")
				.flatMap((s) => [normalize(s.text), ...sentences(s.text)]),
		);
		if (
			earlier.has(normalize(utterance)) ||
			sentences(utterance).some((x) => earlier.has(x))
		)
			rejected.push("repeat");
		// One question per ask; a topic may open with "ご存じでしたか？" and still offer the note.
		if (
			questionMarks(utterance) > (item.kind === "ask" ? 1 : 2) ||
			(item.kind === "ask" && /それと|あと、|ついでに/u.test(utterance))
		)
			rejected.push("too_many_questions");
		// The user does not want to be made to pick one of two.
		if (item.kind === "ask" && /どちら(?!も)|どっち/u.test(utterance))
			rejected.push("either_or");
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
		if (item.declines >= 2) {
			item.status = "dropped";
			item.endedAt = now;
		} else item.deferUntil = now + DECLINE_DEFER_MS;
		// A question that does not fit now means questions do not: the others wait too.
		if (item.kind === "ask")
			for (const i of st.items)
				if (i.kind === "ask" && i.status === "open" && i !== item)
					i.deferUntil = Math.max(i.deferUntil ?? 0, now + DECLINE_DEFER_MS);
		return done(
			declined,
			rejected,
			record("compose", now, call.usage, false, "applied"),
			null,
		);
	}
	const ticket: AgendaTicket = {
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
	item.status = "doing";
	st.issued.set(ticket.id, ticket);
	return done(
		null,
		[],
		record("compose", now, call.usage, true, "applied"),
		ticket,
	);
}
