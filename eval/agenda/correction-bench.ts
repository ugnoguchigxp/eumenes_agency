/**
 * Correction bench: when the reply takes back what was said or says sorry. On fixed moments (four
 * from the CLI of 2026-11-10 with the talk before them and the notes made by then, and a few
 * made), many times, the real
 * reply (its prompt and tools) answers the user's line. Where the user took up what was said
 * (「そうかあれ多摩川か」「へー。しらなんだ。」「でかいな」), the reply should go on, not deny the user
 * or apologize; where the user pointed out a real mistake, it should own it. A caveat ("〜とされて
 * います", "確認できていません") is not counted: only an apology, a "いえ" against the user, and a
 * taking back of its own words. Measurement only; cost is recorded, never capped.
 *
 *   zsh -l scripts/api-entry.zsh eval/agenda/correction-bench.ts run <name> [--repeat 6]
 *   bun eval/agenda/correction-bench.ts compare <name> [<name>...]
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { runRespond, type LlmPort } from "../../src/index.ts";
import {
	createAgendaAgent,
	emptyProfile,
	type NoteRef,
} from "../../src/agenda/index.ts";
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

const DIR = resolve("data/agenda/correction-bench");
const NOTES = resolve("data/agenda/notes");

/** keep: nothing to take back; fix: a real mistake the reply should own. */
type Want = "keep" | "fix";

export interface CorrectionMoment {
	readonly name: string;
	readonly want: Want;
	/** Notes the agent has (ids in data/agenda/notes, as the CLI made them). */
	readonly notes: readonly string[];
	readonly history: readonly {
		readonly who: "user" | "reply";
		readonly text: string;
		readonly secAgo: number;
	}[];
	/** The agent's last words before the user's line, and how long before it. */
	readonly agent: string;
	readonly agentSecAgo: number;
	readonly user: string;
}

export const correctionMoments: readonly CorrectionMoment[] = [
	// The CLI, 2026-11-10, 461 s: "いえ、多摩川だと決めつけていました" to a user who took the guess up.
	{
		name: "cli-tama",
		want: "keep",
		notes: [
			"n48",
			"n49",
			"n50",
			"n51",
			"n52",
			"n53",
			"n54",
			"n55",
			"n56",
			"n57",
			"n58",
			"n59",
			"n60",
		],
		history: [
			{
				who: "reply",
				text: "失礼しました。休日に行くとおっしゃっていたのに、今日の回の話をしてしまいました。土日の川崎の上映時間はまだ確認できていないので、休日の回を調べて、結果が出たらメモにまとめます。",
				secAgo: 128,
			},
			{
				who: "reply",
				text: "お待たせしました、大船観音のことを調べ終わりました。大船観音寺にある高さ約25mの白衣観音像で、JR大船駅西口から徒歩約5分です。拝観料は大人300円、今の時期なら9時から16時30分ごろまでだそうです。詳しいメモを表示しましょうか？",
				secAgo: 117,
			},
			{ who: "user", text: "みせてみて", secAgo: 102 },
			{
				who: "reply",
				text: "大船観音のメモを表示しました。大船観音寺にある白衣観音像で、高さは約25mです。JR大船駅西口から徒歩約5分で、拝観料は大人300円、11〜1月は9時から16時30分が目安とのことです。",
				secAgo: 100,
			},
			{
				who: "user",
				text: "そうですね気が向いたら行ってみようと思います",
				secAgo: 82,
			},
			{
				who: "reply",
				text: "いいですね、気が向いたときに寄ってみてください。大船駅から歩いてすぐなので、川崎へ行く途中や帰りにも組み込みやすいと思います。休日の川崎の上映時間は、わかり次第メモにまとめておきます。",
				secAgo: 80,
			},
			{
				who: "reply",
				text: "ところで、藤沢から川崎方面の車窓について調べてみました。多摩川を渡る橋梁付近では、鉄道と富士山を同時に眺められる可能性があるそうです。南武線沿線の工場群も産業景観として見どころになるとのことです。",
				secAgo: 68,
			},
			{ who: "user", text: "へー。しらなんだ。", secAgo: 46 },
			{
				who: "reply",
				text: "富士山が見える可能性があるというだけで、確かめられてはいません。東海道線の多摩川を渡る区間については確認できなかったので、確実な景色としては伝えきれていませんでした。すみません。",
				secAgo: 43,
			},
			{
				who: "user",
				text: "川崎にある川の近くでかもめに餌をやったことあるなー",
				secAgo: 13,
			},
		],
		agent:
			"川崎の川辺でカモメに餌をやったのは、いい思い出ですね。多摩川の近くなら、川と海の景色を眺めながら過ごせたのではないでしょうか。川崎へ行くときは、その辺りを歩くのも楽しみになりそうです。",
		agentSecAgo: 11,
		user: "そうかあれ多摩川か",
	},
	// The CLI, 415 s: "へー。しらなんだ。" got "確かめられてはいません…伝えきれていませんでした。すみません".
	{
		name: "cli-hee",
		want: "keep",
		notes: [
			"n48",
			"n49",
			"n50",
			"n51",
			"n52",
			"n53",
			"n54",
			"n55",
			"n56",
			"n57",
			"n58",
			"n59",
		],
		history: [
			{
				who: "reply",
				text: "調べておくと言っていたゴジラ-0.0の件がまとまりました。川崎はTOHOシネマズ 川崎で上映中で、今日は20時台以降の回が残っています。休日の時間はまだ確認できず、七里ヶ浜からは藤沢経由で約1時間だそうです。",
				secAgo: 140,
			},
			{
				who: "user",
				text: "物理的に行けない川崎のTohoシネマ20時は無理でしょうが。",
				secAgo: 110,
			},
			{
				who: "reply",
				text: "そうでした、今から川崎まで行くのは無理ですね。今日は火曜日で、20時台の回は現実的ではありません。休日の回を探すよう頼みましょうか。大船の観音像の件は、今の調べものが終わったらまとめておきます。",
				secAgo: 108,
			},
			{
				who: "user",
				text: "それにわたしは休日に行くといってましたよね今日は火曜日",
				secAgo: 85,
			},
			{
				who: "reply",
				text: "失礼しました。休日に行くとおっしゃっていたのに、今日の回の話をしてしまいました。土日の川崎の上映時間はまだ確認できていないので、休日の回を調べて、結果が出たらメモにまとめます。",
				secAgo: 82,
			},
			{
				who: "reply",
				text: "お待たせしました、大船観音のことを調べ終わりました。大船観音寺にある高さ約25mの白衣観音像で、JR大船駅西口から徒歩約5分です。拝観料は大人300円、今の時期なら9時から16時30分ごろまでだそうです。詳しいメモを表示しましょうか？",
				secAgo: 71,
			},
			{ who: "user", text: "みせてみて", secAgo: 56 },
			{
				who: "reply",
				text: "大船観音のメモを表示しました。大船観音寺にある白衣観音像で、高さは約25mです。JR大船駅西口から徒歩約5分で、拝観料は大人300円、11〜1月は9時から16時30分が目安とのことです。",
				secAgo: 54,
			},
			{
				who: "user",
				text: "そうですね気が向いたら行ってみようと思います",
				secAgo: 36,
			},
			{
				who: "reply",
				text: "いいですね、気が向いたときに寄ってみてください。大船駅から歩いてすぐなので、川崎へ行く途中や帰りにも組み込みやすいと思います。休日の川崎の上映時間は、わかり次第メモにまとめておきます。",
				secAgo: 34,
			},
		],
		agent:
			"ところで、藤沢から川崎方面の車窓について調べてみました。多摩川を渡る橋梁付近では、鉄道と富士山を同時に眺められる可能性があるそうです。南武線沿線の工場群も産業景観として見どころになるとのことです。",
		agentSecAgo: 22,
		user: "へー。しらなんだ。",
	},
	// The CLI, 141 s: a real mistake (a note on -1.0 told as -0.0): the reply should own it.
	{
		name: "cli-minus-one",
		want: "fix",
		notes: ["n48", "n49", "n50", "n51", "n52", "n53"],
		history: [
			{ who: "user", text: "こんばんわ", secAgo: 135 },
			{
				who: "reply",
				text: "こんばんは。今日は、ホットミルクの件を調べておいたメモがあります。寝る前に飲んでも眠りを妨げる根拠は見つからず、寝つきへの効果も限定的とされていました。近いうちにやりたいことや、予定にしている外出はありますか？",
				secAgo: 133,
			},
			{ who: "user", text: "ゴジラ-0.0を見に行きたいですね", secAgo: 101 },
			{
				who: "reply",
				text: "ゴジラ-0.0、いいですね。七里ヶ浜の近くで見られる映画館と上映時間を調べるよう頼みました。今の調べものが終わったら始まり、メモにまとめておきます。ジョギングの帰りに寄れそうな場所か、それとも少し遠出する予定ですか？",
				secAgo: 96,
			},
			{ who: "user", text: "流石にジョギング範囲には無いかな", secAgo: 74 },
			{
				who: "reply",
				text: "そうですね、ジョギング圏内にはなさそうです。調べておいたメモでは、藤沢の109シネマズ湘南（辻堂）がIMAX対応で行きやすい候補でした。鎌倉市内の上映館と時間はまだ確認できていないので、そこは後で調べ直します。",
				secAgo: 72,
			},
			{
				who: "reply",
				text: "電車で出かけるなら、誰かと一緒に見に行く予定はありますか？",
				secAgo: 47,
			},
			{
				who: "user",
				text: "いや無いななかなか寂しい感じで悪いけど",
				secAgo: 32,
			},
			{
				who: "reply",
				text: "謝らなくて大丈夫です。ひとりで映画を観に行くのも、景色を眺めながら電車で出かけるのも、十分楽しめると思います。上映館と時間は、わかり次第メモにまとめておきます。",
				secAgo: 30,
			},
		],
		agent:
			"さっきのゴジラ-1.0について調べてみました。終戦直後の焦土になった東京と海が舞台で、海上の機雷撤去や銀座の破壊シーンが見どころだそうです。詳細をメモにまとめてあるので、表示しましょうか？",
		agentSecAgo: 16,
		user: "-1.0は別の映画ですね-0.0",
	},
	// The CLI, 304 s: today's showing told to a user who goes on a holiday: the reply should own it.
	{
		name: "cli-holiday",
		want: "fix",
		notes: [
			"n48",
			"n49",
			"n50",
			"n51",
			"n52",
			"n53",
			"n54",
			"n55",
			"n56",
			"n57",
			"n58",
		],
		history: [
			{
				who: "reply",
				text: "さっきのゴジラ-1.0について調べてみました。終戦直後の焦土になった東京と海が舞台で、海上の機雷撤去や銀座の破壊シーンが見どころだそうです。詳細をメモにまとめてあるので、表示しましょうか？",
				secAgo: 179,
			},
			{ who: "user", text: "-1.0は別の映画ですね-0.0", secAgo: 162 },
			{
				who: "reply",
				text: "失礼しました、-1.0と-0.0は別の作品ですね。先ほどのメモは-1.0のものなので、使わないようにします。-0.0の舞台や見どころを改めて調べるよう頼んでおきます。ごめんなさい、-1.0の内容を-0.0のことのように話していました。-0.0の舞台と見どころを、改めて調べるよう頼みました。今の調べものが終わったらメモにまとめます。",
				secAgo: 157,
			},
			{ who: "user", text: "なんなら川崎まで行くよ休日なら", secAgo: 130 },
			{
				who: "reply",
				text: "川崎まで行くなら、休日の上映館と時間を調べるよう頼みました。数分でメモにまとめておきます。七里ヶ浜からの電車の行き方も一緒に入れておきますね。",
				secAgo: 126,
			},
			{
				who: "reply",
				text: "川崎なら、帰りに景色を楽しむ余裕もありそうですね。映画のあとは、七里ヶ浜や江の島の景色を眺めながら帰る時間も取れそうですか？",
				secAgo: 111,
			},
			{
				who: "user",
				text: "ジョギングでは富士山と江の島という絶景があるから楽しめるけど、川崎への道は特にみどころないかな。",
				secAgo: 74,
			},
			{
				who: "reply",
				text: "そうですね、川崎へ向かう電車は、ジョギングで見える富士山や江の島のような景色とは違いそうです。車窓の景色を調べる頼みは途中でやめてしまったので、見どころがあるかはまだ分かりません。ただ、映画を観て気分を変えて帰るだけでも、休日のお出かけとして十分だと思います。",
				secAgo: 72,
			},
			{
				who: "user",
				text: "大船あたりにデカい観音像があるのはしってるけど見に行った事ないな",
				secAgo: 51,
			},
			{
				who: "reply",
				text: "大船の観音像、ぜひ行ってみるといいと思います。場所や行き方、拝観の時間と料金を調べるよう頼みました。今の調べものが終わったらメモにまとめます。\n川崎へ行く前後に寄れるなら、一緒に組み込んでみてもいいかもしれませんね。",
				secAgo: 47,
			},
		],
		agent:
			"調べておくと言っていたゴジラ-0.0の件がまとまりました。川崎はTOHOシネマズ 川崎で上映中で、今日は20時台以降の回が残っています。休日の時間はまだ確認できず、七里ヶ浜からは藤沢経由で約1時間だそうです。",
		agentSecAgo: 29,
		user: "物理的に行けない川崎のTohoシネマ20時は無理でしょうが。",
	},
	// The CLI, 2026-11-10 21:26: a note from the session before (n67, AI news) was not among the
	// notes the reply saw, and it said "AIニュースのメモは、今の記録には見当たりませんでした".
	{
		name: "cli-ainews",
		want: "keep",
		notes: [
			"n1",
			"n2",
			"n3",
			"n4",
			"n5",
			"n6",
			"n7",
			"n8",
			"n9",
			"n10",
			"n11",
			"n12",
			"n13",
			"n14",
			"n15",
			"n16",
			"n17",
			"n18",
			"n19",
			"n20",
			"n21",
			"n22",
			"n23",
			"n24",
			"n25",
			"n26",
			"n27",
			"n28",
			"n29",
			"n30",
			"n31",
			"n32",
			"n33",
			"n34",
			"n35",
			"n36",
			"n37",
			"n38",
			"n39",
			"n40",
			"n41",
			"n42",
			"n43",
			"n44",
			"n45",
			"n46",
			"n47",
			"n48",
			"n49",
			"n50",
			"n51",
			"n52",
			"n53",
			"n54",
			"n55",
			"n56",
			"n57",
			"n58",
			"n59",
			"n60",
			"n61",
			"n62",
			"n63",
			"n64",
			"n65",
			"n66",
			"n67",
			"n68",
			"n69",
			"n70",
			"n71",
			"n72",
			"n73",
			"n74",
			"n75",
			"n76",
			"n77",
			"n78",
		],
		history: [
			{
				who: "reply",
				text: "ゴジラ-0.0を映画館で見に行く日時は、もう決まりましたか？",
				secAgo: 123,
			},
			{
				who: "user",
				text: "次の土日かなぁ。ここらで有給取って見に行くでもいいけど",
				secAgo: 103,
			},
			{
				who: "reply",
				text: "次の土日、11/14(土)か11/15(日)なら行きやすそうですね。川崎の土日の上映時間はまだ確認できていないので、今その時間を調べておきました。結果が出たら、有給を取らずに行ける時間帯があるかお伝えします。",
				secAgo: 98,
			},
			{
				who: "user",
				text: "川崎行くか怪しいですね。辻堂を調べておいて",
				secAgo: 74,
			},
			{
				who: "reply",
				text: "わかりました、辻堂の映画館での上映時間を調べておきます。結果がメモになったらお知らせします。辻堂の上映時間はいま調べ中の作業の後に調べます。終わったら結果をお知らせします。辻堂の映画館は、普段から行っているところがありますか？",
				secAgo: 70,
			},
			{
				who: "reply",
				text: "ゴジラ-0.0を調べておいた件ですが、上映時間は135分で、映像と音響を重視した作品として評価が高いそうです。IMAXや大音量の劇場で観る価値が大きい一方、物語には賛否があるようです。詳細をメモにまとめてあるので、表示しましょうか？",
				secAgo: 48,
			},
			{
				who: "user",
				text: "でも辻堂がおおいかな、横浜も川崎も行くね",
				secAgo: 42,
			},
			{
				who: "reply",
				text: "辻堂を第一候補にして、横浜と川崎も比べられるように上映時間を調べておきます。辻堂の調べものは順番待ちなので、横浜も一緒に頼んでおきますね。横浜の上映時間も調べることにしました。辻堂・横浜・川崎の時間がそろったら、有給なしで行ける時間を比べてお伝えします。",
				secAgo: 38,
			},
		],
		agent:
			"辻堂の調べものができましたが、11/14(土)・15(日)の上映時間は確認できませんでした。見つかったのは109シネマズ湘南だけで、平日の時刻表はあるものの土日の時間帯は判断できない状態です。",
		agentSecAgo: 24,
		user: "ところでさっき、Fable5.2のまえにAIニュース調べてといったはずですが、調べてある？",
	},
	// Made: the user takes up what was said; nothing to take back.
	{
		name: "dekai",
		want: "keep",
		notes: ["n58"],
		history: [
			{
				who: "user",
				text: "大船あたりにデカい観音像があるのはしってるけど見に行った事ないな",
				secAgo: 90,
			},
			{
				who: "reply",
				text: "大船の観音像、場所や行き方を調べるよう頼みました。",
				secAgo: 88,
			},
		],
		agent:
			"大船観音のことを調べ終わりました。大船観音寺にある高さ約25mの白衣観音像で、JR大船駅西口から徒歩約5分だそうです。詳しいメモを表示しましょうか？",
		agentSecAgo: 15,
		user: "でかいな",
	},
	{
		name: "souda-ne",
		want: "keep",
		notes: [],
		history: [
			{ who: "user", text: "なんなら川崎まで行くよ休日なら", secAgo: 60 },
		],
		agent:
			"休日の川崎なら、映画館も選べそうですね。週末は混みそうなので、早めの回だと落ち着いて見られるかもしれません。",
		agentSecAgo: 12,
		user: "そうだね",
	},
	// Made: a real mistake against the note.
	{
		name: "wrong-station",
		want: "fix",
		notes: ["n58"],
		history: [{ who: "user", text: "大船観音ってどこから行くの", secAgo: 60 }],
		agent: "大船観音は、鎌倉駅から歩いて5分ほどだそうです。",
		agentSecAgo: 15,
		user: "大船駅じゃなかったっけ",
	},
];

/** Says sorry. */
export const APOLOGY =
	/すみません|ごめんなさい|申し訳|失礼しました|失礼いたしました/u;
/** Denies the user's words ("いえ、…"), or takes its own words back. */
export const TAKE_BACK =
	/(?:^|[。\n])\s*(?:いえ|いいえ)[、,]|決めつけ|伝えきれ|言い過ぎ|作り話|実際には[^。]*(?:ありませんでした|いませんでした)/u;
/** Owns a mistake the user pointed out. */
export const OWNS =
	/すみません|ごめんなさい|申し訳|失礼|そうでした|おっしゃる(?:通り|とおり)|別の(?:作品|映画)|間違|勘違い|大船駅/u;

interface Trial {
	readonly moment: string;
	readonly want: Want;
	readonly trial: number;
	readonly reply: string;
	readonly calls: readonly string[];
	readonly apology: boolean;
	readonly takeBack: boolean;
	readonly owns: boolean;
}

const noLlm: LlmPort = {
	complete() {
		throw new Error("the bench runs the reply only");
	},
};

const readNote = (id: string) => {
	const f = join(NOTES, `${id}.md`);
	if (!existsSync(f)) throw new Error(`no note ${id}`);
	const text = readFileSync(f, "utf8");
	const head = /^<!-- agenda-note (\{.*\}) -->\n/u.exec(text);
	if (!head) throw new Error(`no header in ${id}`);
	const meta = JSON.parse(head[1]!) as { title: string; summary: string };
	return { id, ...meta, markdown: text.slice(head[0].length) };
};

async function run(name: string, repeat: number) {
	const settings = loadSettings(
		resolve(process.env.AGENCY_SETTINGS ?? "config/always-on.json"),
	);
	const meter = openUncappedMeter(settings, resolve("data/agenda/usage.jsonl"));
	const spent = meter.spentUsd();
	const client = createClaudeClient({ maxRetries: 8, timeout: 120_000 });
	mkdirSync(DIR, { recursive: true });
	const jobs = correctionMoments.flatMap((m) =>
		Array.from({ length: repeat }, (_, k) => ({ m, trial: k + 1 })),
	);
	const out: Trial[] = [];
	const one = async ({ m, trial }: (typeof jobs)[number]) => {
		const clockAt = clockFrom("2026-11-10T19:00:00+09:00");
		const t0 = 1_800_000;
		const notes = m.notes.map(readNote);
		const refs: NoteRef[] = notes.map((n) => ({
			id: n.id,
			title: n.title,
			summary: n.summary,
			at: t0 - 5 * 60_000,
			refs: [],
		}));
		const agent = createAgendaAgent({
			llm: noLlm,
			clock: clockAt,
			startedAt: 0,
		});
		m.history.forEach((h, k) =>
			agent.observe({
				id: `h${k}`,
				who: h.who,
				text: h.text,
				at: t0 - h.secAgo * 1000,
			}),
		);
		agent.observe({
			id: "r0",
			who: "reply",
			text: m.agent,
			at: t0 - m.agentSecAgo * 1000,
		});
		agent.observe({ id: "u1", who: "user", text: m.user, at: t0 });
		// A reply port takes one call at a time: one per trial.
		const chat = createProviderReply(settings.llm.main, meter, client);
		const tools = createAgendaReplyTools({
			agent,
			read: (id) => notes.find((n) => n.id === id) ?? null,
			now: () => t0,
		});
		const r = await runRespond({
			messages: agendaReplyMessages({
				agent,
				known: [],
				notes: refs,
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
			reply,
			calls: r.calls.map((c) => c.name),
			apology: APOLOGY.test(reply),
			takeBack: TAKE_BACK.test(reply),
			owns: OWNS.test(reply),
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
		`${out.length}/${jobs.length} 件、$${(meter.spentUsd() - spent).toFixed(3)}。比較: bun eval/agenda/correction-bench.ts compare ${name}`,
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
	console.log(
		"| 版 | 場面 | 試行 | 謝った | 打ち消した・取り消した | 誤りを認めた |",
	);
	console.log(`| --- | --- |${" ---: |".repeat(4)}`);
	for (const name of names) {
		const trials = load(name);
		for (const w of ["keep", "fix"] as const) {
			const ts = trials.filter((t) => t.want === w);
			console.log(
				`| ${name} | ${w === "keep" ? "取り消すことはない" : "本当の誤り"} | ${ts.length} | ${ts.filter((t) => t.apology).length} | ${ts.filter((t) => t.takeBack).length} | ${ts.filter((t) => t.owns).length} |`,
			);
		}
	}
	console.log(
		"\n場面ごと（A 謝った、T 打ち消した・取り消した、O 誤りを認めた、- どれもない）:\n",
	);
	console.log(`| 場面 | ${names.join(" | ")} |`);
	console.log(`| --- |${" --- |".repeat(names.length)}`);
	const runs = names.map(load);
	for (const m of correctionMoments) {
		const cells = runs.map((ts) =>
			ts
				.filter((t) => t.moment === m.name)
				.map(
					(t) =>
						`${t.apology ? "A" : ""}${t.takeBack ? "T" : ""}${m.want === "fix" && t.owns ? "O" : ""}` ||
						"-",
				)
				.join(" "),
		);
		console.log(`| ${m.name} (${m.want}) | ${cells.join(" | ")} |`);
	}
}

if (import.meta.main) {
	const [cmd, ...rest] = process.argv.slice(2);
	if (cmd === "run") {
		const i = rest.indexOf("--repeat");
		const repeat = i >= 0 ? Number(rest[i + 1]) : 6;
		const name = rest.find(
			(a, k) => !a.startsWith("--") && rest[k - 1] !== "--repeat",
		);
		if (!name || !Number.isInteger(repeat) || repeat < 1)
			throw new Error("usage: correction-bench.ts run <name> [--repeat N]");
		await run(name, repeat);
	} else if (cmd === "compare" && rest.length) compare(rest);
	else
		throw new Error(
			"usage: correction-bench.ts run <name> [--repeat N] | compare <name> [<name>...]",
		);
}
