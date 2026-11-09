/**
 * The agenda agent wired into the mock Eumenes (memory and steward, documents, one-at-a-time
 * web_research, the reply's tools) on a virtual clock, with scripted models.
 */
import { expect, test } from "bun:test";
import type { LlmPort, LlmRequest } from "../../src/index.ts";
import { createMockDocStore } from "../../examples/virtual-eumenes/agenda/docs.ts";
import {
	createMockMemory,
	createMockSteward,
} from "../../examples/virtual-eumenes/agenda/memory.ts";
import {
	createMockWebResearch,
	fixedWriter,
} from "../../examples/virtual-eumenes/agenda/research.ts";
import { simulateAgenda } from "../../eval/agenda/sim.ts";

type Data = Record<string, unknown>;

/** Steward: remembers each new user line; plan: one research and one ask per new user line. */
const model = (): LlmPort => ({
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
			const conv = d["conversation"] as {
				id: string;
				who: string;
				text: string;
			}[];
			const user = [...conv].reverse().find((s) => s.who === "user");
			const memory = (d["user"] as { memory: { id: string }[] }).memory;
			const asked =
				(d["agenda"] as unknown[]).length +
				(d["askedBefore"] as unknown[]).length;
			value = {
				add:
					user && asked === 0
						? [
								{
									kind: "research",
									text: `下調べ: ${user.text}`,
									refs: [user.id],
									value: 4,
									reason: "先回り",
								},
								{
									kind: "ask",
									text: "好きな食べ物",
									refs: memory.slice(0, 1).map((m) => m.id),
									value: 3,
									reason: "知りたい",
								},
							]
						: [],
				drop: [],
			};
		} else
			value = {
				utterance: `「${(d["item"] as { text: string }).text}」について話す`,
				emotion: "😊",
				decline: null,
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
});

test("quiet for speech: the reply sets it, research goes on into a note, speech waits", async () => {
	const llm = model();
	const memory = createMockMemory();
	const docs = createMockDocStore();
	const research = createMockWebResearch({
		writer: fixedWriter,
		docs,
		delayMs: 120_000,
	});
	const { events } = await simulateAgenda({
		deps: { llm },
		minutes: 40,
		turns: [{ atSec: 0, text: "30分は話しかけないで" }],
		memory,
		steward: createMockSteward({ llm, memory }),
		docs,
		research,
		reply: async (_agent, _at, tools) => {
			await tools.call(
				{
					id: "c1",
					name: "set_quiet",
					arguments: JSON.stringify({ scope: "speech", minutes: 30 }),
				},
				new AbortController().signal,
			);
			return "わかりました。";
		},
	});
	const spoke = events.filter((e) => e.type === "speak");
	expect(spoke.length).toBeGreaterThan(0);
	expect(spoke.every((e) => e.atSec >= 1800)).toBe(true);
	expect(events.find((e) => e.type === "researched")).toMatchObject({
		status: "succeeded",
		atSec: 120,
	});
	expect(docs.list().length).toBe(1);
	expect(memory.known().map((k) => k.text)).toEqual(["30分は話しかけないで"]);
});

test("a later session: a fresh agent, the memory and notes are still there", async () => {
	const llm = model();
	const memory = createMockMemory();
	const docs = createMockDocStore();
	const research = createMockWebResearch({
		writer: fixedWriter,
		docs,
		delayMs: 60_000,
	});
	const base = {
		deps: { llm },
		memory,
		steward: createMockSteward({ llm, memory }),
		docs,
		research,
	};
	await simulateAgenda({
		...base,
		minutes: 5,
		turns: [{ atSec: 0, text: "辛いラーメンが好き" }],
		reply: async () => "いいですね",
	});
	expect(docs.list().length).toBe(1);
	const prompts: Data[] = [];
	const spy: LlmPort = {
		complete(req, s) {
			if (req.system.includes("この呼び出しは「計画」"))
				prompts.push(JSON.parse(req.prompt) as Data);
			return llm.complete(req, s);
		},
	};
	await simulateAgenda({
		...base,
		deps: { llm: spy },
		startMs: 20 * 3_600_000,
		minutes: 1,
		turns: [],
	});
	expect(
		(prompts[0]!["user"] as { memory: { text: string }[] }).memory.map(
			(m) => m.text,
		),
	).toEqual(["辛いラーメンが好き"]);
	expect((prompts[0]!["notes"] as unknown[]).length).toBe(1);
});

test("pause: the reply pauses everything; nothing runs until it ends", async () => {
	const llm = model();
	const memory = createMockMemory();
	const docs = createMockDocStore();
	const research = createMockWebResearch({
		writer: fixedWriter,
		docs,
		delayMs: 60_000,
	});
	const { events } = await simulateAgenda({
		deps: { llm },
		minutes: 20,
		turns: [{ atSec: 0, text: "探索を一時停止して。10分ね" }],
		memory,
		steward: null,
		docs,
		research,
		reply: async (_a, _t, tools) => {
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
	});
	const acted = events.filter((e) =>
		["plan", "research", "speak", "compose"].includes(e.type),
	);
	expect(acted.length).toBeGreaterThan(0);
	expect(acted.every((e) => e.atSec >= 600)).toBe(true);
});

test("a simulated user answers the agent's own speech a little later, unless away", async () => {
	const llm = model();
	const memory = createMockMemory();
	const docs = createMockDocStore();
	const research = createMockWebResearch({
		writer: fixedWriter,
		docs,
		delayMs: 60_000,
	});
	const { events } = await simulateAgenda({
		deps: { llm },
		minutes: 10,
		turns: [{ atSec: 0, text: "辛いラーメンが好き" }],
		memory,
		steward: createMockSteward({ llm, memory }),
		docs,
		research,
		reply: async () => "いいですね",
		// Away from 400 s on. The general question waits until the talk is over (300 s).
		user: async (ctx) =>
			ctx.atSec >= 400
				? null
				: { text: "そうだね", delaySec: 10, feeling: "自然" },
	});
	const spoke = events.find((e) => e.type === "speak")!;
	const answer = events.find(
		(e) => e.type === "user" && e.text === "そうだね",
	)!;
	expect(answer.atSec).toBe(spoke.atSec + 10);
	expect(
		events.filter((e) => e.type === "felt").every((e) => e.atSec < 400),
	).toBe(true);
});
