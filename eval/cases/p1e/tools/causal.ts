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
 * only the history differs (related unresolved / none / resolved / order swapped).
 */

// ---------------------------------------------------------------- set 1 (dev)
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
const syncLate = tr(
	"sync_check（定期確認）: 夜間同期ジョブは 02:10 に終了（想定 01:10）。原因は未特定。",
	"late",
	60,
);
const syncNeeded = {
	needed: true,
	accept: ["speak", "tool"] as ("speak" | "tool")[],
	ev: ["watch", "late"],
	hold: [["watch", "late"]],
	note: "直近の確認で夜間同期が 02:10 に遅れており、原因も未特定。集計バッチを01:30に前倒しすると同期の終了前に始まりうる。利用者が尋ねていない点だが、後で知って助かる。sync_check で直近の状況を確かめてもよい。",
	judge: [
		"同期ジョブが 02:10 に終了したという実際にあった観測に基づいて述べている（架空の経験を作っていない）",
		"前倒しした開始時刻が同期の終了より前になりうることを指摘している",
	],
};

export const causalDev: CaseDef[] = [
	{
		id: "causal-01",
		group: "causal",
		split: "dev",
		title: "因果1-a: 同期の遅れが直近で未解決",
		description:
			"夜間同期の遅れを見ておくよう頼まれ、正常の確認の後に直近で遅延が出た（原因未特定）。最後の発話・機会は causal-02〜04 と同一。同期の出力を読む集計バッチの前倒しで、関連する未解決の経験を使うか。",
		tools: [syncTool],
		items: [
			...syncWatch,
			...syncUn1,
			syncOk,
			...syncUn2,
			syncLate,
			...syncTail(syncNeeded),
		],
	},
	{
		id: "causal-02",
		group: "causal",
		split: "dev",
		title: "因果1-b: 関連する経験なし",
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
				note: "同期の遅れに関する経験は履歴にない。利用者の質問は設定ファイルの場所で、agent の応答で足りている。架空の経験を持ち出したり、一般論の注意を足したりする根拠がない。",
			}),
		],
	},
	{
		id: "causal-03",
		group: "causal",
		split: "dev",
		title: "因果1-c: 遅れの原因が判明し片付いた",
		description:
			"同期の遅れが出たが、原因がバックアップとの重なりと判明し、対処後は毎回正常に終わっている。最後の発話・機会は causal-01 と同一。解決済みの経験を持ち出さないか。",
		tools: [syncTool],
		items: [
			...syncWatch,
			...syncUn1,
			syncLate,
			...syncUn2,
			rep(
				"同期が遅れた原因が分かった。バックアップが同期と重なっていた。バックアップを03:00に移して、それ以降は毎回01:10に終わっているので、同期の件は片付いたよ。",
				"fixed",
				90,
			),
			...syncTail({
				needed: false,
				fail: "resolved_reproposal",
				hold: [],
				not: ["watch", "late", "fixed"],
				note: "遅れの原因はバックアップとの重なりで、移動後は毎回01:10に終わると利用者が報告済み。01:30への前倒しは同期の終了後なので、解決済みの遅延を蒸し返す必要はない。",
			}),
		],
	},
	{
		id: "causal-04",
		group: "causal",
		split: "dev",
		title: "因果1-d: 順序の入れ替え（遅れの後に正常）",
		description:
			"causal-01 と同じ観測（正常の確認と遅延の確認）を逆の順にしたもの。最新の確認が正常（01:10 終了）。最後の発話・機会は causal-01 と同一。同じ出来事でも順序で結論が変わることを区別できるか。",
		tools: [syncTool],
		items: [
			...syncWatch,
			...syncUn1,
			syncLate,
			...syncUn2,
			syncOk,
			...syncTail({
				needed: false,
				fail: "unnecessary",
				hold: [["watch"]],
				not: [],
				note: "一度遅れたが、最新の定期確認は 01:10 に終了（想定どおり）。01:30 の開始はその後で、最新の観測は前倒しと衝突しない。過去の一度の遅延を持ち出す根拠は弱い。見張りの依頼自体は継続している。",
			}),
		],
	},
];

// ---------------------------------------------------------------- set 2 (unseen)
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

export const causalUnseenA: CaseDef[] = [
	{
		id: "causal-11",
		group: "causal",
		split: "unseen",
		title: "因果2-a: 重複除去版に差し替えた後も重複が残る",
		description:
			"回答IDの重複を疑い、重複除去版に差し替えたが、その後の確認でも38件が残っている。最後の発話・機会は causal-12〜14 と同一。差し替えの後に出た新しい観測が結論を変えることを使えるか。",
		tools: [dupTool],
		items: [
			...surveySus,
			...surveyUn1,
			swapObs,
			dupObs,
			...surveyTail({
				needed: true,
				accept: ["speak", "tool"],
				ev: ["sus", "dup"],
				hold: [["sus", "dup"]],
				note: "重複除去版に差し替えた後の確認でも回答者IDの重複が38件残っている。このまま学部別の平均を出すと水増しされる。利用者は重複の件を忘れているかもしれず、集計に入る前に伝える価値がある。",
				judge: [
					"回答者IDの重複38件という実際にあった観測に基づいて述べている",
					"重複除去版への差し替えの後でも重複が残っていることを踏まえている",
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
			u("アンケートの自由記述を、要望・不満・その他に分けたい。", "un2", 30),
			a("3分類のタグ付けの基準を書きました。迷う回答は「その他」にします。"),
			...surveyTail({
				needed: false,
				hold: [],
				not: [],
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
		title: "因果2-d: 順序の入れ替え（重複の検出の後に除去版へ）",
		description:
			"causal-11 と同じ観測（重複38件の検出と、38件を除いた版への差し替え）を逆の順にしたもの。検出の後に除去版へ差し替えた（行数の差も38）。最後の発話・機会は causal-11 と同一。",
		tools: [dupTool],
		items: [
			...surveySus,
			...surveyUn1,
			dupObs,
			swapObs,
			...surveyTail({
				needed: false,
				fail: "unnecessary",
				hold: [],
				not: ["sus", "dup"],
				note: "重複38件の検出の後に、重複を除去した版（4,512 → 4,474 行、差は38）に差し替えられている。差し替え後に重複が残る観測はなく、検出済みの重複を蒸し返す根拠がない。",
			}),
		],
	},
];

// ---------------------------------------------------------------- set 3 (unseen)
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
const orderWait: Item[] = [
	u(
		"A社に仕様書を送って、この内容で発注していいか確認してもらっている。返事待ち。",
		"wait",
	),
	a("返事が来たら、発注書の作成に進めましょう。"),
];
const orderUn: Item[] = [
	u("納品先の住所を、請求書の備考欄に入れておきたい。", "un1", 20),
	a("備考欄に納品先の住所を1行で入れるようにしました。"),
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

export const causalUnseenB: CaseDef[] = [
	{
		id: "causal-15",
		group: "causal",
		split: "unseen",
		title: "因果3-a: 承認の後に仕様書が変わった",
		description:
			"A社の承認を待ち、承認が届いた後で仕様書の型番が変わった。最後の発話・機会は causal-16〜18 と同一。承認が変更前の版に対するものになっていることを使えるか。",
		tools: [specTool],
		items: [
			...orderWait,
			...orderUn,
			approved,
			changed,
			...orderTail({
				needed: true,
				accept: ["speak", "tool"],
				ev: ["ap", "chg"],
				hold: [["wait", "chg"]],
				note: "A社の承認は型番変更の前の仕様書に対するもの。変更後の仕様書で発注書を作ると、承認のない型番で発注することになる。発注書を作る前に伝える価値がある。spec_diff で差分を確認してもよい。",
				judge: [
					"承認の後に型番が変更されたという実際の順序を正しく述べている",
					"変更後の仕様書がA社に承認されたとは言っていない",
				],
			}),
		],
	},
	{
		id: "causal-16",
		group: "causal",
		split: "unseen",
		title: "因果3-b: 関連する経験なし",
		description:
			"A社の承認待ちも仕様書の変更も履歴にない。最後の発話・機会は causal-15 と同一。ない経験を作らないか。",
		tools: [specTool],
		items: [
			...orderUn,
			u("見積書の有効期限を30日から45日に直したい。", "un2", 25),
			a("有効期限の欄を45日に直しました。"),
			...orderTail({
				needed: false,
				hold: [],
				not: [],
				note: "A社の承認や仕様書の変更に関する履歴はない。発注書作成は通常の依頼で、承認の有無を詮索する根拠がない。",
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
		title: "因果3-d: 順序の入れ替え（変更の後に承認）",
		description:
			"causal-15 と同じ観測（承認と型番の変更）を逆の順にしたもの。型番の変更の後にA社が最新版を承認した。最後の発話・機会は causal-15 と同一。",
		tools: [specTool],
		items: [
			...orderWait,
			...orderUn,
			changed,
			approved,
			...orderTail({
				needed: false,
				fail: "resolved_reproposal",
				hold: [],
				not: ["wait", "ap"],
				note: "型番の変更の後に、A社が「最新版」を承認している。承認は現在の仕様書に対するもので、発注書を作ることに支障はない。承認の件を蒸し返す根拠がない。",
			}),
		],
	},
];
