/**
 * H13 judge (P5-a), separate pass. Writes blind A/B pairs (order by hash, salt "h13j:r4");
 * reads <dir>/judge-answers.json {pairId: {better:"A"|"B", imaginedAsFact:{A:n,B:n}}} and scores.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { TURNS } from "./h13-scene.ts";

const dir = process.argv[2] ?? "eval/results/p5a-h13";
const runs = JSON.parse(readFileSync(`${dir}/runs.json`, "utf8")).out as any[];
const get = (c: string, t: string) =>
	runs.find((r) => r.cond === c && r.turn === t);
const say = (r: any) => r?.utterance ?? "（発話なし）";
const pairs = TURNS.filter((t) => t.related).flatMap((t) =>
	(["noInv", "invOff"] as const).map((other) => {
		const id = `${t.id}-${other}`;
		const flip =
			createHash("sha256").update(`h13j:r4:${id}`).digest()[0]! % 2 === 1;
		const [a, b] = flip ? [other, "invOn"] : ["invOn", other];
		return {
			id,
			user: t.text,
			A: say(get(a, t.id)),
			B: say(get(b, t.id)),
			key: { A: a, B: b },
		};
	}),
);
writeFileSync(
	`${dir}/judge-pairs.json`,
	JSON.stringify(
		pairs.map(({ key: _k, ...p }) => p),
		null,
		2,
	),
);
const ansPath = `${dir}/judge-answers.json`;
if (!existsSync(ansPath)) {
	console.log("pairs written; answer judge-answers.json");
	process.exit(0);
}
const ans = JSON.parse(readFileSync(ansPath, "utf8"));
let wins = 0;
let imagined = 0;
for (const p of pairs) {
	const a = ans[p.id];
	if ((p.key as any)[a.better] === "invOn") wins++;
	imagined += (a.imaginedAsFact?.A ?? 0) + (a.imaginedAsFact?.B ?? 0);
}
const spoken = runs.filter((r) => r.utterance);
const uses = spoken.filter((r) => /角換わり|腰掛け銀/.test(r.utterance));
const result = {
	label: "Grok Bot 自己推論値（回答者＝採点者が同一エージェント）",
	pairwiseInvestigationWins: `${wins}/${pairs.length}`,
	imaginedOrPreferenceAsFact: imagined,
	findingsUsedOnRelated: Object.fromEntries(
		["noInv", "invOff", "invOn"].map((c) => [
			c,
			runs.filter((r) => r.cond === c && r.related && r.utterance).length,
		]),
	),
	interruptionsOnUnrelated: Object.fromEntries(
		["noInv", "invOff", "invOn"].map((c) => [
			c,
			runs.filter((r) => r.cond === c && !r.related && r.utterance).length,
		]),
	),
	whenAnnotated: `${uses.filter((r) => /日前|時間前|分前/.test(r.utterance)).length}/${uses.length}`,
	certaintyAnnotated: `${uses.filter((r) => /確認|確かめ|範囲/.test(r.utterance)).length}/${uses.length}`,
	readingStyleWords: spoken.filter((r) =>
		/（読み|ふりがな|読み上げ|さん、/.test(r.utterance),
	).length,
	ticketTtsFalse: `${spoken.filter((r) => r.ticketTts === false).length}/${spoken.length}`,
	deliveryObservedTtsRecorded: `${spoken.filter((r) => typeof r.deliveredTts === "boolean").length}/${spoken.length}`,
};
writeFileSync(`${dir}/result.json`, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
