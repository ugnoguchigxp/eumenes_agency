/**
 * The CLI's host loop for the agenda agent on a fake clock: reply → memory → plan → research →
 * note, typing holds planning and speech, and the reply's tools reach the agent.
 */
import { expect, test } from "bun:test";
import type { LlmPort, LlmRequest } from "../../src/index.ts";
import { createAgendaAgent } from "../../src/agenda/index.ts";
import {
	createAgendaSession,
	type AgendaSessionEvent,
} from "../../standalone/agenda-session.ts";
import { createMockDocStore } from "../../examples/virtual-eumenes/agenda/docs.ts";
import {
	createMockMemory,
	createMockSteward,
	type Steward,
} from "../../examples/virtual-eumenes/agenda/memory.ts";
import {
	createMockWebResearch,
	fixedWriter,
} from "../../examples/virtual-eumenes/agenda/research.ts";

/** A fake clock whose timers run in time order; promises settle between them. */
const fakeClock = () => {
	let now = 0;
	let seq = 0;
	const timers = new Map<number, { at: number; fn: () => void }>();
	const settle = async () => {
		for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r));
	};
	return {
		now: () => now,
		setTimer: (fn: () => void, ms: number) => {
			const id = ++seq;
			timers.set(id, { at: now + ms, fn });
			return id;
		},
		clearTimer: (h: unknown) => void timers.delete(h as number),
		async advance(ms: number) {
			const end = now + ms;
			await settle();
			for (;;) {
				const next = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
				if (!next || next[1].at > end) break;
				timers.delete(next[0]);
				now = Math.max(now, next[1].at);
				next[1].fn();
				await settle();
			}
			now = end;
		},
	};
};

type Data = Record<string, unknown>;
const model: LlmPort = {
	complete<T>(req: LlmRequest<T>) {
		const d = JSON.parse(req.prompt) as Data;
		let value: unknown;
		if (req.system.includes("記憶担当")) {
			const fresh = (
				d["conversation"] as {
					id: string;
					who: string;
					new: boolean;
					text: string;
				}[]
			).filter((s) => s.who === "user" && s.new);
			value = {
				ops: fresh.map((s) => ({
					op: "remember",
					id: null,
					text: s.text,
					evidence: [s.id],
				})),
			};
		} else if (req.system.includes("この呼び出しは「計画」")) {
			const conv = d["conversation"] as { id: string; who: string }[];
			const user = [...conv].reverse().find((s) => s.who === "user");
			const notes = d["notes"] as { id: string; talkedAbout: boolean }[];
			const agenda = d["agenda"] as unknown[];
			value = {
				add: [
					...(user && agenda.length === 0 && notes.length === 0
						? [
								{
									kind: "research",
									text: "辛いラーメンの新店",
									refs: [user.id],
									value: 4,
									reason: "先回り",
									topic: "",
								},
							]
						: []),
					...notes
						.filter((n) => !n.talkedAbout)
						.slice(0, 1)
						.map((n) => ({
							kind: "talk",
							text: "新店の話",
							refs: [n.id],
							value: 3,
							reason: "雑談",
							topic: "",
						})),
				],
				drop: [],
				focus: "",
			};
		} else
			value = {
				utterance:
					"ご存じでしたか？ 新しい店ができたそうです。メモを表示しましょうか？",
				emotion: "😮",
				decline: null,
				questions: 1,
				choice: false,
			};
		return Promise.resolve({
			value: req.schema.parse(value),
			model: "scripted",
			inputTokens: 1,
			outputTokens: 1,
			cacheReadTokens: 0,
			latencyMs: 1,
		});
	},
};

test("say → memory → plan → research → note → talk, held while typing", async () => {
	const clock = fakeClock();
	const events: AgendaSessionEvent[] = [];
	const memory = createMockMemory();
	const docs = createMockDocStore();
	const research = createMockWebResearch({
		writer: fixedWriter,
		docs,
		delayMs: 60_000,
	});
	const agent = createAgendaAgent({
		llm: model,
		startedAt: 0,
		known: memory.known,
		notes: docs.list,
	});
	const session = createAgendaSession({
		agent,
		steward: createMockSteward({ llm: model, memory }),
		docs,
		research,
		reply: async () => "いいですね！",
		emit: (e) => events.push(e),
		...clock,
	});
	session.start();
	await clock.advance(1_000);
	await session.say("辛いラーメンにハマってる");
	await clock.advance(1_000);
	expect(memory.known().map((m) => m.text)).toEqual([
		"辛いラーメンにハマってる",
	]);
	expect(events.find((e) => e.type === "research")).toMatchObject({
		text: "辛いラーメンの新店",
		accepted: true,
	});
	// The user starts typing before the note is back: the talk waits for the typing to stop.
	await clock.advance(58_000);
	session.typed();
	await clock.advance(3_000);
	expect(events.some((e) => e.type === "researched")).toBe(true);
	expect(events.some((e) => e.type === "speak")).toBe(false);
	await clock.advance(5_000);
	expect(events.filter((e) => e.type === "speak")).toMatchObject([
		{ kind: "talk" },
	]);
	expect(docs.list().length).toBe(1);
	session.close();
});

test("the reply's quiet tool holds speech; its pause holds everything", async () => {
	const clock = fakeClock();
	const events: AgendaSessionEvent[] = [];
	const memory = createMockMemory();
	const docs = createMockDocStore();
	const research = createMockWebResearch({
		writer: fixedWriter,
		docs,
		delayMs: 60_000,
	});
	const agent = createAgendaAgent({
		llm: model,
		startedAt: 0,
		known: memory.known,
		notes: docs.list,
	});
	const session = createAgendaSession({
		agent,
		steward: null,
		docs,
		research,
		reply: async (_a, tools) => {
			await tools.call(
				{
					id: "c1",
					name: "set_quiet",
					arguments: JSON.stringify({ scope: "all", minutes: 10 }),
				},
				new AbortController().signal,
			);
			return "止めます。";
		},
		emit: (e) => events.push(e),
		...clock,
	});
	session.start();
	await session.say("探索を一時停止して");
	await clock.advance(9 * 60_000);
	expect(
		events.filter((e) => e.type === "research" || e.type === "speak"),
	).toEqual([]);
	await clock.advance(5 * 60_000);
	expect(events.some((e) => e.type === "research")).toBe(true);
	session.close();
});

test("review 2026-11-10: the plan and speech do not wait for the memory; it is written behind, in order", async () => {
	const clock = fakeClock();
	const events: AgendaSessionEvent[] = [];
	const memory = createMockMemory();
	const docs = createMockDocStore();
	const research = createMockWebResearch({
		writer: fixedWriter,
		docs,
		delayMs: 60_000,
	});
	const agent = createAgendaAgent({
		llm: model,
		startedAt: 0,
		known: memory.known,
		notes: docs.list,
	});
	const inner = createMockSteward({ llm: model, memory });
	let release!: () => void;
	const gate = new Promise<void>((r) => (release = r));
	const order: string[] = [];
	const steward: Steward = async (r) => {
		await gate;
		order.push(r.fresh.join(" "));
		return inner(r);
	};
	const session = createAgendaSession({
		agent,
		steward,
		docs,
		research,
		reply: async () => "いいですね！",
		emit: (e) => events.push(e),
		...clock,
	});
	session.start();
	await session.say("辛いラーメンにハマってる");
	await clock.advance(1_000);
	// The plan ran on the exchange and its research started while the memory is still written.
	expect(events.find((e) => e.type === "research")).toMatchObject({
		text: "辛いラーメンの新店",
	});
	expect(memory.known()).toEqual([]);
	await session.say("パクチーは苦手");
	release();
	await session.flush();
	// One exchange after another.
	expect(memory.known().map((m) => m.text)).toEqual([
		"辛いラーメンにハマってる",
		"パクチーは苦手",
	]);
	expect(order[0]).toContain("u0.1");
	expect(order[1]).toContain("u0.2");
	session.close();
});

test("CLI 2026-11-10: the reply event carries the tools it called, for the log", async () => {
	const clock = fakeClock();
	const events: AgendaSessionEvent[] = [];
	const memory = createMockMemory();
	const docs = createMockDocStore();
	const research = createMockWebResearch({
		writer: fixedWriter,
		docs,
		delayMs: 60_000,
	});
	const agent = createAgendaAgent({
		llm: model,
		startedAt: 0,
		known: memory.known,
		notes: docs.list,
	});
	const calls = [
		{
			name: "start_preparation",
			arguments: JSON.stringify({ request: "-0.0の見どころ" }),
			content: "accepted: 頼んだ",
		},
	];
	const session = createAgendaSession({
		agent,
		steward: null,
		docs,
		research,
		reply: async () => ({
			text: "調べるよう頼みました。",
			calls,
			emotion: null,
		}),
		emit: (e) => events.push(e),
		...clock,
	});
	session.start();
	await session.say("-0.0の見どころを調べて");
	expect(events.find((e) => e.type === "reply")).toMatchObject({
		text: "調べるよう頼みました。",
		calls,
	});
	session.close();
});
