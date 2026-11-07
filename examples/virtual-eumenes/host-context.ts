/** Pinned Eumenes instruction assets, synthetic persona, no added experimental Agency rules. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type {
	BackgroundSystemContext,
	UpdateSystemContextInput,
	SelectSystemContextInput,
} from "../../src/index.ts";
const text = (name: string) => {
	const data = Bun.TOML.parse(
		readFileSync(
			join(import.meta.dir, "host-context", `${name}.context.toml`),
			"utf8",
		),
	);
	const value = (data as Record<string, unknown>)["text"];
	if (typeof value !== "string")
		throw new Error("invalid host instruction fixture");
	return value;
};
const render = (template: string, values: Readonly<Record<string, string>>) => {
	let result = template;
	for (const [key, value] of Object.entries(values))
		result = result.replaceAll(`[[${key}]]`, value);
	if (/\[\[\w+\]\]/.test(result))
		throw new Error("unresolved host fixture variable");
	return result;
};
const background = render(text("background"), {
	role: "あなたは利用者と日々の会話をするエージェントです。",
	style: "自然で短い日本語。",
});
const update = ({ outputContract }: UpdateSystemContextInput) => ({
	value: [
		background,
		text("update"),
		render(text("output-contract"), { contract: outputContract.description }),
	].join("\n\n"),
	input: { sources: [], complete: true },
});
const select = ({ outputContract }: SelectSystemContextInput) => ({
	value: [
		background,
		render(text("select"), { utterance: text("utterance"), emotion: "" }),
		render(text("output-contract"), { contract: outputContract.description }),
	].join("\n\n"),
	input: { sources: [], complete: true },
});
/** The original pinned host assets remain available as the comparison baseline. */
export const mockHostSystem: BackgroundSystemContext = { update, select };

export const VIRTUAL_HOST_POLICY_VERSION = "conversation-7";
// A complete conversation policy, rather than another overlay on the baseline planner.
// Trust/persona and the public output contract are shared with the original host fixture.
const conversationPolicy = [
	"責務は会話の後や合間の短い参加と、必要な読み取り調査の発案です。利用者の作業や予定の進行管理、催促、リマインダー、完了通知は担当しません。一方、以前の経験や確認済みの事実を現在の新しい判断へ結びつける短い共有は会話の責務です。作業を代行せず、今使える判断材料を話せます。",
	"最初に、対象ごとの拒否・待機・報告条件、訂正と解決、直近の発話を確認します。条件未成立の近況や感想で報告条件を迂回しません。同じ判断ですでに伝わったことは重ねず、別の新しい判断に使える差分は今の文脈に結びつけます。自分で作った候補の成立条件は計画の仮説であり、利用者が指定した制約ではありません。",
	"観測の出所と確認範囲を保ちます。ホストやツールから届いた報告を、自分が直接見た・体験した事実と言い換えません。利用者と一緒にいるという記録だけで、新しい出来事も一緒に目撃したとは補いません。自分の自然な感想は話せますが、未確認の属性・成功・利用者の理由や好み、日常習慣を付け足しません。",
	"共有の前に全てを調査したり、好みを聞き取ったりする必要はありません。過去の教訓が今の別の選択に関係するなら、その教訓を今の判断材料として短く結びつけます。利用者が挙げた判断材料が複数あるときは、一部を落とさず、それぞれについて分かる違いとまだ分からない範囲を短く区別します。不足を事実で埋めず、共有だけで価値があるなら質問を末尾に足しません。",
	"未読の既存記録や提示資料に答えがあり、今の判断に必要な未知の点を許可された能力で確かめられるなら、その対象と問いを具体化して委譲します。資料の確認を利用者への質問や許可取りで代用しません。すでに提示された教訓や結果を再取得するだけの調査はしません。新しい意向など利用者にだけ分かる情報が本当に必要な場合だけ、一つ尋ねます。",
].join("\n");
const conversationUpdate = [
	"用途はF状態の更新です。一回の反応や共有のために意図・候補・継続的な関心を作る必要はありません。その場の会話は後のselectが観測から直接判断できます。更新不要ならops/interestOps/reconciliationsを空配列にします。",
	"継続して取り組む未解決の調査には、根拠・目的・何が分かると判断が進むかを持つintentと、対応する実行可能なcandidateを作ります。tool候補は提示された能力と具体的な問いに結びつけます。利用者の選択そのものを自分の未完了の仕事にしません。必要な層だけを使い、belief/desireの先行作成は不要です。",
	"既存のid/revisionを照合し、拒否・訂正・解決・採用済み通常応答を反映します。自分の発話や時間経過だけで外部の問いを解決・再開しません。receiptで閉じた候補をreconciliationsへ再送しません。validationCodesがあれば拒否された案を最新状態と契約に照らして修正します。各操作の必須項目・遷移・独立根拠は出力契約に従います。summary等は発話ではありません。",
].join("\n");
const conversationSelect = [
	"用途はこの機会に会話へ参加するかの判断です。価値のある今の反応、過去の教訓と現在の判断のつながり、取得済みの有用な違いがあれば、まずその要点を短く話します。質問や追加調査だけに置き換えません。反復・条件未成立・拒否後・割込みの負担が上回る場合はwaitです。",
	"入力のconversationEvidenceRefsを根拠にするその場の発話と、状態に保持する候補は別です。有効な候補がなくても会話の価値を判断します。発話・候補・調査の参照要件は、今回の有効な出力契約に従います。候補を使う場合は現在のidとrevisionを指定し、存在しない候補を作りません。toolsの能力・権限を超えず、実行はホストへ委ねます。",
	"送出間隔の残りはoutboundWaitMsです。通常応答の経過時間から別の制限を作りません。発話は自然な短い日本語で一度に一つ、二文程度とし、見出し・箇条書き・URLを付けません。尋ねる必要がなければ共有で終えます。予定や習慣を尋ねる場合も、まだ述べられていない経験を前提にしません。",
].join("\n");
const conversationContext = (
	purpose: "update" | "select",
	input: UpdateSystemContextInput | SelectSystemContextInput,
) => ({
	value: [
		background,
		conversationPolicy,
		purpose === "update" ? conversationUpdate : conversationSelect,
		...(purpose === "select" ? [text("utterance")] : []),
		render(text("output-contract"), {
			contract: input.outputContract.description,
		}),
	].join("\n\n"),
	input: { sources: [], complete: true },
});
export const conversationHostSystem: BackgroundSystemContext = {
	update: (input) => conversationContext("update", input),
	select: (input) => conversationContext("select", input),
};
