/**
 * The agenda agent's rules with a scripted model (spec 2026-11-08 §6): when it plans, researches
 * and speaks is decided by code, and the model is called only to plan and to write.
 */
import { describe, expect, test } from "bun:test";
import type { LlmPort, LlmRequest } from "../../src/index.ts";
import {
	createAgendaAgent,
	declinesOffer,
	type AgendaDeps,
	type CheckOutput,
	type ComposeOutput,
	type NoteRef,
	type PlanOutput,
} from "../../src/agenda/index.ts";

type Data = Record<string, unknown>;

type Kind = "plan" | "check" | "compose";

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
	/** The feeling may be left out of a script (🙂 when speaking, none when declining). */
	compose?: (
		d: Data,
		n: number,
	) => Omit<ComposeOutput, "emotion"> & Partial<Pick<ComposeOutput, "emotion">>;
}) => {
	const calls: { kind: Kind; data: Data }[] = [];
	const llm: LlmPort = {
		complete<T>(req: LlmRequest<T>) {
			const kind = req.system.includes("この呼び出しは「計画」")
				? "plan"
				: req.system.includes("重複チェック")
					? "check"
					: "compose";
			const data = JSON.parse(req.prompt) as Data;
			calls.push({ kind, data });
			const n = calls.filter((c) => c.kind === kind).length;
			const value =
				kind === "plan"
					? (s.plan?.(data, n) ?? { add: [], drop: [] })
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
	test("cold start: plans at once and asks; with nothing to do, no model call", async () => {
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
		// Nothing new: the next thing to do is the hourly plan.
		expect(agent.nextAt(1_000)).toBe(3_600_000);
		const quiet = await agent.step(60_000, idle, sig());
		expect(quiet.plan).toBeNull();
		expect(quiet.compose).toBeNull();
		expect(m.calls.length).toBe(2);
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
		expect(agent.nextAt(1)).toBe(60_000);
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

	test("an own question waits for the answer: no second question, talk after 60 s", async () => {
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
		// Within 60 s nothing; after it the talk, never Q2 before the user answers.
		expect(agent.nextAt(1_000)).toBe(60_000);
		const b = await agent.step(60_000, idle, sig());
		expect(b.tickets).toMatchObject([{ itemKind: "talk" }]);
		agent.recordDelivery({
			ticketId: b.tickets[0]!.id,
			at: 60_000,
			status: "succeeded",
		});
		agent.observe({ id: "u1", who: "user", text: "答え", at: 70_000 });
		// Q2 does not tie into what the user just said: it waits until the talk pauses.
		expect(agent.nextAt(80_000)).toBe(70_000 + 180_000);
		const c = await agent.step(250_000, idle, sig());
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
		expect(agent.nextAt(120_000)).toBe(3_600_000);
		agent.observe({ id: "u2", who: "user", text: "味噌かな", at: 130_000 });
		// Answered: its own question may come again, once the talk pauses.
		expect(agent.nextAt(130_000)).toBe(130_000 + 180_000);
	});

	test("a declined question puts the other questions off too", async () => {
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
		expect(agent.nextAt(1)).toBe(600_000);
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
		expect(agent.nextAt(1)).toBe(3_600_000);
		agent.observe({ id: "u1", who: "user", text: "うん、見せて", at: 30_000 });
		// Answered: questions open again once the talk pauses (the open one is not tied to it).
		expect(agent.nextAt(30_000)).toBe(30_000 + 180_000);
	});

	test("unanswered speech backs off by doubling and is held past ten minutes", async () => {
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
		const agent = make({
			llm: m.llm,
			notes: () => notes,
			speechIntervalSec: 60,
		});
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
		// Each unanswered utterance doubles the gap (60 s × 2, × 4, …); past ten minutes it is held.
		expect(gaps.slice(0, 2)).toEqual([120, 240]);
		expect(agent.view().unanswered).toBeGreaterThanOrEqual(3);
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

	test("declined twice: dropped; a repeat is never said", async () => {
		const m = scripted({
			plan: (_d, n) => (n === 1 ? plan(add("ask", "Q")) : plan()),
			compose: () => ({ utterance: null, decline: "今は合わない" }),
		});
		const agent = make({ llm: m.llm });
		const a = await agent.step(0, idle, sig());
		expect(a.compose?.declined).toBe("今は合わない");
		expect(agent.nextAt(1)).toBe(600_000);
		await agent.step(600_000, idle, sig());
		expect(agent.view().items[0]!.status).toBe("dropped");

		const r = scripted({
			plan: () => plan(add("ask", "別の問い")),
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

	test("a sentence already said, inside a longer utterance, is a repeat", async () => {
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
		expect(out.compose?.rejected).toEqual(["repeat"]);
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
		expect(agent.view().planDue).toBe(false);
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

	test("review: past the hold, only the user's words open speech again", async () => {
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
		// 1 min × 2, × 4, × 8 after each unanswered one; the next (16 min) is past the
		// 10-minute hold: it waits for the user.
		expect(at).toEqual([0, 120, 360, 840]);
		expect(
			agent.view().items.some((i) => i.kind === "talk" && i.status === "open"),
		).toBe(true);
		expect(agent.nextAt(now + 1)! - now).toBeGreaterThan(600_000);
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

	test("in a conversation it asks only at the end of a reply, one question in two replies; its own wait for a pause", async () => {
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
		// Planned, but nothing asked on its own while the user is talking.
		expect(first.plan?.added).toHaveLength(2);
		expect(first.tickets).toEqual([]);
		agent.observe({ id: "u2", who: "user", text: "推論用です", at: 40_000 });
		// The reply may ask what ties into the talk (the lower-valued one), not the general one.
		expect(agent.askForReply(40_000)?.text).toBe("そのPCの用途");
		agent.observe({
			id: "r2",
			who: "reply",
			text: "いいですね。どんなモデルを動かしていますか？",
			at: 40_000,
		});
		expect(
			agent.view().items.find((i) => i.text === "そのPCの用途")?.status,
		).toBe("done");
		// The answer to it gets no question back.
		agent.observe({ id: "u3", who: "user", text: "Qwenです", at: 60_000 });
		expect(agent.askForReply(60_000)).toBeNull();
		agent.observe({ id: "r3", who: "reply", text: "なるほど。", at: 60_000 });
		// The general question waits until three minutes after the user's last words.
		expect(agent.nextAt(70_000)).toBe(60_000 + 180_000);
		const later = await agent.step(240_000, idle, sig());
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
		await agent.step(0, idle, sig());
		agent.observe({ id: "u2", who: "user", text: "速い", at: 10_000 });
		expect(agent.askForReply(10_000)?.text).toBe("用途");
		agent.observe({
			id: "r2",
			who: "reply",
			text: "よかったですね。",
			at: 10_000,
		});
		expect(agent.view().items[0]?.status).toBe("open");
	});

	test("the first words in a while may get a general question in the reply; none in a quiet period", async () => {
		const m = scripted({
			plan: () => plan(add("ask", "苦手なこと", [], 5)),
		});
		const agent = make({ llm: m.llm });
		agent.observe({ id: "u1", who: "user", text: "ただいま", at: 0 });
		const out = await agent.step(0, idle, sig());
		expect(out.tickets).toEqual([]);
		expect(agent.askForReply(0)?.text).toBe("苦手なこと");
		agent.setQuiet({ scope: "speech", minutes: 30, at: 0 });
		expect(agent.askForReply(0)).toBeNull();
	});

	test("the user's no to an offer: nothing for ten minutes, and the plan hears it", async () => {
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
		// The other topic and the question both wait ten minutes.
		expect(agent.nextAt(20_000)).toBe(20_000 + 600_000);
		agent.infoChanged(20_000);
		await agent.step(20_000, idle, sig());
		expect(m.calls.at(-1)!.data["declinedByUser"]).toEqual([
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
		expect(m.calls.at(-1)!.data["declinedByUser"]).toEqual([]);
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
		await agent.step(0, idle, sig());
		agent.observe({
			id: "r1",
			who: "reply",
			text: "いいですね。次に出かける予定はありますか。",
			at: 0,
		});
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
});
