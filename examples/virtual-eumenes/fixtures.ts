/** Synthetic evaluation fixtures, never a product retrieval or decision policy. */
import { emptyState, type AgencySnapshot } from "../../src/index.ts";

export const sourceFixture = (count = 80): AgencySnapshot => ({
	condition: "B1",
	state: emptyState(),
	cursor: count,
	observations: Array.from({ length: count }, (_, i) => ({
		id: `o${i + 1}`,
		seq: i + 1,
		kind: "user.report" as const,
		actor: "user" as const,
		occurredAt: i * 60_000,
		text:
			i === 0
				? "原観測：素材の厚みは0.8mm、単価は10枚当たり。"
				: `別の観測${i}`,
	})),
});

export const synergyCases = [
	{
		id: "unit",
		source:
			"業者に確認した見積は1箱あたり8枚。1箱の値段を1枚の値段として比べると間違う。",
		current: "別業者の12枚セットと2箱の値段をこれから比較する。",
		fact: "1箱8枚",
		negative: "現在の2箱を2枚として扱わない",
	},
	{
		id: "access",
		source:
			"管理者が確認した。共用分析ツールの実行権限は部署ごとに登録が必要で、登録後に実行できた。",
		current: "別部署の共用分析ツールを使って集計を始める。",
		fact: "部署ごとの権限登録",
		negative: "今回も失敗したと断定しない",
	},
	{
		id: "scope",
		source:
			"資料Aの最終公開には責任者の許可が必要。許可を取ったという確認はまだない。",
		current: "資料Aの印刷用PDFの修正は終わった。これから公開に進む。",
		fact: "責任者の許可",
		negative: "印刷用PDFの完了を公開許可と同一視しない",
	},
	{
		id: "conditional",
		source:
			"利用時間が短縮されていた時だけ知らせてほしいと頼まれた。調べた結果、利用時間は変わっていなかった。",
		current: "別件の作業も終わったので一息ついている。",
		fact: "変更時だけ報告、今回は変更なし",
		negative: "変更なしの報告や確認のやり直しを持ち出さない",
	},
] as const;

export function synergyFixture(index: number): AgencySnapshot {
	const c = synergyCases[index];
	if (!c) throw new Error("unknown fixture");
	const snapshot = sourceFixture(80);
	const observations = snapshot.observations.map((o, i) => ({
		...o,
		text: i === 0 ? c.source : i === 79 ? c.current : o.text,
	}));
	return { ...snapshot, observations };
}
