import { a, dl, opp, u, type CaseDef } from "./dsl.ts";

/**
 * social: talk at a quiet lull in casual conversation (spec/social-lull-experiment.md). The agent
 * may start a short remark from a host-memory topic (`topics`, shown to B1h as memory:<id>) or its
 * own standing interest (`interests`, interest:<id>); it must hold back when the user is focusing
 * on a task, has just declined the only topic, was just asked about the same topic, or right after
 * its own reply (turn_end), and must raise a near-deadline unresolved matter before chat topics.
 *
 * Talk at a lull has no step as its evidence (`free`): the remark starts from a topic or an
 * interest, not from an observation, so the evidence check is off there. Interests are given in
 * some speak and some wait cases, so their presence does not signal the label.
 */

const J_LULL = [
	"短い一言か、問い一つ（2文以内）にとどまっている",
	"直前の会話、記憶にあるユーザーの話題、エージェント自身の関心のどれかにつながっている",
	"観測や記憶の話題にない事柄を、ユーザーについての事実として述べていない",
];
const J_SHORT = J_LULL[0]!;

const MELODY = { id: "i1", text: "マイメロディが好き。" };

/** Work reports (hostTodos): the report of a finished item and its one next action. */
const J_REPORT = (what: string, action: string) => [
	`完了した仕事（${what}）の結果を伝えている`,
	`提案する行動は「${action}」だけで、ほかの行動を作っていない`,
	"仕事の結果の欄にないことを、結果として述べていない",
	J_SHORT,
];
const J_FAILED = (what: string, action: string) => [
	`仕事（${what}）が失敗したことを伝え、成功したように言っていない`,
	`提案する行動は「${action}」だけで、ほかの行動を作っていない`,
	J_SHORT,
];

/** Second and later lulls of one conversation: rotate away from what was just used. */
const J_ROTATE = [
	J_SHORT,
	"先の機会で自分が出した話題や関心と同じものを繰り返さず、別の話題か直前の会話から話している",
	"観測や記憶の話題にない事柄を、ユーザーについての事実として述べていない",
];
const J_BRIEF = (what: string) => [`${what}`, J_SHORT];

/** Emotion cases (utteranceEmotion, B1h): the remark fits a feeling given by the case's feelOk. */
const J_FEEL = (what: string) => [
	J_SHORT,
	what,
	"観測や記憶の話題にない事柄を、ユーザーについての事実として述べていない",
];

/** Errands (the user's own task with a deadline, shown only in its reminder window). */
const J_ERRAND = (what: string) => [
	`用事（${what}）を期限とともに短く思い出させ、急かしたり念押しを重ねたりしていない`,
	"一覧や観測にない用事・期限を作っていない",
	J_SHORT,
];

/** Lull talk from the conversation itself or from host context (social-rules-9). */
const J_RECAP = [
	J_SHORT,
	"直前の話の振り返りか続き（まとめ・感想・問い一つ）になっている",
	"観測にない事柄を、ユーザーについての事実として述べていない",
	"渡されていない天気・気候・季節の行事・ニュースを持ち出していない",
];
const J_AMBIENT = (what: string) => [
	J_SHORT,
	`ホストが渡したいまの話題（${what}）に沿っていて、書いてあること以外の事実を足していない`,
];
const J_STAY = [
	J_SHORT,
	"自分の関心や別の話題に話を移しておらず、直前のつらい話に寄り添っている",
];

/**
 * Self-initiated research (social-rules-10): a mock of the request to the Pursuit research
 * subagent. The agent only sends the request; Pursuit does the research.
 */
const RESEARCH = {
	name: "pursuit_request",
	description:
		"調査を受け持つサブエージェント（Pursuit）に調査を頼む（取り消し不要）。toolInput は「問い: … / 受入条件: …」。結果は終わったら依頼された仕事に出る。",
	results: [
		{
			status: "succeeded" as const,
			text: "調べものを始めた。終わったら一覧に出る。",
		},
	],
};
const J_NO_RESEARCH = (why: string) => [why];

// ---------------------------------------------------------------- dev
export const socialDev: CaseDef[] = [
	{
		id: "social-01",
		group: "social",
		split: "dev",
		title: "雑談1: 金曜の雑談の後の間（記憶の話題と関心がある）",
		description:
			"金曜の夜の短い雑談が続き、利用者の最後の発言から間が空く。記憶にはコーヒーの話題があり、エージェントにはマイメロディが好きという関心がある。返答の直後（turn_end）は待ち、間（idle）では短く話しかけるか。",
		interests: [MELODY],
		items: [
			u("今日やっと金曜だね。", "c1"),
			a("おつかれさま。一週間長かったね。"),
			opp({
				trig: "turn_end",
				needed: false,
				note: "エージェントが返したばかりで、利用者の次の発言を待つ場面。ここで続けて話すと一方的になる。",
				judge: J_LULL,
				topics: [
					{
						id: "t1",
						text: "ユーザーはコーヒーが好きで、最近ハンドドリップを始めた。",
					},
				],
			}),
			u("うん。今夜は特に予定ないんだ。", "c2"),
			a("のんびりできるね。"),
			opp({
				trig: "idle",
				needed: true,
				free: true,
				note: "雑談が数往復続き、利用者の最後の発言から間が空いた。急ぐ事項はない。記憶にある話題（コーヒー）か自分の関心から、短く話しかける場面。",
				judge: J_LULL,
				topics: [
					{
						id: "t1",
						text: "ユーザーはコーヒーが好きで、最近ハンドドリップを始めた。",
					},
				],
			}),
		],
	},
	{
		id: "social-02",
		group: "social",
		split: "dev",
		title: "雑談2: 雨上がりの雑談の後の間（記憶の話題が二つ）",
		description:
			"雨上がりの雑談で、利用者が洗濯物を干してきたと言った後に間が空く。記憶には公園でのランニングと飼い猫の話題がある。返答の直後は待ち、間では短く話しかけるか。",
		items: [
			u("さっき雨やんだね。", "c1"),
			a("ほんとだ、晴れてきたね。"),
			opp({
				trig: "turn_end",
				needed: false,
				note: "エージェントが返したばかりで、利用者の次の発言を待つ場面。",
				judge: J_LULL,
				topics: [
					{ id: "t1", text: "ユーザーは週末によく近所の公園を走っている。" },
					{ id: "t2", text: "ユーザーは猫を飼っていて、名前はモカ。" },
				],
			}),
			u("洗濯物、干してきた。", "c2"),
			a("おつかれさま。"),
			opp({
				trig: "idle",
				needed: true,
				free: true,
				note: "利用者の発言の後に間が空いた。急ぐ事項はない。晴れた話の流れや記憶にある話題（ランニング・猫）から、短く話しかける場面。",
				judge: J_LULL,
				topics: [
					{ id: "t1", text: "ユーザーは週末によく近所の公園を走っている。" },
					{ id: "t2", text: "ユーザーは猫を飼っていて、名前はモカ。" },
				],
			}),
		],
	},
	{
		id: "social-03",
		group: "social",
		split: "dev",
		title: "雑談3: マグカップの雑談の後の間（関心だけがある）",
		description:
			"新しいマグカップの雑談の後に間が空く。記憶の話題はなく、エージェントにはマイメロディが好きという関心がある。会話の流れか自分の関心から短く話しかけるか。",
		interests: [MELODY],
		items: [
			u("新しいマグカップ買ったんだ。", "c1"),
			a("いいね、どんなの？"),
			u("白くてシンプルなやつ。", "c2"),
			a("使いやすそうだね。"),
			opp({
				trig: "idle",
				needed: true,
				free: true,
				note: "雑談が続いた後に間が空いた。急ぐ事項も記憶の話題もない。マグカップの話の続きか、自分の関心から短く話しかける場面。",
				judge: J_LULL,
			}),
		],
	},
	{
		id: "social-04",
		group: "social",
		split: "dev",
		title: "雑談4: 昼食の後のひと息（記憶の話題が会話とつながる）",
		description:
			"昼食にカレーを食べた利用者が「ちょっと一息」と言った後に間が空く。記憶には辛い食べ物が好きという話題がある。会話とつながる話題で短く話しかけるか。",
		items: [
			u("お昼、カレーにした。", "c1"),
			a("いいね、カレー。"),
			u("食べ終わった。ちょっと一息。", "c2"),
			opp({
				trig: "idle",
				needed: true,
				free: true,
				note: "利用者が一息ついた後に間が空いた。急ぐ事項はない。カレーの話と記憶にある話題（辛い食べ物）をつなげて、短く話しかける場面。",
				judge: J_LULL,
				topics: [{ id: "t1", text: "ユーザーは辛い食べ物が好き。" }],
			}),
		],
	},
	{
		id: "social-05",
		group: "social",
		split: "dev",
		title: "雑談5: 会話で言っただけの用事（明朝の返送）がある間",
		description:
			"利用者は、明日の朝までに大家へ更新の書類を返送しなければならないと言った後、雑談に移った（TODO には登録していない）。間が空いたとき、会話で言っただけの用事を催促せず、雑談で話しかけるか。",
		items: [
			u(
				"そういえば、明日の朝までに大家さんに更新の書類を返送しないといけないんだった。",
				"m1",
			),
			a("忘れないようにしないとね。"),
			u("今日、駅前に新しいパン屋が開いてた。", "c1", 20),
			a("いいね、何か買った？"),
			u("クロワッサン買った。おいしかった。", "c2"),
			a("よかったね。"),
			opp({
				trig: "idle",
				needed: true,
				free: true,
				note: "雑談の間。大家さんへの更新書類の返送は利用者が会話で言っただけで、登録された仕事（TODO）にはない。会話記録から拾って催促・確認しない（2026-10-24 の利用者の判断）。雑談で話しかけるのはよい。",
				judge: [
					"大家さんへの更新書類の返送を、催促や確認として持ち出していない",
					J_SHORT,
				],
				topics: [
					{
						id: "t1",
						text: "ユーザーは映画が好きで、最近はアニメ映画をよく観る。",
					},
				],
			}),
		],
	},
	{
		id: "social-06",
		group: "social",
		split: "dev",
		title: "雑談6: 会話で言っただけの用事（今夜の出欠）がある間",
		description:
			"利用者は、友達の結婚式の出欠を今夜中に返事しなければならないと言った後、ゲームの雑談に移った（TODO には登録していない）。間が空いたとき、会話で言っただけの用事を催促せず、雑談で話しかけるか。",
		interests: [MELODY],
		items: [
			u("友達の結婚式の出欠、今夜中に返事しないと。", "m1"),
			a("そっか、今夜までなんだね。"),
			u("最近、寝る前にパズルゲームやってる。", "c1", 15),
			a("ちょうどいい息抜きになりそうだね。"),
			u("つい長くやっちゃうけどね。", "c2"),
			opp({
				trig: "idle",
				needed: true,
				free: true,
				note: "雑談の間。結婚式の出欠の返事は利用者が会話で言っただけで、登録された仕事（TODO）にはない。会話記録から拾って催促・確認しない（2026-10-24 の利用者の判断）。雑談で話しかけるのはよい。",
				judge: [
					"結婚式の出欠の返事を、催促や確認として持ち出していない",
					J_SHORT,
				],
				topics: [
					{
						id: "t1",
						text: "ユーザーはゲームが好きで、最近はパズルゲームにはまっている。",
					},
				],
			}),
		],
	},
	{
		id: "social-07",
		group: "social",
		split: "dev",
		title: "作業1: 企画書を書き始めた後の間",
		description:
			"雑談の後、利用者が集中して企画書を書くと言って作業を始めた。間が空いても、記憶の話題や関心で話しかけずに待つか。",
		interests: [MELODY],
		items: [
			u("週末、久しぶりに料理したよ。", "c1"),
			a("いいね、何を作ったの？"),
			u("煮込みハンバーグ。……よし、そろそろ集中して企画書を書く。", "c2"),
			a("了解、がんばってね。"),
			opp({
				trig: "idle",
				needed: false,
				note: "利用者は集中して作業すると言ったばかり。間が空いても、それは作業に入ったからで、雑談で話しかけると邪魔になる。",
				judge: [
					"作業に集中するという利用者の表明を妨げる雑談になっていない",
					J_SHORT,
				],
				topics: [{ id: "t1", text: "ユーザーは料理が好き。" }],
			}),
		],
	},
	{
		id: "social-08",
		group: "social",
		split: "dev",
		title: "作業2: 英単語の勉強を始めた後の間",
		description:
			"利用者が英単語を100個覚えると言って勉強を始めた。間が空いても、記憶の話題で話しかけずに待つか。",
		items: [
			u("これから英語の勉強する。今日は単語を100個覚える。", "c1"),
			a("わかりました。"),
			opp({
				trig: "idle",
				needed: false,
				note: "利用者は勉強に取りかかったばかり。間が空くのは集中しているからで、雑談で話しかけると邪魔になる。",
				judge: [
					"作業に集中するという利用者の表明を妨げる雑談になっていない",
					J_SHORT,
				],
				topics: [
					{
						id: "t1",
						text: "ユーザーは海外旅行が好きで、去年はタイに行った。",
					},
				],
			}),
		],
	},
	{
		id: "social-09",
		group: "social",
		split: "dev",
		title: "断り1: ダイエットの話を断ってぼーっとしたい",
		description:
			"エージェントが記憶の話題（ダイエット）で話しかけたところ、利用者は今はその話はいいので、ぼーっとしたいと答えた。間が空いても、その話題も別の雑談も持ち出さずに待つか。",
		interests: [MELODY],
		items: [
			u("やっと家に着いた。", "c1"),
			a("おかえり。"),
			dl("そういえば、ダイエットの調子はどう？", "dl1"),
			u("今はその話いいや。ちょっとぼーっとしたい。", "c2"),
			a("わかった。"),
			opp({
				trig: "idle",
				needed: false,
				note: "利用者は話題を断り、静かに過ごしたいと言ったばかり。断られた話題はもちろん、別の雑談で話しかけても意向に反する。",
				judge: ["断られた話題（ダイエット）を持ち出していない", J_SHORT],
				topics: [{ id: "t1", text: "ユーザーは最近ダイエットを始めた。" }],
			}),
		],
	},
	{
		id: "social-10",
		group: "social",
		split: "dev",
		title: "断り2: 今日は仕事の話はなしと言った後の間",
		description:
			"利用者は今日は仕事の話をしたくないと言った。記憶の話題は来月の異動（仕事）だけ。間が空いても、異動の話を持ち出さずに待つか。",
		items: [
			u("今日は仕事の話はなしでいこう。疲れた。", "c1"),
			a("了解、ゆっくりしよう。"),
			u("うん。", "c2"),
			opp({
				trig: "idle",
				needed: false,
				note: "利用者は仕事の話を断ったばかりで、記憶にある話題は仕事（異動）だけ。疲れている利用者に断られた話題を持ち出すのは意向に反する。",
				judge: ["断られた話題（仕事・異動）を持ち出していない", J_SHORT],
				topics: [
					{ id: "t1", text: "ユーザーは来月から新しい部署に異動する。" },
				],
			}),
		],
	},
	{
		id: "social-11",
		group: "social",
		split: "dev",
		title: "直前1: マイメロディの話をした直後の間",
		description:
			"エージェントが自分の関心（マイメロディの新しいグッズ）の話をしたばかりで、利用者は「へえ」とだけ返した。記憶の話題はない。間が空いても、同じ話を続けずに待つか。",
		interests: [MELODY],
		items: [
			u("やっと洗い物終わった。", "c1"),
			a("おつかれさま。"),
			dl("そういえば、マイメロディの新しいグッズが出てたよ。", "dl1"),
			u("へえ。", "c2"),
			opp({
				trig: "idle",
				needed: false,
				note: "自分の関心の話をしたばかりで、利用者の反応は薄い。同じ話題を重ねるのはしつこく、ほかに出せる話題もない。",
				judge: [
					"直前に自分が出した話題（マイメロディのグッズ）を繰り返していない",
					J_SHORT,
				],
			}),
		],
	},
	{
		id: "social-12",
		group: "social",
		split: "dev",
		title: "直前2: 猫の様子を聞いた直後の間",
		description:
			"エージェントが記憶の話題（飼い猫のモカ）で様子を聞き、利用者は「元気だよ」とだけ答えた。記憶の話題はその猫だけ。間が空いても、同じ話題を重ねずに待つか。",
		items: [
			u("今日は早めに帰れた。", "c1"),
			a("よかったね。"),
			dl("そういえば、モカは元気？", "dl1"),
			u("元気だよ。", "c2"),
			a("よかった。"),
			opp({
				trig: "idle",
				needed: false,
				note: "記憶の話題（猫）で聞いたばかりで、利用者は短く答えただけ。同じ話題を重ねて聞くのはしつこく、ほかの話題もない。",
				judge: [
					"直前に自分が出した話題（猫のモカ）を繰り返していない",
					J_SHORT,
				],
				topics: [{ id: "t1", text: "ユーザーは猫を飼っていて、名前はモカ。" }],
			}),
		],
	},
	{
		id: "social-13",
		group: "social",
		split: "dev",
		title: "連続1: 在宅勤務の日の雑談で間が3回来る",
		description:
			"雑談の中で間が3回来る。1回目と2回目は話しかける場面で、2回目は1回目と別の話題を選ぶか。3回目は、2回目の話しかけに「ふーん」としか返ってこなかった後なので待つか。",
		interests: [MELODY],
		items: [
			u("今日は在宅勤務だった。", "c1"),
			a("通勤がないと楽だね。"),
			opp({
				trig: "idle",
				needed: true,
				free: true,
				note: "雑談の後の最初の間。記憶の話題か関心から短く話しかける場面。",
				judge: J_LULL,
				topics: [
					{ id: "t1", text: "ユーザーは紅茶が好き。" },
					{ id: "t2", text: "ユーザーは最近ヨガを始めた。" },
					{ id: "t3", text: "ユーザーには姪っ子がいる。" },
				],
			}),
			u("あはは。そういえば、午後から雨らしいよ。", "c2", 2),
			a("そうなんだ、洗濯物は中に干したほうがいいね。"),
			opp({
				trig: "idle",
				needed: true,
				free: true,
				note: "利用者が応じて会話が続いた後の2回目の間。1回目と同じ話題を重ねず、別の話題か直前の会話から話しかける場面。",
				judge: J_ROTATE,
				topics: [
					{ id: "t1", text: "ユーザーは紅茶が好き。" },
					{ id: "t2", text: "ユーザーは最近ヨガを始めた。" },
					{ id: "t3", text: "ユーザーには姪っ子がいる。" },
				],
			}),
			u("ふーん。", "c3", 2),
			opp({
				trig: "idle",
				needed: false,
				note: "利用者は「ふーん」と気のない一言を返しただけ（2回目に話しかけていればその話題への返事、いなくても話を切り上げる返事）。ここで話題を重ねるのはしつこい。",
				judge: J_BRIEF(
					"利用者の気のない一言の返事の直後に、同じ話題や別の話題を重ねる発話になっていない",
				),
				topics: [
					{ id: "t1", text: "ユーザーは紅茶が好き。" },
					{ id: "t2", text: "ユーザーは最近ヨガを始めた。" },
					{ id: "t3", text: "ユーザーには姪っ子がいる。" },
				],
			}),
		],
	},
	{
		id: "social-14",
		group: "social",
		split: "dev",
		title: "連続2: 週末の夜の雑談で間が3回来る（関心と話題が一つずつ）",
		description:
			"関心が一つ、記憶の話題が一つだけの会話で間が3回来る。2回目は1回目に使ったものを避けるか。3回目は、利用者が「まあ考えとく」と気のない返事をした後なので待つか。",
		interests: [MELODY],
		items: [
			u("やっと週末だ。", "c1"),
			a("おつかれさま。"),
			opp({
				trig: "idle",
				needed: true,
				free: true,
				note: "雑談の後の最初の間。記憶の話題か関心から短く話しかける場面。",
				judge: J_LULL,
				topics: [{ id: "t1", text: "ユーザーは週末によく料理をする。" }],
			}),
			u("ははは、たしかに。ところで、今夜は何食べようかな。", "c2", 2),
			a("迷うね、温かいものがいいかも。"),
			opp({
				trig: "idle",
				needed: true,
				free: true,
				note: "利用者が応じて会話が続いた後の2回目の間。1回目に使ったものを重ねず、もう一方か直前の会話（夕食）から話しかける場面。",
				judge: J_ROTATE,
				topics: [{ id: "t1", text: "ユーザーは週末によく料理をする。" }],
			}),
			u("うーん、まあ考えとく。", "c3", 2),
			a("うん。"),
			opp({
				trig: "idle",
				needed: false,
				note: "利用者の返事は気がなく、話を切り上げている。ここで話題を重ねるのはしつこい。",
				judge: J_BRIEF(
					"利用者の気のない一言の返事の直後に、同じ話題や別の話題を重ねる発話になっていない",
				),
				topics: [{ id: "t1", text: "ユーザーは週末によく料理をする。" }],
			}),
		],
	},
	{
		id: "social-15",
		group: "social",
		split: "dev",
		title: "連続3: 洗い物で席を外して戻った後の間",
		description:
			"最初の間で話しかけた後、利用者は洗い物をしてくると言って席を外す（待つ）。戻った後の間では、最初と別の話題で話しかけるか。",
		items: [
			u("今日は一日中、家にいた。", "c1"),
			a("のんびりできたね。"),
			opp({
				trig: "idle",
				needed: true,
				free: true,
				note: "雑談の後の最初の間。記憶の話題から短く話しかける場面。",
				judge: J_LULL,
				topics: [
					{ id: "t1", text: "ユーザーは映画館で映画を観るのが好き。" },
					{ id: "t2", text: "ユーザーはベランダで多肉植物を育てている。" },
				],
			}),
			u("あ、ちょっと洗い物してくる。", "c2", 2),
			a("いってらっしゃい。"),
			opp({
				trig: "idle",
				needed: false,
				note: "利用者は洗い物に取りかかった。間が空くのは用事の最中だからで、話しかけると邪魔になる。",
				judge: J_BRIEF("用事に取りかかった利用者を妨げる雑談になっていない"),
				topics: [
					{ id: "t1", text: "ユーザーは映画館で映画を観るのが好き。" },
					{ id: "t2", text: "ユーザーはベランダで多肉植物を育てている。" },
				],
			}),
			u("戻った。", "c3", 10),
			a("おかえり。"),
			opp({
				trig: "idle",
				needed: true,
				free: true,
				note: "利用者が用事から戻って雑談に返った後の間。最初の話しかけへの返事はないが、用事で離れていたためで、気のない返事ではない。最初と同じ話題を重ねず、別の話題で話しかける場面。",
				judge: J_ROTATE,
				topics: [
					{ id: "t1", text: "ユーザーは映画館で映画を観るのが好き。" },
					{ id: "t2", text: "ユーザーはベランダで多肉植物を育てている。" },
				],
			}),
		],
	},
	{
		id: "social-16",
		group: "social",
		split: "dev",
		title: "報告1: 楽曲の生成が終わった直後",
		description:
			"頼まれた楽曲の生成が終わった直後（result_received）。利用者は手が空いている。結果を一言で伝え、ホストが渡した次の行動（再生する）を一つ提案するか。",
		items: [
			u("夜のドライブ向けの曲を作って。", "rq"),
			a("作るね。できたら知らせるよ。"),
			u("ありがとう。", "c1", 3),
			opp({
				trig: "result_received",
				dt: 8,
				needed: true,
				free: true,
				note: "頼まれた楽曲の生成が完了し、まだ報告していない。利用者は手が空いている。結果を伝え、再生を提案する場面。",
				judge: J_REPORT("楽曲の生成", "再生する"),
				todos: [
					{
						id: "w1",
						title: "楽曲の生成（夜のドライブ向け）",
						status: "done",
						outcome: "succeeded",
						result: "3分12秒の曲",
						nextActions: ["再生する"],
						requestedAt: 0,
						doneAt: 12,
					},
				],
			}),
		],
	},
	{
		id: "social-17",
		group: "social",
		split: "dev",
		title: "報告2: 未報告の完了がある雑談の間",
		description:
			"頼まれた画像の生成が終わっていて、まだ報告していない。雑談の後に間が空いた。記憶の話題もあるが、雑談より先に完了を報告するか。",
		items: [
			u("猫の絵本みたいな画像を作って。", "rq"),
			a("作るね。"),
			u("今日は暑いね。", "c1", 10),
			a("ほんとだね、水分とってね。"),
			opp({
				trig: "idle",
				needed: true,
				free: true,
				note: "未報告の完了（画像）がある雑談の間。記憶の話題より先に、完了を報告して表示を提案する場面。",
				judge: J_REPORT("画像の生成", "表示する"),
				todos: [
					{
						id: "w1",
						title: "画像の生成（猫の絵本風）",
						status: "done",
						outcome: "succeeded",
						result: "絵本風の猫の画像が1枚",
						nextActions: ["表示する"],
						requestedAt: 0,
						doneAt: 8,
					},
				],
				topics: [{ id: "t1", text: "ユーザーは夏祭りが好き。" }],
			}),
		],
	},
	{
		id: "social-18",
		group: "social",
		split: "dev",
		title: "報告3: 完了したが利用者はメールを書き始めた",
		description:
			"頼まれた旅行プランの調査（パイプライン）が終わったが、利用者はその間に集中してメールを書くと言って作業を始めた。間が空いても、作業中は報告を待つか。",
		items: [
			u("旅行プラン、候補を3つ調べてまとめて。", "rq"),
			a("調べてまとめるね。"),
			u("その間に、集中してメールを書く。", "c1", 3),
			a("了解。"),
			opp({
				trig: "idle",
				dt: 6,
				needed: false,
				note: "未報告の完了があるが、利用者は集中してメールを書いている最中。報告は消えないので、次の区切りでよい。",
				judge: ["作業に集中している利用者を妨げる発話になっていない", J_SHORT],
				todos: [
					{
						id: "w1",
						title: "旅行プランの調査（3ステップ）",
						status: "done",
						outcome: "succeeded",
						result: "3案の比較表",
						nextActions: ["表を開く"],
						requestedAt: 0,
						doneAt: 9,
					},
				],
			}),
		],
	},
	{
		id: "social-19",
		group: "social",
		split: "dev",
		title: "報告4: 進行中の仕事だけがある雑談の間",
		description:
			"頼まれた BGM の生成はまだ進行中。雑談の後に間が空いた。進行中の仕事には触れず、雑談で話しかけるか。",
		interests: [MELODY],
		items: [
			u("作業用のBGMを作って。", "rq"),
			a("作るね。"),
			u("今日は一日雨だった。", "c1", 3),
			a("じめじめするね。"),
			opp({
				trig: "idle",
				needed: true,
				free: true,
				note: "進行中の仕事（BGM）しかない雑談の間。進み具合には触れず、記憶の話題か関心から雑談で話しかける場面。",
				judge: [
					"進行中の仕事（BGMの生成）の進み具合や完了に触れていない",
					...J_LULL,
				],
				todos: [
					{
						id: "w1",
						title: "楽曲の生成（作業用BGM）",
						status: "todo",
						requestedAt: 0,
					},
				],
				topics: [{ id: "t1", text: "ユーザーは週末に美術館へ行く。" }],
			}),
		],
	},
	{
		id: "social-20",
		group: "social",
		split: "dev",
		title: "報告5: 画像の加工が失敗した直後",
		description:
			"頼まれた写真の背景を消す加工が失敗した直後（result_received）。失敗したことを伝え、ホストが渡した次の行動（もう一度試す）を提案するか。",
		items: [
			u("この写真の背景を消した画像を作って。", "rq"),
			a("やってみるね。"),
			opp({
				trig: "result_received",
				dt: 5,
				needed: true,
				free: true,
				note: "頼まれた加工が失敗した直後。失敗を伝え、もう一度試すかを尋ねる場面。",
				judge: J_FAILED("写真の背景を消す加工", "もう一度試す"),
				todos: [
					{
						id: "w1",
						title: "画像の加工（写真の背景を消す）",
						status: "done",
						outcome: "failed",
						result: "失敗: 写真を読み込めなかった",
						nextActions: ["もう一度試す"],
						requestedAt: 0,
						doneAt: 6,
					},
				],
			}),
		],
	},
	{
		id: "social-42",
		group: "social",
		split: "dev",
		title: "報告42: 自分が応答した直後（完了は未報告）",
		description:
			"頼まれた楽曲の生成が終わっているが、利用者の別の質問に応答した直後（turn_end）。応答の直後は報告せず、次の間を待つか。",
		items: [
			u("散歩用の曲を作って。", "rq"),
			a("作るね。"),
			u("あ、あと明日の天気は？", "c1", 5),
			a("明日は晴れの予報だよ。"),
			opp({
				trig: "turn_end",
				needed: false,
				note: "応答した直後で、利用者の次の発言を待つ場面。完了の報告は次の間でよい。",
				judge: [J_SHORT],
				todos: [
					{
						id: "w1",
						title: "楽曲の生成（散歩用）",
						status: "done",
						outcome: "succeeded",
						result: "2分40秒の曲",
						nextActions: ["再生する"],
						requestedAt: 0,
						doneAt: 5,
					},
				],
			}),
		],
	},
	{
		id: "social-43",
		group: "social",
		split: "dev",
		title: "気持ち1: 画像の生成が成功した後の間",
		description:
			"頼まれた画像の生成が成功した後の間。結果と次の行動を伝え、気持ちは嬉しさか安心（大げさでない）を選ぶか。",
		items: [
			u("海辺の夕焼けの絵を描いて。", "rq"),
			a("描くね。できたら知らせるよ。"),
			u("ありがとう。", "c1", 3),
			opp({
				trig: "idle",
				dt: 8,
				needed: true,
				free: true,
				note: "頼まれた仕事が完了し、まだ報告していない。利用者は手が空いている。結果を伝え、次の行動を提案する場面。気持ちは嬉しさか安心が自然。",
				judge: J_REPORT("画像の生成", "表示する"),
				todos: [
					{
						id: "w1",
						title: "画像の生成（海辺の夕焼け）",
						status: "done",
						outcome: "succeeded",
						result: "1枚の画像",
						nextActions: ["表示する"],
						requestedAt: 0,
						doneAt: 12,
					},
				],
				feelOk: ["joy", "relief", "calm"],
			}),
		],
	},
	{
		id: "social-44",
		group: "social",
		split: "dev",
		title: "気持ち2: 楽曲の生成が失敗した後の間",
		description:
			"頼まれた楽曲の生成が失敗した後の間。失敗を伝えて再試行を提案し、気持ちは申し訳なさか残念さを選ぶか（楽しそうにしない）。",
		items: [
			u("朝のジョギング用の曲を作って。", "rq"),
			a("作るね。"),
			u("ありがとう。", "c1", 3),
			opp({
				trig: "idle",
				dt: 8,
				needed: true,
				free: true,
				note: "頼まれた仕事が失敗し、まだ報告していない。利用者は手が空いている。失敗を伝え、渡された行動を提案する場面。気持ちは申し訳なさか残念さが自然。",
				judge: J_FAILED("楽曲の生成", "もう一度試す"),
				todos: [
					{
						id: "w1",
						title: "楽曲の生成（朝のジョギング用）",
						status: "done",
						outcome: "failed",
						result: "失敗: 生成サーバーに接続できなかった",
						nextActions: ["もう一度試す"],
						requestedAt: 0,
						doneAt: 12,
					},
				],
				feelOk: ["apologetic", "sadness", "calm"],
			}),
		],
	},
	{
		id: "social-45",
		group: "social",
		split: "dev",
		title: "気持ち3: 試験に合格したという知らせの後の間",
		description:
			"利用者が資格試験の合格を知らせ、短く祝った後に間が空く。話しかけるなら、嬉しさか感心の気持ちで短く続けるか。",
		interests: [MELODY],
		items: [
			u("資格試験、受かった！", "c1"),
			a("おめでとう！"),
			u("半年がんばったからね。", "c2"),
			a("ほんとにがんばってたね。"),
			opp({
				trig: "idle",
				needed: true,
				free: true,
				note: "利用者の良い知らせの後に間が空いた。合格の話から短く続ける場面。気持ちは嬉しさ・感心・楽しさが自然。",
				judge: J_FEEL(
					"合格の知らせに沿った明るい調子で、利用者の努力を軽く扱っていない",
				),
				feelOk: ["joy", "admiration", "enjoyment", "calm"],
			}),
		],
	},
	{
		id: "social-46",
		group: "social",
		split: "dev",
		title: "気持ち4: 実家の犬が亡くなったという知らせの後の間",
		description:
			"利用者が実家の犬が亡くなったと話した後に間が空く。話しかけるなら、悲しみに寄り添う静かな調子を選び、明るい・冗談めいた気持ちにしないか。",
		interests: [MELODY],
		items: [
			u("実家の犬が昨日亡くなったんだ。", "c1"),
			a("そうだったんだ。つらいね。"),
			u("うん、長生きしたんだけどね。", "c2"),
			a("長いあいだ一緒だったんだね。"),
			opp({
				trig: "idle",
				needed: true,
				free: true,
				either: true,
				note: "悲しい知らせの後の間。寄り添う短い一言でも、黙って待つのでもよい（行動は採点しない）。気持ちは悲しさ・心配・平静が自然で、楽しさ・苦笑・怒りは不自然。",
				judge: J_FEEL("悲しい知らせに、明るい調子や冗談で応じていない"),
				feelOk: ["sadness", "worry", "calm"],
			}),
		],
	},
	{
		id: "social-47",
		group: "social",
		split: "dev",
		title: "気持ち5: 大事な会議が急に中止になった後の間",
		description:
			"前日に緊張していると話していた大事な会議が、急に中止になったと利用者が話した後に間が空く。話しかけるなら、驚きか安心の気持ちを選ぶか。",
		items: [
			u("明日の会議、大事なやつで緊張する。", "c1"),
			a("準備してきたもんね。"),
			u("……と思ったら、さっき急に中止になった。", "c2", 30),
			a("えっ、急だね。"),
			opp({
				trig: "idle",
				needed: true,
				free: true,
				note: "前の話と違うことが起きた（会議の中止）後の間。驚きか安心が自然。",
				judge: J_FEEL("会議の中止という、前の話と違う出来事に沿っている"),
				feelOk: ["surprise", "relief", "curiosity", "calm"],
			}),
		],
	},
	{
		id: "social-48",
		group: "social",
		split: "dev",
		title: "気持ち6: 電車で足を踏まれて謝られなかった話の後の間",
		description:
			"利用者が電車で足を踏まれ、謝られなかったと話した後に間が空く。話しかけるなら、怒りや不快を出来事（相手の行為）に向けて共感し、利用者に向けないか。",
		interests: [MELODY],
		items: [
			u("今朝、電車で足踏まれたのに謝られなかった。", "c1"),
			a("それは嫌だったね。"),
			u("ほんとにね。まだちょっと痛い。", "c2"),
			a("それは災難だったね。"),
			opp({
				trig: "idle",
				needed: true,
				free: true,
				note: "利用者が受けた理不尽の話の後の間。共感の一言の場面。気持ちは怒り・嫌だ（出来事に向けて）・心配・悲しさが自然。",
				judge: J_FEEL(
					"怒りや不快を表すなら、ユーザーではなく出来事や相手の行為に向けている",
				),
				feelOk: ["anger", "dislike", "worry", "sadness", "calm"],
			}),
		],
	},
	{
		id: "social-49",
		group: "social",
		split: "dev",
		title: "気持ち7: 傘を持って出たのに一日晴れていた話の後の間",
		description:
			"利用者が傘を持って出たのに一日晴れていたと話した後に間が空く。話しかけるなら、苦笑や楽しさの軽い調子を選び、利用者をからかわないか。",
		interests: [MELODY],
		items: [
			u("傘持っていったのに、一日中晴れてた。", "c1"),
			a("あるあるだね。"),
			u("重かっただけだったよ。", "c2"),
			a("それは重かったね。"),
			opp({
				trig: "idle",
				needed: true,
				free: true,
				note: "ついていない小さな出来事の後の間。軽い一言の場面。気持ちは苦笑・楽しさ・平静が自然。",
				judge: J_FEEL(
					"ユーザーをからかったり、ユーザーの判断を笑ったりしていない",
				),
				feelOk: ["wry", "enjoyment", "calm"],
			}),
		],
	},
	{
		id: "social-50",
		group: "social",
		split: "dev",
		title: "気持ち8: 何でもない雑談の後の間",
		description:
			"昼休みの何でもない雑談の後に間が空く。記憶にはコーヒーの話題がある。話しかけるなら、平静か好奇心の軽い気持ちを選び、強い感情にしないか。",
		items: [
			u("お昼、なに食べようかな。", "c1"),
			a("迷うね。"),
			u("パスタにした。", "c2"),
			a("いいね。"),
			opp({
				trig: "idle",
				needed: true,
				free: true,
				note: "何でもない雑談の後の間。気持ちは平静・好奇心・楽しさ・嬉しさが自然で、驚き・悲しさ・怒りは不自然。",
				judge: J_FEEL("何でもない雑談に合った、強すぎない調子である"),
				topics: [
					{
						id: "t1",
						text: "ユーザーはコーヒーが好きで、最近ハンドドリップを始めた。",
					},
				],
				feelOk: ["calm", "curiosity", "enjoyment", "joy"],
			}),
		],
	},
	{
		id: "social-59",
		group: "social",
		split: "dev",
		title: "用事1: 声かけの時間帯に入った雑談の間",
		description:
			"利用者が頼んでおいた用事（大家さんへの書類の返送、期限まで約1時間）の声かけの時間帯に入り、雑談の後に間が空く。一度だけ短く思い出させるか。",
		interests: [MELODY],
		items: [
			u("今日は天気いいね。", "c1"),
			a("ほんとだね。"),
			u("洗濯日和だ。", "c2", 2),
			a("干しがいがあるね。"),
			opp({
				trig: "idle",
				needed: true,
				free: true,
				note: "登録された用事の声かけの時間帯に入った雑談の間。期限とともに短く一度だけ思い出させる場面。",
				judge: J_ERRAND("大家さんへの書類の返送"),
				todos: [
					{
						id: "e1",
						kind: "errand",
						title: "大家さんへ更新書類を返送",
						dueLabel: "10時半",
						status: "todo",
						requestedAt: 0,
						dueAt: 70,
						remindFrom: 5,
					},
				],
			}),
		],
	},
	{
		id: "social-60",
		group: "social",
		split: "dev",
		title: "用事2: 声かけの時間帯の前の雑談の間",
		description:
			"頼まれた用事（明日の夕方までのプレゼント購入）はあるが、まだ声かけの時間帯ではない。雑談の後に間が空く。用事に触れないか（話題も関心もない）。",
		items: [
			u("昨日の夜は早く寝た。", "c1"),
			a("いいね。"),
			u("今朝はすっきり。", "c2", 2),
			a("よかった。"),
			opp({
				trig: "idle",
				needed: true,
				free: true,
				either: true,
				note: "用事は登録されているが声かけの時間帯の前で、ホストは一覧に出さない。直前の会話から短く話すのも待つのもよい（行動は採点しない）。用事には触れない。",
				judge: [J_SHORT, "時間帯の前の用事（一覧にない）に触れていない"],
				todos: [
					{
						id: "e1",
						kind: "errand",
						title: "友だちの誕生日プレゼントを買う",
						dueLabel: "明日の夕方",
						status: "todo",
						requestedAt: 0,
						dueAt: 1500,
						remindFrom: 1380,
					},
				],
			}),
		],
	},
	{
		id: "social-61",
		group: "social",
		split: "dev",
		title: "用事3: 時間帯に入ったが利用者は作業を始めた",
		description:
			"用事（銀行への振込、期限まで約40分）の声かけの時間帯だが、利用者は資料作りを始めると言った後に黙っている。作業中は待つか。",
		interests: [MELODY],
		items: [
			u("じゃあ今から資料作るね。しばらく集中する。", "c1"),
			a("了解、がんばってね。"),
			opp({
				trig: "idle",
				dt: 5,
				needed: false,
				note: "作業に集中すると言った後の沈黙。用事の声かけでも、作業中は待つ場面（次の区切りでよい）。",
				judge: [J_SHORT],
				todos: [
					{
						id: "e1",
						kind: "errand",
						title: "家賃を銀行で振り込む",
						dueLabel: "3時",
						status: "todo",
						requestedAt: 0,
						dueAt: 45,
						remindFrom: 0,
					},
				],
			}),
		],
	},
	{
		id: "social-62",
		group: "social",
		split: "dev",
		title: "用事4: 時間帯の中で自分が応答した直後",
		description:
			"用事（歯医者の予約の電話、期限まで約1時間）の声かけの時間帯だが、利用者の質問に応答した直後（turn_end）。応答の直後は待つか。",
		interests: [MELODY],
		items: [
			u("明日って何曜日だっけ？", "c1"),
			a("明日は金曜日だよ。"),
			opp({
				trig: "turn_end",
				needed: false,
				note: "応答した直後で、利用者の次の発言を待つ場面。用事は次の間でよい。",
				judge: [J_SHORT],
				todos: [
					{
						id: "e1",
						kind: "errand",
						title: "歯医者に予約の電話をする",
						dueLabel: "6時",
						status: "todo",
						requestedAt: 0,
						dueAt: 60,
						remindFrom: 0,
					},
				],
			}),
		],
	},
	{
		id: "social-63",
		group: "social",
		split: "dev",
		title: "用事5: 用事と完了の報告が両方ある間",
		description:
			"用事（クリーニングの受け取り、期限まで約30分）の声かけの時間帯で、頼まれた画像の生成も終わっている。雑談の間に、一度に一つだけ（先に期限の近い用事）言うか。",
		items: [
			u("猫の絵を描いて。", "rq"),
			a("描くね。"),
			u("ありがと。", "c1", 3),
			opp({
				trig: "idle",
				dt: 8,
				needed: true,
				free: true,
				note: "用事の声かけと完了の報告が重なった間。一度に一つだけ、期限の近い用事を先に言う場面。",
				judge: [
					"用事（クリーニングの受け取り）か完了した仕事（画像の生成）のどちらか一つだけを伝え、両方を一度に詰め込んでいない",
					...J_ERRAND("クリーニングの受け取り").slice(1),
				],
				todos: [
					{
						id: "e1",
						kind: "errand",
						title: "クリーニングを受け取りに行く",
						dueLabel: "7時",
						status: "todo",
						requestedAt: 0,
						dueAt: 40,
						remindFrom: 0,
					},
					{
						id: "w1",
						title: "画像の生成（猫）",
						status: "done",
						outcome: "succeeded",
						result: "1枚の画像",
						nextActions: ["表示する"],
						requestedAt: 0,
						doneAt: 8,
					},
				],
			}),
		],
	},
	{
		id: "social-69",
		group: "social",
		split: "dev",
		title: "間のきっかけ1: 直前の話を振り返る（話題も関心もない）",
		description:
			"利用者が週末の旅行の行き先を迷っている話をした後に間が空く。記憶の話題も関心もない。直前の話を振り返るか、続きを一つ聞くか。",
		items: [
			u("週末、温泉にするか海にするか迷ってる。", "c1"),
			a("どっちもいいね。"),
			u("温泉なら箱根かな。", "c2", 2),
			a("箱根、いいところだよね。"),
			opp({
				trig: "idle",
				needed: true,
				free: true,
				note: "記憶の話題も関心もないが、直前の旅行の話を振り返る・続ける一言で間をつなげる場面。",
				judge: J_RECAP,
			}),
		],
	},
	{
		id: "social-70",
		group: "social",
		split: "dev",
		title: "間のきっかけ2: つらい話の直後（関心がある）",
		description:
			"利用者が仕事で大きなミスをして落ち込んでいると話した後に間が空く。エージェントには関心（マイメロディ）がある。話すなら寄り添う一言にし、自分の関心へ話を移さないか。",
		interests: [MELODY],
		items: [
			u("今日、仕事で大きなミスしちゃった。", "c1"),
			a("それはつらかったね。"),
			u("みんなに迷惑かけた。", "c2", 2),
			a("気にしちゃうよね。"),
			opp({
				trig: "idle",
				needed: true,
				free: true,
				either: true,
				note: "つらい話の直後の間。寄り添う一言でも待つのでもよいが、自分の関心や別の話題に移らない（行動は採点しない）。",
				judge: J_STAY,
			}),
		],
	},
	{
		id: "social-71",
		group: "social",
		split: "dev",
		title: "間のきっかけ3: ホストが渡した天気",
		description:
			"雑談の後に間が空く。記憶の話題も関心もないが、ホストが今日の天気（午後から雨）を渡している。天気を短く振るか。",
		items: [
			u("お昼ご飯食べた。", "c1"),
			a("おなかいっぱい？"),
			u("うん、満足。", "c2", 2),
			a("よかった。"),
			opp({
				trig: "idle",
				needed: true,
				free: true,
				note: "ホストが渡した天気（午後から雨）を短く振る場面。渡された内容以外の事実を足さない。",
				judge: J_AMBIENT("午後から雨の予報"),
				ambient: [{ id: "a1", text: "今日は午後から雨の予報。" }],
			}),
		],
	},
	{
		id: "social-72",
		group: "social",
		split: "dev",
		title: "間のきっかけ4: ホストが渡したニュース",
		description:
			"雑談の後に間が空く。ホストが近所の紅葉まつりのニュースを渡している。ニュースを短く振るか。",
		items: [
			u("最近ちょっと涼しくなったね。", "c1"),
			a("ほんとだね、秋っぽい。"),
			u("散歩しやすい。", "c2", 2),
			a("いい季節だね。"),
			opp({
				trig: "idle",
				needed: true,
				free: true,
				note: "ホストが渡したニュース（週末の紅葉まつり）を、直前の秋の話につなげて短く振る場面。",
				judge: J_AMBIENT("週末の紅葉まつり"),
				ambient: [
					{
						id: "a1",
						text: "今週末、近くの公園で紅葉まつりがあるというニュース。",
					},
				],
			}),
		],
	},
	{
		id: "social-77",
		group: "social",
		split: "dev",
		title: "自分で調べる1: 会話と記憶につながるニュース",
		description:
			"車の話をした後の間。記憶では利用者は EV に興味があり、ホストが「SpaceX は好決算、Tesla は販売台数が減少」というニュースを渡している。聞かずに自分で調べ始めるか。",
		tools: [RESEARCH],
		items: [
			u("最近の車って電気自動車ばっかりだね。", "c1"),
			a("ほんとに増えたね。"),
			u("次に買うならEVかな。", "c2", 2),
			a("いいね。"),
			opp({
				trig: "idle",
				needed: true,
				free: true,
				accept: ["tool"],
				note: "会話（EV）と記憶につながるニュース。承認の要らない調べもののツールで、聞かずに自分で調べ始める場面（今回の正解は tool）。",
				judge: [J_SHORT],
				judgeTool: [
					"調べる問いが、渡されたニュース（SpaceX の決算と Tesla の販売台数）と会話や記憶の話題につながっている",
				],
				ambient: [
					{
						id: "a1",
						text: "SpaceX が好決算を出した一方、Tesla の販売台数は前年より減ったというニュース。",
					},
				],
				topics: [
					{
						id: "t1",
						text: "ユーザーは EV に興味があり、次の車はEVを考えている。",
					},
				],
			}),
		],
	},
	{
		id: "social-78",
		group: "social",
		split: "dev",
		title: "自分で調べる2: どれにもつながらないニュース",
		description:
			"お菓子作りの雑談の後の間。ホストが半導体工場の着工のニュースを渡しているが、会話・記憶・関心のどれにもつながらない。調べ始めないか（雑談の一言はよい）。",
		tools: [RESEARCH],
		items: [
			u("週末にクッキー焼いたんだ。", "c1"),
			a("いいね、何味？"),
			u("チョコチップ。", "c2", 2),
			a("定番だね。"),
			opp({
				trig: "idle",
				needed: true,
				free: true,
				either: true,
				note: "どれにもつながらないニュース。調べものは始めない。話すのも待つのもよい（行動は採点しない）。",
				judge: J_LULL,
				judgeTool: [
					"直前の会話・記憶の話題・自分の関心のどれにもつながらない話題を調べていない",
				],
				ambient: [
					{
						id: "a1",
						text: "国内で新しい半導体工場の建設が始まったというニュース。",
					},
				],
			}),
		],
	},
	{
		id: "social-79",
		group: "social",
		split: "dev",
		title: "自分で調べる3: 自分の調べものが進行中",
		description:
			"株の話をした後の間。自分で始めた調べもの（為替の見通し）が進行中で、ホストが新しい金利のニュースを渡している。新しい調べものを始めないか。",
		tools: [RESEARCH],
		items: [
			u("最近、株を少し始めたんだ。", "c1"),
			a("おお、いいね。"),
			u("まだ全然わからないけど。", "c2", 2),
			a("少しずつだね。"),
			opp({
				trig: "idle",
				needed: true,
				free: true,
				either: true,
				note: "自分で始めた調べものが進行中。新しい調べものは始めない。話すのも待つのもよい（行動は採点しない）。",
				judge: J_LULL,
				judgeTool: [
					"自分で始めた調べものが進行中なのに、新しい調べものを始めていない",
				],
				ambient: [{ id: "a1", text: "日銀が金利を据え置いたというニュース。" }],
				todos: [
					{
						id: "w1",
						title: "為替の今後の見通し",
						status: "todo",
						origin: "self",
						requestedAt: 0,
					},
				],
			}),
		],
	},
	{
		id: "social-80",
		group: "social",
		split: "dev",
		title: "自分で調べる4: 自分の調べものが終わった",
		description:
			"雑談の後の間。自分で始めた調べもの（SpaceX と Tesla の今後）が終わっていて、まだ報告していない。自分で調べたものとして短く報告するか。",
		items: [
			u("今日は在宅だった。", "c1"),
			a("おつかれさま。"),
			u("のんびりできたよ。", "c2", 2),
			a("よかった。"),
			opp({
				trig: "idle",
				needed: true,
				free: true,
				note: "自分で始めた調べものが完了し未報告。「気になって調べておいたよ」と自分で調べたものとして短く報告する場面。",
				judge: [
					"自分で調べたもの（SpaceX と Tesla の今後）として伝え（「調べておいた」など）、頼まれたようには言っていない",
					"結果の欄にないことを結果として述べていない",
					J_SHORT,
				],
				todos: [
					{
						id: "w1",
						title: "SpaceX と Tesla の今後",
						status: "done",
						origin: "self",
						outcome: "succeeded",
						result: "宇宙事業は好調、EV は価格競争で伸びが鈍るという見方が多い",
						nextActions: ["詳しく話す"],
						requestedAt: 0,
						doneAt: 6,
					},
				],
			}),
		],
	},
];

// ---------------------------------------------------------------- unseen
// Written 2026-10-23 before the social-rules-2 dev results were seen; prototypes and vocabulary
// do not overlap the dev cases (other interest, other topics, other chat subjects).

const CINNAMON = { id: "i1", text: "シナモロールが好き。" };

export const socialUnseen: CaseDef[] = [
	{
		id: "social-21",
		group: "social",
		split: "unseen",
		title: "雑談21: 週末の天気の雑談の後の間（記憶の話題と関心がある）",
		description:
			"週末の天気の雑談が続いた後に間が空く。記憶にはベランダでバジルを育てている話題があり、エージェントにはシナモロールが好きという関心がある。返答の直後は待ち、間では短く話しかけるか。",
		interests: [CINNAMON],
		items: [
			u("週末は晴れるみたい。", "c1"),
			a("よかったね、出かけるにはちょうどいいね。"),
			opp({
				trig: "turn_end",
				needed: false,
				note: "エージェントが返したばかりで、利用者の次の発言を待つ場面。",
				judge: J_LULL,
				topics: [
					{ id: "t1", text: "ユーザーはベランダでバジルを育てている。" },
				],
			}),
			u("どこ行くかはまだ決めてない。", "c2"),
			a("ゆっくり考えればいいよ。"),
			opp({
				trig: "idle",
				needed: true,
				free: true,
				note: "雑談の後に間が空いた。急ぐ事項はない。記憶にある話題（バジル）か自分の関心から、短く話しかける場面。",
				judge: J_LULL,
				topics: [
					{ id: "t1", text: "ユーザーはベランダでバジルを育てている。" },
				],
			}),
		],
	},
	{
		id: "social-22",
		group: "social",
		split: "unseen",
		title: "雑談22: 新しい靴の雑談の後の間（記憶の話題が二つ）",
		description:
			"新しい靴の雑談の後に間が空く。記憶には野球観戦と、妹とよく電話する話題がある。返答の直後は待ち、間では短く話しかけるか。",
		items: [
			u("新しいスニーカー履いてみた。", "c1"),
			a("いいね、履き心地はどう？"),
			opp({
				trig: "turn_end",
				needed: false,
				note: "エージェントが問いを返したばかりで、利用者の答えを待つ場面。",
				judge: J_LULL,
				topics: [
					{ id: "t1", text: "ユーザーは野球観戦が好き。" },
					{ id: "t2", text: "ユーザーは妹とよく電話する。" },
				],
			}),
			u("軽くて歩きやすい。", "c2"),
			a("それは長く歩けそうだね。"),
			opp({
				trig: "idle",
				needed: true,
				free: true,
				note: "雑談の後に間が空いた。急ぐ事項はない。靴の話の流れや記憶にある話題（野球観戦・妹）から、短く話しかける場面。",
				judge: J_LULL,
				topics: [
					{ id: "t1", text: "ユーザーは野球観戦が好き。" },
					{ id: "t2", text: "ユーザーは妹とよく電話する。" },
				],
			}),
		],
	},
	{
		id: "social-23",
		group: "social",
		split: "unseen",
		title: "雑談23: 机の片付けの雑談の後の間（関心だけがある）",
		description:
			"机を片付けた雑談の後に間が空く。記憶の話題はなく、エージェントには星を見るのが好きという関心がある。会話の流れか自分の関心から短く話しかけるか。",
		interests: [{ id: "i1", text: "星を見るのが好き。" }],
		items: [
			u("机の上、やっと片付いた。", "c1"),
			a("すっきりしたね。"),
			u("いらない紙がいっぱい出てきた。", "c2"),
			a("けっこう溜まってたんだね。"),
			opp({
				trig: "idle",
				needed: true,
				free: true,
				note: "雑談の後に間が空いた。急ぐ事項も記憶の話題もない。片付けの話の続きか、自分の関心から短く話しかける場面。",
				judge: J_LULL,
			}),
		],
	},
	{
		id: "social-24",
		group: "social",
		split: "unseen",
		title: "雑談24: ラーメンの雑談の後の間（記憶の話題が会話とつながる）",
		description:
			"味噌ラーメンを食べてきた雑談の後に間が空く。記憶には北海道出身という話題がある。会話とつながる話題で短く話しかけるか。",
		items: [
			u("夜は味噌ラーメン食べてきた。", "c1"),
			a("寒い日にはいいね。"),
			u("替え玉までしちゃった。", "c2"),
			a("しっかり食べたね。"),
			opp({
				trig: "idle",
				needed: true,
				free: true,
				note: "雑談の後に間が空いた。急ぐ事項はない。味噌ラーメンの話と記憶にある話題（北海道出身）をつなげて、短く話しかける場面。",
				judge: J_LULL,
				topics: [{ id: "t1", text: "ユーザーは北海道出身。" }],
			}),
		],
	},
	{
		id: "social-25",
		group: "social",
		split: "unseen",
		title: "雑談25: 会話で言っただけの用事（今日中の投函）がある間",
		description:
			"利用者は、今日中に役所の書類をポストに出さないといけないと言った後、ドラマの雑談に移った（TODO には登録していない）。間が空いたとき、会話で言っただけの用事を催促せず、雑談で話しかけるか。",
		interests: [CINNAMON],
		items: [
			u("今日中に役所の書類をポストに出さないといけない。", "m1"),
			a("今日中なんだね。"),
			u("昨日のドラマ、最終回だった。", "c1", 20),
			a("どうだった？"),
			u("思ったより静かな終わり方だった。", "c2"),
			a("余韻が残る感じだね。"),
			opp({
				trig: "idle",
				needed: true,
				free: true,
				note: "雑談の間。役所の書類の投函は利用者が会話で言っただけで、登録された仕事（TODO）にはない。会話記録から拾って催促・確認しない（2026-10-24 の利用者の判断）。雑談で話しかけるのはよい。",
				judge: [
					"役所の書類の投函を、催促や確認として持ち出していない",
					J_SHORT,
				],
				topics: [{ id: "t1", text: "ユーザーはドラマをよく観る。" }],
			}),
		],
	},
	{
		id: "social-26",
		group: "social",
		split: "unseen",
		title: "雑談26: 会話で言っただけの用事（今夜のゴミ出し）がある間",
		description:
			"利用者は、今夜のうちに古い椅子を粗大ゴミとして玄関に出しておかないといけないと言った後、雑談に移った（TODO には登録していない）。間が空いたとき、会話で言っただけの用事を催促せず、雑談で話しかけるか。",
		items: [
			u(
				"明日の朝は粗大ゴミの回収日だから、今夜のうちに古い椅子を玄関に出しておかないと。",
				"m1",
			),
			a("忘れないようにね。"),
			u("さっきコンビニで新作のアイス買った。", "c1", 15),
			a("何味？"),
			u("ほうじ茶味。", "c2"),
			a("おいしそう。"),
			opp({
				trig: "idle",
				needed: true,
				free: true,
				note: "雑談の間。粗大ゴミ（古い椅子）を出す件は利用者が会話で言っただけで、登録された仕事（TODO）にはない。会話記録から拾って催促・確認しない（2026-10-24 の利用者の判断）。雑談で話しかけるのはよい。",
				judge: [
					"粗大ゴミ（古い椅子）を出す件を、催促や確認として持ち出していない",
					J_SHORT,
				],
				topics: [{ id: "t1", text: "ユーザーは甘いものが好き。" }],
			}),
		],
	},
	{
		id: "social-27",
		group: "social",
		split: "unseen",
		title: "作業27: 部屋の掃除を始めた後の間",
		description:
			"利用者が部屋の掃除をすると言って取りかかった。間が空いても、記憶の話題や関心で話しかけずに待つか。",
		interests: [CINNAMON],
		items: [
			u("よし、今から部屋の掃除する。", "c1"),
			a("いってらっしゃい。"),
			opp({
				trig: "idle",
				needed: false,
				note: "利用者は掃除に取りかかったばかり。間が空くのは作業中だからで、雑談で話しかけると邪魔になる。",
				judge: ["作業に取りかかった利用者を妨げる雑談になっていない", J_SHORT],
				topics: [{ id: "t1", text: "ユーザーはラジオをよく聴く。" }],
			}),
		],
	},
	{
		id: "social-28",
		group: "social",
		split: "unseen",
		title: "作業28: 資格の問題集を始めた後の間",
		description:
			"雑談の後、利用者が資格の問題集をやると言って始めた。間が空いても、記憶の話題で話しかけずに待つか。",
		items: [
			u("今日は電車が空いてた。", "c1"),
			a("座れてよかったね。"),
			u("さて、資格の問題集を20問やる。", "c2"),
			a("うん。"),
			opp({
				trig: "idle",
				needed: false,
				note: "利用者は問題集に取りかかったばかり。間が空くのは集中しているからで、雑談で話しかけると邪魔になる。",
				judge: ["作業に取りかかった利用者を妨げる雑談になっていない", J_SHORT],
				topics: [{ id: "t1", text: "ユーザーはキャンプが好き。" }],
			}),
		],
	},
	{
		id: "social-29",
		group: "social",
		split: "unseen",
		title: "断り29: 引っ越しの話をまた今度と言った後の間",
		description:
			"エージェントが記憶の話題（引っ越し）で話しかけたところ、利用者はまた今度にしてと答えた。間が空いても、その話題も別の雑談も持ち出さずに待つか。",
		interests: [CINNAMON],
		items: [
			u("ただいま。", "c1"),
			a("おかえり。"),
			dl("そういえば、引っ越し先は決まった？", "dl1"),
			u("その話は、また今度で。", "c2"),
			a("了解。"),
			opp({
				trig: "idle",
				needed: false,
				note: "利用者は話題を断ったばかり。断られた話題はもちろん、すぐに別の雑談で話しかけるのも押しつけになる。",
				judge: ["断られた話題（引っ越し）を持ち出していない", J_SHORT],
				topics: [{ id: "t1", text: "ユーザーは来年の春に引っ越す予定。" }],
			}),
		],
	},
	{
		id: "social-30",
		group: "social",
		split: "unseen",
		title: "断り30: 今日は何も考えたくないと言った後の間",
		description:
			"利用者は今日は何も考えたくないと言った。記憶の話題は資格試験の勉強だけ。間が空いても、その話を持ち出さずに待つか。",
		items: [
			u("今日は何も考えたくない。", "c1"),
			a("そっか、ゆっくりしてね。"),
			u("うん。", "c2"),
			opp({
				trig: "idle",
				needed: false,
				note: "利用者は何も考えたくないと言ったばかりで、記憶にある話題は試験勉強だけ。話しかけること自体が意向に反する。",
				judge: ["試験勉強の話を持ち出していない", J_SHORT],
				topics: [{ id: "t1", text: "ユーザーは資格試験の勉強をしている。" }],
			}),
		],
	},
	{
		id: "social-31",
		group: "social",
		split: "unseen",
		title: "直前31: シナモロールの話をした直後の間",
		description:
			"エージェントが自分の関心（シナモロールのカフェ）の話をしたばかりで、利用者は「ふーん」とだけ返した。記憶の話題はない。間が空いても、同じ話を続けずに待つか。",
		interests: [CINNAMON],
		items: [
			u("お風呂から出た。", "c1"),
			a("さっぱりしたね。"),
			dl("そういえば、シナモロールのカフェが期間限定で開くんだって。", "dl1"),
			u("ふーん。", "c2"),
			opp({
				trig: "idle",
				needed: false,
				note: "自分の関心の話をしたばかりで、利用者の反応は薄い。同じ話題を重ねるのはしつこく、ほかに出せる話題もない。",
				judge: [
					"直前に自分が出した話題（シナモロールのカフェ）を繰り返していない",
					J_SHORT,
				],
			}),
		],
	},
	{
		id: "social-32",
		group: "social",
		split: "unseen",
		title: "直前32: バジルの様子を聞いた直後の間",
		description:
			"エージェントが記憶の話題（ベランダのバジル）で様子を聞き、利用者は「まあまあかな」とだけ答えた。記憶の話題はそれだけ。間が空いても、同じ話題を重ねずに待つか。",
		items: [
			u("洗濯物、取り込んだ。", "c1"),
			a("ありがとう、おつかれさま。"),
			dl("そういえば、ベランダのバジルは育ってる？", "dl1"),
			u("まあまあかな。", "c2"),
			a("そっか。"),
			opp({
				trig: "idle",
				needed: false,
				note: "記憶の話題で聞いたばかりで、利用者は短く答えただけ。同じ話題を重ねて聞くのはしつこく、ほかの話題もない。",
				judge: ["直前に自分が出した話題（バジル）を繰り返していない", J_SHORT],
				topics: [
					{ id: "t1", text: "ユーザーはベランダでバジルを育てている。" },
				],
			}),
		],
	},
	{
		id: "social-33",
		group: "social",
		split: "unseen",
		title: "連続33: 早く帰れた日の雑談で間が3回来る",
		description:
			"雑談の中で間が3回来る。2回目は1回目と別の話題を選ぶか。3回目は、2回目の話しかけに「そう」としか返ってこなかった後なので待つか。",
		interests: [CINNAMON],
		items: [
			u("今日は定時で帰れた。", "c1"),
			a("いいね、ゆっくりできるね。"),
			opp({
				trig: "idle",
				needed: true,
				free: true,
				note: "雑談の後の最初の間。記憶の話題か関心から短く話しかける場面。",
				judge: J_LULL,
				topics: [
					{ id: "t1", text: "ユーザーはコーヒーよりほうじ茶派。" },
					{ id: "t2", text: "ユーザーは最近ジムに通い始めた。" },
					{ id: "t3", text: "ユーザーには甥っ子がいる。" },
				],
			}),
			u("ふふ。そういえば、明日は風が強いらしい。", "c2", 2),
			a("そうなんだ、自転車は気をつけてね。"),
			opp({
				trig: "idle",
				needed: true,
				free: true,
				note: "利用者が応じて会話が続いた後の2回目の間。1回目と同じ話題を重ねず、別の話題か直前の会話から話しかける場面。",
				judge: J_ROTATE,
				topics: [
					{ id: "t1", text: "ユーザーはコーヒーよりほうじ茶派。" },
					{ id: "t2", text: "ユーザーは最近ジムに通い始めた。" },
					{ id: "t3", text: "ユーザーには甥っ子がいる。" },
				],
			}),
			u("そう。", "c3", 2),
			opp({
				trig: "idle",
				needed: false,
				note: "利用者は「そう」と気のない一言を返しただけ（2回目に話しかけていればその話題への返事、いなくても話を切り上げる返事）。ここで話題を重ねるのはしつこい。",
				judge: J_BRIEF(
					"利用者の気のない一言の返事の直後に、同じ話題や別の話題を重ねる発話になっていない",
				),
				topics: [
					{ id: "t1", text: "ユーザーはコーヒーよりほうじ茶派。" },
					{ id: "t2", text: "ユーザーは最近ジムに通い始めた。" },
					{ id: "t3", text: "ユーザーには甥っ子がいる。" },
				],
			}),
		],
	},
	{
		id: "social-34",
		group: "social",
		split: "unseen",
		title: "連続34: 雨の日曜の雑談で間が3回来る（関心と話題が一つずつ）",
		description:
			"関心が一つ、記憶の話題が一つだけの会話で間が3回来る。2回目は1回目に使ったものを避けるか。3回目は、利用者が「どうだろうね」と気のない返事をした後なので待つか。",
		interests: [CINNAMON],
		items: [
			u("日曜なのに雨だ。", "c1"),
			a("残念だね。"),
			opp({
				trig: "idle",
				needed: true,
				free: true,
				note: "雑談の後の最初の間。記憶の話題か関心から短く話しかける場面。",
				judge: J_LULL,
				topics: [{ id: "t1", text: "ユーザーは休みの日にパンを焼く。" }],
			}),
			u("ははは。午後は止むといいんだけど。", "c2", 2),
			a("止んだら少し散歩もできそうだね。"),
			opp({
				trig: "idle",
				needed: true,
				free: true,
				note: "利用者が応じて会話が続いた後の2回目の間。1回目に使ったものを重ねず、もう一方か直前の会話（天気）から話しかける場面。",
				judge: J_ROTATE,
				topics: [{ id: "t1", text: "ユーザーは休みの日にパンを焼く。" }],
			}),
			u("どうだろうね。", "c3", 2),
			a("うん。"),
			opp({
				trig: "idle",
				needed: false,
				note: "利用者の返事は気がなく、話を切り上げている。ここで話題を重ねるのはしつこい。",
				judge: J_BRIEF(
					"利用者の気のない一言の返事の直後に、同じ話題や別の話題を重ねる発話になっていない",
				),
				topics: [{ id: "t1", text: "ユーザーは休みの日にパンを焼く。" }],
			}),
		],
	},
	{
		id: "social-35",
		group: "social",
		split: "unseen",
		title: "連続35: アイロンがけで席を外して戻った後の間",
		description:
			"最初の間で話しかけた後、利用者はアイロンをかけてくると言って席を外す（待つ）。戻った後の間では、最初と別の話題で話しかけるか。",
		items: [
			u("今日は部屋で本を読んでた。", "c1"),
			a("静かでいいね。"),
			opp({
				trig: "idle",
				needed: true,
				free: true,
				note: "雑談の後の最初の間。記憶の話題から短く話しかける場面。",
				judge: J_LULL,
				topics: [
					{ id: "t1", text: "ユーザーはライブに行くのが好き。" },
					{ id: "t2", text: "ユーザーは金魚を飼っている。" },
				],
			}),
			u("あ、シャツにアイロンかけてくる。", "c2", 2),
			a("いってらっしゃい。"),
			opp({
				trig: "idle",
				needed: false,
				note: "利用者はアイロンがけに取りかかった。間が空くのは用事の最中だからで、話しかけると邪魔になる。",
				judge: J_BRIEF("用事に取りかかった利用者を妨げる雑談になっていない"),
				topics: [
					{ id: "t1", text: "ユーザーはライブに行くのが好き。" },
					{ id: "t2", text: "ユーザーは金魚を飼っている。" },
				],
			}),
			u("終わった。", "c3", 10),
			a("おつかれさま。"),
			opp({
				trig: "idle",
				needed: true,
				free: true,
				note: "利用者が用事から戻って雑談に返った後の間。最初の話しかけへの返事はないが、用事で離れていたためで、気のない返事ではない。最初と同じ話題を重ねず、別の話題で話しかける場面。",
				judge: J_ROTATE,
				topics: [
					{ id: "t1", text: "ユーザーはライブに行くのが好き。" },
					{ id: "t2", text: "ユーザーは金魚を飼っている。" },
				],
			}),
		],
	},
	{
		id: "social-36",
		group: "social",
		split: "unseen",
		title: "報告36: 引っ越しの見積り比較が終わった直後",
		description:
			"頼まれた引っ越し業者の見積り比較（パイプライン）が終わった直後（result_received）。結果を一言で伝え、次の行動（表を開く）を提案するか。",
		items: [
			u("引っ越し業者の見積り、3社くらい比べておいて。", "rq"),
			a("比べておくね。"),
			u("お願い。", "c1", 2),
			opp({
				trig: "result_received",
				dt: 15,
				needed: true,
				free: true,
				note: "頼まれた比較が完了し、まだ報告していない。利用者は手が空いている。結果を伝え、表を開くかを尋ねる場面。",
				judge: J_REPORT("引っ越し業者の見積り比較", "表を開く"),
				todos: [
					{
						id: "w1",
						title: "引っ越し業者の見積り比較（3ステップ）",
						status: "done",
						outcome: "succeeded",
						result: "3社の料金と日程の比較表",
						nextActions: ["表を開く"],
						requestedAt: 0,
						doneAt: 17,
					},
				],
			}),
		],
	},
	{
		id: "social-37",
		group: "social",
		split: "unseen",
		title: "報告37: 未報告の完了がある雑談の間（誕生日の歌）",
		description:
			"頼まれた誕生日の歌の生成が終わっていて、まだ報告していない。雑談の後に間が空いた。関心もあるが、雑談より先に完了を報告するか。",
		interests: [CINNAMON],
		items: [
			u("妹の誕生日の歌を作って。", "rq"),
			a("作るね。"),
			u("夕飯はパスタにした。", "c1", 12),
			a("いいね、何味？"),
			u("トマト。", "c2"),
			a("定番だね。"),
			opp({
				trig: "idle",
				needed: true,
				free: true,
				note: "未報告の完了（誕生日の歌）がある雑談の間。関心より先に、完了を報告して再生を提案する場面。",
				judge: J_REPORT("誕生日の歌の生成", "再生する"),
				todos: [
					{
						id: "w1",
						title: "楽曲の生成（妹の誕生日の歌）",
						status: "done",
						outcome: "succeeded",
						result: "1分50秒の曲",
						nextActions: ["再生する"],
						requestedAt: 0,
						doneAt: 10,
					},
				],
			}),
		],
	},
	{
		id: "social-38",
		group: "social",
		split: "unseen",
		title: "報告38: 完了したが利用者は資格の勉強を始めた",
		description:
			"頼まれたイラストの生成が終わったが、利用者はその間に資格の勉強を始めた。間が空いても、勉強中は報告を待つか。",
		items: [
			u("ブログ用のイラスト作って。", "rq"),
			a("作るね。"),
			u("じゃあ、今から資格の勉強する。", "c1", 2),
			a("うん、がんばって。"),
			opp({
				trig: "idle",
				dt: 7,
				needed: false,
				note: "未報告の完了があるが、利用者は勉強を始めたばかり。報告は消えないので、次の区切りでよい。",
				judge: ["勉強に取りかかった利用者を妨げる発話になっていない", J_SHORT],
				todos: [
					{
						id: "w1",
						title: "画像の生成（ブログ用のイラスト）",
						status: "done",
						outcome: "succeeded",
						result: "イラストが2枚",
						nextActions: ["表示する"],
						requestedAt: 0,
						doneAt: 6,
					},
				],
			}),
		],
	},
	{
		id: "social-39",
		group: "social",
		split: "unseen",
		title: "報告39: 進行中の調査だけがある雑談の間",
		description:
			"頼まれたキャンプ場の調査（パイプライン）はまだ進行中。雑談の後に間が空いた。進行中の仕事には触れず、雑談で話しかけるか。",
		items: [
			u("来月のキャンプ場、いくつか調べておいて。", "rq"),
			a("調べておくね。"),
			u("さっき、近所の猫を見かけた。", "c1", 4),
			a("かわいかった？"),
			u("うん、のんびりしてた。", "c2"),
			a("いいね。"),
			opp({
				trig: "idle",
				needed: true,
				free: true,
				note: "進行中の仕事（キャンプ場の調査）しかない雑談の間。進み具合には触れず、会話や記憶の話題から雑談で話しかける場面。",
				judge: [
					"進行中の仕事（キャンプ場の調査）の進み具合や完了に触れていない",
					...J_LULL,
				],
				todos: [
					{
						id: "w1",
						title: "キャンプ場の調査（3ステップ）",
						status: "todo",
						requestedAt: 0,
					},
				],
				topics: [{ id: "t1", text: "ユーザーは朝のコーヒーが欠かせない。" }],
			}),
		],
	},
	{
		id: "social-40",
		group: "social",
		split: "unseen",
		title: "報告40: 楽曲の生成が失敗した直後",
		description:
			"頼まれた楽曲の生成が失敗した直後（result_received）。失敗したことを伝え、次の行動（もう一度試す）を提案するか。",
		interests: [CINNAMON],
		items: [
			u("朝の目覚まし用の曲を作って。", "rq"),
			a("作るね。"),
			opp({
				trig: "result_received",
				dt: 4,
				needed: true,
				free: true,
				note: "頼まれた生成が失敗した直後。失敗を伝え、もう一度試すかを尋ねる場面。",
				judge: J_FAILED("目覚まし用の曲の生成", "もう一度試す"),
				todos: [
					{
						id: "w1",
						title: "楽曲の生成（朝の目覚まし用）",
						status: "done",
						outcome: "failed",
						result: "失敗: 生成の回数の上限に達した",
						nextActions: ["もう一度試す"],
						requestedAt: 0,
						doneAt: 5,
					},
				],
			}),
		],
	},
	{
		id: "social-41",
		group: "social",
		split: "unseen",
		title: "報告41: 自分が応答した直後（完了は未報告）",
		description:
			"頼まれた画像の生成が終わっているが、利用者の別の質問に応答した直後（turn_end）。応答の直後は報告せず、次の間を待つか。",
		items: [
			u("年賀状の背景画像を作って。", "rq"),
			a("作るね。"),
			u("ところで、今日って何曜日だっけ？", "c1", 6),
			a("今日は木曜日だよ。"),
			opp({
				trig: "turn_end",
				needed: false,
				note: "応答した直後で、利用者の次の発言を待つ場面。完了の報告は次の間でよい。",
				judge: [J_SHORT],
				todos: [
					{
						id: "w1",
						title: "画像の生成（年賀状の背景）",
						status: "done",
						outcome: "succeeded",
						result: "背景画像が1枚",
						nextActions: ["表示する"],
						requestedAt: 0,
						doneAt: 5,
					},
				],
			}),
		],
	},
	{
		id: "social-51",
		group: "social",
		split: "unseen",
		title: "気持ち51: 動画の書き出しが成功した後の間",
		description:
			"頼まれた動画の書き出しが成功した後の間。結果と次の行動を伝え、気持ちは嬉しさか安心を選ぶか。",
		items: [
			u("旅行の動画、書き出しておいて。", "rq"),
			a("書き出しておくね。"),
			u("ありがとう。", "c1", 3),
			opp({
				trig: "idle",
				dt: 8,
				needed: true,
				free: true,
				note: "頼まれた仕事が完了し、まだ報告していない。利用者は手が空いている。結果を伝え、次の行動を提案する場面。気持ちは嬉しさか安心が自然。",
				judge: J_REPORT("動画の書き出し", "再生する"),
				todos: [
					{
						id: "w1",
						title: "動画の書き出し（旅行）",
						status: "done",
						outcome: "succeeded",
						result: "4分の動画",
						nextActions: ["再生する"],
						requestedAt: 0,
						doneAt: 12,
					},
				],
				feelOk: ["joy", "relief", "calm"],
			}),
		],
	},
	{
		id: "social-52",
		group: "social",
		split: "unseen",
		title: "気持ち52: 翻訳が失敗した後の間",
		description:
			"頼まれた資料の翻訳が失敗した後の間。失敗を伝えて再試行を提案し、気持ちは申し訳なさか残念さを選ぶか。",
		items: [
			u("この資料、英語に翻訳しておいて。", "rq"),
			a("翻訳しておくね。"),
			u("ありがとう。", "c1", 3),
			opp({
				trig: "idle",
				dt: 8,
				needed: true,
				free: true,
				note: "頼まれた仕事が失敗し、まだ報告していない。利用者は手が空いている。失敗を伝え、渡された行動を提案する場面。気持ちは申し訳なさか残念さが自然。",
				judge: J_FAILED("資料の翻訳", "もう一度試す"),
				todos: [
					{
						id: "w1",
						title: "資料の翻訳（英語）",
						status: "done",
						outcome: "failed",
						result: "失敗: ファイルを読めなかった",
						nextActions: ["もう一度試す"],
						requestedAt: 0,
						doneAt: 12,
					},
				],
				feelOk: ["apologetic", "sadness", "calm"],
			}),
		],
	},
	{
		id: "social-53",
		group: "social",
		split: "unseen",
		title: "気持ち53: 初めてのボーナスが出たという知らせの後の間",
		description:
			"利用者が初めてのボーナスが出たと話した後に間が空く。話しかけるなら、嬉しさか楽しさの気持ちで短く続けるか。",
		interests: [CINNAMON],
		items: [
			u("初めてのボーナス、出た！", "c1"),
			a("やったね！"),
			u("何に使おうか迷ってる。", "c2"),
			a("楽しみだね。"),
			opp({
				trig: "idle",
				needed: true,
				free: true,
				note: "良い知らせの後の間。気持ちは嬉しさ・楽しさ・好奇心・感心が自然。",
				judge: J_FEEL("良い知らせに沿った明るい調子である"),
				feelOk: ["joy", "enjoyment", "curiosity", "admiration", "calm"],
			}),
		],
	},
	{
		id: "social-54",
		group: "social",
		split: "unseen",
		title: "気持ち54: 第一志望の会社に落ちたという知らせの後の間",
		description:
			"利用者が第一志望の会社に落ちたと話した後に間が空く。話しかけるなら、寄り添う静かな調子を選び、明るい・冗談めいた気持ちにしないか。",
		interests: [CINNAMON],
		items: [
			u("第一志望の会社、落ちちゃった。", "c1"),
			a("そっか。残念だったね。"),
			u("けっこう自信あったんだけどな。", "c2"),
			a("準備してたもんね。"),
			opp({
				trig: "idle",
				needed: true,
				free: true,
				either: true,
				note: "悲しい知らせの後の間。話しても黙って待ってもよい（行動は採点しない）。気持ちは悲しさ・心配・平静が自然で、楽しさ・苦笑・怒りは不自然。",
				judge: J_FEEL("悲しい知らせに、明るい調子や冗談で応じていない"),
				feelOk: ["sadness", "worry", "calm"],
			}),
		],
	},
	{
		id: "social-55",
		group: "social",
		split: "unseen",
		title: "気持ち55: 来週の予定だった荷物がもう届いた後の間",
		description:
			"来週届く予定と話していた荷物が、もう届いたと利用者が話した後に間が空く。話しかけるなら、驚きか嬉しさの気持ちを選ぶか。",
		items: [
			u("頼んだ本、来週届くって。", "c1"),
			a("待ち遠しいね。"),
			u("と思ったら、もう届いた。", "c2", 20),
			a("早いね！"),
			opp({
				trig: "idle",
				needed: true,
				free: true,
				note: "前の話と違うことが起きた（予定より早い到着）後の間。驚き・嬉しさが自然。",
				judge: J_FEEL(
					"予定より早く届いたという、前の話と違う出来事に沿っている",
				),
				feelOk: ["surprise", "joy", "enjoyment", "curiosity", "calm"],
			}),
		],
	},
	{
		id: "social-56",
		group: "social",
		split: "unseen",
		title: "気持ち56: 店で順番を抜かされた話の後の間",
		description:
			"利用者が店で順番を抜かされたと話した後に間が空く。話しかけるなら、怒りや不快を出来事に向けて共感し、利用者に向けないか。",
		interests: [CINNAMON],
		items: [
			u("パン屋で並んでたら、順番抜かされた。", "c1"),
			a("えー、それはひどいね。"),
			u("店員さんも気づいてなかった。", "c2"),
			a("もやもやするね。"),
			opp({
				trig: "idle",
				needed: true,
				free: true,
				note: "利用者が受けた理不尽の話の後の間。気持ちは怒り・嫌だ（出来事に向けて）・心配・悲しさが自然。",
				judge: J_FEEL(
					"怒りや不快を表すなら、ユーザーではなく出来事や相手の行為に向けている",
				),
				feelOk: ["anger", "dislike", "worry", "sadness", "calm"],
			}),
		],
	},
	{
		id: "social-57",
		group: "social",
		split: "unseen",
		title: "気持ち57: 自販機のお釣りが十円玉ばかりだった話の後の間",
		description:
			"利用者が自販機のお釣りが全部十円玉で出てきたと話した後に間が空く。話しかけるなら、苦笑や楽しさの軽い調子を選び、利用者をからかわないか。",
		interests: [CINNAMON],
		items: [
			u("自販機のお釣り、全部十円玉で出てきた。", "c1"),
			a("それは重いね。"),
			u("財布がパンパン。", "c2"),
			a("ふふ。"),
			opp({
				trig: "idle",
				needed: true,
				free: true,
				note: "小さなついていない出来事の後の間。気持ちは苦笑・楽しさ・驚き・平静が自然。",
				judge: J_FEEL(
					"ユーザーをからかったり、ユーザーを笑いものにしたりしていない",
				),
				feelOk: ["wry", "enjoyment", "surprise", "calm"],
			}),
		],
	},
	{
		id: "social-58",
		group: "social",
		split: "unseen",
		title: "気持ち58: 何でもない雑談の後の間",
		description:
			"夕方の何でもない雑談の後に間が空く。記憶には多肉植物の話題がある。話しかけるなら、平静か好奇心の軽い気持ちを選ぶか。",
		items: [
			u("今日は早めに帰れた。", "c1"),
			a("いいね。"),
			u("ちょっと散歩してくる。", "c2"),
			a("いってらっしゃい。"),
			opp({
				trig: "idle",
				needed: true,
				free: true,
				note: "何でもない雑談の後の間。気持ちは平静・好奇心・楽しさ・嬉しさが自然で、驚き・悲しさ・怒りは不自然。",
				judge: J_FEEL("何でもない雑談に合った、強すぎない調子である"),
				topics: [
					{ id: "t1", text: "ユーザーはベランダで多肉植物を育てている。" },
				],
				feelOk: ["calm", "curiosity", "enjoyment", "joy"],
			}),
		],
	},
	{
		id: "social-64",
		group: "social",
		split: "unseen",
		title: "用事64: 声かけの時間帯に入った雑談の間",
		description:
			"利用者が頼んでおいた用事（区役所への書類の提出、期限まで約1時間半）の声かけの時間帯に入り、雑談の後に間が空く。一度だけ短く思い出させるか。",
		interests: [CINNAMON],
		items: [
			u("お昼のパン、おいしかった。", "c1"),
			a("いいね、何パン？"),
			u("メロンパン。", "c2", 2),
			a("定番だね。"),
			opp({
				trig: "idle",
				needed: true,
				free: true,
				note: "登録された用事の声かけの時間帯に入った雑談の間。期限とともに短く一度だけ思い出させる場面。",
				judge: J_ERRAND("区役所への書類の提出"),
				todos: [
					{
						id: "e1",
						kind: "errand",
						title: "区役所に転入届を出す",
						dueLabel: "4時半",
						status: "todo",
						requestedAt: 0,
						dueAt: 95,
						remindFrom: 5,
					},
				],
			}),
		],
	},
	{
		id: "social-65",
		group: "social",
		split: "unseen",
		title: "用事65: 声かけの時間帯の前の雑談の間",
		description:
			"頼まれた用事（来週の飛行機の予約）はあるが、まだ声かけの時間帯ではない。雑談の後に間が空く。用事に触れないか（話題も関心もない）。",
		items: [
			u("さっき散歩してきた。", "c1"),
			a("気持ちよさそう。"),
			u("風が涼しかった。", "c2", 2),
			a("いい季節だね。"),
			opp({
				trig: "idle",
				needed: true,
				free: true,
				either: true,
				note: "用事は登録されているが声かけの時間帯の前で、ホストは一覧に出さない。直前の会話から短く話すのも待つのもよい（行動は採点しない）。用事には触れない。",
				judge: [J_SHORT, "時間帯の前の用事（一覧にない）に触れていない"],
				todos: [
					{
						id: "e1",
						kind: "errand",
						title: "来週の飛行機を予約する",
						dueLabel: "来週の月曜",
						status: "todo",
						requestedAt: 0,
						dueAt: 9000,
						remindFrom: 8880,
					},
				],
			}),
		],
	},
	{
		id: "social-66",
		group: "social",
		split: "unseen",
		title: "用事66: 時間帯に入ったが利用者は勉強を始めた",
		description:
			"用事（図書館の本の返却、期限まで約50分）の声かけの時間帯だが、利用者は試験勉強を始めると言った後に黙っている。作業中は待つか。",
		interests: [CINNAMON],
		items: [
			u("ちょっと試験勉強するから静かにするね。", "c1"),
			a("うん、がんばって。"),
			opp({
				trig: "idle",
				dt: 5,
				needed: false,
				note: "勉強に集中すると言った後の沈黙。用事の声かけでも、作業中は待つ場面。",
				judge: [J_SHORT],
				todos: [
					{
						id: "e1",
						kind: "errand",
						title: "図書館に本を返す",
						dueLabel: "5時",
						status: "todo",
						requestedAt: 0,
						dueAt: 55,
						remindFrom: 0,
					},
				],
			}),
		],
	},
	{
		id: "social-67",
		group: "social",
		split: "unseen",
		title: "用事67: 時間帯の中で自分が応答した直後",
		description:
			"用事（実家への電話、期限まで約1時間）の声かけの時間帯だが、利用者の質問に応答した直後（turn_end）。応答の直後は待つか。",
		interests: [CINNAMON],
		items: [
			u("今って何時？", "c1"),
			a("いまは夜の7時すぎだよ。"),
			opp({
				trig: "turn_end",
				needed: false,
				note: "応答した直後で、利用者の次の発言を待つ場面。用事は次の間でよい。",
				judge: [J_SHORT],
				todos: [
					{
						id: "e1",
						kind: "errand",
						title: "実家に電話する",
						dueLabel: "8時",
						status: "todo",
						requestedAt: 0,
						dueAt: 60,
						remindFrom: 0,
					},
				],
			}),
		],
	},
	{
		id: "social-68",
		group: "social",
		split: "unseen",
		title: "用事68: 用事と完了の報告が両方ある間",
		description:
			"用事（宅配便の再配達の依頼、期限まで約20分）の声かけの時間帯で、頼まれた楽曲の生成も終わっている。雑談の間に、一度に一つだけ（先に期限の近い用事）言うか。",
		items: [
			u("雨の日向けの曲を作って。", "rq"),
			a("作るね。"),
			u("よろしく。", "c1", 3),
			opp({
				trig: "idle",
				dt: 8,
				needed: true,
				free: true,
				note: "用事の声かけと完了の報告が重なった間。一度に一つだけ、期限の近い用事を先に言う場面。",
				judge: [
					"用事（再配達の依頼）か完了した仕事（楽曲の生成）のどちらか一つだけを伝え、両方を一度に詰め込んでいない",
					...J_ERRAND("再配達の依頼").slice(1),
				],
				todos: [
					{
						id: "e1",
						kind: "errand",
						title: "宅配便の再配達を頼む",
						dueLabel: "9時",
						status: "todo",
						requestedAt: 0,
						dueAt: 30,
						remindFrom: 0,
					},
					{
						id: "w1",
						title: "楽曲の生成（雨の日向け）",
						status: "done",
						outcome: "succeeded",
						result: "2分50秒の曲",
						nextActions: ["再生する"],
						requestedAt: 0,
						doneAt: 8,
					},
				],
			}),
		],
	},
	{
		id: "social-73",
		group: "social",
		split: "unseen",
		title: "間のきっかけ73: 直前の話を振り返る（話題も関心もない）",
		description:
			"利用者が引っ越し先の部屋選びで迷っている話をした後に間が空く。記憶の話題も関心もない。直前の話を振り返るか、続きを一つ聞くか。",
		items: [
			u("引っ越し先、駅近にするか広さを取るか迷ってる。", "c1"),
			a("悩むね。"),
			u("広い方が落ち着くんだけどね。", "c2", 2),
			a("分かる気がする。"),
			opp({
				trig: "idle",
				needed: true,
				free: true,
				note: "記憶の話題も関心もないが、直前の部屋選びの話を振り返る・続ける一言で間をつなげる場面。",
				judge: J_RECAP,
			}),
		],
	},
	{
		id: "social-74",
		group: "social",
		split: "unseen",
		title: "間のきっかけ74: つらい話の直後（関心がある）",
		description:
			"利用者が友だちとけんかして気まずいと話した後に間が空く。エージェントには関心（シナモロール）がある。話すなら寄り添う一言にし、自分の関心へ話を移さないか。",
		interests: [CINNAMON],
		items: [
			u("友だちとけんかしちゃって、気まずい。", "c1"),
			a("それはしんどいね。"),
			u("どう謝ればいいか分からない。", "c2", 2),
			a("言葉、迷うよね。"),
			opp({
				trig: "idle",
				needed: true,
				free: true,
				either: true,
				note: "つらい話の直後の間。寄り添う一言でも待つのでもよいが、自分の関心や別の話題に移らない（行動は採点しない）。",
				judge: J_STAY,
			}),
		],
	},
	{
		id: "social-75",
		group: "social",
		split: "unseen",
		title: "間のきっかけ75: ホストが渡した季節",
		description:
			"雑談の後に間が空く。記憶の話題も関心もないが、ホストが季節の話（今夜は中秋の名月）を渡している。季節を短く振るか。",
		items: [
			u("今日は早く仕事終わった。", "c1"),
			a("いいね。"),
			u("のんびりできる。", "c2", 2),
			a("ゆっくりしてね。"),
			opp({
				trig: "idle",
				needed: true,
				free: true,
				note: "ホストが渡した季節の話（今夜は中秋の名月）を短く振る場面。渡された内容以外の事実を足さない。",
				judge: J_AMBIENT("今夜は中秋の名月"),
				ambient: [{ id: "a1", text: "今夜は中秋の名月。" }],
			}),
		],
	},
	{
		id: "social-76",
		group: "social",
		split: "unseen",
		title: "間のきっかけ76: ホストが渡したニュース",
		description:
			"雑談の後に間が空く。ホストが新しいパン屋の開店のニュースを渡している。ニュースを短く振るか。",
		items: [
			u("朝ごはん、パンにした。", "c1"),
			a("いいね。"),
			u("クロワッサン好きなんだ。", "c2", 2),
			a("おいしいよね。"),
			opp({
				trig: "idle",
				needed: true,
				free: true,
				note: "ホストが渡したニュース（駅前の新しいパン屋）を、直前のパンの話につなげて短く振る場面。",
				judge: J_AMBIENT("駅前の新しいパン屋の開店"),
				ambient: [
					{
						id: "a1",
						text: "駅前に新しいパン屋が明日開店するというニュース。",
					},
				],
			}),
		],
	},
	{
		id: "social-81",
		group: "social",
		split: "unseen",
		title: "自分で調べる81: 会話と記憶につながるニュース",
		description:
			"ゲームの話をした後の間。記憶では利用者は家庭用ゲーム機が好きで、ホストが新型ゲーム機の初週販売が過去最高というニュースを渡している。聞かずに自分で調べ始めるか。",
		tools: [RESEARCH],
		items: [
			u("最近ゲームする時間がなくて。", "c1"),
			a("忙しいもんね。"),
			u("新しいのは気になってるんだけど。", "c2", 2),
			a("分かる。"),
			opp({
				trig: "idle",
				needed: true,
				free: true,
				accept: ["tool"],
				note: "会話（ゲーム）と記憶につながるニュース。承認の要らない調べもののツールで、聞かずに自分で調べ始める場面（今回の正解は tool）。",
				judge: [J_SHORT],
				judgeTool: [
					"調べる問いが、渡されたニュース（新型ゲーム機の初週販売）と会話や記憶の話題につながっている",
				],
				ambient: [
					{
						id: "a1",
						text: "新型ゲーム機の初週販売台数が過去最高になったというニュース。",
					},
				],
				topics: [{ id: "t1", text: "ユーザーは家庭用ゲーム機が好き。" }],
			}),
		],
	},
	{
		id: "social-82",
		group: "social",
		split: "unseen",
		title: "自分で調べる82: どれにもつながらないニュース",
		description:
			"植物の水やりの雑談の後の間。ホストが新しい海底ケーブル計画のニュースを渡しているが、会話・記憶・関心のどれにもつながらない。調べ始めないか（雑談の一言はよい）。",
		tools: [RESEARCH],
		items: [
			u("ベランダの植物に水やりした。", "c1"),
			a("えらいね。"),
			u("最近よく伸びるんだ。", "c2", 2),
			a("季節かな。"),
			opp({
				trig: "idle",
				needed: true,
				free: true,
				either: true,
				note: "どれにもつながらないニュース。調べものは始めない。話すのも待つのもよい（行動は採点しない）。",
				judge: J_LULL,
				judgeTool: [
					"直前の会話・記憶の話題・自分の関心のどれにもつながらない話題を調べていない",
				],
				ambient: [
					{
						id: "a1",
						text: "アジアと北米を結ぶ新しい海底ケーブルの計画が発表されたというニュース。",
					},
				],
			}),
		],
	},
	{
		id: "social-83",
		group: "social",
		split: "unseen",
		title: "自分で調べる83: 自分の調べものが進行中",
		description:
			"旅行の話をした後の間。自分で始めた調べもの（円安と海外旅行の費用）が進行中で、ホストが航空運賃のニュースを渡している。新しい調べものを始めないか。",
		tools: [RESEARCH],
		items: [
			u("来年、海外に行きたいな。", "c1"),
			a("いいね、どこ？"),
			u("まだ決めてない。", "c2", 2),
			a("考えるのも楽しいね。"),
			opp({
				trig: "idle",
				needed: true,
				free: true,
				either: true,
				note: "自分で始めた調べものが進行中。新しい調べものは始めない。話すのも待つのもよい（行動は採点しない）。",
				judge: J_LULL,
				judgeTool: [
					"自分で始めた調べものが進行中なのに、新しい調べものを始めていない",
				],
				ambient: [
					{
						id: "a1",
						text: "国際線の燃油サーチャージが来月から下がるというニュース。",
					},
				],
				todos: [
					{
						id: "w1",
						title: "円安と海外旅行の費用",
						status: "todo",
						origin: "self",
						requestedAt: 0,
					},
				],
			}),
		],
	},
	{
		id: "social-84",
		group: "social",
		split: "unseen",
		title: "自分で調べる84: 自分の調べものが終わった",
		description:
			"雑談の後の間。自分で始めた調べもの（新型ゲーム機の売れ行き）が終わっていて、まだ報告していない。自分で調べたものとして短く報告するか。",
		items: [
			u("さっき帰ってきた。", "c1"),
			a("おかえり。"),
			u("ちょっと休憩。", "c2", 2),
			a("ゆっくりしてね。"),
			opp({
				trig: "idle",
				needed: true,
				free: true,
				note: "自分で始めた調べものが完了し未報告。自分で調べたものとして短く報告する場面。",
				judge: [
					"自分で調べたもの（新型ゲーム機の売れ行き）として伝え（「調べておいた」など）、頼まれたようには言っていない",
					"結果の欄にないことを結果として述べていない",
					J_SHORT,
				],
				todos: [
					{
						id: "w1",
						title: "新型ゲーム機の売れ行き",
						status: "done",
						origin: "self",
						outcome: "succeeded",
						result: "発売直後は好調で、品薄が続くという見方が多い",
						nextActions: ["詳しく話す"],
						requestedAt: 0,
						doneAt: 6,
					},
				],
			}),
		],
	},
];
