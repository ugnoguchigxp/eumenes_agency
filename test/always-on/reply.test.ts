/** The reply as the agent's own voice: its state, a tool to start preparations, memory across sessions. */
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAlwaysOnAgent, type ReplyToolCall } from "../../src/index.ts";
import {
	alwaysOnReplySystem,
	createReplyTools,
	loadAgentState,
	replyMessages,
	saveAgentState,
	startPreparationTool,
} from "../../standalone/always-on-host.ts";
import { createAlwaysOnSession } from "../../standalone/always-on-session.ts";
import {
	alwaysOnMockTools,
	createMockPreparer,
} from "../../examples/virtual-eumenes/always-on-mock.ts";
import { idle, scriptedThink, signal, wait } from "./helpers.ts";

const user = (id: string, at: number, text: string) => ({
	id,
	kind: "exchange.adopted" as const,
	actor: "user" as const,
	occurredAt: at,
	text,
});
const call = (args: unknown): ReplyToolCall => ({
	id: "c1",
	name: "start_preparation",
	arguments: JSON.stringify(args),
});

describe("requested preparation", () => {
	test("the user's request starts a preparation resting on their words", () => {
		const agent = createAlwaysOnAgent({
			llm: scriptedThink(() => wait()),
			tools: alwaysOnMockTools,
		});
		expect(
			agent.requestPrepare({ toolName: "research", toolInput: "q", at: 0 }),
		).toEqual({ rejected: "needs_user_request" });
		agent.observe(user("u1", 0, "最終確認のチェックリスト作って"));
		const r = agent.requestPrepare({
			toolName: "make_note",
			toolInput: "最終確認のチェックリスト",
			at: 1,
		});
		expect("ticket" in r && r.ticket.evidenceRefs).toEqual(["u1"]);
		expect(agent.view().preparing[0]).toMatchObject({ requested: true });
		expect(
			agent.requestPrepare({
				toolName: "make_note",
				toolInput: "最終確認のチェックリスト",
				at: 2,
			}),
		).toEqual({ rejected: "duplicate_prepare" });
		expect(
			agent.requestPrepare({ toolName: "send_message", toolInput: "x", at: 3 }),
		).toEqual({ rejected: "tool_not_autonomous" });
		// Forgetting the request drops the preparation too.
		agent.forget(["u1"]);
		expect(agent.view().preparing).toEqual([]);
	});

	test("the reply's tool offers only usable tools and turns refusals into results", async () => {
		expect(
			(
				startPreparationTool(alwaysOnMockTools).parameters as {
					properties: { toolName: { enum: string[] } };
				}
			).properties.toolName.enum,
		).toEqual(["research", "make_note"]);
		const agent = createAlwaysOnAgent({
			llm: scriptedThink(() => wait()),
			tools: alwaysOnMockTools,
		});
		const started: string[] = [];
		const port = createReplyTools({
			agent,
			tools: alwaysOnMockTools,
			now: () => 0,
			start: (t) => started.push(t.toolInput ?? ""),
		});
		const s = new AbortController().signal;
		expect(
			(await port.call(call({ toolName: "research", toolInput: "q" }), s))
				.content,
		).toBe("refused: needs_user_request");
		agent.observe(user("u1", 0, "調べて"));
		expect(
			(await port.call(call({ toolName: "research", toolInput: "q" }), s))
				.content,
		).toStartWith("started: research: q");
		expect(started).toEqual(["q"]);
		expect(
			(
				await port.call(
					{ id: "c2", name: "start_preparation", arguments: "{" },
					s,
				)
			).content,
		).toBe("refused: invalid_arguments");
	});

	test("in the CLI loop, a reply that starts a preparation is followed by its result", async () => {
		let now = 0;
		const timers: { at: number; fn: () => void }[] = [];
		const preparer = createMockPreparer({
			subagent: {
				run: async () => ({
					status: "succeeded",
					summary: "チェックリスト本文",
				}),
			},
			delayMs: 60_000,
		});
		const agent = createAlwaysOnAgent({
			llm: scriptedThink(() => wait()),
			tools: preparer.tools,
		});
		const kinds: string[] = [];
		const session = createAlwaysOnSession({
			agent,
			preparer,
			now: () => now,
			setTimer: (fn, ms) => {
				timers.push({ at: now + ms, fn });
				return timers.length;
			},
			clearTimer: () => undefined,
			emit: (e) => kinds.push(e.type),
			reply: async (_a, tools) => {
				await tools.call(
					call({
						toolName: "make_note",
						toolInput: "最終確認のチェックリスト",
					}),
					new AbortController().signal,
				);
				return "最終確認のチェックリストを作り始めました。";
			},
		});
		await session.say("最終確認なので自分から動いてほしい");
		expect(kinds).toEqual(["user", "prepare", "reply"]);
		expect(agent.view().preparing[0]).toMatchObject({ requested: true });
		now = 60_000;
		for (const t of timers.filter((t) => t.at <= now)) t.fn();
		for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
		expect(kinds).toContain("prepared");
		expect(agent.view().stock[0]).toMatchObject({
			kind: "finding",
			text: "チェックリスト本文",
		});
		session.close();
	});
});

describe("the reply as the agent's voice", () => {
	test("its instructions name its abilities; its state is reference data", async () => {
		const system = alwaysOnReplySystem([], alwaysOnMockTools);
		expect(system).toContain("research（");
		expect(system).toContain("make_note（");
		expect(system).not.toContain("send_message");
		const agent = createAlwaysOnAgent({
			llm: scriptedThink(() => wait()),
			tools: alwaysOnMockTools,
		});
		agent.observe(user("u1", 0, "調べて"));
		agent.requestPrepare({
			toolName: "research",
			toolInput: "辛いラーメン",
			at: 1,
		});
		await agent.tick(10_000, idle, signal());
		const state = replyMessages(agent, [], alwaysOnMockTools)[1]!.content;
		expect(state).toContain("辛いラーメン");
		expect(state).toContain("askedByUser");
		expect(state).toContain("今は様子を見る");
	});

	test("the reply sees only the latest turns, however long the record grows", () => {
		const agent = createAlwaysOnAgent({ llm: scriptedThink(() => wait()) });
		for (let i = 0; i < 100; i++) agent.observe(user(`u${i}`, i, `発言${i}`));
		const turns = replyMessages(agent, []).slice(2);
		expect(turns.length).toBe(1);
		expect(turns[0]!.content).toContain("発言99");
		expect(turns[0]!.content).not.toContain("発言59\\n");
	});
});

describe("memory across sessions", () => {
	test("the saved agent comes back, and a new session's words are not taken for old ones", async () => {
		const dir = mkdtempSync(join(tmpdir(), "always-on-"));
		const path = join(dir, "state.json");
		expect(loadAgentState(path)).toBeNull();
		const first = createAlwaysOnAgent({ llm: scriptedThink(() => wait()) });
		let now = 1_000;
		const opts = (agent: ReturnType<typeof createAlwaysOnAgent>) => ({
			agent,
			preparer: createMockPreparer({
				subagent: { run: async () => ({ status: "succeeded", summary: "" }) },
				delayMs: 1,
			}),
			now: () => now,
			setTimer: () => 0,
			clearTimer: () => undefined,
			emit: () => undefined,
			reply: async () => "うん",
		});
		const s1 = createAlwaysOnSession(opts(first));
		await s1.say("辛いラーメンが好き");
		s1.close();
		saveAgentState(path, first.snapshot());
		const second = createAlwaysOnAgent({
			llm: scriptedThink(() => wait()),
			restore: loadAgentState(path)!,
		});
		now = 90_000_000;
		const s2 = createAlwaysOnSession(opts(second));
		await s2.say("ただいま");
		s2.close();
		expect(second.snapshot().observations.map((o) => o.text)).toEqual([
			"辛いラーメンが好き",
			"うん",
			"ただいま",
			"うん",
		]);
	});
});
