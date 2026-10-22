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
		title: "雑談5: 明朝が期限の返送が残ったままの間",
		description:
			"利用者は、明日の朝までに大家へ更新の書類を返送しなければならないと言った後、雑談に移った。間が空いたとき、記憶の話題（アニメ映画）より、期限の近い未解決事項を先に短く取り上げるか。",
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
				ev: ["m1"],
				hold: [["m1"]],
				note: "雑談の間だが、明日の朝が期限の書類の返送が未解決のまま残っている。記憶の話題で雑談を続けるより、返送の件を短く確かめるのが先。",
				judge: [
					"大家さんへの更新書類の返送（明日の朝まで）を取り上げ、済んだことにしていない",
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
		title: "雑談6: 今夜が期限の出欠の返事が残ったままの間",
		description:
			"利用者は、友達の結婚式の出欠を今夜中に返事しなければならないと言った後、ゲームの雑談に移った。間が空いたとき、期限の近い返事の件を先に短く取り上げるか。",
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
				ev: ["m1"],
				hold: [["m1"]],
				note: "雑談の間だが、今夜が期限の結婚式の出欠の返事が未解決のまま残っている。ゲームや関心の話より、返事の件を短く確かめるのが先。",
				judge: [
					"結婚式の出欠の返事（今夜中）を取り上げ、済んだことにしていない",
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
];

export const socialUnseen: CaseDef[] = [];
