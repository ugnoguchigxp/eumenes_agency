/**
 * The agenda agent's working state and what every part of it shares: the host's inputs, ids, the
 * record of a model call. Kept in one object so the rules (pacing.ts) and the calls (plan.ts,
 * check.ts, compose.ts) read and change the same state. Never saved: it is working memory.
 */
import type { LlmPort } from "../contracts/ports.ts";
import { defaultBudget } from "../contracts/runtime.ts";
import type { Budget } from "../application/budget.ts";
import {
	SAID_KEPT,
	type AgendaItem,
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
	/** The host's memory of the user (eumenes_memory), read at each call. */
	readonly known?: () => readonly KnownItem[];
	/** The researcher's notes in the host's document store, read at each call. */
	readonly notes?: () => readonly NoteRef[];
	/**
	 * The user's plans-and-interests note (Markdown, profile.ts), read at each call: what the
	 * memory leaves out (intentions, plans not settled, what the user is thinking about).
	 */
	readonly profile?: () => string;
	/** A host persona replaces the built-in one; the rest of the instructions stays. */
	readonly persona?: string;
	readonly speechIntervalSec?: SpeechIntervalSec;
	/** Local time as the user would say it (the core has no clock or time zone). */
	readonly clock?: (now: number) => string;
	/** When the agent starts: planning is due at once, so it can go and learn about the user. */
	readonly startedAt: number;
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
	/** The user said no to the agent's question or offer: the words of both, by id. */
	userDeclines: {
		readonly at: number;
		readonly agentId: string;
		readonly userId: string;
	}[];
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
		userDeclines: [],
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
export const known = (st: AgendaState) =>
	(st.deps.known?.() ?? []).filter(
		(k) =>
			k.id !== "" &&
			k.text.trim() !== "" &&
			!st.forgotten.has(`memory:${k.id}`),
	);

/** The researcher's notes, without what was forgotten or rests on it. */
export const notes = (st: AgendaState) =>
	(st.deps.notes?.() ?? []).filter(
		(x) =>
			!st.forgotten.has(`note:${x.id}`) &&
			!x.refs.some((r) => st.forgotten.has(r)),
	);

export const clock = (st: AgendaState, now: number) =>
	st.deps.clock ? st.deps.clock(now) : null;

export const remember = (st: AgendaState, s: Said) => {
	st.said.push(s);
	if (st.said.length > SAID_KEPT) st.said = st.said.slice(-SAID_KEPT);
};

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
				| "checkedRequest"
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
