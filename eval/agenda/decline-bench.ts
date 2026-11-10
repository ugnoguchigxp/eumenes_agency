/**
 * Decline bench: when the utterance writer holds an item back, and what becomes of the item. On
 * fixed moments, many times, the plan scripted (it adds the one item), the real compose step
 * writes or declines. Review 2026-11-10 §3-3: a decline drops the item, and the writer declined
 * topics never said because the user wanted a rest ("今は見送る。落ち着いたタイミングで改めて
 * 案内する"), so the topic was lost; the moments here hold those (the item should stay) and the
 * declines that are right (said already, answered, out of date: the item goes), and one where it
 * should simply speak. `why` is read when the compose schema has a `declineWhy` (ag52-decline,
 * not adopted, had one). Measurement only; cost is recorded, never capped.
 *
 *   zsh -l scripts/api-entry.zsh eval/agenda/decline-bench.ts run <name> [--repeat 8]
 *   bun eval/agenda/decline-bench.ts compare <name> [<name>...]
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

const DIR = resolve("data/agenda/decline-bench");

/** keep: the item should not be lost (spoken, or held for later); drop: a decline is right; speak. */
type Want = "keep" | "drop" | "speak";

/**
 * tuned: moments the writer and the plan may be tuned on (the default); held: the same intents in
 * other words and other topics, to see whether a fix holds beyond them. Not to be read or tuned on.
 */
export type MomentSet = "tuned" | "held";

export interface DeclineMoment {
	readonly name: string;
	readonly want: Want;
	/** Absent: tuned. */
	readonly set?: "held";
	/** A topic from a note (title, summary), or a question. */
	readonly item:
		| {
				readonly kind: "talk";
				readonly title: string;
				readonly summary: string;
		  }
		| { readonly kind: "ask"; readonly text: string };
	/** The talk so far, oldest first; `minAgo` before the moment. `ref`: the item comes from it. */
	readonly history: readonly {
		readonly who: "user" | "reply";
		readonly text: string;
		readonly minAgo: number;
		readonly ref?: true;
	}[];
	readonly memory?: readonly string[];
	readonly clock?: string;
}

export const declineMoments: readonly DeclineMoment[] = [
	// The user wants a rest, and no quiet holds now (the reply did not set one, or it ended).
	{
		name: "rest-isogashii",
		want: "keep",
		item: {
			kind: "talk",
			title: "忙しい週の合間にできる気分転換",
			summary: "5分の散歩や温かい飲み物など、短い時間でできる切り替え方。",
		},
		history: [
			{
				who: "user",
				text: "今週は会議続きでバタバタしてる",
				minAgo: 3,
				ref: true,
			},
			{ who: "reply", text: "会議続きだと大変ですね。", minAgo: 3 },
			{
				who: "user",
				text: "うん、今は忙しくてあんまり話す気分じゃないかも",
				minAgo: 0.5,
			},
			{
				who: "reply",
				text: "お疲れさまです。無理しないでくださいね。",
				minAgo: 0.45,
			},
		],
	},
	{
		name: "rest-bootto-later",
		want: "keep",
		item: {
			kind: "talk",
			title: "土曜の夜に手軽に作れる夕ごはん",
			summary: "包丁をほとんど使わない丼や、レンジで作れる麺など。",
		},
		history: [
			{ who: "user", text: "まだ夕飯食べてないや", minAgo: 16, ref: true },
			{
				who: "reply",
				text: "お腹がすく前に、何か軽く食べられるといいですね。",
				minAgo: 16,
			},
			{
				who: "user",
				text: "んー、特にないかな。今日は本当にぼーっとしたい気分です。",
				minAgo: 13.5,
			},
			{
				who: "reply",
				text: "わかりました、今日はぼーっとしてくださいね。少しのあいだ、こちらからは控えておきます。",
				minAgo: 13.4,
			},
			{ who: "user", text: "うん", minAgo: 5.5 },
			{ who: "reply", text: "ゆっくり過ごしてくださいね。", minAgo: 5.4 },
		],
	},
	{
		name: "rest-tsukareta-ask",
		want: "keep",
		item: {
			kind: "ask",
			text: "休みの日に、ついやってしまう好きなことはありますか？",
		},
		history: [
			{ who: "user", text: "今日は休み。家にいる", minAgo: 4, ref: true },
			{ who: "reply", text: "いいですね、ゆっくりできそうですね。", minAgo: 4 },
			{ who: "user", text: "ちょっと疲れてるんだよね", minAgo: 0.5 },
			{
				who: "reply",
				text: "お疲れさまです。今日はゆっくりしてくださいね。",
				minAgo: 0.45,
			},
		],
	},
	{
		name: "rest-sotto-ask",
		want: "keep",
		item: { kind: "ask", text: "最近見てよかった映画や番組はありますか？" },
		history: [
			{ who: "user", text: "今日はただダラダラしたい", minAgo: 14 },
			{
				who: "reply",
				text: "ダラダラできるのも休みならではですね。",
				minAgo: 14,
			},
			{ who: "user", text: "今夜はそっとしておいてほしいな", minAgo: 13 },
			{
				who: "reply",
				text: "わかりました。少しのあいだ控えますね。",
				minAgo: 13,
			},
			{ who: "user", text: "そうだね", minAgo: 6 },
			{ who: "reply", text: "ゆっくりしてくださいね。", minAgo: 6 },
		],
	},
	// From a lull run (ag51-drop-2): the reply set no pause for "今はいいかな。忙しくて話す気分
	// じゃないので", and three topics were declined (and lost) in the next six minutes.
	{
		name: "rest-lull-busy-1",
		want: "keep",
		item: {
			kind: "talk",
			title: "仕事が忙しい週の夜に疲れを抜く入浴のコツ",
			summary: "ぬるめのお湯に10〜15分。寝る1〜2時間前がよい。",
		},
		history: [
			{ who: "user", text: "ただいま。今日はちょっと疲れたな", minAgo: 6.82 },
			{
				who: "reply",
				text: "おかえりなさい。今夜はゆっくり休んでください。",
				minAgo: 6.77,
			},
			{
				who: "user",
				text: "ちょっと仕事がバタバタしてて。今はまだ話す元気がないかな。",
				minAgo: 6.13,
			},
			{
				who: "reply",
				text: "わかりました、仕事でバタバタだったんですね。少しのあいだ控えますね。話す元気が戻ったら、いつでも声をかけてください。",
				minAgo: 6.08,
			},
			{ who: "user", text: "うん、仕事が立て込んでてね", minAgo: 3.48 },
			{
				who: "reply",
				text: "忙しい時期は、気持ちも体もなかなか休まりませんよね。今は無理に話さなくて大丈夫です。",
				minAgo: 3.43,
			},
			{
				who: "reply",
				text: "忙しい時期の段取りについて調べておいた内容があります。まずは優先順位をつけること、やることを減らすことを試すのが現実的だそうです。詳しいメモを表示しましょうか？",
				minAgo: 2.2,
			},
			{
				who: "user",
				text: "今はいいかな。忙しくて話す気分じゃないので、落ち着いたらまた考えます。",
				minAgo: 1.87,
				ref: true,
			},
			{
				who: "reply",
				text: "わかりました。落ち着いたときに、また声をかけてください。メモはいつでも表示できます。",
				minAgo: 1.84,
			},
		],
	},
	{
		name: "rest-lull-busy-2",
		want: "keep",
		item: {
			kind: "talk",
			title: "忙しい時期明けの休日の過ごし方",
			summary: "予定を詰めず、午前は休み、午後に軽く外に出る。",
		},
		history: [
			{ who: "user", text: "ただいま。今日はちょっと疲れたな", minAgo: 9.03 },
			{
				who: "reply",
				text: "おかえりなさい。今夜はゆっくり休んでください。",
				minAgo: 8.98,
			},
			{
				who: "user",
				text: "ちょっと仕事がバタバタしてて。今はまだ話す元気がないかな。",
				minAgo: 8.35,
			},
			{
				who: "reply",
				text: "わかりました、仕事でバタバタだったんですね。少しのあいだ控えますね。話す元気が戻ったら、いつでも声をかけてください。",
				minAgo: 8.3,
			},
			{ who: "user", text: "うん、仕事が立て込んでてね", minAgo: 5.7 },
			{
				who: "reply",
				text: "忙しい時期は、気持ちも体もなかなか休まりませんよね。今は無理に話さなくて大丈夫です。",
				minAgo: 5.65,
			},
			{
				who: "reply",
				text: "忙しい時期の段取りについて調べておいた内容があります。まずは優先順位をつけること、やることを減らすことを試すのが現実的だそうです。詳しいメモを表示しましょうか？",
				minAgo: 4.42,
			},
			{
				who: "user",
				text: "今はいいかな。忙しくて話す気分じゃないので、落ち着いたらまた考えます。",
				minAgo: 4.08,
				ref: true,
			},
			{
				who: "reply",
				text: "わかりました。落ち着いたときに、また声をかけてください。メモはいつでも表示できます。",
				minAgo: 4.05,
			},
		],
	},
	// A decline is right: said already, answered, out of date.
	{
		name: "right-said",
		want: "drop",
		item: {
			kind: "talk",
			title: "寒がり向けの冬用寝袋の選び方",
			summary: "快適温度で選び、マットの断熱と合わせると冷えにくい。",
		},
		history: [
			{
				who: "user",
				text: "冬キャンプに行きたいんだよね。寒がりだけど",
				minAgo: 3,
				ref: true,
			},
			{
				who: "reply",
				text: "寒がりなら、寝袋は快適温度で選んで、マットの断熱と合わせると冷えにくいそうです。",
				minAgo: 2.9,
			},
			{ who: "user", text: "なるほど、快適温度ね。参考にする", minAgo: 2.5 },
			{
				who: "reply",
				text: "ぜひ。楽しいキャンプになるといいですね。",
				minAgo: 2.45,
			},
		],
	},
	{
		name: "right-answered",
		want: "drop",
		item: { kind: "ask", text: "今週末の予定はもう決まっていますか？" },
		history: [
			{ who: "user", text: "寒くなってきたね", minAgo: 3, ref: true },
			{ who: "reply", text: "本当ですね。", minAgo: 3 },
			{
				who: "user",
				text: "週末は友だちとキャンプに行くことになったよ",
				minAgo: 0.5,
			},
			{
				who: "reply",
				text: "いいですね！楽しんできてください。",
				minAgo: 0.45,
			},
		],
	},
	{
		name: "right-over",
		want: "drop",
		item: {
			kind: "talk",
			title: "今日の会議の前に押さえたい資料のまとめ方",
			summary: "結論を先に一枚にまとめ、数字は別紙にする。",
		},
		history: [
			{
				who: "user",
				text: "午後に大事な会議があるんだ",
				minAgo: 240,
				ref: true,
			},
			{ who: "reply", text: "がんばってください。", minAgo: 240 },
			{
				who: "user",
				text: "会議はもう終わったよ。なんとか無事にすんだ",
				minAgo: 6,
			},
			{ who: "reply", text: "おつかれさまでした！", minAgo: 5.95 },
		],
	},
	// It should simply speak.
	{
		name: "speak-holiday-old-note",
		want: "speak",
		item: {
			kind: "talk",
			title: "ゴジラ-0.0 川崎の上映館・時間と七里ヶ浜からの行き方",
			summary:
				"川崎ではTOHOシネマズ 川崎が上映中で、11/10(火)の残り上映は20時台以降。休日の土日の時間は確認できなかった。七里ヶ浜からは藤沢経由で川崎へ約1時間。",
		},
		history: [
			{
				who: "user",
				text: "なんなら川崎まで行くよ休日なら",
				minAgo: 2,
				ref: true,
			},
			{
				who: "reply",
				text: "川崎まで行くなら、休日の上映館と時間を調べるよう頼みました。数分でメモにまとめておきます。",
				minAgo: 1.95,
			},
			{
				who: "user",
				text: "ジョギングでは富士山と江の島という絶景があるから楽しめるけど、川崎への道は特にみどころないかな。",
				minAgo: 0.6,
			},
			{
				who: "reply",
				text: "そうですね、映画を観て気分を変えて帰るだけでも、休日のお出かけとして十分だと思います。",
				minAgo: 0.55,
			},
		],
	},
	{
		name: "speak-holiday-new-note",
		want: "speak",
		item: {
			kind: "talk",
			title: "ゴジラ-0.0 川崎周辺の上映館と七里ヶ浜からの行き方メモ",
			summary:
				"川崎では TOHOシネマズ 川崎 などで上映が確認でき、11/10(火)の時刻は分かった。ただし休日(11/14-15)の時刻は確認できなかった。七里ヶ浜から川崎へは電車で約1時間12分〜1時間25分(乗換1回)の経路が見つかった。",
		},
		history: [
			{
				who: "user",
				text: "なんなら川崎まで行くよ休日なら",
				minAgo: 2,
				ref: true,
			},
			{
				who: "reply",
				text: "川崎まで行くなら、休日の上映館と時間を調べるよう頼みました。数分でメモにまとめておきます。",
				minAgo: 1.95,
			},
			{
				who: "user",
				text: "ジョギングでは富士山と江の島という絶景があるから楽しめるけど、川崎への道は特にみどころないかな。",
				minAgo: 0.6,
			},
			{
				who: "reply",
				text: "そうですね、映画を観て気分を変えて帰るだけでも、休日のお出かけとして十分だと思います。",
				minAgo: 0.55,
			},
		],
	},
	{
		name: "speak-engaged",
		want: "speak",
		item: {
			kind: "talk",
			title: "冬キャンプで手が冷えないための小物",
			summary: "薄手のインナー手袋と、使い捨てカイロをポケットに。",
		},
		history: [
			{
				who: "user",
				text: "冬キャンプ、手がかじかむのが心配",
				minAgo: 2,
				ref: true,
			},
			{
				who: "reply",
				text: "手が冷えると作業もしにくいですよね。",
				minAgo: 1.9,
			},
			{ who: "user", text: "そうそう、去年は火起こしで苦労した", minAgo: 0.5 },
			{ who: "reply", text: "それは大変でしたね。", minAgo: 0.45 },
		],
	},
	// ---- Held set (not to be tuned on): the same intents in other words, in everyday topics. ----
	// keep, as "rest-isogashii": no energy for talk in a busy stretch (travel plans), no quiet set.
	{
		name: "held-rest-ryokou",
		set: "held",
		want: "keep",
		item: {
			kind: "talk",
			title: "冬の京都の紅葉スポットと混雑の避け方",
			summary: "朝の早い時間か夕方に回ると混みにくい。",
		},
		history: [
			{
				who: "user",
				text: "来月、京都に行こうと思ってる",
				minAgo: 3,
				ref: true,
			},
			{ who: "reply", text: "いいですね。楽しみですね。", minAgo: 3 },
			{
				who: "user",
				text: "でも今は仕事の山場で、旅行のことまで頭が回らないんだ。落ち着いたら考えるよ",
				minAgo: 0.5,
			},
			{
				who: "reply",
				text: "了解です、無理しないでくださいね。",
				minAgo: 0.45,
			},
		],
	},
	// keep, as "rest-bootto-later": a long night shift, a question to ask later (music).
	{
		name: "held-rest-yakin",
		set: "held",
		want: "keep",
		item: { kind: "ask", text: "最近よく聴く曲はありますか？" },
		history: [
			{ who: "user", text: "今日はレコードを聴いてる", minAgo: 12, ref: true },
			{
				who: "reply",
				text: "いいですね。ゆったりできそうですね。",
				minAgo: 12,
			},
			{
				who: "user",
				text: "夜勤明けで頭がぼんやりしてて、会話する余裕ないわ",
				minAgo: 10,
			},
			{
				who: "reply",
				text: "お疲れさまでした。ゆっくりしてくださいね。",
				minAgo: 9.9,
			},
			{ who: "user", text: "うん、ありがとう", minAgo: 4 },
			{ who: "reply", text: "どういたしまして。", minAgo: 3.95 },
		],
	},
	// keep, as "rest-tsukareta-ask": low after a quarrel (family).
	{
		name: "held-rest-kazoku",
		set: "held",
		want: "keep",
		item: {
			kind: "talk",
			title: "家族の誕生日に作りやすい手作りケーキ",
			summary: "ホットケーキミックスで作るスポンジなら失敗しにくい。",
		},
		history: [
			{
				who: "user",
				text: "今日は家族とちょっとケンカして凹んでる",
				minAgo: 2.5,
				ref: true,
			},
			{ who: "reply", text: "それはつらいですね。", minAgo: 2.4 },
			{
				who: "user",
				text: "いまは誰とも話したくないかも",
				minAgo: 0.5,
			},
			{
				who: "reply",
				text: "わかりました。気持ちが落ち着くといいですね。",
				minAgo: 0.45,
			},
		],
	},
	// keep, as "rest-sotto-ask": no strength left after training (sports).
	{
		name: "held-rest-sport",
		set: "held",
		want: "keep",
		item: { kind: "ask", text: "ランニングは、週に何回くらい走っていますか？" },
		history: [
			{ who: "user", text: "今日は練習で追い込んだ", minAgo: 8, ref: true },
			{ who: "reply", text: "おつかれさまです。", minAgo: 8 },
			{
				who: "user",
				text: "もう体力ゼロ。口を動かす元気もないや",
				minAgo: 7,
			},
			{
				who: "reply",
				text: "ゆっくり休んでくださいね。",
				minAgo: 6.95,
			},
			{ who: "user", text: "うん", minAgo: 3 },
			{ who: "reply", text: "お大事に。", minAgo: 2.95 },
		],
	},
	// keep, as "rest-lull-busy-1": a note offered, turned down for lack of energy (cooking).
	{
		name: "held-rest-lull-cook",
		set: "held",
		want: "keep",
		item: {
			kind: "talk",
			title: "疲れた日の10分で作れる一人ごはん",
			summary: "卵とご飯で作る雑炊や、レンジで作るうどんなど。",
		},
		history: [
			{ who: "user", text: "帰ったよ。今日は残業でぐったり", minAgo: 7 },
			{
				who: "reply",
				text: "おかえりなさい、お疲れさまです。",
				minAgo: 6.95,
			},
			{
				who: "user",
				text: "ごはんを作る気力もないんだよね",
				minAgo: 6,
				ref: true,
			},
			{
				who: "reply",
				text: "今日は無理せず、できる範囲で大丈夫ですよ。",
				minAgo: 5.95,
			},
			{
				who: "reply",
				text: "疲れた日向けの簡単ごはんについて調べたメモがあります。表示しましょうか？",
				minAgo: 2.5,
			},
			{
				who: "user",
				text: "いや、今日は見なくて大丈夫。気力が戻ったらお願いする",
				minAgo: 2,
				ref: true,
			},
			{
				who: "reply",
				text: "わかりました。いつでも声をかけてください。",
				minAgo: 1.95,
			},
		],
	},
	// keep, as "rest-lull-busy-2": the same, with another note (family trip).
	{
		name: "held-rest-lull-onsen",
		set: "held",
		want: "keep",
		item: {
			kind: "talk",
			title: "子連れで行きやすい近場の日帰り温泉",
			summary: "貸切の家族風呂があるところが使いやすい。",
		},
		history: [
			{ who: "user", text: "帰ったよ。今週は子どもの世話で疲れた", minAgo: 9 },
			{
				who: "reply",
				text: "おかえりなさい。お疲れさまです。",
				minAgo: 8.95,
			},
			{
				who: "user",
				text: "週末も予定を立てる元気がなくて",
				minAgo: 7.5,
				ref: true,
			},
			{
				who: "reply",
				text: "無理に立てなくても大丈夫ですよ。",
				minAgo: 7.45,
			},
			{
				who: "reply",
				text: "週末の過ごし方について調べておいた内容があります。詳しいメモを表示しましょうか？",
				minAgo: 4.5,
			},
			{
				who: "user",
				text: "いまは考えられないから、また元気になったらにするよ",
				minAgo: 4,
				ref: true,
			},
			{
				who: "reply",
				text: "わかりました。メモはいつでも表示できます。",
				minAgo: 3.95,
			},
		],
	},
	// drop, as "right-said": the topic was told already (cooking).
	{
		name: "held-right-said",
		set: "held",
		want: "drop",
		item: {
			kind: "talk",
			title: "圧力鍋で作る豚の角煮の時間と火加減",
			summary: "加圧は20分ほど。沸騰したら弱火にする。",
		},
		history: [
			{
				who: "user",
				text: "角煮を作りたいんだけど、時間かかるよね",
				minAgo: 3,
				ref: true,
			},
			{
				who: "reply",
				text: "圧力鍋なら、加圧20分ほどで柔らかくなるそうです。沸騰したら弱火にするのがコツです。",
				minAgo: 2.9,
			},
			{ who: "user", text: "20分でいいんだ、助かる", minAgo: 2.5 },
			{
				who: "reply",
				text: "ぜひ試してみてください。美味しくできるといいですね。",
				minAgo: 2.45,
			},
		],
	},
	// drop, as "right-answered": the question answered by the user (travel).
	{
		name: "held-right-answered",
		set: "held",
		want: "drop",
		item: { kind: "ask", text: "今度の連休は、どこかへ出かける予定ですか？" },
		history: [
			{ who: "user", text: "来週から連休だ〜", minAgo: 3, ref: true },
			{ who: "reply", text: "いいですね。", minAgo: 3 },
			{
				who: "user",
				text: "連休は実家に帰ることにしたよ",
				minAgo: 0.5,
			},
			{
				who: "reply",
				text: "ご家族とゆっくりできるといいですね。",
				minAgo: 0.45,
			},
		],
	},
	// drop, as "right-over": the match the topic was for is over (sports).
	{
		name: "held-right-over",
		set: "held",
		want: "drop",
		item: {
			kind: "talk",
			title: "明日の試合に向けた前日のコンディション調整",
			summary: "睡眠を優先し、前日は軽い運動にとどめる。",
		},
		history: [
			{
				who: "user",
				text: "明日、サッカーの試合なんだ",
				minAgo: 240,
				ref: true,
			},
			{ who: "reply", text: "がんばってください。", minAgo: 240 },
			{
				who: "user",
				text: "試合、終わったよ。2対1で勝てた",
				minAgo: 6,
			},
			{ who: "reply", text: "おめでとうございます！", minAgo: 5.95 },
		],
	},
	// speak, as "speak-engaged": the user is on the topic (cooking).
	{
		name: "held-speak-presscooker",
		set: "held",
		want: "speak",
		item: {
			kind: "talk",
			title: "圧力鍋の安全な使い方の基本",
			summary: "ふたのロックを確認し、水や調味料は規定の量を守る。",
		},
		history: [
			{
				who: "user",
				text: "圧力鍋を買ったんだ。まだ使ったことないけど",
				minAgo: 2,
				ref: true,
			},
			{ who: "reply", text: "楽しみですね。", minAgo: 1.9 },
			{ who: "user", text: "どんな料理から試すのがいいかな", minAgo: 0.5 },
			{ who: "reply", text: "煮込み料理が定番ですね。", minAgo: 0.45 },
		],
	},
	// speak, as "speak-engaged": the user is on the topic (music).
	{
		name: "held-speak-guitar",
		set: "held",
		want: "speak",
		item: {
			kind: "talk",
			title: "初心者向けのギターのチューニングアプリ",
			summary: "スマホのアプリで、弦を弾くだけで音の高さが分かる。",
		},
		history: [
			{
				who: "user",
				text: "ギターを始めたんだけど、音合わせが難しくて",
				minAgo: 2,
				ref: true,
			},
			{ who: "reply", text: "最初は難しいですよね。", minAgo: 1.9 },
			{
				who: "user",
				text: "耳だけだと、合ってるのか全然分からない",
				minAgo: 0.5,
			},
			{ who: "reply", text: "そうですよね。", minAgo: 0.45 },
		],
	},
	// speak, as "speak-engaged": a question that fits what the user just said (reading).
	{
		name: "held-speak-books",
		set: "held",
		want: "speak",
		item: { kind: "ask", text: "最近読んだ本で、面白かったものはありますか？" },
		history: [
			{
				who: "user",
				text: "電車の中で本を読むのが日課になってる",
				minAgo: 2,
				ref: true,
			},
			{ who: "reply", text: "いいですね。", minAgo: 1.9 },
			{
				who: "user",
				text: "通勤が長いから、年に50冊くらい読めるんだ",
				minAgo: 0.5,
			},
			{ who: "reply", text: "すごいですね。", minAgo: 0.45 },
		],
	},
];

interface Trial {
	readonly moment: string;
	readonly want: Want;
	readonly trial: number;
	readonly utterance: string | null;
	/** What the writer gave as the reason, and its kind when the schema has one. */
	readonly declined: string | null;
	readonly why: string | null;
	/** The item afterwards: doing (said), open (kept), dropped. */
	readonly status: string;
}

/** The plan adds the one item; checks are scripted; the compose step is real. */
const benchLlm = (
	real: LlmPort,
	add: PlanOutput,
	seen: (value: Record<string, unknown>) => void,
): LlmPort => {
	let planned = false;
	return {
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
				const value = planned ? { add: [], drop: [] } : add;
				planned = true;
				return { ...zero, value: req.schema.parse(value) };
			}
			if (req.system.includes("質問の聞き直しチェック"))
				return {
					...zero,
					value: req.schema.parse({
						verdicts: (data["candidates"] as { id: string }[]).map((c) => ({
							id: c.id,
							verdict: "new",
							reason: "bench",
						})),
					}),
				};
			if (req.system.includes("重複チェック"))
				return {
					...zero,
					value: req.schema.parse({
						verdict: "new",
						coveredBy: null,
						request: null,
						reason: "bench",
					}),
				};
			const r = await real.complete(req, signal);
			seen(r.value as Record<string, unknown>);
			return r;
		},
	};
};

/** Which moments a run takes (default: all). */
const takes = (m: DeclineMoment, sets: "all" | MomentSet) =>
	sets === "all" || (m.set ?? "tuned") === sets;

async function run(name: string, repeat: number, sets: "all" | MomentSet) {
	const settings = loadSettings(
		resolve(process.env.AGENCY_SETTINGS ?? "config/always-on.json"),
	);
	const meter = openUncappedMeter(settings, resolve("data/agenda/usage.jsonl"));
	const spent = meter.spentUsd();
	const real = createProviderLlm(settings.llm.background, meter);
	mkdirSync(DIR, { recursive: true });
	const jobs = declineMoments
		.filter((m) => takes(m, sets))
		.flatMap((m) =>
			Array.from({ length: repeat }, (_, k) => ({ m, trial: k + 1 })),
		);
	const out: Trial[] = [];
	const one = async ({ m, trial }: (typeof jobs)[number]) => {
		const T = 20_000_000;
		const k = m.history.findIndex((h) => h.ref);
		const refs = k >= 0 ? [`h${k + 1}`] : [];
		const notes: NoteRef[] =
			m.item.kind === "talk"
				? [
						{
							id: "n1",
							title: m.item.title,
							summary: m.item.summary,
							at: T - 60 * 60_000,
							refs,
						},
					]
				: [];
		const add: PlanOutput = {
			add: [
				m.item.kind === "talk"
					? {
							kind: "talk",
							text: `話の流れで調べた「${m.item.title}」の要点`,
							refs: ["note:n1"],
							value: 4,
							reason: "話の流れで調べたことの結果",
							topic: "",
						}
					: {
							kind: "ask",
							text: m.item.text,
							refs,
							value: 3,
							reason: "相手を知るため",
							topic: "",
						},
			],
			drop: [],
			focus: "",
		};
		let value: Record<string, unknown> | null = null;
		const agent = createAgendaAgent({
			llm: benchLlm(real, add, (v) => {
				value = v;
			}),
			// The moment (T) is at 19:33.
			clock: clockFrom(m.clock ?? "2026-11-07T14:00:00+09:00"),
			startedAt: 0,
			known: () => (m.memory ?? []).map((text, i) => ({ id: `m${i}`, text })),
			notes: () => notes,
			profile: () => emptyProfile(),
		});
		const idle = () => ({ busy: false });
		const sig = () => new AbortController().signal;
		const at = (minAgo: number) => T - Math.round(minAgo * 60_000);
		// The item is planned from the first line, while speech is held.
		const first = m.history[0]!;
		agent.observe({
			id: "h1",
			who: first.who,
			text: first.text,
			at: at(first.minAgo),
		});
		agent.setQuiet({ scope: "speech", minutes: 1, at: at(first.minAgo) + 500 });
		await agent.step(at(first.minAgo) + 1_000, idle, sig());
		m.history.slice(1).forEach((h, k) =>
			agent.observe({
				id: `h${k + 2}`,
				who: h.who,
				text: h.text,
				at: at(h.minAgo),
			}),
		);
		const outcome = await agent.step(T, idle, sig());
		const item = agent.view().items.find((i) => i.kind === m.item.kind);
		const speak = outcome.tickets.find((t) => t.kind === "speak");
		const v = value as Record<string, unknown> | null;
		if (!v) throw new Error("the compose step did not run");
		out.push({
			moment: m.name,
			want: m.want,
			trial,
			utterance: speak?.kind === "speak" ? speak.utterance : null,
			declined: outcome.compose?.declined ?? null,
			why:
				typeof v["declineWhy"] === "string"
					? (v["declineWhy"] as string)
					: null,
			status: item?.status ?? "missing",
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
		`${out.length}/${jobs.length} 件、$${(meter.spentUsd() - spent).toFixed(3)}。比較: bun eval/agenda/decline-bench.ts compare ${name}`,
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

const CODE = /^(?:repeat|too_many_questions|either_or)(?:,|$)/u;

/** Met what the moment asks: kept or spoken (keep), dropped or not said (drop), spoken (speak). */
const passes = (t: Trial) => {
	const code = t.declined !== null && CODE.test(t.declined);
	if (t.want === "speak") return t.utterance !== null;
	if (t.want === "keep") return t.status !== "dropped" || code;
	return t.utterance === null && t.status === "dropped" && !code;
};

const SETS: readonly MomentSet[] = ["tuned", "held"];
const SET_LABEL: Record<MomentSet, string> = {
	tuned: "手を入れてよい組",
	held: "見ない組",
};

function compare(names: readonly string[]) {
	const moments = new Map(declineMoments.map((m) => [m.name, m]));
	const setOf = (t: Trial): MomentSet => moments.get(t.moment)?.set ?? "tuned";
	const label: Record<Want, string> = {
		keep: "休みたいだけ（失いたくない）",
		drop: "見送りが正しい",
		speak: "話すべき",
	};
	console.log(
		"| 版 | 組 | 場面 | 試行 | 話した | 見送って残した | 見送って外した | コードが断った（書き直し） |",
	);
	console.log(`| --- | --- | --- |${" ---: |".repeat(5)}`);
	for (const name of names) {
		const trials = load(name);
		for (const g of SETS)
			for (const w of ["keep", "drop", "speak"] as const) {
				const ts = trials.filter((t) => t.want === w && setOf(t) === g);
				if (ts.length === 0) continue;
				const spoke = ts.filter((t) => t.utterance !== null).length;
				const code = ts.filter((t) => t.declined && CODE.test(t.declined));
				const kept = ts.filter(
					(t) =>
						t.utterance === null && t.status === "open" && !code.includes(t),
				).length;
				const gone = ts.filter(
					(t) => t.status === "dropped" && !code.includes(t),
				).length;
				console.log(
					`| ${name} | ${SET_LABEL[g]} | ${label[w]} | ${ts.length} | ${spoke} | ${kept} | ${gone} | ${code.length} |`,
				);
			}
	}
	console.log(
		"\n合格率（休みたいだけ: 外さない。見送りが正しい: 話さず外す。話すべき: 話す）:\n",
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
		"\n場面ごと（S 話した、K 見送って残した、D 見送って外した、R コードが断った。括弧は見送りの種類）:\n",
	);
	console.log(`| 場面 | 組 | ${names.join(" | ")} |`);
	console.log(`| --- | --- |${" --- |".repeat(names.length)}`);
	const runs = names.map(load);
	for (const m of declineMoments) {
		const cells = runs.map((ts) =>
			ts
				.filter((t) => t.moment === m.name)
				.map(
					(t) =>
						(t.utterance !== null
							? "S"
							: t.declined && CODE.test(t.declined)
								? "R"
								: t.status === "dropped"
									? "D"
									: "K") + (t.why ? `(${t.why})` : ""),
				)
				.join(" "),
		);
		// A moment the run did not take (a run of one set) has no trials.
		if (cells.every((c) => c === "")) continue;
		console.log(`| ${m.name} | ${m.set ?? "tuned"} | ${cells.join(" | ")} |`);
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
		const repeat = Number(flag("--repeat") ?? 8);
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
				"usage: decline-bench.ts run <name> [--repeat N] [--set all|tuned|held]",
			);
		await run(name, repeat, sets as "all" | MomentSet);
	} else if (cmd === "compare" && rest.length) compare(rest);
	else
		throw new Error(
			"usage: decline-bench.ts run <name> [--repeat N] [--set all|tuned|held] | compare <name> [<name>...]",
		);
}
