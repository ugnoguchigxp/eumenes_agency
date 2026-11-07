/**
 * The always-on host loop of the CLI, without terminal I/O: heartbeat, typing pause, the normal
 * reply, delivery of own speech, running preparations and taking their results back. Clock and
 * timers are injected so the whole loop runs in fixed tests (test/always-on/session.test.ts).
 */
import {
	createHeartbeat,
	createHeartbeatScheduler,
	defaultHeartbeat,
	type AlwaysOnAgent,
	type AlwaysOnTicket,
	type TickOutcome,
} from "../src/index.ts";
import type { MockPreparer } from "../examples/virtual-eumenes/always-on-mock.ts";

export type SessionEvent =
	| { readonly type: "user"; readonly text: string }
	| {
			readonly type: "reply";
			readonly text: string;
			readonly latencyMs: number;
	  }
	| { readonly type: "tick"; readonly outcome: TickOutcome }
	| {
			readonly type: "speak";
			readonly action: "speak" | "ask";
			readonly text: string;
	  }
	| {
			readonly type: "prepare";
			readonly toolName: string | null;
			readonly toolInput: string | null;
			readonly accepted: boolean;
	  }
	| {
			readonly type: "prepared";
			readonly status: string;
			readonly text: string;
	  }
	| {
			readonly type: "error";
			readonly where: string;
			readonly message: string;
	  };

export interface SessionDeps {
	readonly agent: AlwaysOnAgent;
	/** The normal reply to what the user just said (the agent's record holds the conversation). */
	readonly reply: (agent: AlwaysOnAgent) => Promise<string>;
	readonly preparer: Pick<MockPreparer, "start" | "due" | "nextAt">;
	readonly now: () => number;
	readonly setTimer: (fn: () => void, ms: number) => unknown;
	readonly clearTimer: (handle: unknown) => void;
	readonly emit: (event: SessionEvent) => void;
	/** Typing counts as typing until this long after the last key. */
	readonly typingIdleMs?: number;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The kind of a tick for logs and counts: what was actually issued, not what was refused. */
export const tickAction = (o: TickOutcome) =>
	o.skipped ? "skipped" : (o.ticket?.action ?? "wait");

export function createAlwaysOnSession(deps: SessionDeps) {
	const { agent, now, setTimer, clearTimer, emit } = deps;
	const typingIdleMs = deps.typingIdleMs ?? 4_000;
	const heartbeat = createHeartbeat(defaultHeartbeat, now());
	heartbeat.event(now());
	let closed = false;
	let typing: unknown = null;
	let replying = false;
	let inFlight: AbortController | null = null;
	let jobsTimer: unknown = null;
	let n = 0;
	const busy = () => ({ busy: typing !== null || replying });

	/** One timer for the earliest preparation result still out. */
	const armJobs = () => {
		if (jobsTimer !== null) clearTimer(jobsTimer);
		jobsTimer = null;
		const at = deps.preparer.nextAt();
		if (closed || at === null) return;
		jobsTimer = setTimer(
			() => {
				jobsTimer = null;
				void collect();
			},
			Math.max(0, at - now()),
		);
	};
	const collect = async () => {
		try {
			const results = await deps.preparer.due(now());
			if (closed) return;
			for (const r of results) {
				agent.workReturned(r);
				emit({ type: "prepared", status: r.status, text: r.summary });
			}
			if (results.length > 0) {
				heartbeat.event(now());
				scheduler.rearm();
			}
		} catch (e) {
			emit({ type: "error", where: "prepare", message: message(e) });
		}
		armJobs();
	};

	const deliver = (ticket: AlwaysOnTicket) => {
		if (ticket.action === "prepare") {
			const accepted = deps.preparer.start(ticket, now());
			agent.recordResult({
				ticketId: ticket.id,
				status: accepted ? "succeeded" : "failed",
				at: now(),
			});
			emit({
				type: "prepare",
				toolName: ticket.toolName,
				toolInput: ticket.toolInput,
				accepted,
			});
			armJobs();
			return;
		}
		emit({
			type: "speak",
			action: ticket.action,
			text: ticket.utterance ?? "",
		});
		agent.recordResult({ ticketId: ticket.id, status: "succeeded", at: now() });
	};

	const scheduler = createHeartbeatScheduler({
		heartbeat,
		now,
		setTimer,
		clearTimer,
		run: async () => {
			if (closed) return null;
			inFlight = new AbortController();
			try {
				const o = await agent.tick(now(), busy, inFlight.signal);
				if (closed) return null;
				emit({ type: "tick", outcome: o });
				if (o.ticket) deliver(o.ticket);
				return o.skipped ? null : { next: o.next, wakeAt: o.wakeAt };
			} catch (e) {
				emit({ type: "error", where: "tick", message: message(e) });
				return null;
			} finally {
				inFlight = null;
			}
		},
	});

	const typingDone = () => {
		if (typing === null) return;
		clearTimer(typing);
		typing = null;
		heartbeat.leave(now());
		scheduler.rearm();
	};

	return {
		start(): void {
			scheduler.rearm();
		},
		/** A key other than Enter: the user is typing, so nothing is said over them. */
		typed(): void {
			if (closed) return;
			if (typing === null) {
				heartbeat.enter();
				scheduler.rearm();
			} else clearTimer(typing);
			typing = setTimer(typingDone, typingIdleMs);
		},
		/** The user submitted a line: the agent's record gets it, then the normal reply. */
		async say(text: string): Promise<void> {
			typingDone();
			if (closed) return;
			n++;
			agent.invalidate();
			agent.observe({
				id: `u${n}`,
				kind: "exchange.adopted",
				actor: "user",
				occurredAt: now(),
				text,
			});
			emit({ type: "user", text });
			replying = true;
			heartbeat.enter();
			const started = now();
			try {
				const reply = await deps.reply(agent);
				if (closed || reply === "") return;
				agent.observe({
					id: `r${n}`,
					kind: "exchange.adopted",
					actor: "agent",
					occurredAt: now(),
					text: reply,
				});
				emit({ type: "reply", text: reply, latencyMs: now() - started });
			} catch (e) {
				emit({ type: "error", where: "reply", message: message(e) });
			} finally {
				replying = false;
				heartbeat.leave(now());
				heartbeat.event(now());
				scheduler.rearm();
			}
		},
		/** Think now (a test command), unless a tick is running or the user is busy. */
		tickNow: () => scheduler.fireNow(),
		mute(minutes: number): void {
			agent.mute(now() + minutes * 60_000);
		},
		stop(): void {
			agent.setStopped(true);
			heartbeat.stop();
			inFlight?.abort();
		},
		resume(): void {
			agent.setStopped(false);
			agent.mute(null);
			heartbeat.resume(now());
			scheduler.rearm();
		},
		status: () => heartbeat.status(),
		close(): void {
			closed = true;
			scheduler.dispose();
			inFlight?.abort();
			if (jobsTimer !== null) clearTimer(jobsTimer);
			if (typing !== null) clearTimer(typing);
		},
	};
}
export type AlwaysOnSession = ReturnType<typeof createAlwaysOnSession>;
