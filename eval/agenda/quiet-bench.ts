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

const DIR = resolve("data/agenda/quiet-bench");

/** What the user's words ask for (the user's decision 2026-11-10: soft words are a short pause). */
type Want = "soft" | "asked" | "said" | "leaving" | "none";

/**
 * tuned: moments the reply may be tuned on (the default); held: made to see whether a fix holds
 * beyond them (the same wish in other words and other topics; no line of the reply's
 * instructions is among them). Do not read these, or tune on them, while changing the reply.
 */
export type MomentSet = "tuned" | "held";

export interface QuietMoment {
	readonly name: string;
	readonly want: Want;
	/** Absent: tuned. */
	readonly set?: "held";
	/** For `said`: the length the words give, in minutes. */
	readonly minutes?: number;
	/** For a pause of everything (「探索を一時停止して」). */
	readonly scope?: "all";
	readonly clock?: string;
	readonly memory?: readonly string[];
	/** The talk before the agent's last words, as in a live run (the reply sees all of it). */
	readonly history?: readonly {
		readonly who: "user" | "reply";
		readonly text: string;
		readonly secAgo: number;
	}[];
	/** The agent's last words before the user's line. */
	readonly agent: string;
	/** How long before the user's line the agent's words came (default 60 s). */
	readonly agentSecAgo?: number;
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
	// Soft words the reply set no pause for (ag48–ag52, 2026-11-10): mostly a no to an offer with a
	// wish to rest, and the next topics were declined and lost (lull, ag51-drop-2).
	{
		name: "miss-isogashii",
		want: "soft",
		agent:
			"忙しい時期の段取りについて調べておいた内容があります。まずは優先順位をつけること、やることを減らすこと、人に任せることを手軽な順に試して、短い区切りや書き出しで気持ちを切り替えるのが現実的だそうです。詳しいメモ、表示しましょうか？",
		user: "今はいいかな。忙しくて話す気分じゃないので、落ち着いたらまた考えます。",
	},
	{
		name: "miss-yasumitai-atode",
		want: "soft",
		agent:
			"会議が続くと疲れがたまりやすい理由を、話の流れで少し調べておきました。連続した会議では注意力や作業記憶が消耗しやすく、切り替えの負担も重なるそうです。詳しくメモにまとめてあるので、表示しましょうか？",
		user: "いまは休みたいから、あとでいいかな。",
	},
	{
		name: "miss-yasumitai-gomen",
		want: "soft",
		agent:
			"ちょっと落ち着いたころに、今日の夜や週末はどんなふうに過ごすことが多いか教えてもらえますか？",
		user: "いまは休みたいので、ごめんなさい。落ち着いたらまた話します。",
	},
	{
		name: "miss-yomu-kini",
		want: "soft",
		agent:
			"さっき話していた、仕事で疲れた日の手軽な回復方法を調べておきました。まずは5分でできることから始めるのが良さそうです。詳しくメモにまとめてあるので、表示しましょうか？",
		user: "ううん、今は疲れてて読む気になれないかな。また今度でいいよ。",
	},
	{
		name: "miss-chotto-yasumitai",
		want: "soft",
		agent:
			"お疲れさまです。話の流れで、疲れた日に試せる数分から30分でできる休み方を調べてまとめてあります。体を動かす、感覚を変える、頭を休ませる、の3方向から選ぶのがコツだそうです。メモを表示しましょうか？",
		user: "んー、今はいいかな。ちょっと休みたいので、また今度でお願いします。",
	},
	{
		name: "miss-mou-tsukareta",
		want: "soft",
		agent:
			"パクチーが苦手なら、お店選びは気をつけますね。ところで、食べ歩きはだいたいどのあたりに行くことが多いですか？",
		user: "うーん、都内の駅の近くが多いかな。でも今日はもう疲れちゃったので、またにしてもらえると助かります。",
	},
	{
		name: "miss-bootto-kibun",
		want: "soft",
		agent:
			"寝る前や休憩中にできる、道具なしで数分でできるストレッチと呼吸法を調べておきました。座ったままでもできる動きと呼吸を組み合わせると、ぼーっとしたい夜に体がゆるみやすいそうです。",
		user: "うん…ありがとう。今はぼーっとしたい気分だから、また今度ね。",
	},
	{
		name: "miss-kiryoku",
		want: "soft",
		agent:
			"焚き火にかけたケトルは、火が強すぎると湯温が上がりすぎることがあるそうです。炭を少し寄せて火を弱めると、コーヒーを淹れやすい湯温に近づけやすいと思います。",
		user: "うーん、静かめのところが多いですかね。人が少ないと落ち着くので。ただ、今は仕事で疲れてて、あんまり話す気力がないかもです。",
	},
	{
		name: "miss-kangaetakunai",
		want: "soft",
		agent:
			"お疲れさまでした。疲れた日は、どんなふうに気持ちを戻すことが多いですか？",
		user: "んー、お風呂に入ってぼーっとすることが多いかな。今日はもう何も考えたくないや。",
	},
	{
		name: "miss-bootto-imawa",
		want: "soft",
		agent:
			"ゆっくりされているところすみません、話の流れで休日を家でのんびり過ごすコツを調べていました。読書や料理、映画などの定番に、五感を整える工夫や予定をゆるく保つことを組み合わせると、家時間の満足度が上がるそうです。詳しいメモがあるので、表示しましょうか？",
		user: "うーん、今はいいかな。ぼーっとしていたいので、また今度でお願いします。",
	},
	{
		name: "miss-hontoni-tsukare",
		want: "soft",
		agent:
			"仕事が立て込んで疲れているなら、道具なしで数分できるストレッチや呼吸法と、寝る前の環境づくりを組み合わせると、体を休ませやすくなるそうです。詳しいメモを表示しましょうか？",
		user: "いや、今は大丈夫。ほんとに疲れてて、考えたくないんだよね。",
	},
	{
		name: "miss-gorogoro",
		want: "soft",
		agent:
			"前に調べていた、家で週末の夜をゆっくり過ごすコツがまとまりました。照明や香り、食事、スマホとの距離を少し整えるだけで、家の夜がぐっと落ち着くそうです。詳しいことはメモにまとめてあるので、表示しましょうか？",
		user: "うーん、今はごろごろしていたいので、また後でで大丈夫です。",
	},
	{
		name: "miss-kono-kurai",
		want: "soft",
		agent:
			"休日はのんびり過ごされるんですね。ふだんのお仕事や生活のリズムは、どんな感じですか？",
		user: "仕事は平日に動いていて、休みはしっかり休む感じです。ふだんの話はあまりしたくないので、今日はこのくらいで大丈夫です。",
	},
	{
		name: "miss-mou-iikana",
		want: "soft",
		agent:
			"家で気分を切り替える方法について調べた要点もまとまりました。短い移動や窓辺で外を眺めること、部屋の模様替えは気分を上向かせる可能性があるそうですが、効果の大きさや続く期間は研究によってばらつきがあるようです。",
		user: "今日はもういいかな。また今度聞かせてください。",
	},
	// The same lines with the whole talk before them, as the live reply saw it (ag48–ag52).
	{
		name: "live-isogashii",
		want: "soft",
		history: [
			{ who: "user", text: "ただいま。今日はちょっと疲れたな", secAgo: 297 },
			{
				who: "reply",
				text: "おかえりなさい。今日はちょっと疲れたんですね。今夜はゆっくり休んでください。話したいことが出てきたら、いつでも聞きます。",
				secAgo: 295,
			},
			{
				who: "reply",
				text: "お疲れさまでした。今日はどんなことで疲れたんですか？",
				secAgo: 281,
			},
			{
				who: "reply",
				text: "疲れた日は、寝る前に画面から少し離れて、ぬるめのお湯に浸かると休みやすいと言われています。はっきり効果が証明されたわけではありませんが、今夜試せそうならどうぞ。",
				secAgo: 267,
			},
			{
				who: "user",
				text: "ちょっと仕事がバタバタしてて。今はまだ話す元気がないかな。",
				secAgo: 256,
			},
			{
				who: "reply",
				text: "わかりました、仕事でバタバタだったんですね。少しのあいだ控えますね。話す元気が戻ったら、いつでも声をかけてください。",
				secAgo: 253,
			},
			{ who: "user", text: "うん、仕事が立て込んでてね", secAgo: 97 },
			{
				who: "reply",
				text: "忙しい時期は、気持ちも体もなかなか休まりませんよね。今は無理に話さなくて大丈夫です。少し落ち着いたら、疲れを抜く方法を調べたメモがあるので、そのときに見てみてください。",
				secAgo: 95,
			},
		],
		agent:
			"忙しい時期の段取りについて調べておいた内容があります。まずは優先順位をつけること、やることを減らすこと、人に任せることを手軽な順に試して、短い区切りや書き出しで気持ちを切り替えるのが現実的だそうです。詳しいメモ、表示しましょうか？",
		agentSecAgo: 20,
		user: "今はいいかな。忙しくて話す気分じゃないので、落ち着いたらまた考えます。",
	},
	{
		name: "live-yasumitai-atode",
		want: "soft",
		history: [
			{ who: "user", text: "ただいま。今日はちょっと疲れたな", secAgo: 303 },
			{
				who: "reply",
				text: "おかえりなさい。今日は疲れたんですね。ゆっくり休めましたか？無理せず、話したいことがあったら聞かせてください。",
				secAgo: 296,
			},
			{
				who: "reply",
				text: "さっきは疲れたと言っていましたね。今日いちばん疲れたのは、どんなことでしたか？",
				secAgo: 282,
			},
			{
				who: "user",
				text: "んー、仕事で会議が続いてへとへとで。今はちょっと休みたいかな。",
				secAgo: 262,
			},
			{
				who: "reply",
				text: "会議が続いたなら、へとへとになりますよね。少しのあいだ控えますね。ゆっくり休んでください。",
				secAgo: 259,
			},
			{ who: "user", text: "うん、仕事が立て込んでてね", secAgo: 103 },
			{
				who: "reply",
				text: "仕事が立て込んでいると、気持ちも体も休まりにくいですよね。前に調べておいた、短時間でできる疲れの回復法（呼吸を整える、軽く体を動かす、水分をとる、短く休む）も、落ち着いたときに使えるかもしれません。疲れたときは、どんなふうに気分を戻すのが好きですか？",
				secAgo: 101,
			},
		],
		agent:
			"会議が続くと疲れがたまりやすい理由を、話の流れで少し調べておきました。連続した会議では注意力や作業記憶が消耗しやすく、切り替えの負担も重なるそうです。詳しくメモにまとめてあるので、表示しましょうか？",
		agentSecAgo: 20,
		user: "いまは休みたいから、あとでいいかな。",
	},
	{
		name: "live-hontoni-tsukare",
		want: "soft",
		history: [
			{ who: "user", text: "ただいま。今日はちょっと疲れたな", secAgo: 225 },
			{
				who: "reply",
				text: "おかえりなさい。今日は疲れたんですね。無理に話さなくても大丈夫ですし、話したくなったら聞かせてください。ゆっくり休んでくださいね。",
				secAgo: 222,
			},
			{
				who: "reply",
				text: "ゆっくり休めそうなときに、好きな過ごし方や、最近ほっとできたことがあれば聞いてみたいです。",
				secAgo: 209,
			},
			{
				who: "user",
				text: "うーん、今日はほんとに疲れてて、ちょっと今は考えられないかな。また落ち着いたらね。",
				secAgo: 164,
			},
			{
				who: "reply",
				text: "わかりました、今はそっとしておきますね。ゆっくり休んでください。落ち着いたら、いつでも声をかけてください。",
				secAgo: 159,
			},
			{ who: "user", text: "うん、仕事が立て込んでてね", secAgo: 25 },
			{
				who: "reply",
				text: "お仕事が立て込んでいたんですね。今日はかなり気を張っていたのかもしれません。今は何も考えず、体を休めることを優先してください。",
				secAgo: 23,
			},
		],
		agent:
			"仕事が立て込んで疲れているなら、道具なしで数分できるストレッチや呼吸法と、寝る前の環境づくりを組み合わせると、体を休ませやすくなるそうです。詳しいメモを表示しましょうか？",
		agentSecAgo: 8,
		user: "いや、今は大丈夫。ほんとに疲れてて、考えたくないんだよね。",
	},
	{
		name: "live-bootto-imawa",
		want: "soft",
		history: [
			{ who: "user", text: "今日は休み。家でのんびりしてる", secAgo: 917 },
			{
				who: "reply",
				text: "いいですね、土曜の夜を家でのんびり過ごせるのは贅沢な時間だと思います。今日は特に何か調べたいことや、頼みたいことはありますか？何もなければ、ゆっくりしてくださいね。",
				secAgo: 914,
			},
			{
				who: "reply",
				text: "家でゆっくり過ごせているんですね。休みの日にのんびりするとき、いつも好きなことや楽しみにしていることはありますか？",
				secAgo: 900,
			},
			{
				who: "user",
				text: "うーん、特にないかな。今日はただぼーっとしてたい気分で。",
				secAgo: 888,
			},
			{
				who: "reply",
				text: "わかりました、少しのあいだ控えますね。ぼーっとする時間も、休日にはちゃんと意味があると思います。話したくなったら、いつでも声をかけてください。",
				secAgo: 883,
			},
			{ who: "user", text: "うん", secAgo: 317 },
			{ who: "reply", text: "うん、ゆっくりどうぞ。", secAgo: 316 },
		],
		agent:
			"ゆっくりされているところすみません、話の流れで休日を家でのんびり過ごすコツを調べていました。読書や料理、映画などの定番に、五感を整える工夫や予定をゆるく保つことを組み合わせると、家時間の満足度が上がるそうです。詳しいメモがあるので、表示しましょうか？",
		agentSecAgo: 12,
		user: "うーん、今はいいかな。ぼーっとしていたいので、また今度でお願いします。",
	},
	// Not a request: a no to the note alone, a topic for later, a wish for fewer questions (never
	// a reason to speak less: user, 2026-11-09).
	{
		name: "memo-only",
		want: "none",
		agent:
			"防寒の調べものがまとまりました。寝袋は温度表示に余裕を持って選び、地面からの冷えとテント内の結露対策を重点的にすると快適に過ごしやすいそうです。詳しいメモを表示しましょうか？",
		user: "えっ、もうまとまったんですか。寝袋は温度表示に余裕を持って選ぶんですね。詳しいメモは、今はいいかな、また今度見ます。",
	},
	{
		name: "topic-later",
		want: "none",
		agent:
			"お待たせしました。辛いラーメンの辛さの表し方と、激辛ラーメンの流れを調べてみました。店ごとの段階表記や唐辛子・花椒などの材料で表されることが多く、激辛ブームは辛さを競う楽しみ方として広がってきたようです。詳しいメモを表示しましょうか？",
		user: "へえ、辛さの表し方や激辛ブームの話、面白そうですね。ただ、詳しいメモはいまは大丈夫です。モンハンの方が気になるので、あとで軽く教えてください。",
	},
	{
		name: "hodohodo",
		want: "none",
		agent:
			"リオレウス戦で斧モードの溜め斬りを狙うなら、どんな場面で溜めるのが多いですか？",
		user: "溜めるのは、レウスが空から降りてきて着地した直後の隙が多いですね。ただ、あんまり質問攻めされると疲れちゃうので、ほどほどにお願いします。",
	},
	// ---- Held set (not to be tuned on): the same wishes in other words, in everyday topics. ----
	// Soft: "give me a moment, my hands are full" (cooking).
	{
		name: "held-soft-ryori",
		set: "held",
		want: "soft",
		agent: "今夜の晩ごはんは、もう献立を決めていますか？",
		user: "うーん、まだ。いま包丁持ってるから、ちょっと間をあけてもらえると助かる。",
	},
	// Soft: "I am listening, leave me for a while" (music).
	{
		name: "held-soft-ongaku",
		set: "held",
		want: "soft",
		agent: "最近よく聴いているアルバムはありますか？",
		user: "昔のジャズばっかりかな。あ、ごめん、いまちょうど聴き入ってるところだから、少し間をおいてくれると嬉しい。",
	},
	// Soft: a sick child (family), asked to ease off until things calm down.
	{
		name: "held-soft-kazoku",
		set: "held",
		want: "soft",
		agent: "週末は、ご家族でお出かけの予定ですか？",
		user: "子どもが熱出しててそれどころじゃないんだよね。落ち着くまでは控えめにしてもらえると助かる。",
	},
	// Soft: worn out after a race (sports), will talk again when recovered.
	{
		name: "held-soft-sport",
		set: "held",
		want: "soft",
		agent: "昨日のマラソン大会は、完走できましたか？",
		user: "完走はしたけど、足がパンパンで今は何も頭に入らないや。元気になったらまた話すね。",
	},
	// Soft: declining an offered note with a wish to rest (appliances).
	{
		name: "held-soft-memo",
		set: "held",
		want: "soft",
		agent:
			"洗濯機の乾燥機能の電気代について調べたメモがあります。使い方によって月に数百円ほど違うそうです。表示しましょうか？",
		user: "ううん、今は見る余裕がないや。落ち着いてからにするよ。",
	},
	// Asked: close your mouth until I call (work).
	{
		name: "held-asked-report",
		set: "held",
		want: "asked",
		agent: "今日の仕事は、もう一段落しましたか？",
		user: "いまからレポート書くから、こっちが呼ぶまで口を閉じてて。",
	},
	// Asked: leave me alone, no reply needed (cooking).
	{
		name: "held-asked-hitori",
		set: "held",
		want: "asked",
		agent: "圧力鍋のレシピも、いくつか探しておきましょうか？",
		user: "今はひとりにして。返事もいらない。",
	},
	// Said: forty-five minutes (sports).
	{
		name: "held-said-45",
		set: "held",
		want: "said",
		minutes: 45,
		agent: "今日のランニングは、何キロ走る予定ですか？",
		user: "45分は声かけないでもらえる？ ストレッチするから。",
	},
	// Said: until three o'clock (travel / the afternoon).
	{
		name: "held-said-3ji",
		set: "held",
		want: "said",
		minutes: 60,
		clock: "2026-11-07T14:00:00+09:00",
		agent: "午後は、どこかへ出かけますか？",
		user: "3時までは静かにしといて。",
	},
	// Leaving: off to work in the morning.
	{
		name: "held-leaving-shigoto",
		set: "held",
		want: "leaving",
		clock: "2026-11-08T07:30:00+09:00",
		agent: "今日のお弁当は、もう用意しましたか？",
		user: "うん、作った。じゃ、仕事行ってくる。",
	},
	// Leaving: going to bed.
	{
		name: "held-leaving-nemui",
		set: "held",
		want: "leaving",
		clock: "2026-11-07T23:45:00+09:00",
		agent: "明日の朝ごはんは、いつもどんな感じですか？",
		user: "眠くなってきたから、今日は寝るわ。また明日。",
	},
	// None: takes up a fact (cooking).
	{
		name: "held-none-kakuni",
		set: "held",
		want: "none",
		agent: "圧力鍋は、煮込み料理の時間をぐっと短くできて便利だそうですよ。",
		user: "ふーん、便利なんだね。今度使ってみようかな。",
	},
	// None: turns a research offer down for a reason (travel), no wish for quiet.
	{
		name: "held-none-yado",
		set: "held",
		want: "none",
		agent: "来月の京都旅行の宿も、調べておきましょうか？",
		user: "宿は友人が押さえてくれてるから、そこは頼まなくて平気だよ。",
	},
	// None: mentions being busy but asks for more (music).
	{
		name: "held-none-gen",
		set: "held",
		want: "none",
		agent: "ギターの弦は、どのくらいの頻度で替えていますか？",
		user: "半年に一回くらいかな。最近は仕事が忙しくて弾けてないけど。弦の選び方も調べてくれる？",
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

/** Which moments a run takes (default: all). */
const takes = (m: QuietMoment, sets: "all" | MomentSet) =>
	sets === "all" || (m.set ?? "tuned") === sets;

async function run(name: string, repeat: number, sets: "all" | MomentSet) {
	const settings = loadSettings(
		resolve(process.env.AGENCY_SETTINGS ?? "config/always-on.json"),
	);
	const meter = openUncappedMeter(settings, resolve("data/agenda/usage.jsonl"));
	const spent = meter.spentUsd();
	mkdirSync(DIR, { recursive: true });
	const jobs = quietMoments
		.filter((m) => takes(m, sets))
		.flatMap((m) =>
			Array.from({ length: repeat }, (_, k) => ({ m, trial: k + 1 })),
		);
	const out: Trial[] = [];
	const one = async ({ m, trial }: (typeof jobs)[number]) => {
		const clockAt = clockFrom(m.clock ?? "2026-11-07T19:00:00+09:00");
		// Past a live talk's length when there is one (the user's line comes at 19:10 or 20:00).
		const t0 = m.history ? 3_600_000 : 600_000;
		const agent = createAgendaAgent({
			llm: noLlm,
			clock: clockAt,
			startedAt: 0,
		});
		if (m.history)
			m.history.forEach((h, k) =>
				agent.observe({
					id: `h${k}`,
					who: h.who,
					text: h.text,
					at: t0 - h.secAgo * 1000,
				}),
			);
		else agent.observe({ id: "u0", who: "user", text: "こんばんは", at: 0 });
		agent.observe({
			id: "r0",
			who: "reply",
			text: m.agent,
			at: t0 - (m.agentSecAgo ?? 60) * 1000,
		});
		agent.observe({ id: "u1", who: "user", text: m.user, at: t0 });
		// A reply port takes one call at a time: one per trial.
		const chat = createProviderReply(
			settings.llm.main,
			meter,
			clientFor(settings.llm.main),
		);
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
				// The agent's words offer a note: it is there (else the reply apologizes for it).
				notes: /表示しましょうか|メモ|調べておき|まとま/u.test(m.agent)
					? [
							{
								id: "n1",
								title: "話の流れで調べたこと",
								summary: m.agent,
								at: t0 - 5 * 60_000,
								refs: [],
							},
						]
					: [],
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

/** The wish was met: a quiet period for what asked for one (of the length said), none for the rest. */
const passes = (t: Trial, m: QuietMoment | undefined) => {
	const q = last(t);
	const set = q !== null && q.minutes > 0;
	if (t.want === "none") return !set;
	if (!set) return false;
	if (t.want === "said") return Math.abs(q.minutes - (m?.minutes ?? -1)) <= 10;
	return t.want === "leaving" || !t.longPromise;
};

const SETS: readonly MomentSet[] = ["tuned", "held"];
const SET_LABEL: Record<MomentSet, string> = {
	tuned: "手を入れてよい組",
	held: "見ない組",
};

function compare(names: readonly string[]) {
	const wants: Want[] = ["soft", "asked", "said", "leaving", "none"];
	const label: Record<Want, string> = {
		soft: "やわらかい言葉",
		asked: "長さなしの依頼",
		said: "長さを言った",
		leaving: "離れる",
		none: "依頼なし",
	};
	const moments = new Map(quietMoments.map((m) => [m.name, m]));
	const setOf = (t: Trial): MomentSet => moments.get(t.moment)?.set ?? "tuned";
	console.log(
		"| 版 | 組 | 言い方 | 件数 | 静かにした | 長さの中央値（分） | 長さの範囲（分） | 長く黙る約束の言葉 | 言った長さと合う（said） | 全部止める（scope=all） |",
	);
	console.log(`| --- | --- | --- |${" ---: |".repeat(7)}`);
	for (const name of names) {
		const trials = load(name);
		for (const g of SETS)
			for (const w of wants) {
				const ts = trials.filter((t) => t.want === w && setOf(t) === g);
				if (ts.length === 0) continue;
				const set = ts.filter((t) => last(t) && last(t)!.minutes > 0);
				const mins = set.map((t) => last(t)!.minutes);
				const fits =
					w === "said"
						? `${set.filter((t) => Math.abs(last(t)!.minutes - (moments.get(t.moment)?.minutes ?? -1)) <= 10).length}/${ts.length}`
						: "-";
				const all = set.filter((t) => last(t)!.scope === "all").length;
				console.log(
					`| ${name} | ${SET_LABEL[g]} | ${label[w]} | ${ts.length} | ${set.length} | ${median(mins) ?? "-"} | ${mins.length ? `${Math.min(...mins)}〜${Math.max(...mins)}` : "-"} | ${ts.filter((t) => t.longPromise).length} | ${fits} | ${all} |`,
				);
			}
	}
	console.log(
		"\n合格率（静かにすべき言い方は静かにし、長さが合い、長く黙る約束をしない。依頼なしは静かにしない）:\n",
	);
	console.log("| 版 | 組 | 合格 | 試行 | 率 |");
	console.log("| --- | --- | ---: | ---: | ---: |");
	for (const name of names) {
		const trials = load(name);
		for (const g of SETS) {
			const ts = trials.filter((t) => setOf(t) === g);
			if (ts.length === 0) continue;
			const ok = ts.filter((t) => passes(t, moments.get(t.moment))).length;
			console.log(
				`| ${name} | ${SET_LABEL[g]} | ${ok} | ${ts.length} | ${((100 * ok) / ts.length).toFixed(0)}% |`,
			);
		}
	}
	console.log("\n場面ごと（静かにした長さ、分。- は呼ばなかった）:\n");
	console.log(`| 場面 | 組 | 言い方 | ${names.join(" | ")} |`);
	console.log(`| --- | --- | --- |${" --- |".repeat(names.length)}`);
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
		// A moment the run did not take (a run of one set) has no trials: shown as blanks.
		if (cells.every((c) => c === "")) continue;
		console.log(
			`| ${m.name} | ${m.set ?? "tuned"} | ${m.want} | ${cells.join(" | ")} |`,
		);
	}
	console.log(
		"\n（a は scope=all、! は返事が長く黙る約束の言葉（今日は・今夜は・話しかけません など）を含む）",
	);
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
				"usage: quiet-bench.ts run <name> [--repeat N] [--set all|tuned|held]",
			);
		await run(name, repeat, sets as "all" | MomentSet);
	} else if (cmd === "compare" && rest.length) compare(rest);
	else
		throw new Error(
			"usage: quiet-bench.ts run <name> [--repeat N] [--set all|tuned|held] | compare <name> [<name>...]",
		);
}
