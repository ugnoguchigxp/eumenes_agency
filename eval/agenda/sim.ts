/**
 * The agenda agent in a mock Eumenes, on a virtual clock: the user's turns, the normal reply with
 * its tools, the steward writing the memory after each exchange, web_research taking one request
 * at a time and saving notes, and the agent stepping whenever something is due.
 *
 * As in the CLI (review 2026-11-10): the agent's own work (the reply and each step) moves the
 * virtual clock by the real time it takes, rounded to the second; the memory writers, research and
 * the simulated user run beside it and do not. The user types each line before it arrives (about three
 * characters a second) and the agent is busy meanwhile; an utterance written while the user
 * started typing is thrown away, as the CLI does. When the agent speaks again before the user
 * started typing an answer, the user answers the newest words instead, no later than they would
 * have answered the earlier ones (or still sends the earlier answer if the new words get none).
 */
import {
	createAgendaAgent,
	asksQuestion,
	type AgendaAgent,
	type AgendaDeps,
	type AgendaTicket,
	type QuietScope,
	type ReplyCall,
} from "../../src/agenda/index.ts";
import type { EmotionEmoji, ToolPort } from "../../src/index.ts";
import {
	createAgendaReplyTools,
	notesMentioned,
} from "../../standalone/agenda-reply.ts";
import type { MockDocStore } from "../../examples/virtual-eumenes/agenda/docs.ts";
import type {
	MemoryReader,
	Steward,
} from "../../examples/virtual-eumenes/agenda/memory.ts";
import type { MockWebResearch } from "../../examples/virtual-eumenes/agenda/research.ts";
import type { SimulatedUser } from "./user.ts";

/** A reply's text and the tools it called (runRespond's result fits). */
export interface ReplyOut {
	readonly text: string;
	readonly calls: readonly ReplyCall[];
	readonly emotion?: EmotionEmoji | null;
}

export interface UserTurn {
	readonly atSec: number;
	readonly text: string;
	/** Said in answer to the agent (the simulated user), not from the script. */
	readonly reactive?: boolean;
	/** When the user starts typing it (default: `typingMs` before `atSec`). */
	readonly typingFromSec?: number;
}

/** How long the user types a line: about three characters a second, 2 to 20 s (an estimate). */
export const typingMs = (text: string) =>
	Math.min(20_000, Math.max(2_000, [...text].length * 300));

interface Usage {
	readonly latencyMs: number;
	readonly inputTokens: number;
	readonly outputTokens: number;
}

/** What a writer (the memory's, or the plans-and-interests note's) did with one exchange. */
interface WriterEvent<T extends "memory" | "profile"> {
	readonly type: T;
	readonly atSec: number;
	readonly applied: readonly string[];
	readonly rejected: readonly string[];
	readonly usage: Usage | null;
}

export type AgendaSimEvent =
	| {
			readonly type: "user";
			readonly atSec: number;
			readonly id: string;
			readonly text: string;
	  }
	| {
			readonly type: "reply";
			readonly atSec: number;
			readonly id: string;
			readonly text: string;
			readonly emotion?: EmotionEmoji | null;
	  }
	| {
			/** What the simulated user made of being spoken to, and whether they answered. */
			readonly type: "felt";
			readonly atSec: number;
			/** Spoken to on the agent's own, or asked at the end of a reply. */
			readonly on: "speak" | "reply";
			readonly feeling: string;
			/** The simulated user's own yes or no to "was that off?" (absent in older runs). */
			readonly uneasy?: boolean;
			readonly replied: boolean;
	  }
	| {
			readonly type: "quiet";
			readonly atSec: number;
			readonly scope: QuietScope;
			readonly minutes: number;
	  }
	| {
			readonly type: "show" | "read";
			readonly atSec: number;
			readonly noteId: string;
			readonly title: string;
	  }
	| {
			readonly type: "asked";
			readonly atSec: number;
			readonly text: string;
			readonly queued: boolean;
	  }
	| WriterEvent<"memory">
	| WriterEvent<"profile">
	| {
			readonly type: "plan";
			readonly atSec: number;
			readonly added: readonly {
				id: string;
				kind: string;
				text: string;
				value: number;
			}[];
			readonly dropped: readonly string[];
			readonly rejected: readonly string[];
			readonly reasons: readonly string[];
			readonly changed: boolean;
			readonly code: string;
			readonly usage: Usage;
	  }
	| {
			readonly type: "check";
			readonly atSec: number;
			readonly itemId: string;
			readonly verdict: string;
			readonly coveredBy: string | null;
			readonly request: string | null;
			readonly reason: string;
			readonly usage: Usage;
	  }
	| {
			readonly type: "compose";
			readonly atSec: number;
			readonly itemId: string;
			readonly declined: string | null;
			readonly code: string;
			readonly usage: Usage;
	  }
	| {
			readonly type: "speak";
			readonly atSec: number;
			readonly kind: "ask" | "talk";
			readonly itemId: string;
			readonly noteId: string | null;
			readonly text: string;
			readonly emotion?: EmotionEmoji | null;
	  }
	| {
			/** A question of the agent's list that the reply asked at its end. */
			readonly type: "reply_ask";
			readonly atSec: number;
			readonly itemId: string;
	  }
	| {
			/** A question not asked: in meaning, asked or answered already (the agent's check). */
			readonly type: "repeat";
			readonly atSec: number;
			readonly itemId: string;
			readonly text: string;
			readonly verdict: "asked" | "answered";
			readonly reason: string;
	  }
	| {
			readonly type: "research";
			readonly atSec: number;
			readonly itemId: string;
			readonly text: string;
			readonly requested: boolean;
			readonly accepted: boolean;
	  }
	| {
			readonly type: "researched";
			readonly atSec: number;
			readonly status: string;
			readonly noteId: string | null;
			readonly title: string | null;
			readonly summary: string | null;
	  };

export interface AgendaSimInput {
	readonly deps: Omit<AgendaDeps, "startedAt" | "known" | "notes">;
	readonly minutes: number;
	readonly turns: readonly UserTurn[];
	readonly startMs?: number;
	readonly memory: MemoryReader;
	readonly steward: Steward | null;
	/** The plans-and-interests note's writer (absent: no note). */
	readonly profile?: Steward | null;
	readonly docs: MockDocStore;
	readonly research: MockWebResearch;
	/** The normal reply (absent: no reply); its tool calls go into the agent's record. */
	readonly reply?: (
		agent: AgendaAgent,
		atMs: number,
		tools: ToolPort,
	) => Promise<string | ReplyOut>;
	readonly onEvent?: (e: AgendaSimEvent) => void;
	/** A user who answers the agent's own speech (absent: only the scripted turns). */
	readonly user?: SimulatedUser;
	/** Real milliseconds, for the time the agent's work takes (default `performance.now`). */
	readonly realMs?: () => number;
}

export async function simulateAgenda(input: AgendaSimInput) {
	const start = input.startMs ?? 0;
	const end = start + input.minutes * 60_000;
	const agent = createAgendaAgent({
		...input.deps,
		startedAt: start,
		known: input.memory.known,
		notes: input.docs.list,
	});
	const events: AgendaSimEvent[] = [];
	const sec = (at: number) => (at - start) / 1000;
	const emit = (e: AgendaSimEvent) => {
		events.push(e);
		input.onEvent?.(e);
	};
	const turns = [...input.turns].sort((a, b) => a.atSec - b.atSec);
	const stamp = start.toString(36);
	let now = start;
	let n = 0;
	const seen = new Set<string>();
	const realMs = input.realMs ?? (() => performance.now());
	/** Real time since `t0`, as the virtual clock counts it (whole seconds). */
	const spent = (t0: number) => Math.round((realMs() - t0) / 1000) * 1000;
	/** The agent's work: the virtual clock goes on by the time it took. */
	const work = async <T>(f: () => Promise<T>): Promise<T> => {
		const t0 = realMs();
		const r = await f();
		now += spent(t0);
		return r;
	};
	const turnAtMs = (u: UserTurn) => start + u.atSec * 1000;
	const typingFromMs = (u: UserTurn) =>
		u.typingFromSec === undefined
			? turnAtMs(u) - typingMs(u.text)
			: start + u.typingFromSec * 1000;
	/**
	 * The line the user is typing at `t`, or has sent and the agent has not taken yet (the CLI is
	 * busy with it as soon as it is sent).
	 */
	const typedAt = (t: number) =>
		turns.find((u) => typingFromMs(u) <= t) ?? null;

	const handle = (t: AgendaTicket) => {
		if (t.kind === "research") {
			const accepted = input.research.start(t, now);
			agent.researchStarted(t.id, accepted, now);
			emit({
				type: "research",
				atSec: sec(now),
				itemId: t.itemId,
				text: t.text,
				requested: t.requested,
				accepted,
			});
			return;
		}
		emit({
			type: "speak",
			atSec: sec(now),
			kind: t.itemKind,
			itemId: t.itemId,
			noteId: t.noteId,
			text: t.utterance,
			emotion: t.emotion,
		});
		agent.recordDelivery({ ticketId: t.id, at: now, status: "succeeded" });
	};

	/** The simulated user hears what the agent said and maybe answers a little later. */
	const react = async (utterance: string, on: "speak" | "reply") => {
		if (!input.user) return;
		// An answer to the agent's earlier words the user has not started typing yet.
		const pending =
			turns.find((u) => u.reactive && typingFromMs(u) > now) ?? null;
		const history = events.flatMap((e) =>
			e.type === "user" || e.type === "reply" || e.type === "speak"
				? [{ who: e.type === "user" ? "user" : "agent", text: e.text }]
				: [],
		);
		const r = await input.user({
			atSec: sec(now),
			clock: input.deps.clock ? input.deps.clock(now) : null,
			utterance,
			history,
		});
		if (!r) return;
		emit({
			type: "felt",
			atSec: sec(now),
			on,
			feeling: r.feeling,
			...(r.uneasy === undefined ? {} : { uneasy: r.uneasy }),
			replied: r.text !== null,
		});
		// Nothing to say to the new words: the answer to the earlier ones still comes.
		if (r.text === null) return;
		// Something to say to the new words: one line answers what is in front of them now, sent no
		// later than the earlier answer would have been (more words do not put an answer off).
		if (pending) turns.splice(turns.indexOf(pending), 1);
		const atSec = Math.min(
			sec(now) + r.delaySec,
			pending?.atSec ?? Number.POSITIVE_INFINITY,
		);
		// Typing is part of the delay: it starts no earlier than the words were heard.
		turns.push({
			atSec,
			text: r.text,
			reactive: true,
			typingFromSec: Math.max(sec(now), atSec - typingMs(r.text) / 1000),
		});
		turns.sort((a, b) => a.atSec - b.atSec);
	};

	const step = async () => {
		const t0 = realMs();
		// The user's next line calls the step off when it comes while the step is out, as in the
		// CLI (its plan and line are stale then).
		const off = new AbortController();
		const nextLine = turns[0] ? start + turns[0].atSec * 1000 - now : null;
		const callOff =
			nextLine === null
				? null
				: setTimeout(() => off.abort(), Math.max(1, nextLine));
		// Busy while the user types, as of the moment the agent asks (its calls take time).
		const out = await agent
			.step(
				now,
				() => ({ busy: typedAt(now + spent(t0)) !== null }),
				off.signal,
			)
			.finally(() => {
				if (callOff !== null) clearTimeout(callOff);
			});
		now += spent(t0);
		if (out.plan) {
			const { call } = out.plan;
			emit({
				type: "plan",
				atSec: sec(now),
				added: out.plan.added.map((a) => ({
					id: a.id,
					kind: a.kind,
					text: a.text,
					value: a.value,
				})),
				dropped: out.plan.dropped,
				rejected: out.plan.rejected,
				reasons: out.plan.reasons,
				changed: call.changed,
				code: call.code,
				usage: {
					latencyMs: call.latencyMs,
					inputTokens: call.inputTokens,
					outputTokens: call.outputTokens,
				},
			});
		}
		if (out.check && out.check.call.model !== "") {
			const { call } = out.check;
			emit({
				type: "check",
				atSec: sec(now),
				itemId: out.check.itemId,
				verdict: out.check.verdict,
				coveredBy: out.check.coveredBy,
				request: out.check.request,
				reason: out.check.reason,
				usage: {
					latencyMs: call.latencyMs,
					inputTokens: call.inputTokens,
					outputTokens: call.outputTokens,
				},
			});
		}
		for (const r of out.repeats)
			emit({
				type: "repeat",
				atSec: sec(now),
				itemId: r.itemId,
				text: r.text,
				verdict: r.verdict,
				reason: r.reason,
			});
		if (out.compose) {
			const { call } = out.compose;
			emit({
				type: "compose",
				atSec: sec(now),
				itemId: out.compose.itemId,
				declined: out.compose.declined,
				code: call.code,
				usage: {
					latencyMs: call.latencyMs,
					inputTokens: call.inputTokens,
					outputTokens: call.outputTokens,
				},
			});
		}
		for (const t of out.tickets) handle(t);
		for (const t of out.tickets)
			if (t.kind === "speak") await react(t.utterance, "speak");
		return out;
	};

	let sameTime = 0;
	let lastAt = -1;
	for (;;) {
		const turn = turns[0];
		const turnAt = turn ? start + turn.atSec * 1000 : Number.POSITIVE_INFINITY;
		const jobAt = input.research.nextAt() ?? Number.POSITIVE_INFINITY;
		let agentAt = agent.nextAt(now) ?? Number.POSITIVE_INFINITY;
		// While the user types, nothing is planned or said: the agent's next step is when the line
		// arrives (research that comes back meanwhile is still received).
		const typing = typedAt(agentAt);
		if (typing) agentAt = turnAtMs(typing);
		const at = Math.min(turnAt, jobAt, agentAt);
		if (at > end) break;
		// A step that keeps asking for the same moment without doing anything moves time on.
		sameTime = at === lastAt ? sameTime + 1 : 0;
		lastAt = at;
		// Time never goes back: a research left from an earlier session was due before this one.
		now = Math.max(now, sameTime > 4 ? at + 1000 : at);
		if (jobAt <= now) {
			const r = await input.research.due(now);
			if (r) {
				agent.researchReturned({
					ticketId: r.ticketId,
					at: now,
					status: r.status,
					note: r.note,
				});
				emit({
					type: "researched",
					atSec: sec(now),
					status: r.status,
					noteId: r.note?.id ?? null,
					title: r.note?.title ?? null,
					summary: r.note?.summary ?? r.error,
				});
			}
			await step();
			continue;
		}
		if (turn && turnAt <= now) {
			turns.shift();
			// The user said something of their own: answers they meant to give to older words lapse.
			if (!turn.reactive)
				for (let i = turns.length - 1; i >= 0; i--)
					if (turns[i]!.reactive) turns.splice(i, 1);
			n++;
			const userId = `u${stamp}.${n}`;
			agent.observe({ id: userId, who: "user", text: turn.text, at: now });
			emit({ type: "user", atSec: sec(now), id: userId, text: turn.text });
			if (input.reply) {
				const tools = createAgendaReplyTools({
					agent,
					read: (id) => input.docs.read(id),
					now: () => now,
					events: {
						onQuiet: (q) => emit({ type: "quiet", atSec: sec(now), ...q }),
						onShow: (d) =>
							emit({
								type: "show",
								atSec: sec(now),
								noteId: d.id,
								title: d.title,
							}),
						onRead: (d) =>
							emit({
								type: "read",
								atSec: sec(now),
								noteId: d.id,
								title: d.title,
							}),
						onResearch: (r) => emit({ type: "asked", atSec: sec(now), ...r }),
					},
				});
				const at = now;
				const out = await work(() => input.reply!(agent, at, tools));
				const { text, calls, emotion } =
					typeof out === "string"
						? { text: out, calls: [], emotion: null }
						: { emotion: null, ...out };
				const replyId = `r${stamp}.${n}`;
				const openAsks = new Set(
					agent
						.view()
						.items.filter((i) => i.kind === "ask" && i.status === "open")
						.map((i) => i.id),
				);
				agent.observe({ id: replyId, who: "reply", text, at: now, calls });
				// The question offered to this reply was asked in it: the agent's item is done.
				for (const i of agent.view().items)
					if (i.kind === "ask" && i.status === "done" && openAsks.has(i.id))
						emit({ type: "reply_ask", atSec: sec(now), itemId: i.id });
				for (const id of notesMentioned(text, input.docs.list()))
					agent.noteUsed(id, now);
				emit({ type: "reply", atSec: sec(now), id: replyId, text, emotion });
				// A reply that asks something is answered (or not) like the agent's own words.
				if (asksQuestion(text)) await react(text, "reply");
			}
			// The writers see the agent's own speech too: it is what the user answered. The note
			// of plans and interests goes after the memory, so it leaves out what that holds.
			const said = agent
				.view()
				.said.slice(-8)
				.map((s) => ({ id: s.id, who: s.who, text: s.text }));
			const fresh = said.filter((s) => !seen.has(s.id)).map((s) => s.id);
			for (const s of said) seen.add(s.id);
			// The exchange is in: the plan sees it now, as in the CLI (review 2026-11-10). The
			// writers run beside the agent's step, so they do not move the clock; the step reads
			// whatever they have written by the time it asks.
			agent.infoChanged(now);
			const at = now;
			// A writer's failure is held, not left unhandled while the step runs, and fails the
			// scenario after it (as before the writers ran behind).
			const writing = (async () => {
				for (const [type, writer] of [
					["memory", input.steward],
					["profile", input.profile ?? null],
				] as const) {
					if (!writer) continue;
					const m = await writer({ said, fresh, at });
					emit({
						type,
						atSec: sec(at),
						applied: m.applied,
						rejected: m.rejected,
						usage: m.usage,
					});
				}
			})().then(
				() => null,
				(e: unknown) => ({ failed: e }),
			);
			const stepped = await step().then(
				() => null,
				(e: unknown) => ({ failed: e }),
			);
			const wrote = await writing;
			if (stepped) throw stepped.failed;
			if (wrote) throw wrote.failed;
			continue;
		}
		await step();
	}
	return { agent, events };
}
