/**
 * The user's plans-and-interests note: what the memory leaves out, written from the user's own
 * words, and seen by the plan (as a reason for research) and the utterance.
 */
import { expect, test } from "bun:test";
import type { LlmPort, LlmRequest } from "../../src/index.ts";
import {
	createAgendaAgent,
	emptyProfile,
	profileLines,
	updateProfile,
	type PlanOutput,
} from "../../src/agenda/index.ts";

const idle = () => ({ busy: false });

type Op = {
	op: "add" | "update" | "remove";
	section: "plans" | "interests" | null;
	id: string | null;
	text: string | null;
	evidence: string[];
};

/** A model that answers the note's writer with the next ops, and records what it was given. */
const writerModel = (answers: Op[][]) => {
	const prompts: Record<string, unknown>[] = [];
	const llm: LlmPort = {
		complete<T>(req: LlmRequest<T>) {
			prompts.push(JSON.parse(req.prompt) as Record<string, unknown>);
			return Promise.resolve({
				value: req.schema.parse({ ops: answers.shift() ?? [] }),
				model: "scripted",
				inputTokens: 10,
				outputTokens: 10,
				cacheReadTokens: 0,
				latencyMs: 1,
			});
		},
	};
	return { llm, prompts };
};

const run = (
	llm: LlmPort,
	markdown: string,
	said: { id: string; who: string; text: string }[],
	fresh: string[],
) =>
	updateProfile({
		llm,
		markdown,
		said,
		fresh,
		known: [{ id: "m1", text: "温泉が好き" }],
		clock: "2026/11/7(土) 19:00",
		at: 0,
		signal: new AbortController().signal,
	});

test("a plan the memory leaves out goes into the note, from the user's own words", async () => {
	const m = writerModel([
		[
			{
				op: "add",
				section: "plans",
				id: null,
				text: "12月に箱根へ一泊の温泉旅行を考えている。宿は未定",
				evidence: ["u1"],
			},
			// The agent's words are no evidence.
			{
				op: "add",
				section: "interests",
				id: null,
				text: "露天風呂付きの宿",
				evidence: ["a1"],
			},
		],
	]);
	const said = [
		{ id: "a1", who: "own", text: "露天風呂付きの宿もありますよ" },
		{
			id: "u1",
			who: "user",
			text: "来月、箱根に一泊で温泉旅行に行こうと思ってるんだ",
		},
	];
	const u = await run(m.llm, "", said, ["a1", "u1"]);
	expect(u.applied).toEqual([
		"add 予定: 12月に箱根へ一泊の温泉旅行を考えている。宿は未定",
	]);
	expect(u.rejected).toEqual(["add:needs_new_user_words"]);
	expect(profileLines(u.markdown)).toEqual([
		{
			id: "p1",
			section: "plans",
			text: "12月に箱根へ一泊の温泉旅行を考えている。宿は未定",
			line: 5,
		},
	]);
	// The writer saw the time, what the memory holds, and which words are new and whose.
	expect(m.prompts[0]!["now"]).toBe("2026/11/7(土) 19:00");
	expect(m.prompts[0]!["memory"]).toEqual(["温泉が好き"]);
	expect(m.prompts[0]!["conversation"]).toEqual([
		{
			id: "a1",
			who: "agent",
			text: "露天風呂付きの宿もありますよ",
			new: false,
		},
		{
			id: "u1",
			who: "user",
			text: "来月、箱根に一泊で温泉旅行に行こうと思ってるんだ",
			new: true,
		},
	]);
});

test("the user's own lines and wording stay; only the named lines change", async () => {
	const edited = [
		"# 利用者の予定と関心",
		"",
		"自分用のメモ（利用者が書いた）",
		"",
		"## 予定",
		"- 12月に箱根へ一泊（宿は未定）",
		"- 年末は実家に帰る",
		"",
		"## 関心",
		"- ローカルLLMの速度",
		"",
	].join("\n");
	const m = writerModel([
		[
			{
				op: "update",
				section: null,
				id: "p1",
				text: "12/6〜7に箱根へ一泊。宿は強羅で探している",
				evidence: ["u2"],
			},
			{ op: "remove", section: null, id: "p3", text: null, evidence: ["u2"] },
			{
				op: "add",
				section: "interests",
				id: null,
				text: "強羅の宿の空き",
				evidence: ["u2"],
			},
		],
	]);
	const u = await run(
		m.llm,
		edited,
		[
			{
				id: "u2",
				who: "user",
				text: "箱根は12/6から一泊、強羅で探してる。LLMの速度はもう気にしてない",
			},
		],
		["u2"],
	);
	expect(u.markdown).toBe(
		[
			"# 利用者の予定と関心",
			"",
			"自分用のメモ（利用者が書いた）",
			"",
			"## 予定",
			"- 12/6〜7に箱根へ一泊。宿は強羅で探している",
			"- 年末は実家に帰る",
			"",
			"## 関心",
			"- 強羅の宿の空き",
			"",
		].join("\n"),
	);
});

test("no new user words, no call; an empty note starts from the template", async () => {
	const m = writerModel([]);
	const u = await run(
		m.llm,
		"",
		[{ id: "a1", who: "own", text: "旅行の予定はありますか？" }],
		["a1"],
	);
	expect(m.prompts).toEqual([]);
	expect(u.changed).toBe(false);
	expect(u.markdown).toBe(emptyProfile());
});

test("the plan sees the note and may research a plan from it; the utterance sees it too", async () => {
	const plans: Record<string, unknown>[] = [];
	const composes: Record<string, unknown>[] = [];
	const llm: LlmPort = {
		complete<T>(req: LlmRequest<T>) {
			const data = JSON.parse(req.prompt) as Record<string, unknown>;
			const isPlan = req.system.includes("この呼び出しは「計画」");
			const isCheck = req.system.includes("重複チェック");
			if (isPlan) plans.push(data);
			else if (!isCheck) composes.push(data);
			const plan: PlanOutput = {
				add:
					plans.length === 1 && isPlan
						? [
								{
									kind: "research",
									text: "12月の箱根で一泊できる温泉宿の候補を調べ、予算別に結論をまとめる",
									refs: ["profile:p1"],
									value: 4,
									reason: "予定の下調べ",
								},
								{
									kind: "ask",
									text: "箱根には誰と行く予定ですか",
									refs: ["profile:p1"],
									value: 3,
									reason: "同行者が未定",
								},
							]
						: [],
				drop: [],
			};
			const value = isPlan
				? plan
				: isCheck
					? { verdict: "new", coveredBy: null, request: null, reason: "新しい" }
					: {
							utterance: "箱根には誰と行く予定ですか？",
							decline: null,
							emotion: "🙂",
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
	const markdown = emptyProfile().replace(
		"## 予定\n",
		"## 予定\n- 12月に箱根へ一泊の温泉旅行を考えている。宿と同行者は未定\n",
	);
	const agent = createAgendaAgent({
		llm,
		startedAt: 0,
		profile: () => markdown,
	});
	const out = await agent.step(0, idle, new AbortController().signal);
	expect((plans[0]!["user"] as Record<string, unknown>)["plans"]).toEqual([
		{
			id: "profile:p1",
			text: "12月に箱根へ一泊の温泉旅行を考えている。宿と同行者は未定",
		},
	]);
	// The note's line is a reason the user gave: research may rest on it alone.
	expect(out.plan?.added.map((a) => a.kind).sort()).toEqual([
		"ask",
		"research",
	]);
	// The question rests on the note, not on words of a talk that is over: it is asked.
	expect(out.tickets.map((t) => t.kind).sort()).toEqual(["research", "speak"]);
	expect((composes[0]!["user"] as Record<string, unknown>)["plans"]).toEqual([
		"12月に箱根へ一泊の温泉旅行を考えている。宿と同行者は未定",
	]);
});

test("an interest stays until the user says it is over; a plan whose day passed may go", async () => {
	const note = [
		"## 予定",
		"- 11/1に京都へ日帰り",
		"",
		"## 関心",
		"- Geminiの動画生成のニュース",
		"",
	].join("\n");
	const m = writerModel([
		[
			{ op: "remove", section: null, id: "p1", text: null, evidence: [] },
			{ op: "remove", section: null, id: "p2", text: null, evidence: [] },
		],
	]);
	const u = await run(
		m.llm,
		note,
		[{ id: "u1", who: "user", text: "それは以前の会話を記憶しての事ですか？" }],
		["u1"],
	);
	expect(u.applied).toEqual(["remove p1: 11/1に京都へ日帰り"]);
	expect(u.rejected).toEqual(["remove:needs_new_user_words"]);
	expect(profileLines(u.markdown).map((l) => l.text)).toEqual([
		"Geminiの動画生成のニュース",
	]);
});
