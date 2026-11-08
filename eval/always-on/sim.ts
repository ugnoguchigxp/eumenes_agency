/**
 * Virtual-clock driver for the always-on agent: the same heartbeat rule the CLI uses, scripted
 * user turns at fixed times, immediate delivery of tickets. Used by the free silence check
 * (scripted model) and the live check (real model).
 */
import {
	createAlwaysOnAgent,
	createHeartbeat,
	defaultHeartbeat,
	type AlwaysOnAgent,
	type AlwaysOnDeps,
	type TickOutcome,
	type ToolPort,
} from "../../src/index.ts";
import type { MockPreparer } from "../../examples/virtual-eumenes/always-on-mock.ts";
import { createReplyTools } from "../../standalone/always-on-host.ts";

export interface UserTurn {
	readonly atSec: number;
	readonly text: string;
}

export type SimEvent =
	| { readonly type: "user"; readonly atSec: number; readonly text: string }
	| { readonly type: "reply"; readonly atSec: number; readonly text: string }
	| {
			readonly type: "prepared";
			readonly atSec: number;
			readonly status: string;
			readonly text: string;
	  }
	| {
			readonly type: "tick";
			readonly atSec: number;
			readonly action: "wait" | "speak" | "ask" | "prepare" | "skipped";
			readonly applied: readonly string[];
			readonly drive: string | null;
			readonly thought: string | null;
			readonly text: string | null;
			readonly rejected: readonly string[];
			readonly next: string;
			readonly latencyMs: number | null;
			readonly code: string | null;
			readonly inputTokens: number;
			readonly outputTokens: number;
	  };

export interface SimInput {
	readonly deps: AlwaysOnDeps;
	readonly minutes: number;
	readonly turns?: readonly UserTurn[];
	/** The normal reply to a user turn (absent: no reply is made); `tools` starts preparations. */
	readonly reply?: (
		agent: AlwaysOnAgent,
		atMs: number,
		tools: ToolPort,
	) => Promise<string>;
	readonly onEvent?: (e: SimEvent) => void;
	/** Runs prepare tickets (absent: every preparation is refused by the host). */
	readonly preparer?: MockPreparer;
	/** Virtual time the session starts at (a later session of a restored agent starts later). */
	readonly startMs?: number;
}

export interface SimResult {
	readonly agent: AlwaysOnAgent;
	readonly events: readonly SimEvent[];
	readonly ticks: number;
	readonly utterances: number;
	readonly prepares: number;
	readonly lastTickSec: number | null;
}

export async function simulate(input: SimInput): Promise<SimResult> {
	const agent = createAlwaysOnAgent(input.deps);
	const start = input.startMs ?? 0;
	const heartbeat = createHeartbeat(defaultHeartbeat, start);
	const end = start + input.minutes * 60_000;
	const turns = [...(input.turns ?? [])].sort((a, b) => a.atSec - b.atSec);
	const events: SimEvent[] = [];
	const emit = (e: SimEvent) => {
		events.push(e);
		input.onEvent?.(e);
	};
	let now = start;
	let n = 0;
	const stamp = start.toString(36);
	let ticks = 0;
	let utterances = 0;
	let prepares = 0;
	let lastTick: number | null = null;
	heartbeat.event(start);
	for (;;) {
		const delay = heartbeat.delayMs(now);
		const tickAt = delay === null ? Number.POSITIVE_INFINITY : now + delay;
		const turn = turns[0];
		const turnAt = turn ? start + turn.atSec * 1000 : Number.POSITIVE_INFINITY;
		const jobAt = input.preparer?.nextAt() ?? Number.POSITIVE_INFINITY;
		if (Math.min(tickAt, turnAt, jobAt) > end) break;
		if (jobAt <= Math.min(tickAt, turnAt)) {
			now = jobAt;
			for (const r of await input.preparer!.due(now)) {
				agent.workReturned(r);
				emit({
					type: "prepared",
					atSec: (now - start) / 1000,
					status: r.status,
					text: r.summary,
				});
			}
			heartbeat.event(now);
			continue;
		}
		if (turn && turnAt <= tickAt) {
			turns.shift();
			now = turnAt;
			n++;
			agent.invalidate();
			agent.observe({
				id: `u${stamp}.${n}`,
				kind: "exchange.adopted",
				actor: "user",
				occurredAt: now,
				text: turn.text,
			});
			emit({ type: "user", atSec: (now - start) / 1000, text: turn.text });
			if (input.reply) {
				const tools = createReplyTools({
					agent,
					tools: input.deps.tools ?? [],
					now: () => now,
					start: (ticket) => {
						const accepted = input.preparer?.start(ticket, now) ?? false;
						if (accepted) prepares++;
						agent.recordResult({
							ticketId: ticket.id,
							status: accepted ? "succeeded" : "failed",
							at: now,
						});
						emit({
							type: "tick",
							atSec: (now - start) / 1000,
							action: "prepare",
							applied: [],
							drive: "requested",
							thought: null,
							text: `${ticket.toolName}: ${ticket.toolInput}（返事から）`,
							rejected: [],
							next: "normal",
							latencyMs: null,
							code: null,
							inputTokens: 0,
							outputTokens: 0,
						});
					},
				});
				const text = await input.reply(agent, now, tools);
				agent.observe({
					id: `r${stamp}.${n}`,
					kind: "exchange.adopted",
					actor: "agent",
					occurredAt: now,
					text,
				});
				emit({ type: "reply", atSec: (now - start) / 1000, text });
			}
			heartbeat.event(now);
			continue;
		}
		now = tickAt;
		ticks++;
		lastTick = now;
		const out: TickOutcome = await agent.tick(
			now,
			() => ({ busy: false }),
			new AbortController().signal,
		);
		if (out.ticket?.action === "prepare") {
			const accepted = input.preparer?.start(out.ticket, now) ?? false;
			if (accepted) prepares++;
			agent.recordResult({
				ticketId: out.ticket.id,
				status: accepted ? "succeeded" : "failed",
				at: now,
			});
		} else if (out.ticket) {
			utterances++;
			agent.recordResult({
				ticketId: out.ticket.id,
				status: "succeeded",
				at: now,
			});
		}
		emit({
			type: "tick",
			atSec: (now - start) / 1000,
			action: out.skipped ? "skipped" : (out.ticket?.action ?? "wait"),
			applied: out.applied,
			drive: out.thought?.drive ?? null,
			thought: out.thought?.text ?? null,
			text:
				out.ticket?.utterance ??
				(out.ticket ? `${out.ticket.toolName}: ${out.ticket.toolInput}` : null),
			rejected: out.rejected,
			next: out.next,
			latencyMs: out.call?.latencyMs ?? null,
			code: out.call?.code ?? out.skipped,
			inputTokens: out.call?.inputTokens ?? 0,
			outputTokens: out.call?.outputTokens ?? 0,
		});
		heartbeat.ticked(now, out.next);
		if (out.wakeAt !== null) heartbeat.wakeBy(now, out.wakeAt);
	}
	return {
		agent,
		events,
		ticks,
		utterances,
		prepares,
		lastTickSec: lastTick === null ? null : (lastTick - start) / 1000,
	};
}
