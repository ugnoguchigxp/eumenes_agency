/**
 * The agenda agent (spec/always-on-agenda-design-2026-11-08.md). Code keeps the list of things to
 * do and decides when to plan, when to start research and when and which item to say. The model
 * is called only to plan (on new information) and to write the one utterance code picked.
 * Host-neutral: time comes in as arguments, nothing is stored outside the instance.
 */
import type { LlmPort } from "../contracts/ports.ts";
import { defaultBudget } from "../contracts/runtime.ts";
import type { Budget } from "../application/budget.ts";
import { callModel } from "../application/model-call.ts";
import {
	checkSchema,
	composeSchema,
	DECLINE_DEFER_MS,
	ENGAGED_MS,
	TOPIC_RECENT_MS,
	DEFAULT_QUIET_MIN,
	defaultSpeechIntervalSec,
	IDLE_PLAN_MS,
	OPEN_LIMITS,
	PLAN_ADD_LIMITS,
	planSchema,
	QUESTION_WAIT_MS,
	RESEARCH_RETRY_MS,
	RESEARCH_TTL_MS,
	SAID_KEPT,
	SAME_THEME_OVERLAP,
	SPEECH_HOLD_MS,
	speechIntervals,
	type AgendaItem,
	type AgendaKind,
	type AgendaTicket,
	type CallRecord,
	type CheckOutcome,
	type ComposeOutcome,
	type KnownItem,
	type NoteRef,
	type PlanOutcome,
	type Quiet,
	type QuietScope,
	type ReplyCall,
	type Said,
	type SpeechIntervalSec,
	type StepHost,
	type StepOutcome,
} from "./contracts.ts";
import {
	checkData,
	checkSystem,
	composeData,
	composeSystem,
	planData,
	planSystem,
} from "./prompt.ts";

/** No budget gate (spec §2): calls happen only on new information or a chosen utterance. */
const unlimited: Budget = {
	config: defaultBudget,
	remaining: () => Number.MAX_SAFE_INTEGER,
	check: () => "ok",
	record: () => undefined,
};

export interface AgendaDeps {
	readonly llm: LlmPort;
	/** The host's memory of the user (eumenes_memory), read at each call. */
	readonly known?: () => readonly KnownItem[];
	/** The researcher's notes in the host's document store, read at each call. */
	readonly notes?: () => readonly NoteRef[];
	/** A host persona replaces the built-in one; the rest of the instructions stays. */
	readonly persona?: string;
	readonly speechIntervalSec?: SpeechIntervalSec;
	/** Local time as the user would say it (the core has no clock or time zone). */
	readonly clock?: (now: number) => string;
	/** When the agent starts: planning is due at once, so it can go and learn about the user. */
	readonly startedAt: number;
}

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
	/**
	 * The reply's tool: research on the user's latest words. What the user asked for goes first in
	 * line and is reported when ready; what the reply started on its own is ordinary research.
	 */
	/** The reply read or showed this note: it has been talked about, no topic is made of it. */
	noteUsed(noteId: string, at: number): void;
	requestResearch(r: {
		text: string;
		at: number;
		/** The user asked for it (absent: yes). */
		requested?: boolean;
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
}

/** Text compared for repeats: whitespace and punctuation do not make a sentence new. */
export const normalize = (text: string) =>
	text.replace(/[\s、。，．,.!?！？…・「」『』（）()〜~ー-]/gu, "");

/** Words of a research request that say how, not what: they never make two themes alike. */
const REQUEST_WORDS = [
	"調べてほしい",
	"まとめてほしい",
	"調べて",
	"まとめて",
	"調べ",
	"まとめ",
	"てほしい",
	"ほしい",
	"一覧",
	"結論",
	"について",
	"向けに",
	"ための",
	"など",
	"こと",
	"もの",
	"整理",
	"確認",
	"情報",
	"おすすめ",
	"一文で",
];
const themeBigrams = (text: string) => {
	let t = text.replace(/[\s、。！？!?…・「」『』（）()：:〜~ー-]/gu, "");
	for (const w of REQUEST_WORDS) t = t.split(w).join("");
	const out = new Set<string>();
	for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
	return out;
};
/** Shared character pairs over the smaller side: near 1 when one theme restates the other. */
export const themeOverlap = (a: string, b: string) => {
	const x = themeBigrams(a);
	const y = themeBigrams(b);
	if (x.size === 0 || y.size === 0) return 0;
	let both = 0;
	for (const g of x) if (y.has(g)) both++;
	return both / Math.min(x.size, y.size);
};

/** Sentences long enough to be a statement or a question of their own, normalized. */
const sentences = (text: string) =>
	text
		.split(/(?<=[。！？!?])/u)
		.map(normalize)
		.filter((x) => x.length >= 8);

const endsWithQuestion = (text: string) => /[？?]\s*[」』）)]*\s*$/u.test(text);
const questionMarks = (text: string) => (text.match(/[？?]/gu) ?? []).length;

export function createAgendaAgent(deps: AgendaDeps): AgendaAgent {
	const intervalSec = deps.speechIntervalSec ?? defaultSpeechIntervalSec;
	if (!speechIntervals.includes(intervalSec))
		throw new RangeError("invalid speech interval");
	const intervalMs = intervalSec * 1000;
	const persona = deps.persona;
	const planInstructions = planSystem(persona);
	const composeInstructions = composeSystem(persona);
	const checkInstructions = checkSystem();

	let said: Said[] = [];
	let items: AgendaItem[] = [];
	const quiet: Quiet = { speechUntil: null, allUntil: null };
	/** When the user's last quiet period ended (the words asking for it are still in view). */
	let lastQuietEnd: number | null = null;
	const forgotten = new Set<string>();
	const issued = new Map<string, AgendaTicket>();
	let researching: { ticket: AgendaTicket; at: number } | null = null;
	let planDue = true;
	/** Grows with every reason to plan; a plan that ran while it grew leaves the plan due. */
	let planGen = 0;
	const wantPlan = () => {
		planDue = true;
		planGen++;
	};
	let lastPlanAt: number | null = null;
	let lastInfoAt = deps.startedAt;
	let lastAgentAt: number | null = null;
	let lastAgentAsked = false;
	/** The agent asked on its own and the user has not spoken since. */
	let ownAskPending = false;
	let lastUserAt: number | null = null;
	let unanswered = 0;
	let stopped = false;
	let epoch = 0;
	let n = 0;
	const nextId = (prefix: string) => `${prefix}${++n}`;

	const known = () =>
		(deps.known?.() ?? []).filter(
			(k) =>
				k.id !== "" && k.text.trim() !== "" && !forgotten.has(`memory:${k.id}`),
		);
	const notes = () =>
		(deps.notes?.() ?? []).filter(
			(x) =>
				!forgotten.has(`note:${x.id}`) && !x.refs.some((r) => forgotten.has(r)),
		);
	const clock = (now: number) => (deps.clock ? deps.clock(now) : null);

	const remember = (s: Said) => {
		said.push(s);
		if (said.length > SAID_KEPT) said = said.slice(-SAID_KEPT);
	};

	const paused = (now: number) =>
		quiet.allUntil !== null && now < quiet.allUntil;
	const speechQuiet = (now: number) =>
		paused(now) || (quiet.speechUntil !== null && now < quiet.speechUntil);

	/** Quiet periods that have ended: the plan sees the new situation. */
	const endQuiet = (now: number) => {
		if (quiet.allUntil !== null && now >= quiet.allUntil) {
			lastQuietEnd = quiet.allUntil;
			quiet.allUntil = null;
			wantPlan();
		}
		if (quiet.speechUntil !== null && now >= quiet.speechUntil) {
			lastQuietEnd = quiet.speechUntil;
			quiet.speechUntil = null;
			wantPlan();
		}
	};

	/** The earliest time the agent may speak on its own (ignoring busy), or null when held. */
	const speechOpenAt = (now: number): number | null => {
		if (stopped) return null;
		let at = now;
		if (quiet.allUntil !== null && quiet.allUntil > at) at = quiet.allUntil;
		if (quiet.speechUntil !== null && quiet.speechUntil > at)
			at = quiet.speechUntil;
		const gap = intervalMs * 2 ** unanswered;
		// No talking to an empty room: past the hold, only the user's next words open it again.
		if (unanswered > 0 && gap > Math.max(SPEECH_HOLD_MS, intervalMs))
			return null;
		if (lastAgentAt !== null) {
			at = Math.max(at, lastAgentAt + (unanswered > 0 ? gap : intervalMs));
			const waiting =
				lastAgentAsked && (lastUserAt === null || lastUserAt <= lastAgentAt);
			if (waiting) at = Math.max(at, lastAgentAt + QUESTION_WAIT_MS);
		}
		return at;
	};

	/**
	 * Its own question waits for the user's next words: no other question before them, even with a
	 * topic brought up in between.
	 */
	const askBlocked = () => ownAskPending;

	const order = (a: AgendaItem, b: AgendaItem) =>
		Number(b.requested || b.promised) - Number(a.requested || a.promised) ||
		b.value - a.value ||
		a.createdAt - b.createdAt;

	/** The user is in the middle of a conversation (spoke a moment ago). */
	const engaged = (now: number) =>
		lastUserAt !== null && now - lastUserAt < ENGAGED_MS;
	/**
	 * Does the item tie into what is being talked about: the user's or the agent's words of the
	 * last few minutes, or a note made from them? What the user asked for always does.
	 */
	const connected = (i: AgendaItem, now: number) => {
		if (i.requested || i.promised) return true;
		const recent = new Set(
			said.filter((s) => now - s.at <= TOPIC_RECENT_MS).map((s) => s.id),
		);
		const fromRecent = (refs: readonly string[]) =>
			refs.some((r) => recent.has(r));
		if (fromRecent(i.refs)) return true;
		const noteIds = [
			...(i.noteId ? [i.noteId] : []),
			...i.refs.flatMap((r) => (r.startsWith("note:") ? [r.slice(5)] : [])),
		];
		return notes().some((n) => noteIds.includes(n.id) && fromRecent(n.refs));
	};
	/** When an item may be said, as far as the flow of the conversation goes. */
	const topicOpenAt = (i: AgendaItem, now: number) =>
		!engaged(now) || connected(i, now) ? now : lastUserAt! + ENGAGED_MS;

	const speakable = (now: number) =>
		items
			.filter(
				(i) =>
					i.status === "open" &&
					(i.kind === "ask" || i.kind === "talk") &&
					(i.deferUntil === null || i.deferUntil <= now) &&
					!(i.kind === "ask" && askBlocked()) &&
					topicOpenAt(i, now) <= now,
			)
			.sort(order);

	const nextResearch = (now: number) =>
		items
			.filter(
				(i) =>
					i.status === "open" &&
					i.kind === "research" &&
					(i.deferUntil === null || i.deferUntil <= now),
			)
			.sort(order)[0] ?? null;

	const record = (
		purpose: CallRecord["purpose"],
		at: number,
		usage: {
			model: string;
			latencyMs: number;
			inputTokens: number;
			outputTokens: number;
		} | null,
		changed: boolean,
		code: CallRecord["code"],
	): CallRecord => ({
		purpose,
		at,
		model: usage?.model ?? "",
		latencyMs: usage?.latencyMs ?? 0,
		inputTokens: usage?.inputTokens ?? 0,
		outputTokens: usage?.outputTokens ?? 0,
		changed,
		code,
	});

	const noteRef = (r: string) => (r.startsWith("note:") ? r.slice(5) : null);

	const plan = async (
		now: number,
		signal: AbortSignal,
	): Promise<PlanOutcome> => {
		const startEpoch = epoch;
		const startGen = planGen;
		const knownNow = known();
		const notesNow = notes();
		const prompt = planData({
			now,
			clock: clock(now),
			said,
			items,
			known: knownNow,
			notes: notesNow,
			researching: researching
				? (items.find((i) => i.id === researching!.ticket.itemId) ?? null)
				: null,
			quiet,
		});
		const call = await callModel(
			deps.llm,
			unlimited,
			{
				purpose: "think",
				at: now,
				system: planInstructions,
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
				if (planGen === startGen) planDue = false;
				lastPlanAt = now;
			}
			return {
				added: [],
				dropped: [],
				rejected: [],
				reasons: [],
				call: record("plan", now, null, false, code),
			};
		}
		// The user spoke while the plan was out: it may add what was just answered. Plan again.
		if (epoch !== startEpoch)
			return {
				added: [],
				dropped: [],
				rejected: [],
				reasons: [],
				call: record("plan", now, call.usage, false, "stale"),
			};
		// What came while it was out (a returned note, a memory change) is planned on next.
		if (planGen === startGen) planDue = false;
		lastPlanAt = now;
		const refsKnown = new Set([
			...said.map((s) => s.id),
			...knownNow.map((k) => `memory:${k.id}`),
			...notesNow.map((x) => `note:${x.id}`),
		]);
		const userSaid = new Set(
			said.filter((s) => s.who === "user").map((s) => s.id),
		);
		const rejected: string[] = [];
		const reasons: string[] = [];
		const dropped: string[] = [];
		for (const d of call.value.drop) {
			const item = items.find((i) => i.id === d.id && i.status === "open");
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
		const addedPer: Record<AgendaKind, number> = {
			ask: 0,
			research: 0,
			talk: 0,
		};
		for (const a of call.value.add) {
			const text = a.text.trim();
			const refs = [...new Set(a.refs)];
			const open = items.filter(
				(i) =>
					i.kind === a.kind && (i.status === "open" || i.status === "doing"),
			).length;
			const why = (code: string) => rejected.push(`${a.kind}:${code}`);
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
			// Research rests on what the user said: their words, the memory of them, or a note that
			// came from those. The agent's own words alone never start it.
			if (
				a.kind === "research" &&
				!refs.some(
					(r) =>
						userSaid.has(r) || r.startsWith("memory:") || r.startsWith("note:"),
				)
			) {
				why("needs_user_reason");
				continue;
			}
			const noteIds = refs.map(noteRef).filter((x): x is string => x !== null);
			if (a.kind === "talk" && noteIds.length !== 1) {
				why("needs_one_note");
				continue;
			}
			const noteId = a.kind === "talk" ? noteIds[0]! : null;
			if (
				noteId !== null &&
				items.some(
					(i) =>
						i.kind === "talk" && i.noteId === noteId && i.status !== "dropped",
				)
			) {
				why("note_already_talked");
				continue;
			}
			const same = normalize(text);
			if (
				items.some(
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
					...items
						.filter((i) => i.kind === "research")
						.map((i) => i.checkedRequest ?? i.text),
					...notesNow.map((x) => `${x.title}${x.summary}`),
				].some((t) => themeOverlap(text, t) >= SAME_THEME_OVERLAP)
			) {
				why("same_theme");
				continue;
			}
			const item: AgendaItem = {
				id: nextId("a"),
				kind: a.kind,
				text,
				refs,
				value: a.value,
				reason: a.reason,
				requested: false,
				promised: false,
				noteId,
				status: "open",
				createdAt: now,
				deferUntil: null,
				declines: 0,
				endedAt: null,
			};
			items.push(item);
			added.push(item);
			addedPer[a.kind]++;
			reasons.push(`${item.kind} ${item.id}: ${a.reason}`);
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
	};

	/** Is this research a new theme? Covered: dropped; partly covered: narrowed; new: as it is. */
	const check = async (
		item: AgendaItem,
		now: number,
		signal: AbortSignal,
	): Promise<CheckOutcome> => {
		const notesNow = notes();
		const researchedBefore = items
			.filter(
				(i) => i.kind === "research" && i.id !== item.id && i.status !== "open",
			)
			.map((i) => i.checkedRequest ?? i.text);
		const out = (
			verdict: CheckOutcome["verdict"],
			coveredBy: string | null,
			request: string | null,
			reason: string,
			call: CallRecord,
		): CheckOutcome => ({
			itemId: item.id,
			verdict,
			coveredBy,
			request,
			reason,
			call,
		});
		// What the user asked for is not second-guessed; with nothing to compare, there is no call.
		if (
			item.requested ||
			(notesNow.length === 0 && researchedBefore.length === 0)
		) {
			item.checkedRequest = null;
			return out(
				"new",
				null,
				null,
				item.requested ? "requested" : "nothing_to_compare",
				record("check", now, null, false, "applied"),
			);
		}
		const call = await callModel(
			deps.llm,
			unlimited,
			{
				purpose: "think",
				at: now,
				system: checkInstructions,
				prompt: checkData({
					now,
					request: item.text,
					notes: notesNow,
					researchedBefore,
				}),
				schema: checkSchema,
				maxOutputTokens: 400,
			},
			signal,
		);
		if (!call.ok) {
			// An unchecked research is not started blind; it is tried again later.
			item.deferUntil = now + RESEARCH_RETRY_MS;
			return out(
				"failed",
				null,
				null,
				call.outcome.code,
				record(
					"check",
					now,
					null,
					false,
					call.outcome.code === "aborted" ? "aborted" : "failed",
				),
			);
		}
		const v = call.value;
		const coveredBy =
			v.coveredBy && notesNow.some((x) => `note:${x.id}` === v.coveredBy)
				? v.coveredBy
				: null;
		// What the reply said it would look into and a note already covers: the promise is kept
		// with that note instead of the same research again.
		if (v.verdict === "covered" && item.promised && coveredBy === null) {
			item.checkedRequest = null;
			return out(
				"new",
				null,
				null,
				`promised: ${v.reason}`,
				record("check", now, call.usage, true, "applied"),
			);
		}
		if (v.verdict === "covered") {
			item.status = "dropped";
			item.endedAt = now;
			const noteId = coveredBy!.slice(5);
			if (
				item.promised &&
				!items.some(
					(i) =>
						i.kind === "talk" && i.noteId === noteId && i.status !== "dropped",
				)
			)
				items.push({
					id: nextId("a"),
					kind: "talk",
					text: "調べておくと言った件は、前に調べたメモにもうまとまっている",
					refs: [coveredBy!, ...item.refs],
					value: 5,
					reason: "返事で調べておくと言ったことは、既存のメモで答えられる",
					requested: false,
					promised: true,
					noteId,
					status: "open",
					createdAt: now,
					deferUntil: null,
					declines: 0,
					endedAt: null,
				});
			return out(
				"covered",
				coveredBy,
				null,
				v.reason,
				record("check", now, call.usage, true, "applied"),
			);
		}
		const narrowed = v.verdict === "partial" ? (v.request?.trim() ?? "") : "";
		item.checkedRequest = narrowed === "" ? null : narrowed;
		return out(
			narrowed === "" ? "new" : "partial",
			null,
			narrowed === "" ? null : narrowed,
			v.reason,
			record("check", now, call.usage, true, "applied"),
		);
	};

	const compose = async (
		item: AgendaItem,
		now: number,
		host: () => StepHost,
		signal: AbortSignal,
	): Promise<{ outcome: ComposeOutcome; ticket: AgendaTicket | null }> => {
		const startEpoch = epoch;
		const note =
			item.noteId === null
				? null
				: (notes().find((x) => x.id === item.noteId) ?? null);
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
			deps.llm,
			unlimited,
			{
				purpose: "think",
				at: now,
				system: composeInstructions,
				prompt: composeData({
					now,
					clock: clock(now),
					item,
					note,
					said,
					known: known(),
					quietEndedSecAgo:
						lastQuietEnd === null
							? null
							: Math.round((now - lastQuietEnd) / 1000),
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
		if (epoch !== startEpoch || host().busy || stopped || speechQuiet(now))
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
				said
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
				for (const i of items)
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
			id: nextId("t"),
			kind: "speak",
			itemId: item.id,
			itemKind: item.kind === "ask" ? "ask" : "talk",
			utterance,
			noteId: item.noteId,
			refs: [...item.refs],
			at: now,
		};
		item.status = "doing";
		issued.set(ticket.id, ticket);
		return done(
			null,
			[],
			record("compose", now, call.usage, true, "applied"),
			ticket,
		);
	};

	const agent: AgendaAgent = {
		observe(s) {
			if (forgotten.has(s.id))
				throw new RangeError(`said ${s.id} was forgotten`);
			if (said.some((x) => x.id === s.id)) return;
			remember({
				id: s.id,
				who: s.who,
				text: s.text,
				at: s.at,
				refs: [],
				...(s.calls?.length ? { calls: structuredClone([...s.calls]) } : {}),
			});
			if (s.who === "user") {
				lastUserAt = s.at;
				unanswered = 0;
				ownAskPending = false;
				epoch++;
			} else {
				lastAgentAt = Math.max(lastAgentAt ?? 0, s.at);
				lastAgentAsked = endsWithQuestion(s.text);
				// A reply that ended in a question waits for its answer like an own one.
				if (lastAgentAsked) ownAskPending = true;
			}
		},

		infoChanged(at) {
			wantPlan();
			lastInfoAt = Math.max(lastInfoAt, at);
		},

		async step(now, host, signal) {
			const base = {
				at: now,
				plan: null,
				check: null,
				compose: null,
				tickets: [] as AgendaTicket[],
			};
			if (stopped) return { ...base, skipped: "stopped" };
			endQuiet(now);
			if (researching && researching.at + RESEARCH_TTL_MS <= now) {
				const item = items.find((i) => i.id === researching!.ticket.itemId);
				if (item) {
					item.status = "dropped";
					item.endedAt = now;
				}
				issued.delete(researching.ticket.id);
				researching = null;
			}
			// With nothing new for an hour, the time of day itself is the news.
			if (
				!planDue &&
				Math.max(lastPlanAt ?? deps.startedAt, lastInfoAt) + IDLE_PLAN_MS <= now
			)
				wantPlan();
			const tickets: AgendaTicket[] = [];
			let planned: PlanOutcome | null = null;
			let composed: ComposeOutcome | null = null;
			if (paused(now)) return { ...base, skipped: null };
			if (planDue && !host().busy) planned = await plan(now, signal);
			// Stopped while the plan was out: nothing is started or said.
			if (stopped) return { ...base, plan: planned, skipped: "stopped" };
			// One research at a time (the researcher's limit), in order: asked for, value, oldest.
			// Before it starts, its theme is checked against the notes: no result comes back twice.
			let checked: CheckOutcome | null = null;
			if (researching === null && !paused(now)) {
				let next = nextResearch(now);
				if (next && next.checkedRequest === undefined) {
					checked = await check(next, now, signal);
					if (checked.verdict === "covered" || checked.verdict === "failed")
						next = null;
				}
				// Stopped, paused or forgotten while the check was out: nothing starts.
				if (
					next &&
					(stopped ||
						paused(now) ||
						researching !== null ||
						!items.includes(next) ||
						next.status !== "open")
				)
					next = null;
				if (next && next.checkedRequest !== undefined) {
					const ticket: AgendaTicket = {
						id: nextId("t"),
						kind: "research",
						itemId: next.id,
						text: next.checkedRequest ?? next.text,
						requested: next.requested,
						promised: next.promised,
						refs: [...next.refs],
						at: now,
					};
					next.status = "doing";
					issued.set(ticket.id, ticket);
					researching = { ticket, at: now };
					tickets.push(ticket);
				}
			}
			const open = speechOpenAt(now);
			if (
				!stopped &&
				!host().busy &&
				open !== null &&
				open <= now &&
				!speechQuiet(now)
			) {
				const item = speakable(now)[0];
				if (item) {
					const c = await compose(item, now, host, signal);
					composed = c.outcome;
					if (c.ticket) tickets.push(c.ticket);
				}
			}
			return {
				at: now,
				skipped: null,
				plan: planned,
				check: checked,
				compose: composed,
				tickets,
			};
		},

		nextAt(now) {
			if (stopped) return null;
			const times: number[] = [];
			if (paused(now)) return quiet.allUntil;
			if (quiet.speechUntil !== null && quiet.speechUntil > now)
				times.push(quiet.speechUntil);
			if (planDue) times.push(now);
			times.push(
				Math.max(lastPlanAt ?? deps.startedAt, lastInfoAt) + IDLE_PLAN_MS,
			);
			if (researching === null) {
				const r = items.filter(
					(i) => i.status === "open" && i.kind === "research",
				);
				for (const i of r) times.push(Math.max(now, i.deferUntil ?? now));
			} else times.push(researching.at + RESEARCH_TTL_MS);
			const open = speechOpenAt(now);
			if (open !== null) {
				const cands = items.filter(
					(i) =>
						i.status === "open" &&
						(i.kind === "talk" || (i.kind === "ask" && !askBlocked())),
				);
				for (const i of cands)
					times.push(Math.max(open, i.deferUntil ?? open, topicOpenAt(i, now)));
			}
			return times.length ? Math.max(now, Math.min(...times)) : null;
		},

		researchStarted(ticketId, accepted, at) {
			const t = issued.get(ticketId);
			if (!t || t.kind !== "research" || accepted) return;
			issued.delete(ticketId);
			if (researching?.ticket.id === ticketId) researching = null;
			const item = items.find((i) => i.id === t.itemId);
			if (item && item.status === "doing") {
				item.status = "open";
				item.deferUntil = at + RESEARCH_RETRY_MS;
			}
		},

		researchReturned(r) {
			const t = issued.get(r.ticketId);
			if (!t || t.kind !== "research") return;
			issued.delete(r.ticketId);
			if (researching?.ticket.id === r.ticketId) researching = null;
			const item = items.find((i) => i.id === t.itemId);
			if (item) {
				item.status = r.status === "succeeded" ? "done" : "dropped";
				item.endedAt = r.at;
				item.resultNoteId = r.note?.id ?? null;
			}
			wantPlan();
			lastInfoAt = Math.max(lastInfoAt, r.at);
			// What the user asked for, or what the reply said it would look into, is reported when
			// it is ready; the rest is knowledge to keep.
			if (
				r.status === "succeeded" &&
				r.note &&
				item &&
				(t.requested || t.promised) &&
				!forgotten.has(`note:${r.note.id}`) &&
				!t.refs.some((x) => forgotten.has(x))
			) {
				items.push({
					id: nextId("a"),
					kind: "talk",
					text: t.requested
						? `頼まれた調べもの「${r.note.title}」ができた`
						: `調べておくと言った「${r.note.title}」がまとまった`,
					refs: [`note:${r.note.id}`, ...t.refs],
					value: 5,
					reason: t.requested
						? "利用者に頼まれた調べものの結果"
						: "返事で調べておくと言ったことの結果",
					requested: t.requested,
					promised: true,
					noteId: r.note.id,
					status: "open",
					createdAt: r.at,
					deferUntil: null,
					declines: 0,
					endedAt: null,
				});
			}
		},

		recordDelivery(r) {
			const t = issued.get(r.ticketId);
			if (!t || t.kind !== "speak") return;
			issued.delete(r.ticketId);
			const item = items.find((i) => i.id === t.itemId);
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
				forgotten.has(t.itemId) ||
				t.refs.some((x) => forgotten.has(x));
			if (!gone)
				remember({
					id: nextId("s"),
					who: "own",
					text: t.utterance,
					at: r.at,
					refs: [...t.refs, t.itemId],
				});
			lastAgentAt = Math.max(lastAgentAt ?? 0, r.at);
			lastAgentAsked = t.itemKind === "ask" || endsWithQuestion(t.utterance);
			// Anything it asked on its own (a topic that ends "表示しましょうか？" too) waits for an answer.
			if (t.itemKind === "ask" || endsWithQuestion(t.utterance))
				ownAskPending = true;
			unanswered++;
		},

		requestResearch(r) {
			if (stopped) return { rejected: "stopped" };
			const requested = r.requested ?? true;
			const text = r.text.trim();
			if (text === "") return { rejected: "empty" };
			const asked = [...said].reverse().find((s) => s.who === "user");
			if (!asked) return { rejected: "needs_user_request" };
			const same = normalize(text);
			if (
				items.some(
					(i) =>
						i.kind === "research" &&
						(i.status === "open" || i.status === "doing") &&
						normalize(i.text) === same,
				)
			)
				return { rejected: "duplicate" };
			const item: AgendaItem = {
				id: nextId("a"),
				kind: "research",
				text,
				refs: [asked.id],
				value: requested ? 5 : 4,
				reason: requested
					? "利用者に頼まれた"
					: "返事で始めた（利用者の言葉から）",
				requested,
				promised: true,
				noteId: null,
				status: "open",
				createdAt: r.at,
				deferUntil: null,
				declines: 0,
				endedAt: null,
			};
			items.push(item);
			return { item, queued: researching !== null };
		},

		noteUsed(noteId, at) {
			for (const i of items)
				if (i.kind === "talk" && i.noteId === noteId && i.status === "open") {
					i.status = "done";
					i.endedAt = at;
				}
			if (!items.some((i) => i.kind === "talk" && i.noteId === noteId))
				items.push({
					id: nextId("a"),
					kind: "talk",
					text: "返事で使った",
					refs: [`note:${noteId}`],
					value: 1,
					reason: "返事で読んだ・表示した",
					requested: false,
					promised: false,
					noteId,
					status: "done",
					createdAt: at,
					deferUntil: null,
					declines: 0,
					endedAt: at,
				});
		},

		setQuiet(r) {
			const minutes = r.minutes ?? DEFAULT_QUIET_MIN;
			if (!Number.isFinite(minutes) || minutes < 0)
				throw new RangeError("quiet needs minutes >= 0");
			// Zero ends every quiet period, whichever scope was named, and the plan looks again.
			if (minutes === 0) {
				quiet.speechUntil = null;
				quiet.allUntil = null;
				wantPlan();
				return { ...quiet };
			}
			const until = r.at + minutes * 60_000;
			if (r.scope === "all") quiet.allUntil = until;
			else quiet.speechUntil = until;
			return { ...quiet };
		},

		setStopped(s) {
			stopped = s;
			epoch++;
		},

		forget(refs) {
			for (const r of refs) forgotten.add(r);
			// Fixed point: words and items resting on forgotten refs go, and what rests on them.
			for (;;) {
				const before = said.length + items.length;
				const gone = (rs: readonly string[]) =>
					rs.some((x) => forgotten.has(x));
				for (const s of said) if (gone(s.refs)) forgotten.add(s.id);
				said = said.filter((s) => !forgotten.has(s.id));
				for (const i of items)
					if (
						gone(i.refs) ||
						(i.noteId !== null && forgotten.has(`note:${i.noteId}`))
					)
						forgotten.add(i.id);
				items = items.filter((i) => !forgotten.has(i.id));
				if (said.length + items.length === before) break;
			}
			if (
				researching &&
				!items.some((i) => i.id === researching!.ticket.itemId)
			) {
				issued.delete(researching.ticket.id);
				researching = null;
			}
			// A forgotten research is not waited for; speech the host may already be saying is kept,
			// so its delivery still counts for pacing (its words are not kept).
			for (const [id, t] of issued)
				if (t.kind === "research" && !items.some((i) => i.id === t.itemId))
					issued.delete(id);
			epoch++;
		},

		view: () => ({
			items: structuredClone(items),
			said: structuredClone(said),
			quiet: { ...quiet },
			researching: researching
				? (structuredClone(
						items.find((i) => i.id === researching!.ticket.itemId),
					) ?? null)
				: null,
			planDue,
			unanswered,
		}),
	};
	return agent;
}
