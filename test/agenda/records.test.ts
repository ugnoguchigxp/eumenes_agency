/**
 * The host's records in the agent's calls (spec 2026-11-22 §5.4): plans, goals, conflicts and the
 * question ledger replace the plans-and-interests note; the host's marks (under review, suppressed)
 * keep what rests on them from being written, said or planned; the ledger keeps the agent from
 * asking again. Scripted model; no live call.
 */
import { describe, expect, test } from "bun:test";
import type { LlmPort, LlmRequest } from "../../src/index.ts";
import {
	agendaReplyMessages,
	agendaReplySystem,
	createAgendaAgent,
	createAgendaHost,
	type AgendaDeps,
	type AgendaHostEvent,
	type AgendaMarks,
	type AgendaRecords,
	type AgendaRecordsWriter,
	type PlanOutput,
} from "../../src/agenda/index.ts";

type Kind = "plan" | "check" | "ask_check" | "compose";
type Data = Record<string, unknown>;

const kindOf = (system: string): Kind =>
	system.includes("この呼び出しは「計画」")
		? "plan"
		: system.includes("重複チェック")
			? "check"
			: system.includes("質問の聞き直しチェック")
				? "ask_check"
				: "compose";

const scripted = (s: { plan?: (n: number) => PlanOutput } = {}) => {
	const calls: { kind: Kind; data: Data; prompt: string }[] = [];
	const llm: LlmPort = {
		complete<T>(req: LlmRequest<T>) {
			const kind = kindOf(req.system);
			const data = JSON.parse(req.prompt) as Data;
			calls.push({ kind, data, prompt: req.prompt });
			const n = calls.filter((c) => c.kind === kind).length;
			const value =
				kind === "plan"
					? (s.plan?.(n) ?? { add: [], drop: [], focus: "" })
					: kind === "ask_check"
						? {
								verdicts: (data["candidates"] as { id: string }[]).map((c) => ({
									id: c.id,
									verdict: "new",
									reason: "test",
								})),
							}
						: kind === "check"
							? { verdict: "new", coveredBy: null, request: null, reason: "x" }
							: {
									utterance: `一言${n}`,
									decline: null,
									emotion: "🙂",
									questions: 0,
									choice: false,
								};
			return Promise.resolve({
				value: req.schema.parse(value),
				model: "scripted",
				inputTokens: 10,
				outputTokens: 10,
				cacheReadTokens: 0,
				latencyMs: 1,
			});
		},
	};
	return { llm, calls, of: (k: Kind) => calls.filter((c) => c.kind === k) };
};

const add = (
	kind: "ask" | "research" | "talk",
	text: string,
	refs: string[] = [],
	topic = "",
) => ({ kind, text, refs, value: 3, reason: "test", topic });
const plan = (...items: ReturnType<typeof add>[]): PlanOutput => ({
	add: items,
	drop: [],
	focus: "",
});
const idle = () => ({ busy: false });
const sig = () => new AbortController().signal;
const make = (deps: Partial<AgendaDeps> & Pick<AgendaDeps, "llm">) =>
	createAgendaAgent({ startedAt: 0, ...deps });
/** The user's words are old: the talk is over, so what is drawn from the records may be said. */
const longAgo = -3_600_000;

const records: AgendaRecords = {
	plans: [{ ref: "p1", text: "水曜に歯医者", dueAt: "2026-11-25" }],
	goals: [{ ref: "g1", text: "毎朝ストレッチを続ける", state: "進行中" }],
	conflicts: [{ ref: "c1", text: "紅茶派と言っていたが、コーヒーと言った" }],
	questions: [{ attribute: "好きな色", state: "answered" }],
};

describe("the records replace the plans-and-interests note", () => {
	test("the plan reads the plans, goals, conflicts and ledger beside the memory; no profile", async () => {
		const m = scripted();
		const agent = make({
			llm: m.llm,
			known: () => [{ id: "m1", text: "猫を飼っている" }],
			records: () => records,
		});
		agent.observe({ id: "u1", who: "user", text: "こんにちは", at: longAgo });
		await agent.step(0, idle, sig());
		const d = m.of("plan")[0]!.data;
		expect(d["user"]).toEqual({
			memory: [{ id: "memory:m1", text: "猫を飼っている" }],
			goals: [
				{ id: "goal:g1", text: "毎朝ストレッチを続ける", state: "進行中" },
			],
			plans: [{ id: "plan:p1", text: "水曜に歯医者", dueAt: "2026-11-25" }],
			conflicts: [
				{ id: "conflict:c1", text: "紅茶派と言っていたが、コーヒーと言った" },
			],
		});
		expect(d["questionLedger"]).toEqual([
			{ attribute: "好きな色", state: "answered" },
		]);
		expect(m.of("plan")[0]!.prompt).not.toContain("profile");
		expect(m.of("plan")[0]!.prompt).not.toContain("interests");
	});

	test("the host fills each call for what bears on it", async () => {
		const m = scripted({
			plan: (n) =>
				n === 1 ? plan(add("talk", "歯医者の話", ["u1", "plan:p1"])) : plan(),
		});
		const asked: string[] = [];
		const agent = make({
			llm: m.llm,
			known: (call) => {
				asked.push(call.purpose);
				return [];
			},
			records: (call) => {
				asked.push(`records:${call.purpose}`);
				if (call.purpose === "compose")
					expect(call.item).toMatchObject({ kind: "talk", text: "歯医者の話" });
				return call.purpose === "compose"
					? { plans: records.plans ?? [] }
					: records;
			},
		});
		agent.observe({ id: "u1", who: "user", text: "こんにちは", at: longAgo });
		await agent.step(0, idle, sig());
		expect(asked).toContain("plan");
		expect(asked).toContain("records:plan");
		expect(asked).toContain("compose");
		expect(m.of("compose")[0]!.data["user"]).toEqual({
			memory: [],
			plans: [{ text: "水曜に歯医者", dueAt: "2026-11-25" }],
		});
	});

	test("research rests on a plan or a goal alone; a question on a record is asked after the talk is over", async () => {
		const m = scripted({
			plan: (n) =>
				n === 1
					? plan(
							add("research", "歯医者の下調べ", ["plan:p1"]),
							add("ask", "ストレッチの時間帯は？", ["goal:g1"]),
						)
					: plan(),
		});
		const agent = make({
			llm: m.llm,
			records: () => ({
				plans: records.plans ?? [],
				goals: records.goals ?? [],
			}),
		});
		agent.observe({ id: "u1", who: "user", text: "やあ", at: longAgo });
		const out = await agent.step(0, idle, sig());
		expect(out.plan?.added.map((a) => a.kind).sort()).toEqual([
			"ask",
			"research",
		]);
		expect(out.plan?.rejected).toEqual([]);
		expect(out.tickets.map((t) => t.kind).sort()).toEqual([
			"research",
			"speak",
		]);
	});

	test("a ref the host did not show is refused", async () => {
		const m = scripted({
			plan: (n) =>
				n === 1 ? plan(add("research", "調べ", ["plan:p9"])) : plan(),
		});
		const agent = make({ llm: m.llm, records: () => records });
		agent.observe({ id: "u1", who: "user", text: "やあ", at: 0 });
		const out = await agent.step(0, idle, sig());
		expect(out.plan?.rejected).toEqual(["research:unknown_ref"]);
	});

	test("a record the host forgot is not shown again", async () => {
		const m = scripted();
		const agent = make({ llm: m.llm, records: () => records });
		agent.forget(["plan:p1"]);
		agent.observe({ id: "u1", who: "user", text: "やあ", at: 0 });
		await agent.step(0, idle, sig());
		expect((m.of("plan")[0]!.data["user"] as Data)["plans"]).toBeUndefined();
	});

	test("a snapshot has no profile to keep", () => {
		const agent = make({ llm: scripted().llm });
		expect(Object.keys(agent.snapshot(0)).sort()).toEqual([
			"at",
			"items",
			"n",
			"quiet",
			"version",
		]);
	});
});

describe("the question ledger", () => {
	const ledger = (state: "asked" | "answered" | "declined" | "deferred") => ({
		questions: [{ attribute: "好きな色", state }],
	});

	test.each(["asked", "answered", "declined", "deferred"] as const)(
		"the plan does not add an ask about an attribute that is %s",
		async (state) => {
			const m = scripted({
				plan: (n) =>
					n === 1
						? plan(
								add("ask", "好きな色は何ですか？"),
								add("ask", "休日の過ごし方は？"),
							)
						: plan(),
			});
			const agent = make({ llm: m.llm, records: () => ledger(state) });
			agent.observe({ id: "u1", who: "user", text: "やあ", at: 0 });
			const out = await agent.step(0, idle, sig());
			expect(out.plan?.rejected).toEqual([`ask:ledger_${state}`]);
			expect(out.plan?.added.map((i) => i.text)).toEqual([
				"休日の過ごし方は？",
			]);
		},
	);

	test("a different attribute that shares letters with a ledger entry is not a hit", async () => {
		const m = scripted({
			plan: (n) => (n === 1 ? plan(add("ask", "好きな食べ物は？")) : plan()),
		});
		const agent = make({
			llm: m.llm,
			records: () => ({
				questions: [{ attribute: "好きな色", state: "answered" }],
			}),
		});
		agent.observe({ id: "u1", who: "user", text: "やあ", at: 0 });
		const out = await agent.step(0, idle, sig());
		expect(out.plan?.rejected).toEqual([]);
		expect(out.plan?.added.map((i) => i.text)).toEqual(["好きな食べ物は？"]);
	});

	test("the question check drops a ledger hit without a model call, and shows the rest the ledger", async () => {
		const m = scripted({
			plan: (n) => (n === 1 ? plan(add("ask", "休日の過ごし方は？")) : plan()),
		});
		const agent = make({
			llm: m.llm,
			records: () => ({
				questions: [
					{ attribute: "好きな色", state: "deferred" },
					{ attribute: "仕事", state: "answered" },
				],
			}),
		});
		agent.observe({ id: "u1", who: "user", text: "やあ", at: 0 });
		await agent.step(0, idle, sig());
		const c = m.of("ask_check")[0]!;
		expect(c.data["questionLedger"]).toEqual([
			{ attribute: "好きな色", state: "deferred" },
			{ attribute: "仕事", state: "answered" },
		]);
		expect(Object.keys(c.data)[0]).toBe("questionLedger");
	});

	test("an ask that slips through the plan is dropped by the check against the ledger alone", async () => {
		const m = scripted({
			// The plan sees no ledger; the check does.
			plan: (n) =>
				n === 1 ? plan(add("ask", "好きな色は何ですか？")) : plan(),
		});
		let ledgerOn = false;
		const agent = make({
			llm: m.llm,
			records: (call) =>
				call.purpose === "ask_check" || ledgerOn
					? { questions: [{ attribute: "好きな色", state: "declined" }] }
					: {},
		});
		agent.observe({ id: "u1", who: "user", text: "やあ", at: 0 });
		const out = await agent.step(0, idle, sig());
		ledgerOn = true;
		expect(out.repeats).toEqual([
			{
				itemId: expect.any(String),
				text: "好きな色は何ですか？",
				verdict: "asked",
				reason: "台帳: 好きな色（declined）",
			},
		]);
		expect(m.of("ask_check")).toHaveLength(0);
		expect(out.tickets.filter((t) => t.kind === "speak")).toHaveLength(0);
	});
});

describe("under review: what rests on a corrected record is not said until it is reviewed", () => {
	const speaks = (out: { tickets: readonly { kind: string }[] }) =>
		out.tickets.filter((t) => t.kind === "speak");

	test("not written, not said while the mark stands; it stays open and is said once it is cleared", async () => {
		let marks: AgendaMarks = {};
		const m = scripted({
			plan: (n) =>
				n === 1
					? plan(add("talk", "コーヒーの話", ["u1", "memory:m1"]))
					: plan(),
		});
		const agent = make({
			llm: m.llm,
			known: () => [{ id: "m1", text: "コーヒーはブラック" }],
			marks: () => marks,
		});
		agent.observe({ id: "u1", who: "user", text: "やあ", at: longAgo });
		// Planned while speech is quiet: the talk waits as an open item.
		agent.setQuiet({ scope: "speech", minutes: 10, at: 0 });
		await agent.step(0, idle, sig());
		expect(agent.view().items.map((i) => i.status)).toEqual(["open"]);
		marks = { underReview: ["memory:m1"] };
		agent.setQuiet({ scope: "speech", minutes: 0, at: 1 });
		const held = await agent.step(1, idle, sig());
		expect(speaks(held)).toEqual([]);
		expect(m.of("compose")).toHaveLength(0);
		expect(agent.view().items.map((i) => i.status)).toEqual(["open"]);
		// The host's review is done: the mark goes, and the item is written and said.
		marks = {};
		agent.infoChanged(2);
		const cleared = await agent.step(2, idle, sig());
		expect(speaks(cleared)).toHaveLength(1);
		expect(m.of("compose")).toHaveLength(1);
	});

	test("a new item on a record under review is not planned: the record is not shown", async () => {
		const m = scripted({
			plan: (n) =>
				n === 1
					? plan(add("talk", "コーヒーの話", ["u1", "memory:m1"]))
					: plan(),
		});
		const agent = make({
			llm: m.llm,
			known: () => [{ id: "m1", text: "コーヒーはブラック" }],
			marks: () => ({ underReview: ["memory:m1"] }),
		});
		agent.observe({ id: "u1", who: "user", text: "やあ", at: longAgo });
		const out = await agent.step(0, idle, sig());
		expect(out.plan?.rejected).toEqual(["talk:unknown_ref"]);
	});

	test("it is not offered to a reply either", async () => {
		let marks: AgendaMarks = {};
		const agent = make({
			llm: scripted({
				plan: (n) =>
					n === 1 ? plan(add("ask", "好みは？", ["u1", "memory:m1"])) : plan(),
			}).llm,
			known: () => [{ id: "m1", text: "コーヒーはブラック" }],
			marks: () => marks,
		});
		agent.observe({ id: "u1", who: "user", text: "やあ", at: 0 });
		agent.setQuiet({ scope: "speech", minutes: 10, at: 0 });
		await agent.step(0, idle, sig());
		agent.observe({ id: "u2", who: "user", text: "こんにちは", at: 1 });
		expect(agent.askForReply(2)?.text).toBe("好みは？");
		marks = { underReview: ["memory:m1"] };
		expect(agent.askForReply(3)).toBeNull();
	});

	test("a note made from the corrected record holds what talks about it", async () => {
		const m = scripted({
			plan: (n) =>
				n === 1 ? plan(add("talk", "メモの話", ["note:n1"])) : plan(),
		});
		const agent = make({
			llm: m.llm,
			notes: () => [
				{ id: "n1", title: "題", summary: "要約", at: 0, refs: ["memory:m1"] },
			],
			marks: () => ({ underReview: ["memory:m1"] }),
		});
		agent.observe({ id: "u1", who: "user", text: "やあ", at: longAgo });
		const out = await agent.step(0, idle, sig());
		expect(out.plan?.rejected).toEqual(["talk:under_review"]);
		expect(m.of("compose")).toHaveLength(0);
	});

	test("a record under review is not shown to the plan", async () => {
		const m = scripted();
		const agent = make({
			llm: m.llm,
			known: () => [
				{ id: "m1", text: "コーヒーはブラック" },
				{ id: "m2", text: "猫を飼っている" },
			],
			records: () => records,
			marks: () => ({ underReview: ["memory:m1", "plan:p1"] }),
		});
		agent.observe({ id: "u1", who: "user", text: "やあ", at: 0 });
		await agent.step(0, idle, sig());
		const user = m.of("plan")[0]!.data["user"] as {
			memory: { id: string }[];
			plans?: unknown;
		};
		expect(user.memory.map((x) => x.id)).toEqual(["memory:m2"]);
		expect(user.plans).toBeUndefined();
	});
});

describe("suppressed: what the user asked not to bring up", () => {
	test("an item that rests on a suppressed record, or speaks of a suppressed topic, is dropped", async () => {
		let suppress = false;
		const m = scripted({
			plan: (n) =>
				n === 1
					? plan(
							add("talk", "元カノの思い出", ["u1"], "恋愛"),
							add("talk", "猫の話", ["u1", "memory:m1"]),
							add("ask", "休日の過ごし方は？", ["memory:m2"]),
						)
					: plan(),
		});
		const agent = make({
			llm: m.llm,
			known: () => [
				{ id: "m1", text: "猫を飼っている" },
				{ id: "m2", text: "仕事は営業" },
			],
			marks: () =>
				suppress
					? { suppressedRefs: ["memory:m1"], suppressedTopics: ["元カノ"] }
					: {},
		});
		agent.observe({ id: "u1", who: "user", text: "やあ", at: longAgo });
		agent.setQuiet({ scope: "speech", minutes: 10, at: 0 });
		await agent.step(0, idle, sig());
		const open = () =>
			agent
				.view()
				.items.filter((i) => i.status === "open")
				.map((i) => i.text);
		expect(open()).toEqual(["元カノの思い出", "猫の話", "休日の過ごし方は？"]);
		suppress = true;
		agent.setQuiet({ scope: "speech", minutes: 0, at: 1 });
		agent.infoChanged(1);
		const out = await agent.step(1, idle, sig());
		const status = (text: string) =>
			agent.view().items.find((i) => i.text === text)?.status;
		expect(status("元カノの思い出")).toBe("dropped");
		expect(status("猫の話")).toBe("dropped");
		// Only the item that is neither about the topic nor on the record is written.
		expect((m.of("compose")[0]!.data["item"] as Data)["text"]).toBe(
			"休日の過ごし方は？",
		);
		expect(m.of("plan")[1]!.data["user"]).toMatchObject({
			doNotRaise: ["元カノ"],
		});
		expect(m.of("compose")).toHaveLength(1);
		expect(out.plan).not.toBeNull();
	});

	test("the plan's own proposals on a suppressed topic or record are refused", async () => {
		const m = scripted({
			plan: (n) =>
				n === 1
					? plan(
							add("research", "元カノの近況", ["u1"]),
							add("talk", "猫の話", ["u1", "memory:m1"]),
							add("talk", "天気の話", ["u1"]),
						)
					: plan(),
		});
		const agent = make({
			llm: m.llm,
			known: () => [{ id: "m1", text: "猫を飼っている" }],
			marks: () => ({
				suppressedRefs: ["memory:m1"],
				suppressedTopics: ["元カノ"],
			}),
		});
		agent.observe({ id: "u1", who: "user", text: "やあ", at: 0 });
		const out = await agent.step(0, idle, sig());
		// The suppressed record is not shown, so a ref to it is unknown; the topic is refused by name.
		expect(out.plan?.rejected).toEqual([
			"research:suppressed",
			"talk:unknown_ref",
		]);
		expect(out.plan?.added.map((i) => i.text)).toEqual(["天気の話"]);
	});

	test("a suppressed research does not start", async () => {
		const m = scripted({
			plan: (n) =>
				n === 1 ? plan(add("research", "元カノの近況", ["u1"])) : plan(),
		});
		let suppress = false;
		const agent = make({
			llm: m.llm,
			marks: () => (suppress ? { suppressedTopics: ["元カノ"] } : {}),
		});
		agent.observe({ id: "u1", who: "user", text: "やあ", at: 0 });
		await agent.step(0, () => ({ busy: true }), sig());
		suppress = true;
		const out = await agent.step(1, idle, sig());
		expect(out.tickets.filter((t) => t.kind === "research")).toEqual([]);
	});
});

describe("the reply's rules and state", () => {
	test("no rule line speaks of the plans-and-interests note", () => {
		const system = agendaReplySystem();
		expect(system).not.toContain("interests");
		expect(system).not.toContain("plans と interests");
		expect(system).toContain("- memory・plans・goals は、どれも");
		expect(system).toContain("- plans は、利用者が前に話した予定");
	});

	test("plans and goals the host gives go into the state, and nothing else of the note", () => {
		const agent = make({ llm: scripted().llm });
		agent.observe({ id: "u1", who: "user", text: "やあ", at: 0 });
		const state = (extra: Parameters<typeof agendaReplyMessages>[0]) =>
			JSON.parse(
				agendaReplyMessages(extra)
					.find((x) => x.role === "user")!
					.content.replace(/^<[^>]*>/u, "")
					.replace(/<\/[^>]*>$/u, ""),
			) as Data;
		const base = { agent, known: [], notes: [], clock: null, now: 1 };
		expect(state(base)["plans"]).toBeUndefined();
		const d = state({
			...base,
			plans: records.plans ?? [],
			goals: records.goals ?? [],
		});
		expect(d["plans"]).toEqual([{ text: "水曜に歯医者", dueAt: "2026-11-25" }]);
		expect(d["goals"]).toEqual([
			{ text: "毎朝ストレッチを続ける", state: "進行中" },
		]);
		expect(d["interests"]).toBeUndefined();
	});
});

describe("the host loop and the records' writer", () => {
	const hostOf = (records: AgendaRecordsWriter) => {
		const events: AgendaHostEvent[] = [];
		const agent = make({ llm: scripted().llm });
		let n = 0;
		const host = createAgendaHost({
			agent,
			records,
			notes: { read: () => null, list: () => [] },
			research: { start: () => true },
			reply: () => Promise.resolve(`返事${++n}`),
			now: () => 1_000,
			setTimer: () => 0,
			clearTimer: () => undefined,
			emit: (e) => events.push(e),
		});
		return { host, events };
	};

	test("the writer reads every line after its position, not the latest eight", async () => {
		const seen: string[][] = [];
		let fail = true;
		const { host, events } = hostOf(async ({ said }) => {
			seen.push(said.map((s) => s.id));
			if (fail) throw new Error("down");
			return { applied: ["plan add: x"], rejected: [] };
		});
		for (let i = 0; i < 6; i++) await host.say(`発言${i}`);
		await host.flush();
		// Each pass failed: the next one reads the lines again, with the new ones.
		expect(seen.length).toBeGreaterThan(1);
		expect(seen.at(-1)!.length).toBeGreaterThan(8);
		expect(
			events.filter((e) => e.type === "error" && e.where === "records"),
		).not.toHaveLength(0);
		fail = false;
		await host.say("もう一つ");
		await host.flush();
		const last = seen.at(-1)!;
		expect(last.length).toBe(14);
		expect(events.at(-1)).toMatchObject({
			type: "records",
			applied: ["plan add: x"],
		});
		// Read and kept: the next pass starts after them.
		await host.say("最後");
		await host.flush();
		expect(seen.at(-1)!.length).toBe(2);
	});

	test("lines are given as the user's or the agent's, with no other kind", async () => {
		let got: readonly { who: string }[] = [];
		const { host } = hostOf(async ({ said }) => {
			got = said;
			return { applied: [], rejected: [] };
		});
		await host.say("こんにちは");
		await host.flush();
		expect(got.map((s) => s.who)).toEqual(["user", "agent"]);
	});
});
