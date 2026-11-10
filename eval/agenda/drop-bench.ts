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

/**
 * tuned: moments the plan may be tuned on (the default); held: the same intents in other words and
 * other topics, to see whether a fix holds beyond them. Not to be read or tuned on.
 */
export type MomentSet = "tuned" | "held";

export interface DropMoment {
	readonly name: string;
	/** Absent: tuned. */
	readonly set?: "held";
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

// The held set's topics: everyday ones (cooking, work, travel, home), none of the tuned set's.
const heldTopics = homeNotes(
	["okazu", "平日の夜に作り置きできる簡単おかず"],
	["commute", "朝の通勤が楽になる持ち物の整え方"],
	["music", "休みの日に聴きたいおだやかな音楽"],
);
const heldLaterTopics = [
	...heldTopics,
	...homeNotes(["knit", "家で少しずつ進められる編みものの始め方"]),
];
const heldAsk: BenchItem = {
	key: "ask-cooking",
	kind: "ask",
	text: "最近はまっている料理はありますか？",
	expect: "keep",
};
const EARLIER_TOMATO =
	"ベランダでのトマト栽培の基本（苗の選び方、水やり、支柱）を調べ、初心者向けにまとめる";
const MINI_TOMATO =
	"ミニトマトのベランダ栽培を改めて調べ、前のメモ（普通のトマト）とは別の品種としてまとめる";
const TOMATO_TALK =
	"ベランダでのトマト栽培について調べました。苗は葉の色が濃いものを選び、水やりは土の表面が乾いてからたっぷりが基本だそうです。詳細をメモにまとめてあるので、表示しましょうか？";
const tomatoNotes: readonly BenchItem[] = [
	{
		key: "tomato",
		kind: "talk",
		text: "ベランダでのトマト栽培の基本と水やりの頻度",
		expect: "any",
	},
	...homeNotes(["washer", "洗濯機の乾燥機能の電気代と時短のコツ"]),
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
	// ---- Held set (not to be tuned on): the same intents in other words, in everyday topics. ----
	// rest, as "rest-bootto": no head for anything (work).
	{
		name: "held-rest-atama",
		set: "held",
		group: "rest",
		items: [...heldTopics, heldAsk],
		agent: "今日の夕飯は、もう決めていますか？",
		user: "いまは頭が回らないから、ひと息つかせて",
		reply: "わかりました。少しのあいだ控えますね。",
	},
	// rest, as "rest-tsukareta": too tired to talk (work).
	{
		name: "held-rest-shindoi",
		set: "held",
		group: "rest",
		items: [...heldTopics, heldAsk],
		agent: "最近、お仕事は落ち着いていますか？",
		user: "ちょっと今日はしんどくて、会話する気力がないや",
		reply: "お疲れさまです。少しのあいだ控えますね。",
	},
	// rest, as "rest-matte": busy for a moment (family).
	{
		name: "held-rest-nekashi",
		set: "held",
		group: "rest",
		items: [...heldTopics, heldAsk],
		agent: "休みの日は、どんなふうに過ごすことが多いですか？",
		user: "いま子どもを寝かしつけてるところだから、またのちほどね",
		reply: "了解です。少しのあいだ控えますね。",
	},
	// rest, as "rest-nonbiri": wants a quiet evening (music).
	{
		name: "held-rest-shizuka",
		set: "held",
		group: "rest",
		items: [...heldTopics, heldAsk],
		agent: "音楽を聴きながら作業するのは、お好きですか？",
		user: "今日はもう静かに過ごしたい気分なんだ",
		reply: "いいですね。少しのあいだ控えますね。",
	},
	// later, as "later-bootto": nothing on the mind (commute), thirteen minutes on a result comes in.
	{
		name: "held-later-nanimo",
		set: "held",
		group: "later",
		items: [...heldLaterTopics, heldAsk],
		agent: "仕事帰りに寄り道することはありますか？",
		user: "今日はなんにも考えたくない気分",
		reply: "わかりました。少しのあいだ、こちらからは控えておきますね。",
	},
	// later, as "later-yasumitai": a headache, taking it easy (health).
	{
		name: "held-later-zutsu",
		set: "held",
		group: "later",
		items: [...heldLaterTopics, heldAsk],
		agent: "最近、体調はいかがですか？",
		user: "ちょっと頭痛がするので、今日はおとなしくしてる",
		reply: "お大事にしてください。少しのあいだ控えますね。",
	},
	// promise, as "promise-dup-now": a request that looks like an earlier note's (tomato, then
	// cherry tomato); another research is running.
	{
		name: "held-promise-dup-now",
		set: "held",
		group: "promise",
		items: [...tomatoNotes],
		requests: [{ key: "mini-tomato", text: MINI_TOMATO, expect: "keep" }],
		earlier: { text: EARLIER_TOMATO, noteKey: "tomato" },
		running: "新しい洗濯機の乾燥機能の電気代を、機種ごとに比べる",
		agent: TOMATO_TALK,
		user: "トマトじゃなくて、ミニトマトの方を育てたいんだよね",
		reply:
			"ミニトマトのほうでしたね。ミニトマトの育て方を、改めて調べるよう頼みました。今の調べものが終わったらメモにまとめます。",
	},
	// promise, as "promise-dup-later": the same, and the user goes on to another thing.
	{
		name: "held-promise-dup-later",
		set: "held",
		group: "promise",
		items: [...tomatoNotes],
		requests: [{ key: "mini-tomato", text: MINI_TOMATO, expect: "keep" }],
		earlier: { text: EARLIER_TOMATO, noteKey: "tomato" },
		running: "新しい洗濯機の乾燥機能の電気代を、機種ごとに比べる",
		agent: TOMATO_TALK,
		user: "トマトじゃなくて、ミニトマトの方を育てたいんだよね",
		reply:
			"ミニトマトのほうでしたね。ミニトマトの育て方を、改めて調べるよう頼みました。今の調べものが終わったらメモにまとめます。",
		next: {
			user: "ベランダは南向きで、日当たりは良い方だよ",
			reply: "それなら育てやすそうですね。",
		},
	},
	// promise, as "promise-cancel": asked for, then called off (travel).
	{
		name: "held-promise-cancel",
		set: "held",
		group: "promise",
		items: homeNotes(["okazu", "平日の夜に作り置きできる簡単おかず"]),
		requests: [
			{
				key: "kyoto",
				text: "京都の紅葉の見頃と混雑する時間帯を調べてまとめる",
				expect: "drop",
			},
		],
		agent: "来月の旅行先は、もう決めていますか？",
		user: "京都の紅葉の見頃を調べておいて",
		reply:
			"わかりました。京都の紅葉の見頃と混雑する時間帯を調べるよう頼みました。",
		next: {
			user: "ごめん、やっぱり京都はやめて温泉にした。紅葉の調べものは取り下げるね",
			reply: "わかりました、京都の紅葉の件は取り下げますね。",
		},
	},
	// right, as "right-declined": a topic turned down for good (cooking).
	{
		name: "held-right-declined",
		set: "held",
		group: "right",
		items: [
			{
				key: "curry",
				kind: "talk",
				text: "スパイスカレーの新しいお店",
				expect: "drop",
			},
			...homeNotes(
				["okazu", "平日の夜に作り置きできる簡単おかず"],
				["music", "休みの日に聴きたいおだやかな音楽"],
			),
		],
		agent:
			"スパイスカレーの話の続きですが、新しいお店の情報がまとまりました。表示しましょうか？",
		user: "カレーの話題はもう結構です。当分いらないな",
		reply: "わかりました、カレーの話はここまでにしますね。",
	},
	// right, as "right-correction": a taste that changed (ramen to a salt-free diet).
	{
		name: "held-right-correction",
		set: "held",
		group: "right",
		items: [
			{
				key: "ramen-new",
				kind: "talk",
				text: "味の濃いラーメンの新しい店",
				expect: "drop",
			},
			{
				key: "izakaya",
				kind: "talk",
				text: "塩気の強い居酒屋つまみの人気メニュー",
				expect: "drop",
			},
			...homeNotes(["dashi", "減塩でも満足できる出汁の取り方"]),
		],
		agent:
			"味の濃いものがお好きなんですよね。最近食べた中で一番濃かったのは何ですか？",
		user: "実は健診で引っかかって、最近は減塩中で濃い味は避けてるんだ",
		reply: "そうだったんですね。体をいたわってくださいね。",
		memory: ["味の濃い料理が好き"],
	},
	// right, as "right-answered": the question answered (dinner).
	{
		name: "held-right-answered",
		set: "held",
		group: "right",
		items: [
			{
				key: "ask-dinner",
				kind: "ask",
				text: "今夜の晩ごはんは、もう決まっていますか？",
				expect: "drop",
			},
			...homeNotes(
				["okazu", "平日の夜に作り置きできる簡単おかず"],
				["music", "休みの日に聴きたいおだやかな音楽"],
			),
		],
		agent: "お腹がすく時間ですね。",
		user: "今夜は餃子にするって決めたよ",
		reply: "いいですね！餃子、美味しくできるといいですね。",
	},
	// right, as "right-over": the day it was for is over (an interview).
	{
		name: "held-right-over",
		set: "held",
		group: "right",
		items: [
			{
				key: "interview",
				kind: "talk",
				text: "今日の面接の前に確認したい自己紹介の整え方",
				expect: "drop",
			},
			...homeNotes(
				["commute", "朝の通勤が楽になる持ち物の整え方"],
				["music", "休みの日に聴きたいおだやかな音楽"],
			),
		],
		agent: "おかえりなさい。今日の面接はどうでしたか？",
		user: "面接、終わったよ。ひと安心",
		reply: "おつかれさまでした！ひと安心ですね。",
		memory: ["今日の午後に面接がある"],
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
				: {
						utterance: null,
						decline: "bench",
						emotion: null,
						questions: 0,
						choice: false,
					};
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
					topic: "",
				})),
				...asks.slice(k, k + 2).map((i) => ({
					kind: "ask" as const,
					text: i.text,
					refs: [],
					value: 3,
					reason: "相手を知るため",
					topic: "",
				})),
			],
			drop: [],
			focus: "",
		});
	return out;
};

/** Which moments a run takes (default: all). */
const takes = (m: DropMoment, sets: "all" | MomentSet) =>
	sets === "all" || (m.set ?? "tuned") === sets;

async function run(name: string, repeat: number, sets: "all" | MomentSet) {
	const settings = loadSettings(
		resolve(process.env.AGENCY_SETTINGS ?? "config/always-on.json"),
	);
	const meter = openUncappedMeter(settings, resolve("data/agenda/usage.jsonl"));
	const spent = meter.spentUsd();
	const real = createProviderLlm(settings.llm.background, meter);
	mkdirSync(DIR, { recursive: true });
	const jobs = dropMoments
		.filter((m) => takes(m, sets))
		.flatMap((m) =>
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

const SETS: readonly MomentSet[] = ["tuned", "held"];
const SET_LABEL: Record<MomentSet, string> = {
	tuned: "手を入れてよい組",
	held: "見ない組",
};

function compare(names: readonly string[]) {
	const moments = new Map(dropMoments.map((m) => [m.name, m]));
	const setOf = (t: Trial): MomentSet => moments.get(t.moment)?.set ?? "tuned";
	/** Items the plan was right or wrong about in a trial: kept ones not dropped, due ones dropped. */
	const tally = (t: Trial) => {
		const m = moments.get(t.moment)!;
		const gone = new Set(t.dropped.map((d) => d.key));
		let keep = 0;
		let keepDropped = 0;
		let due = 0;
		let dueDropped = 0;
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
		return { keep, keepDropped, due, dueDropped };
	};
	console.log(
		"| 版 | 組 | 場面 | 試行 | 残すべき項目を外した | 外すべき項目を外した | 掘り下げ中（nothingToSay） |",
	);
	console.log(`| --- | --- | --- |${" ---: |".repeat(4)}`);
	for (const name of names) {
		const trials = load(name);
		for (const s of SETS)
			for (const g of ["rest", "later", "right", "promise"] as const) {
				const ts = trials.filter((t) => t.group === g && setOf(t) === s);
				if (ts.length === 0) continue;
				let keep = 0;
				let keepDropped = 0;
				let due = 0;
				let dueDropped = 0;
				for (const t of ts) {
					const x = tally(t);
					keep += x.keep;
					keepDropped += x.keepDropped;
					due += x.due;
					dueDropped += x.dueDropped;
				}
				console.log(
					`| ${name} | ${SET_LABEL[s]} | ${{ rest: "休みたいだけ（直後）", later: "休みたいだけ（13分後に結果）", right: "外すのが正しい", promise: "頼まれた調べもの" }[g]} | ${ts.length} | ${keepDropped}/${keep} | ${due ? `${dueDropped}/${due}` : "-"} | ${ts.filter((t) => t.nothingToSay).length} |`,
				);
			}
	}
	console.log(
		"\n合格率（項目ごと。残すべき項目を外さない、外すべき項目を外す）:\n",
	);
	console.log("| 版 | 組 | 合格 | 項目 | 率 |");
	console.log("| --- | --- | ---: | ---: | ---: |");
	for (const name of names) {
		const trials = load(name);
		for (const s of SETS) {
			let ok = 0;
			let all = 0;
			for (const t of trials.filter((x) => setOf(x) === s)) {
				const x = tally(t);
				ok += x.keep - x.keepDropped + x.dueDropped;
				all += x.keep + x.due;
			}
			if (all === 0) continue;
			console.log(
				`| ${name} | ${SET_LABEL[s]} | ${ok} | ${all} | ${((100 * ok) / all).toFixed(0)}% |`,
			);
		}
	}
	console.log("\n場面ごと（外した項目。- は何も外さなかった）:\n");
	console.log(`| 場面 | 組 | ${names.join(" | ")} |`);
	console.log(`| --- | --- |${" --- |".repeat(names.length)}`);
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
		const repeat = Number(flag("--repeat") ?? 4);
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
				"usage: drop-bench.ts run <name> [--repeat N] [--set all|tuned|held]",
			);
		await run(name, repeat, sets as "all" | MomentSet);
	} else if (cmd === "compare" && rest.length) compare(rest);
	else
		throw new Error(
			"usage: drop-bench.ts run <name> [--repeat N] [--set all|tuned|held] | compare <name> [<name>...]",
		);
}
