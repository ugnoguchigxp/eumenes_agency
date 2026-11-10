/**
 * The agenda agent's rules with a scripted model (spec 2026-11-08 §6): when it plans, researches
 * and speaks is decided by code, and the model is called only to plan and to write.
 */
import { describe, expect, test } from "bun:test";
import type { LlmPort, LlmRequest } from "../../src/index.ts";
import {
	createAgendaAgent,
	declinesOffer,
	RESEARCH_TTL_MS,
	type AgendaDeps,
	type AgendaSnapshot,
	type CheckOutput,
	type ComposeOutput,
	type NoteRef,
	type PlanOutput,
} from "../../src/agenda/index.ts";

type Data = Record<string, unknown>;

type Kind = "plan" | "check" | "ask_check" | "compose";

const withEmotion = (
	c: Omit<ComposeOutput, "emotion"> & Partial<Pick<ComposeOutput, "emotion">>,
): ComposeOutput => ({
	...c,
	emotion: c.emotion ?? (c.utterance === null ? null : "🙂"),
});

/** Plans, checks and utterances by script; tells the calls apart by their instructions. */
const scripted = (s: {
	plan?: (d: Data, n: number) => PlanOutput;
	check?: (d: Data, n: number) => CheckOutput;
	/** Questions asked or answered already, by id (none unless the script says so). */
	repeats?: (d: Data, n: number) => Record<string, "asked" | "answered">;
	/** The feeling may be left out of a script (🙂 when speaking, none when declining). */
	compose?: (
		d: Data,
		n: number,
	) => Omit<ComposeOutput, "emotion"> & Partial<Pick<ComposeOutput, "emotion">>;
}) => {
	const calls: { kind: Kind; data: Data }[] = [];
	const llm: LlmPort = {
		complete<T>(req: LlmRequest<T>) {
			const kind: Kind = req.system.includes("この呼び出しは「計画」")
				? "plan"
				: req.system.includes("重複チェック")
					? "check"
					: req.system.includes("質問の聞き直しチェック")
						? "ask_check"
						: "compose";
			const data = JSON.parse(req.prompt) as Data;
			calls.push({ kind, data });
			const n = calls.filter((c) => c.kind === kind).length;
			const value =
				kind === "plan"
					? (s.plan?.(data, n) ?? { add: [], drop: [] })
					: kind === "ask_check"
						? {
								verdicts: (data["candidates"] as { id: string }[]).map((c) => ({
									id: c.id,
									verdict: s.repeats?.(data, n)[c.id] ?? "new",
									reason: "test",
								})),
							}
						: kind === "check"
							? (s.check?.(data, n) ?? {
									verdict: "new",
									coveredBy: null,
									request: null,
									reason: "新しい",
								})
							: withEmotion(
									s.compose?.(data, n) ?? {
										utterance: `一言${n}`,
										decline: null,
									},
								);
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
	return {
		llm,
		calls,
		count: (k: Kind) => calls.filter((c) => c.kind === k).length,
	};
};

const add = (
	kind: "ask" | "research" | "talk",
	text: string,
	refs: string[] = [],
	value = 3,
) => ({
	kind,
	text,
	refs,
	value,
	reason: "test",
});
const plan = (...items: ReturnType<typeof add>[]): PlanOutput => ({
	add: items,
	drop: [],
});
const idle = () => ({ busy: false });
const sig = () => new AbortController().signal;
const make = (deps: Partial<AgendaDeps> & Pick<AgendaDeps, "llm">) =>
	createAgendaAgent({ startedAt: 0, ...deps });

describe("agenda agent", () => {
	test("cold start: plans at once and asks; with nothing left to say it digs once, then idles", async () => {
		const m = scripted({
			plan: (_d, n) =>
				n === 1 ? plan(add("ask", "最近ハマっていること")) : plan(),
		});
		const agent = make({ llm: m.llm });
		const out = await agent.step(0, idle, sig());
		expect(out.plan?.added.map((a) => a.kind)).toEqual(["ask"]);
		expect(out.tickets).toMatchObject([{ kind: "speak", itemKind: "ask" }]);
		agent.recordDelivery({
			ticketId: out.tickets[0]!.id,
			at: 0,
			status: "succeeded",
		});
		// Nothing left to say: the next plan digs into an interest, at once.
		expect(agent.nextAt(1_000)).toBe(1_000);
		const dig = await agent.step(1_000, idle, sig());
		expect(dig.plan?.added).toEqual([]);
		expect(m.calls.at(-1)!.data["nothingToSay"]).toBe(true);
		// Nothing to dig into: it idles until something new comes (or the hour).
		expect(agent.nextAt(2_000)).toBe(1_000 + 3_600_000);
		const quiet = await agent.step(60_000, idle, sig());
		expect(quiet.plan).toBeNull();
		expect(quiet.compose).toBeNull();
		// The plan, the check of its new question, the utterance, the dig.
		expect(m.calls.map((c) => c.kind)).toEqual([
			"plan",
			"ask_check",
			"compose",
			"plan",
		]);
	});

	test("one research at a time; what the user asked for goes first", async () => {
		const m = scripted({
			plan: (d, n) => {
				const said = (d["conversation"] as { id: string }[])[0]!.id;
				return n === 1
					? plan(
							add("research", "A", [said], 5),
							add("research", "B", [said], 2),
						)
					: plan();
			},
		});
		const agent = make({ llm: m.llm });
		agent.observe({ id: "u1", who: "user", text: "辛いラーメンが好き", at: 0 });
		const first = await agent.step(0, idle, sig());
		const r1 = first.tickets.filter((t) => t.kind === "research");
		expect(r1.map((t) => t.kind === "research" && t.text)).toEqual(["A"]);
		const asked = agent.requestResearch({ text: "頼まれたC", at: 1_000 });
		expect("item" in asked && asked.queued).toBe(true);
		const busy = await agent.step(2_000, idle, sig());
		expect(busy.tickets.filter((t) => t.kind === "research")).toEqual([]);
		agent.researchReturned({
			ticketId: r1[0]!.id,
			at: 120_000,
			status: "succeeded",
			note: null,
		});
		const next = await agent.step(120_000, idle, sig());
		expect(next.tickets.find((t) => t.kind === "research")).toMatchObject({
			text: "頼まれたC",
			requested: true,
		});
	});

	test("a refused start is tried again later", async () => {
		const m = scripted({
			plan: (d) =>
				plan(
					add("research", "A", [
						(d["conversation"] as { id: string }[])[0]!.id,
					]),
				),
		});
		const agent = make({ llm: m.llm });
		agent.observe({ id: "u1", who: "user", text: "x", at: 0 });
		const out = await agent.step(0, idle, sig());
		const t = out.tickets.find((x) => x.kind === "research")!;
		agent.researchStarted(t.id, false, 0);
		expect(agent.view().researching).toBeNull();
		// Nothing to say meanwhile: it digs at once; its proposal is refused (researched already),
		// so it digs once more; then the retry of the research is next.
		expect(agent.nextAt(1)).toBe(1);
		await agent.step(1, idle, sig());
		expect(agent.nextAt(2)).toBe(2);
		await agent.step(2, idle, sig());
		expect(agent.nextAt(3)).toBe(60_000);
	});

	test("quiet for speech: nothing is said, research goes on, the end plans again", async () => {
		const m = scripted({
			plan: (d, n) =>
				n === 1
					? plan(
							add("research", "A", [
								(d["conversation"] as { id: string }[])[0]!.id,
							]),
							add("ask", "好きな食べ物"),
						)
					: plan(),
		});
		const agent = make({ llm: m.llm });
		agent.observe({ id: "u1", who: "user", text: "30分話しかけないで", at: 0 });
		agent.setQuiet({ scope: "speech", minutes: 30, at: 0 });
		const out = await agent.step(0, idle, sig());
		expect(out.tickets.map((t) => t.kind)).toEqual(["research"]);
		expect(m.count("compose")).toBe(0);
		expect(agent.nextAt(1_000)).toBe(1_800_000);
		const after = await agent.step(1_800_000, idle, sig());
		expect(after.plan).not.toBeNull();
		expect(after.tickets.map((t) => t.kind)).toEqual(["speak"]);
	});

	test("quiet for speech ends when the user talks again: a declared bedtime is not a timer while the talk goes on", async () => {
		const m = scripted({
			plan: (_d, n) => (n === 2 ? plan(add("talk", "曲の話", ["u2"])) : plan()),
		});
		const agent = make({ llm: m.llm });
		agent.observe({
			id: "u1",
			who: "user",
			text: "そろそろ寝ようと思います",
			at: 0,
		});
		agent.setQuiet({ scope: "speech", minutes: 420, at: 0 });
		await agent.step(0, idle, sig());
		expect(agent.view().quiet.speechUntil).toBe(420 * 60_000);
		agent.observe({
			id: "u2",
			who: "user",
			text: "いや夜にリラックスできる曲を作ってほしくて",
			at: 30_000,
		});
		expect(agent.view().quiet.speechUntil).toBeNull();
		const out = await agent.step(30_000, idle, sig());
		expect(out.tickets.map((t) => t.kind)).toEqual(["speak"]);
	});

	test("quiet for speech: work goes on, it digs for when the user is back", async () => {
		const m = scripted({
			plan: (d) =>
				d["nothingToSay"]
					? plan(add("research", "モンハンの新作の噂", ["u1"]))
					: plan(),
		});
		const agent = make({ llm: m.llm });
		agent.observe({
			id: "u1",
			who: "user",
			text: "モンハン好き。おやすみ",
			at: 0,
		});
		agent.setQuiet({ scope: "speech", minutes: 420, at: 0 });
		// The plan on the user's words finds nothing; the next step digs.
		expect((await agent.step(0, idle, sig())).tickets).toEqual([]);
		expect(agent.nextAt(0)).toBe(0);
		const out = await agent.step(1, idle, sig());
		expect(out.tickets).toMatchObject([
			{ kind: "research", text: "モンハンの新作の噂" },
		]);
		expect(m.count("compose")).toBe(0);
		expect(
			m.calls.filter((c) => c.kind === "plan").at(-1)!.data["quiet"],
		).toMatchObject({ speechForSec: expect.any(Number) });
		// A pause stops the work too.
		const p = scripted({ plan: () => plan(add("research", "A", ["u1"])) });
		const paused = make({ llm: p.llm });
		paused.observe({
			id: "u1",
			who: "user",
			text: "探索を一時停止して",
			at: 0,
		});
		paused.setQuiet({ scope: "all", minutes: 30, at: 0 });
		expect((await paused.step(0, idle, sig())).tickets).toEqual([]);
		expect(p.calls.length).toBe(0);
	});

	test("a pause of everything stays when the user talks", async () => {
		const agent = make({ llm: scripted({}).llm });
		agent.setQuiet({ scope: "all", minutes: 30, at: 0 });
		agent.observe({ id: "u1", who: "user", text: "こんにちは", at: 1_000 });
		expect(agent.view().quiet.allUntil).toBe(1_800_000);
	});

	test("pause: no plan, no research, no speech until it ends", async () => {
		const m = scripted({});
		const agent = make({ llm: m.llm });
		agent.observe({ id: "u1", who: "user", text: "探索を一時停止して", at: 0 });
		agent.setQuiet({ scope: "all", minutes: 30, at: 0 });
		agent.infoChanged(0);
		const out = await agent.step(0, idle, sig());
		expect(out.plan).toBeNull();
		expect(agent.nextAt(0)).toBe(1_800_000);
		expect(m.calls.length).toBe(0);
		agent.requestResearch({ text: "A", at: 1 });
		expect((await agent.step(60_000, idle, sig())).tickets).toEqual([]);
		const resumed = await agent.step(1_800_000, idle, sig());
		expect(resumed.plan).not.toBeNull();
		expect(resumed.tickets.map((t) => t.kind)).toEqual(["research"]);
	});

	test("an own question: talk goes on at its pace, but no second question before the answer", async () => {
		const note: NoteRef = {
			id: "n1",
			title: "辛い店",
			summary: "A店",
			at: 0,
			refs: [],
		};
		const m = scripted({
			plan: (_d, n) =>
				n === 1
					? plan(
							add("ask", "Q1", [], 5),
							add("ask", "Q2", [], 4),
							add("talk", "店の話", ["note:n1"], 1),
						)
					: plan(),
		});
		const agent = make({ llm: m.llm, notes: () => [note] });
		const a = await agent.step(0, idle, sig());
		expect(a.tickets).toMatchObject([{ itemKind: "ask" }]);
		agent.recordDelivery({
			ticketId: a.tickets[0]!.id,
			at: 0,
			status: "succeeded",
		});
		// Ten seconds later the talk comes, though Q1 is not answered; never Q2 before the answer.
		expect(agent.nextAt(1_000)).toBe(10_000);
		const b = await agent.step(10_000, idle, sig());
		expect(b.tickets).toMatchObject([{ itemKind: "talk" }]);
		agent.recordDelivery({
			ticketId: b.tickets[0]!.id,
			at: 10_000,
			status: "succeeded",
		});
		agent.observe({ id: "u1", who: "user", text: "答え", at: 30_000 });
		// Answered. Q2 does not tie into the talk: it waits until the talk is over (meanwhile
		// the agent digs into the talk).
		const during = await agent.step(30_000, idle, sig());
		expect(during.tickets.filter((t) => t.kind === "speak")).toEqual([]);
		const c = await agent.step(330_001, idle, sig());
		expect(c.tickets).toMatchObject([{ itemKind: "ask" }]);
		expect(
			m.calls
				.filter((x) => x.kind === "compose")
				.map((x) => (x.data["item"] as { text: string }).text),
		).toEqual(["Q1", "店の話", "Q2"]);
	});

	test("a topic in between does not open the way to a second question", async () => {
		const note: NoteRef = {
			id: "n1",
			title: "t",
			summary: "s",
			at: 0,
			refs: [],
		};
		const m = scripted({
			plan: (_d, n) =>
				n === 1
					? plan(
							add("ask", "Q1", [], 5),
							add("talk", "話題", ["note:n1"], 4),
							add("ask", "Q2", [], 3),
						)
					: plan(),
		});
		const agent = make({ llm: m.llm, notes: () => [note] });
		let now = 0;
		const kinds: string[] = [];
		for (let i = 0; i < 4; i++) {
			const at = agent.nextAt(now);
			if (at === null || at > 3_000_000) break;
			now = at;
			const out = await agent.step(now, idle, sig());
			for (const t of out.tickets)
				if (t.kind === "speak") {
					kinds.push(t.itemKind);
					agent.recordDelivery({
						ticketId: t.id,
						at: now,
						status: "succeeded",
					});
				}
		}
		expect(kinds).toEqual(["ask", "talk"]);
	});

	test("a reply that ended in a question: no question until the user answers", async () => {
		const m = scripted({
			plan: (_d, n) => (n === 1 ? plan(add("ask", "Q")) : plan()),
		});
		const agent = make({ llm: m.llm });
		agent.observe({ id: "u1", who: "user", text: "辛いラーメンが好き", at: 0 });
		agent.observe({
			id: "r1",
			who: "reply",
			text: "いいですね。どんな味が好きですか？",
			at: 0,
		});
		const out = await agent.step(0, idle, sig());
		expect(out.tickets).toEqual([]);
		// Its question waits for the answer; with nothing else to say it digs (nothing here).
		expect(agent.nextAt(120_000)).toBe(120_000);
		await agent.step(120_000, idle, sig());
		expect(agent.nextAt(121_000)).toBe(120_000 + 3_600_000);
		agent.observe({ id: "u2", who: "user", text: "味噌かな", at: 130_000 });
		// Answered: something comes at once (the open question does not tie into the talk, so a
		// dig into the talk first).
		expect(agent.nextAt(130_000)).toBe(130_000);
	});

	test("a declined question goes; the other questions are not held back", async () => {
		const m = scripted({
			plan: (_d, n) =>
				n === 1
					? plan(add("ask", "Q1", [], 5), add("ask", "Q2", [], 4))
					: plan(),
			compose: () => ({
				utterance: null,
				decline: "疲れているので今は聞かない",
			}),
		});
		const agent = make({ llm: m.llm });
		await agent.step(0, idle, sig());
		expect(m.count("compose")).toBe(1);
		expect(agent.view().items.find((i) => i.text === "Q1")?.status).toBe(
			"dropped",
		);
		// Q2 comes at once.
		expect(agent.nextAt(1)).toBe(1);
		await agent.step(1, idle, sig());
		expect((m.calls.at(-1)!.data["item"] as { text: string }).text).toBe("Q2");
	});

	test("a result it did not ask for (research Eumenes ran for the user elsewhere) is received as a note", async () => {
		const notes: NoteRef[] = [];
		const m = scripted({
			plan: (d) =>
				(d["notes"] as unknown[]).length > 0
					? plan(add("talk", "届いた調べものの話", ["note:n1"], 4))
					: plan(),
		});
		const agent = make({ llm: m.llm, notes: () => notes });
		const first = await agent.step(0, idle, sig());
		expect(first.tickets).toEqual([]);
		// The agent researches nothing itself: the host saved a report from web_research or
		// pursuit and says something new came in.
		notes.push({
			id: "n1",
			title: "箱根・強羅の宿の候補",
			summary: "12月の土曜に空きのある宿が3件",
			at: 5_000,
			refs: [],
		});
		agent.infoChanged(5_000);
		const at = agent.nextAt(5_000);
		expect(at).not.toBeNull();
		const out = await agent.step(at!, idle, sig());
		expect(m.count("plan")).toBe(2);
		expect(out.tickets).toMatchObject([{ kind: "speak", itemKind: "talk" }]);
	});

	test("a topic that ends in a question waits for the answer before any question", async () => {
		const note: NoteRef = {
			id: "n1",
			title: "t",
			summary: "s",
			at: 0,
			refs: [],
		};
		const m = scripted({
			plan: (_d, n) =>
				n === 1
					? plan(add("talk", "話題", ["note:n1"], 5), add("ask", "Q", [], 4))
					: plan(),
			compose: (d) =>
				(d["item"] as { kind: string }).kind === "talk"
					? {
							utterance:
								"ご存じでしたか？ 新しくなったそうです。表示しましょうか？",
							decline: null,
						}
					: { utterance: "好きな食べ物は？", decline: null },
		});
		const agent = make({ llm: m.llm, notes: () => [note] });
		const out = await agent.step(0, idle, sig());
		expect(out.tickets).toMatchObject([{ itemKind: "talk" }]);
		agent.recordDelivery({
			ticketId: out.tickets[0]!.id,
			at: 0,
			status: "succeeded",
		});
		// The question waits for the answer; meanwhile it digs (nothing here), then idles.
		expect(agent.nextAt(1)).toBe(1);
		await agent.step(1, idle, sig());
		expect(agent.nextAt(2)).toBe(1 + 3_600_000);
		agent.observe({ id: "u1", who: "user", text: "うん、見せて", at: 30_000 });
		// Answered: something comes at once (a dig into the talk, as the open question does not
		// tie into it).
		expect(agent.nextAt(30_000)).toBe(30_000);
	});

	test("unanswered speech keeps its pace: about once in ten seconds", async () => {
		const m = scripted({
			plan: () =>
				plan(
					add("ask", "Q"),
					add("talk", "t1", ["note:n1"]),
					add("talk", "t2", ["note:n2"]),
				),
		});
		const notes: NoteRef[] = [1, 2, 3, 4, 5, 6, 7, 8].map((k) => ({
			id: `n${k}`,
			title: `${k}`,
			summary: `${k}`,
			at: 0,
			refs: [],
		}));
		const agent = make({ llm: m.llm, notes: () => notes });
		let now = 0;
		const gaps: number[] = [];
		let last = 0;
		for (let i = 0; i < 6; i++) {
			const at = agent.nextAt(now);
			if (at === null || at > 7_200_000) break;
			now = at;
			const out = await agent.step(now, idle, sig());
			const t = out.tickets.find((x) => x.kind === "speak");
			if (!t) {
				now += 1_000;
				continue;
			}
			if (i > 0) gaps.push((now - last) / 1000);
			last = now;
			agent.recordDelivery({ ticketId: t.id, at: now, status: "succeeded" });
			agent.infoChanged(now);
		}
		// The question, then the topics, ten seconds apart though no one answers (the user wants
		// it a little noisy; what it has to say is what bounds it).
		expect(gaps.slice(0, 2)).toEqual([10, 10]);
		expect(agent.view().unanswered).toBeGreaterThanOrEqual(3);
	});

	test("a result the user waits for is said without the sentence said before, not held back for it", async () => {
		const note: NoteRef = {
			id: "n9",
			title: "Qwen4",
			summary: "未発表",
			at: 1,
			refs: ["u1"],
		};
		const m = scripted({
			compose: () => ({
				utterance:
					"調べものを始めました、数分でメモになります。Qwen4はまだ発表されていませんでした。",
				decline: null,
			}),
		});
		const agent = make({ llm: m.llm, notes: () => [note] });
		agent.observe({ id: "u1", who: "user", text: "Qwen4を調べて", at: 0 });
		agent.observe({
			id: "r1",
			who: "reply",
			text: "調べものを始めました、数分でメモになります。",
			at: 0,
		});
		agent.requestResearch({ text: "Qwen4", at: 0 });
		const out = await agent.step(0, idle, sig());
		const t = out.tickets.find((x) => x.kind === "research")!;
		agent.researchStarted(t.id, true, 0);
		agent.researchReturned({
			ticketId: t.id,
			at: 120_000,
			status: "succeeded",
			note,
		});
		const said = await agent.step(120_000, idle, sig());
		expect(said.tickets).toMatchObject([
			{
				kind: "speak",
				itemKind: "talk",
				utterance: "Qwen4はまだ発表されていませんでした。",
			},
		]);
	});

	test("requested research comes back as a talk that goes first", async () => {
		const note: NoteRef = {
			id: "n9",
			title: "京都の朝",
			summary: "朝は伏見稲荷",
			at: 1,
			refs: ["u1"],
		};
		const m = scripted({ plan: () => plan(add("ask", "Q", [], 5)) });
		const agent = make({ llm: m.llm, notes: () => [note] });
		agent.observe({ id: "u1", who: "user", text: "京都の朝を調べて", at: 0 });
		agent.observe({ id: "r1", who: "reply", text: "調べますね。", at: 0 });
		agent.requestResearch({ text: "京都の朝", at: 0 });
		const out = await agent.step(0, idle, sig());
		const t = out.tickets.find((x) => x.kind === "research")!;
		agent.researchReturned({
			ticketId: t.id,
			at: 120_000,
			status: "succeeded",
			note,
		});
		const next = await agent.step(120_000, idle, sig());
		expect(next.tickets).toMatchObject([
			{ kind: "speak", itemKind: "talk", noteId: "n9" },
		]);
	});

	test("a plan out while the user spoke is thrown away and made again", async () => {
		let speak: (() => void) | null = null;
		const m = scripted({
			plan: (_d, n) => {
				if (n === 1) speak?.();
				return plan(add("ask", `Q${n}`));
			},
		});
		const agent = make({ llm: m.llm });
		speak = () =>
			agent.observe({ id: "u1", who: "user", text: "それはもう答えた", at: 1 });
		const out = await agent.step(0, idle, sig());
		expect(out.plan?.call.code).toBe("stale");
		expect(agent.view().items).toEqual([]);
		expect(agent.view().planDue).toBe(true);
		speak = null;
		const again = await agent.step(2, idle, sig());
		expect(again.plan?.added.map((a) => a.text)).toEqual(["Q2"]);
	});

	test("declined by the model: dropped at once; a repeat is never said", async () => {
		const m = scripted({
			plan: (_d, n) => (n === 1 ? plan(add("ask", "Q")) : plan()),
			compose: () => ({ utterance: null, decline: "今は合わない" }),
		});
		const agent = make({ llm: m.llm });
		const a = await agent.step(0, idle, sig());
		expect(a.compose?.declined).toBe("今は合わない");
		expect(agent.view().items[0]!.status).toBe("dropped");

		const r = scripted({
			plan: () => plan(add("ask", "別の問い", ["u1"])),
			compose: () => ({ utterance: "こんにちは。", decline: null }),
		});
		const b = make({ llm: r.llm });
		b.observe({ id: "u1", who: "user", text: "やあ", at: 0 });
		b.observe({ id: "r1", who: "reply", text: "こんにちは", at: 0 });
		const out = await b.step(200_000, idle, sig());
		expect(out.compose?.rejected).toEqual(["repeat"]);
		expect(out.tickets).toEqual([]);
	});

	test("research needs the user's words, the memory or a note; the agent's own words do not count", async () => {
		const m = scripted({
			plan: () =>
				plan(
					add("research", "返事の続き", ["r1"]),
					add("research", "記憶から", ["memory:m1"]),
				),
		});
		const agent = make({
			llm: m.llm,
			known: () => [{ id: "m1", text: "辛いもの好き" }],
		});
		agent.observe({ id: "r1", who: "reply", text: "辛いのいいですね", at: 0 });
		const out = await agent.step(0, idle, sig());
		expect(out.plan?.rejected).toEqual(["research:needs_user_reason"]);
		expect(out.plan?.added.map((a) => a.text)).toEqual(["記憶から"]);
	});

	test("the same theme again: refused at the plan by its words, or by the check before it starts", async () => {
		const notes: NoteRef[] = [
			{
				id: "n1",
				title: "辛いラーメンの新作",
				summary: "最近話題の辛いラーメンの新作をまとめた",
				at: 0,
				refs: ["u1"],
			},
		];
		const m = scripted({
			plan: (d, n) => {
				const u = (d["conversation"] as { id: string }[])[0]!.id;
				return n === 1
					? plan(
							add(
								"research",
								"辛いラーメンの話題の新作を調べてまとめてほしい",
								[u],
							),
							add("research", "辛いもの好きに合うお店の探し方", [u]),
							add("research", "パクチー抜きで頼める辛い店", [u]),
						)
					: plan();
			},
			check: (d) =>
				(d["request"] as string).includes("探し方")
					? {
							verdict: "covered",
							coveredBy: "note:n1",
							request: null,
							reason: "n1 と同じ",
						}
					: {
							verdict: "partial",
							coveredBy: null,
							request: "パクチー抜きの注文ができる店の傾向だけ",
							reason: "一部は n1",
						},
		});
		const agent = make({ llm: m.llm, notes: () => notes });
		agent.observe({
			id: "u1",
			who: "user",
			text: "辛いのが好き、パクチーは苦手",
			at: 0,
		});
		const out = await agent.step(0, idle, sig());
		expect(out.plan?.rejected).toEqual(["research:same_theme"]);
		// The first in line is covered by n1 and dropped; the next one starts narrowed.
		expect(out.check).toMatchObject({
			verdict: "covered",
			coveredBy: "note:n1",
		});
		expect(out.tickets).toEqual([]);
		const next = await agent.step(1, idle, sig());
		expect(next.check).toMatchObject({ verdict: "partial" });
		expect(next.tickets.find((t) => t.kind === "research")).toMatchObject({
			text: "パクチー抜きの注文ができる店の傾向だけ",
		});
	});

	test("what the user asked for is not checked against the notes", async () => {
		const m = scripted({});
		const agent = make({
			llm: m.llm,
			notes: () => [{ id: "n1", title: "t", summary: "s", at: 0, refs: [] }],
		});
		agent.observe({ id: "u1", who: "user", text: "もう一度調べて", at: 0 });
		agent.requestResearch({ text: "同じこと", at: 0 });
		const out = await agent.step(0, () => ({ busy: true }), sig());
		expect(out.tickets.map((t) => t.kind)).toEqual(["research"]);
		expect(m.count("check")).toBe(0);
	});

	test("a sentence already said, inside a topic, is left out; the rest is said", async () => {
		const note: NoteRef = {
			id: "n1",
			title: "t",
			summary: "s",
			at: 0,
			refs: ["u1"],
		};
		const m = scripted({
			plan: (_d, n) =>
				n === 1 ? plan(add("talk", "話題", ["note:n1"])) : plan(),
			compose: () => ({
				utterance:
					"ご存じでしたか？ メモがあります。動画生成AIは使ってみたことはありますか？",
				decline: null,
			}),
		});
		const agent = make({ llm: m.llm, notes: () => [note] });
		agent.observe({ id: "u1", who: "user", text: "AIの話", at: 0 });
		agent.observe({
			id: "r1",
			who: "reply",
			text: "いいですね。動画生成AIは使ってみたことはありますか？",
			at: 0,
		});
		agent.observe({ id: "u2", who: "user", text: "まだ", at: 10_000 });
		const out = await agent.step(30_000, idle, sig());
		expect(out.tickets).toMatchObject([
			{ kind: "speak", utterance: "ご存じでしたか？ メモがあります。" },
		]);
	});

	test("a dig whose every proposal was refused digs once more, shown what was refused and why", async () => {
		const note: NoteRef = {
			id: "n1",
			title: "Oracleの経営陣",
			summary: "共同CEOの二人",
			at: 0,
			refs: [],
		};
		const m = scripted({
			plan: (_d, n) =>
				n === 2
					? plan(add("research", "Oracleの経営陣", ["u1"]))
					: n === 3
						? plan(add("research", "ラリー・エリソンの来歴", ["u1"]))
						: plan(),
		});
		const agent = make({ llm: m.llm, notes: () => [note] });
		agent.observe({
			id: "u1",
			who: "user",
			text: "ラリー・エリソンが出ないのおかしくない？",
			at: 0,
		});
		await agent.step(0, idle, sig());
		// The dig proposes what a note has already: refused; it digs again at once.
		const first = await agent.step(1, idle, sig());
		expect(first.plan?.rejected).toEqual(["research:same_theme"]);
		const again = await agent.step(2, idle, sig());
		expect(
			m.calls.filter((c) => c.kind === "plan").at(-1)!.data["refusedLastDig"],
		).toEqual([
			{ kind: "research", text: "Oracleの経営陣", why: "same_theme" },
		]);
		expect(again.tickets).toMatchObject([
			{ kind: "research", text: "ラリー・エリソンの来歴" },
		]);
	});

	test("research it started from the user's words is talked about when it comes back, without the plan", async () => {
		const notesNow: NoteRef[] = [];
		const m = scripted({
			plan: (_d, n) =>
				n === 1 ? plan(add("research", "Cranberriesの代表曲", ["u1"])) : plan(),
		});
		const agent = make({ llm: m.llm, notes: () => notesNow });
		agent.observe({
			id: "u1",
			who: "user",
			text: "Cranberriesみたいな女性の声が好き",
			at: 0,
		});
		const out = await agent.step(0, idle, sig());
		const t = out.tickets.find((x) => x.kind === "research")!;
		agent.researchStarted(t.id, true, 0);
		const note: NoteRef = {
			id: "n1",
			title: "Cranberriesの代表曲",
			summary: "Linger、Dreams",
			at: 60_000,
			refs: ["u1"],
		};
		notesNow.push(note);
		agent.researchReturned({
			ticketId: t.id,
			at: 60_000,
			status: "succeeded",
			note,
		});
		// The plan adds nothing; the result is said anyway, as part of the talk.
		const said = await agent.step(60_000, idle, sig());
		expect(said.tickets).toMatchObject([
			{ kind: "speak", itemKind: "talk", noteId: "n1" },
		]);
	});

	test("work the user said yes to goes to the toolchain found for it, unchecked against notes, and is reported", async () => {
		const notesNow: NoteRef[] = [
			{
				id: "n1",
				title: "七里ヶ浜の朝",
				summary: "江の島と富士",
				at: 0,
				refs: [],
			},
		];
		const m = scripted({});
		const agent = make({ llm: m.llm, notes: () => notesNow });
		agent.observe({ id: "u1", who: "user", text: "いいね、作ってみて", at: 0 });
		agent.observe({ id: "r1", who: "reply", text: "作り始めました。", at: 0 });
		const r = agent.requestResearch({
			text: "七里ヶ浜の朝を北斎風の絵にする",
			at: 0,
			delegatedTo: "mock.paint",
		});
		expect("item" in r && r.item.delegatedTo).toBe("mock.paint");
		const out = await agent.step(0, idle, sig());
		// No theme check (the work is no research), and the toolchain goes with the ticket.
		expect(m.count("check")).toBe(0);
		const t = out.tickets.find((x) => x.kind === "research")!;
		expect(t).toMatchObject({
			kind: "research",
			delegatedTo: "mock.paint",
			requested: true,
		});
		agent.researchStarted(t.id, true, 0);
		const work: NoteRef = {
			id: "n2",
			title: "七里ヶ浜の朝（北斎風）",
			summary: "波と江の島と富士",
			at: 120_000,
			refs: [],
		};
		notesNow.push(work);
		agent.researchReturned({
			ticketId: t.id,
			at: 120_000,
			status: "succeeded",
			note: work,
		});
		expect(
			agent.view().items.find((i) => i.kind === "talk" && i.noteId === "n2")
				?.text,
		).toBe("頼まれた「七里ヶ浜の朝（北斎風）」ができた");
	});

	test("the plan knows a toolchain only once the reply found one: it sees what was found, for what", async () => {
		const m = scripted({});
		const agent = make({ llm: m.llm });
		agent.observe({
			id: "u1",
			who: "user",
			text: "ジョギングの記録、毎回メモするの面倒なんだよね",
			at: 0,
		});
		agent.observe({
			id: "r1",
			who: "reply",
			text: "記録を手伝える担当がいます。作ってみましょうか？",
			at: 0,
			calls: [
				{
					name: "find_toolchain",
					arguments: JSON.stringify({ query: "ジョギングの記録アプリを作る" }),
					content: JSON.stringify({
						candidates: [
							{
								toolchain: "mock.run",
								description:
									"「ジョギングの記録アプリを作る」を引き受ける担当（mock）",
							},
						],
					}),
				},
				{ name: "read_note", arguments: "{}", content: "not a catalog" },
			],
		});
		await agent.step(0, idle, sig());
		expect(
			m.calls.find((c) => c.kind === "plan")!.data["toolchainsFound"],
		).toEqual([
			{
				toolchain: "mock.run",
				description: "「ジョギングの記録アプリを作る」を引き受ける担当（mock）",
				query: "ジョギングの記録アプリを作る",
			},
		]);
	});

	test("a topic without a note: the agent's own thought on what the user talks about", async () => {
		const m = scripted({
			plan: (d, n) =>
				n === 1
					? plan(
							add("talk", "宙に浮いた話"),
							add("talk", "ベゾスはPrinceton出身で中退組ではない", [
								(d["conversation"] as { id: string }[]).at(-1)!.id,
							]),
						)
					: plan(),
			compose: () => ({
				utterance: "ちなみに、ベゾスは中退せずにPrincetonを卒業しています。",
				decline: null,
			}),
		});
		const agent = make({ llm: m.llm });
		agent.observe({
			id: "u1",
			who: "user",
			text: "中退した起業家って多いね",
			at: 0,
		});
		const out = await agent.step(0, idle, sig());
		// Resting on nothing it is refused; on the user's words it is said, with no note.
		expect(out.plan?.rejected).toEqual(["talk:needs_one_note"]);
		expect(out.tickets).toMatchObject([
			{ kind: "speak", itemKind: "talk", noteId: null },
		]);
	});

	test("research the reply said it would do: checked, reported when ready", async () => {
		const note: NoteRef = {
			id: "n2",
			title: "京都の天気",
			summary: "朝は冷える",
			at: 1,
			refs: ["u1"],
		};
		const m = scripted({});
		const agent = make({
			llm: m.llm,
			notes: () => [
				{ id: "n1", title: "京都", summary: "京都の回り方", at: 0, refs: [] },
				note,
			],
		});
		agent.observe({ id: "u1", who: "user", text: "おはよう", at: 0 });
		agent.requestResearch({
			text: "今日の京都の天気",
			at: 0,
			requested: false,
		});
		const out = await agent.step(0, () => ({ busy: true }), sig());
		const t = out.tickets.find((x) => x.kind === "research")!;
		expect(m.count("check")).toBe(1);
		agent.researchReturned({
			ticketId: t.id,
			at: 120_000,
			status: "succeeded",
			note,
		});
		const talk = agent.view().items.find((i) => i.kind === "talk")!;
		expect(talk).toMatchObject({
			promised: true,
			requested: false,
			noteId: "n2",
		});
		expect(
			agent.view().items.find((i) => i.kind === "research")!.resultNoteId,
		).toBe("n2");
	});

	test("a new angle on a theme researched already goes on to the check, not refused by shared words", async () => {
		const excitement =
			"牛乳（ホットミルク1杯）に、興奮や覚醒につながる成分（チラミン、フェニルアラニン、カフェインなど）がどれだけ含まれるかを確かめ、寝る前に飲んで眠りを妨げるかを結論にしてほしい。";
		const m = scripted({
			plan: (_d, n) =>
				n === 1 ? plan(add("research", excitement, ["u1"])) : plan(),
		});
		const agent = make({ llm: m.llm });
		agent.observe({
			id: "u0",
			who: "user",
			text: "グリシンは入ってないの？ミルク",
			at: 0,
		});
		expect(
			agent.requestResearch({
				text: "牛乳（ホットミルク1杯）に含まれるグリシンの量と、寝る前のグリシン摂取の睡眠への効果に関する研究的根拠を確かめ、効果があるかを結論にしてほしい。",
				at: 0,
				requested: true,
			}),
		).toHaveProperty("item");
		agent.observe({
			id: "u1",
			who: "user",
			text: "逆に興奮に繋がる成分入ってないのミルク",
			at: 0,
		});
		const out = await agent.step(0, idle, sig());
		expect(out.plan?.rejected).toEqual([]);
		expect(out.plan?.added.map((a) => a.text)).toEqual([excitement]);
	});

	test("research the reply promised, already in a note: the promise is kept with that note", async () => {
		const m = scripted({
			check: () => ({
				verdict: "covered",
				coveredBy: "note:n1",
				request: null,
				reason: "n1 にある",
			}),
		});
		const agent = make({
			llm: m.llm,
			notes: () => [
				{
					id: "n1",
					title: "京都の回り方",
					summary: "早朝に回る",
					at: 0,
					refs: [],
				},
			],
		});
		agent.observe({ id: "u1", who: "user", text: "おはよう", at: 0 });
		agent.requestResearch({
			text: "京都の回り方をもう一度",
			at: 0,
			requested: false,
		});
		const out = await agent.step(0, () => ({ busy: true }), sig());
		expect(out.tickets).toEqual([]);
		expect(agent.view().items.find((i) => i.kind === "talk")).toMatchObject({
			promised: true,
			noteId: "n1",
			status: "open",
		});
	});

	test("review: news while a plan is out (a note, a memory change) is planned on right after", async () => {
		let agent: ReturnType<typeof make> | null = null;
		const m = scripted({
			plan: (_d, n) => {
				if (n === 1) agent!.infoChanged(5);
				return plan();
			},
		});
		agent = make({ llm: m.llm });
		await agent.step(0, idle, sig());
		expect(agent.view().planDue).toBe(true);
		await agent.step(10, idle, sig());
		expect(m.count("plan")).toBe(2);
		// That plan was for the news; with nothing left to say, the next one digs.
		expect(
			m.calls.filter((c) => c.kind === "plan")[1]!.data["nothingToSay"],
		).toBe(undefined);
		expect(agent.view().planDue).toBe(true);
	});

	test("with nothing left to say it digs into an interest; while that runs no other dig; an empty dig waits for news", async () => {
		const note: NoteRef = {
			id: "n1",
			title: "辛さの種類",
			summary: "唐辛子・花椒",
			at: 120_000,
			refs: [],
		};
		const notesNow: NoteRef[] = [];
		const m = scripted({
			plan: (d, n) =>
				n === 2 && d["nothingToSay"]
					? plan(add("research", "辛いラーメンの辛さの種類", ["memory:m1"]))
					: plan(),
		});
		const agent = make({
			llm: m.llm,
			known: () => [{ id: "m1", text: "辛いラーメンが好き" }],
			notes: () => notesNow,
		});
		await agent.step(0, idle, sig());
		// Nothing to say: the next plan digs, and asks for research on the user's interest.
		const dig = await agent.step(1, idle, sig());
		expect(
			m.calls.filter((c) => c.kind === "plan")[1]!.data["nothingToSay"],
		).toBe(true);
		const t = dig.tickets.find((x) => x.kind === "research")!;
		expect(t.text).toBe("辛いラーメンの辛さの種類");
		agent.researchStarted(t.id, true, 1);
		// While it runs, no other dig.
		await agent.step(2, idle, sig());
		expect(m.count("plan")).toBe(2);
		notesNow.push(note);
		agent.researchReturned({
			ticketId: t.id,
			at: 120_000,
			status: "succeeded",
			note,
		});
		// The result is planned on; then, with nothing to say, a dig that finds nothing.
		await agent.step(120_000, idle, sig());
		await agent.step(120_001, idle, sig());
		expect(
			m.calls.filter((c) => c.kind === "plan")[3]!.data["nothingToSay"],
		).toBe(true);
		// Empty: no further dig until something new.
		expect(agent.nextAt(120_002)).toBe(120_001 + 3_600_000);
		agent.infoChanged(130_000);
		expect(agent.nextAt(130_000)).toBe(130_000);
	});

	test("review: stopped while the plan or the check is out, nothing starts", async () => {
		let agent: ReturnType<typeof make> | null = null;
		const m = scripted({
			plan: (d) => {
				agent!.setStopped(true);
				return plan(
					add("research", "A", [
						(d["conversation"] as { id: string }[])[0]!.id,
					]),
				);
			},
		});
		agent = make({ llm: m.llm });
		agent.observe({ id: "u1", who: "user", text: "x", at: 0 });
		const out = await agent.step(0, idle, sig());
		expect(out.tickets).toEqual([]);

		const notes: NoteRef[] = [
			{ id: "n1", title: "別", summary: "別の話", at: 0, refs: [] },
		];
		let b: ReturnType<typeof make> | null = null;
		const k = scripted({
			plan: (d) =>
				plan(
					add("research", "B", [
						(d["conversation"] as { id: string }[])[0]!.id,
					]),
				),
			check: () => {
				b!.forget(["u1"]);
				return { verdict: "new", coveredBy: null, request: null, reason: "" };
			},
		});
		b = make({ llm: k.llm, notes: () => notes });
		b.observe({ id: "u1", who: "user", text: "y", at: 0 });
		const out2 = await b.step(0, idle, sig());
		expect(out2.tickets).toEqual([]);
		expect(b.view().researching).toBeNull();
	});

	test("review: zero minutes ends every quiet period, whichever scope", () => {
		const agent = make({ llm: scripted({}).llm });
		agent.setQuiet({ scope: "speech", minutes: 480, at: 0 });
		agent.setQuiet({ scope: "all", minutes: 30, at: 0 });
		expect(agent.setQuiet({ scope: "all", minutes: 0, at: 1 })).toEqual({
			speechUntil: null,
			allUntil: null,
		});
		expect(agent.view().planDue).toBe(true);
	});

	test("with no answer it goes on at the set pace while it has something to say", async () => {
		const notes: NoteRef[] = [1, 2, 3, 4, 5, 6, 7, 8].map((k) => ({
			id: `n${k}`,
			title: `${k}`,
			summary: `${k}`,
			at: 0,
			refs: [],
		}));
		// Each plan brings two more topics, so there is always something to say.
		const m = scripted({
			plan: (_d, n) =>
				plan(
					...notes
						.slice(2 * n - 2, 2 * n)
						.map((x) => add("talk", `t${x.id}`, [`note:${x.id}`])),
				),
		});
		const agent = make({
			llm: m.llm,
			notes: () => notes,
			speechIntervalSec: 60,
		});
		let now = 0;
		const at: number[] = [];
		for (let i = 0; i < 12; i++) {
			const next = agent.nextAt(now);
			if (next === null || next >= 3_400_000) break;
			now = next;
			for (const t of (await agent.step(now, idle, sig())).tickets)
				if (t.kind === "speak") {
					at.push(now / 1000);
					agent.recordDelivery({
						ticketId: t.id,
						at: now,
						status: "succeeded",
					});
					agent.infoChanged(now);
				}
		}
		// Every minute (the 60 s setting), never slower for want of an answer, never held.
		expect(at.slice(0, 4)).toEqual([0, 60, 120, 180]);
	});

	test("a note the reply read or showed is not brought up again as a topic", async () => {
		const note: NoteRef = {
			id: "n1",
			title: "t",
			summary: "s",
			at: 0,
			refs: [],
		};
		const m = scripted({ plan: () => plan(add("talk", "話題", ["note:n1"])) });
		const agent = make({ llm: m.llm, notes: () => [note] });
		agent.noteUsed("n1", 0);
		const out = await agent.step(0, idle, sig());
		expect(out.plan?.rejected).toEqual(["talk:note_already_talked"]);
		expect(out.tickets).toEqual([]);
	});

	test("speech carries the feeling it is said with", async () => {
		const m = scripted({
			plan: (_d, n) => (n === 1 ? plan(add("ask", "Q")) : plan()),
			compose: () => ({
				utterance: "最近ハマっていることは？",
				emotion: "🤔",
				decline: null,
			}),
		});
		const out = await make({ llm: m.llm }).step(0, idle, sig());
		expect(out.tickets).toMatchObject([{ kind: "speak", emotion: "🤔" }]);
	});

	test("a question that makes the user pick one of two is never said", async () => {
		const m = scripted({
			plan: (_d, n) => (n === 1 ? plan(add("ask", "過ごし方")) : plan()),
			compose: () => ({
				utterance: "温泉と観光、どちらに時間を使いたいですか？",
				decline: null,
			}),
		});
		const agent = make({ llm: m.llm });
		const out = await agent.step(0, idle, sig());
		expect(out.compose?.rejected).toEqual(["either_or"]);
		expect(out.tickets).toEqual([]);
	});

	test("a question asked or answered already, in meaning, is not asked: checked when planned and right before", async () => {
		const byText = (d: Data, verdicts: Record<string, "asked" | "answered">) =>
			Object.fromEntries(
				(d["candidates"] as { id: string; text: string }[]).flatMap((c) =>
					verdicts[c.text] ? [[c.id, verdicts[c.text]!]] : [],
				),
			);
		const m = scripted({
			plan: (_d, n) =>
				n === 1
					? plan(
							add("ask", "最近楽しみにしていること", [], 5),
							add("ask", "夢中になっていること", [], 4),
						)
					: n === 2
						? plan(add("ask", "うなぎの好きな食べ方", [], 3))
						: plan(),
			// When planned: the second is the same kind of question as the first. Right before the
			// third is asked: the user has talked about it meanwhile.
			repeats: (d, n) =>
				n === 1
					? byText(d, { 夢中になっていること: "asked" })
					: n === 3
						? byText(d, { うなぎの好きな食べ方: "answered" })
						: {},
		});
		const agent = make({ llm: m.llm });
		const first = await agent.step(0, idle, sig());
		expect(first.repeats).toMatchObject([
			{ text: "夢中になっていること", verdict: "asked" },
		]);
		expect(first.tickets).toMatchObject([{ itemKind: "ask" }]);
		agent.recordDelivery({
			ticketId: first.tickets[0]!.id,
			at: 0,
			status: "succeeded",
		});
		// Nothing left: the dig adds a question; it passes, and waits for the shortest gap.
		const dig = await agent.step(1_000, idle, sig());
		expect(dig.plan?.added.map((i) => i.text)).toEqual([
			"うなぎの好きな食べ方",
		]);
		expect(dig.repeats).toEqual([]);
		agent.observe({
			id: "u1",
			who: "user",
			text: "うなぎは蒲焼きでしか食べない",
			at: 5_000,
		});
		// Once the talk is over the held question comes up; right before, it is checked again.
		const second = await agent.step(400_000, idle, sig());
		expect(second.repeats).toMatchObject([
			{ text: "うなぎの好きな食べ方", verdict: "answered" },
		]);
		expect(second.tickets.filter((t) => t.kind === "speak")).toEqual([]);
	});

	test("in a talk, what ties into it goes first; a general question waits until the talk is over", async () => {
		const m = scripted({
			plan: (d, n) =>
				n === 1
					? plan(
							add("ask", "苦手なこと", [], 5),
							add(
								"ask",
								"そのPCの用途",
								[(d["conversation"] as { id: string }[]).at(-1)!.id],
								3,
							),
						)
					: plan(),
		});
		const agent = make({ llm: m.llm });
		agent.observe({
			id: "u1",
			who: "user",
			text: "AI MAX 395 128GBを持ってます",
			at: 0,
		});
		agent.observe({ id: "r1", who: "reply", text: "いい環境ですね。", at: 0 });
		const first = await agent.step(20_000, idle, sig());
		// The question that ties into the talk goes first, though it is worth less.
		expect(first.tickets).toMatchObject([{ itemKind: "ask" }]);
		expect((m.calls.at(-1)!.data["item"] as { text: string }).text).toBe(
			"そのPCの用途",
		);
		agent.recordDelivery({
			ticketId: first.tickets[0]!.id,
			at: 20_000,
			status: "succeeded",
		});
		agent.observe({ id: "u2", who: "user", text: "推論用です", at: 40_000 });
		// The general one does not tie into the talk: the reply is not offered it.
		expect(agent.askForReply(40_000)).toBeNull();
		agent.observe({ id: "r2", who: "reply", text: "なるほど。", at: 40_000 });
		// Nothing that ties in: it digs into the talk at once. Finding nothing does not bring the
		// general question in: it stays unsaid while the talk goes on.
		expect(agent.nextAt(50_000)).toBe(50_000);
		const dig = await agent.step(50_000, idle, sig());
		expect(
			m.calls.filter((c) => c.kind === "plan").at(-1)!.data["nothingToSay"],
		).toBe(true);
		expect(dig.tickets.filter((t) => t.kind === "speak")).toEqual([]);
		// Once the talk is over, it may come.
		const later = await agent.step(340_001, idle, sig());
		expect(later.tickets).toMatchObject([{ itemKind: "ask" }]);
		expect((m.calls.at(-1)!.data["item"] as { text: string }).text).toBe(
			"苦手なこと",
		);
	});

	test("a reply that leaves the offered question out: it stays open", async () => {
		const m = scripted({
			plan: (d) =>
				plan(
					add("ask", "用途", [
						(d["conversation"] as { id: string }[]).at(-1)!.id,
					]),
				),
		});
		const agent = make({ llm: m.llm });
		agent.observe({ id: "u1", who: "user", text: "PCを買った", at: 0 });
		agent.observe({ id: "r1", who: "reply", text: "いいですね。", at: 0 });
		await agent.step(0, idle, sig());
		agent.observe({ id: "u2", who: "user", text: "速い", at: 5_000 });
		expect(agent.askForReply(5_000)?.text).toBe("用途");
		agent.observe({
			id: "r2",
			who: "reply",
			text: "よかったですね。",
			at: 5_000,
		});
		expect(agent.view().items[0]?.status).toBe("open");
	});

	test("the first words in a while may get a general question in the reply; none in a quiet period", async () => {
		const m = scripted({
			plan: () => plan(add("ask", "苦手なこと", [], 5)),
		});
		const agent = make({ llm: m.llm });
		// It spoke a moment ago (the shortest gap holds its own speech); then the user is back.
		agent.observe({ id: "r0", who: "reply", text: "こんばんは。", at: 0 });
		agent.observe({ id: "u1", who: "user", text: "ただいま", at: 0 });
		const out = await agent.step(0, idle, sig());
		expect(out.tickets).toEqual([]);
		expect(agent.askForReply(0)?.text).toBe("苦手なこと");
		agent.setQuiet({ scope: "speech", minutes: 30, at: 0 });
		expect(agent.askForReply(0)).toBeNull();
	});

	test("the user's no to an offer: the plan hears it, and nothing else is held back", async () => {
		const notesNow: NoteRef[] = [
			{ id: "n1", title: "辛い店", summary: "A店", at: 0, refs: [] },
			{ id: "n2", title: "家ラーメン", summary: "B", at: 0, refs: [] },
		];
		const m = scripted({
			plan: (_d, n) =>
				n === 1
					? plan(
							add("talk", "店の話", ["note:n1"], 5),
							add("talk", "家の話", ["note:n2"], 4),
							add("ask", "Q", [], 3),
						)
					: plan(),
			compose: (_d, n) => ({
				utterance: `話${n}があります。表示しましょうか？`,
				decline: null,
			}),
		});
		const agent = make({ llm: m.llm, notes: () => notesNow });
		const a = await agent.step(0, idle, sig());
		agent.recordDelivery({
			ticketId: a.tickets[0]!.id,
			at: 0,
			status: "succeeded",
		});
		agent.observe({ id: "u1", who: "user", text: "今はいいかな", at: 20_000 });
		// Nothing is held back for the no: something comes at once (a dig into the talk).
		expect(agent.nextAt(20_000)).toBe(20_000);
		agent.infoChanged(20_000);
		await agent.step(20_000, idle, sig());
		expect(
			m.calls.filter((c) => c.kind === "plan").at(-1)!.data["declinedByUser"],
		).toEqual([
			{
				agentSaid: "話1があります。表示しましょうか？",
				user: "今はいいかな",
				minutesAgo: 0,
			},
		]);
		// Forgotten words take the record with them.
		agent.forget(["u1"]);
		agent.infoChanged(30_000);
		await agent.step(30_000, idle, sig());
		expect(
			m.calls.filter((c) => c.kind === "plan").at(-1)!.data["declinedByUser"],
		).toEqual([]);
	});

	test("a question about a talk that is over is not asked on its own", async () => {
		const m = scripted({
			plan: (_d, n) =>
				n === 1
					? plan(add("ask", "深掘り", ["u1"], 5), add("ask", "一般", [], 3))
					: plan(),
		});
		const agent = make({ llm: m.llm });
		agent.observe({
			id: "u1",
			who: "user",
			text: "モンハンにハマってる",
			at: 0,
		});
		agent.observe({ id: "r1", who: "reply", text: "いいですね。", at: 0 });
		agent.setQuiet({ scope: "speech", minutes: 6, at: 0 });
		await agent.step(0, idle, sig());
		// Past five minutes the talk is over: the general question goes, the other is dropped.
		const out = await agent.step(360_000, idle, sig());
		expect(out.tickets).toMatchObject([{ itemKind: "ask" }]);
		expect((m.calls.at(-1)!.data["item"] as { text: string }).text).toBe(
			"一般",
		);
		expect(agent.view().items.find((i) => i.text === "深掘り")?.status).toBe(
			"dropped",
		);
	});

	test("questions closed with 。 are questions too", async () => {
		const m = scripted({ plan: () => plan(add("ask", "道具", ["u1"])) });
		const agent = make({ llm: m.llm });
		agent.observe({ id: "u1", who: "user", text: "キャンプに行った", at: 0 });
		agent.observe({
			id: "r1",
			who: "reply",
			text: "いいですね。次に出かける予定はありますか。",
			at: 0,
		});
		// The reply asked: its own question waits for the answer.
		expect((await agent.step(0, idle, sig())).tickets).toEqual([]);
		// The answer to it gets no question back, as with "？"; the question stays open.
		agent.observe({ id: "u2", who: "user", text: "来月かな", at: 10_000 });
		expect(agent.askForReply(10_000)).toBeNull();
		agent.observe({
			id: "r2",
			who: "reply",
			text: "楽しみですね。",
			at: 10_000,
		});
		agent.observe({ id: "u3", who: "user", text: "うん", at: 20_000 });
		expect(agent.askForReply(20_000)?.text).toBe("道具");
	});

	test("what counts as a no: only clear ones", () => {
		for (const t of [
			"今はいいかな",
			"今はいいや",
			"また今度で",
			"いや、今はいらない",
			"結構です",
			"興味ないかな",
			"あとで見る",
			"今日はいいよ",
			"うーん、今はいいかなー",
			"ごめん、また今度",
			"いいや",
			"うーん、道具の話はまたそのうちで。今日はのんびりしたい",
			"その話は今度で",
		])
			expect([t, declinesOffer(t)]).toEqual([t, true]);
		for (const t of [
			"それはいいね",
			"今はいい感じ",
			"うん、見せて",
			"テントのポールかな",
			"いいですね",
			"それはいいですね",
			"それはいい！",
			"別にいいよ",
			"それは結構好きです",
			"もう結構遅いね",
			"うん、もういいよ、続けて",
			"もう遠慮なく聞いて",
			"それはやめたほうがいい",
			"今日は大丈夫です、ありがとう",
			"もう大丈夫そう",
			"キャンプはいいね",
			"仕事のことは特に話すこともないかな",
		])
			expect([t, declinesOffer(t)]).toEqual([t, false]);
	});

	test("the plan's refs are checked: unknown refs, research without a reason, talk without a note", async () => {
		const m = scripted({
			plan: () =>
				plan(
					add("research", "理由なし"),
					add("ask", "知らない参照", ["memory:zz"]),
					add("talk", "メモなし"),
					add("ask", "ok"),
				),
		});
		const agent = make({ llm: m.llm });
		const out = await agent.step(0, idle, sig());
		expect(out.plan?.rejected).toEqual([
			"research:needs_user_reason",
			"ask:unknown_ref",
			"talk:needs_one_note",
		]);
		expect(out.plan?.added.map((a) => a.text)).toEqual(["ok"]);
	});

	test("forgetting the user's words drops what rests on them, and what was said from it", async () => {
		const m = scripted({
			plan: (d) =>
				plan(
					add("ask", "深掘り", [
						(d["conversation"] as { id: string }[])[0]!.id,
					]),
				),
		});
		const agent = make({ llm: m.llm });
		agent.observe({ id: "u1", who: "user", text: "秘密の話", at: 0 });
		// Its own question comes once the talk pauses.
		const out = await agent.step(180_000, idle, sig());
		agent.recordDelivery({
			ticketId: out.tickets[0]!.id,
			at: 180_000,
			status: "succeeded",
		});
		expect(agent.view().said.map((s) => s.who)).toEqual(["user", "own"]);
		agent.forget(["u1"]);
		expect(agent.view().said).toEqual([]);
		expect(agent.view().items).toEqual([]);
	});

	test("busy: no plan and no speech; research may still start", async () => {
		const m = scripted({});
		const agent = make({ llm: m.llm });
		agent.observe({ id: "u1", who: "user", text: "x", at: 0 });
		agent.requestResearch({ text: "A", at: 0 });
		const out = await agent.step(0, () => ({ busy: true }), sig());
		expect(out.plan).toBeNull();
		expect(out.tickets.map((t) => t.kind)).toEqual(["research"]);
		expect(m.calls.length).toBe(0);
	});

	test("review 2026-11-10: covered with no note (an earlier request) or a note not there is dropped, not thrown", async () => {
		for (const coveredBy of [null, "note:missing"]) {
			const m = scripted({
				plan: (_d, n) =>
					n === 1
						? plan(add("research", "辛いラーメンの新作", ["u1"]))
						: plan(),
				check: () => ({
					verdict: "covered",
					coveredBy,
					request: null,
					reason: "前に頼んだものと同じ",
				}),
			});
			const agent = make({
				llm: m.llm,
				notes: () => [{ id: "n1", title: "t", summary: "s", at: 0, refs: [] }],
			});
			agent.observe({ id: "u1", who: "user", text: "辛いのが好き", at: 0 });
			const out = await agent.step(0, idle, sig());
			expect(out.check).toMatchObject({ verdict: "covered", coveredBy: null });
			expect(out.tickets.filter((t) => t.kind === "research")).toEqual([]);
			expect(agent.view().items.map((i) => [i.kind, i.status])).toEqual([
				["research", "dropped"],
			]);
		}
	});

	test("review 2026-11-10: research asked for that fails is told, not left in silence", async () => {
		const m = scripted({});
		const agent = make({ llm: m.llm });
		agent.observe({ id: "u1", who: "user", text: "京都の朝を調べて", at: 0 });
		agent.requestResearch({ text: "京都の朝", at: 0 });
		const out = await agent.step(0, () => ({ busy: true }), sig());
		const t = out.tickets.find((x) => x.kind === "research")!;
		agent.researchReturned({
			ticketId: t.id,
			at: 60_000,
			status: "failed",
			note: null,
		});
		const items = agent.view().items;
		expect(items.find((i) => i.kind === "research")).toMatchObject({
			status: "failed",
			endedAt: 60_000,
		});
		const told = items.find((i) => i.kind === "talk")!;
		expect(told).toMatchObject({
			requested: true,
			promised: true,
			noteId: null,
			status: "open",
			refs: ["u1"],
		});
		expect(told.text).toContain("「京都の朝」は、うまく調べられなかった");
		const next = await agent.step(60_000, idle, sig());
		expect(next.tickets).toMatchObject([
			{ kind: "speak", itemKind: "talk", itemId: told.id },
		]);
		// Asked again, it is not refused as a repeat of what failed.
		expect(
			agent.requestResearch({ text: "京都の朝", at: 70_000 }),
		).toHaveProperty("item");
	});

	test("review 2026-11-10: a promised research never returned fails after its time and is told; the agent's own is not", async () => {
		const m = scripted({
			plan: (_d, n) =>
				n === 1 ? plan(add("research", "辛い店の探し方", ["u1"])) : plan(),
		});
		const agent = make({ llm: m.llm });
		agent.observe({ id: "u1", who: "user", text: "辛いのが好き", at: 0 });
		// Its own research (from the plan) first; it fails: nothing to tell.
		const own = await agent.step(0, idle, sig());
		const t1 = own.tickets.find((x) => x.kind === "research")!;
		agent.researchReturned({
			ticketId: t1.id,
			at: 1,
			status: "failed",
			note: null,
		});
		expect(agent.view().items.filter((i) => i.kind === "talk")).toEqual([]);
		// What the reply said it would look into, never returned.
		agent.requestResearch({ text: "京都の朝", at: 2, requested: false });
		const out = await agent.step(2, () => ({ busy: true }), sig());
		expect(out.tickets.map((x) => x.kind)).toEqual(["research"]);
		await agent.step(2 + RESEARCH_TTL_MS, () => ({ busy: true }), sig());
		const items = agent.view().items;
		expect(
			items.find((i) => i.kind === "research" && i.text === "京都の朝"),
		).toMatchObject({ status: "failed" });
		expect(items.find((i) => i.kind === "talk")).toMatchObject({
			requested: false,
			promised: true,
			text: "調べておくと言った「京都の朝」は、うまく調べられなかった",
		});
	});

	test("review 2026-11-10: the promises still open and the quiet outlive a restart; working memory does not", async () => {
		const m = scripted({
			plan: (_d, n) =>
				n === 1 ? plan(add("ask", "最近ハマっていること")) : plan(),
		});
		const a = make({ llm: m.llm });
		a.observe({ id: "u1", who: "user", text: "京都の朝と夜を調べて", at: 0 });
		a.requestResearch({ text: "京都の朝", at: 0 });
		a.requestResearch({ text: "京都の夜", at: 0 });
		const out = await a.step(0, idle, sig());
		const first = out.tickets.find((x) => x.kind === "research")!;
		// The agent's own question is working memory: it is not kept.
		expect(a.view().items.map((i) => [i.kind, i.status])).toEqual([
			["research", "doing"],
			["research", "open"],
			["ask", "open"],
		]);
		a.setQuiet({ scope: "speech", minutes: 60, at: 0 });
		// The host stores it as JSON and passes it back after the restart.
		const saved = JSON.parse(JSON.stringify(a.snapshot(1))) as AgendaSnapshot;
		expect(saved.items.map((i) => [i.kind, i.text])).toEqual([
			["research", "京都の朝"],
			["research", "京都の夜"],
		]);
		const b = make({ llm: m.llm, startedAt: 2, restore: saved });
		expect(b.view().items.map((i) => [i.text, i.status])).toEqual([
			["京都の朝", "open"],
			["京都の夜", "open"],
		]);
		expect(b.view().said).toEqual([]);
		expect(b.view().quiet.speechUntil).toBe(3_600_000);
		// The running one comes back queued and starts again first; new ids go on after the old.
		const again = await b.step(2, () => ({ busy: true }), sig());
		expect(again.tickets).toMatchObject([
			{ kind: "research", text: "京都の朝", requested: true },
		]);
		expect(again.tickets[0]!.id).not.toBe(first.id);
		b.observe({ id: "u2", who: "user", text: "昼も", at: 3 });
		const r = b.requestResearch({ text: "京都の昼", at: 3 });
		expect("item" in r && saved.items.some((i) => i.id === r.item.id)).toBe(
			false,
		);
		// What was promised and told is gone from the next snapshot.
		b.researchReturned({
			ticketId: again.tickets[0]!.id,
			at: 4,
			status: "failed",
			note: null,
		});
		expect(b.snapshot(5).items.map((i) => [i.kind, i.text])).toEqual([
			["research", "京都の夜"],
			["research", "京都の昼"],
			[
				"talk",
				"頼まれた調べもの「京都の朝」は、うまく調べられなかった（もう一度頼まれればやり直せる）",
			],
		]);
		// A snapshot is checked before it is trusted.
		expect(() =>
			make({
				llm: m.llm,
				restore: { ...saved, version: 2 } as unknown as AgendaSnapshot,
			}),
		).toThrow();
	});
});
