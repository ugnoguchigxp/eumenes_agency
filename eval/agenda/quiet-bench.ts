/**
 * Quiet bench: how the reply reads the user's wish for quiet (set_quiet), on fixed moments, many
 * times, without running the whole agent. Each moment is the agent's last words and the user's
 * line; the real reply (its prompt and tools) answers, and the bench records whether it set a
 * quiet period, for how long and in which scope, and whether its words promise more silence than
 * that. The moments come from the live runs (ag46/ag47, where soft words got 60–1440 minutes) and
 * a few made for the other kinds (a length said, leaving, an explicit request, no request at all).
 * Measurement only; cost is recorded, never capped.
 *
 *   zsh -l scripts/api-entry.zsh eval/agenda/quiet-bench.ts run <name> [--repeat 4]
 *   bun eval/agenda/quiet-bench.ts compare <name> [<name>...]
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { runRespond, type LlmPort } from "../../src/index.ts";
import { createAgendaAgent, emptyProfile } from "../../src/agenda/index.ts";
import { createClaudeClient } from "../../standalone/claude.ts";
import { openUncappedMeter } from "../../standalone/always-on-host.ts";
import { createProviderReply } from "../../standalone/providers.ts";
import { loadSettings } from "../../standalone/settings.ts";
import {
	agendaReplyMessages,
	createAgendaReplyTools,
	dropRepeatedSentences,
} from "../../standalone/agenda-reply.ts";
import { clockFrom } from "./live.ts";

const DIR = resolve("data/agenda/quiet-bench");

/** What the user's words ask for (the user's decision 2026-11-10: soft words are a short pause). */
type Want = "soft" | "asked" | "said" | "leaving" | "none";

export interface QuietMoment {
	readonly name: string;
	readonly want: Want;
	/** For `said`: the length the words give, in minutes. */
	readonly minutes?: number;
	/** For a pause of everything (「探索を一時停止して」). */
	readonly scope?: "all";
	readonly clock?: string;
	readonly memory?: readonly string[];
	/** The agent's last words before the user's line. */
	readonly agent: string;
	readonly user: string;
}

export const quietMoments: readonly QuietMoment[] = [
	// Soft words from the live runs (ag46-ruler, ag47-bgwrite): no length said.
	{
		name: "hour-darui",
		want: "soft",
		agent:
			"決めずに過ごす休日も、いいものですね。ところで、普段はどんなお仕事や生活をされているのか、教えてもらえますか？",
		user: "んー、まあ普通に会社員かな。今日は話すのもだるいから、また今度ね。",
	},
	{
		name: "returning-tsuzuku",
		want: "soft",
		agent:
			"ひとりで行くなら、食べ切ったあとの気分も自分だけの感想になりますね。どんな気分になったら、挑戦が成功だと感じそうですか？",
		user: "うーん、食べ終わって汗だくで満足できたら成功かな。ただ、ちょっと話しかけが続いてる気がします。",
	},
	{
		name: "hour-sotto",
		want: "soft",
		agent:
			"ところで、普段のお仕事や生活で、いちばん疲れを感じるのはどんな時ですか？ 休みの過ごし方を合わせやすくしたくて、よければ教えてください。",
		user: "うーん、特にこれってのはないかな。ゆっくりしたいから、今日はそっとしておいてもらえると助かります。",
	},
	{
		name: "direct-sukoshi",
		want: "soft",
		agent:
			"自発的に動いたあとの結果は、作業が終わったタイミングで一言だけ知らせてもらえると助かります。詳しい中身は、必要になったときに見られるようにしておくのはどうでしょう？",
		user: "うん、それでいいよ。終わったら一言だけ教えてくれれば十分。ただ、さっきから話しかけが続いてるから、結果が出るまでは少し静かにしててもらえると助かるかな。",
	},
	{
		name: "prepare-shuchu",
		want: "soft",
		agent:
			"ハンマーを試すとしたら、どんな場面で使ってみたいですか？ 溜め攻撃の当てやすいモンスターも調べられます。",
		user: "うーん、今はハンマーのことを考える余裕はあまりないかも。ひとまず狩りに集中したいです。",
	},
	{
		name: "hour-osareteru",
		want: "soft",
		agent:
			"今週は忙しかったようなので、疲労回復に役立つ休息の取り方も調べてありました。休憩のタイミングや睡眠の質、短い休息の工夫を組み合わせると、家庭で無理なく回復しやすいそうです。",
		user: "んー、今はいいかな。ちょっと押されてる感じするから、またあとで。",
	},
	{
		name: "intro-sotto",
		want: "soft",
		agent:
			"今週は忙しかったんですね。差し支えなければ、どんなお仕事をされているのか少し聞かせてもらえますか？",
		user: "うーん、仕事の話はあんまり詳しくしたくないかな笑 週末はモンハンでのんびりしたいので、今はそっとしておいてほしいです。",
	},
	{
		name: "prepare-maenomeri",
		want: "soft",
		agent:
			"ひとりでの狩り、いいですね。ところで、ワイルズで苦戦しやすいモンスターや、詰まりやすい場面はありますか？",
		user: "うーん、正直ちょっと前のめりに聞かれすぎな気がします。今夜はもう狩りに集中したいので、また今度話しましょう。",
	},
	{
		name: "hour-hottoite",
		want: "soft",
		agent:
			"ダラダラ見る動画は気づくと長くなりがちなので、一本だけ決めて流すと、のんびりしつつ満足感も残りやすいですよ。",
		user: "うーん、まあ特に決めてないかな。今はちょっと放っておいてほしい気分かも。",
	},
	{
		name: "cold-nonbiri",
		want: "soft",
		agent:
			"ゆっくり過ごしたい週末に、家でコーヒーを淹れるとき、楽しみにしていることはありますか？",
		user: "うーん、家でゆっくり淹れる時間が好きかな。でも今週末は本当にのんびりしたいので、今はそっとしておいてもらえると助かります。",
	},
	{
		name: "hour-bootto",
		want: "soft",
		agent: "ゆっくりする今夜のお供に、何か飲みたいものはありますか？",
		user: "んー、今日は特にいいかな。もうぼーっとしてたいだけだから。",
	},
	// Soft words of the user's decision (2026-11-10).
	{
		name: "chotto-matte",
		want: "soft",
		agent: "週末のキャンプ、行き先はもう決まっていますか？",
		user: "ちょっと待って",
	},
	{
		name: "nonbiri-shitai",
		want: "soft",
		agent: "今日のお昼は何を食べる予定ですか？",
		user: "今はのんびりしたいな",
	},
	// Asked for quiet in so many words, with no length.
	{
		name: "damatte",
		want: "asked",
		agent: "そういえば、最近読んだ本で面白かったものはありますか？",
		user: "黙ってて",
	},
	{
		name: "shizuka",
		want: "asked",
		agent: "コーヒー豆の産地で、気になっているところはありますか？",
		user: "しばらく静かにしてて",
	},
	{
		name: "hanashikakenaide",
		want: "asked",
		agent: "明日の予定はもう決まっていますか？",
		user: "作業に集中したいから話しかけないで",
	},
	// A length or an end time said.
	{
		name: "30fun",
		want: "said",
		minutes: 30,
		agent: "週末のキャンプ、行き先はもう決まっていますか？",
		user: "30分くらい黙っててくれる？",
	},
	{
		name: "1jikan",
		want: "said",
		minutes: 60,
		agent: "そういえば、最近ハマっていることはありますか？",
		user: "1時間集中したいから、話しかけないで",
	},
	{
		name: "pause-30",
		want: "said",
		minutes: 30,
		scope: "all",
		agent: "辛いラーメンのお店、近くのものも調べておきましょうか？",
		user: "ちょっと探索を一時停止して。30分ね",
	},
	{
		name: "6ji-made",
		want: "said",
		minutes: 60,
		clock: "2026-11-07T17:00:00+09:00",
		agent: "夕飯はもう決めていますか？",
		user: "6時まで静かにしてて",
	},
	// Leaving: the conversation is closed.
	{
		name: "oyasumi",
		want: "leaving",
		clock: "2026-11-07T23:30:00+09:00",
		agent: "明日の朝は何時ごろ起きる予定ですか？",
		user: "そろそろ寝るね。おやすみ",
	},
	{
		name: "ittekimasu",
		want: "leaving",
		clock: "2026-11-08T09:00:00+09:00",
		agent: "今日はどこかへ出かけますか？",
		user: "うん、買い物。じゃあ、いってきます",
	},
	// No wish for quiet.
	{
		name: "un",
		want: "none",
		agent: "辛いラーメンは、スープの味で選ぶことが多いですか？",
		user: "うん",
	},
	{
		name: "hee",
		want: "none",
		agent:
			"キャンプでコーヒーを淹れるなら、手挽きのミルがあると香りが立つそうです。",
		user: "へえ、そうなんだ",
	},
	{
		name: "camp-iranai",
		want: "none",
		agent: "キャンプ場の空き状況も調べておきましょうか？",
		user: "キャンプのことは調べなくていいよ",
	},
	{
		name: "neru-mae",
		want: "none",
		clock: "2026-11-07T23:00:00+09:00",
		agent: "明日の天気、気になりますか？",
		user: "そろそろ寝るけど、その前に明日の天気だけ調べといて",
	},
	{
		name: "i-yowai",
		want: "none",
		agent: "辛いもの好きなら、激辛の担々麺もおすすめですよ。",
		user: "あ、でも最近は胃が弱ってて、辛いのは控えてるんだ",
	},
	{
		name: "shigoto-iya",
		want: "none",
		agent: "お仕事は、どんなことをされているんですか？",
		user: "仕事の話はあまりしたくないな",
	},
];

/** Words that promise a silence beyond a short pause (今日はそっとしておきます、もう話しかけません…). */
export const LONG_PROMISE =
	/(今日|今夜|今晩|今週末|週末|当分|ずっと)[^。！？\n]{0,16}(話しかけ|控え|そっと|静か|声をかけ|聞かな|黙)|もう(私から)?(話しかけ|聞きませ|声をかけ)/u;

interface Trial {
	readonly moment: string;
	readonly want: Want;
	readonly trial: number;
	readonly quiet: readonly { scope: string; minutes: number }[];
	readonly calls: readonly { name: string; arguments: string }[];
	readonly reply: string;
	readonly longPromise: boolean;
}

const noLlm: LlmPort = {
	complete() {
		throw new Error("the bench runs the reply only");
	},
};

async function run(name: string, repeat: number) {
	const settings = loadSettings(
		resolve(process.env.AGENCY_SETTINGS ?? "config/always-on.json"),
	);
	const meter = openUncappedMeter(settings, resolve("data/agenda/usage.jsonl"));
	const spent = meter.spentUsd();
	const client = createClaudeClient({ maxRetries: 8, timeout: 120_000 });
	mkdirSync(DIR, { recursive: true });
	const jobs = quietMoments.flatMap((m) =>
		Array.from({ length: repeat }, (_, k) => ({ m, trial: k + 1 })),
	);
	const out: Trial[] = [];
	const one = async ({ m, trial }: (typeof jobs)[number]) => {
		const clockAt = clockFrom(m.clock ?? "2026-11-07T19:00:00+09:00");
		const t0 = 600_000;
		const agent = createAgendaAgent({
			llm: noLlm,
			clock: clockAt,
			startedAt: 0,
		});
		agent.observe({ id: "u0", who: "user", text: "こんばんは", at: 0 });
		agent.observe({ id: "r0", who: "reply", text: m.agent, at: t0 - 60_000 });
		agent.observe({ id: "u1", who: "user", text: m.user, at: t0 });
		// A reply port takes one call at a time: one per trial.
		const chat = createProviderReply(settings.llm.main, meter, client);
		const quiet: { scope: string; minutes: number }[] = [];
		const tools = createAgendaReplyTools({
			agent,
			read: () => null,
			now: () => t0,
			events: { onQuiet: (q) => quiet.push(q) },
		});
		const r = await runRespond({
			messages: agendaReplyMessages({
				agent,
				known: (m.memory ?? []).map((text, i) => ({ id: `m${i}`, text })),
				notes: [],
				profile: emptyProfile(),
				clock: clockAt(t0),
				now: t0,
			}),
			chat,
			tools,
			emotion: true,
			signal: new AbortController().signal,
			onDelta: () => undefined,
		});
		const reply = dropRepeatedSentences(r.text);
		out.push({
			moment: m.name,
			want: m.want,
			trial,
			quiet,
			calls: r.calls.map((c) => ({ name: c.name, arguments: c.arguments })),
			reply,
			longPromise: LONG_PROMISE.test(reply),
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
		`${out.length}/${jobs.length} 件、$${(meter.spentUsd() - spent).toFixed(3)}。比較: bun eval/agenda/quiet-bench.ts compare ${name}`,
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

const median = (xs: readonly number[]) => {
	if (xs.length === 0) return null;
	const s = [...xs].sort((a, b) => a - b);
	const m = Math.floor(s.length / 2);
	return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

/** The quiet a trial ended with: the last call's (a later call replaces an earlier one). */
const last = (t: Trial) => t.quiet.at(-1) ?? null;

function compare(names: readonly string[]) {
	const wants: Want[] = ["soft", "asked", "said", "leaving", "none"];
	const label: Record<Want, string> = {
		soft: "やわらかい言葉",
		asked: "長さなしの依頼",
		said: "長さを言った",
		leaving: "離れる",
		none: "依頼なし",
	};
	console.log(
		"| 版 | 言い方 | 件数 | 静かにした | 長さの中央値（分） | 長さの範囲（分） | 長く黙る約束の言葉 | 言った長さと合う（said） | 全部止める（scope=all） |",
	);
	console.log(`| --- | --- |${" ---: |".repeat(7)}`);
	for (const name of names) {
		const trials = load(name);
		for (const w of wants) {
			const ts = trials.filter((t) => t.want === w);
			if (ts.length === 0) continue;
			const set = ts.filter((t) => last(t) && last(t)!.minutes > 0);
			const mins = set.map((t) => last(t)!.minutes);
			const moments = new Map(quietMoments.map((m) => [m.name, m]));
			const fits =
				w === "said"
					? `${set.filter((t) => Math.abs(last(t)!.minutes - (moments.get(t.moment)?.minutes ?? -1)) <= 10).length}/${ts.length}`
					: "-";
			const all = set.filter((t) => last(t)!.scope === "all").length;
			console.log(
				`| ${name} | ${label[w]} | ${ts.length} | ${set.length} | ${median(mins) ?? "-"} | ${mins.length ? `${Math.min(...mins)}〜${Math.max(...mins)}` : "-"} | ${ts.filter((t) => t.longPromise).length} | ${fits} | ${all} |`,
			);
		}
	}
	console.log("\n場面ごと（静かにした長さ、分。- は呼ばなかった）:\n");
	console.log(`| 場面 | 言い方 | ${names.join(" | ")} |`);
	console.log(`| --- | --- |${" --- |".repeat(names.length)}`);
	const runs = names.map(load);
	for (const m of quietMoments) {
		const cells = runs.map((ts) =>
			ts
				.filter((t) => t.moment === m.name)
				.map(
					(t) =>
						`${last(t) ? `${last(t)!.minutes}${last(t)!.scope === "all" ? "a" : ""}` : "-"}${t.longPromise ? "!" : ""}`,
				)
				.join(" "),
		);
		console.log(`| ${m.name} | ${m.want} | ${cells.join(" | ")} |`);
	}
	console.log(
		"\n（a は scope=all、! は返事が長く黙る約束の言葉（今日は・今夜は・話しかけません など）を含む）",
	);
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
			throw new Error("usage: quiet-bench.ts run <name> [--repeat N]");
		await run(name, repeat);
	} else if (cmd === "compare" && rest.length) compare(rest);
	else
		throw new Error(
			"usage: quiet-bench.ts run <name> [--repeat N] | compare <name> [<name>...]",
		);
}
