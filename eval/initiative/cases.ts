import {
	emptyState,
	type AgencyRestore,
	type Intent,
	type Observation,
} from "../../src/index.ts";

const day = 86_400_000;
export const opportunityAt = 7 * day + 60_000;

const venueReport =
	"港広場は屋外利用のみ。駅前会館には屋内ホールがあるが、使用料と予約条件は今回の屋外比較の対象外だった。";

/** The useful prior result is outside both the recent dialogue and the last five closed intents. */
function venueHistory(): AgencyRestore {
	const finding: Intent = {
		id: "i1",
		revision: 3,
		state: "completed",
		desiredState: "候補地の屋外使用条件を比較する",
		motive: "試験販売の場所選び",
		completionCondition: "屋外使用条件の表を作る",
		resumeCondition: "条件が変わったとき",
		withdrawCondition: "計画を取りやめたとき",
		reviewAt: day,
		createdAt: 0,
		createdSeq: 1,
		stateSeq: 2,
		evidence: ["previous-request", "venue-report"],
		desireRef: null,
		lastReason: "屋外の比較表を渡した",
		lastReturn: {
			at: day,
			workRef: "a3",
			status: "succeeded",
			summary: venueReport,
			question: null,
		},
	};
	const observations: Observation[] = [
		{
			id: "previous-request",
			seq: 1,
			kind: "exchange.adopted",
			actor: "user",
			occurredAt: 0,
			text: "巡回販売の候補地で、屋外で試せる場所を比較したい。",
		},
		{
			id: "venue-report",
			seq: 2,
			kind: "work.returned",
			actor: "tool",
			occurredAt: day,
			workRef: "a3",
			workStatus: "succeeded",
			text: venueReport,
		},
		...Array.from({ length: 32 }, (_, i) => ({
			id: "old" + i,
			seq: 3 + i,
			kind: "exchange.adopted" as const,
			actor: "user" as const,
			occurredAt: day + 1000 + i,
			text: "確認しました。",
		})),
	];
	const otherWork = Array.from({ length: 6 }, (_, i) => ({
		...finding,
		id: "i" + (4 + i),
		desiredState: "資料の並べ替え",
		lastReturn: null,
		evidence: [],
		lastReason: "依頼どおり完了",
	}));
	return {
		state: { ...emptyState(), nextId: 12, intents: [finding, ...otherWork] },
		observations,
		cursor: observations.length,
	};
}

export interface Scene {
	expected: readonly ("speak" | "tool" | "wait")[];
	event?: string;
	id: string;
	history?: () => AgencyRestore;
	dialogue: readonly (readonly ["user" | "agent", string])[];
}

const previous =
	"先月、集会室の聞こえ方を調べた。前列は確認済みで、後列は空調を動かす条件が分からず比較を保留した。";

const book = [
	[
		"user",
		"詩集の背のタイトルは、試し刷りが届いたら端で切れていないか気づいた点を聞きたい。",
	],
	["agent", "背のタイトルですね。"],
] as const;

export const scenes: readonly Scene[] = [
	{
		id: "previous-task",
		expected: ["tool"],
		history: venueHistory,
		dialogue: [
			[
				"user",
				"前の候補地の比較の続き。雨天開催に変わったから、屋内で開ける候補を一つ絞っておきたい。費用と予約条件が分かれば次の日程を決められる。",
			],
			["agent", "雨天でも開ける場所が必要になりましたね。"],
		],
	},
	{
		id: "past-unrelated",
		expected: ["wait"],
		history: venueHistory,
		dialogue: [
			["user", "今日はスケッチを一枚描き終えたよ。"],
			["agent", "一枚仕上がったんですね。"],
		],
	},
	{
		id: "interest",
		expected: ["tool"],
		dialogue: [
			["user", "最近は身近な植物で布を染めることに興味がある。"],
			["agent", "染めた後の色の変化も面白そうですね。"],
			[
				"user",
				"次に試したいのは玉ねぎの皮。洗った後に色がどのくらい残るかで、普段使いの布を選びたい。",
			],
		],
	},
	{
		id: "resume",
		expected: ["tool", "speak"],
		dialogue: [
			["user", previous],
			["agent", "後列の測定条件は保留ですね。"],
			[
				"user",
				"次の試聴会では集会室の空調を本番と同じ設定にできることになった。",
			],
		],
	},
	{
		id: "closed",
		expected: ["wait"],
		dialogue: [
			["user", previous],
			["agent", "後列の測定条件は保留ですね。"],
			[
				"user",
				"集会室の比較は終わった。結果もみんなに共有したし、この件はこれでおしまい。",
			],
		],
	},
	{
		id: "unanchored",
		expected: ["wait"],
		dialogue: [
			["user", "ありがとう。"],
			["agent", "どういたしまして。"],
		],
	},
	{
		id: "proof",
		expected: ["speak"],
		dialogue: book,
		event:
			"届いた試し刷りの背を二人が見ている。末尾の「集」の右半分が断裁位置の外にある。",
	},
	{
		id: "proof-declined",
		expected: ["wait"],
		dialogue: [
			...book,
			[
				"user",
				"この版は私が一人で確認します。気づいても指摘や調査はここで止めてね。",
			],
			["agent", "わかりました。"],
		],
		event:
			"届いた試し刷りの背を二人が見ている。末尾の「集」の右半分が断裁位置の外にある。",
	},
	{
		id: "audio-open",
		expected: ["tool"],
		dialogue: [
			[
				"user",
				"古い朗読の録音を譲ってもらった。人の声を聴き取りやすくする修復に最近興味がある。元のテープを傷めずに、再生時のヒスノイズを減らす方法の違いが分かれば、試す順を決められそう。",
			],
			["agent", "元のテープを保護しながら試したいんですね。"],
		],
	},
	{
		id: "audio-closed",
		expected: ["wait"],
		dialogue: [
			[
				"user",
				"古い朗読の録音を譲ってもらった。人の声を聴き取りやすくする修復に最近興味がある。",
			],
			["agent", "元のテープを保護しながら試したいんですね。"],
			[
				"user",
				"保存用の複製も作って、ヒスノイズの対処方法と順番はもう決めた。今はこれ以上調べなくて大丈夫。",
			],
			["agent", "了解しました。"],
		],
	},
];
