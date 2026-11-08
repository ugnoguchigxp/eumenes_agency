/**
 * The agenda agent in a mock Eumenes, on a virtual clock: the user's turns, the normal reply with
 * its tools, the steward writing the memory after each exchange, web_research taking one request
 * at a time and saving notes, and the agent stepping whenever something is due. The model calls
 * take real time but the virtual clock stands still during them.
 */
import {
	createAgendaAgent,
	endsWithQuestion,
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
}

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
	const signal = new AbortController().signal;

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
			replied: r.text !== null,
		});
		if (r.text === null) return;
		turns.push({ atSec: sec(now) + r.delaySec, text: r.text, reactive: true });
		turns.sort((a, b) => a.atSec - b.atSec);
	};

	const step = async () => {
		const out = await agent.step(now, () => ({ busy: false }), signal);
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
		const agentAt = agent.nextAt(now) ?? Number.POSITIVE_INFINITY;
		const at = Math.min(turnAt, jobAt, agentAt);
		if (at > end) break;
		// A step that keeps asking for the same moment without doing anything moves time on.
		sameTime = at === lastAt ? sameTime + 1 : 0;
		lastAt = at;
		now = sameTime > 4 ? at + 1000 : at;
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
				const out = await input.reply(agent, now, tools);
				const { text, calls, emotion } =
					typeof out === "string"
						? { text: out, calls: [], emotion: null }
						: { emotion: null, ...out };
				const replyId = `r${stamp}.${n}`;
				agent.observe({ id: replyId, who: "reply", text, at: now, calls });
				for (const id of notesMentioned(text, input.docs.list()))
					agent.noteUsed(id, now);
				emit({ type: "reply", atSec: sec(now), id: replyId, text, emotion });
				// A reply that asks something is answered (or not) like the agent's own words.
				if (endsWithQuestion(text)) await react(text, "reply");
			}
			// The writers see the agent's own speech too: it is what the user answered. The note
			// of plans and interests goes after the memory, so it leaves out what that holds.
			const said = agent
				.view()
				.said.slice(-8)
				.map((s) => ({ id: s.id, who: s.who, text: s.text }));
			const fresh = said.filter((s) => !seen.has(s.id)).map((s) => s.id);
			for (const s of said) seen.add(s.id);
			for (const [type, writer] of [
				["memory", input.steward],
				["profile", input.profile ?? null],
			] as const) {
				if (!writer) continue;
				const m = await writer({ said, fresh, at: now });
				emit({
					type,
					atSec: sec(now),
					applied: m.applied,
					rejected: m.rejected,
					usage: m.usage,
				});
			}
			// The exchange is processed (reply and memory): the plan sees it once.
			agent.infoChanged(now);
			await step();
			continue;
		}
		await step();
	}
	return { agent, events };
}
