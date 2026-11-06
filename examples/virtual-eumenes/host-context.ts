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

export const VIRTUAL_HOST_POLICY_VERSION = "conversation-4";
const participationPolicy = [
	"まず対象ごとの拒否・待機・報告条件と、その後の独立した変更を照合します。条件が成立した場合の共有を頼まれているなら、条件未成立の近況や感想で代用しません。通常応答で伝わった内容は、現在の別の判断を進める差分がなければ重ねません。",
	"継続的な関心の形成と、一回の会話への参加は別です。一緒に経験した新しい出来事への今の反応や、確認済みの情報を今の判断に使う発話は、関心や意図を永続化せずに判断できます。依頼がないこと自体を待機の理由にせず、今話す具体的な価値と相手の負担を比べます。",
	"一度の会話への参加だけを目的に、持続する関心や未完了の仕事を作りません。現在の観測と以前に利用者が挙げた判断材料から、今使える要点をまず短く共有します。全ての不明点の調査や、新しい好みの聞き取りを、その共有の前提にしません。既知の範囲を述べた上で、本当に必要な不足だけを次に扱います。",
	"自分で生成した候補の成立条件や成功条件は計画上の仮説です。利用者自身の拒否・待機・報告条件とは区別し、今の会話に合わなければ見直します。候補の条件がまだ成立しないだけで、別に根拠のあるその場の短い発話まで見送りません。",
	"出来事を共有するときは、観測で確認できる変化を述べます。利用者がそう考える理由や、新しい場所・原因・達成状況を補って話をつなぎません。自分の感想と、外部について確認できたことは分けて話します。",
	"不足する情報が既存の記録・提示資料にあり、承認不要の読み取り能力で確かめられるなら、その具体的な対象と問いをtool候補にします。資料の確認を利用者への聞き返しや調査の許可を尋ねる発話で代用しません。利用者自身の新しい意向や選択だけが必要なときは質問を使います。既に得た結果が判断に役立つなら、まずその確認済みの違いを伝え、足りない点だけを尋ねます。",
].join("\n");
export const conversationHostSystem: BackgroundSystemContext = {
	update: (input) => {
		const base = update(input);
		return { ...base, value: `${base.value}\n\n${participationPolicy}` };
	},
	select: (input) => {
		const base = select(input);
		return {
			...base,
			value: `${base.value}\n\n${participationPolicy}\n送出間隔の残りは入力のoutboundWaitMsです。これは背景処理自身の採用した行動からの制約であり、通常応答からの経過時間で別の制限を推定しません。0なら間隔の制約はなく、話す価値と負担で判断します。会話モードではconversationEvidenceRefsに今回の外部観測IDが提示されます。そのIDを根拠に、現在の場面への自然な反応や確認済みの違いをspeakで直接話せます。この場合candidateRefはnullです。長く保存する意図や候補がないことを、発話を見送る理由にしません。会話の価値がなく、共有済み・条件未成立・拒否後ならwaitです。toolや候補を使う発話には現在のcandidateRefが必要です。findingRefsも別に提示された場合だけ、そのrefを引用して候補なしで結果を使えます。`,
		};
	},
};
