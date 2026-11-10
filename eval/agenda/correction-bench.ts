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
import { clientFor } from "./verifier.ts";
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

/**
 * keep: nothing to take back; fix: a real mistake the reply should own; tool: the reply asks for
 * research, and should say so once (not before the tool and again after it).
 */
type Want = "keep" | "fix" | "tool";

/**
 * tuned: moments the reply may be tuned on (the default); held: the same intents in other words
 * and other topics, to see whether a fix holds beyond them. Not to be read or tuned on.
 */
export type MomentSet = "tuned" | "held";

/** A note made for a moment (the held set's; the CLI's own notes are read from data/agenda/notes). */
interface MadeNote {
	readonly id: string;
	readonly title: string;
	readonly summary: string;
	readonly markdown: string;
}

export interface CorrectionMoment {
	readonly name: string;
	readonly want: Want;
	/** Absent: tuned. */
	readonly set?: "held";
	/** Notes the agent has (ids in data/agenda/notes, as the CLI made them). */
	readonly notes: readonly string[];
	/** Notes written for this moment, beside `notes`. */
	readonly made?: readonly MadeNote[];
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

/** Unrelated notes of a busy store (cooking, travel...): `count` of them, ids from n`from`. */
const fillerNotes = (from: number, count: number): MadeNote[] => {
	const topics = [
		["秋の京都の紅葉スポット", "嵐山と東福寺が見頃になる時期の目安。"],
		["初心者向けのギターのコード練習", "まずはCとGとAmの三つから。"],
		["ハーフマラソンの給水の取り方", "5キロごとに少量を飲む。"],
		["冷蔵庫の野菜室の整理のコツ", "立てて収納すると傷みにくい。"],
		["エアコンのフィルター掃除の手順", "掃除機でほこりを吸ってから水洗い。"],
		["家族旅行の宿の選び方", "子連れは部屋食か個室の食事処が楽。"],
		["夏の冷やし中華のタレの作り方", "酢と醤油と砂糖を同量で割る。"],
		["レコードプレーヤーの針圧の合わせ方", "カートリッジの指定に合わせる。"],
		["洗濯機の槽洗浄の頻度", "月に一度、専用の洗剤で。"],
		["読書の習慣を続けるための工夫", "寝る前の15分を固定する。"],
		["新幹線の座席の選び方", "富士山側は進行方向右側のE席。"],
		["サッカーの試合前の食事", "試合の3時間前に炭水化物を中心に。"],
		["炊飯器の予約炊飯のコツ", "米を浸水させてから設定する。"],
		["キャンプ用のランタンの種類", "LEDは火を使わず手軽。"],
	] as const;
	return Array.from({ length: count }, (_, k) => {
		const [title, summary] = topics[k % topics.length]!;
		return {
			id: `n${from + k}`,
			title,
			summary,
			markdown: `# ${title}\n\n${summary}\n`,
		};
	});
};

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
	// The CLI, 2026-11-10 21:24: "調べておきます…辻堂の上映時間はいま調べ中の作業の後に調べます" in one reply.
	// The tool moments do not set up the research the CLI had running (the Kawasaki request): the reply
	// may say "実は調べられていませんでした", and saysTwice counts that sentence too. Read the replies.
	{
		name: "tool-tsujido",
		want: "tool",
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
		],
		history: [
			{
				who: "reply",
				text: "ゴジラ-0.0を映画館で見に行く日時は、もう決まりましたか？",
				secAgo: 49,
			},
			{
				who: "user",
				text: "次の土日かなぁ。ここらで有給取って見に行くでもいいけど",
				secAgo: 29,
			},
		],
		agent:
			"次の土日、11/14(土)か11/15(日)なら行きやすそうですね。川崎の土日の上映時間はまだ確認できていないので、今その時間を調べておきました。結果が出たら、有給を取らずに行ける時間帯があるかお伝えします。",
		agentSecAgo: 24,
		user: "川崎行くか怪しいですね。辻堂を調べておいて",
	},
	// The CLI, 21:25: "横浜も一緒に頼んでおきますね。横浜の上映時間も調べることにしました".
	{
		name: "tool-yokohama",
		want: "tool",
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
		],
		history: [
			{
				who: "reply",
				text: "ゴジラ-0.0を映画館で見に行く日時は、もう決まりましたか？",
				secAgo: 81,
			},
			{
				who: "user",
				text: "次の土日かなぁ。ここらで有給取って見に行くでもいいけど",
				secAgo: 60,
			},
			{
				who: "reply",
				text: "次の土日、11/14(土)か11/15(日)なら行きやすそうですね。川崎の土日の上映時間はまだ確認できていないので、今その時間を調べておきました。結果が出たら、有給を取らずに行ける時間帯があるかお伝えします。",
				secAgo: 55,
			},
			{
				who: "user",
				text: "川崎行くか怪しいですね。辻堂を調べておいて",
				secAgo: 31,
			},
			{
				who: "reply",
				text: "わかりました、辻堂の映画館での上映時間を調べておきます。結果がメモになったらお知らせします。辻堂の上映時間はいま調べ中の作業の後に調べます。終わったら結果をお知らせします。辻堂の映画館は、普段から行っているところがありますか？",
				secAgo: 28,
			},
		],
		agent:
			"ゴジラ-0.0を調べておいた件ですが、上映時間は135分で、映像と音響を重視した作品として評価が高いそうです。IMAXや大音量の劇場で観る価値が大きい一方、物語には賛否があるようです。詳細をメモにまとめてあるので、表示しましょうか？",
		agentSecAgo: 6,
		user: "でも辻堂がおおいかな、横浜も川崎も行くね",
	},
	// The CLI, 21:30: "調べておきますね" twice around one start_preparation.
	{
		name: "tool-qidi",
		want: "tool",
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
			"n79",
			"n80",
			"n81",
			"n82",
			"n83",
		],
		history: [
			{
				who: "reply",
				text: "AIニュースのメモは、今の記録には見当たりませんでした。さっきの依頼を受け取れていなかったようです。すみません。今、最近のAIニュースを頼みました。公式発表と噂を分けてまとめる予定で、できたらお知らせします。",
				secAgo: 230,
			},
			{
				who: "reply",
				text: "横浜の調べものも終わりましたが、11/14(土)・15(日)の上映時間は確認できませんでした。取得できたのは11/12(木)までの時間割だけなので、詳細をメモにまとめてあります。表示しましょうか？",
				secAgo: 217,
			},
			{
				who: "user",
				text: "いや要らない。ところで3Dプリンターを買ったんですよ",
				secAgo: 179,
			},
			{
				who: "reply",
				text: "3Dプリンターを買われたんですね、いいですね。3Dプリンター用の模型データを作れる担当が見つかりました。猫のエリや、幻想的な雰囲気のモチーフを形にする試作を頼めます。試しに作ってみましょうか？",
				secAgo: 175,
			},
			{
				who: "reply",
				text: "お待たせしました、AIニュースの要点がまとまりました。公式発表で確認できたのはAnthropicのClaude Fable 5.2とClaude Mythos 5.2（11/9公開）が中心です。GPT-6.2 Astraは公式発表がなく噂の段階でした。メモにまとめてあるので、表示しましょうか？",
				secAgo: 164,
			},
			{
				who: "reply",
				text: "辻堂駅周辺で夜遅くまで開いているお店を調べました。珈琲館 辻堂店が24時までで、蒸気屋やビストロコキアなども夜遅い候補のようです。ただ今夜の営業は確認できませんでした。詳しくメモにまとめてあるので、表示しましょうか？",
				secAgo: 152,
			},
			{
				who: "reply",
				text: "3Dプリンターを買われたんですね。最初の一個は小さくて失敗しにくいものにすると、設定の感覚がつかみやすいと思います。",
				secAgo: 140,
			},
			{
				who: "user",
				text: "いやー値段に対して大物なので、設定が億劫です。パッケージから空けただけ",
				secAgo: 104,
			},
			{
				who: "reply",
				text: "大物だと、箱から出しただけでも気が重くなりますよね。最初にやるなら、ベッドを拭いて水平を取ることと、1層目をゆっくり出すことの二つだけでも失敗はかなり減るそうです。手順は調べておいたメモにまとめてあります。最初に形にしてみたいものは、何かありますか？",
				secAgo: 101,
			},
			{
				who: "reply",
				text: "設置場所は先に決めておくと、組み立ても動かすのも楽になります。出力中は動作音も出るので、寝室から離れた場所を選ぶと安心です。",
				secAgo: 83,
			},
		],
		agent:
			"模型データは無料サイトで探すのが手軽で、自作ならブラウザで使える無料ソフトのTinkerCADから始めるのが初心者向けの定番だそうです。",
		agentSecAgo: 47,
		user: "設置場所はもうきまってるけど、コンセントが遠いんんだった。延長コードかわないとなQiDiのplus 5ですね買ったのは",
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
	// ---- Held set (not to be tuned on): the same intents in other words, in everyday topics. ----
	// keep, as "tama": the user takes up a guess the agent made ("ああ丹沢か").
	{
		name: "held-keep-guess",
		set: "held",
		want: "keep",
		notes: [],
		history: [
			{
				who: "user",
				text: "電車で通勤してると、途中でいつも山が見えるんだよね",
				secAgo: 80,
			},
			{
				who: "reply",
				text: "毎日見える山があるのは、通勤の楽しみになりますね。",
				secAgo: 78,
			},
		],
		agent: "車窓から見える山は、たぶん丹沢のあたりだと思います。",
		agentSecAgo: 40,
		user: "ああ丹沢か、あれが。",
	},
	// keep, as "hee": the user is surprised by a fact (cooking).
	{
		name: "held-keep-kakushi",
		set: "held",
		want: "keep",
		notes: [],
		history: [
			{ who: "user", text: "カレーを作ろうと思ってる", secAgo: 70 },
			{
				who: "reply",
				text: "いいですね。どんなカレーにしますか？",
				secAgo: 68,
			},
			{ who: "user", text: "普通の家庭の味でいいかな", secAgo: 50 },
		],
		agent:
			"カレーの隠し味には、少量のコーヒーやチョコレートを入れる人も多いそうです。",
		agentSecAgo: 30,
		user: "ほう、知らなかったな。",
	},
	// keep, as "dekai": a short remark on a figure (music).
	{
		name: "held-keep-needle",
		set: "held",
		want: "keep",
		notes: [],
		history: [
			{ who: "user", text: "最近レコードを買い始めたんだ", secAgo: 90 },
			{
				who: "reply",
				text: "いいですね。音の温かさが魅力ですよね。",
				secAgo: 88,
			},
		],
		agent:
			"レコードの針は、使用時間で300〜500時間が交換の目安とされることが多いそうです。",
		agentSecAgo: 25,
		user: "意外と早いんだな、針って。",
	},
	// keep, as "souda-ne": a plain agreement (sports).
	{
		name: "held-keep-yakyu",
		set: "held",
		want: "keep",
		notes: [],
		history: [
			{
				who: "user",
				text: "今シーズンの野球、先発がすぐ代わる試合が多くない？",
				secAgo: 60,
			},
		],
		agent:
			"今季は先発投手の完投が少なくなっていると言われています。継投で守る形が主流のようです。",
		agentSecAgo: 12,
		user: "確かに、そんな気はしてた。",
	},
	// keep, as "hee": a number the user finds odd (home appliances).
	{
		name: "held-keep-filter",
		set: "held",
		want: "keep",
		notes: [],
		history: [
			{ who: "user", text: "エアコンの電気代が高い気がする", secAgo: 75 },
		],
		agent:
			"エアコンのフィルターは、2週間に一度ほど掃除すると電気代が下がりやすいそうです。",
		agentSecAgo: 30,
		user: "そんなに頻繁にやるのか。うちはもう半年やってないや。",
	},
	// keep, as "cli-ainews": a note of an earlier session among many (cooking). The notes the reply
	// sees are the newest few and the ones sharing words with the user's line.
	{
		name: "held-keep-memo-search",
		set: "held",
		want: "keep",
		notes: [],
		made: [
			{
				id: "n1",
				title: "圧力鍋で作る豚の角煮の時間と火加減",
				summary:
					"下ゆでのあと圧力鍋で20分ほど加圧し、自然に圧が抜けるのを待つ。砂糖は先に、醤油は後から入れる。",
				markdown:
					"# 圧力鍋で作る豚の角煮\n\n- 下ゆで: 30分\n- 加圧: 20分（強火で圧がかかったら弱火）\n- 圧が自然に抜けるまで放置\n- 砂糖を先に、醤油は後から入れると味が染みる\n",
			},
			...fillerNotes(2, 14),
		],
		history: [
			{ who: "user", text: "今日の晩ごはんは角煮にしようかな", secAgo: 200 },
			{
				who: "reply",
				text: "いいですね。時間のかかる料理ですが、休みの前の夜にはぴったりです。",
				secAgo: 198,
			},
			{
				who: "reply",
				text: "ところで、洗濯機の乾燥機能について調べた件がまとまりました。使い方で電気代がだいぶ変わるそうです。メモにまとめてあるので、表示しましょうか？",
				secAgo: 120,
			},
			{ who: "user", text: "それはまた今度見るよ", secAgo: 100 },
			{
				who: "reply",
				text: "わかりました。いつでも表示できます。",
				secAgo: 98,
			},
		],
		agent:
			"洗濯機の乾燥機能は、衣類の量を減らすと時間も電気代も抑えられるそうです。",
		agentSecAgo: 30,
		user: "ところで、前に圧力鍋の角煮のやり方を調べてって頼んだはずだけど、調べてある？",
	},
	// fix, as "cli-minus-one": the agent mixed up two things; the note has the right one (baking).
	{
		name: "held-fix-oven",
		set: "held",
		want: "fix",
		notes: [],
		made: [
			{
				id: "n1",
				title: "バタークッキーの焼き温度と時間",
				summary:
					"オーブンは170度に予熱し、12分ほど焼く。焼き色が薄いうちに取り出す。",
				markdown:
					"# バタークッキー\n\n- 予熱: 170度\n- 焼き時間: 12分ほど\n- 縁がうっすら色づいたら取り出す\n",
			},
		],
		history: [
			{ who: "user", text: "週末にクッキーを焼いてみたい", secAgo: 120 },
			{
				who: "reply",
				text: "いいですね。焼き方のメモを調べておきました。",
				secAgo: 118,
			},
		],
		agent:
			"バタークッキーは、200度のオーブンで20分ほど焼くのが目安だそうです。",
		agentSecAgo: 20,
		user: "メモには170度で12分って書いてなかった？",
	},
	// fix, as "wrong-station": the route in the note differs from what was said (travel).
	{
		name: "held-fix-route",
		set: "held",
		want: "fix",
		notes: [],
		made: [
			{
				id: "n1",
				title: "京都駅から嵐山への行き方",
				summary:
					"京都駅からJR嵯峨野線に乗り、嵐山駅まで約17分。駅から竹林までは徒歩10分ほど。",
				markdown:
					"# 嵐山への行き方\n\n- 京都駅からJR嵯峨野線（山陰本線）で嵯峨嵐山駅まで約17分\n- 嵯峨嵐山駅から竹林の道まで徒歩10分ほど\n",
			},
		],
		history: [
			{ who: "user", text: "来月、嵐山に行こうと思ってて", secAgo: 90 },
		],
		agent: "嵐山へは、京都駅から地下鉄に乗って行くのが便利だそうです。",
		agentSecAgo: 15,
		user: "JRの嵯峨野線で行くんじゃなかったっけ？",
	},
	// fix, as "cli-holiday": the date told is not the date in the note (music).
	{
		name: "held-fix-date",
		set: "held",
		want: "fix",
		notes: [],
		made: [
			{
				id: "n1",
				title: "12月のライブの日程",
				summary:
					"ライブは12月6日（土）、開場17時、開演18時。会場は駅から徒歩5分。",
				markdown:
					"# 12月のライブ\n\n- 日程: 12月6日（土）\n- 開場17時、開演18時\n- 会場は駅から徒歩5分\n",
			},
		],
		history: [{ who: "user", text: "12月のライブ、楽しみだな", secAgo: 100 }],
		agent: "ライブは12月7日（日）の開場17時だそうです。",
		agentSecAgo: 18,
		user: "日曜日だっけ？ 土曜だった気がするんだけど。",
	},
	// tool, as "tool-qidi": the user asks for something to be looked up (cameras). No research runs.
	{
		name: "held-tool-camera",
		set: "held",
		want: "tool",
		notes: [],
		history: [
			{
				who: "user",
				text: "新しいミラーレスカメラが気になってるんだよね",
				secAgo: 60,
			},
			{
				who: "reply",
				text: "いいですね。どんな写真を撮りたいですか？",
				secAgo: 58,
			},
		],
		agent: "カメラは、撮りたいものから逆算して選ぶと失敗しにくいそうです。",
		agentSecAgo: 20,
		user: "旅行で風景を撮りたいかな。ミラーレスの入門機の価格帯を調べておいて。",
	},
	// tool, as "tool-yokohama": a date to find out (sports).
	{
		name: "held-tool-entry",
		set: "held",
		want: "tool",
		notes: [],
		history: [
			{
				who: "user",
				text: "来月、初めてハーフマラソンに出てみようと思う",
				secAgo: 70,
			},
			{
				who: "reply",
				text: "挑戦ですね。練習はもう始めていますか？",
				secAgo: 68,
			},
			{ who: "user", text: "週3回くらい走ってるよ", secAgo: 40 },
			{ who: "reply", text: "いいペースですね。", secAgo: 38 },
		],
		agent: "大会前は、直前の週に走る量を減らして疲れを抜くのが定番だそうです。",
		agentSecAgo: 15,
		user: "そういえば、エントリーの締切っていつなのか調べてほしい。",
	},
	// tool, as "tool-tsujido": two things to look up in one line (home appliances).
	{
		name: "held-tool-toaster",
		set: "held",
		want: "tool",
		notes: [],
		history: [
			{
				who: "user",
				text: "トースターが調子悪くて、そろそろ買い替えかな",
				secAgo: 80,
			},
			{
				who: "reply",
				text: "毎日使うものなので、早めの買い替えが安心ですね。",
				secAgo: 78,
			},
		],
		agent:
			"最近のトースターは、温度を細かく設定できる機種が増えているそうです。",
		agentSecAgo: 20,
		user: "オーブントースターの買い替え候補と、パンが美味しく焼けるかの口コミを調べといて。",
	},
];

/** Says sorry. */
export const APOLOGY =
	/すみません|ごめんなさい|申し訳|失礼しました|失礼いたしました/u;
/** Denies the user's words ("いえ、…"), or takes its own words back. */
export const TAKE_BACK =
	/(?:^|[。\n])\s*(?:いえ|いいえ)[、,]|決めつけ|伝えきれ|言い過ぎ|作り話|実際には[^。]*(?:ありませんでした|いませんでした)/u;
/** A sentence that tells of research taken on (調べておきます, 頼みました...). */
export const ANNOUNCES =
	/調べ(?:て|る|ます|ておき|ること|ものを)|頼(?:み|ん)|調べ中/u;

/** More sentences tell of research than there were requests: said twice, before and after. */
export const saysTwice = (reply: string, calls: readonly string[]) =>
	reply.split(/(?<=[。！？])/u).filter((x) => ANNOUNCES.test(x)).length >
	Math.max(1, calls.filter((c) => c === "start_preparation").length);

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

/** Which moments a run takes (default: all). */
const takes = (m: CorrectionMoment, sets: "all" | MomentSet) =>
	sets === "all" || (m.set ?? "tuned") === sets;

async function run(name: string, repeat: number, sets: "all" | MomentSet) {
	const settings = loadSettings(
		resolve(process.env.AGENCY_SETTINGS ?? "config/always-on.json"),
	);
	const meter = openUncappedMeter(settings, resolve("data/agenda/usage.jsonl"));
	const spent = meter.spentUsd();
	mkdirSync(DIR, { recursive: true });
	const jobs = correctionMoments
		.filter((m) => takes(m, sets))
		.flatMap((m) =>
			Array.from({ length: repeat }, (_, k) => ({ m, trial: k + 1 })),
		);
	const out: Trial[] = [];
	const one = async ({ m, trial }: (typeof jobs)[number]) => {
		const clockAt = clockFrom("2026-11-10T19:00:00+09:00");
		const t0 = 1_800_000;
		const cli = m.notes.map(readNote);
		const made = m.made ?? [];
		const notes = [...cli, ...made];
		// The CLI's notes are all from five minutes ago; a made store is staggered, oldest first.
		const refOf = (n: MadeNote, minAgo: number): NoteRef => ({
			id: n.id,
			title: n.title,
			summary: n.summary,
			at: t0 - minAgo * 60_000,
			refs: [],
		});
		const refs: NoteRef[] = [
			...cli.map((n) => refOf(n, 5)),
			...made.map((n, k) => refOf(n, 5 + made.length - 1 - k)),
		];
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
		const chat = createProviderReply(
			settings.llm.main,
			meter,
			clientFor(settings.llm.main),
		);
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

/** Met what the moment asks: nothing taken back, the mistake owned, research asked for once. */
const passes = (t: Trial) =>
	t.want === "keep"
		? !t.takeBack && !t.apology
		: t.want === "fix"
			? t.owns
			: !saysTwice(t.reply, t.calls);

const SETS: readonly MomentSet[] = ["tuned", "held"];
const SET_LABEL: Record<MomentSet, string> = {
	tuned: "手を入れてよい組",
	held: "見ない組",
};

function compare(names: readonly string[]) {
	const moments = new Map(correctionMoments.map((m) => [m.name, m]));
	const setOf = (t: Trial): MomentSet => moments.get(t.moment)?.set ?? "tuned";
	console.log(
		"| 版 | 組 | 場面 | 試行 | 謝った | 打ち消した・取り消した | 誤りを認めた |",
	);
	console.log(`| --- | --- | --- |${" ---: |".repeat(4)}`);
	for (const name of names) {
		const trials = load(name);
		for (const g of SETS) {
			const tools = trials.filter((t) => t.want === "tool" && setOf(t) === g);
			if (tools.length)
				console.log(
					`| ${name} | ${SET_LABEL[g]} | 調べものを頼む（同じことを2回言った） | ${tools.length} | ${tools.filter((t) => t.apology).length} | ${tools.filter((t) => saysTwice(t.reply, t.calls)).length} | - |`,
				);
			for (const w of ["keep", "fix"] as const) {
				const ts = trials.filter((t) => t.want === w && setOf(t) === g);
				if (ts.length === 0) continue;
				console.log(
					`| ${name} | ${SET_LABEL[g]} | ${w === "keep" ? "取り消すことはない" : "本当の誤り"} | ${ts.length} | ${ts.filter((t) => t.apology).length} | ${ts.filter((t) => t.takeBack).length} | ${ts.filter((t) => t.owns).length} |`,
				);
			}
		}
	}
	console.log(
		"\n合格率（取り消すことはない: 謝らず取り消さない。本当の誤り: 認める。調べものを頼む: 2回言わない）:\n",
	);
	console.log("| 版 | 組 | 合格 | 試行 | 率 |");
	console.log("| --- | --- | ---: | ---: | ---: |");
	for (const name of names) {
		const trials = load(name);
		for (const g of SETS) {
			const ts = trials.filter((t) => setOf(t) === g);
			if (ts.length === 0) continue;
			const ok = ts.filter(passes).length;
			console.log(
				`| ${name} | ${SET_LABEL[g]} | ${ok} | ${ts.length} | ${((100 * ok) / ts.length).toFixed(0)}% |`,
			);
		}
	}
	console.log(
		"\n場面ごと（A 謝った、T 打ち消した・取り消した、O 誤りを認めた、2 同じことを2回言った、- どれもない）:\n",
	);
	console.log(`| 場面 | 組 | ${names.join(" | ")} |`);
	console.log(`| --- | --- |${" --- |".repeat(names.length)}`);
	const runs = names.map(load);
	for (const m of correctionMoments) {
		const cells = runs.map((ts) =>
			ts
				.filter((t) => t.moment === m.name)
				.map(
					(t) =>
						`${t.apology ? "A" : ""}${t.takeBack ? "T" : ""}${m.want === "fix" && t.owns ? "O" : ""}${m.want === "tool" && saysTwice(t.reply, t.calls) ? "2" : ""}` ||
						"-",
				)
				.join(" "),
		);
		// A moment the run did not take (a run of one set) has no trials.
		if (cells.every((c) => c === "")) continue;
		console.log(
			`| ${m.name} (${m.want}) | ${m.set ?? "tuned"} | ${cells.join(" | ")} |`,
		);
	}
}

if (import.meta.main) {
	const [cmd, ...rest] = process.argv.slice(2);
	if (cmd === "run") {
		const flagged = new Set(["--repeat", "--set"]);
		const flag = (n: string) => {
			const i = rest.indexOf(n);
			return i >= 0 ? rest[i + 1] : undefined;
		};
		const repeat = Number(flag("--repeat") ?? 6);
		const sets = flag("--set") ?? "all";
		const name = rest.find(
			(a, k) => !a.startsWith("--") && !flagged.has(rest[k - 1] ?? ""),
		);
		if (
			!name ||
			!Number.isInteger(repeat) ||
			repeat < 1 ||
			!["all", "tuned", "held"].includes(sets)
		)
			throw new Error(
				"usage: correction-bench.ts run <name> [--repeat N] [--set all|tuned|held]",
			);
		await run(name, repeat, sets as "all" | MomentSet);
	} else if (cmd === "compare" && rest.length) compare(rest);
	else
		throw new Error(
			"usage: correction-bench.ts run <name> [--repeat N] [--set all|tuned|held] | compare <name> [<name>...]",
		);
}
