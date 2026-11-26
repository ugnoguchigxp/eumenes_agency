/**
 * The plan: on new information the model proposes what to add and drop; code applies what holds
 * (refs it was shown, the user's words behind research, one note per topic, no repeated theme).
 */
import { callModel } from "../application/model-call.ts";
import {
	OPEN_LIMITS,
	NOTE_FRESH_MS,
	PLAN_ADD_LIMITS,
	goalPlanSchema,
	planSchema,
	RESEARCH_RETRY_MS,
	SAME_THEME_OVERLAP,
	type AgendaItem,
	type AgendaKind,
	type GoalWorkPlan,
	type PlanOutcome,
	type PlanOutput,
} from "./contracts.ts";
import { ledgerEntry } from "./ask-check.ts";
import { heldReason, heldWhy, recordHeld, suppressedTopics } from "./marks.ts";
import {
	connected,
	drawsOnMemory,
	holdsElsewhere,
	isRecordRef,
	sameTopic,
	tiesToLatest,
} from "./pacing.ts";
import { asData, goalPlanInstructions, planData } from "./prompt.ts";
import {
	isAssignment,
	known,
	makeItem,
	notes,
	record,
	records,
	stampOf,
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
	// What the user asked not to bring up goes: its items are dropped, and the plan reads no record
	// that carries a mark (the host leaves them out too; this is the second guard).
	for (const i of st.items)
		if (i.status === "open" && heldReason(st, i) === "suppressed") {
			i.status = "dropped";
			i.endedAt = now;
		}
	const knownNow = known(st, { purpose: "plan" }).filter(
		(k) => recordHeld(st, `memory:${k.id}`, k.text) === null,
	);
	const hostNow = records(st, { purpose: "plan" });
	const plansNow = hostNow.plans.filter(
		(x) => recordHeld(st, `plan:${x.ref}`, x.text) === null,
	);
	const goalsNow = hostNow.goals.filter(
		(x) => recordHeld(st, `goal:${x.ref}`, x.text) === null,
	);
	const conflictsNow = hostNow.conflicts.filter(
		(x) => recordHeld(st, `conflict:${x.ref}`, x.text) === null,
	);
	const notesNow = notes(st);
	const researching = st.researching;
	const goalContext = st.deps.goalContext?.() ?? null;
	// The focus the plan names is that of the user's latest words as it reads them now.
	const latestUser = st.said.filter((s) => s.who === "user").at(-1) ?? null;
	const prompt = planData({
		now,
		stamp: stampOf(st),
		said: st.said,
		items: st.items.filter((i) => !isAssignment(i)),
		assignments: st.items.filter(
			(i) => isAssignment(i) && (i.status === "open" || i.status === "doing"),
		),
		known: knownNow,
		plans: plansNow,
		goals: goalsNow,
		conflicts: conflictsNow,
		questions: hostNow.questions,
		doNotRaise: suppressedTopics(st),
		notes: notesNow,
		researching: researching
			? (st.items.find((i) => i.id === researching.ticket.itemId) ?? null)
			: null,
		quiet: st.quiet,
		lastFocus: st.focus?.topic ?? null,
		nothingToSay: digging,
		refusedLastDig: digging ? st.refusedLastDig : [],
	});
	const call = await callModel<PlanOutput & { goalWork?: GoalWorkPlan }>(
		st.deps.llm,
		unlimited,
		{
			purpose: "think",
			at: now,
			system: goalContext
				? `${st.instructions.plan}\n\n${goalPlanInstructions}`
				: st.instructions.plan,
			prompt: goalContext
				? `${prompt}\n<goal_context>${asData(goalContext)}</goal_context>`
				: prompt,
			schema: goalContext ? goalPlanSchema : planSchema,
			maxOutputTokens: goalContext ? 2400 : 1500,
		},
		signal,
	);
	if (!call.ok) {
		const code = call.outcome.code === "aborted" ? "aborted" : "failed";
		// Called off (the user spoke): the dig it was is still owed.
		if (code === "aborted") st.dig ||= digging;
		// A failed plan is tried again shortly, not left until the next news (which could be an
		// hour away), and not in a tight loop either.
		if (code === "failed") {
			st.lastPlanAt = now;
			st.planRetryAt = now + RESEARCH_RETRY_MS;
		}
		return nothing(record("plan", now, null, false, code));
	}
	// The user spoke while the plan was out: it may add what was just answered. Plan again.
	if (st.epoch !== startEpoch)
		return nothing(record("plan", now, call.usage, false, "stale"));
	// What came while it was out (a returned note, a memory change) is planned on next.
	if (st.planGen === startGen) st.planDue = false;
	st.lastPlanAt = now;
	st.planRetryAt = null;
	const focus = call.value.focus.trim();
	if (latestUser && focus !== "")
		st.focus = { topic: focus, userId: latestUser.id };
	const refsKnown = new Set([
		...st.said.map((s) => s.id),
		...knownNow.map((k) => `memory:${k.id}`),
		...plansNow.map((x) => `plan:${x.ref}`),
		...goalsNow.map((x) => `goal:${x.ref}`),
		...conflictsNow.map((x) => `conflict:${x.ref}`),
		...notesNow.map((x) => `note:${x.id}`),
	]);
	const userSaid = new Set(
		st.said.filter((s) => s.who === "user").map((s) => s.id),
	);
	const rejected: string[] = [];
	const goalWork = st.planGen === startGen ? call.value.goalWork : undefined;
	const delegation = goalWork?.delegation;
	let proposal: PlanOutcome["goalWork"];
	if (goalContext && goalWork) {
		const goal = goalContext.goals.find(
			(g) =>
				g.id === delegation?.goalId && g.revision === delegation.goalRevision,
		);
		if (
			delegation &&
			(!goal ||
				!goalContext.toolchains.some(
					(t) => t.revisionId === delegation.toolchainRevisionId,
				) ||
				delegation.memoryIds.some(
					(id) => !goalContext.memory.some((m) => m.id === id),
				))
		) {
			rejected.push("goal:unknown_reference");
		} else if (delegation && goal?.phase === "wait") {
			rejected.push("goal:preparation_pending");
			proposal = {
				contextId: goalContext.id,
				analysis: goalWork.analysis,
				delegation: null,
			};
		} else {
			proposal = { contextId: goalContext.id, ...goalWork };
		}
	}
	const refused: { kind: string; text: string; why: string }[] = [];
	const reasons: string[] = [];
	const dropped: string[] = [];
	for (const d of call.value.drop) {
		const item = st.items.find((i) => i.id === d.id && i.status === "open");
		if (!item) {
			rejected.push(`drop:${d.id}:not_open`);
			continue;
		}
		// What the user asked for, or the reply took on, only the user calls off: not before they
		// speak again (the CLI, 2026-11-10: "-0.0 の舞台と見どころ" went seven seconds after the
		// reply took it on, as a repeat of a note that turned out to be about -1.0). A repeat is
		// for the check before it starts to find, and to tell.
		if (
			(item.requested || item.promised) &&
			!st.said.some((s) => s.who === "user" && s.at > item.createdAt)
		) {
			rejected.push(`drop:${d.id}:promised`);
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
		// Research held back in a talk (it does not tie in) leaves room for what does.
		const open = st.items.filter(
			(i) =>
				i.kind === a.kind &&
				!isAssignment(i) &&
				(i.status === "open" || i.status === "doing") &&
				!(
					i.kind === "research" &&
					i.status === "open" &&
					holdsElsewhere(st, now) &&
					!connected(st, i)
				),
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
		// What the user asked not to bring up is not planned; what rests on a corrected record
		// waits until the host has reviewed it.
		const held = heldWhy(st, refs, [text, a.topic]);
		if (held !== null) {
			why(held === "suppressed" ? "suppressed" : "under_review");
			continue;
		}
		// The question ledger: what was asked, answered, declined or put off is not asked again.
		if (a.kind === "ask") {
			const entry = ledgerEntry(text, hostNow.questions);
			if (entry) {
				why(`ledger_${entry.state}`);
				continue;
			}
		}
		// Research rests on what the user said: their words, the memory of them, their plans and
		// goals, or a note that came from those. The agent's own words alone never start it.
		if (
			a.kind === "research" &&
			!refs.some((r) => userSaid.has(r) || isRecordRef(r))
		) {
			why("needs_user_reason");
			continue;
		}
		// In a talk, what is drawn from the memory, the interests or a note ties into it too: the
		// user's latest words among its refs, or a note made from them (user, 2026-11-10: "Qwenとか
		// ダリオアモデイとか、今の会話に関係無いメモリを拾ってくるべきでは無い…共通点があるなら優秀").
		if (
			holdsElsewhere(st, now) &&
			drawsOnMemory(refs) &&
			!tiesToLatest(st, refs) &&
			!sameTopic(a.topic, focus)
		) {
			why("off_topic");
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
		// The same theme again brings the same result back: compare with the research of the
		// last day (waiting, running or ended) and with the notes of the last day. Older ones
		// may be out of date (tomorrow's weather, this week's news): the check reads whether a
		// note still answers.
		if (
			a.kind === "research" &&
			[
				...st.items
					.filter(
						(i) =>
							i.kind === "research" &&
							!isAssignment(i) &&
							(i.endedAt === null || now - i.endedAt < NOTE_FRESH_MS),
					)
					.map((i) => i.checkedRequest ?? i.text),
				...notesNow
					.filter((x) => now - x.at < NOTE_FRESH_MS)
					.map((x) => `${x.title}${x.summary}`),
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
			...(a.topic.trim() ? { topic: a.topic.trim() } : {}),
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
		...(proposal ? { goalWork: proposal } : {}),
		call: record(
			"plan",
			now,
			call.usage,
			added.length + dropped.length > 0 || Boolean(proposal?.delegation),
			"applied",
		),
	};
}
