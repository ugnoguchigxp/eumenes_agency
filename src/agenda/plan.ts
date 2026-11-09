/**
 * The plan: on new information the model proposes what to add and drop; code applies what holds
 * (refs it was shown, the user's words behind research, one note per topic, no repeated theme).
 */
import { callModel } from "../application/model-call.ts";
import {
	OPEN_LIMITS,
	PLAN_ADD_LIMITS,
	planSchema,
	SAME_THEME_OVERLAP,
	type AgendaItem,
	type AgendaKind,
	type PlanOutcome,
} from "./contracts.ts";
import { profileOf } from "./profile.ts";
import { planData } from "./prompt.ts";
import {
	clock,
	known,
	makeItem,
	notes,
	record,
	unlimited,
	wantPlan,
	type AgendaState,
} from "./state.ts";
import { normalize, themeOverlap } from "./text.ts";

const noteRef = (r: string) => (r.startsWith("note:") ? r.slice(5) : null);

const nothing = (call: PlanOutcome["call"]): PlanOutcome => ({
	added: [],
	dropped: [],
	rejected: [],
	reasons: [],
	call,
});

export async function plan(
	st: AgendaState,
	now: number,
	signal: AbortSignal,
): Promise<PlanOutcome> {
	const startEpoch = st.epoch;
	const startGen = st.planGen;
	// This plan digs (nothing was left to say); a new dig needs a new reason.
	const digging = st.dig;
	st.dig = false;
	const knownNow = known(st);
	const notesNow = notes(st);
	const profileNow = profileOf(st);
	const researching = st.researching;
	const prompt = planData({
		now,
		clock: clock(st, now),
		said: st.said,
		items: st.items,
		known: knownNow,
		profile: profileNow,
		notes: notesNow,
		researching: researching
			? (st.items.find((i) => i.id === researching.ticket.itemId) ?? null)
			: null,
		quiet: st.quiet,
		userDeclines: st.userDeclines,
		nothingToSay: digging,
		refusedLastDig: digging ? st.refusedLastDig : [],
	});
	const call = await callModel(
		st.deps.llm,
		unlimited,
		{
			purpose: "think",
			at: now,
			system: st.instructions.plan,
			prompt,
			schema: planSchema,
			maxOutputTokens: 1500,
		},
		signal,
	);
	if (!call.ok) {
		const code = call.outcome.code === "aborted" ? "aborted" : "failed";
		// A failed plan is not retried in a loop: the next new information plans again.
		if (code === "failed") {
			if (st.planGen === startGen) st.planDue = false;
			st.lastPlanAt = now;
		}
		return nothing(record("plan", now, null, false, code));
	}
	// The user spoke while the plan was out: it may add what was just answered. Plan again.
	if (st.epoch !== startEpoch)
		return nothing(record("plan", now, call.usage, false, "stale"));
	// What came while it was out (a returned note, a memory change) is planned on next.
	if (st.planGen === startGen) st.planDue = false;
	st.lastPlanAt = now;
	const refsKnown = new Set([
		...st.said.map((s) => s.id),
		...knownNow.map((k) => `memory:${k.id}`),
		...profileNow.map((l) => `profile:${l.id}`),
		...notesNow.map((x) => `note:${x.id}`),
	]);
	const userSaid = new Set(
		st.said.filter((s) => s.who === "user").map((s) => s.id),
	);
	const rejected: string[] = [];
	const refused: { kind: string; text: string; why: string }[] = [];
	const reasons: string[] = [];
	const dropped: string[] = [];
	for (const d of call.value.drop) {
		const item = st.items.find((i) => i.id === d.id && i.status === "open");
		if (!item) {
			rejected.push(`drop:${d.id}:not_open`);
			continue;
		}
		item.status = "dropped";
		item.endedAt = now;
		dropped.push(item.id);
		reasons.push(`drop ${item.id}: ${d.reason}`);
	}
	const added: AgendaItem[] = [];
	const addedPer: Record<AgendaKind, number> = { ask: 0, research: 0, talk: 0 };
	for (const a of call.value.add) {
		const text = a.text.trim();
		const refs = [...new Set(a.refs)];
		const open = st.items.filter(
			(i) => i.kind === a.kind && (i.status === "open" || i.status === "doing"),
		).length;
		const why = (code: string) => {
			rejected.push(`${a.kind}:${code}`);
			refused.push({ kind: a.kind, text: a.text.trim(), why: code });
		};
		if (text === "") {
			why("empty");
			continue;
		}
		if (addedPer[a.kind] >= PLAN_ADD_LIMITS[a.kind]) {
			why("too_many");
			continue;
		}
		if (open >= OPEN_LIMITS[a.kind]) {
			why("open_limit");
			continue;
		}
		if (refs.some((r) => !refsKnown.has(r))) {
			why("unknown_ref");
			continue;
		}
		// Research rests on what the user said: their words, the memory of them, their plans and
		// interests, or a note that came from those. The agent's own words alone never start it.
		if (
			a.kind === "research" &&
			!refs.some(
				(r) =>
					userSaid.has(r) ||
					r.startsWith("memory:") ||
					r.startsWith("profile:") ||
					r.startsWith("note:"),
			)
		) {
			why("needs_user_reason");
			continue;
		}
		const noteIds = refs.map(noteRef).filter((x): x is string => x !== null);
		// A topic rests on one note, or, without one, on the user's words it answers: the agent's
		// own thought or what it knows about what the user is talking about.
		if (
			a.kind === "talk" &&
			(noteIds.length > 1 ||
				(noteIds.length === 0 && !refs.some((r) => userSaid.has(r))))
		) {
			why("needs_one_note");
			continue;
		}
		const noteId = a.kind === "talk" ? (noteIds[0] ?? null) : null;
		if (
			noteId !== null &&
			st.items.some(
				(i) =>
					i.kind === "talk" && i.noteId === noteId && i.status !== "dropped",
			)
		) {
			why("note_already_talked");
			continue;
		}
		const same = normalize(text);
		if (
			st.items.some(
				(i) =>
					i.kind === a.kind &&
					i.status !== "dropped" &&
					normalize(i.text) === same,
			)
		) {
			why("duplicate");
			continue;
		}
		// The same theme again brings the same result back: compare with every earlier
		// research and every note (this session's or an earlier one's).
		if (
			a.kind === "research" &&
			[
				...st.items
					.filter((i) => i.kind === "research")
					.map((i) => i.checkedRequest ?? i.text),
				...notesNow.map((x) => `${x.title}${x.summary}`),
			].some((t) => themeOverlap(text, t) >= SAME_THEME_OVERLAP)
		) {
			why("same_theme");
			continue;
		}
		const item = makeItem(st, {
			kind: a.kind,
			text,
			refs,
			value: a.value,
			reason: a.reason,
			noteId,
			createdAt: now,
		});
		st.items.push(item);
		added.push(item);
		addedPer[a.kind]++;
		reasons.push(`${item.kind} ${item.id}: ${a.reason}`);
	}
	// A dig: no other until something new comes. One whose every proposal was refused (a theme
	// researched already, say) digs once more at once, shown what was refused and why: running
	// out of things to say is not decided on one try (user, 2026-11-09: "判定が浅すぎ").
	if (digging) {
		st.dugAt = now;
		if (added.length === 0 && refused.length > 0 && !st.digRetried) {
			st.digRetried = true;
			st.refusedLastDig = refused;
			st.dig = true;
			wantPlan(st);
		} else {
			st.digRetried = false;
			st.refusedLastDig = [];
		}
	}
	return {
		added,
		dropped,
		rejected,
		reasons,
		call: record(
			"plan",
			now,
			call.usage,
			added.length + dropped.length > 0,
			"applied",
		),
	};
}
