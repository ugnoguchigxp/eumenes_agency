/**
 * Surface-cue balance check for the P1-E case set (review 2026-10-22 E3).
 *
 * For every opportunity with a label (`expect` not null) this derives cue values that a model could
 * use to guess the label without understanding the matter: the trigger, the shape of the last
 * observation before the opportunity ("ending shape") and the shape of the last two observations.
 * Inside each (split, group) it prints a table (trigger, ending shape) x (needed / not-needed) and
 * FAILS when, for a cue dimension, the set of cue values seen on needed opportunities and the set
 * seen on not-needed opportunities are disjoint (so one value, or a set of values, separates the
 * labels perfectly). A group with opportunities of only one label also fails (no contrast).
 *
 * Rules (per split and group):
 *  1. per cue dimension (trigger, ending, ending2 and the joint cell "trigger / ending"), the
 *     needed-values and not-needed-values must share at least one value;
 *  2. the share of opportunities whose joint cell (trigger / ending) holds only one label must not
 *     exceed SINGLE_LABEL_MAX (0.4) in a group with at least MIN_FOR_SHARE (6) opportunities.
 *     Rule 1 on the joint cell only catches complete separation; rule 2 catches near-separation
 *     (for example a trigger that is "idle" only when waiting is right). 0.4 leaves room for the
 *     cells that are one-sided for a semantic reason (the user is away: wait) while still failing
 *     groups where most of the label can be read off the timing.
 * Lopsided values that still overlap are only reported as warnings.
 */
import type { Case } from "../../../contracts.ts";

type Obs = Extract<Case["steps"][number], { type: "observation" }>;

export type EndingShape =
	| "agent_will" // agent reply that is still mid-task: 〜します / 〜ましょう / 〜ですね
	| "agent_done" // agent reply that reports a finished act: 〜しました / 〜です
	| "user_pause" // user announces a break (free for a chat): 休憩する / ここまでにして
	| "user_away" // user announces being busy or away (waiting is right): 電話 / 来客 / 対応してくる
	| "user_report" // user.report observation (the user reports an outcome)
	| "user_plan" // any other user utterance: a request, a plan, a statement
	| "external_result"; // tool / host / source observation (result_received-like)

export interface Cue {
	trigger: string;
	/** Shape of the last observation. */
	ending: EndingShape;
	/** Shapes of the last two observations, oldest first. */
	ending2: string;
	/** The joint cell: "trigger / ending". */
	joint: string;
}

export const CUE_DIMENSIONS = [
	"trigger",
	"ending",
	"ending2",
	"joint",
] as const;
export const SINGLE_LABEL_MAX = 0.4;
export const MIN_FOR_SHARE = 6;
export type CueDimension = (typeof CUE_DIMENSIONS)[number];

const PAUSE = /(休憩|一息|ここまでにして)/;
const AWAY = /(しばらく出る|対応してくる|電話が来た|来客)/;
const DONE = /(ました|でした|です|ません)[。！]?$/;

export function shapeOf(o: Obs): EndingShape {
	if (o.actor === "tool" || o.actor === "host") return "external_result";
	if (o.actor === "agent")
		return DONE.test(o.text) ? "agent_done" : "agent_will";
	if (o.kind === "user.report") return "user_report";
	if (AWAY.test(o.text)) return "user_away";
	return PAUSE.test(o.text) ? "user_pause" : "user_plan";
}

export interface LabeledOpp {
	caseId: string;
	oppId: string;
	needed: boolean;
	cue: Cue;
	/**
	 * Character-bigram overlap between the last two observations and the present steps that are not
	 * themselves among the last two observations.
	 */
	overlap: number;
}

const bigrams = (s: string): Set<string> => {
	const out = new Set<string>();
	const t = s.replace(/[\s。、，．！？「」（）()]/g, "");
	for (let i = 0; i + 1 < t.length; i++) out.add(t.slice(i, i + 2));
	return out;
};

export function collect(c: Case): LabeledOpp[] {
	const seen: Obs[] = [];
	const byId = new Map<string, Obs>();
	const out: LabeledOpp[] = [];
	for (const s of c.steps) {
		if (s.type === "observation") {
			seen.push(s);
			byId.set(s.id, s);
			continue;
		}
		if (!s.expect) continue;
		const last = seen[seen.length - 1];
		const prev = seen[seen.length - 2];
		if (!last) continue;
		const sh = shapeOf(last);
		const sh2 = prev ? `${shapeOf(prev)}>${sh}` : sh;
		const tail = new Set([
			...bigrams(last.text),
			...(prev ? bigrams(prev.text) : []),
		]);
		const pres = new Set<string>();
		for (const id of s.present) {
			if (id === last.id || id === prev?.id) continue;
			const o = byId.get(id);
			if (o) for (const g of bigrams(o.text)) pres.add(g);
		}
		let inter = 0;
		for (const g of tail) if (pres.has(g)) inter += 1;
		const overlap = tail.size === 0 ? 0 : inter / tail.size;
		out.push({
			caseId: c.id,
			oppId: s.id,
			needed: s.expect.needed,
			cue: {
				trigger: s.trigger,
				ending: sh,
				ending2: sh2,
				joint: `${s.trigger} / ${sh}`,
			},
			overlap,
		});
	}
	return out;
}

export interface GroupReport {
	key: string;
	total: number;
	needed: number;
	/** (trigger, ending) -> [needed, notNeeded]. */
	table: Map<string, [number, number]>;
	problems: string[];
	warnings: string[];
	overlap: { needed: number; notNeeded: number };
	/** Share of opportunities whose joint cell (trigger / ending) holds one label only. */
	singleShare: number;
}

export function analyze(key: string, opps: LabeledOpp[]): GroupReport {
	const needed = opps.filter((o) => o.needed);
	const not = opps.filter((o) => !o.needed);
	const table = new Map<string, [number, number]>();
	for (const o of opps) {
		const k = `${o.cue.trigger} / ${o.cue.ending}`;
		const row = table.get(k) ?? [0, 0];
		row[o.needed ? 0 : 1] += 1;
		table.set(k, row);
	}
	const problems: string[] = [];
	const warnings: string[] = [];
	if (needed.length === 0 || not.length === 0)
		problems.push(
			`only ${needed.length === 0 ? "not-needed" : "needed"} opportunities (no contrast)`,
		);
	else {
		for (const dim of CUE_DIMENSIONS) {
			const a = new Set(needed.map((o) => o.cue[dim]));
			const b = new Set(not.map((o) => o.cue[dim]));
			const shared = [...a].filter((v) => b.has(v));
			if (shared.length === 0)
				problems.push(
					`${dim}: needed {${[...a].join(", ")}} and not-needed {${[...b].join(", ")}} are disjoint`,
				);
			else {
				// Informational: a value with >=4 opportunities that is entirely one label.
				for (const v of new Set([...a, ...b])) {
					const n = needed.filter((o) => o.cue[dim] === v).length;
					const m = not.filter((o) => o.cue[dim] === v).length;
					if (n + m >= 4 && (n === 0 || m === 0))
						warnings.push(
							`${dim}=${v}: ${n} needed / ${m} not-needed (lopsided)`,
						);
				}
			}
		}
	}
	let single = 0;
	for (const [n, m] of table.values()) if (n === 0 || m === 0) single += n + m;
	const singleShare = opps.length === 0 ? 0 : single / opps.length;
	if (opps.length >= MIN_FOR_SHARE && singleShare > SINGLE_LABEL_MAX)
		problems.push(
			`single-label joint cells hold ${(singleShare * 100).toFixed(0)}% of the opportunities (max ${SINGLE_LABEL_MAX * 100}%)`,
		);
	const mean = (xs: LabeledOpp[]) =>
		xs.length === 0 ? 0 : xs.reduce((s, x) => s + x.overlap, 0) / xs.length;
	return {
		key,
		total: opps.length,
		needed: needed.length,
		table,
		problems,
		warnings,
		overlap: { needed: mean(needed), notNeeded: mean(not) },
		singleShare,
	};
}

/** Analyze built cases: one report per (split, group). */
export function analyzeAll(cases: readonly Case[]): GroupReport[] {
	const groups = new Map<string, LabeledOpp[]>();
	for (const c of cases) {
		const k = `${c.split}/${c.group}`;
		const xs = groups.get(k) ?? [];
		xs.push(...collect(c));
		groups.set(k, xs);
	}
	return [...groups.entries()]
		.sort(([x], [y]) => x.localeCompare(y))
		.map(([k, xs]) => analyze(k, xs));
}

export function formatReport(reports: readonly GroupReport[]): string {
	const lines: string[] = [];
	for (const r of reports) {
		lines.push(
			`[${r.key}] opportunities ${r.total} (needed ${r.needed} / not-needed ${r.total - r.needed}); single-label joint cells ${(r.singleShare * 100).toFixed(0)}%; mean bigram overlap needed ${r.overlap.needed.toFixed(2)} / not-needed ${r.overlap.notNeeded.toFixed(2)}`,
		);
		const rows = [...r.table.entries()].sort(([x], [y]) => x.localeCompare(y));
		const w = Math.max(...rows.map(([k]) => k.length), 24);
		lines.push(`  ${"trigger / ending".padEnd(w)}  needed  not-needed`);
		for (const [k, [n, m]] of rows)
			lines.push(
				`  ${k.padEnd(w)}  ${String(n).padStart(6)}  ${String(m).padStart(10)}`,
			);
		for (const w2 of r.warnings) lines.push(`  warn: ${w2}`);
		for (const p of r.problems) lines.push(`  FAIL: ${p}`);
	}
	return lines.join("\n");
}

/** The whole check: reports plus the groups that fail. Used by build.ts and by cues.test.ts. */
export function checkCues(cases: readonly Case[]): {
	reports: GroupReport[];
	failed: GroupReport[];
} {
	const reports = analyzeAll(cases);
	return { reports, failed: reports.filter((r) => r.problems.length > 0) };
}
