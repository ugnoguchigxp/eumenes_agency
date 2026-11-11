/**
 * The agenda agent's host loop, host-neutral: what a host (Eumenes, the CLI) runs around the
 * agent. Typing and the reply make it busy; each exchange goes to the memory's and the note's
 * writers behind the talk (nothing waits for them); research tickets go to the host's researcher
 * and their results come back through `researchReturned`; the agent is stepped when something is
 * due, and words the user sends while a reply is written go into that reply (steer). Clock and
 * timers are injected, so the same loop runs in fixed tests and in the host.
 */
import type { EmotionEmoji, ReplyPort, ToolPort } from "../contracts/index.ts";
import type { AgendaAgent } from "./agent.ts";
import type {
	AgendaTicket,
	NoteRef,
	QuietScope,
	ReplyCall,
	StepOutcome,
} from "./contracts.ts";
import {
	createAgendaReplyTools,
	notesMentioned,
	type AgendaNoteText,
	type AgendaToolchains,
} from "./reply.ts";
import type { AgendaReplySteering } from "./steer.ts";

export type AgendaHostEvent =
	| { readonly type: "user"; readonly text: string }
	| {
			readonly type: "reply";
			readonly text: string;
			readonly latencyMs: number;
			/** The feeling the reply is said with (its leading emoji, removed from the text). */
			readonly emotion: EmotionEmoji | null;
			/** The tools it called and what they answered (the CLI, 2026-11-10: a reply said it had
			 * asked for research, and the log could not tell whether it had). */
			readonly calls: readonly ReplyCall[];
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

/** One pass of a writer over the latest exchange (Eumenes: the steward; the profile note). */
export type AgendaWriter = (input: {
	readonly said: readonly { id: string; who: string; text: string }[];
	/** Words not seen in an earlier pass: only these can be evidence. */
	readonly fresh: readonly string[];
	readonly at: number;
}) => Promise<{
	readonly applied: readonly string[];
	readonly rejected: readonly string[];
}>;

export type AgendaReplyOutput =
	| string
	| {
			readonly text: string;
			readonly calls: readonly ReplyCall[];
			readonly emotion?: EmotionEmoji | null;
	  };

export interface AgendaHostDeps {
	readonly agent: AgendaAgent;
	/** The memory's writer, run after each exchange. */
	readonly memory?: AgendaWriter | null;
	/** The plans-and-interests note's writer, run after the memory's (it leaves out what that holds). */
	readonly profile?: AgendaWriter | null;
	/** The researcher's notes (Eumenes: its Markdown documents). */
	readonly notes: {
		read(id: string): AgendaNoteText | null;
		list(): readonly NoteRef[];
	};
	/**
	 * Hands a research ticket to the researcher (web research; work for a toolchain when it has
	 * `delegatedTo`): true when taken. The host calls `researchReturned` when it is done.
	 */
	readonly research: {
		start(
			ticket: Extract<AgendaTicket, { kind: "research" }>,
			at: number,
		): boolean;
	};
	/** The toolchain catalog for the reply's find_toolchain and delegate (absent: no such tools). */
	readonly toolchains?: AgendaToolchains;
	/**
	 * The normal reply (runRespond with the host's chat port, over `agendaReplyMessages`); its tool
	 * calls go into the agent's record so the next reply sees them. `steer` wraps its chat port so
	 * that each model call takes the words sent meanwhile.
	 */
	readonly reply: (
		agent: AgendaAgent,
		tools: ToolPort,
		steer: (chat: ReplyPort) => ReplyPort,
	) => Promise<AgendaReplyOutput>;
	/**
	 * Words sent while a reply is written go into its next model call (eumenes-steer); without it
	 * they wait for a reply of their own.
	 */
	readonly steering?: AgendaReplySteering;
	readonly now: () => number;
	readonly setTimer: (fn: () => void, ms: number) => unknown;
	readonly clearTimer: (handle: unknown) => void;
	readonly emit: (event: AgendaHostEvent) => void;
	/** Typing counts as typing until this long after the last key. */
	readonly typingIdleMs?: number;
	/** Ids of the user's lines and the replies are `u<idPrefix>.<n>` and `r<idPrefix>.<n>`. */
	readonly idPrefix?: string;
}

/** After a step threw, the next try waits this long (not a tight loop; it was a minute). */
const STEP_RETRY_MS = 10_000;

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function createAgendaHost(deps: AgendaHostDeps) {
	const { agent, now, setTimer, clearTimer, emit } = deps;
	const typingIdleMs = deps.typingIdleMs ?? 4_000;
	let closed = false;
	let typing: unknown = null;
	let replying = false;
	let stepping = false;
	let again = false;
	let timer: unknown = null;
	/** The step out now: the user's words call it off (its plan and line are stale). */
	let inFlight: AbortController | null = null;
	let backoffUntil = 0;
	let n = 0;
	const seen = new Set<string>();
	/** The memory's and the note's writers, one exchange after another, behind the talk. */
	let writing: Promise<void> = Promise.resolve();
	/** The reply out now, with the replies to words sent meanwhile that it did not take. */
	let replies: Promise<void> = Promise.resolve();
	/** Words sent while a reply is written (their ids). */
	let sentMeanwhile: string[] = [];
	// Ids stay unique across sessions (the memory keeps the user's words as sources).
	const stamp = deps.idPrefix ?? now().toString(36);
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
				inFlight = new AbortController();
				const out = await agent.step(
					now(),
					() => ({ busy: busy() }),
					inFlight.signal,
				);
				inFlight = null;
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

	/** The memory's and the note's writers see the exchange, behind the talk. */
	const write = () => {
		// The writers see the agent's own speech too: it is what the user answered.
		const said = agent
			.view()
			.said.slice(-8)
			.map((s) => ({ id: s.id, who: s.who, text: s.text }));
		const fresh = said.filter((s) => !seen.has(s.id)).map((s) => s.id);
		for (const s of said) seen.add(s.id);
		writing = writing.then(async () => {
			for (const [type, writer] of [
				["memory", deps.memory ?? null],
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
	};

	/**
	 * The reply to the user's latest words. Words sent while it is written go into its next model
	 * call (steer); those no call took get a reply of their own right after it. Then the plan sees
	 * the exchange at once, and nothing waits for the memory (review 2026-11-10: the writing took
	 * 5 s before anything could be planned or said); the writers run behind, one exchange after
	 * another, and the plan reads what they wrote at its next call.
	 */
	const answer = async (): Promise<void> => {
		try {
			for (;;) {
				const replyId = `r${stamp}.${n}`;
				let run: ReturnType<AgendaReplySteering["begin"]> | null = null;
				try {
					run = deps.steering?.begin(replyId) ?? null;
				} catch (e) {
					// No steer for this reply: words sent meanwhile get a reply of their own.
					emit({ type: "error", where: "steer", message: message(e) });
				}
				const started = now();
				let answered = false;
				let taken = new Set<string>();
				try {
					const tools = createAgendaReplyTools({
						agent,
						read: (id) => deps.notes.read(id),
						now,
						...(deps.toolchains ? { toolchains: deps.toolchains } : {}),
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
					const out = await deps.reply(agent, tools, (chat) =>
						run ? run.wrap(chat) : chat,
					);
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
							id: replyId,
							who: "reply",
							text: reply,
							at: now(),
							calls,
						});
						for (const id of notesMentioned(reply, deps.notes.list()))
							agent.noteUsed(id, now());
						emit({
							type: "reply",
							text: reply,
							latencyMs: now() - started,
							emotion,
							calls,
						});
						answered = true;
					}
				} catch (e) {
					emit({ type: "error", where: "reply", message: message(e) });
				} finally {
					// The target is closed whatever happened (one inbox serves the whole server).
					if (run) taken = new Set(run.end());
				}
				// What a model call of this reply took is answered when the reply came out; the rest,
				// and all of it when no reply came, gets the next reply (review 2026-11-11).
				if (!answered) taken = new Set();
				write();
				sentMeanwhile = sentMeanwhile.filter((id) => !taken.has(id));
				if (sentMeanwhile.length === 0 || closed) return;
				sentMeanwhile = [];
			}
		} finally {
			replying = false;
			agent.infoChanged(now());
			void kick();
		}
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
		 * and the note are written behind it. While a reply is being written, the line goes into it
		 * (steer) or gets a reply of its own right after. Resolves when the replies are out.
		 */
		say(text: string): Promise<void> {
			if (typing !== null) {
				clearTimer(typing);
				typing = null;
			}
			if (closed) return Promise.resolve();
			n++;
			const userId = `u${stamp}.${n}`;
			agent.observe({ id: userId, who: "user", text, at: now() });
			// The plan and the line out now are for words before these: called off, so the next
			// step (right after the reply) does not wait for them (review 2026-11-10 evening 4.2 B).
			inFlight?.abort();
			emit({ type: "user", text });
			if (replying) {
				sentMeanwhile.push(userId);
				deps.steering?.send(userId);
				return replies;
			}
			replying = true;
			replies = answer();
			return replies;
		},
		/** A research ticket is done (its note saved, or it failed): the agent hears of it. */
		researchReturned(r: {
			readonly ticketId: string;
			readonly status: "succeeded" | "failed";
			readonly note: NoteRef | null;
			readonly error?: string | null;
		}): void {
			if (closed) return;
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
				summary: r.note?.summary ?? r.error ?? null,
			});
			void kick();
		},
		/** Waits for the replies out, then for the writers (the host waits before it closes the memory). */
		async flush(): Promise<void> {
			await replies;
			await writing;
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
export type AgendaHost = ReturnType<typeof createAgendaHost>;
