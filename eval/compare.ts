/**
 * H1: before/after comparison of two eval runs with fixed thresholds
 * (eval/gates/thresholds.json). Per condition: TP/FP/FN/TN, recall,
 * precision, safety count, and per-rep spread. Decision: adopt only when
 * no gate regresses and at least one metric improves.
 */
import { readFileSync } from "node:fs";
import { classify, latestRecords } from "./score.ts";
import { runRecordSchema, type RunRecord } from "./contracts.ts";

export interface Thresholds {
	maxRecallDrop: number;
	maxFpIncrease: number;
	maxSafetyIncrease: number;
	maxUnnecessaryIncrease: number;
	minRecallGainToAdopt: number;
}

export interface CondStats {
	runs: number;
	TP: number;
	FP: number;
	FN: number;
	TN: number;
	safety: number;
	recall: number | null;
	precision: number | null;
	recallByRep: Record<number, number | null>;
}

const ratio = (a: number, b: number): number | null => (b === 0 ? null : a / b);

export function statsFor(records: RunRecord[]): Map<string, CondStats> {
	const out = new Map<string, CondStats>();
	const perRep = new Map<string, Map<number, { tp: number; fn: number }>>();
	for (const r of latestRecords(records)) {
		if (r.incomplete) continue;
		const s = out.get(r.condition) ?? {
			runs: 0,
			TP: 0,
			FP: 0,
			FN: 0,
			TN: 0,
			safety: 0,
			recall: null,
			precision: null,
			recallByRep: {},
		};
		s.runs += 1;
		s.safety += r.safety.length;
		const reps = perRep.get(r.condition) ?? new Map();
		const rep = reps.get(r.rep) ?? { tp: 0, fn: 0 };
		for (const o of r.opportunities) {
			const b = classify(o).bucket;
			if (b === "TP" || b === "FP" || b === "FN" || b === "TN") s[b] += 1;
			if (b === "TP") rep.tp += 1;
			if (b === "FN") rep.fn += 1;
		}
		reps.set(r.rep, rep);
		perRep.set(r.condition, reps);
		out.set(r.condition, s);
	}
	for (const [c, s] of out) {
		s.recall = ratio(s.TP, s.TP + s.FN);
		s.precision = ratio(s.TP, s.TP + s.FP);
		for (const [rep, v] of perRep.get(c) ?? [])
			s.recallByRep[rep] = ratio(v.tp, v.tp + v.fn);
	}
	return out;
}

export interface Verdict {
	condition: string;
	adopt: boolean;
	reasons: string[];
}

export function decide(
	before: CondStats,
	after: CondStats,
	t: Thresholds,
	condition: string,
): Verdict {
	const reasons: string[] = [];
	const rb = before.recall ?? 0;
	const ra = after.recall ?? 0;
	if (rb - ra > t.maxRecallDrop)
		reasons.push(`recall低下 ${rb.toFixed(2)}→${ra.toFixed(2)}`);
	if (after.FP - before.FP > t.maxFpIncrease)
		reasons.push(`FP増加 ${before.FP}→${after.FP}`);
	if (after.safety - before.safety > t.maxSafetyIncrease)
		reasons.push(`安全観測増加 ${before.safety}→${after.safety}`);
	const improved = ra - rb > t.minRecallGainToAdopt || after.FP < before.FP;
	if (!improved && reasons.length === 0) reasons.push("改善なし");
	return { condition, adopt: reasons.length === 0, reasons };
}

const fmt = (x: number | null): string => (x === null ? "-" : x.toFixed(2));

export function compareTable(
	before: Map<string, CondStats>,
	after: Map<string, CondStats>,
	t: Thresholds,
): string {
	const lines = [
		"| 条件 | 側 | run | TP | FP | FN | TN | recall | precision | 安全 | rep別recall |",
		"| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
	];
	const verdicts: Verdict[] = [];
	for (const c of new Set([...before.keys(), ...after.keys()])) {
		for (const [side, m] of [
			["before", before],
			["after", after],
		] as const) {
			const s = m.get(c);
			if (!s) continue;
			const reps = Object.entries(s.recallByRep)
				.map(([k, v]) => `r${k}=${fmt(v)}`)
				.join(" ");
			lines.push(
				`| ${c} | ${side} | ${s.runs} | ${s.TP} | ${s.FP} | ${s.FN} | ${s.TN} | ${fmt(s.recall)} | ${fmt(s.precision)} | ${s.safety} | ${reps} |`,
			);
		}
		const b = before.get(c);
		const a = after.get(c);
		if (b && a) verdicts.push(decide(b, a, t, c));
	}
	lines.push("", "| 条件 | 判定 | 理由 |", "| --- | --- | --- |");
	for (const v of verdicts)
		lines.push(
			`| ${v.condition} | ${v.adopt ? "採用可" : "不採用"} | ${v.reasons.join("; ") || "-"} |`,
		);
	return lines.join("\n");
}

export function loadRuns(path: string): RunRecord[] {
	return readFileSync(path, "utf8")
		.split("\n")
		.filter((l) => l.trim())
		.map((l) => runRecordSchema.parse(JSON.parse(l)));
}

if (import.meta.main) {
	const [before, after] = process.argv.slice(2);
	if (!before || !after) {
		console.error(
			"usage: bun eval/compare.ts <before-run-name> <after-run-name>",
		);
		process.exit(2);
	}
	const t = JSON.parse(
		readFileSync(new URL("./gates/thresholds.json", import.meta.url), "utf8"),
	) as Thresholds;
	const load = (n: string) =>
		statsFor(loadRuns(`eval/results/${n}/runs.jsonl`));
	console.log(compareTable(load(before), load(after), t));
}
