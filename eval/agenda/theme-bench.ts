/**
 * Theme bench (review 2026-11-10 evening 3.4): a research the plan proposes on its own, with a
 * note on the same theme from three days before. Information that changes with the day (the
 * weather, the news, prices, showings) should be looked up again; what does not change (how a
 * thing works, its history) should not. Two refusals stand in the way: the code's character
 * overlap (with every note before; with the notes of the last day now) and the check call (the
 * model; now told how old each note is). Both are counted, on the real check, many times.
 *
 *   AGENCY_SETTINGS=config/agenda-luna.json zsh -l scripts/api-entry.zsh \
 *     eval/agenda/theme-bench.ts run <name> [--repeat 3]
 *   bun eval/agenda/theme-bench.ts compare <name> [<name>...]
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { check } from "../../src/agenda/check.ts";
import {
	SAME_THEME_OVERLAP,
	type NoteRef,
} from "../../src/agenda/contracts.ts";
import {
	askCheckSystem,
	checkSystem,
	composeSystem,
	planSystem,
} from "../../src/agenda/prompt.ts";
import { createState, makeItem } from "../../src/agenda/state.ts";
import { themeOverlap } from "../../src/agenda/text.ts";
import { openUncappedMeter } from "../../standalone/always-on-host.ts";
import { createProviderLlm } from "../../standalone/providers.ts";
import { loadSettings } from "../../standalone/settings.ts";
import { clockFrom } from "./live.ts";
import { clientFor } from "./verifier.ts";

const DIR = resolve("data/agenda/theme-bench");
const NOW = Date.parse("2026-11-11T10:00:00+09:00");
const NOTE_AT = NOW - 72 * 3_600_000;
/** The code's rule since 2026-11-11: only notes of the last day are compared in code. */
const FRESH_MS = 24 * 3_600_000;

export interface ThemeCase {
	readonly name: string;
	/** Changes with the day: should be looked up again. */
	readonly dated: boolean;
	readonly request: string;
	readonly note: { readonly title: string; readonly summary: string };
}

export const themeCases: readonly ThemeCase[] = [
	{
		name: "sapporo-weather",
		dated: true,
		request: "明日の札幌の天気と、出かけるときの服装の目安を調べる",
		note: {
			title: "札幌の天気と服装の目安",
			summary:
				"11/8(土)の札幌は晴れのち雪、最高気温4℃。厚手のコートと手袋が必要。",
		},
	},
	{
		name: "chip-news",
		dated: true,
		request: "最近の半導体業界のニュースを調べ、重要なものをまとめる",
		note: {
			title: "半導体業界の最近のニュース",
			summary:
				"11/7時点: 大手の新工場の着工、AI向けメモリの値上がり、輸出規制の見直しが主な話題。",
		},
	},
	{
		name: "museum-week",
		dated: true,
		request: "今週末の国立科学博物館の特別展と、開館時間を調べる",
		note: {
			title: "国立科学博物館の特別展と開館時間",
			summary:
				"11/8時点の特別展は「深海展」（11/9まで）。開館は9時〜17時、金土は20時まで。",
		},
	},
	{
		name: "yen-rate",
		dated: true,
		request: "今の円ドル相場と、旅行の両替をいつするとよいかを調べる",
		note: {
			title: "円ドル相場と両替のタイミング",
			summary:
				"11/8時点で1ドル151円前後。両替は空港より市中の両替所かカードが有利。",
		},
	},
	{
		name: "pollen",
		dated: true,
		request: "今週の東京の花粉の飛散予報を調べる",
		note: {
			title: "東京の花粉の飛散予報",
			summary:
				"11/8の予報ではブタクサが少なめ、週末にかけて飛散はやや多い見込み。",
		},
	},
	{
		name: "baseball",
		dated: true,
		request: "昨日のプロ野球の試合結果を調べる",
		note: {
			title: "プロ野球の試合結果",
			summary: "11/7の試合: 日本シリーズ第6戦は延長の末にサヨナラ勝ち。",
		},
	},
	{
		name: "gas-price",
		dated: true,
		request: "今週のガソリン価格の全国平均を調べる",
		note: {
			title: "ガソリン価格の全国平均",
			summary:
				"11/5発表の全国平均はレギュラー1リットル174円、前週より1円安い。",
		},
	},
	{
		name: "console-stock",
		dated: true,
		request: "Nintendo Switch 2 の今の在庫状況と、買える店を調べる",
		note: {
			title: "Nintendo Switch 2 の在庫状況",
			summary: "11/8時点で大手量販店の店頭在庫は少なめ、公式ストアは抽選販売。",
		},
	},
	{
		name: "typhoon",
		dated: true,
		request: "台風の最新の進路予報を調べる",
		note: {
			title: "台風の進路予報",
			summary:
				"11/8時点で台風25号は沖縄の南を北上、週明けに本州に近づく見込み。",
		},
	},
	{
		name: "shinjuku-showings",
		dated: true,
		request: "今週末の新宿の映画館の上映スケジュールを調べる",
		note: {
			title: "新宿の映画館の上映スケジュール",
			summary: "11/8(土)の上映: 話題作は朝9時から夜21時まで1日6回。",
		},
	},
	{
		name: "clock-tower",
		dated: false,
		request: "札幌の時計台の歴史と見どころを調べる",
		note: {
			title: "札幌時計台の歴史と見どころ",
			summary:
				"1878年に札幌農学校の演武場として建てられた。現存する日本最古の塔時計の一つ。",
		},
	},
	{
		name: "chip-making",
		dated: false,
		request: "半導体がどうやって作られるのか、製造工程の仕組みを調べる",
		note: {
			title: "半導体の製造工程",
			summary:
				"シリコンウェハーに露光・エッチング・成膜を繰り返して回路を作り、切り分けて封止する。",
		},
	},
	{
		name: "museum-halls",
		dated: false,
		request: "国立科学博物館の常設展の見どころを調べる",
		note: {
			title: "国立科学博物館の常設展の見どころ",
			summary:
				"日本館の恐竜化石と忠犬ハチ公の剥製、地球館の生命の進化の展示が人気。",
		},
	},
	{
		name: "exchange-rates",
		dated: false,
		request: "為替レートがどうやって決まるのか、仕組みを調べる",
		note: {
			title: "為替レートの決まり方",
			summary:
				"通貨の需要と供給で決まり、金利差・貿易収支・景気の見通しが主な要因。",
		},
	},
	{
		name: "hay-fever",
		dated: false,
		request: "花粉症が起きる仕組みと、基本的な対策を調べる",
		note: {
			title: "花粉症の仕組みと対策",
			summary:
				"花粉に免疫が過剰に反応して起きる。マスク・眼鏡・早めの薬が基本の対策。",
		},
	},
	{
		name: "draft",
		dated: false,
		request: "プロ野球のドラフト制度の仕組みを調べる",
		note: {
			title: "プロ野球のドラフト制度",
			summary:
				"新人選手の交渉権を球団が指名で分け合う制度。重複指名は抽選で決める。",
		},
	},
	{
		name: "gas-tax",
		dated: false,
		request: "ガソリンの値段の内訳（税金など）を調べる",
		note: {
			title: "ガソリン価格の内訳",
			summary:
				"原油代のほか、ガソリン税・石油石炭税・消費税が含まれ、税が約4割を占める。",
		},
	},
	{
		name: "console-specs",
		dated: false,
		request: "Nintendo Switch 2 の本体の仕様を調べる",
		note: {
			title: "Nintendo Switch 2 の本体の仕様",
			summary: "7.9インチの液晶、最大4K出力（テレビ接続時）、内蔵256GB。",
		},
	},
	{
		name: "typhoon-names",
		dated: false,
		request: "台風ができる仕組みと、名前の付け方を調べる",
		note: {
			title: "台風ができる仕組みと名前",
			summary:
				"暖かい海の水蒸気で発達する熱帯低気圧。名前はアジアの14か国などが出した140の名前を順に使う。",
		},
	},
	{
		name: "imax",
		dated: false,
		request: "映画館の IMAX と通常の上映の違いを調べる",
		note: {
			title: "IMAX と通常上映の違い",
			summary:
				"IMAX は大きな縦長のスクリーンと専用の音響で、画面の上下まで映る作品がある。",
		},
	},
];

interface Trial {
	readonly case: string;
	readonly trial: number;
	readonly verdict: string;
	readonly reason: string;
}

async function run(name: string, repeat: number) {
	const settings = loadSettings(
		resolve(process.env.AGENCY_SETTINGS ?? "config/always-on.json"),
	);
	const meter = openUncappedMeter(settings, resolve("data/agenda/usage.jsonl"));
	const spent = meter.spentUsd();
	const llm = createProviderLlm(
		settings.llm.background,
		meter,
		clientFor(settings.llm.background),
	);
	const clock = clockFrom("2026-11-11T10:00:00+09:00");
	mkdirSync(DIR, { recursive: true });
	const jobs = themeCases.flatMap((c) =>
		Array.from({ length: repeat }, (_, k) => ({ c, trial: k + 1 })),
	);
	const out: Trial[] = [];
	const one = async ({ c, trial }: (typeof jobs)[number]) => {
		const note: NoteRef = {
			id: "n1",
			title: c.note.title,
			summary: c.note.summary,
			at: NOTE_AT,
			refs: [],
		};
		const st = createState(
			{
				llm,
				notes: () => [note],
				clock: (t) => clock(t - NOW),
				startedAt: NOW,
			},
			10_000,
			{
				plan: planSystem(),
				check: checkSystem(),
				compose: composeSystem(),
				askCheck: askCheckSystem(),
			},
		);
		const item = makeItem(st, {
			kind: "research",
			text: c.request,
			refs: ["profile:p1"],
			value: 3,
			reason: "bench",
			createdAt: NOW,
		});
		st.items.push(item);
		const r = await check(st, item, NOW, new AbortController().signal);
		out.push({ case: c.name, trial, verdict: r.verdict, reason: r.reason });
	};
	const queue = [...jobs];
	await Promise.all(
		Array.from({ length: 8 }, async () => {
			for (let j = queue.shift(); j; j = queue.shift())
				await one(j).catch((e: unknown) =>
					console.error(
						`${j.c.name}#${j.trial}: ${e instanceof Error ? e.message : String(e)}`,
					),
				);
		}),
	);
	out.sort((a, b) =>
		a.case === b.case ? a.trial - b.trial : a.case.localeCompare(b.case),
	);
	writeFileSync(
		join(DIR, `${name}.jsonl`),
		out.map((t) => JSON.stringify(t)).join("\n") + "\n",
	);
	console.log(
		`${out.length}/${jobs.length} 件、$${(meter.spentUsd() - spent).toFixed(3)}。比較: bun eval/agenda/theme-bench.ts compare ${name}`,
	);
}

const load = (name: string): Trial[] => {
	const f = join(DIR, `${name}.jsonl`);
	if (!existsSync(f)) throw new Error(`no bench run: ${f}`);
	return readFileSync(f, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((l) => JSON.parse(l) as Trial);
};

/** The code's refusal by character overlap, before 2026-11-11 (any note) and since (a day's). */
const codeRefuses = (c: ThemeCase, since: boolean) =>
	(!since || NOW - NOTE_AT < FRESH_MS) &&
	themeOverlap(c.request, `${c.note.title}${c.note.summary}`) >=
		SAME_THEME_OVERLAP;

/**
 * `<name>` or `<name>@before`: the code rule the run is read with (since 2026-11-11 by default;
 * `@before` for a run of the version before, whose code compared every note).
 */
function compare(names: readonly string[]) {
	console.log(
		"| 版 | 種類 | 依頼 | コードが断った | 確認が covered | 断った合計（調べ直さない） |",
	);
	console.log("| --- | --- | ---: | ---: | ---: | ---: |");
	for (const arg of names) {
		const [name, rule] = arg.split("@");
		const trials = load(name!);
		for (const dated of [true, false]) {
			const cs = themeCases.filter((c) => c.dated === dated);
			const ts = trials.filter((t) => cs.some((c) => c.name === t.case));
			const code = ts.filter((t) =>
				codeRefuses(
					cs.find((c) => c.name === t.case)!,
					rule !== "before",
				),
			);
			const covered = ts.filter((t) => t.verdict === "covered");
			const refused = ts.filter(
				(t) => code.includes(t) || t.verdict === "covered",
			);
			console.log(
				`| ${arg} | ${dated ? "日で変わる（調べ直したい）" : "変わらない（調べ直さない）"} | ${ts.length} | ${code.length} | ${covered.length} | ${refused.length} |`,
			);
		}
	}
	console.log("\n依頼ごと（C 確認が covered、P partial、N new、- 失敗）:\n");
	console.log(`| 依頼 | 種類 | ${names.join(" | ")} |`);
	console.log(`| --- | --- |${" --- |".repeat(names.length)}`);
	for (const c of themeCases)
		console.log(
			`| ${c.name} | ${c.dated ? "日で変わる" : "変わらない"} | ${names
				.map((arg) =>
					load(arg.split("@")[0]!)
						.filter((t) => t.case === c.name)
						.map((t) =>
							t.verdict === "covered"
								? "C"
								: t.verdict === "partial"
									? "P"
									: t.verdict === "new"
										? "N"
										: "-",
						)
						.join(""),
				)
				.join(" | ")} |`,
		);
}

if (import.meta.main) {
	const [cmd, ...rest] = process.argv.slice(2);
	if (cmd === "run") {
		const i = rest.indexOf("--repeat");
		const repeat = i >= 0 ? Number(rest[i + 1]) : 3;
		const name = rest.find(
			(a, k) => !a.startsWith("--") && rest[k - 1] !== "--repeat",
		);
		if (!name || !Number.isInteger(repeat) || repeat < 1)
			throw new Error("usage: theme-bench.ts run <name> [--repeat N]");
		await run(name, repeat);
	} else if (cmd === "compare" && rest.length) compare(rest);
	else
		throw new Error(
			"usage: theme-bench.ts run <name> [--repeat N] | compare <name>[@before] ...",
		);
}
