/**
 * The agenda agent's host loop for the CLI, without terminal I/O: typing and the reply make it
 * busy, each exchange goes through the steward into the memory behind the talk (nothing waits
 * for it), web_research takes one request
 * at a time, and the agent is stepped when something is due. Clock and timers are injected so
 * the loop runs in fixed tests.
 */
import type {
	AgendaAgent,
	AgendaTicket,
	QuietScope,
	ReplyCall,
	StepOutcome,
} from "../src/agenda/index.ts";
import type { EmotionEmoji, ToolPort } from "../src/index.ts";
import { createAgendaReplyTools, notesMentioned } from "./agenda-reply.ts";
import type { MockDocStore } from "../examples/virtual-eumenes/agenda/docs.ts";
import type { Steward } from "../examples/virtual-eumenes/agenda/memory.ts";
import type { MockWebResearch } from "../examples/virtual-eumenes/agenda/research.ts";

export type AgendaSessionEvent =
	| { readonly type: "user"; readonly text: string }
	| {
			readonly type: "reply";
			readonly text: string;
			readonly latencyMs: number;
			/** The feeling the reply is said with (its leading emoji, removed from the text). */
			readonly emotion: EmotionEmoji | null;
	  }
	| { readonly type: "step"; readonly outcome: StepOutcome }
	| {
			readonly type: "speak";
			readonly kind: "ask" | "talk";
			readonly text: string;
			readonly emotion: EmotionEmoji | null;
	  }
	| {
			readonly type: "research";
			readonly text: string;
			readonly requested: boolean;
			readonly accepted: boolean;
			/** The toolchain the work went to, not research. */
			readonly delegatedTo?: string;
	  }
	| {
			readonly type: "researched";
			readonly status: string;
			readonly title: string | null;
			readonly summary: string | null;
	  }
	| {
			readonly type: "memory" | "profile";
			readonly applied: readonly string[];
			readonly rejected: readonly string[];
	  }
	| {
			readonly type: "quiet";
			readonly scope: QuietScope;
			readonly minutes: number;
	  }
	| {
			readonly type: "show";
			readonly id: string;
			readonly title: string;
			readonly markdown: string;
	  }
	| {
			readonly type: "error";
			readonly where: string;
			readonly message: string;
	  };

export interface AgendaSessionDeps {
	readonly agent: AgendaAgent;
	/** The memory's writer, run after each exchange. */
	readonly steward: Steward | null;
	/** The plans-and-interests note's writer, run after the memory's (it leaves out what that holds). */
	readonly profile?: Steward | null;
	readonly docs: MockDocStore;
	readonly research: MockWebResearch;
	/** The normal reply; its tool calls go into the agent's record so the next reply sees them. */
	readonly reply: (
		agent: AgendaAgent,
		tools: ToolPort,
	) => Promise<
		| string
		| {
				readonly text: string;
				readonly calls: readonly ReplyCall[];
				readonly emotion?: EmotionEmoji | null;
		  }
	>;
	readonly now: () => number;
	readonly setTimer: (fn: () => void, ms: number) => unknown;
	readonly clearTimer: (handle: unknown) => void;
	readonly emit: (event: AgendaSessionEvent) => void;
	/** Typing counts as typing until this long after the last key. */
	readonly typingIdleMs?: number;
}

/** After a step threw, the next try waits this long. */
const STEP_RETRY_MS = 60_000;

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function createAgendaSession(deps: AgendaSessionDeps) {
	const { agent, now, setTimer, clearTimer, emit } = deps;
	const typingIdleMs = deps.typingIdleMs ?? 4_000;
	let closed = false;
	let typing: unknown = null;
	let replying = false;
	let stepping = false;
	let again = false;
	let timer: unknown = null;
	let collecting = false;
	let backoffUntil = 0;
	let n = 0;
	const seen = new Set<string>();
	/** The memory's and the note's writers, one exchange after another, behind the talk. */
	let writing: Promise<void> = Promise.resolve();
	// Ids stay unique across CLI sessions (the memory keeps the user's words as sources).
	const stamp = now().toString(36);
	const busy = () => typing !== null || replying;

	const handle = (t: AgendaTicket) => {
		if (t.kind === "research") {
			let accepted = false;
			try {
				accepted = deps.research.start(t, now());
			} catch (e) {
				emit({ type: "error", where: "research", message: message(e) });
			}
			agent.researchStarted(t.id, accepted, now());
			emit({
				type: "research",
				text: t.text,
				requested: t.requested,
				accepted,
				...(t.delegatedTo ? { delegatedTo: t.delegatedTo } : {}),
			});
			if (accepted) void collect();
			return;
		}
		let delivered = true;
		try {
			emit({
				type: "speak",
				kind: t.itemKind,
				text: t.utterance,
				emotion: t.emotion,
			});
		} catch (e) {
			delivered = false;
			emit({ type: "error", where: "speak", message: message(e) });
		}
		agent.recordDelivery({
			ticketId: t.id,
			at: now(),
			status: delivered ? "succeeded" : "failed",
		});
	};

	/** Waits for the research out and hands its note to the agent. */
	const collect = async () => {
		if (collecting) return;
		collecting = true;
		try {
			for (;;) {
				const at = deps.research.nextAt();
				if (at === null || closed) return;
				if (at > now()) {
					await new Promise<void>((r) => setTimer(r, at - now()));
					continue;
				}
				const r = await deps.research.due(now());
				if (closed) return;
				if (!r) continue;
				agent.researchReturned({
					ticketId: r.ticketId,
					at: now(),
					status: r.status,
					note: r.note,
				});
				emit({
					type: "researched",
					status: r.status,
					title: r.note?.title ?? null,
					summary: r.note?.summary ?? r.error,
				});
				void kick();
			}
		} catch (e) {
			emit({ type: "error", where: "research", message: message(e) });
		} finally {
			collecting = false;
		}
	};

	/** One step now (or right after the one running), then the timer for the next. */
	const kick = async (): Promise<void> => {
		if (closed) return;
		if (stepping) {
			again = true;
			return;
		}
		stepping = true;
		try {
			do {
				again = false;
				const out = await agent.step(
					now(),
					() => ({ busy: busy() }),
					new AbortController().signal,
				);
				if (closed) return;
				emit({ type: "step", outcome: out });
				for (const t of out.tickets) handle(t);
			} while (again && !closed);
		} catch (e) {
			// A step that keeps failing is not retried at once, over and over.
			backoffUntil = now() + STEP_RETRY_MS;
			emit({ type: "error", where: "step", message: message(e) });
		} finally {
			stepping = false;
			arm();
		}
	};

	/** While busy nothing is planned or said, so the next step waits for the end of it. */
	const arm = () => {
		if (timer !== null) clearTimer(timer);
		timer = null;
		if (closed || busy()) return;
		const next = agent.nextAt(now());
		if (next === null) return;
		const at = Math.max(next, backoffUntil);
		timer = setTimer(
			() => {
				timer = null;
				void kick();
			},
			Math.max(0, at - now()),
		);
	};

	const typingDone = () => {
		if (typing === null) return;
		clearTimer(typing);
		typing = null;
		void kick();
	};

	return {
		start(): void {
			void kick();
		},
		/** A key other than Enter: the user is typing, so nothing is planned or said over them. */
		typed(): void {
			if (closed) return;
			if (typing !== null) clearTimer(typing);
			else if (timer !== null) {
				clearTimer(timer);
				timer = null;
			}
			typing = setTimer(typingDone, typingIdleMs);
		},
		/**
		 * The user submitted a line: the reply, then the plan sees the exchange at once; the memory
		 * and the note are written behind it. Resolves when the reply is out.
		 */
		async say(text: string): Promise<void> {
			if (typing !== null) {
				clearTimer(typing);
				typing = null;
			}
			if (closed) return;
			n++;
			const userId = `u${stamp}.${n}`;
			agent.observe({ id: userId, who: "user", text, at: now() });
			emit({ type: "user", text });
			replying = true;
			const started = now();
			try {
				const tools = createAgendaReplyTools({
					agent,
					read: (id) => deps.docs.read(id),
					now,
					events: {
						onQuiet: (q) => emit({ type: "quiet", ...q }),
						onShow: (d) =>
							emit({
								type: "show",
								id: d.id,
								title: d.title,
								markdown: d.markdown,
							}),
					},
				});
				const out = await deps.reply(agent, tools);
				if (closed) return;
				const {
					text: reply,
					calls,
					emotion,
				} = typeof out === "string"
					? { text: out, calls: [], emotion: null }
					: { emotion: null, ...out };
				if (reply !== "") {
					agent.observe({
						id: `r${stamp}.${n}`,
						who: "reply",
						text: reply,
						at: now(),
						calls,
					});
					for (const id of notesMentioned(reply, deps.docs.list()))
						agent.noteUsed(id, now());
					emit({
						type: "reply",
						text: reply,
						latencyMs: now() - started,
						emotion,
					});
				}
			} catch (e) {
				emit({ type: "error", where: "reply", message: message(e) });
			}
			// The exchange is in: the plan sees it now, and nothing waits for the memory (review
			// 2026-11-10: the writing took 5 s before anything could be planned or said). The
			// writers run behind, one exchange after another; the plan reads what they wrote at
			// its next call (the memory and the note are read at each call).
			replying = false;
			agent.infoChanged(now());
			void kick();
			// The writers see the agent's own speech too: it is what the user answered.
			const said = agent
				.view()
				.said.slice(-8)
				.map((s) => ({ id: s.id, who: s.who, text: s.text }));
			const fresh = said.filter((s) => !seen.has(s.id)).map((s) => s.id);
			for (const s of said) seen.add(s.id);
			writing = writing.then(async () => {
				for (const [type, writer] of [
					["memory", deps.steward],
					["profile", deps.profile ?? null],
				] as const) {
					// Not skipped when the host closes: what the user said is still written (flush).
					if (!writer) continue;
					try {
						const m = await writer({ said, fresh, at: now() });
						if (m.applied.length || m.rejected.length)
							emit({ type, applied: m.applied, rejected: m.rejected });
					} catch (e) {
						emit({ type: "error", where: type, message: message(e) });
					}
				}
			});
		},
		/** The writers' work still out (the host waits for it before it closes the memory). */
		flush(): Promise<void> {
			return writing;
		},
		/** The host's stop: nothing at all until resumed. */
		stop(): void {
			agent.setStopped(true);
			if (timer !== null) clearTimer(timer);
			timer = null;
		},
		resume(): void {
			agent.setStopped(false);
			void kick();
		},
		close(): void {
			closed = true;
			if (timer !== null) clearTimer(timer);
			if (typing !== null) clearTimer(typing);
		},
	};
}
export type AgendaSession = ReturnType<typeof createAgendaSession>;
