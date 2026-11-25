/**
 * The agenda agent's working state and what every part of it shares: the host's inputs, ids, the
 * record of a model call. Kept in one object so the rules (pacing.ts) and the calls (plan.ts,
 * check.ts, compose.ts) read and change the same state. Working memory, never saved as a whole:
 * only the promises still open and the quiet go into a snapshot (agent.ts, `snapshot`).
 */
import type { LlmPort } from "../contracts/ports.ts";
import { defaultBudget } from "../contracts/runtime.ts";
import type { Budget } from "../application/budget.ts";
import {
	SAID_KEPT,
	type AgendaCall,
	type AgendaGoalContext,
	type AgendaItem,
	type AgendaMarks,
	type AgendaRecords,
	type AgendaSnapshot,
	type AgendaTicket,
	type CallRecord,
	type KnownItem,
	type NoteRef,
	type Quiet,
	type Said,
	type SpeechIntervalSec,
} from "./contracts.ts";

export interface AgendaDeps {
	readonly llm: LlmPort;
	/** The host has an opportunity to ask for a goal proposal in this planning call. */
	readonly goalContext?: () => AgendaGoalContext | null;
	/**
	 * The host's memory of the user (eumenes_memory), read at each call: the records that bear on
	 * that call (`call` says which), not the whole of it.
	 */
	readonly known?: (call: AgendaCall) => readonly KnownItem[];
	/**
	 * The plans, goals, conflicts and question ledger the host selects for each call (spec
	 * 2026-11-22 §5.4). Replaces the plans-and-interests note: what the agent knows of the user
	 * beyond the memory is the host's records, not a note the agent keeps.
	 */
	readonly records?: (call: AgendaCall) => AgendaRecords;
	/** Marks on the host's records (under review, suppressed), read whenever an item is chosen. */
	readonly marks?: () => AgendaMarks;
	/** The researcher's notes in the host's document store, read at each call. */
	readonly notes?: () => readonly NoteRef[];
	/** A host persona replaces the built-in one; the rest of the instructions stays. */
	readonly persona?: string;
	readonly speechIntervalSec?: SpeechIntervalSec;
	/** Local time as the user would say it (the core has no clock or time zone). */
	readonly clock?: (now: number) => string;
	/** When the agent starts: planning is due at once, so it can go and learn about the user. */
	readonly startedAt: number;
	/**
	 * What the agent saved before the last restart (`AgendaAgent.snapshot`), validated here: the
	 * promises still open and the quiet the user asked for. Absent: a fresh start.
	 */
	readonly restore?: AgendaSnapshot;
}

export interface AgendaState {
	readonly deps: AgendaDeps;
	readonly intervalMs: number;
	readonly instructions: {
		readonly plan: string;
		readonly check: string;
		readonly compose: string;
		readonly askCheck: string;
	};
	said: Said[];
	items: AgendaItem[];
	readonly quiet: Quiet;
	/** When the user's last quiet period ended (the words asking for it are still in view). */
	lastQuietEnd: number | null;
	readonly forgotten: Set<string>;
	readonly issued: Map<string, AgendaTicket>;
	researching: { ticket: AgendaTicket; at: number } | null;
	planDue: boolean;
	/** The plan that is due digs into one of the user's interests: nothing was left to say. */
	dig: boolean;
	/** The last dig: no other until something new comes (the user's words, a result, news). */
	dugAt: number | null;
	/** What the last dig proposed and code refused (a theme researched already...): shown to the next. */
	refusedLastDig: {
		readonly kind: string;
		readonly text: string;
		readonly why: string;
	}[];
	/** A dig whose every proposal was refused is tried once more; this says it was. */
	digRetried: boolean;
	/** Grows with every reason to plan; a plan that ran while it grew leaves the plan due. */
	planGen: number;
	lastPlanAt: number | null;
	lastInfoAt: number;
	lastAgentAt: number | null;
	lastAgentAsked: boolean;
	/** The agent asked (on its own or in a reply) and the user has not spoken since. */
	ownAskPending: boolean;
	/** The question offered to the reply to the user's words `userId`; asked if the reply ends in one. */
	offeredAsk: { readonly itemId: string; readonly userId: string } | null;
	/** A plan that failed is tried again at this time (null: no failure pending). */
	planRetryAt: number | null;
	/** A line written ahead of its time, said when speech opens unless the user spoke (epoch). */
	ready: {
		readonly ticket: Extract<AgendaTicket, { kind: "speak" }>;
		readonly epoch: number;
	} | null;
	/** The topic of the user's words `userId`, as the plan named it. */
	focus: { readonly topic: string; readonly userId: string } | null;
	lastUserAt: number | null;
	unanswered: number;
	stopped: boolean;
	/** Grows with the user's words, a stop or a forget: work started before it is stale. */
	epoch: number;
	n: number;
}

export function createState(
	deps: AgendaDeps,
	intervalMs: number,
	instructions: AgendaState["instructions"],
): AgendaState {
	return {
		deps,
		intervalMs,
		instructions,
		said: [],
		items: [],
		quiet: { speechUntil: null, allUntil: null },
		lastQuietEnd: null,
		forgotten: new Set(),
		issued: new Map(),
		researching: null,
		planDue: true,
		dig: false,
		dugAt: null,
		refusedLastDig: [],
		digRetried: false,
		planGen: 0,
		lastPlanAt: null,
		lastInfoAt: deps.startedAt,
		lastAgentAt: null,
		lastAgentAsked: false,
		ownAskPending: false,
		offeredAsk: null,
		focus: null,
		ready: null,
		planRetryAt: null,
		lastUserAt: null,
		unanswered: 0,
		stopped: false,
		epoch: 0,
		n: 0,
	};
}

export const nextId = (st: AgendaState, prefix: string) => `${prefix}${++st.n}`;

export const wantPlan = (st: AgendaState) => {
	st.planDue = true;
	st.planGen++;
};

/** The host's memory of the user, without what was forgotten. */
export const known = (st: AgendaState, call: AgendaCall) =>
	(st.deps.known?.(call) ?? []).filter(
		(k) =>
			k.id !== "" &&
			k.text.trim() !== "" &&
			!st.forgotten.has(`memory:${k.id}`),
	);

/** The host's plans, goals, conflicts and question ledger for a call, without what was forgotten. */
export const records = (st: AgendaState, call: AgendaCall) => {
	const r = st.deps.records?.(call) ?? {};
	const live = (kind: string, ref: string, text: string) =>
		ref !== "" && text.trim() !== "" && !st.forgotten.has(`${kind}:${ref}`);
	return {
		plans: (r.plans ?? []).filter((x) => live("plan", x.ref, x.text)),
		goals: (r.goals ?? []).filter((x) => live("goal", x.ref, x.text)),
		conflicts: (r.conflicts ?? []).filter((x) =>
			live("conflict", x.ref, x.text),
		),
		questions: (r.questions ?? []).filter((x) => x.attribute.trim() !== ""),
	};
};

/** The researcher's notes, without what was forgotten or rests on it. */
export const notes = (st: AgendaState) =>
	(st.deps.notes?.() ?? []).filter(
		(x) =>
			!st.forgotten.has(`note:${x.id}`) &&
			!x.refs.some((r) => st.forgotten.has(r)),
	);

/** UTC to the minute ("2026-11-22T09:03Z"), by calendar arithmetic (the core has no Date). */
const utcMinute = (at: number): string => {
	const days = Math.floor(at / 86_400_000);
	const z = days + 719_468;
	const era = Math.floor(z / 146_097);
	const doe = z - era * 146_097;
	const yoe = Math.floor(
		(doe -
			Math.floor(doe / 1_460) +
			Math.floor(doe / 36_524) -
			Math.floor(doe / 146_096)) /
			365,
	);
	const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
	const mp = Math.floor((5 * doy + 2) / 153);
	const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
	const month = mp < 10 ? mp + 3 : mp - 9;
	const year = yoe + era * 400 + (month <= 2 ? 1 : 0);
	const minutes = Math.floor(at / 60_000) - days * 1_440;
	const two = (n: number) => String(n).padStart(2, "0");
	return `${year}-${two(month)}-${two(day)}T${two(Math.floor(minutes / 60))}:${two(minutes % 60)}Z`;
};

/**
 * A moment as the prompts show it: the host's wording of the local time, or UTC to the minute
 * when the host gave no clock. The same moment reads the same in every call, so a line keeps its
 * time while the conversation grows and the head of the prompt stays as it was.
 */
export const stampOf =
	(st: AgendaState) =>
	(at: number): string =>
		st.deps.clock ? st.deps.clock(at) : utcMinute(at);

export const remember = (st: AgendaState, s: Said) => {
	st.said.push(s);
	if (st.said.length > SAID_KEPT) st.said = st.said.slice(-SAID_KEPT);
};

/**
 * Work handed to a toolchain (a research item with `delegatedTo`): it does not use the researcher's
 * one slot, is not checked against the notes and is not the plan's business.
 */
export const isAssignment = (i: AgendaItem) =>
	i.kind === "research" && i.delegatedTo !== undefined;

/** A new item with the usual defaults: open, not deferred, never declined. */
export const makeItem = (
	st: AgendaState,
	i: Pick<
		AgendaItem,
		"kind" | "text" | "refs" | "value" | "reason" | "createdAt"
	> &
		Partial<
			Pick<
				AgendaItem,
				| "requested"
				| "promised"
				| "noteId"
				| "status"
				| "endedAt"
				| "delegatedTo"
				| "question"
				| "progress"
				| "checkedRequest"
				| "topic"
			>
		>,
): AgendaItem => ({
	id: nextId(st, "a"),
	requested: false,
	promised: false,
	noteId: null,
	status: "open",
	deferUntil: null,
	declines: 0,
	endedAt: null,
	...i,
});

/** No budget gate (spec §2): calls happen only on new information or a chosen utterance. */
export const unlimited: Budget = {
	config: defaultBudget,
	remaining: () => Number.MAX_SAFE_INTEGER,
	check: () => "ok",
	record: () => undefined,
};

export const record = (
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
