/**
 * The agenda agent's host loop for the CLI, without terminal I/O: the packaged host loop
 * (src/agenda/host.ts, what Eumenes runs) with the CLI's stand-ins behind its ports: the mock
 * documents for notes, the stand-in researcher (one request at a time, polled here for its
 * result), the steward and the profile note's writer, and the mock toolchains. Clock and timers
 * are injected so the loop runs in fixed tests.
 */
import {
	createAgendaHost,
	type AgendaHostEvent,
	type AgendaReplyOutput,
	type AgendaReplySteering,
} from "../src/agenda/index.ts";
import type { AgendaAgent } from "../src/agenda/index.ts";
import type { ReplyPort, ToolPort } from "../src/index.ts";
import { mockToolchains } from "./agenda-reply.ts";
import type { MockDocStore } from "../examples/virtual-eumenes/agenda/docs.ts";
import type { Steward } from "../examples/virtual-eumenes/agenda/memory.ts";
import type { MockWebResearch } from "../examples/virtual-eumenes/agenda/research.ts";

export type AgendaSessionEvent = AgendaHostEvent;

export interface AgendaSessionDeps {
	readonly agent: AgendaAgent;
	/** The memory's writer, run after each exchange. */
	readonly steward: Steward | null;
	/** The plans-and-interests note's writer, run after the memory's (it leaves out what that holds). */
	readonly profile?: Steward | null;
	readonly docs: MockDocStore;
	readonly research: MockWebResearch;
	/**
	 * The normal reply; its tool calls go into the agent's record so the next reply sees them.
	 * `steer` wraps its chat port so that each model call takes the words sent meanwhile.
	 */
	readonly reply: (
		agent: AgendaAgent,
		tools: ToolPort,
		steer: (chat: ReplyPort) => ReplyPort,
	) => Promise<AgendaReplyOutput>;
	readonly now: () => number;
	readonly setTimer: (fn: () => void, ms: number) => unknown;
	readonly clearTimer: (handle: unknown) => void;
	readonly emit: (event: AgendaSessionEvent) => void;
	/** Typing counts as typing until this long after the last key. */
	readonly typingIdleMs?: number;
	/** Words sent while a reply is written go into its next model call (eumenes-steer). */
	readonly steering?: AgendaReplySteering;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function createAgendaSession(deps: AgendaSessionDeps) {
	const { now, setTimer, emit } = deps;
	let closed = false;
	let collecting = false;
	const host = createAgendaHost({
		agent: deps.agent,
		memory: deps.steward,
		profile: deps.profile ?? null,
		notes: { read: (id) => deps.docs.read(id), list: () => deps.docs.list() },
		research: {
			start: (t, at) => {
				const accepted = deps.research.start(t, at);
				if (accepted) void collect();
				return accepted;
			},
		},
		toolchains: mockToolchains,
		reply: deps.reply,
		...(deps.steering ? { steering: deps.steering } : {}),
		now,
		setTimer,
		clearTimer: deps.clearTimer,
		emit,
		...(deps.typingIdleMs !== undefined
			? { typingIdleMs: deps.typingIdleMs }
			: {}),
	});

	/** Waits for the research out and hands its note to the host. */
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
				host.researchReturned(r);
			}
		} catch (e) {
			emit({ type: "error", where: "research", message: message(e) });
		} finally {
			collecting = false;
		}
	};

	return {
		...host,
		close(): void {
			closed = true;
			host.close();
		},
	};
}
export type AgendaSession = ReturnType<typeof createAgendaSession>;
