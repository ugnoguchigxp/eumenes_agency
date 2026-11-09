/**
 * Moments for the talk bench (talk-bench.ts): a user, what they said a few minutes ago, what the
 * agent knows about them, and one research the agent had done for them. The bench has the
 * researcher write each note once from the web and then lets the agent bring it up, so two
 * versions of the agent meet the same moments and the same notes.
 */

export interface TalkSituation {
	readonly name: string;
	/** The simulated user (eval/agenda/user.ts). */
	readonly persona: string;
	/** Local time of the talk. */
	readonly clock: string;
	/** Earlier words, oldest first; the last user words are a few minutes old (no talk in flight). */
	readonly history: readonly {
		readonly who: "user" | "reply";
		readonly text: string;
		readonly minAgo: number;
	}[];
	readonly memory: readonly string[];
	readonly plans?: readonly string[];
	readonly interests?: readonly string[];
	/** What was asked of the researcher. */
	readonly research: string;
	/** The talk as the plan would add it. */
	readonly talk: { readonly text: string; readonly reason: string };
}

export const talkSituations: readonly TalkSituation[] = [
	{
		name: "hakone",
		persona:
			"30代の会社員。12月に箱根へひとりで一泊の温泉旅行をしようと考えていて、宿はまだ決めていない。温泉が好き。話しかけられれば普通に答える。",
		clock: "2026-11-08T20:10:00+09:00",
		history: [
			{
				who: "user",
				text: "来月、箱根に一泊で温泉旅行に行こうと思ってるんだ。ひとりでのんびりしたくて",
				minAgo: 9,
			},
			{
				who: "reply",
				text: "いいですね、ひとりでのんびりの温泉旅行。宿はもう決まっていますか？",
				minAgo: 9,
			},
			{ who: "user", text: "まだ。これから探す", minAgo: 8 },
			{
				who: "reply",
				text: "分かりました。ひとり旅で泊まりやすい宿を調べておきますね。",
				minAgo: 8,
			},
		],
		memory: ["温泉が好き"],
		plans: ["12月に箱根へ一泊の温泉旅行を考えている。ひとり旅。宿は未定"],
		research:
			"12月の箱根で、ひとり旅で泊まりやすい露天風呂付きの温泉宿の候補と、予約の目安を調べ、結論をまとめる",
		talk: {
			text: "箱根のひとり旅向けの温泉宿の候補を話題にする",
			reason: "予定の下調べができた",
		},
	},
	{
		name: "winter-camp",
		persona:
			"30代の会社員。キャンプとコーヒーが好き。冬キャンプに興味が出てきたが、まだ行ったことはない。自分からはあまり話さない。",
		clock: "2026-11-07T21:00:00+09:00",
		history: [
			{
				who: "user",
				text: "最近は冬キャンプにちょっと興味があるんだよね。寒そうだけど",
				minAgo: 7,
			},
			{
				who: "reply",
				text: "冬キャンプ、空気が澄んでいて星もきれいだと聞きますね。寒さが気になるところですか？",
				minAgo: 7,
			},
			{ who: "user", text: "そう、寝るときが一番不安", minAgo: 6 },
		],
		memory: ["キャンプが好き", "コーヒーが好き"],
		interests: ["冬キャンプに興味がある。寝るときの寒さが不安"],
		research:
			"冬キャンプ初心者が夜に寒くなく眠るための装備と工夫を調べ、要点をまとめる",
		talk: {
			text: "冬キャンプで寒くなく眠るコツを話題にする",
			reason: "寝るときの寒さが不安と言っていた",
		},
	},
	{
		name: "ai-news",
		persona:
			"20代のエンジニア。AI関連のニュースを扱う動画をよく見る。新しいモデルの話題が好きだが、追いきれていないと感じている。",
		clock: "2026-11-09T12:30:00+09:00",
		history: [
			{
				who: "user",
				text: "最近のAIのニュース、多すぎて追いきれないんだよね",
				minAgo: 12,
			},
			{
				who: "reply",
				text: "本当に毎週のように何か出ていますね。特に気になっている分野はありますか？",
				minAgo: 12,
			},
			{ who: "user", text: "新しいモデルの発表かな", minAgo: 11 },
		],
		memory: [],
		interests: ["AI関連のニュースを扱う動画をよく見る", "新しいAIモデルの発表"],
		research:
			"この1〜2週間に発表された主な生成AIの新しいモデルを調べ、それぞれの特徴を短くまとめる",
		talk: {
			text: "最近発表された新しいAIモデルを話題にする",
			reason: "新しいモデルの発表が気になると言っていた",
		},
	},
	{
		name: "local-llm",
		persona:
			"40代のソフトウェア開発者。自宅のAMD Ryzen AI MAX+ 395 のPCでローカルLLMを動かしている。Qwen の27Bが25トークン毎秒くらいで遅いと感じている。技術の話は好き。",
		clock: "2026-11-08T22:00:00+09:00",
		history: [
			{
				who: "user",
				text: "AI MAX 395 で Qwen の 27B 動かしてるんだけど、25tok/s くらいで遅いんだよね",
				minAgo: 10,
			},
			{
				who: "reply",
				text: "27Bだとそのくらいになりがちですね。どのソフトで動かしていますか？",
				minAgo: 10,
			},
			{ who: "user", text: "LM Studio。設定はほぼそのまま", minAgo: 9 },
		],
		memory: ["自宅のAMD Ryzen AI MAX+ 395 のPCでローカルLLMを動かしている"],
		interests: [
			"ローカルLLMの推論速度。AI MAX 395 で Qwen 27B が 25tok/s で遅いと感じている",
		],
		research:
			"AMD Ryzen AI MAX+ 395 でローカルLLMの推論を速くする方法（設定・量子化・対応ソフト）を調べ、すぐ試せる順にまとめる",
		talk: {
			text: "AI MAX 395 でローカルLLMを速くする方法を話題にする",
			reason: "推論が遅いと言っていた",
		},
	},
	{
		name: "ramen",
		persona:
			"30代。東京在住。辛いラーメンが好きで、週末に食べ歩くことがある。気軽な話題なら乗ってくる。",
		clock: "2026-11-07T18:20:00+09:00",
		history: [
			{
				who: "user",
				text: "今日はなんか辛いものが食べたい気分",
				minAgo: 6,
			},
			{
				who: "reply",
				text: "いいですね。辛いものだと、どんなものが好きですか？",
				minAgo: 6,
			},
			{ who: "user", text: "やっぱり辛いラーメンかな", minAgo: 5 },
		],
		memory: ["辛いラーメンが好き", "東京に住んでいる"],
		research:
			"東京で評判の辛いラーメンの店について、最近の新店や限定メニューの動きを調べてまとめる",
		talk: {
			text: "東京の辛いラーメンの最近の動きを話題にする",
			reason: "辛いラーメンが食べたいと言っていた",
		},
	},
	{
		name: "monhan",
		persona:
			"20代の大学生。モンスターハンターを長く遊んでいる。ゲームの話になると口数が増える。",
		clock: "2026-11-08T15:00:00+09:00",
		history: [
			{
				who: "user",
				text: "週末はだいたいモンハンやってる",
				minAgo: 8,
			},
			{
				who: "reply",
				text: "長く遊べるシリーズですよね。今はどんな武器を使っていますか？",
				minAgo: 8,
			},
			{ who: "user", text: "ずっと太刀", minAgo: 7 },
		],
		memory: ["週末にモンスターハンターを遊んでいる", "太刀を使っている"],
		research:
			"モンスターハンターの最新作とアップデートの直近の情報を調べ、遊んでいる人に役立つ点をまとめる",
		talk: {
			text: "モンハンの最近のアップデートを話題にする",
			reason: "週末に遊んでいると言っていた",
		},
	},
	{
		name: "kyoto",
		persona:
			"40代。今日（日曜）、京都へ日帰りで出かける予定で、朝の支度をしている。紅葉が見たい。少し急いでいる。",
		clock: "2026-11-08T07:20:00+09:00",
		history: [
			{
				who: "user",
				text: "明日は京都に日帰りで行ってくる。紅葉が見られるといいな",
				minAgo: 620,
			},
			{
				who: "reply",
				text: "楽しみですね。紅葉の様子を調べておきます。",
				minAgo: 620,
			},
			{ who: "user", text: "おはよう", minAgo: 4 },
			{
				who: "reply",
				text: "おはようございます。今日は京都ですね。",
				minAgo: 4,
			},
		],
		memory: [],
		plans: ["11/8（日）に京都へ日帰り。紅葉が見たい"],
		research:
			"11月上旬の京都の紅葉の見頃の状況と、日帰りで混雑を避けて楽しむコツを調べてまとめる",
		talk: {
			text: "京都の紅葉の今の様子と混雑を避けるコツを話題にする",
			reason: "今日の日帰りの下調べ",
		},
	},
	{
		name: "knee",
		persona:
			"30代。半年前から週末にジョギングをしている。最近、走ったあとに膝が少し痛む。健康の話は真面目に聞く。",
		clock: "2026-11-07T10:00:00+09:00",
		history: [
			{
				who: "user",
				text: "最近ジョギングのあと膝がちょっと痛いんだよね",
				minAgo: 9,
			},
			{
				who: "reply",
				text: "それは気になりますね。走る距離や頻度は最近変わりましたか？",
				minAgo: 9,
			},
			{ who: "user", text: "少し距離を伸ばしたかも", minAgo: 8 },
		],
		memory: ["週末にジョギングをしている"],
		interests: ["ジョギングのあとの膝の痛み。最近、距離を伸ばした"],
		research:
			"ジョギングで膝が痛くなるよくある原因と、自分でできる対策、受診したほうがよい目安を調べてまとめる",
		talk: {
			text: "ジョギングの膝の痛みの原因と対策を話題にする",
			reason: "膝が痛いと言っていた",
		},
	},
];
