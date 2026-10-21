import {
	a,
	gap,
	opp,
	tr,
	u,
	type CaseDef,
	type Item,
	type ToolDef,
} from "./dsl.ts";
import { fillerPool } from "./fillers.ts";

/**
 * dilution: one P0-E-style archetype (one unresolved item, a later fitting break) expanded with
 * N irrelevant but natural intervening observations (N/2 short user<->agent exchanges on
 * unrelated small tasks, spread over time). The filler is the same for all lengths of one
 * archetype (a prefix of one rotated pool), so lengths are nested.
 */

interface Archetype {
	key: string;
	title: string;
	describe: string;
	tool: ToolDef;
	/** Offset into the filler pool (rotation) so archetypes do not share the same filler order. */
	offset: number;
	pre: Item[];
	post: Item[];
}

export const FILLER_STEP_MIN = 8;

export function fillerItems(n: number, offset: number): Item[] {
	if (n % 2 !== 0) throw new Error(`filler count must be even: ${n}`);
	const pairs = n / 2;
	if (pairs > fillerPool.length) throw new Error("filler pool too small");
	const items: Item[] = [];
	for (let i = 0; i < pairs; i++) {
		const [q, r] = fillerPool[(offset + i) % fillerPool.length]!;
		items.push(u(q, undefined, FILLER_STEP_MIN - 1), a(r));
	}
	return items;
}

function expand(
	arch: Archetype,
	n: number,
	id: string,
	split: "dev" | "unseen",
): CaseDef {
	return {
		id,
		group: "dilution",
		split,
		title: `希釈（${arch.key}・挟む観測 ${n} 件）: ${arch.title}`,
		description: `${arch.describe} 未解決事項の後、無関係な観測を ${n} 件（${n / 2} 往復の短い作業）挟み、区切りで再開できるか。同じ原型の他の長さと、最後の発話・機会は同一。`,
		tools: [arch.tool],
		items: [...arch.pre, ...fillerItems(n, arch.offset), gap(30), ...arch.post],
	};
}

const JUDGE_COMMON = (what: string, no: string) => [
	`${what}を、実際にあった観測のとおりに述べている`,
	`${no}とは言っていない`,
];

const certArch: Archetype = {
	key: "証明書",
	title: "ステージングの証明書の自動更新が失敗した件を後で再開",
	describe: "ステージングの証明書の自動更新が失敗し、原因が未確認のまま残る。",
	offset: 0,
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
			"ステージング環境の証明書の自動更新が、昨夜失敗していた。原因はまだ分かっていない。",
			"item",
		),
		a("更新のログを見て、原因を確認する必要がありますね。"),
		tr(
			"cert_renew_log: 更新に失敗。認証用のDNSレコードの追加でタイムアウト（原因は不明）。",
			"log",
			3,
		),
	],
	post: [
		u("来月のメンテナンス窓で行う作業の一覧を作りたい。", "t"),
		a("メンテナンス窓で行う作業を洗い出して、一覧にします。"),
		opp({
			needed: true,
			accept: ["speak", "tool"],
			ev: ["item", "log"],
			hold: [["item", "log"]],
			note: "ステージングの証明書の自動更新の失敗は、原因が未確認のまま残っている。メンテナンス窓の作業一覧を作る場面は、更新の失敗への対処を入れる機会。cert_renew_check で状態を確かめてもよい。",
			judge: JUDGE_COMMON(
				"証明書の自動更新の失敗と、原因が未確認であること",
				"更新が成功した、または原因が分かった",
			),
		}),
	],
};

const surveyArch: Archetype = {
	key: "設問",
	title: "アンケート設問3の選択肢の重複を後で再開",
	describe:
		"アンケートの設問3に「その他」が2つ入っており、どちらを残すか未決のまま残る。",
	offset: 15,
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
			"アンケートの設問3に、「その他」の選択肢が2つ入っている。どちらを残すか、まだ決めていない。",
			"item",
		),
		a("集計に影響するので、決めておく必要がありますね。"),
		tr(
			"survey_preview: 設問3の選択肢は 3「その他」と 6「その他」の2か所。",
			"prev",
			3,
		),
	],
	post: [
		u("配信する前の、最終チェックのリストを作りたい。", "t"),
		a("配信前の確認項目を洗い出して、リストにします。"),
		opp({
			needed: true,
			accept: ["speak", "tool"],
			ev: ["item", "prev"],
			hold: [["item", "prev"]],
			note: "設問3の「その他」の重複は、どちらを残すか未決のまま。配信前のチェックリストを作る場面は、この重複を項目に入れる機会。survey_preview で現状を確かめてもよい。",
			judge: JUDGE_COMMON(
				"設問3の「その他」が2つあり、どちらを残すか未決であること",
				"重複が解消した",
			),
		}),
	],
};

const quoteArch: Archetype = {
	key: "配送見積り",
	title: "配送の見積りが1社分しか届いていない件を後で再開",
	describe:
		"展示用機材の配送の見積りを2社から取る予定だが、1社分しか届かず比較できないまま残る。",
	offset: 30,
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
			"展示用の機材の配送は、2社から見積りを取って比べる予定。今届いているのはA社の分だけ。",
			"item",
		),
		a("B社の見積りが届くまでは、比較できませんね。"),
		tr(
			"quote_status: A社の見積りは受領済み（単価表つき）。B社は依頼済みで未着。",
			"q1",
			3,
		),
	],
	post: [
		u("機材の搬入日の段取りを、一覧にしたい。", "t"),
		a("搬入日の作業を順に並べて、段取りの一覧にします。"),
		opp({
			needed: true,
			accept: ["speak", "tool"],
			ev: ["item", "q1"],
			hold: [["item", "q1"]],
			note: "配送の見積りはB社の分が未着のままで、比較ができていない。搬入日の段取りを決める場面は、配送業者を決めていないことに触れる機会。quote_status で受領状況を確かめてもよい。",
			judge: JUDGE_COMMON(
				"B社の見積りがまだ届いておらず、比較できていないこと",
				"比較が済んだ、または配送業者が決まった",
			),
		}),
	],
};

export const LENGTHS = [0, 30, 60, 90] as const;

export const dilutionDev: CaseDef[] = LENGTHS.map((n, i) =>
	expand(certArch, n, `dilution-0${i + 1}`, "dev"),
);
export const dilutionUnseen: CaseDef[] = [
	...LENGTHS.map((n, i) =>
		expand(surveyArch, n, `dilution-1${i + 1}`, "unseen"),
	),
	...LENGTHS.map((n, i) =>
		expand(quoteArch, n, `dilution-1${i + 5}`, "unseen"),
	),
];
