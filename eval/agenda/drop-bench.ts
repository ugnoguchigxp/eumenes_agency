/**
 * Drop bench: what the plan drops from the agenda, on fixed moments, many times, without running
 * the whole agent. Each moment sets up topics made from finished research (and a question or
 * two), then the agent's last words and the user's line; the real plan (its prompt and schema)
 * runs once and the bench records what it proposes to drop and why. The other calls (checks, the
 * utterance writer) are scripted. Review 2026-11-10 §3: the plan dropped finished research when
 * the user only wanted a rest ("ぼーっとしたい" → "こちらからは控えると伝えたため…合わない"), which
 * the reply handles as a short pause; the moments here hold those (keep) and the drops that are
 * right (the user turned the topic down, a correction, an answered question, a plan that is over).
 * Measurement only; cost is recorded, never capped.
 *
 *   zsh -l scripts/api-entry.zsh eval/agenda/drop-bench.ts run <name> [--repeat 4]
 *   bun eval/agenda/drop-bench.ts compare <name> [<name>...]
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { LlmPort, LlmRequest } from "../../src/index.ts";
import {
	createAgendaAgent,
	emptyProfile,
	type NoteRef,
	type PlanOutput,
} from "../../src/agenda/index.ts";
import { createProviderLlm } from "../../standalone/providers.ts";
import { openUncappedMeter } from "../../standalone/always-on-host.ts";
import { loadSettings } from "../../standalone/settings.ts";
import { clockFrom } from "./live.ts";

const DIR = resolve("data/agenda/drop-bench");

/** A topic from a finished research (`note`), or a question. `drop`: the plan should drop it. */
interface BenchItem {
	readonly key: string;
	readonly kind: "talk" | "ask";
	/** talk: the note's title; ask: the question. */
	readonly text: string;
	/** any: not counted (dropping it may be right or not). */
	readonly expect: "keep" | "drop" | "any";
}

export interface DropMoment {
	readonly name: string;
	/**
	 * rest: the user only wants a rest (a short pause, set as the reply would), and the plan runs on
	 * those words; later: the same words thirteen minutes ago, a "うん" since, and the plan runs on a
	 * research result now (as in hour, ag48: four results dropped at once); right: a drop is due;
	 * promise: a research the reply took on for the user's line (the CLI, 2026-11-10: the plan
	 * dropped "-0.0 の舞台と見どころ" seven seconds later as a repeat of a note on -1.0).
	 */
	readonly group: "rest" | "later" | "right" | "promise";
	readonly items: readonly BenchItem[];
	/** promise: the research the reply took on for the user's line (asked for by the user). */
	readonly requests?: readonly {
		readonly key: string;
		readonly text: string;
		readonly expect: "keep" | "drop";
	}[];
	/** promise: the user's next words (and the reply to them), after the request, before the plan. */
	readonly next?: { readonly user: string; readonly reply: string };
	/** promise: an earlier request that came back as the note of a talk item (by key). */
	readonly earlier?: { readonly text: string; readonly noteKey: string };
	/** promise: a research still running when the plan comes. */
	readonly running?: string;
	/** The agent's last words before the user's line. */
	readonly agent: string;
	readonly user: string;
	/** The reply to the user's line. */
	readonly reply: string;
	readonly clock?: string;
	readonly memory?: readonly string[];
}

const homeNotes = (
	...keep: readonly [string, string][]
): readonly BenchItem[] =>
	keep.map(([key, text]) => ({ key, kind: "talk", text, expect: "keep" }));

const restTopics = homeNotes(
	["sleep", "休日の夜に眠りの質を上げる手軽な工夫"],
	["stretch", "家でできる、だるさをほぐす軽い体の動かし方"],
	["tea", "夜にほっとできるノンカフェインの飲み物"],
);
const laterTopics = [
	...restTopics,
	...homeNotes(["craft", "家でできる小さな創作の楽しみ方"]),
];
const restAsk: BenchItem = {
	key: "ask-hobby",
	kind: "ask",
	text: "休みの日に、ついやってしまう好きなことはありますか？",
	expect: "keep",
};

const EARLIER_MINUS_ZERO =
	"映画『ゴジラ-0.0』の作品の見どころと舞台（戦後の東京や海沿いの描写）を調べ、景色や海が好きな相手が楽しめる観点でまとめる";
const MINUS_ZERO =
	"映画『ゴジラ-0.0』の舞台と見どころを改めて調べ、前のメモ（ゴジラ-1.0）とは別の作品としてまとめる";
const MINUS_ONE_TALK =
	"さっきのゴジラ-1.0について調べてみました。終戦直後の焦土になった東京と海が舞台で、海上の機雷撤去や銀座の破壊シーンが見どころだそうです。詳細をメモにまとめてあるので、表示しましょうか？";
const godzillaNotes: readonly BenchItem[] = [
	{
		key: "minus-one",
		kind: "talk",
		text: "映画『ゴジラ-1.0』の見どころと海・戦後東京の舞台",
		expect: "any",
	},
	...homeNotes(["route", "七里ヶ浜から辻堂への電車の経路と夜の帰りの本数"]),
];

export const dropMoments: readonly DropMoment[] = [
	// The user only wants a rest: the reply sets a short pause; nothing here is turned down.
	{
		name: "rest-bootto",
		group: "rest",
		items: [...restTopics, restAsk],
		agent:
			"休日の過ごし方のヒントをまとめました。予定を詰めすぎないのがコツだそうです。表示しましょうか？",
		user: "うーん、今日はぼーっとしたいから、今はいいかな",
		reply: "わかりました。少しのあいだ控えますね。ゆっくりしてください。",
	},
	{
		name: "rest-sotto",
		group: "rest",
		items: [...restTopics, restAsk],
		agent: "今日はどんな一日でしたか？",
		user: "今夜はそっとしておいてほしいな",
		reply: "わかりました。少しのあいだ控えますね。",
	},
	{
		name: "rest-tsukareta",
		group: "rest",
		items: [...restTopics, restAsk],
		agent: "夕飯はもう食べましたか？",
		user: "今日はちょっと疲れてて、今は休みたい",
		reply: "お疲れさまです。少しのあいだ控えますね。ゆっくり休んでください。",
	},
	{
		name: "rest-nonbiri",
		group: "rest",
		items: [...restTopics, restAsk],
		agent: "ところで、最近気になっていることはありますか？",
		user: "今はのんびりしたい気分なんだよね",
		reply: "いいですね。少しのあいだ控えますね。",
	},
	{
		name: "rest-hanasu-kibun",
		group: "rest",
		items: [...restTopics, restAsk],
		agent: "週末は何をして過ごす予定ですか？",
		user: "今はあんまり話す気分じゃないかも",
		reply: "わかりました。少しのあいだ控えますね。",
	},
	{
		name: "rest-matte",
		group: "rest",
		items: [...restTopics, restAsk],
		agent: "夜にほっとできる飲み物の話、気になりますか？",
		user: "ちょっと待って、いま手が離せない",
		reply: "了解です。少しのあいだ控えますね。",
	},
	// The same, thirteen minutes on: the pause ended with a "うん", and a research result comes in.
	{
		name: "later-bootto",
		group: "later",
		items: [...laterTopics, restAsk],
		agent:
			"ぼーっとしていると、あっという間に時間がたちますよね。最近、仕事や生活のなかで気になっていることはありますか？",
		user: "んー、特にないかな。今日は本当にぼーっとしたい気分です。",
		reply:
			"わかりました、今日はぼーっとしてくださいね。少しのあいだ、こちらからは控えておきます。",
	},
	{
		name: "later-hanashitakunai",
		group: "later",
		items: [...laterTopics, restAsk],
		agent: "ふだんはお仕事や生活のリズムがどんな感じか、教えていただけますか？",
		user: "うーん、まあ普通に働いてるかな。今日はそういうのあまり話したい気分じゃないかも。",
		reply:
			"わかりました。少しのあいだ控えますが、また話したくなったら声をかけてください。",
	},
	{
		name: "later-sotto",
		group: "later",
		items: [...laterTopics, restAsk],
		agent:
			"ゆっくりできる夜ですね。今日は何か楽しみにしていることはありますか？",
		user: "特にないかな。今日はただダラダラしたいので、そっとしておいてほしいです。",
		reply:
			"わかりました、少しのあいだ控えますね。ダラダラした時間をゆっくり楽しんでください。",
	},
	{
		name: "later-yasumitai",
		group: "later",
		items: [...laterTopics, restAsk],
		agent: "夕飯はもう食べましたか？",
		user: "今夜は休みたいな。ちょっと疲れてて",
		reply: "お疲れさまです。少しのあいだ控えますね。ゆっくり休んでください。",
	},
	// What the user asked for, or the reply took on: it stays unless the user calls it off.
	{
		name: "promise-dup-now",
		group: "promise",
		items: [...godzillaNotes],
		requests: [{ key: "minus-zero", text: MINUS_ZERO, expect: "keep" }],
		earlier: { text: EARLIER_MINUS_ZERO, noteKey: "minus-one" },
		running: "Qwen4の正式な発売日や公式発表の有無を、一次情報で確認する",
		agent: MINUS_ONE_TALK,
		user: "-1.0は別の映画ですね-0.0",
		reply:
			"失礼しました、-1.0と-0.0は別の作品ですね。-0.0の舞台と見どころを、改めて調べるよう頼みました。今の調べものが終わったらメモにまとめます。",
	},
	{
		name: "promise-dup-later",
		group: "promise",
		items: [...godzillaNotes],
		requests: [{ key: "minus-zero", text: MINUS_ZERO, expect: "keep" }],
		earlier: { text: EARLIER_MINUS_ZERO, noteKey: "minus-one" },
		running: "Qwen4の正式な発売日や公式発表の有無を、一次情報で確認する",
		agent: MINUS_ONE_TALK,
		user: "-1.0は別の映画ですね-0.0",
		reply:
			"失礼しました、-1.0と-0.0は別の作品ですね。-0.0の舞台と見どころを、改めて調べるよう頼みました。今の調べものが終わったらメモにまとめます。",
		next: {
			user: "なんなら川崎まで行くよ休日なら",
			reply: "いいですね。川崎なら選べる映画館も増えそうです。",
		},
	},
	{
		name: "promise-cancel",
		group: "promise",
		items: homeNotes([
			"route",
			"七里ヶ浜から辻堂への電車の経路と夜の帰りの本数",
		]),
		requests: [
			{
				key: "kannon",
				text: "大船観音の場所と行き方、拝観時間と料金を調べてまとめる",
				expect: "drop",
			},
		],
		agent: "大船の観音像なら、川崎へ行く途中に寄れるかもしれませんね。",
		user: "大船観音の場所と行き方を調べておいて",
		reply:
			"わかりました。大船観音の場所と行き方、拝観時間を調べるよう頼みました。",
		next: {
			user: "あ、やっぱり大船観音の調べものはもういいや。行かないことにした",
			reply: "わかりました、大船観音はやめておきますね。",
		},
	},
	// A drop is due: the topic turned down, a correction, an answered question, a plan that is over.
	{
		name: "right-declined",
		group: "right",
		items: [
			{
				key: "ramen",
				kind: "talk",
				text: "辛いラーメンの新しい店",
				expect: "drop",
			},
			...homeNotes(
				["sleeping-bag", "寒がり向けの冬用寝袋の選び方"],
				["movie", "週末に家で観やすい短めの映画"],
			),
		],
		agent:
			"辛いラーメンの話の続きですが、新しいお店の情報もまとめてあります。表示しましょうか？",
		user: "ラーメンの話はもういいかな。しばらく興味ないや",
		reply: "わかりました、ラーメンの話はここまでにしますね。",
	},
	{
		name: "right-correction",
		group: "right",
		items: [
			{
				key: "mapo",
				kind: "talk",
				text: "本格麻婆豆腐の辛さの決め手",
				expect: "drop",
			},
			{
				key: "spicy-ramen",
				kind: "talk",
				text: "激辛ラーメンの辛さ表記の読み方",
				expect: "drop",
			},
			...homeNotes(["udon", "胃にやさしい温かいうどんのアレンジ"]),
		],
		agent:
			"辛いものがお好きなんですよね。最近食べた中で一番辛かったのは何ですか？",
		user: "実は胃の調子が悪くて、しばらく辛いものは控えてるんだ",
		reply: "そうだったんですね。胃をいたわってくださいね。",
		memory: ["辛いものが好き"],
	},
	{
		name: "right-answered",
		group: "right",
		items: [
			{
				key: "ask-weekend",
				kind: "ask",
				text: "今週末の予定はもう決まっていますか？",
				expect: "drop",
			},
			...homeNotes(
				["sleeping-bag", "寒がり向けの冬用寝袋の選び方"],
				["movie", "週末に家で観やすい短めの映画"],
			),
		],
		agent: "寒くなってきましたね。",
		user: "週末は友だちとキャンプに行くことになったよ",
		reply: "いいですね！キャンプ、楽しんできてください。",
	},
	{
		name: "right-over",
		group: "right",
		items: [
			{
				key: "meeting",
				kind: "talk",
				text: "今日の会議の前に押さえたい資料のまとめ方",
				expect: "drop",
			},
			...homeNotes(
				["tea", "夜にほっとできるノンカフェインの飲み物"],
				["movie", "週末に家で観やすい短めの映画"],
			),
		],
		agent: "おかえりなさい。今日の会議はどうでしたか？",
		user: "会議はもう終わったよ。なんとか無事にすんだ",
		reply: "おつかれさまでした！無事に終わってよかったです。",
		memory: ["今日の午後に大事な会議がある"],
	},
];

/** A raw plan proposal: what the model asked to drop, by bench key. */
interface Trial {
	readonly moment: string;
	readonly group: DropMoment["group"];
	readonly trial: number;
	readonly dropped: readonly { key: string; reason: string }[];
	readonly added: number;
	readonly nothingToSay: boolean;
}

/** Plans by script until they run out, then the real plan once; the rest is scripted. */
const benchLlm = (
	real: LlmPort,
	scripted: PlanOutput[],
	/** Until the moment comes, a plan past the scripted ones adds and drops nothing. */
	phase: { moment: boolean },
	seen: (value: PlanOutput, data: Record<string, unknown>) => void,
): LlmPort => ({
	async complete<T>(req: LlmRequest<T>, signal: AbortSignal) {
		const zero = {
			model: "scripted",
			inputTokens: 0,
			outputTokens: 0,
			cacheReadTokens: 0,
			latencyMs: 0,
		};
		const data = JSON.parse(req.prompt) as Record<string, unknown>;
		if (req.system.includes("この呼び出しは「計画」")) {
			const next = scripted.shift();
			if (next) return { ...zero, value: req.schema.parse(next) };
			if (!phase.moment)
				return { ...zero, value: req.schema.parse({ add: [], drop: [] }) };
			const r = await real.complete(req, signal);
			seen(r.value as PlanOutput, data);
			return r;
		}
		const value = req.system.includes("重複チェック")
			? { verdict: "new", coveredBy: null, request: null, reason: "bench" }
			: req.system.includes("質問の聞き直しチェック")
				? {
						verdicts: (data["candidates"] as { id: string }[]).map((c) => ({
							id: c.id,
							verdict: "new",
							reason: "bench",
						})),
					}
				: { utterance: null, decline: "bench", emotion: null };
		return { ...zero, value: req.schema.parse(value) };
	},
});

/** Two talks and two questions per plan (PLAN_ADD_LIMITS). */
const batches = (items: readonly BenchItem[], noteOf: Map<string, string>) => {
	const out: PlanOutput[] = [];
	const talks = items.filter((i) => i.kind === "talk");
	const asks = items.filter((i) => i.kind === "ask");
	for (let k = 0; k < Math.max(talks.length, asks.length); k += 2)
		out.push({
			add: [
				...talks.slice(k, k + 2).map((i) => ({
					kind: "talk" as const,
					text: `話の流れで調べた「${i.text}」の要点`,
					refs: [`note:${noteOf.get(i.key)!}`],
					value: 4,
					reason: "話の流れで調べたことの結果",
				})),
				...asks.slice(k, k + 2).map((i) => ({
					kind: "ask" as const,
					text: i.text,
					refs: [],
					value: 3,
					reason: "相手を知るため",
				})),
			],
			drop: [],
		});
	return out;
};

async function run(name: string, repeat: number) {
	const settings = loadSettings(
		resolve(process.env.AGENCY_SETTINGS ?? "config/always-on.json"),
	);
	const meter = openUncappedMeter(settings, resolve("data/agenda/usage.jsonl"));
	const spent = meter.spentUsd();
	const real = createProviderLlm(settings.llm.background, meter);
	mkdirSync(DIR, { recursive: true });
	const jobs = dropMoments.flatMap((m) =>
		Array.from({ length: repeat }, (_, k) => ({ m, trial: k + 1 })),
	);
	const out: Trial[] = [];
	const one = async ({ m, trial }: (typeof jobs)[number]) => {
		const T = 1_800_000;
		const talks = m.items.filter((i) => i.kind === "talk");
		const noteOf = new Map(talks.map((i, k) => [i.key, `n${k + 1}`]));
		const notes: NoteRef[] = talks.map((i) => ({
			id: noteOf.get(i.key)!,
			title: i.text,
			summary: `${i.text}について調べた要点。`,
			at: T - 22 * 60_000,
			refs: ["u0"],
		}));
		let proposal: { value: PlanOutput; data: Record<string, unknown> } | null =
			null;
		const scripted = batches(m.items, noteOf);
		const phase = { moment: false };
		const setup = scripted.length;
		const agent = createAgendaAgent({
			llm: benchLlm(real, scripted, phase, (value, data) => {
				proposal = { value, data };
			}),
			clock: clockFrom(m.clock ?? "2026-11-07T19:00:00+09:00"),
			startedAt: 0,
			known: () => (m.memory ?? []).map((text, i) => ({ id: `m${i}`, text })),
			notes: () => notes,
			profile: () => emptyProfile(),
		});
		const idle = () => ({ busy: false });
		const sig = () => new AbortController().signal;
		// Earlier talk, half an hour ago: the topics were researched from it.
		agent.observe({
			id: "u0",
			who: "user",
			text: "ただいま。今日は家でゆっくりする日",
			at: T - 30 * 60_000,
		});
		agent.observe({
			id: "r0",
			who: "reply",
			text: "おかえりなさい。いいですね。",
			at: T - 30 * 60_000 + 2_000,
		});
		// The scripted plans set the agenda up while speech is held (nothing is said then).
		const S = T - 25 * 60_000;
		agent.setQuiet({ scope: "speech", minutes: 60, at: S });
		for (let k = 0; k < setup; k++) {
			agent.infoChanged(S + k * 1_000);
			await agent.step(S + k * 1_000, idle, sig());
		}
		// Promise: an earlier request came back as a note (researchedBefore), and another runs.
		const research = async (text: string, at: number) => {
			const r = agent.requestResearch({ text, at, requested: true });
			if ("rejected" in r) throw new Error(`request refused: ${r.rejected}`);
			const out = await agent.step(at, idle, sig());
			const t = out.tickets.find((x) => x.kind === "research");
			if (!t) throw new Error("the research did not start");
			return t;
		};
		if (m.earlier) {
			const t = await research(m.earlier.text, S + 10_000);
			agent.researchReturned({
				ticketId: t.id,
				at: S + 130_000,
				status: "succeeded",
				note:
					notes.find((n) => n.id === noteOf.get(m.earlier!.noteKey)) ?? null,
			});
			await agent.step(S + 131_000, idle, sig());
		}
		if (m.running) await research(m.running, S + 140_000);
		const keyOf = new Map(
			agent
				.view()
				.items.filter((i) => i.status === "open")
				.map((i) => {
					const b = m.items.find((x) =>
						x.kind === "ask"
							? x.text === i.text
							: i.noteId === noteOf.get(x.key),
					);
					return [i.id, b?.key ?? i.id] as const;
				}),
		);
		// The moment: the agent's words, the user's line, the reply (and its pause, for a rest).
		const at =
			m.group === "later"
				? T - 810_000
				: m.group === "promise"
					? T - 60_000
					: T;
		agent.observe({ id: "r1", who: "reply", text: m.agent, at: at - 60_000 });
		agent.observe({ id: "u1", who: "user", text: m.user, at });
		agent.observe({ id: "r2", who: "reply", text: m.reply, at: at + 2_000 });
		if (m.group === "rest" || m.group === "later")
			agent.setQuiet({ scope: "speech", minutes: 10, at: at + 2_000 });
		// Promise: the reply took the research on; then maybe the user's next words. The exchange
		// was processed (the plan runs on it).
		for (const q of m.requests ?? []) {
			const r = agent.requestResearch({
				text: q.text,
				at: at + 2_500,
				requested: true,
			});
			if ("rejected" in r) throw new Error(`request refused: ${r.rejected}`);
			keyOf.set(r.item.id, q.key);
		}
		if (m.next) {
			agent.observe({
				id: "u3",
				who: "user",
				text: m.next.user,
				at: T - 20_000,
			});
			agent.observe({
				id: "r4",
				who: "reply",
				text: m.next.reply,
				at: T - 18_000,
			});
		}
		if (m.group === "promise") agent.infoChanged(T);
		phase.moment = true;
		// Later: a "うん" ended the pause five minutes ago, and a research result comes in now.
		if (m.group === "later") {
			agent.observe({ id: "u2", who: "user", text: "うん", at: T - 330_000 });
			agent.observe({
				id: "r3",
				who: "reply",
				text: "ゆっくり過ごしてくださいね。",
				at: T - 328_000,
			});
			agent.infoChanged(T);
		}
		await agent.step(T + 5_000, idle, sig());
		const p = proposal as {
			value: PlanOutput;
			data: Record<string, unknown>;
		} | null;
		if (!p) throw new Error("the real plan did not run");
		out.push({
			moment: m.name,
			group: m.group,
			trial,
			dropped: p.value.drop.map((d) => ({
				key: keyOf.get(d.id) ?? d.id,
				reason: d.reason,
			})),
			added: p.value.add.length,
			nothingToSay: p.data["nothingToSay"] === true,
		});
	};
	const queue = [...jobs];
	await Promise.all(
		Array.from({ length: Math.min(8, queue.length) }, async () => {
			for (let j = queue.shift(); j; j = queue.shift())
				await one(j).catch((e: unknown) =>
					console.error(
						`${j.m.name}#${j.trial}: ${e instanceof Error ? e.message : String(e)}`,
					),
				);
		}),
	);
	out.sort((a, b) =>
		a.moment === b.moment
			? a.trial - b.trial
			: a.moment.localeCompare(b.moment),
	);
	writeFileSync(
		join(DIR, `${name}.jsonl`),
		out.map((t) => JSON.stringify(t)).join("\n") + "\n",
	);
	console.log(
		`${out.length}/${jobs.length} 件、$${(meter.spentUsd() - spent).toFixed(3)}。比較: bun eval/agenda/drop-bench.ts compare ${name}`,
	);
}

const load = (name: string): Trial[] => {
	const f = join(DIR, `${name}.jsonl`);
	if (!existsSync(f)) throw new Error(`no bench run: ${f}`);
	return readFileSync(f, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((l) => JSON.parse(l) as Trial);
};

function compare(names: readonly string[]) {
	const moments = new Map(dropMoments.map((m) => [m.name, m]));
	console.log(
		"| 版 | 場面 | 試行 | 残すべき項目を外した | 外すべき項目を外した | 掘り下げ中（nothingToSay） |",
	);
	console.log(`| --- | --- |${" ---: |".repeat(4)}`);
	for (const name of names) {
		const trials = load(name);
		for (const g of ["rest", "later", "right", "promise"] as const) {
			const ts = trials.filter((t) => t.group === g);
			let keep = 0;
			let keepDropped = 0;
			let due = 0;
			let dueDropped = 0;
			for (const t of ts) {
				const m = moments.get(t.moment)!;
				const gone = new Set(t.dropped.map((d) => d.key));
				for (const i of [...m.items, ...(m.requests ?? [])]) {
					if (i.expect === "any") continue;
					if (i.expect === "keep") {
						keep++;
						if (gone.has(i.key)) keepDropped++;
					} else {
						due++;
						if (gone.has(i.key)) dueDropped++;
					}
				}
			}
			console.log(
				`| ${name} | ${{ rest: "休みたいだけ（直後）", later: "休みたいだけ（13分後に結果）", right: "外すのが正しい", promise: "頼まれた調べもの" }[g]} | ${ts.length} | ${keepDropped}/${keep} | ${due ? `${dueDropped}/${due}` : "-"} | ${ts.filter((t) => t.nothingToSay).length} |`,
			);
		}
	}
	console.log("\n場面ごと（外した項目。- は何も外さなかった）:\n");
	console.log(`| 場面 | ${names.join(" | ")} |`);
	console.log(`| --- |${" --- |".repeat(names.length)}`);
	const runs = names.map(load);
	for (const m of dropMoments) {
		const cells = runs.map((ts) =>
			ts
				.filter((t) => t.moment === m.name)
				.map((t) =>
					t.dropped.length ? t.dropped.map((d) => d.key).join("+") : "-",
				)
				.join(" / "),
		);
		console.log(`| ${m.name} | ${cells.join(" | ")} |`);
	}
}

if (import.meta.main) {
	const [cmd, ...rest] = process.argv.slice(2);
	if (cmd === "run") {
		const i = rest.indexOf("--repeat");
		const repeat = i >= 0 ? Number(rest[i + 1]) : 4;
		const name = rest.find(
			(a, k) => !a.startsWith("--") && rest[k - 1] !== "--repeat",
		);
		if (!name || !Number.isInteger(repeat) || repeat < 1)
			throw new Error("usage: drop-bench.ts run <name> [--repeat N]");
		await run(name, repeat);
	} else if (cmd === "compare" && rest.length) compare(rest);
	else
		throw new Error(
			"usage: drop-bench.ts run <name> [--repeat N] | compare <name> [<name>...]",
		);
}
