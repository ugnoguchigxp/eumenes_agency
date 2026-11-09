/**
 * The comparison table for an adoption decision: each run of each group, and each group's
 * pooled numbers (judge, discomfort, reactions to topics, must-hold conditions, cost, wall time,
 * the agent's own questions and topics). Groups are comma-separated runs under data/agenda/runs.
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
