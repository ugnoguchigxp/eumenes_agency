/**
 * Writer bench: what the researcher (the real web note writer) puts in a note's title and summary,
 * the only part the agent's utterance writer sees. On fixed requests from the CLI of 2026-11-10,
 * many times. There, a request on 『ゴジラ-0.0』 (out on 2026-11-03) came back titled and summed up
 * as 『ゴジラ-1.0』, the body saying "ご依頼の「ゴジラ-0.0」は誤記と思われます", and the agent told the
 * user about -1.0 as if it were what they talked about; and a request for showings on a holiday
 * came back summed up with tonight's showings first. The checks: does the title or summary keep
 * the name asked for (and, when it gives another, say it is another); does the summary open with
 * the condition asked for (the holiday). Uses web search (cost recorded, never capped).
 *
 *   zsh -l scripts/api-entry.zsh eval/agenda/writer-bench.ts run <name> [--repeat 3] [request...]
 *   bun eval/agenda/writer-bench.ts compare <name> [<name>...]
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { openUncappedMeter } from "../../standalone/always-on-host.ts";
import { webNoteWriter } from "../../standalone/agenda-research.ts";
import { loadSettings } from "../../standalone/settings.ts";

const DIR = resolve("data/agenda/writer-bench");

export interface WriterRequest {
	readonly name: string;
	readonly request: string;
	/** The name asked for: the title or summary should carry it. */
	readonly keep: RegExp;
	/** Another thing the writer may swap in: if named, it must be said to be another. */
	readonly swap?: RegExp;
	/** The condition asked for: the summary should open with it (its first sentence). */
	readonly first?: RegExp;
	/** The answer under that condition: found (times on the day), or when it will be out. */
	readonly answer?: RegExp;
}

export const writerRequests: readonly WriterRequest[] = [
	{
		name: "minus-zero-sights",
		request:
			"映画『ゴジラ-0.0』の作品の見どころと舞台（戦後の東京や海沿いの描写）を調べ、景色や海が好きな相手が楽しめる観点でまとめる",
		keep: /-0\.0|マイナスゼロ/u,
		swap: /-1\.0|マイナスワン/u,
	},
	{
		name: "minus-zero-again",
		request:
			"映画『ゴジラ-0.0』の舞台と見どころを改めて調べ、前のメモ（ゴジラ-1.0）とは別の作品としてまとめる",
		keep: /-0\.0|マイナスゼロ/u,
		swap: /-1\.0|マイナスワン/u,
	},
	{
		name: "kawasaki-holiday",
		request:
			"映画『ゴジラ-0.0』を川崎周辺（川崎駅近くのIMAXや大型シネコンなど）で見られる映画館と上映時間を調べ、休日に行きやすい候補をまとめる。七里ヶ浜からの電車での行き方も添える",
		keep: /-0\.0|マイナスゼロ/u,
		swap: /-1\.0|マイナスワン/u,
		first: /休日|土日|土曜|日曜|週末/u,
		// Times on Saturday or Sunday, or when the weekend's showings will be out.
		answer:
			/(?:土|日|休日|週末|11\/1[45])[^。]*\d{1,2}[:：]\d{2}|\d{1,2}[:：]\d{2}[^。]*(?:土|日曜|休日|週末)|(?:公開|掲載|発表)(?:は|され)[^。]*(?:水|木|金|ごろ|頃|前日|日前)/u,
	},
	{
		name: "ofuna-kannon",
		request:
			"大船の大きな観音像（大船観音）について、場所・高さなどの基本情報、最寄り駅からの行き方、見どころ、拝観時間と料金をまとめる",
		keep: /大船観音/u,
	},
	{
		name: "qwen4",
		request:
			"Qwen4の公式なリリース時期と発表内容を確かめ、公式情報と噂を分けてまとめる",
		keep: /Qwen ?4/u,
		swap: /Qwen ?3(?:\.\d)?(?![\d.])/u,
	},
];

/** A sentence that tells the thing named is another than the one asked for, or was not found. */
const SAYS_OTHER =
	/別の作品|別作品|とは別|ではなく|見つから|確認でき(?:ず|ない|なかった|ません)|情報がな|公式情報はな|前作/u;

interface Trial {
	readonly request: string;
	readonly trial: number;
	readonly title: string;
	readonly summary: string;
	readonly keeps: boolean;
	/** Names the other thing without saying it is another. */
	readonly swapped: boolean;
	readonly firstFits: boolean | null;
	readonly typo: boolean;
}

async function run(name: string, repeat: number, only: readonly string[]) {
	const settings = loadSettings(
		resolve(process.env.AGENCY_SETTINGS ?? "config/always-on.json"),
	);
	const meter = openUncappedMeter(settings, resolve("data/agenda/usage.jsonl"));
	const spent = meter.spentUsd();
	mkdirSync(DIR, { recursive: true });
	const jobs = writerRequests
		.filter((w) => only.length === 0 || only.includes(w.name))
		.flatMap((w) =>
			Array.from({ length: repeat }, (_, k) => ({ w, trial: k + 1 })),
		);
	let searches = 0;
	const out: Trial[] = [];
	const one = async ({ w, trial }: (typeof jobs)[number]) => {
		// The CLI's clock that evening.
		const writer = webNoteWriter({
			role: settings.llm.background,
			meter,
			today: () => "2026/11/10(火) 19:10",
		});
		const note = await writer.writer(w.request);
		searches += writer.searches();
		const head = `${note.title}\n${note.summary}`;
		const firstSentence = note.summary.split(/(?<=[。！？])/u)[0] ?? "";
		out.push({
			request: w.name,
			trial,
			title: note.title,
			summary: note.summary,
			keeps: w.keep.test(head),
			swapped: w.swap ? w.swap.test(head) && !SAYS_OTHER.test(head) : false,
			firstFits: w.first ? w.first.test(firstSentence) : null,
			typo: /誤記|誤り|間違い/u.test(`${head}\n${note.markdown}`),
		});
	};
	const queue = [...jobs];
	await Promise.all(
		Array.from({ length: Math.min(5, queue.length) }, async () => {
			for (let j = queue.shift(); j; j = queue.shift())
				await one(j).catch((e: unknown) =>
					console.error(
						`${j.w.name}#${j.trial}: ${e instanceof Error ? e.message : String(e)}`,
					),
				);
		}),
	);
	out.sort((a, b) =>
		a.request === b.request
			? a.trial - b.trial
			: a.request.localeCompare(b.request),
	);
	writeFileSync(
		join(DIR, `${name}.jsonl`),
		out.map((t) => JSON.stringify(t)).join("\n") + "\n",
	);
	console.log(
		`${out.length}/${jobs.length} 件、$${(meter.spentUsd() - spent).toFixed(3)}（トークン分。Web 検索 ${searches} 回の料金は別）。比較: bun eval/agenda/writer-bench.ts compare ${name}`,
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

/** The checks, from the title and summary (so earlier runs are read the same way). */
const check = (w: WriterRequest, t: Trial) => {
	const head = `${t.title}\n${t.summary}`;
	const firstSentence = t.summary.split(/(?<=[。！？])/u)[0] ?? "";
	return {
		keeps: w.keep.test(head),
		swapped: w.swap ? w.swap.test(head) && !SAYS_OTHER.test(head) : false,
		firstFits: w.first ? w.first.test(firstSentence) : null,
		mentions: w.first ? w.first.test(t.summary) : null,
		answers: w.answer ? w.answer.test(t.summary) : null,
	};
};

function compare(names: readonly string[]) {
	console.log(
		"| 版 | 依頼 | 試行 | 題・要約に頼んだ名前 | 別のものと言わずに置き換えた | 要約が条件に触れる（最初の文で） | 条件での答え（時刻か公開時期） | 「誤記」と書いた |",
	);
	console.log(`| --- | --- |${" ---: |".repeat(6)}`);
	for (const name of names) {
		const trials = load(name);
		for (const w of writerRequests) {
			const ts = trials.filter((t) => t.request === w.name);
			if (ts.length === 0) continue;
			const cs = ts.map((t) => check(w, t));
			console.log(
				`| ${name} | ${w.name} | ${ts.length} | ${cs.filter((c) => c.keeps).length} | ${w.swap ? cs.filter((c) => c.swapped).length : "-"} | ${w.first ? `${cs.filter((c) => c.mentions).length}（${cs.filter((c) => c.firstFits).length}）` : "-"} | ${w.answer ? cs.filter((c) => c.answers).length : "-"} | ${ts.filter((t) => t.typo).length} |`,
			);
		}
	}
	console.log("\n題と要約:\n");
	for (const name of names)
		for (const t of load(name))
			console.log(
				`- ${name} ${t.request}#${t.trial}: ${t.title} ／ ${t.summary}`,
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
			throw new Error(
				"usage: writer-bench.ts run <name> [--repeat N] [request...]",
			);
		const only = rest.filter(
			(a, k) => a !== name && !a.startsWith("--") && rest[k - 1] !== "--repeat",
		);
		await run(name, repeat, only);
	} else if (cmd === "compare" && rest.length) compare(rest);
	else
		throw new Error(
			"usage: writer-bench.ts run <name> [--repeat N] | compare <name> [<name>...]",
		);
}
