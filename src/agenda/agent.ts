/**
 * The agenda agent (spec/always-on-agenda-design-2026-11-08.md). Code keeps the list of things to
 * do and decides when to plan, when to start research and when and which item to say; the model
 * is called only to plan (plan.ts), to check a research theme (check.ts) and to write the one
 * utterance code picked (compose.ts). The rules of timing live in pacing.ts, the state in
 * state.ts. Host-neutral: time comes in as arguments, nothing is stored outside the instance.
 */
import {
	AGENDA_SNAPSHOT_VERSION,
	agendaSnapshotSchema,
	ANSWER_WINDOW_MS,
	DEFAULT_QUIET_MIN,
	defaultSpeechIntervalSec,
	IDLE_PLAN_MS,
	RESEARCH_RETRY_MS,
	RESEARCH_TTL_MS,
	TOPIC_RECENT_MS,
	speechIntervals,
	type AgendaItem,
	type AgendaSnapshot,
	type AgendaTicket,
	type CheckOutcome,
	type ComposeOutcome,
	type NoteRef,
	type PlanOutcome,
	type Quiet,
	type QuietScope,
	type ReplyCall,
	type Said,
	type StepHost,
	type AskRepeat,
	type StepOutcome,
} from "./contracts.ts";
import { check } from "./check.ts";
import { compose } from "./compose.ts";
import {
	askBlocked,
	canDig,
	connected,
	holdsElsewhere,
	endQuiet,
	nextResearch,
	paused,
	replyAsk,
	speakable,
	speechOpenAt,
	speechQuiet,
	topicGone,
} from "./pacing.ts";
import { plan } from "./plan.ts";
import { checkAsks } from "./ask-check.ts";
import {
	askCheckSystem,
	checkSystem,
	composeSystem,
	planSystem,
} from "./prompt.ts";
import {
	createState,
	makeItem,
	nextId,
	remember,
	wantPlan,
	type AgendaDeps,
	type AgendaState,
} from "./state.ts";
import { declinesOffer, endsWithQuestion, normalize } from "./text.ts";

export type { AgendaDeps } from "./state.ts";
export { normalize, themeOverlap } from "./text.ts";

export interface AgendaView {
	readonly items: readonly AgendaItem[];
	readonly said: readonly Said[];
	readonly quiet: Quiet;
	readonly researching: AgendaItem | null;
	readonly planDue: boolean;
	readonly unanswered: number;
}

export interface AgendaAgent {
	/** A user turn or the agent's reply to it (own speech comes in through `recordDelivery`). */
	observe(said: {
		id: string;
		who: "user" | "reply";
		text: string;
		at: number;
		/** `reply`: the tools it called, shown to the next reply as its own history. */
		calls?: readonly ReplyCall[];
	}): void;
	/** Something new the plan should see (an exchange was processed, the memory changed). */
	infoChanged(at: number): void;
	/**
	 * The question the reply to the user's latest words may end with (null: none now). In a
	 * conversation this is how the agent asks; if the reply ends in a question, the item is asked.
	 */
	askForReply(now: number): AgendaItem | null;
	/** Plans, starts research and picks what to say, as the rules allow now. */
	step(
		now: number,
		host: () => StepHost,
		signal: AbortSignal,
	): Promise<StepOutcome>;
	/** When `step` has something to do next (null: only new information or the host can wake it). */
	nextAt(now: number): number | null;
	/** The host's answer to a research ticket: accepted, or refused (busy researcher). */
	researchStarted(ticketId: string, accepted: boolean, at: number): void;
	/** A research came back; the host saved its note (null when it failed). */
	researchReturned(r: {
		ticketId: string;
		at: number;
		status: "succeeded" | "failed";
		note: NoteRef | null;
	}): void;
	/** The host delivered (or failed to deliver) a speak ticket. */
	recordDelivery(r: {
		ticketId: string;
		at: number;
		status: "succeeded" | "failed";
	}): void;
	/** The reply read or showed this note: it has been talked about, no topic is made of it. */
	noteUsed(noteId: string, at: number): void;
	/**
	 * The reply's tool: research on the user's latest words. What the user asked for goes first in
	 * line and is reported when ready; what the reply started on its own is a promise kept too.
	 */
	requestResearch(r: {
		text: string;
		at: number;
		/** The user asked for it (absent: yes). */
		requested?: boolean;
		/** Work for a toolchain found through find_toolchain instead of research (the user said yes). */
		delegatedTo?: string;
	}):
		| { readonly item: AgendaItem; readonly queued: boolean }
		| { readonly rejected: string };
	/** The reply's tool: quiet for speech only or for everything; 0 minutes ends it. */
	setQuiet(r: { scope: QuietScope; minutes: number | null; at: number }): Quiet;
	/** The host's stop: nothing at all until resumed. */
	setStopped(stopped: boolean): void;
	/** Drops the words and memory/note refs given, and everything that rests on them. */
	forget(refs: readonly string[]): void;
	view(): AgendaView;
	/**
	 * What the host saves to outlive a restart and passes back as `restore`: the promises still
	 * open and the quiet. Save it after each step, reply and research result (and at exit).
	 */
	snapshot(now: number): AgendaSnapshot;
}

export function createAgendaAgent(deps: AgendaDeps): AgendaAgent {
	const intervalSec = deps.speechIntervalSec ?? defaultSpeechIntervalSec;
	if (!speechIntervals.includes(intervalSec))
		throw new RangeError("invalid speech interval");
	const st = createState(deps, intervalSec * 1000, {
		plan: planSystem(deps.persona),
		check: checkSystem(),
		compose: composeSystem(deps.persona),
		askCheck: askCheckSystem(),
	});
	if (deps.restore) restore(st, deps.restore);
	const researchingItem = () =>
		st.researching
			? (st.items.find((i) => i.id === st.researching!.ticket.itemId) ?? null)
			: null;
	/**
	 * The researcher failed, or never came back. What the user asked for, or what the reply said
	 * it would look into, was promised: the user hears it did not work out, not silence.
	 */
	const researchFailed = (
		t: Extract<AgendaTicket, { kind: "research" }>,
		at: number,
	) => {
		const item = st.items.find((i) => i.id === t.itemId);
		if (!item) return;
		item.status = "failed";
		item.endedAt = at;
		if (!(t.requested || t.promised) || t.refs.some((x) => st.forgotten.has(x)))
			return;
		st.items.push(
			makeItem(st, {
				kind: "talk",
				text: t.delegatedTo
					? `頼まれた「${item.text}」は、担当（${t.delegatedTo}）がやり遂げられなかった`
					: t.requested
						? `頼まれた調べもの「${item.text}」は、うまく調べられなかった（もう一度頼まれればやり直せる）`
						: `調べておくと言った「${item.text}」は、うまく調べられなかった`,
				refs: [...t.refs],
				value: 5,
				reason: "約束した調べものが失敗した（黙って終わらせない）",
				requested: t.requested,
				promised: true,
				createdAt: at,
			}),
		);
	};

	return {
		observe(s) {
			if (st.forgotten.has(s.id))
				throw new RangeError(`said ${s.id} was forgotten`);
			if (st.said.some((x) => x.id === s.id)) return;
			const before = st.said.at(-1);
			remember(st, {
				id: s.id,
				who: s.who,
				text: s.text,
				at: s.at,
				refs: [],
				...(s.calls?.length ? { calls: structuredClone([...s.calls]) } : {}),
			});
			if (s.who === "user") {
				// The user talking ends a quiet for speech: they are here (user, 2026-11-09: after
				// "そろそろ寝よう" set seven hours of quiet, six more minutes of talk got no word of
				// its own). Asked for again, the reply sets it again; a pause of everything stays.
				if (st.quiet.speechUntil !== null && s.at < st.quiet.speechUntil) {
					st.quiet.speechUntil = null;
					st.lastQuietEnd = s.at;
					wantPlan(st);
				}
				st.lastUserAt = s.at;
				st.unanswered = 0;
				st.ownAskPending = false;
				st.offeredAsk = null;
				st.epoch++;
				// "Not now" to what the agent just asked or offered: it backs off, and the plan hears it.
				if (
					before &&
					before.who !== "user" &&
					s.at - before.at <= ANSWER_WINDOW_MS &&
					endsWithQuestion(before.text) &&
					declinesOffer(s.text)
				) {
					// The plan hears it and leaves that topic; nothing else is held back.
					st.userDeclines = [
						...st.userDeclines,
						{ at: s.at, agentId: before.id, userId: s.id },
					].slice(-4);
				}
			} else {
				// The question offered to this reply is asked when the reply ends in one.
				const offered = st.offeredAsk;
				st.offeredAsk = null;
				const item = offered
					? st.items.find((i) => i.id === offered.itemId)
					: undefined;
				if (
					item &&
					item.status === "open" &&
					offered!.userId ===
						st.said.filter((x) => x.who === "user").at(-1)?.id &&
					endsWithQuestion(s.text)
				) {
					item.status = "done";
					item.endedAt = s.at;
				}
				st.lastAgentAt = Math.max(st.lastAgentAt ?? 0, s.at);
				st.lastAgentAsked = endsWithQuestion(s.text);
				// A reply that ended in a question waits for its answer like an own one.
				if (st.lastAgentAsked) st.ownAskPending = true;
			}
		},

		infoChanged(at) {
			wantPlan(st);
			st.lastInfoAt = Math.max(st.lastInfoAt, at);
		},

		// One reply at a time (the hosts serialize the user's turns): a second offer replaces the first.
		askForReply(now) {
			const item = replyAsk(st, now);
			const user = st.said.filter((x) => x.who === "user").at(-1);
			st.offeredAsk =
				item && user ? { itemId: item.id, userId: user.id } : null;
			return item ? structuredClone(item) : null;
		},

		async step(now, host, signal) {
			const base = {
				at: now,
				plan: null,
				check: null,
				repeats: [] as AskRepeat[],
				compose: null,
				tickets: [] as AgendaTicket[],
			};
			if (st.stopped) return { ...base, skipped: "stopped" };
			endQuiet(st, now);
			if (st.researching && st.researching.at + RESEARCH_TTL_MS <= now) {
				const t = st.researching.ticket;
				st.issued.delete(t.id);
				st.researching = null;
				if (t.kind === "research") researchFailed(t, now);
			}
			// With nothing new for an hour, the time of day itself is the news.
			if (
				!st.planDue &&
				Math.max(st.lastPlanAt ?? deps.startedAt, st.lastInfoAt) +
					IDLE_PLAN_MS <=
					now
			)
				wantPlan(st);
			const tickets: AgendaTicket[] = [];
			let planned: PlanOutcome | null = null;
			let composed: ComposeOutcome | null = null;
			if (paused(st, now)) return { ...base, skipped: null };
			// Nothing that may be said now: this very step digs (not the next one).
			if (canDig(st, now)) {
				st.dig = true;
				wantPlan(st);
			}
			if (st.planDue && !host().busy) planned = await plan(st, now, signal);
			// New questions are checked at once: one asked or answered already, in meaning, goes
			// before it is offered to a reply or asked on its own.
			const repeats: AskRepeat[] = [];
			const checkedNow = new Set<string>();
			if (planned && !st.stopped) {
				const fresh = planned.added.filter((i) => i.kind === "ask");
				for (const i of fresh) checkedNow.add(i.id);
				repeats.push(...(await checkAsks(st, fresh, now, signal)).repeats);
			}
			// Stopped while the plan was out: nothing is started or said.
			if (st.stopped) return { ...base, plan: planned, skipped: "stopped" };
			// One research at a time (the researcher's limit), in order: asked for, value, oldest.
			// Before it starts, its theme is checked against the notes: no result comes back twice.
			let checked: CheckOutcome | null = null;
			if (st.researching === null && !paused(st, now)) {
				let next = nextResearch(st, now);
				if (next && next.checkedRequest === undefined) {
					checked = await check(st, next, now, signal);
					if (checked.verdict === "covered" || checked.verdict === "failed")
						next = null;
				}
				// Stopped, paused or forgotten while the check was out: nothing starts.
				if (
					next &&
					(st.stopped ||
						paused(st, now) ||
						st.researching !== null ||
						!st.items.includes(next) ||
						next.status !== "open")
				)
					next = null;
				if (next && next.checkedRequest !== undefined) {
					const ticket: AgendaTicket = {
						id: nextId(st, "t"),
						kind: "research",
						itemId: next.id,
						text: next.checkedRequest ?? next.text,
						requested: next.requested,
						promised: next.promised,
						refs: [...next.refs],
						at: now,
						...(next.delegatedTo ? { delegatedTo: next.delegatedTo } : {}),
					};
					next.status = "doing";
					st.issued.set(ticket.id, ticket);
					st.researching = { ticket, at: now };
					tickets.push(ticket);
				}
			}
			// A question about a talk that is over is not asked any more; its place in the list frees up.
			for (const i of st.items)
				if (i.status === "open" && topicGone(st, i, now)) {
					i.status = "dropped";
					i.endedAt = now;
				}
			const open = speechOpenAt(st, now);
			if (
				!st.stopped &&
				!host().busy &&
				open !== null &&
				open <= now &&
				!speechQuiet(st, now)
			) {
				// A question is checked again right before it is asked (the user may have answered
				// it meanwhile); a repeat goes and the next item is said instead.
				for (let tries = 0; tries < 3 && !st.stopped; tries++) {
					const item = speakable(st, now)[0];
					if (!item) break;
					if (item.kind === "ask" && !checkedNow.has(item.id)) {
						checkedNow.add(item.id);
						const r = await checkAsks(st, [item], now, signal);
						if (r.repeats.length) {
							repeats.push(...r.repeats);
							continue;
						}
					}
					const c = await compose(st, item, now, host, signal);
					composed = c.outcome;
					if (c.ticket) tickets.push(c.ticket);
					break;
				}
			}
			// Nothing left to say and nothing on the way: the next plan digs into an interest.
			if (canDig(st, now)) {
				st.dig = true;
				wantPlan(st);
			}
			return {
				at: now,
				skipped: null,
				plan: planned,
				check: checked,
				repeats,
				compose: composed,
				tickets,
			};
		},

		nextAt(now) {
			if (st.stopped) return null;
			if (paused(st, now)) return st.quiet.allUntil;
			const times: number[] = [];
			if (st.quiet.speechUntil !== null && st.quiet.speechUntil > now)
				times.push(st.quiet.speechUntil);
			if (st.planDue) times.push(now);
			// Nothing that may be said (topics from elsewhere wait while the talk goes on): dig now.
			if (canDig(st, now)) times.push(now);
			times.push(
				Math.max(st.lastPlanAt ?? deps.startedAt, st.lastInfoAt) + IDLE_PLAN_MS,
			);
			if (st.researching === null) {
				for (const i of st.items)
					if (i.status === "open" && i.kind === "research")
						times.push(Math.max(now, i.deferUntil ?? now));
			} else times.push(st.researching.at + RESEARCH_TTL_MS);
			const open = speechOpenAt(st, now);
			if (open !== null)
				for (const i of st.items)
					if (
						i.status === "open" &&
						(i.kind === "talk" ||
							(i.kind === "ask" && !askBlocked(st) && !topicGone(st, i, now)))
					)
						times.push(
							Math.max(
								open,
								i.deferUntil ?? open,
								// A topic from elsewhere, while the talk goes on: when the talk is over.
								holdsElsewhere(st, now) && !connected(st, i, now)
									? st.lastUserAt! + TOPIC_RECENT_MS
									: open,
							),
						);
			return times.length ? Math.max(now, Math.min(...times)) : null;
		},

		researchStarted(ticketId, accepted, at) {
			const t = st.issued.get(ticketId);
			if (!t || t.kind !== "research" || accepted) return;
			st.issued.delete(ticketId);
			if (st.researching?.ticket.id === ticketId) st.researching = null;
			const item = st.items.find((i) => i.id === t.itemId);
			if (item && item.status === "doing") {
				item.status = "open";
				item.deferUntil = at + RESEARCH_RETRY_MS;
			}
		},

		researchReturned(r) {
			const t = st.issued.get(r.ticketId);
			if (!t || t.kind !== "research") return;
			st.issued.delete(r.ticketId);
			if (st.researching?.ticket.id === r.ticketId) st.researching = null;
			wantPlan(st);
			st.lastInfoAt = Math.max(st.lastInfoAt, r.at);
			if (r.status === "failed") {
				researchFailed(t, r.at);
				return;
			}
			const item = st.items.find((i) => i.id === t.itemId);
			if (item) {
				item.status = "done";
				item.endedAt = r.at;
				item.resultNoteId = r.note?.id ?? null;
			}
			const usable =
				r.status === "succeeded" &&
				r.note &&
				item &&
				!st.forgotten.has(`note:${r.note.id}`) &&
				!t.refs.some((x) => st.forgotten.has(x));
			// Research it started from the user's words (digging into the talk) is said when it is
			// ready, as what was asked for is: it is the next thing to say about what they talk
			// about, not left to the plan to pick (user, 2026-11-09: "最後詰まって話が振れなく").
			// Unless the reply has used the note already.
			if (
				usable &&
				!t.requested &&
				!t.promised &&
				t.refs.some((x) =>
					st.said.some((s) => s.id === x && s.who === "user"),
				) &&
				!st.items.some(
					(i) =>
						i.kind === "talk" &&
						i.noteId === r.note!.id &&
						i.status !== "dropped",
				)
			)
				st.items.push(
					makeItem(st, {
						kind: "talk",
						text: `話の流れで調べた「${r.note!.title}」の要点`,
						refs: [`note:${r.note!.id}`, ...t.refs],
						value: 4,
						reason: "話の流れで調べたことの結果",
						noteId: r.note!.id,
						createdAt: r.at,
					}),
				);
			// What the user asked for, or what the reply said it would look into, is reported when
			// it is ready; the rest is knowledge to keep.
			if (usable && (t.requested || t.promised))
				st.items.push(
					makeItem(st, {
						kind: "talk",
						text: t.delegatedTo
							? `頼まれた「${r.note!.title}」ができた`
							: t.requested
								? `頼まれた調べもの「${r.note!.title}」ができた`
								: `調べておくと言った「${r.note!.title}」がまとまった`,
						refs: [`note:${r.note!.id}`, ...t.refs],
						value: 5,
						reason: t.requested
							? "利用者に頼まれた調べものの結果"
							: "返事で調べておくと言ったことの結果",
						requested: t.requested,
						promised: true,
						noteId: r.note!.id,
						createdAt: r.at,
					}),
				);
		},

		recordDelivery(r) {
			const t = st.issued.get(r.ticketId);
			if (!t || t.kind !== "speak") return;
			st.issued.delete(r.ticketId);
			const item = st.items.find((i) => i.id === t.itemId);
			if (r.status !== "succeeded") {
				if (item && item.status === "doing") {
					item.status = "open";
					item.deferUntil = r.at + RESEARCH_RETRY_MS;
				}
				return;
			}
			if (item) {
				item.status = "done";
				item.endedAt = r.at;
			}
			// Said, so it counts for pacing; forgotten meanwhile, so its words are not kept.
			const gone =
				!item ||
				st.forgotten.has(t.itemId) ||
				t.refs.some((x) => st.forgotten.has(x));
			if (!gone)
				remember(st, {
					id: nextId(st, "s"),
					who: "own",
					text: t.utterance,
					at: r.at,
					refs: [...t.refs, t.itemId],
				});
			st.lastAgentAt = Math.max(st.lastAgentAt ?? 0, r.at);
			st.lastAgentAsked = t.itemKind === "ask" || endsWithQuestion(t.utterance);
			// Anything it asked on its own (a topic that ends "表示しましょうか？" too) waits for an answer.
			// The offer stays in: letting a question follow it (ag49-offer, 2026-11-10, not adopted)
			// put the question over an offer not yet answered, felt as 唐突/しつこい (3 of 4).
			if (st.lastAgentAsked) st.ownAskPending = true;
			st.unanswered++;
		},

		requestResearch(r) {
			if (st.stopped) return { rejected: "stopped" };
			const requested = r.requested ?? true;
			const text = r.text.trim();
			if (text === "") return { rejected: "empty" };
			const asked = [...st.said].reverse().find((s) => s.who === "user");
			if (!asked) return { rejected: "needs_user_request" };
			const same = normalize(text);
			if (
				st.items.some(
					(i) =>
						i.kind === "research" &&
						(i.status === "open" || i.status === "doing") &&
						normalize(i.text) === same,
				)
			)
				return { rejected: "duplicate" };
			const item = makeItem(st, {
				kind: "research",
				text,
				refs: [asked.id],
				value: requested ? 5 : 4,
				reason: requested
					? "利用者に頼まれた"
					: "返事で始めた（利用者の言葉から）",
				requested,
				promised: true,
				createdAt: r.at,
				// Work for a toolchain is no research: nothing to check against the notes.
				...(r.delegatedTo
					? { delegatedTo: r.delegatedTo, checkedRequest: null }
					: {}),
			});
			st.items.push(item);
			return { item, queued: st.researching !== null };
		},

		noteUsed(noteId, at) {
			for (const i of st.items)
				if (i.kind === "talk" && i.noteId === noteId && i.status === "open") {
					i.status = "done";
					i.endedAt = at;
				}
			if (!st.items.some((i) => i.kind === "talk" && i.noteId === noteId))
				st.items.push(
					makeItem(st, {
						kind: "talk",
						text: "返事で使った",
						refs: [`note:${noteId}`],
						value: 1,
						reason: "返事で読んだ・表示した",
						noteId,
						status: "done",
						createdAt: at,
						endedAt: at,
					}),
				);
		},

		setQuiet(r) {
			const minutes = r.minutes ?? DEFAULT_QUIET_MIN;
			if (!Number.isFinite(minutes) || minutes < 0)
				throw new RangeError("quiet needs minutes >= 0");
			// Zero ends every quiet period, whichever scope was named, and the plan looks again.
			if (minutes === 0) {
				st.quiet.speechUntil = null;
				st.quiet.allUntil = null;
				wantPlan(st);
				return { ...st.quiet };
			}
			const until = r.at + minutes * 60_000;
			if (r.scope === "all") st.quiet.allUntil = until;
			else st.quiet.speechUntil = until;
			return { ...st.quiet };
		},

		setStopped(s) {
			st.stopped = s;
			st.epoch++;
		},

		forget(refs) {
			for (const r of refs) st.forgotten.add(r);
			// Fixed point: words and items resting on forgotten refs go, and what rests on them.
			const gone = (rs: readonly string[]) =>
				rs.some((x) => st.forgotten.has(x));
			for (;;) {
				const before = st.said.length + st.items.length;
				for (const s of st.said) if (gone(s.refs)) st.forgotten.add(s.id);
				st.said = st.said.filter((s) => !st.forgotten.has(s.id));
				st.userDeclines = st.userDeclines.filter(
					(d) => !st.forgotten.has(d.agentId) && !st.forgotten.has(d.userId),
				);
				for (const i of st.items)
					if (
						gone(i.refs) ||
						(i.noteId !== null && st.forgotten.has(`note:${i.noteId}`))
					)
						st.forgotten.add(i.id);
				st.items = st.items.filter((i) => !st.forgotten.has(i.id));
				if (st.said.length + st.items.length === before) break;
			}
			if (st.researching && researchingItem() === null) {
				st.issued.delete(st.researching.ticket.id);
				st.researching = null;
			}
			// A forgotten research is not waited for; speech the host may already be saying is kept,
			// so its delivery still counts for pacing (its words are not kept).
			for (const [id, t] of st.issued)
				if (t.kind === "research" && !st.items.some((i) => i.id === t.itemId))
					st.issued.delete(id);
			st.epoch++;
		},

		view: () => ({
			items: structuredClone(st.items),
			said: structuredClone(st.said),
			quiet: { ...st.quiet },
			researching: structuredClone(researchingItem()),
			planDue: st.planDue,
			unanswered: st.unanswered,
		}),

		snapshot: (now) => ({
			version: AGENDA_SNAPSHOT_VERSION,
			at: now,
			n: st.n,
			quiet: { ...st.quiet },
			items: st.items
				.filter(
					(i) =>
						(i.kind === "research" || i.kind === "talk") &&
						(i.status === "open" || i.status === "doing") &&
						(i.requested || i.promised),
				)
				.map((i) => ({
					id: i.id,
					kind: i.kind === "research" ? "research" : "talk",
					text: i.text,
					refs: [...i.refs],
					value: i.value,
					reason: i.reason,
					requested: i.requested,
					promised: i.promised,
					noteId: i.noteId,
					createdAt: i.createdAt,
					declines: i.declines,
					...(i.checkedRequest !== undefined
						? { checkedRequest: i.checkedRequest }
						: {}),
					...(i.delegatedTo !== undefined
						? { delegatedTo: i.delegatedTo }
						: {}),
				})),
		}),
	};
}

/**
 * Puts back what a snapshot kept. Running work comes back queued (its researcher or its speech did
 * not survive the restart); ids go on after the highest restored one.
 */
function restore(st: AgendaState, given: AgendaSnapshot): void {
	const s = agendaSnapshotSchema.parse(given);
	st.quiet.speechUntil = s.quiet.speechUntil;
	st.quiet.allUntil = s.quiet.allUntil;
	const seen = new Set<string>();
	for (const x of s.items) {
		if (seen.has(x.id)) continue;
		seen.add(x.id);
		st.items.push({
			id: x.id,
			kind: x.kind,
			text: x.text,
			refs: x.refs,
			value: x.value,
			reason: x.reason,
			requested: x.requested,
			promised: x.promised,
			noteId: x.noteId,
			status: "open",
			createdAt: x.createdAt,
			deferUntil: null,
			declines: x.declines,
			endedAt: null,
			...(x.checkedRequest !== undefined
				? { checkedRequest: x.checkedRequest }
				: {}),
			...(x.delegatedTo !== undefined ? { delegatedTo: x.delegatedTo } : {}),
		});
	}
	const highest = Math.max(
		0,
		...s.items.map((i) => Number(/\d+$/u.exec(i.id)?.[0] ?? 0)),
	);
	st.n = Math.max(st.n, s.n, highest);
}
