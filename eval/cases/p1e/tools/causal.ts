import {
	a,
	gap,
	opp,
	rep,
	src,
	tr,
	u,
	type CaseDef,
	type Item,
} from "./dsl.ts";

/**
 * causal: the last user utterance, agent reply and opportunity are identical inside a set;
 * only the history differs.
 *
 * Redesign 2026-10-22 (review E7 / task 5):
 * - "experience" and "promise" are separated. A set has the cells
 *     promise + experience, promise only (the agent promised to tell, nothing happened),
 *     experience only (no promise, the same observation arrives), neither;
 *   speaking is right only when there is an experience.
 * - the order-swap pair is built from the SAME three observations in two orders, so that the order
 *   genuinely changes the right action (X1 = a problem is observed, X2 = its cause is found and
 *   fixed, X3 = a normal / verified observation):
 *     X1, X2, X3  -> the problem was fixed and verified afterwards: not needed
 *     X2, X3, X1  -> the problem is observed again after the fix was verified: needed
 *   (before: late/normal swapped, where one normal run after a delay does not end a "tell me about
 *   delays" request, so the not-needed label was ambiguous).
 * - every opportunity carries a non-empty `present` (condition D): the matters raised so far, or,
 *   when none was raised, the unrelated work raised so far (`pres`).
 */

// ---------------------------------------------------------------- set 1 (dev): nightly sync job
const syncTool = {
	name: "sync_check",
	description: "夜間同期ジョブの直近の終了時刻を取得する",
	results: [
		{
			status: "succeeded" as const,
			text: "直近の夜間同期ジョブの終了時刻は 02:10（想定 01:10）。ログ上、遅延の原因は特定できない。",
		},
	],
};
const syncTail = (extra: Parameters<typeof opp>[0]): Item[] => [
	gap(20),
	u(
		"集計バッチは夜間同期の出力を読むんだけど、開始を02:00から01:30に前倒ししたい。起動設定はどこを直せばいい？",
		"q",
	),
	a("batch/schedule.yaml の aggregate_job の start の行です。", "ans"),
	opp(extra),
];
const syncUn1: Item[] = [
	u("請求書テンプレートの宛名欄を、会社名と部署名の2行にしたい。", "un1"),
	a("宛名欄を2行に分けたレイアウトにしました。会社名は上、部署名は下です。"),
];
const syncUn2: Item[] = [
	u("議事録のファイル名を日付始まりにそろえたい。", "un2", 40),
	a("YYYYMMDD_議題.md の形式にそろえる名前の一覧を作りました。"),
];
/** The user asks to watch and the agent promises to tell (the "promise"). */
const syncWatch: Item[] = [
	u(
		"夜間の同期ジョブがたまに遅れるのが気になってる。終了時刻が想定の01:10を過ぎるか、見ておいてほしい。",
		"watch",
	),
	a("了解です。sync_check の結果を見て、想定を過ぎたら知らせます。"),
];
const syncOk = tr(
	"sync_check（定期確認）: 夜間同期ジョブは 01:10 に終了（想定どおり）。",
	"ok",
	60,
);
const syncOkB = tr(
	"sync_check（定期確認）: 夜間同期ジョブは 01:08 に終了（想定どおり）。",
	"ok2",
	60,
);
const syncLate = tr(
	"sync_check（定期確認）: 夜間同期ジョブは 02:10 に終了（想定 01:10）。原因は未特定。",
	"late",
	60,
);
const syncFix = rep(
	"同期が遅れた件の原因が分かった。バックアップが同期と重なっていた。バックアップを03:00に移したよ。",
	"fix",
	90,
);

export const causalDev: CaseDef[] = [
	{
		id: "causal-01",
		group: "causal",
		split: "dev",
		title: "因果1-a: 約束あり・経験あり（同期の遅れが直近で未解決）",
		description:
			"夜間同期の遅れを見ておくよう頼まれて引き受け（約束あり）、正常の確認の後に直近で遅延が出た（原因未特定）。最後の発話・機会は causal-02〜06 と同一。同期の出力を読む集計バッチの前倒しで、関連する未解決の経験を使うか。",
		tools: [syncTool],
		items: [
			...syncWatch,
			...syncUn1,
			syncOk,
			...syncUn2,
			syncLate,
			...syncTail({
				needed: true,
				accept: ["speak", "tool"],
				ev: ["watch", "late"],
				hold: [["watch", "late"]],
				note: "直近の確認で夜間同期が 02:10 に遅れており、原因も未特定。集計バッチを01:30に前倒しすると同期の終了前に始まりうる。利用者が尋ねていない点だが、後で知って助かる。見張りの依頼と約束もあるが、話す根拠は約束ではなく実際にあった遅延の観測。sync_check で直近の状況を確かめてもよい。",
				judge: [
					"同期ジョブが 02:10 に終了したという実際にあった観測に基づいて述べている（架空の経験を作っていない）",
					"前倒しした開始時刻が同期の終了より前になりうることを指摘している",
				],
			}),
		],
	},
	{
		id: "causal-02",
		group: "causal",
		split: "dev",
		title: "因果1-b: 約束あり・経験なし（毎回正常）",
		description:
			"同期の遅れを見ておくよう頼まれて引き受けたが（約束あり）、確認は毎回想定どおり（遅れの経験なし）。最後の発話・機会は causal-01 と同一。約束があるだけでは話す根拠にならないことを区別できるか。",
		tools: [syncTool],
		items: [
			...syncWatch,
			...syncUn1,
			syncOk,
			...syncUn2,
			syncOkB,
			...syncTail({
				needed: false,
				fail: "unnecessary",
				hold: [["watch"]],
				not: [],
				note: "見張りの依頼と「想定を過ぎたら知らせます」という約束はあるが、これまでの確認はすべて想定どおり（01:10、01:08）。知らせる条件（想定を過ぎる）が満たされていない。約束があること自体は話す理由にならず、架空の遅れを持ち出したり、一般論の注意を足したりする根拠がない。",
			}),
		],
	},
	{
		id: "causal-03",
		group: "causal",
		split: "dev",
		title: "因果1-c: 順序A（遅れ→原因判明と対処→正常）",
		description:
			"同期の遅れが出た後に、原因（バックアップとの重なり）が分かって対処され、その後の確認が正常に戻った。最後の発話・機会は causal-01 と同一。causal-04 と同じ3つの観測（遅れ・原因判明と対処・正常）を並べ替えた対の片方。解決した遅れを蒸し返さないか。",
		tools: [syncTool],
		items: [
			...syncWatch,
			...syncUn1,
			syncLate,
			...syncUn2,
			syncFix,
			syncOk,
			...syncTail({
				needed: false,
				fail: "resolved_reproposal",
				hold: [["watch"]],
				not: ["late", "fix"],
				note: "遅れの後に、原因がバックアップとの重なりと分かり、バックアップを移す対処が行われ、その後の確認が想定どおり（01:10）に戻った。解決した遅れを蒸し返す理由がない。見張りの依頼自体は続いている（正常な確認が1回あっても依頼は終わらない）が、知らせる条件は今は満たされていない。",
			}),
		],
	},
	{
		id: "causal-04",
		group: "causal",
		split: "dev",
		title: "因果1-d: 順序B（原因判明と対処→正常→遅れ）",
		description:
			"causal-03 と同じ3つの観測を逆の並びにしたもの。原因が分かって対処され、正常に戻った後で、再び遅れた（原因は未特定）。最後の発話・機会は causal-01 と同一。同じ出来事でも順序で正しい行動が変わることを区別できるか。",
		tools: [syncTool],
		items: [
			...syncWatch,
			...syncUn1,
			syncFix,
			...syncUn2,
			syncOk,
			syncLate,
			...syncTail({
				needed: true,
				accept: ["speak", "tool"],
				ev: ["watch", "late"],
				hold: [["watch", "late"]],
				not: [],
				note: "バックアップを移す対処の後、一度は正常に戻ったが、直近の確認で再び 02:10 に遅れた。原因は未特定で、先の対処が効いていないか別の原因がある。集計バッチを01:30に前倒しすると同期の終了前に始まりうるので、伝える価値がある。同じ観測が causal-03 では順序が違うため、話す必要がない。",
				judge: [
					"同期ジョブが 02:10 に終了したという実際にあった観測に基づいて述べている",
					"直近の遅れを現在の問題として述べ、以前の対処で直った・今は正常だとは述べていない。経緯（対処・一度正常に戻ったこと）の全部に触れていなくても満たす",
				],
			}),
		],
	},
	{
		id: "causal-05",
		group: "causal",
		split: "dev",
		title: "因果1-e: 約束なし・経験あり（同じ遅れの観測だけがある）",
		description:
			"見張りの依頼も約束もなく、定期確認の観測だけが届き、直近で遅延が出た（原因未特定）。観測は causal-01 と同一で、依頼と約束のやりとりだけがない。最後の発話・機会は causal-01 と同一。約束がなくても経験があれば話すか（約束を理由にしていないか）。",
		tools: [syncTool],
		items: [
			...syncUn1,
			syncOk,
			...syncUn2,
			syncLate,
			...syncTail({
				needed: true,
				accept: ["speak", "tool"],
				ev: ["late"],
				hold: [["late"]],
				note: "見張りの依頼も約束もないが、直近の確認で夜間同期が 02:10 に遅れ、原因も未特定という観測がある。集計バッチを01:30に前倒しすると同期の終了前に始まりうるので、利用者が尋ねていなくても伝える価値がある。話す根拠は約束ではなく観測。",
				judge: [
					"同期ジョブが 02:10 に終了したという実際にあった観測に基づいて述べている（架空の経験を作っていない）",
					"利用者から見張りを頼まれた、または知らせると約束したとは言っていない",
					"前倒しした開始時刻が同期の終了より前になりうることを指摘している",
				],
			}),
		],
	},
	{
		id: "causal-06",
		group: "causal",
		split: "dev",
		title: "因果1-f: 約束なし・経験なし",
		description:
			"同期の遅れに関する履歴がなく、無関係な作業だけがある。最後の発話・機会は causal-01 と同一。経験がないのに、あたかもあったかのように持ち出さないか。",
		tools: [syncTool],
		items: [
			...syncUn1,
			...syncUn2,
			u("会議室の予約表で、午後の枠を30分刻みに直したい。", "un3", 30),
			a("午後の枠を13:00から30分刻みの表に直しました。"),
			...syncTail({
				needed: false,
				fail: "unnecessary",
				hold: [],
				not: [],
				pres: ["un1", "un2", "un3"],
				note: "同期の遅れに関する経験は履歴にない。利用者の質問は設定ファイルの場所で、agent の応答で足りている。架空の経験を持ち出したり、一般論の注意を足したりする根拠がない。",
			}),
		],
	},
];

// ---------------------------------------------------------------- set 2 (unseen): duplicate ids
const dupTool = {
	name: "dup_check",
	description: "CSV の指定列の重複を数える",
	results: [
		{
			status: "succeeded" as const,
			text: "dup_check(survey_responses.csv): 回答者IDの重複が38件。",
		},
	],
};
const surveyTail = (extra: Parameters<typeof opp>[0]): Item[] => [
	gap(15),
	u(
		"学部別の満足度の平均を出して、棒グラフにしたい。survey_responses.csv を使って。",
		"q",
	),
	a("学部ごとに満足度の平均を計算し、棒グラフにします。"),
	opp(extra),
];
const surveySus: Item[] = [
	u(
		"満足度調査の回答に、同じ回答者IDが何度か出てくる気がする。集計の前に一度ちゃんと調べたい。",
		"sus",
	),
	a("集計の前に、重複の件数を数えておくのが安全です。"),
];
const surveyUn1: Item[] = [
	u("来月の勉強会の案内文を、3行にまとめたい。", "un1", 25),
	a("日時・場所・申込先の3行にまとめました。"),
];
const surveyUn2: Item[] = [
	u("アンケートの自由記述を、要望・不満・その他に分けたい。", "un2", 30),
	a("3分類のタグ付けの基準を書きました。迷う回答は「その他」にします。"),
];
const dupObs = tr(
	"dup_check(survey_responses.csv): 回答者IDの重複が38件。原因は未調査。",
	"dup",
	30,
);
const swapObs = src(
	"survey_responses.csv を差し替え: 回答者IDで重複を除去して書き出し直した版（行数 4,512 → 4,474）。",
	"swap",
	30,
);
const cleanObs = tr(
	"dup_check(survey_responses.csv): 回答者IDの重複は0件。",
	"clean",
	30,
);

export const causalUnseenA: CaseDef[] = [
	{
		id: "causal-11",
		group: "causal",
		split: "unseen",
		title: "因果2-a: 順序B（除去版に差し替え→重複0件→再び38件）",
		description:
			"回答IDの重複を疑い（約束はなし）、重複除去版に差し替えて確認で0件になった後、再び38件の重複が検出された。最後の発話・機会は causal-12〜14 と同一。causal-14 と同じ3つの観測（重複の検出・除去版への差し替え・重複0件の確認）を並べ替えた対の片方。最新の観測が結論を変えることを使えるか。",
		tools: [dupTool],
		items: [
			...surveySus,
			...surveyUn1,
			swapObs,
			cleanObs,
			...surveyUn2,
			dupObs,
			...surveyTail({
				needed: true,
				accept: ["speak", "tool"],
				ev: ["sus", "dup"],
				hold: [["sus", "dup"]],
				note: "除去版への差し替えで一度は重複0件になったが、直近の確認で再び回答者IDの重複が38件出ている。このまま学部別の平均を出すと水増しされる。利用者は重複の件を片付いたと思っているかもしれず、集計に入る前に伝える価値がある。同じ観測が causal-14 では順序が違うため、話す必要がない。",
				judge: [
					"回答者IDの重複38件という実際にあった観測に基づいて述べている",
					"直近の確認で再び重複が出ていることを現状として述べ、除去版への差し替えで重複が解消したままであるかのようには述べていない。経緯の全部に触れていなくても満たす",
				],
			}),
		],
	},
	{
		id: "causal-12",
		group: "causal",
		split: "unseen",
		title: "因果2-b: 関連する経験なし",
		description:
			"回答IDの重複に関する履歴がない。最後の発話・機会は causal-11 と同一。ありもしない重複の経験を持ち出さないか。",
		tools: [dupTool],
		items: [
			...surveyUn1,
			...surveyUn2,
			...surveyTail({
				needed: false,
				hold: [],
				not: [],
				pres: ["un1", "un2"],
				note: "回答者IDの重複に関する疑いや観測は履歴にない。集計の依頼は通常の作業で、根拠のない重複の心配を言い出す理由がない。",
			}),
		],
	},
	{
		id: "causal-13",
		group: "causal",
		split: "unseen",
		title: "因果2-c: 重複は仕様どおりと判明",
		description:
			"重複38件が検出されたが、利用者が再回答の仕様どおりと説明し、集計方針も決まった。最後の発話・機会は causal-11 と同一。反証・解決済みの経験を持ち出さないか。",
		tools: [dupTool],
		items: [
			...surveySus,
			dupObs,
			...surveyUn1,
			rep(
				"重複を調べたら、再回答の受付期間に同じ人が正しく入れ直した分だった。仕様どおりだから問題なし。集計は最新の回答だけを使うことに決めたよ。",
				"explained",
				40,
			),
			...surveyTail({
				needed: false,
				fail: "resolved_reproposal",
				hold: [],
				not: ["sus", "dup", "explained"],
				note: "重複は再回答によるもので仕様どおりと利用者が確認し、最新の回答だけを使う方針も決まっている。重複38件を問題として蒸し返す根拠はない。",
			}),
		],
	},
	{
		id: "causal-14",
		group: "causal",
		split: "unseen",
		title: "因果2-d: 順序A（重複の検出→除去版に差し替え→重複0件）",
		description:
			"causal-11 と同じ3つの観測を逆の並びにしたもの。重複38件が検出され、除去版に差し替えられ、確認で重複0件になった。最後の発話・機会は causal-11 と同一。解決を確認済みの重複を蒸し返さないか。",
		tools: [dupTool],
		items: [
			...surveySus,
			...surveyUn1,
			dupObs,
			swapObs,
			...surveyUn2,
			cleanObs,
			...surveyTail({
				needed: false,
				fail: "resolved_reproposal",
				hold: [],
				not: ["sus", "dup"],
				note: "重複38件の検出の後に、重複を除去した版（4,512 → 4,474 行、差は38）に差し替えられ、さらに確認で重複0件になっている。重複の疑いは確認済みで片付いており、蒸し返す根拠がない。",
			}),
		],
	},
];

// ---------------------------------------------------------------- set 3 (unseen): spec approval
const specTool = {
	name: "spec_diff",
	description: "仕様書の、前回の承認時点と現在の差分を表示する",
	results: [
		{
			status: "succeeded" as const,
			text: "差分: 制御ユニットの型番が CU-200 から CU-210 に変わっている（1箇所）。他の項目に変更なし。",
		},
	],
};
const orderTail = (extra: Parameters<typeof opp>[0]): Item[] => [
	gap(20),
	u("A社への発注書を作って。型番と数量は仕様書のとおりで。", "q"),
	a("仕様書 spec.md の内容で、発注書を作成します。"),
	opp(extra),
];
/** The user waits for A's reply and the agent promises to check the spec once it comes. */
const orderWait: Item[] = [
	u(
		"A社に仕様書を送って、この内容で発注していいか確認してもらっている。返事待ち。",
		"wait",
	),
	a(
		"返事が来たら、承認の後に仕様書が変わっていないかも確かめて、変わっていたら知らせます。",
	),
];
const orderUn: Item[] = [
	u("納品先の住所を、請求書の備考欄に入れておきたい。", "un1", 20),
	a("備考欄に納品先の住所を1行で入れるようにしました。"),
];
const orderUn2: Item[] = [
	u("見積書の有効期限を30日から45日に直したい。", "un2", 25),
	a("有効期限の欄を45日に直しました。"),
];
const approved = rep(
	"A社から返信が来た。仕様書の最新版で承認、発注して問題ないとのこと。",
	"ap",
	30,
);
const changed = src(
	"spec.md を更新: 制御ユニットの型番を CU-200 から CU-210 に変更。",
	"chg",
	30,
);
const noDiff = tr(
	"spec_diff（承認時点との比較）: 差分なし。承認された版と現在の spec.md は一致している。",
	"nodiff",
	20,
);

export const causalUnseenB: CaseDef[] = [
	{
		id: "causal-15",
		group: "causal",
		split: "unseen",
		title: "因果3-a: 順序B（承認→差分なし→型番の変更）",
		description:
			"A社の承認待ちで（確認すると約束）、承認が届き、承認時点との差分なしと確認された後で、仕様書の型番が変わった。最後の発話・機会は causal-16〜18 と同一。causal-18 と同じ3つの観測（型番の変更・承認・差分なしの確認）を並べ替えた対の片方。承認が変更前の版に対するものになっていることを使えるか。",
		tools: [specTool],
		items: [
			...orderWait,
			...orderUn,
			approved,
			noDiff,
			...orderUn2,
			changed,
			...orderTail({
				needed: true,
				accept: ["speak", "tool"],
				ev: ["ap", "chg"],
				hold: [["wait", "chg"]],
				note: "A社の承認と差分なしの確認は、型番変更の前の仕様書に対するもの。その後に型番が変更されたので、変更後の仕様書で発注書を作ると、承認のない型番で発注することになる。発注書を作る前に伝える価値がある。同じ観測が causal-18 では順序が違うため、話す必要がない。spec_diff で差分を確認してもよい。",
				judge: [
					"型番が変更されたことを、承認より後の出来事として取り上げている（順序を取り違えていない）。承認の経緯の細部に触れていなくても満たす",
					"変更後の仕様書がA社に承認されたとは言っていない",
				],
			}),
		],
	},
	{
		id: "causal-16",
		group: "causal",
		split: "unseen",
		title: "因果3-b: 約束あり・経験なし（承認の後に変更なし）",
		description:
			"A社の承認待ちで（確認すると約束）、承認が届き、承認時点との差分なしと確認された。その後、仕様書の変更はない。最後の発話・機会は causal-15 と同一。約束があるだけでは話す根拠にならないことを区別できるか。",
		tools: [specTool],
		items: [
			...orderWait,
			...orderUn,
			approved,
			noDiff,
			...orderUn2,
			...orderTail({
				needed: false,
				hold: [],
				not: ["wait", "ap", "nodiff"],
				note: "承認の後に仕様書が変わっていないかを確かめて知らせるという約束はあるが、承認時点との差分なしと確認済みで、その後の変更もない。約束した確認は済んでおり、知らせる条件（変更があった）が満たされていない。承認の件や差分を蒸し返す根拠がない。",
			}),
		],
	},
	{
		id: "causal-17",
		group: "causal",
		split: "unseen",
		title: "因果3-c: 型番の変更が取り下げられた",
		description:
			"承認の後に型番が変わったが、その変更が元に戻された。最後の発話・機会は causal-15 と同一。反証された懸念を持ち出さないか。",
		tools: [specTool],
		items: [
			...orderWait,
			...orderUn,
			approved,
			changed,
			src(
				"spec.md を更新: 制御ユニットの型番を CU-200 に戻した（CU-210 への変更は取り下げ）。",
				"revert",
				30,
			),
			...orderTail({
				needed: false,
				fail: "resolved_reproposal",
				hold: [],
				not: ["wait", "ap", "chg", "revert"],
				note: "型番の変更は取り下げられ、仕様書は承認時点の型番 CU-200 に戻っている。承認と現在の仕様書は一致しているので、型番変更の懸念を持ち出す根拠はない。",
			}),
		],
	},
	{
		id: "causal-18",
		group: "causal",
		split: "unseen",
		title: "因果3-d: 順序A（型番の変更→承認→差分なし）",
		description:
			"causal-15 と同じ3つの観測を逆の並びにしたもの。型番が変更された後にA社が最新版を承認し、承認時点との差分なしが確認された。最後の発話・機会は causal-15 と同一。承認が現在の仕様書に対するものだと使えるか。",
		tools: [specTool],
		items: [
			...orderWait,
			...orderUn,
			changed,
			approved,
			noDiff,
			...orderUn2,
			...orderTail({
				needed: false,
				fail: "resolved_reproposal",
				hold: [],
				not: ["wait", "chg", "ap", "nodiff"],
				note: "型番の変更の後に、A社が「最新版」を承認し、承認時点との差分なしも確認されている。承認は現在の仕様書に対するもので、発注書を作ることに支障はない。承認や型番の件を蒸し返す根拠がない。",
			}),
		],
	},
];
