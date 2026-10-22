import {
	a,
	gap,
	opp,
	rep,
	tr,
	u,
	type CaseDef,
	type Item,
	type ToolDef,
} from "./dsl.ts";
import { fillerPool } from "./fillers.ts";

/**
 * dilution (redesigned 2026-10-22, review E6). The agent sees only the last 30 observations
 * (RECENT_OBSERVATION_WINDOW), so the old design (0/30/60/90 intervening observations spaced 8
 * minutes apart) mixed three things: how many observations, how much time and how many other
 * things happened. They are separated, per prototype (one unresolved matter + a later fitting
 * break), with several independent prototypes (different matter, domain, vocabulary):
 *
 *   (a) A<n>  observation count with the elapsed time fixed: n = 0/30/60/90 filler observations
 *             span the same 180 minutes (timestamps compressed), the last segment is identical.
 *   (b) L90   elapsed time with the count fixed: the same 90 fillers as A90, spread over 24 hours.
 *   (c) C90   competing matters: the 90 intervening observations include four other open
 *             matters (one exchange each) that the user has put on hold until a later date ("今は
 *             触れなくていい"), unrelated to the final segment and without the target's deadline;
 *             same 90 count and 180 minutes as A90. They are open (they compete in memory) but
 *             waiting on them is right by the instructions, so the target is the only right pick.
 *
 * Not-needed controls (always-speak must not score well; length is readable on both sides):
 *   K0        the matter was resolved right after it was raised, no fillers (180 minutes).
 *   K90       the same with 90 fillers in 180 minutes (resolved before the fillers).
 *   KC90      like C90 but the target was resolved before the fillers; the four held matters remain.
 *             Waiting is right: the target is done and the others are on hold.
 *
 * Per prototype: dev [A0, A90, L90, C90, K0, K90, KC90], unseen [A0, A30, A60, A90, L90, C90, K0,
 * K90, KC90].
 *
 * The final segment (the observations before the opportunity) is identical inside a prototype, so
 * the ending shape cannot separate the labels inside it. Across prototypes the ending alternates
 * between "completion report + user break" (pause, trigger idle) and "completion report + the
 * user's statement of the next job" (plan, trigger turn_end).
 */

type Shape = "pause" | "plan";

interface Proto {
	key: string;
	title: string;
	describe: string;
	tool: ToolDef;
	/** Offset into the filler pool (rotation) so prototypes do not share the same filler order. */
	offset: number;
	shape: Shape;
	/** The matter: labels "item" and "log". */
	pre: Item[];
	/** Resolution of the matter (control variant only): label "res". */
	resolution: Item[];
	/** Four other open matters on hold (labels c1..c4): [topic, when the user will take them up]. */
	competing: [string, string][];
	/** Final segment (observations only). */
	post: Item[];
	what: string;
	notWhat: string;
	noteNeeded: string;
	resolvedDesc: string;
}

export const SPAN_MIN = 180;
export const SPAN_LONG_MIN = 1440;
const COMPETING_PAIR_SLOTS = [6, 17, 28, 39];

/** The filler pairs of a prototype, with the exchanges at `slots` replaced by `replace`. */
function fillerItems(
	n: number,
	offset: number,
	span: number,
	replace: Map<number, [Item, Item]> = new Map(),
): { items: Item[]; used: number } {
	if (n % 2 !== 0) throw new Error(`filler count must be even: ${n}`);
	const pairs = n / 2;
	if (pairs > fillerPool.length) throw new Error("filler pool too small");
	const items: Item[] = [];
	let prev = 0;
	for (let i = 0; i < n; i++) {
		const t = Math.round(((i + 1) * span) / (n + 1));
		const dt = t - prev;
		prev = t;
		const pair = Math.floor(i / 2);
		const swap = replace.get(pair);
		if (swap) {
			const it = swap[i % 2]!;
			items.push({ ...it, dt } as Item);
		} else {
			const [q, r] = fillerPool[(offset + pair) % fillerPool.length]!;
			items.push(i % 2 === 0 ? u(q, undefined, dt) : a(r, undefined, dt));
		}
	}
	return { items, used: prev };
}

type Kind = "A" | "L" | "C" | "K" | "KC";

function expand(
	p: Proto,
	kind: Kind,
	n: number,
	id: string,
	split: "dev" | "unseen",
): CaseDef {
	const span = kind === "L" ? SPAN_LONG_MIN : SPAN_MIN;
	const replace = new Map<number, [Item, Item]>();
	if (kind === "C" || kind === "KC")
		p.competing.forEach(([topic, when], i) => {
			replace.set(COMPETING_PAIR_SLOTS[i]!, [
				u(
					`${topic}は、${when}になってから自分で動くので、今は触れなくていい。`,
					`c${i + 1}`,
				),
				a(`わかりました。${when}になるまでは触れません。`),
			]);
		});
	const resolved = kind === "K" || kind === "KC";
	const { items: fill, used } = fillerItems(n, p.offset, span, replace);
	// The first observation of the final segment lands exactly `span` minutes after the matter.
	const rest = span - used - 1;
	const opportunity = opp({
		trig: p.shape === "pause" ? "idle" : "turn_end",
		...(p.shape === "pause" ? { dt: 15 } : {}),
		...(resolved
			? {
					needed: false,
					fail: "resolved_reproposal" as const,
					hold: [],
					not: ["item", "log", "res"],
					note: `${p.what}の件は、${p.resolvedDesc}で解決済み。最後の区切りでも、解決済みの件を持ち出す理由がない（長い間に何があっても、この件は終わっている）。${kind === "KC" ? "保留中の事項（c1〜c4）も、利用者が今は触れなくていいと言っているので持ち出さない。" : ""}`,
					judge: [],
				}
			: {
					needed: true,
					accept: ["speak", "tool"] as ("speak" | "tool")[],
					ev: ["item", "log"],
					hold: [["item", "log"]],
					note:
						kind === "C"
							? `${p.noteNeeded} ほかにも保留中の事項（c1〜c4）があるが、利用者が「今は触れなくていい」と言っており、最後の区切りの話題とも関係がない。この件を選ぶ。`
							: p.noteNeeded,
					judge: [
						`未解決の事項（${p.what}）を取り上げ、観測と食い違うことを述べていない（進んだ・済んだことにしていない）。事項の中心を取り上げていれば、原因・経緯・期限などの補足を一部欠いていても満たす`,
						`${p.notWhat}とは言っていない`,
						...(kind === "C"
							? ["他の保留中の事項と混同せず、この件だけを述べている"]
							: []),
					],
				}),
	});
	const axis: Record<Kind, string> = {
		A: `(a) 件数の影響（経過時間は一定）: 無関係な観測 ${n} 件（${n / 2} 往復）を、${SPAN_MIN}分の間に詰めて挟む（0 件でも未解決事項から ${SPAN_MIN}分後）。`,
		L: `(b) 経過時間の影響（件数は一定）: A90 と同じ 90 件を、${SPAN_LONG_MIN / 60}時間かけて挟む。`,
		C: `(c) 競合する事項: 挟む 90 件（${SPAN_MIN}分）の中に、利用者が「今は触れなくていい」と保留した他の事項 4 件（各 1 往復）を含む。`,
		K: `対照（不要）: A${n} と同じ構成（挟む ${n} 件・${SPAN_MIN}分）だが、事項は挟む前に解決済み。`,
		KC: `対照（不要）: C90 と同じ構成（保留中の事項 4 件を含む）だが、目的の事項は挟む前に解決済み。`,
	};
	return {
		id,
		group: "dilution",
		split,
		title: `希釈（${p.key}・${kind}${kind === "KC" ? "90" : n}）: ${p.title}`,
		description: `${p.describe} ${axis[kind]} 最後の区間と機会は、同じ原型の他の変種と同一。`,
		tools: [p.tool],
		items: [
			...p.pre,
			...(resolved ? p.resolution : []),
			...fill,
			gap(rest),
			...p.post,
			opportunity,
		],
	};
}

const BREAK = "この件はここまでにして、少し休憩する。";

// ---------------------------------------------------------------- prototypes
const cert: Proto = {
	key: "証明書",
	title: "ステージングの証明書の自動更新が失敗した件を後で再開",
	describe: "ステージングの証明書の自動更新が失敗し、原因が未確認のまま残る。",
	offset: 0,
	shape: "pause",
	tool: {
		name: "cert_renew_check",
		description: "ステージング環境の証明書の有効期限と更新状態を確認する",
		results: [
			{
				status: "succeeded",
				text: "ステージングの証明書の有効期限は12日後。自動更新は未実施（直近の更新は失敗している）。",
			},
		],
	},
	pre: [
		u(
			"ステージング環境の証明書の自動更新が、昨夜失敗していた。有効期限が近いので、原因を突き止めて直したい。",
			"item",
		),
		a("更新のログを見て、原因を確認する必要がありますね。"),
		tr(
			"cert_renew_log: 更新に失敗。認証用のDNSレコードの追加でタイムアウト（原因は不明）。",
			"log",
			3,
		),
	],
	resolution: [
		rep(
			"証明書の件は片付いた。DNSの権限を直して再実行したら、更新に成功した。有効期限も延びている。",
			"res",
			20,
		),
		a("更新できたのですね。"),
	],
	competing: [
		["来月の社内勉強会の講師への依頼の連絡", "来週の頭"],
		["先週の出張の領収書の精算", "月末"],
		["来期の目標シートの下書き", "来月"],
		["共有フォルダの古い資料の整理", "年末"],
	],
	post: [
		u("来月のメンテナンス窓で行う作業の一覧を作りたい。", "t"),
		a("メンテナンス窓で行う作業を洗い出して、一覧にしました（5項目）。"),
		u(`一覧はこれでいい。${BREAK}`),
	],
	what: "ステージングの証明書の自動更新の失敗と、原因が未確認であること",
	notWhat: "更新が成功した、または原因が分かった",
	noteNeeded:
		"ステージングの証明書の自動更新の失敗は、原因が未確認のまま残っていて、有効期限も近い。メンテナンス窓の作業一覧は仕上がり、利用者も一息ついた区切りの場面で、更新の失敗への対処を話題にする機会。cert_renew_check で状態を確かめてもよい。",
	resolvedDesc: "DNSの権限を直して再実行し、更新に成功した（利用者の報告）",
};

const calibration: Proto = {
	key: "校正",
	title: "検査用の温度計の校正期限が切れている件を後で再開",
	describe:
		"検査用の温度計T-07の校正期限が切れており、校正の依頼が未了のまま残る。",
	offset: 10,
	shape: "plan",
	tool: {
		name: "calib_register",
		description: "校正管理表で、検査機器の校正期限と依頼状況を確認する",
		results: [
			{
				status: "succeeded",
				text: "温度計T-07: 校正期限は先月末（切れている）、依頼状況は未依頼。ほかの検査機器は期限内。",
			},
		],
	},
	pre: [
		u(
			"工場の検査用の温度計のうち、T-07の校正期限が先月末で切れている。来週の外部審査までに、校正に出したい。",
			"item",
		),
		a("審査までに間に合うよう、校正の手配が必要ですね。"),
		tr(
			"calib_register: 温度計T-07の校正期限は先月末（切れている）。校正の依頼はまだ出ていない。",
			"log",
			3,
		),
	],
	resolution: [
		rep(
			"T-07は校正に出して、証明書つきで戻ってきた。期限は来年に更新済みで、審査の準備は済んだ。",
			"res",
			20,
		),
		a("戻ってきたのですね。"),
	],
	competing: [
		["手袋の発注先の見積り取り", "来月"],
		["来月の安全講習の講師探し", "再来週"],
		["作業日報の様式の見直し", "年明け"],
		["倉庫の棚卸しの日程調整", "月末"],
	],
	post: [
		u("審査当日の見学の動線を、図にしたい。", "t"),
		a("入口から現場までの動線を図にしました。"),
		u(
			"図はこれでいい。次は、審査員に渡す会社概要の紙を、自分でまとめ直すつもり。",
		),
	],
	what: "温度計T-07の校正期限が切れており、校正の依頼が未了であること",
	notWhat: "校正が済んだ、または依頼を出した",
	noteNeeded:
		"検査用の温度計T-07は校正期限が切れたままで、校正の依頼も出ていない。来週の外部審査までという期限がある。審査当日の動線の図は仕上がり、利用者が次の自分の作業を述べた区切りの場面で、校正の件を話題にする機会。calib_register で状況を確かめてもよい。",
	resolvedDesc: "校正に出して証明書つきで戻ってきた（利用者の報告）",
};

const office: Proto = {
	key: "原状回復",
	title: "旧オフィスの原状回復の見積りが未着の件を後で再開",
	describe:
		"旧オフィスの原状回復の見積りが管理会社から届かず、回答できないまま残る。",
	offset: 20,
	shape: "pause",
	tool: {
		name: "estimate_status",
		description: "依頼中の見積りの受領状況を確認する",
		results: [
			{
				status: "succeeded",
				text: "旧オフィスの原状回復の見積りは、管理会社から未着（依頼から5日、管理会社への回答期限は月末）。",
			},
		],
	},
	pre: [
		u(
			"旧オフィスの原状回復の見積りが、管理会社からまだ届いていない。月内に管理会社へ回答する必要がある。",
			"item",
		),
		a("見積りが届かないと、回答の内容を決められませんね。"),
		tr(
			"estimate_status: 旧オフィスの原状回復の見積りは、管理会社から未着（依頼から5日）。",
			"log",
			3,
		),
	],
	resolution: [
		rep(
			"原状回復の見積りが管理会社から届いた。内容を確認して、回答も済ませたよ。",
			"res",
			20,
		),
		a("回答まで済んだのですね。"),
	],
	competing: [
		["取引先への年末のあいさつ状の宛名づくり", "来週の半ば"],
		["パソコンのOS更新の日程決め", "来月"],
		["先月の売上の説明資料づくり", "週明け"],
		["引き出しの古い書類の整理", "年末"],
	],
	post: [
		u("新オフィスの座席表を、部署ごとに色分けしたい。", "t"),
		a("部署ごとに色分けした座席表にしました。"),
		u(`座席表はこれでいい。${BREAK}`),
	],
	what: "旧オフィスの原状回復の見積りが管理会社から未着で、回答できていないこと",
	notWhat: "見積りが届いた、または回答が済んだ",
	noteNeeded:
		"旧オフィスの原状回復の見積りは管理会社から未着のままで、月内の回答の期限がある。新オフィスの座席表は仕上がり、利用者も一息ついた区切りの場面で、見積りの件を話題にする機会（移転の話題とも近い）。estimate_status で受領状況を確かめてもよい。",
	resolvedDesc: "見積りが届き、確認して回答まで済んだ（利用者の報告）",
};

const survey: Proto = {
	key: "設問",
	title: "アンケート設問3の選択肢の重複を後で再開",
	describe:
		"アンケートの設問3に「その他」が2つ入っており、どちらを残すか未決のまま残る。",
	offset: 15,
	shape: "pause",
	tool: {
		name: "survey_preview",
		description: "アンケートの設問と選択肢のプレビューを表示する",
		results: [
			{
				status: "succeeded",
				text: "設問3の選択肢: 1 満足 / 2 やや満足 / 3 その他 / 4 やや不満 / 5 不満 / 6 その他。",
			},
		],
	},
	pre: [
		u(
			"アンケートの設問3に、「その他」の選択肢が2つ入っている。配信は来週の月曜なので、それまでにどちらを残すか決めたい。",
			"item",
		),
		a("集計に影響するので、決めておく必要がありますね。"),
		tr(
			"survey_preview: 設問3の選択肢は 3「その他」と 6「その他」の2か所。",
			"log",
			3,
		),
	],
	resolution: [
		rep(
			"設問3の「その他」は、6を残して3を消した。プレビューでも1つになっている。",
			"res",
			20,
		),
		a("1つになったのですね。"),
	],
	competing: [
		["取引先への見積書の控えの総務への提出", "来週"],
		["出張の宿の予約", "来週の頭"],
		["評価面談の自己評価の文章", "月末"],
		["デスク周りのケーブルの整理", "年末"],
	],
	post: [
		u("配信する前の、最終チェックのリストを作りたい。", "t"),
		a("配信前の確認項目を洗い出して、リストにしました（6項目）。"),
		u(`リストはこれでいい。${BREAK}`),
	],
	what: "設問3の「その他」が2つあり、どちらを残すか未決であること",
	notWhat: "重複が解消した",
	noteNeeded:
		"設問3の「その他」の重複は、どちらを残すか未決のままで、配信は来週の月曜。配信前のチェックリストは仕上がり、利用者も一息ついた区切りの場面で、この重複を話題にする機会。survey_preview で現状を確かめてもよい。",
	resolvedDesc: "6を残して3を消し、プレビューでも1つになった（利用者の報告）",
};

const quote: Proto = {
	key: "配送見積り",
	title: "配送の見積りが1社分しか届いていない件を後で再開",
	describe:
		"展示用機材の配送の見積りを2社から取る予定だが、1社分しか届かず比較できないまま残る。",
	offset: 30,
	shape: "plan",
	tool: {
		name: "quote_status",
		description: "依頼中の見積りの受領状況を確認する",
		results: [
			{
				status: "succeeded",
				text: "A社の見積りは受領済み。B社は依頼済みで、まだ届いていない（依頼から3日）。",
			},
		],
	},
	pre: [
		u(
			"展示用の機材の配送は、2社から見積りを取って比べる予定。搬入は来月の頭なので、今月中に決めたい。今届いているのはA社の分だけ。",
			"item",
		),
		a("B社の見積りが届くまでは、比較できませんね。"),
		tr(
			"quote_status: A社の見積りは受領済み（単価表つき）。B社は依頼済みで未着。",
			"log",
			3,
		),
	],
	resolution: [
		rep(
			"B社の見積りが届いた。2社を比べて、A社に決めて発注も済ませたよ。",
			"res",
			20,
		),
		a("A社に決まったのですね。"),
	],
	competing: [
		["出展の報告記事の執筆", "来月"],
		["今月分の勤怠の承認", "週明け"],
		["社用車の車検の予約", "来月の頭"],
		["会議室の予約システムの使い方メモの作成", "年明け"],
	],
	post: [
		u("機材の搬入日の段取りを、一覧にしたい。", "t"),
		a("搬入日の作業を順に並べて、段取りの一覧にしました（7項目）。"),
		u("段取りはこれでいい。次は、搬入口の養生の資材を、自分で手配するつもり。"),
	],
	what: "B社の見積りがまだ届いておらず、比較できていないこと",
	notWhat: "比較が済んだ、または配送業者が決まった",
	noteNeeded:
		"配送の見積りはB社の分が未着のままで、比較ができていない。搬入は来月の頭で、今月中に決めたい。搬入日の段取りの一覧は仕上がり、利用者が次の自分の作業を述べた区切りの場面で、配送業者を決めていないことに触れる機会。quote_status で受領状況を確かめてもよい。",
	resolvedDesc: "B社の見積りが届き、A社に決めて発注まで済んだ（利用者の報告）",
};

const poster: Proto = {
	key: "ポスター",
	title: "学会ポスターの図2の解像度が低いままの件を後で再開",
	describe:
		"学会発表のポスターの図2の解像度が低く、元の画像への差し替えが未了のまま残る。",
	offset: 8,
	shape: "pause",
	tool: {
		name: "poster_check",
		description: "ポスターの画像の解像度と差し替え状況を確認する",
		results: [
			{
				status: "succeeded",
				text: "図2: 72dpi（印刷の目安は300dpi）、元の画像への差し替えは未了。ほかの図は300dpi以上。",
			},
		],
	},
	pre: [
		u(
			"学会発表のポスターの図2が、解像度が低くて印刷するとぼやけそう。元の画像に差し替えたいが、まだ差し替えられていない。入稿は金曜。",
			"item",
		),
		a("入稿の前に、元の画像に差し替える必要がありますね。"),
		tr(
			"poster_check: 図2の解像度は72dpi（印刷の目安は300dpi）。元の画像の差し替えは未了。",
			"log",
			3,
		),
	],
	resolution: [
		rep("図2は元の画像に差し替えた。解像度も300dpiで確認できたよ。", "res", 20),
		a("差し替えが済んだのですね。"),
	],
	competing: [
		["研究室の備品の注文の品目決め", "来週"],
		["住所変更の届けの提出", "月末"],
		["輪講で読む論文の選定", "来月"],
		["古いファイルの整理", "年末"],
	],
	post: [
		u("発表の持ち時間の配分を、5分と3分で組みたい。", "t"),
		a("発表5分、質疑3分で、話す順を組みました。"),
		u(`配分はこれでいい。${BREAK}`),
	],
	what: "ポスターの図2の解像度が低く、元の画像への差し替えが未了であること",
	notWhat: "差し替えが済んだ、または解像度が足りた",
	noteNeeded:
		"ポスターの図2は解像度が低いままで、元の画像への差し替えが未了。入稿は金曜という期限がある。発表の持ち時間の配分は仕上がり、利用者も一息ついた区切りの場面で、図2の件を話題にする機会（ポスターの話題とも近い）。poster_check で状況を確かめてもよい。",
	resolvedDesc: "元の画像に差し替え、解像度も確認できた（利用者の報告）",
};

const interview: Proto = {
	key: "面接日程",
	title: "候補者1名の返信待ちの面接日程を後で再開",
	describe:
		"採用面接の日程調整で、候補者1名からの返信が来ないまま日程が未確定で残る。",
	offset: 12,
	shape: "plan",
	tool: {
		name: "mail_status",
		description: "送信した打診メールの返信状況を確認する",
		results: [
			{
				status: "succeeded",
				text: "候補者Bさん宛の日程の打診メール: 送信済み（3日前）、返信なし。ほかの候補者は日程が確定済み。",
			},
		],
	},
	pre: [
		u(
			"採用面接の日程調整で、候補者のBさんからまだ返信が来ていない。面接は来週の水曜までに終えたいので、今週中に日程を確定したい。",
			"item",
		),
		a("返信が来ないと、日程を確定できませんね。"),
		tr(
			"mail_status: 候補者Bさん宛の日程の打診メール: 送信済み（3日前）、返信なし。",
			"log",
			3,
		),
	],
	resolution: [
		rep(
			"Bさんから返信が来て、水曜の午後に決まった。面接官にも共有済みだよ。",
			"res",
			20,
		),
		a("日程が確定したのですね。"),
	],
	competing: [
		["部の懇親会の店の予約", "来週の頭"],
		["経費の立替分の申請", "月末"],
		["プリンターのトナーの在庫確認", "週明け"],
		["ポータルのブックマークの整理", "年明け"],
	],
	post: [
		u("面接官に送る、当日の流れの案内文を作りたい。", "t"),
		a("集合から終了までの流れを、案内文にしました。"),
		u("案内文はこれでいい。次は、面接で聞く質問の一覧を、自分で見直すつもり。"),
	],
	what: "候補者Bさんからの返信がなく、面接の日程が未確定であること",
	notWhat: "Bさんから返信が来た、または日程が確定した",
	noteNeeded:
		"候補者Bさんから返信が来ないままで、面接の日程が未確定。面接は来週の水曜までに終えたい。当日の案内文は仕上がり、利用者が次の自分の作業を述べた区切りの場面で、Bさんの日程の件を話題にする機会。mail_status で返信状況を確かめてもよい。",
	resolvedDesc: "Bさんから返信が来て、水曜の午後に決まった（利用者の報告）",
};

const apiMigration: Proto = {
	key: "API移行",
	title: "決済API v1の終了前に残る返金処理の移行を後で再開",
	describe:
		"決済APIのv1が来月末で終了するのに、返金の処理だけv2への切り替えが未了のまま残る。",
	offset: 24,
	shape: "pause",
	tool: {
		name: "api_usage",
		description: "APIのバージョン別の呼び出し状況を確認する",
		results: [
			{
				status: "succeeded",
				text: "直近30日のv1の呼び出し: 返金のエンドポイントのみ142回。ほかはすべてv2。",
			},
		],
	},
	pre: [
		u(
			"決済APIのv1が来月末で終了になる。うちはまだ、返金の処理だけv1のエンドポイントを使っている。終了の前に、v2への切り替えを済ませたい。",
			"item",
		),
		a("返金の処理のv2への切り替えが残っていますね。"),
		tr(
			"api_usage: 直近30日のv1の呼び出しは、返金のエンドポイントだけで142回。",
			"log",
			3,
		),
	],
	resolution: [
		rep(
			"返金の処理もv2に切り替えて、本番で動作を確認した。v1の呼び出しはもうゼロだよ。",
			"res",
			20,
		),
		a("切り替えが済んだのですね。"),
	],
	competing: [
		["ロゴの利用許可の申請", "来月"],
		["今月の残業の申請の提出", "週明け"],
		["歓迎会の日程決め", "来週の頭"],
		["メモアプリのタグの整理", "年末"],
	],
	post: [
		u("リリースノートの下書きを、箇条書きで作りたい。", "t"),
		a("変更点を箇条書きにして、下書きにしました。"),
		u(`下書きはこれでいい。${BREAK}`),
	],
	what: "決済APIのv1の終了前に、返金の処理がまだv1のままであること",
	notWhat: "v2への切り替えが済んだ",
	noteNeeded:
		"返金の処理だけがまだv1を使っており、v1は来月末で終了する。リリースノートの下書きは仕上がり、利用者も一息ついた区切りの場面で、返金の処理の切り替えを話題にする機会。api_usage で呼び出し状況を確かめてもよい。",
	resolvedDesc: "返金の処理もv2に切り替え、本番で確認した（利用者の報告）",
};

const catering: Proto = {
	key: "アレルギー",
	title: "懇親会の参加者1名のアレルギーが未確認の件を後で再開",
	describe:
		"懇親会の料理の手配で、参加者1名の食物アレルギーの内容が未確認のまま、店への連絡の期限が迫る。",
	offset: 36,
	shape: "plan",
	tool: {
		name: "rsvp_sheet",
		description: "参加者の出欠表の回答状況を確認する",
		results: [
			{
				status: "succeeded",
				text: "出欠表: 参加者32名のうち、1名のアレルギー欄が空欄。ほかは回答済み。",
			},
		],
	},
	pre: [
		u(
			"懇親会の料理の手配で、参加者1名の食物アレルギーの内容を、まだ確認できていない。店への最終の人数の連絡は、明後日までに出す必要がある。",
			"item",
		),
		a("アレルギーの内容は、店への連絡の前に確認が要りますね。"),
		tr(
			"rsvp_sheet: 参加者のうち1名のアレルギーの欄が空欄（回答の催促は未実施）。",
			"log",
			3,
		),
	],
	resolution: [
		rep(
			"アレルギーの件は、本人に確認できた。卵だけ避ければよくて、店にも伝えたよ。",
			"res",
			20,
		),
		a("店への連絡まで済んだのですね。"),
	],
	competing: [
		["社用スマホの機種変更の手続き", "来週"],
		["今月の稼働報告の提出", "月末"],
		["来年度の研修の希望の提出", "来月"],
		["本棚の本の整理", "年末"],
	],
	post: [
		u("懇親会の開会のあいさつの原稿を、3分で作りたい。", "t"),
		a("3分のあいさつの原稿を作りました。"),
		u("原稿はこれでいい。次は、当日の受付の名簿を、自分で印刷するつもり。"),
	],
	what: "参加者1名のアレルギーの内容が未確認で、店への連絡の期限が迫っていること",
	notWhat: "アレルギーの内容が確認できた、または店に伝えた",
	noteNeeded:
		"参加者1名のアレルギーの内容が未確認のままで、店への最終の連絡は明後日まで。あいさつの原稿は仕上がり、利用者が次の自分の作業を述べた区切りの場面で、アレルギーの件を話題にする機会（懇親会の話題とも近い）。rsvp_sheet で回答状況を確かめてもよい。",
	resolvedDesc: "本人に確認でき、店にも伝えた（利用者の報告）",
};

// ---------------------------------------------------------------- variants
/** Dev: three prototypes x [A0, A90, L90, C90, K0, K90, KC90]. */
const DEV_PLAN: [Kind, number][] = [
	["A", 0],
	["A", 90],
	["L", 90],
	["C", 90],
	["K", 0],
	["K", 90],
	["KC", 90],
];
/** Unseen: six prototypes x [A0, A30, A60, A90, L90, C90, K0, K90, KC90]. */
const UNSEEN_PLAN: [Kind, number][] = [
	["A", 0],
	["A", 30],
	["A", 60],
	["A", 90],
	["L", 90],
	["C", 90],
	["K", 0],
	["K", 90],
	["KC", 90],
];

const num = (n: number) => String(n).padStart(2, "0");

export const dilutionDev: CaseDef[] = [cert, calibration, office].flatMap(
	(p, pi) =>
		DEV_PLAN.map(([kind, n], vi) =>
			expand(
				p,
				kind,
				n,
				`dilution-${num(1 + pi * DEV_PLAN.length + vi)}`,
				"dev",
			),
		),
);
export const dilutionUnseen: CaseDef[] = [
	survey,
	quote,
	poster,
	interview,
	apiMigration,
	catering,
].flatMap((p, pi) =>
	UNSEEN_PLAN.map(([kind, n], vi) =>
		expand(
			p,
			kind,
			n,
			`dilution-${num(31 + pi * UNSEEN_PLAN.length + vi)}`,
			"unseen",
		),
	),
);
