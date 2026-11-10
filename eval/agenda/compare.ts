/**
 * The comparison table for an adoption decision: each run of each group, and each group's
 * pooled numbers (judge, discomfort, reactions to topics, must-hold conditions, cost, wall time,
 * the agent's own questions and topics, and how much and how soon it spoke on its own). Groups
 * are comma-separated runs under data/agenda/runs.
 *
 *   bun eval/agenda/compare.ts ag23-base,ag24-base2 ag32-fix-1,ag32-fix-2
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { judgeAspects, type JudgeAspect } from "./judge.ts";
import { scenarioMetrics } from "./metrics.ts";

const label: Record<JudgeAspect, string> = {
	flow: "流れ",
	questions: "質問",
	anticipation: "先回り",
	pacing: "加減",
	honesty: "正直",
};

type Rows = ReturnType<typeof scenarioMetrics>;

const wallOf = (dir: string, rows: Rows) =>
	Math.max(
		0,
		...rows.map((r) => {
			const f = join(dir, `${r.scenario}.summary.json`);
			const s = existsSync(f)
				? (JSON.parse(readFileSync(f, "utf8")) as { wallSec?: number })
				: {};
			return s.wallSec ?? 0;
		}),
	);

const stats = (rows: Rows) => {
	const judged = rows.filter((r) => r.judge.flow !== null);
	const avg = (a: JudgeAspect) =>
		judged.length
			? judged.reduce((n, r) => n + (r.judge[a] ?? 0), 0) / judged.length
			: Number.NaN;
	const sum = (f: (r: Rows[number]) => number) =>
		rows.reduce((n, r) => n + f(r), 0);
	const checked = rows.filter((r) => r.condition);
	return {
		judge: Object.fromEntries(judgeAspects.map((a) => [a, avg(a)])) as Record<
			JudgeAspect,
			number
		>,
		uneasy: sum((r) => r.uneasy),
		uneasyWords: sum((r) => r.uneasyWords),
		labeled: sum((r) => r.labeled),
		felt: sum((r) => r.felt),
		reacted: sum((r) => r.reacted),
		talks: sum((r) => r.talks),
		ok: checked.filter((r) => r.condition!.ok).length,
		checked: checked.length,
		failed: checked.filter((r) => !r.condition!.ok).map((r) => r.scenario),
		usd: sum((r) => r.usd),
		ownAsks: sum((r) => r.asks),
	};
};

const pct = (a: number, b: number) =>
	b ? `${Math.round((a * 100) / b)}%` : "-";

const median = (xs: readonly number[]) => {
	if (xs.length === 0) return null;
	const s = [...xs].sort((a, b) => a - b);
	const m = Math.floor(s.length / 2);
	return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

/** How much and how soon the agent spoke on its own, pooled over runs and scenarios. */
const speechStats = (rows: Rows) => {
	const sum = (f: (p: Rows[number]["speech"]) => number) =>
		rows.reduce((n, r) => n + f(r.speech), 0);
	const openMin = sum((p) => p.openMin);
	const runs = new Set(rows.map((r) => r.run)).size || 1;
	return {
		// Outside the quiet set in each session; the quiet is counted on its own (per run).
		perMin: openMin ? sum((p) => p.own - p.spokeInQuiet) / openMin : 0,
		quietMinPerRun: sum((p) => p.quietMin) / runs,
		spokeInQuiet: sum((p) => p.spokeInQuiet),
		gapP50: median(rows.flatMap((r) => r.speech.gaps)),
		silenceP50: median(rows.map((r) => r.speech.longestSilenceSec)),
		firstOwnP50: median(rows.flatMap((r) => r.speech.firstOwnSec)),
		firstOwn: sum((p) => p.firstOwnSec.length),
		userLines: sum((p) => p.userLines),
		notesUsed: sum((p) => p.notesUsed),
		notesMade: sum((p) => p.notesMade),
		plannedSaid: sum((p) => p.plannedSaid),
		planned: sum((p) => p.planned),
		stale: sum((p) => p.stale),
		composes: sum((p) => p.composes),
		background: sum((p) => p.background),
		own: sum((p) => p.own),
		repeatsDropped: sum((p) => p.repeatsDropped),
	};
};
const speechHead =
	"| 実行 | 自発 回/分（静かな時間の外） | 静かな時間（分/回） | 静かな時間に話した | 間隔p50 | 最長の沈黙（シナリオの中央値） | 発言→自発p50 | 次の発言までに自発 | メモ使用 | 計画→発話 | 破棄した話す文 | 背景の呼び出し/自発 | 聞き直しで外した質問 |";
const speechCols = 12;
const secs = (x: number | null) => (x === null ? "-" : `${Math.round(x)}秒`);
const speechLine = (name: string, p: ReturnType<typeof speechStats>) =>
	console.log(
		`| ${name} | ${p.perMin.toFixed(2)} | ${p.quietMinPerRun.toFixed(0)} | ${p.spokeInQuiet} | ${secs(p.gapP50)} | ${secs(p.silenceP50)} | ${secs(p.firstOwnP50)} | ${p.firstOwn}/${p.userLines}（${pct(p.firstOwn, p.userLines)}） | ${p.notesUsed}/${p.notesMade}（${pct(p.notesUsed, p.notesMade)}） | ${p.plannedSaid}/${p.planned}（${pct(p.plannedSaid, p.planned)}） | ${p.stale}/${p.composes}（${pct(p.stale, p.composes)}） | ${p.own ? (p.background / p.own).toFixed(1) : "-"} | ${p.repeatsDropped} |`,
	);

if (import.meta.main) {
	const groups = process.argv.slice(2).map((g) => g.split(",").filter(Boolean));
	if (groups.length === 0)
		throw new Error("usage: compare.ts <run,run...> [<run,run...>...]");
	const head = `| 実行 | ${judgeAspects.map((a) => label[a]).join(" | ")} | 違和感 | （語で数えた違和感） | 話題に反応 | 守る条件 | 実時間 | $ |`;
	console.log(head);
	console.log(`| --- |${" ---: |".repeat(judgeAspects.length + 6)}`);
	const line = (name: string, s: ReturnType<typeof stats>, wall: string) =>
		console.log(
			`| ${name} | ${judgeAspects.map((a) => (Number.isNaN(s.judge[a]) ? "-" : s.judge[a].toFixed(2))).join(" | ")} | ${s.uneasy}/${s.felt}（${pct(s.uneasy, s.felt)}）${s.labeled < s.felt ? "*" : ""} | ${s.uneasyWords}/${s.felt}（${pct(s.uneasyWords, s.felt)}） | ${s.reacted}/${s.talks}（${pct(s.reacted, s.talks)}） | ${s.ok}/${s.checked}${s.failed.length ? `（×${s.failed.join(" ")}）` : ""} | ${wall} | ${s.usd.toFixed(3)} |`,
		);
	const pooled: { name: string; rows: Rows }[] = [];
	for (const g of groups) {
		const all: Rows = [];
		for (const run of g) {
			const dir = resolve("data/agenda/runs", run);
			if (!existsSync(dir)) throw new Error(`no run: ${dir}`);
			const rows = scenarioMetrics(dir, run);
			all.push(...rows);
			line(run, stats(rows), `${wallOf(dir, rows)}秒`);
		}
		pooled.push({ name: g.join("+"), rows: all });
	}
	console.log("\n発話の量と速さ（実行ごと、群ごと）:\n");
	console.log(speechHead);
	console.log(`| --- |${" ---: |".repeat(speechCols)}`);
	for (const p of pooled) {
		if (p.name.includes("+"))
			for (const run of p.name.split("+"))
				speechLine(run, speechStats(p.rows.filter((r) => r.run === run)));
		speechLine(p.name, speechStats(p.rows));
	}
	console.log(
		"\n（静かな時間は、返事が set_quiet で決めた期間（話しかけの停止は利用者が次に話すまで）。回/分と沈黙はその時間を除き、静かな時間は別に数える（頼まれていない長い静かな時間は、ここで増える）。沈黙は、エージェントの言葉（自分からと返事）がない時間で、シナリオの初めと終わりを含む。メモ使用は、そのセッションでできたメモのうち、話題にした・表示した・返事で読んだもの。計画→発話は、計画が足した質問と話題のうち、自分から話したか返事の最後に聞いたもの）",
	);
	console.log("\n自分から話した回数（1回あたり）: 質問・話題");
	for (const p of pooled) {
		const s = stats(p.rows);
		const n = p.name.split("+").length;
		console.log(
			`  ${p.name}: ${(s.ownAsks / n).toFixed(1)}・${(s.talks / n).toFixed(1)}`,
		);
	}
	if (groups.some((g) => g.length > 1) || groups.length > 1) {
		console.log("\n群ごと（全回をまとめた値。判定役は平均）:\n");
		console.log(head);
		console.log(`| --- |${" ---: |".repeat(judgeAspects.length + 6)}`);
		for (const p of pooled) {
			const s = stats(p.rows);
			const n = p.name.split("+").length;
			line(p.name, { ...s, usd: s.usd / n }, "-");
		}
		console.log("\n（群ごとの $ は1回あたり）");
		console.log(
			"違和感は利用者役が「違和感あり」と答えた数。* の付いた値は答えのない古い実行を含み、そこは感想の語で数えた。",
		);
	}
}
