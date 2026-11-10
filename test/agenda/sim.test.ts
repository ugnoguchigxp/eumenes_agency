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

/** The agent's work takes no time: atSec stays exact whatever the machine's load. */
const frozen = () => 0;

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
									topic: "",
								},
								{
									kind: "ask",
									text: "好きな食べ物",
									refs: memory.slice(0, 1).map((m) => m.id),
									value: 3,
									reason: "知りたい",
									topic: "",
								},
							]
						: [],
				drop: [],
				focus: "",
			};
		} else
			value = {
				utterance: `「${(d["item"] as { text: string }).text}」について話す`,
				emotion: "😊",
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
		realMs: frozen,
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
		realMs: frozen,
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
		realMs: frozen,
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
		realMs: frozen,
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

// ------------------------------------------------------------------ the ruler (review 2026-11-10)

test("ruler: the agent's work moves the virtual clock by the real time it takes", async () => {
	const llm = model();
	const memory = createMockMemory();
	const docs = createMockDocStore();
	let real = 0;
	const { events } = await simulateAgenda({
		deps: { llm },
		minutes: 1,
		turns: [{ atSec: 0, text: "辛いラーメンが好き" }],
		memory,
		steward: null,
		docs,
		research: createMockWebResearch({
			writer: fixedWriter,
			docs,
			delayMs: 60_000,
		}),
		realMs: () => real,
		reply: async () => {
			real += 3_000;
			return "いいですね";
		},
	});
	expect(events.find((e) => e.type === "user")?.atSec).toBe(0);
	expect(events.find((e) => e.type === "reply")?.atSec).toBe(3);
	expect(events.find((e) => e.type === "plan")?.atSec).toBe(3);
});

test("ruler: what is written while the user starts typing is thrown away; nothing is said meanwhile", async () => {
	const base = model();
	let real = 0;
	// Writing an utterance takes five seconds.
	const llm: LlmPort = {
		complete(req, s) {
			if (req.system.includes("この呼び出しは「話す文を書く」")) real += 5_000;
			return base.complete(req, s);
		},
	};
	const memory = createMockMemory();
	const docs = createMockDocStore();
	const { events } = await simulateAgenda({
		deps: { llm },
		minutes: 3,
		// The note comes at 60 s and its topic is written until 65 s; the user starts typing at 62 s.
		turns: [
			{ atSec: 0, text: "辛いラーメンが好き" },
			{ atSec: 64, text: "そういえば" },
		],
		memory,
		steward: createMockSteward({ llm, memory }),
		docs,
		research: createMockWebResearch({
			writer: fixedWriter,
			docs,
			delayMs: 60_000,
		}),
		realMs: () => real,
		reply: async () => "いいですね",
	});
	expect(
		events.find((e) => e.type === "compose" && e.code === "stale"),
	).toMatchObject({ atSec: 65 });
	expect(
		events
			.filter((e) => e.type === "speak")
			.every((e) => e.atSec < 62 || e.atSec > 65),
	).toBe(true);
	// The line sent meanwhile is taken once the agent is done.
	expect(
		events.find((e) => e.type === "user" && e.text === "そういえば"),
	).toMatchObject({ atSec: 65 });
});

test("ruler: spoken to again before typing, the user answers the newest words, no later than the first answer", async () => {
	const llm: LlmPort = {
		complete<T>(req: LlmRequest<T>) {
			const d = JSON.parse(req.prompt) as Data;
			const plans = req.system.includes("この呼び出しは「計画」");
			let value: unknown;
			if (plans) {
				const user = (d["conversation"] as { id: string; who: string }[]).find(
					(s) => s.who === "user",
				);
				const first = (d["agenda"] as unknown[]).length === 0 && user;
				value = {
					add: first
						? ["一つ目の話", "二つ目の話"].map((text) => ({
								kind: "talk",
								text,
								refs: [user.id],
								value: 3,
								reason: "test",
								topic: "",
							}))
						: [],
					drop: [],
					focus: "",
				};
			} else
				value = {
					utterance: `「${(d["item"] as { text: string }).text}」です`,
					emotion: "😊",
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
	const run = async (answersSecond: boolean) => {
		const docs = createMockDocStore();
		const { events } = await simulateAgenda({
			deps: { llm },
			realMs: frozen,
			minutes: 2,
			turns: [{ atSec: 0, text: "ラーメンの話をしよう" }],
			memory: createMockMemory(),
			steward: null,
			docs,
			research: createMockWebResearch({
				writer: fixedWriter,
				docs,
				delayMs: 60_000,
			}),
			reply: async () => "いいですね",
			user: async (ctx) =>
				!answersSecond && ctx.utterance.includes("二つ目")
					? { text: null, delaySec: 30, feeling: "自然" }
					: {
							text: `そうだね:${ctx.utterance}`,
							delaySec: 30,
							feeling: "自然",
						},
		});
		const spoke = events.filter((e) => e.type === "speak");
		expect(spoke.map((e) => e.text)).toEqual([
			"「一つ目の話」です",
			"「二つ目の話」です",
		]);
		const answers = events.filter(
			(e) => e.type === "user" && e.text.startsWith("そうだね"),
		);
		return { spoke, answers };
	};
	// Ten seconds apart, before the user started typing: one line, to the newest words, sent when
	// the first answer would have been (more speech does not put the answer off).
	const both = await run(true);
	expect(
		both.answers.map((e) => [e.atSec, e.type === "user" && e.text]),
	).toEqual([[both.spoke[0]!.atSec + 30, "そうだね:「二つ目の話」です"]]);
	// Nothing to say to the newer words: the answer to the earlier ones still comes.
	const first = await run(false);
	expect(
		first.answers.map((e) => [e.atSec, e.type === "user" && e.text]),
	).toEqual([[first.spoke[0]!.atSec + 30, "そうだね:「一つ目の話」です"]]);
});

test("ruler: time never goes back for research left from an earlier session; repeats are recorded", async () => {
	const base = model();
	const llm: LlmPort = {
		complete<T>(req: LlmRequest<T>, s: AbortSignal) {
			if (!req.system.includes("質問の聞き直しチェック"))
				return base.complete(req, s);
			const d = JSON.parse(req.prompt) as Data;
			return Promise.resolve({
				value: req.schema.parse({
					verdicts: (d["candidates"] as { id: string }[]).map((c) => ({
						id: c.id,
						verdict: "asked",
						reason: "もう聞いた",
					})),
				}),
				model: "scripted",
				inputTokens: 1,
				outputTokens: 1,
				cacheReadTokens: 0,
				latencyMs: 1,
			});
		},
	};
	const memory = createMockMemory();
	const docs = createMockDocStore();
	const research = createMockWebResearch({
		writer: fixedWriter,
		docs,
		delayMs: 3_600_000,
	});
	const base2 = {
		deps: { llm },
		realMs: frozen,
		memory,
		steward: createMockSteward({ llm, memory }),
		docs,
		research,
		reply: async () => "いいですね",
	};
	const first = await simulateAgenda({
		...base2,
		minutes: 1,
		turns: [{ atSec: 0, text: "辛いラーメンが好き" }],
	});
	expect(first.events.find((e) => e.type === "repeat")).toMatchObject({
		verdict: "asked",
		text: "好きな食べ物",
	});
	// The research is due in the first session's hour, before the second session starts.
	const second = await simulateAgenda({
		...base2,
		startMs: 2 * 3_600_000,
		minutes: 1,
		turns: [],
	});
	expect(second.events.find((e) => e.type === "researched")).toMatchObject({
		atSec: 0,
	});
	expect(second.events.every((e) => e.atSec >= 0)).toBe(true);
});

test("review 2026-11-10: a writer that fails behind the step fails its scenario, not the process", async () => {
	const llm = model();
	const memory = createMockMemory();
	const docs = createMockDocStore();
	const research = createMockWebResearch({
		writer: fixedWriter,
		docs,
		delayMs: 120_000,
	});
	const unhandled: unknown[] = [];
	const onUnhandled = (e: unknown) => unhandled.push(e);
	process.on("unhandledRejection", onUnhandled);
	try {
		await expect(
			simulateAgenda({
				realMs: frozen,
				deps: { llm },
				minutes: 5,
				turns: [{ atSec: 0, text: "こんばんは" }],
				memory,
				steward: () => Promise.reject(new Error("the store is gone")),
				docs,
				research,
				reply: () => Promise.resolve("こんばんは。"),
			}),
		).rejects.toThrow("the store is gone");
		await new Promise((r) => setTimeout(r, 0));
		expect(unhandled).toEqual([]);
	} finally {
		process.off("unhandledRejection", onUnhandled);
	}
});
