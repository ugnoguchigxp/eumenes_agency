/**
 * P0-E / P1-E evaluation CLI. `--suite p0e|p1e` (default p0e) picks the case set:
 * p0e cases are eval/cases/{dev,unseen}, p1e cases eval/cases/p1e/{dev,unseen}.
 *
 *   bun eval/main.ts validate [--suite p1e] [--split dev]
 *   bun eval/main.ts run --name <run> [--suite p1e] [--split dev] [--conditions B0,B1,B1a,B1h,B2,F,D] [--reps 3]
 *       [--group causal,...] [--case <id>] [--resume] [--budget-usd n] [--allow-unverified]
 *       (p0e default conditions: B0,B1,B2,F; p1e default: B1,B1a,B2,D.
 *        B1a = B1 with select called even when there are no notes (ablation of the
 *        host_no_candidates gate); B1h = B1a + social lull talk (hostTopics, the case's
 *        interests and topics); D = diagnostic, no stored state.
 *        p1e default groups: the six P1-E groups; the social group runs only when named,
 *        e.g. --group social --conditions B1a,B1h,D)
 *   bun eval/main.ts score --name <run>
 *   bun eval/main.ts trace --name <run> --case <id> [--condition B2] [--rep 1] [--prompt]
 *   bun eval/main.ts judge --name <run> [--limit N] [--budget-usd n] [--allow-unverified]   (content + state judge; spends money)
 *   bun eval/main.ts label-export --suite p1e --split dev --n 12 --out <file.md> [--seed s]
 *   bun eval/main.ts agreement --sheet <file.md> [--allow-unverified]
 *   bun eval/main.ts judge-export --name <run> --n 30 --out <file.md> [--seed s] [--allow-unverified]
 *   bun eval/main.ts judge-agreement --sheet <file.md> [--allow-unverified]
 *       (also writes results/<run>/judge-agreement.md with a parseable digest/n/kappa header)
 *
 * Case versions: records and label/judge keys carry a caseHash. --resume, judge,
 * judge-export, agreement and judge-agreement refuse a changed case, and refuse records
 * or keys without a hash unless --allow-unverified. `score` warns in the summary header.
 * `run` halts after 2 consecutive incomplete (infra) runs and after 3 consecutive runs in
 * which every call is an agent output failure (llm:*), both with exit code 3.
 *
 * Results: eval/results/<name>/{runs.jsonl, summary.md, judgments.jsonl, state-judgments.jsonl,
 * traces.jsonl}. runs.jsonl, summary.md and judgments.jsonl are tracked (.gitignore
 * exceptions); traces.jsonl (every model call + final state) and state-judgments.jsonl
 * are local unless an exception is added.
 * `run` and `judge` call real models and spend money; they stop at the spend limit, and
 * at --budget-usd (this command's own spend; the global meter is unchanged). `run` also
 * stops on any safety observation.
 */
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
	defaultCasesDir,
	allowUnverifiedHint,
	assertCaseVersions,
	caseVersionIssues,
	loadAllSuiteCases,
	loadSuiteCases,
	type Split,
} from "./cases.ts";
import {
	caseGroups,
	evalConditions,
	runRecordSchema,
	runtimeConditionOf,
	suites,
	type Case,
	type CaseGroup,
	type EvalCondition,
	type RunRecord,
	type Suite,
} from "./contracts.ts";
import { createDiagnosticRuntime, presentMap } from "./diagnostic.ts";
import { commandBudgetReached, withCommandBudget } from "./budget.ts";
import {
	appendJudgments,
	assertDigestCompatible,
	judgeDigest,
	judgeFingerprint,
	pendingJudgeTasks,
	readJudgments,
	runJudge,
} from "./judge.ts";
import {
	appendStateJudgments,
	pendingStateTasks,
	readStateJudgments,
	runStateJudge,
	stateDigest,
} from "./state-judge.ts";
import {
	buildJudgeSheet,
	buildLabelSheet,
	defaultSeed,
	formatJudgeAgreement,
	formatLabelAgreement,
	judgeAgreement,
	judgedActions,
	labelAgreement,
	parseJudgeSheet,
	parseLabelSheet,
	type JudgeKey,
	type LabelKey,
} from "./label.ts";
import { isSpendLimit, replayCase } from "./replay.ts";
import {
	agreementHeader,
	latestRecords,
	parseAgreementHeader,
	summarize,
} from "./score.ts";
import { createSelectProbe } from "./state-check.ts";
import { createTraceRecorder, traceCommand } from "./trace.ts";
import type { LlmPort } from "../src/contracts/ports.ts";

export const resultsRoot = resolve(import.meta.dir, "results");

export interface PlannedRun {
	readonly case: Case;
	readonly condition: EvalCondition;
	readonly rep: number;
}

export const runKey = (
	caseId: string,
	condition: string,
	rep: number,
): string => `${caseId}\u0000${condition}\u0000${rep}`;

const rotate = <T>(xs: readonly T[], by: number): T[] => {
	if (xs.length === 0) return [];
	const n = ((by % xs.length) + xs.length) % xs.length;
	return [...xs.slice(n), ...xs.slice(0, n)];
};

/**
 * Run order: per case, per rep, the conditions rotated so no condition always goes first.
 * B0 runs once (rep 1) regardless of reps.
 */
export function planRuns(
	cases: readonly Case[],
	selected: readonly EvalCondition[],
	reps: number,
): PlannedRun[] {
	const plan: PlannedRun[] = [];
	cases.forEach((c, caseIndex) => {
		for (let rep = 1; rep <= reps; rep++) {
			const applicable = selected.filter((cond) => cond !== "B0" || rep === 1);
			for (const condition of rotate(applicable, caseIndex + rep - 1)) {
				plan.push({ case: c, condition, rep });
			}
		}
	});
	return plan;
}

/** Drops runs already present in a previous runs.jsonl (for --resume). */
export function skipDone(
	plan: readonly PlannedRun[],
	done: ReadonlySet<string>,
): PlannedRun[] {
	return plan.filter((p) => !done.has(runKey(p.case.id, p.condition, p.rep)));
}

/** Keys of finished runs. Incomplete runs are re-run on --resume (latest record per key wins). */
export function doneKeys(records: RunRecord[]): Set<string> {
	return new Set(
		latestRecords(records)
			.filter((r) => !r.incomplete)
			.map((r) => runKey(r.caseId, r.condition, r.rep)),
	);
}

/** Resuming under different instructions or settings would mix incomparable runs. */
export function assertResumeCompatible(
	records: readonly RunRecord[],
	settingsDigest: string,
	instructionVersion: string,
): void {
	for (const r of records) {
		if (
			r.instructionVersion !== instructionVersion ||
			r.settingsDigest !== settingsDigest
		) {
			throw new Error(
				`cannot --resume: ${r.caseId}/${r.condition}/rep${r.rep} was recorded with instructionVersion=${r.instructionVersion} settingsDigest=${r.settingsDigest}, current is ${instructionVersion} / ${settingsDigest}. Use a new --name.`,
			);
		}
	}
}

/** Resuming against edited cases would mix records of two versions of a case. */
export function assertResumeCases(
	records: readonly RunRecord[],
	cases: readonly Case[],
	allowUnverified = false,
): void {
	assertCaseVersions(records, cases, "cannot --resume", allowUnverified);
}

export const maxConsecutiveIncomplete = 2;
export const maxConsecutiveOutputFailures = 3;

/**
 * A run whose every model call is an agent output failure (llm:* schema/parse/refusal/
 * max_tokens). It is scored as decided (never made incomplete), but repeating it only
 * spends money, so the run loop halts after maxConsecutiveOutputFailures in a row.
 */
export const allCallsOutputFailures = (record: RunRecord): boolean =>
	record.condition !== "B0" &&
	record.calls.length > 0 &&
	record.calls.every((c) => c.code.startsWith("llm:"));

/** Decides whether the run loop must stop after a record. exit: 2 safety, 3 limit/systematic. */
export function evaluateStop(
	record: RunRecord,
	consecutiveIncomplete: number,
	consecutiveOutputFailures = 0,
): {
	consecutive: number;
	outputFailures: number;
	stop: { code: number; message: string } | null;
} {
	const consecutive = record.incomplete ? consecutiveIncomplete + 1 : 0;
	const outputFailures = allCallsOutputFailures(record)
		? consecutiveOutputFailures + 1
		: 0;
	if (record.safety.length > 0) {
		return {
			consecutive,
			outputFailures,
			stop: {
				code: 2,
				message: `safety observation: ${record.safety.join(", ")}`,
			},
		};
	}
	if (
		record.calls.some((c) => isSpendLimit(c.code)) ||
		(record.error !== null && isSpendLimit(record.error))
	) {
		return {
			consecutive,
			outputFailures,
			stop: { code: 3, message: "spend limit reached" },
		};
	}
	if (consecutive >= maxConsecutiveIncomplete) {
		return {
			consecutive,
			outputFailures,
			stop: {
				code: 3,
				message: `${consecutive} consecutive incomplete runs (systematic failure, e.g. API/auth/network); fix the cause and use --resume`,
			},
		};
	}
	if (outputFailures >= maxConsecutiveOutputFailures) {
		return {
			consecutive,
			outputFailures,
			stop: {
				code: 3,
				message: `${outputFailures} consecutive runs in which every model call failed with an agent output failure (llm:schema/parse/refusal/max_tokens; scored as is, not an outage). Likely an instruction/schema problem: fix it and use --resume`,
			},
		};
	}
	return { consecutive, outputFailures, stop: null };
}

export function parseRunsJsonl(
	text: string,
	source = "runs.jsonl",
): RunRecord[] {
	const records: RunRecord[] = [];
	text.split("\n").forEach((line, i) => {
		if (line.trim() === "") return;
		let raw: unknown;
		try {
			raw = JSON.parse(line);
		} catch (error) {
			throw new Error(
				`${source}:${i + 1}: invalid JSON (${(error as Error).message})`,
			);
		}
		const parsed = runRecordSchema.safeParse(raw);
		if (!parsed.success) {
			const issues = parsed.error.issues
				.map((x) => `${x.path.join(".") || "(root)"}: ${x.message}`)
				.join("; ");
			throw new Error(`${source}:${i + 1}: ${issues}`);
		}
		records.push(parsed.data);
	});
	return records;
}

/** `--group a,b`: case groups to run; unknown names are an error. */
export const parseGroups = (value: string): CaseGroup[] => {
	const out: CaseGroup[] = [];
	for (const raw of value.split(",")) {
		const v = raw.trim();
		if (!(caseGroups as readonly string[]).includes(v))
			throw new Error(`unknown group: ${v}`);
		if (!out.includes(v as CaseGroup)) out.push(v as CaseGroup);
	}
	return out;
};

export const parseConditions = (value: string): EvalCondition[] => {
	const out: EvalCondition[] = [];
	for (const raw of value.split(",")) {
		const v = raw.trim();
		if (!(evalConditions as readonly string[]).includes(v)) {
			throw new Error(`unknown condition: ${v}`);
		}
		const cond = v as EvalCondition;
		if (!out.includes(cond)) out.push(cond);
	}
	return out;
};

const parseSplit = (value: string): Split => {
	if (value !== "dev" && value !== "unseen") {
		throw new Error(`--split must be dev or unseen, got ${value}`);
	}
	return value;
};

export const parseSuite = (value: string): Suite => {
	if (!(suites as readonly string[]).includes(value)) {
		throw new Error(`--suite must be p0e or p1e, got ${value}`);
	}
	return value as Suite;
};

/**
 * P1-E default: the conditions the spec compares (F is out), the B1a ablation (B1 with
 * select called even without notes) and the D diagnostic.
 */
export const defaultConditions = (
	suite: Suite,
	groups?: readonly CaseGroup[],
): string =>
	suite !== "p1e"
		? "B0,B1,B2,F"
		: groups !== undefined &&
			  groups.length > 0 &&
			  groups.every((g) => p1eExtraGroups.includes(g))
			? // social lull: B1/B2 never see topics or interests
				"B1a,B1h,D"
			: "B1,B1a,B2,D";

const runName = (value: string | undefined): string => {
	if (!value || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(value)) {
		throw new Error(
			"--name is required and must match [A-Za-z0-9][A-Za-z0-9_.-]*",
		);
	}
	return value;
};

const p1eGroups: readonly CaseGroup[] = [
	"causal",
	"transfer",
	"premise",
	"amplify",
	"concurrent",
	"dilution",
];
/** P1-E case groups that a run includes only when named with --group. */
const p1eExtraGroups: readonly CaseGroup[] = ["social"];
/** Groups a run includes by default. */
export const groupsOf = (suite: Suite): readonly CaseGroup[] =>
	suite === "p1e"
		? p1eGroups
		: caseGroups.filter(
				(g) => !p1eGroups.includes(g) && !p1eExtraGroups.includes(g),
			);

export function validateCommand(
	split: Split,
	root: string = defaultCasesDir,
	suite: Suite = "p0e",
): string {
	const cases = loadSuiteCases(suite, split, root);
	const out: string[] = [
		`${suite === "p0e" ? "" : `${suite} `}${split}: ${cases.length} cases`,
	];
	for (const g of suite === "p1e"
		? [...p1eGroups, ...p1eExtraGroups]
		: groupsOf(suite)) {
		const inGroup = cases.filter((c) => c.group === g);
		const opps = inGroup.reduce(
			(n, c) => n + c.steps.filter((s) => s.type === "opportunity").length,
			0,
		);
		const draft = inGroup.filter((c) => c.labelStatus === "draft").length;
		out.push(
			`  ${g.padEnd(10)} cases=${inGroup.length} opportunities=${opps} draft=${draft} confirmed=${inGroup.length - draft}`,
		);
	}
	const draftAll = cases.filter((c) => c.labelStatus === "draft").length;
	out.push(`  labels: draft=${draftAll} confirmed=${cases.length - draftAll}`);
	if (suite === "p1e") {
		const opps = cases.flatMap((c) =>
			c.steps.flatMap((s) => (s.type === "opportunity" ? [s] : [])),
		);
		out.push(
			`  p1e: opportunities=${opps.length} withExpect=${opps.filter((o) => o.expect !== null).length} withStateExpect=${opps.filter((o) => o.stateExpect !== null).length} withPresent=${opps.filter((o) => o.present.length > 0).length} withJudge=${opps.filter((o) => o.judge.length > 0).length}`,
		);
	}
	return out.join("\n");
}

/** Written by judge-agreement next to the run (header line: digest, n, kappa). */
export const judgeAgreementFile = "judge-agreement.md";

/**
 * Warning lines for the summary header: records without a caseHash, and records whose case
 * changed (or no longer exists) since they were made. Never throws.
 */
export function caseVersionWarnings(
	records: readonly RunRecord[],
	casesRoot?: string,
): string[] {
	const latest = latestRecords([...records]);
	const out: string[] = [];
	const unhashed = latest.filter((r) => r.caseHash === undefined).length;
	if (unhashed > 0)
		out.push(
			`${unhashed} 件の記録に caseHash がない（ケースの版を検証できない）`,
		);
	for (const suite of unique(latest.map((r) => r.suite))) {
		const mine = latest.filter((r) => r.suite === suite);
		let cases: Case[];
		try {
			cases = loadAllSuiteCases(suite, casesRoot);
		} catch (error) {
			out.push(
				`${suite} のケースを読み込めず版を検証できない: ${(error as Error).message.split("\n").slice(0, 2).join(" ")}`,
			);
			continue;
		}
		const { issues } = caseVersionIssues(mine, cases);
		if (issues.length > 0)
			out.push(
				`記録後にケースが変更されている: ${issues.map((i) => i.caseId).join(", ")}（記録時と現行のケースが違う）`,
			);
		const known = new Set(cases.map((c) => c.id));
		const gone = unique(
			mine.map((r) => r.caseId).filter((id) => !known.has(id)),
		);
		if (gone.length > 0)
			out.push(`現行のケースにない id の記録: ${gone.join(", ")}`);
	}
	return out;
}

const unique = <T>(xs: T[]): T[] => [...new Set(xs)];

export function scoreCommand(
	name: string,
	root = resultsRoot,
	suite?: Suite,
	casesRoot?: string,
): string {
	const file = join(root, name, "runs.jsonl");
	if (!existsSync(file)) throw new Error(`not found: ${file}`);
	const records = parseRunsJsonl(readFileSync(file, "utf8"), file);
	if (suite !== undefined) {
		const other = records.find((r) => r.suite !== suite);
		if (other)
			throw new Error(
				`--suite ${suite} but ${file} has records of suite ${other.suite}`,
			);
	}
	const out = join(root, name, "summary.md");
	const agreementPath = join(root, name, judgeAgreementFile);
	writeFileSync(
		out,
		summarize(
			records,
			readJudgments(join(root, name, "judgments.jsonl")),
			readStateJudgments(join(root, name, "state-judgments.jsonl")),
			{
				judgeAgreement: existsSync(agreementPath)
					? parseAgreementHeader(readFileSync(agreementPath, "utf8"))
					: null,
				caseWarnings: caseVersionWarnings(records, casesRoot),
			},
		),
	);
	return out;
}

const readRecords = (root: string, name: string): RunRecord[] => {
	const file = join(root, name, "runs.jsonl");
	if (!existsSync(file)) throw new Error(`not found: ${file}`);
	return parseRunsJsonl(readFileSync(file, "utf8"), file);
};

const suiteOfRecords = (records: readonly RunRecord[]): Suite => {
	const found = new Set(records.map((r) => r.suite));
	if (found.size !== 1)
		throw new Error(
			`runs.jsonl must hold exactly one suite, found: ${[...found].join(",") || "none"}`,
		);
	return [...found][0] as Suite;
};

/**
 * Judge pass of a run: the content judge (outward actions vs `judge` criteria, one call per
 * action) and the state judge (mustNotHold matters vs open items, one call per checked
 * opportunity), both resume-safe. `--limit` counts calls over both passes.
 */
export async function judgeCommand(
	name: string,
	options: {
		llm: LlmPort;
		role: { model: string; effort: string };
		limit?: number;
		root?: string;
		casesRoot?: string;
		allowUnverified?: boolean;
	},
): Promise<string> {
	const root = options.root ?? resultsRoot;
	const records = readRecords(root, name);
	const suite = suiteOfRecords(records);
	const cases = loadAllSuiteCases(suite, options.casesRoot);
	const { unverified } = assertCaseVersions(
		records,
		cases,
		`cannot judge ${name}`,
		options.allowUnverified ?? false,
	);
	const file = join(root, name, "judgments.jsonl");
	const stateFile = join(root, name, "state-judgments.jsonl");
	const existing = readJudgments(file);
	const existingState = readStateJudgments(stateFile);
	const digest = judgeDigest(options.role, judgeFingerprint());
	const sDigest = stateDigest(options.role);
	assertDigestCompatible(existing, digest, file);
	assertDigestCompatible(existingState, sDigest, stateFile);
	const tasks = pendingJudgeTasks(records, cases, existing);
	const stateTasks = pendingStateTasks(records, cases, existingState);
	const content = await runJudge({
		tasks,
		llm: options.llm,
		digest,
		append: appendJudgments(file),
		...(options.limit === undefined ? {} : { limit: options.limit }),
	});
	const lines = [
		...(unverified > 0
			? [
					`note: --allow-unverified: ${unverified} records have no caseHash (made before hashing); their case version is not verified.`,
				]
			: []),
		`judge ${name}: content ${tasks.length} pending actions, judged ${content.judged} (${content.rows} criteria), failed ${content.failed}, remaining ${content.remaining}${content.stoppedBy ? `, stopped: ${content.stoppedBy}` : ""}`,
		...content.messages.map((m) => `  ${m}`),
	];
	const halted =
		content.stoppedBy === "spend_limit" || content.stoppedBy === "failures";
	const left =
		options.limit === undefined ? undefined : options.limit - content.judged;
	if (halted || (left !== undefined && left <= 0)) {
		lines.push(
			`state: ${stateTasks.length} pending opportunities, not run (${halted ? "content pass stopped" : "limit reached"})`,
		);
		return lines.join("\n");
	}
	const state = await runStateJudge({
		tasks: stateTasks,
		llm: options.llm,
		digest: sDigest,
		append: appendStateJudgments(stateFile),
		...(left === undefined ? {} : { limit: left }),
	});
	lines.push(
		`state: ${stateTasks.length} pending opportunities, judged ${state.judged} (${state.rows} matters), failed ${state.failed}, remaining ${state.remaining}${state.stoppedBy ? `, stopped: ${state.stoppedBy}` : ""}`,
		...state.messages.map((m) => `  ${m}`),
	);
	return lines.join("\n");
}

const keyPath = (sheet: string): string => `${sheet}.key.json`;

export function labelExportCommand(options: {
	suite: Suite;
	split: Split;
	n: number;
	out: string;
	seed?: string;
	casesRoot?: string;
}): string {
	// The default groups only: groups run on request (social) are not in the labeling pool.
	const groups = groupsOf(options.suite);
	const cases = loadSuiteCases(
		options.suite,
		options.split,
		options.casesRoot,
	).filter((c) => groups.includes(c.group));
	const { sheet, key } = buildLabelSheet(
		options.suite,
		options.split,
		cases,
		options.n,
		options.seed ?? defaultSeed,
	);
	writeFileSync(options.out, sheet);
	writeFileSync(keyPath(options.out), `${JSON.stringify(key, null, "\t")}\n`);
	return `wrote ${options.out} (${key.items.length} items) and ${keyPath(options.out)} (do not open the key before answering)`;
}

export function agreementCommand(
	sheet: string,
	casesRoot?: string,
	allowUnverified = false,
): string {
	const key = JSON.parse(readFileSync(keyPath(sheet), "utf8")) as LabelKey;
	if (key.kind !== "label")
		throw new Error(`${keyPath(sheet)} is not a label key`);
	const cases = loadSuiteCases(key.suite, key.split, casesRoot);
	return formatLabelAgreement(
		labelAgreement(
			parseLabelSheet(readFileSync(sheet, "utf8")),
			key,
			cases,
			allowUnverified,
		),
	);
}

export function judgeExportCommand(options: {
	name: string;
	n: number;
	out: string;
	seed?: string;
	root?: string;
	casesRoot?: string;
	allowUnverified?: boolean;
}): string {
	const root = options.root ?? resultsRoot;
	const records = readRecords(root, options.name);
	const cases = loadAllSuiteCases(suiteOfRecords(records), options.casesRoot);
	assertCaseVersions(
		records,
		cases,
		`cannot export judge sheet of ${options.name}`,
		options.allowUnverified ?? false,
	);
	const judgments = readJudgments(join(root, options.name, "judgments.jsonl"));
	const actions = judgedActions(latestRecords(records), cases, judgments);
	if (actions.length === 0)
		throw new Error(`no judged actions in ${options.name}; run judge first`);
	const { sheet, key } = buildJudgeSheet(
		options.name,
		actions,
		options.n,
		options.seed ?? defaultSeed,
	);
	writeFileSync(options.out, sheet);
	writeFileSync(keyPath(options.out), `${JSON.stringify(key, null, "\t")}\n`);
	return `wrote ${options.out} (${key.items.length} items) and ${keyPath(options.out)} (holds the judge verdicts; do not open it before answering)`;
}

export function judgeAgreementCommand(
	sheet: string,
	options: {
		root?: string;
		casesRoot?: string;
		allowUnverified?: boolean;
	} = {},
): string {
	const root = options.root ?? resultsRoot;
	const key = JSON.parse(readFileSync(keyPath(sheet), "utf8")) as JudgeKey;
	if (key.kind !== "judge")
		throw new Error(`${keyPath(sheet)} is not a judge key`);
	if (key.caseHashes !== undefined) {
		const cases = loadAllSuiteCases(key.suite ?? "p1e", options.casesRoot);
		assertCaseVersions(
			Object.entries(key.caseHashes).map(([caseId, hash]) => ({
				caseId,
				caseHash: hash,
			})),
			cases,
			"cannot compute judge agreement",
		);
	} else if (!options.allowUnverified) {
		throw new Error(
			`cannot compute judge agreement: the key has no caseHashes, so the case versions cannot be verified; ${allowUnverifiedHint}.`,
		);
	}
	const result = judgeAgreement(
		parseJudgeSheet(readFileSync(sheet, "utf8")),
		key,
	);
	const text = formatJudgeAgreement(result);
	const dir = join(root, key.run);
	if (existsSync(dir)) {
		writeFileSync(
			join(dir, judgeAgreementFile),
			`${agreementHeader({ digest: key.judgeDigest ?? "", n: result.compared, kappa: result.kappa })}\n# 判定器と利用者の一致（${key.run}）\n\n${text}\n`,
		);
	}
	return text;
}

async function runCommand(values: {
	name: string;
	suite: Suite;
	split: Split;
	conditions: EvalCondition[];
	groups: readonly CaseGroup[];
	reps: number;
	caseId: string | undefined;
	resume: boolean;
	budgetUsd: number | undefined;
	allowUnverified: boolean;
}): Promise<number> {
	const dir = join(resultsRoot, values.name);
	const file = join(dir, "runs.jsonl");
	let existing: RunRecord[] = [];
	if (existsSync(file)) {
		if (!values.resume) {
			throw new Error(
				`${file} exists; use --resume to continue or pick another --name`,
			);
		}
		existing = parseRunsJsonl(readFileSync(file, "utf8"), file);
	}
	const done = doneKeys(existing);
	let cases = loadSuiteCases(values.suite, values.split);
	assertResumeCases(existing, cases, values.allowUnverified);
	// --resume without the run's --group would plan other groups into this run.
	const outside = [
		...new Set(
			existing.map((r) => r.group).filter((g) => !values.groups.includes(g)),
		),
	];
	if (outside.length > 0)
		throw new Error(
			`${file} has records of group(s) ${outside.join(", ")} that are not selected; pass --group ${[...new Set(existing.map((r) => r.group))].join(",")}`,
		);
	cases = cases.filter((c) => values.groups.includes(c.group));
	if (values.caseId) cases = cases.filter((c) => c.id === values.caseId);
	if (cases.length === 0) throw new Error("no cases selected");
	const plan = skipDone(planRuns(cases, values.conditions, values.reps), done);
	console.log(`${plan.length} runs planned (${done.size} already done)`);
	if (plan.length === 0) return 0;

	const { loadSettings, settingsDigest, openSpendMeter, resolveBudget } =
		await import("../standalone/settings.ts");
	const { createClaudeLlm } = await import("../standalone/claude.ts");
	const { createAgencyRuntime, INSTRUCTION_VERSION } =
		await import("../src/index.ts");

	const settings = loadSettings();
	const meter = openSpendMeter(settings);
	const llm = createClaudeLlm(settings.llm.background, meter);
	const digest = settingsDigest(settings);
	const budget = resolveBudget(settings);
	assertResumeCompatible(existing, digest, INSTRUCTION_VERSION);
	mkdirSync(dir, { recursive: true });
	const startSpent = meter.spentUsd();
	const capped =
		values.budgetUsd === undefined
			? llm
			: withCommandBudget(llm, () => meter.spentUsd(), values.budgetUsd);
	const recorder = createTraceRecorder(
		capped,
		join(dir, "traces.jsonl"),
		values.name,
	);
	// Reads the state at select time for the P1-E state check.
	const probe = createSelectProbe();
	const probed = probe.wrap(recorder.llm);

	let n = 0;
	let consecutiveIncomplete = 0;
	let consecutiveOutputFailures = 0;
	for (const p of plan) {
		n++;
		try {
			meter.assertWithinLimit();
		} catch (error) {
			console.log(`stop: ${(error as Error).message}`);
			return 3;
		}
		if (
			values.budgetUsd !== undefined &&
			commandBudgetReached(() => meter.spentUsd(), startSpent, values.budgetUsd)
		) {
			console.log(
				`stop: --budget-usd ${values.budgetUsd} reached; use --resume to continue`,
			);
			return 3;
		}
		recorder.begin({
			caseId: p.case.id,
			condition: p.condition,
			rep: p.rep,
		});
		const condition = p.condition;
		const runtimeCondition = runtimeConditionOf(condition);
		const record = await replayCase(
			p.case,
			condition,
			p.rep,
			(tools) =>
				condition === "D"
					? createDiagnosticRuntime({
							llm: probed,
							tools,
							present: presentMap(p.case),
							budget,
						})
					: createAgencyRuntime({
							condition: runtimeCondition ?? "B1",
							llm: probed,
							tools,
							budget,
							// B1a: B1 without the host_no_candidates gate (ablation).
							// B1h: B1a + social lull talk from the case's interests and topics.
							...(condition === "B1a" || condition === "B1h"
								? { selectWhenEmpty: true }
								: {}),
							...(condition === "B1h"
								? {
										hostTopics: true,
										hostTodos: true,
										standingInterests: p.case.interests ?? [],
									}
								: {}),
						}),
			{
				runName: values.name,
				settingsDigest: digest,
				instructionVersion: INSTRUCTION_VERSION,
				spent: () => meter.spentUsd(),
				batchSize: budget.batchSize,
				onFinal: (state) => recorder.final(state),
				probe,
			},
		);
		appendFileSync(file, `${JSON.stringify(record)}\n`);
		console.log(
			`[${n}/${plan.length}] ${p.case.id} ${p.condition} rep${p.rep} usd=${record.usd.toFixed(4)} total=${meter.spentUsd().toFixed(4)} opps=${record.opportunities.length} calls=${record.calls.length}${record.incomplete ? " INCOMPLETE" : ""}${record.error ? ` error=${record.error}` : ""}`,
		);
		const verdict = evaluateStop(
			record,
			consecutiveIncomplete,
			consecutiveOutputFailures,
		);
		consecutiveIncomplete = verdict.consecutive;
		consecutiveOutputFailures = verdict.outputFailures;
		if (verdict.stop) {
			console.log(`STOP: ${verdict.stop.message}`);
			return verdict.stop.code;
		}
	}
	return 0;
}

const positiveInt = (value: string | undefined, flag: string): number => {
	const n = Number(value);
	if (!Number.isInteger(n) || n < 1)
		throw new Error(`${flag} must be an integer >= 1`);
	return n;
};

const parseBudget = (value: string | undefined): number | undefined => {
	if (value === undefined) return undefined;
	const n = Number(value);
	if (!Number.isFinite(n) || n <= 0)
		throw new Error("--budget-usd must be a positive number");
	return n;
};

const required = (value: string | undefined, flag: string): string => {
	if (!value) throw new Error(`${flag} is required`);
	return value;
};

export async function main(argv: string[]): Promise<number> {
	const { values, positionals } = parseArgs({
		args: argv,
		allowPositionals: true,
		options: {
			name: { type: "string" },
			suite: { type: "string" },
			split: { type: "string", default: "dev" },
			conditions: { type: "string" },
			reps: { type: "string", default: "3" },
			case: { type: "string" },
			group: { type: "string" },
			resume: { type: "boolean", default: false },
			condition: { type: "string" },
			rep: { type: "string" },
			prompt: { type: "boolean", default: false },
			limit: { type: "string" },
			n: { type: "string" },
			out: { type: "string" },
			sheet: { type: "string" },
			seed: { type: "string" },
			"budget-usd": { type: "string" },
			"allow-unverified": { type: "boolean", default: false },
		},
	});
	const command = positionals[0];
	const suite = parseSuite(values.suite ?? "p0e");
	if (command === "validate") {
		console.log(
			validateCommand(parseSplit(values.split), defaultCasesDir, suite),
		);
		return 0;
	}
	if (command === "score") {
		console.log(
			scoreCommand(
				runName(values.name),
				resultsRoot,
				values.suite === undefined ? undefined : suite,
			),
		);
		return 0;
	}
	if (command === "label-export") {
		console.log(
			labelExportCommand({
				suite,
				split: parseSplit(values.split),
				n: positiveInt(values.n, "--n"),
				out: required(values.out, "--out"),
				...(values.seed === undefined ? {} : { seed: values.seed }),
			}),
		);
		return 0;
	}
	if (command === "agreement") {
		console.log(
			agreementCommand(
				required(values.sheet, "--sheet"),
				undefined,
				values["allow-unverified"],
			),
		);
		return 0;
	}
	if (command === "judge-export") {
		console.log(
			judgeExportCommand({
				name: runName(values.name),
				n: positiveInt(values.n, "--n"),
				out: required(values.out, "--out"),
				...(values.seed === undefined ? {} : { seed: values.seed }),
				allowUnverified: values["allow-unverified"],
			}),
		);
		return 0;
	}
	if (command === "judge-agreement") {
		console.log(
			judgeAgreementCommand(required(values.sheet, "--sheet"), {
				allowUnverified: values["allow-unverified"],
			}),
		);
		return 0;
	}
	if (command === "judge") {
		const name = runName(values.name);
		const limit =
			values.limit === undefined
				? undefined
				: positiveInt(values.limit, "--limit");
		const { loadSettings, judgeRole, openSpendMeter } =
			await import("../standalone/settings.ts");
		const { createClaudeLlm } = await import("../standalone/claude.ts");
		const settings = loadSettings();
		const meter = openSpendMeter(settings);
		const role = judgeRole(settings);
		const budgetUsd = parseBudget(values["budget-usd"]);
		const base = createClaudeLlm(role, meter);
		const llm =
			budgetUsd === undefined
				? base
				: withCommandBudget(base, () => meter.spentUsd(), budgetUsd);
		console.log(
			await judgeCommand(name, {
				llm,
				role,
				...(limit === undefined ? {} : { limit }),
				allowUnverified: values["allow-unverified"],
			}),
		);
		return 0;
	}
	if (command === "trace") {
		if (!values.case) {
			throw new Error(
				"trace: --case <id> is required (usage: trace --name <run> --case <id> [--condition B2] [--rep 1] [--prompt])",
			);
		}
		const rep = values.rep === undefined ? undefined : Number(values.rep);
		if (rep !== undefined && (!Number.isInteger(rep) || rep < 1))
			throw new Error("--rep must be an integer >= 1");
		let condition: string | undefined;
		if (values.condition !== undefined) {
			const parsed = parseConditions(values.condition);
			if (parsed.length !== 1) throw new Error("--condition takes one value");
			condition = parsed[0];
		}
		console.log(
			traceCommand(
				join(resultsRoot, runName(values.name), "traces.jsonl"),
				{ caseId: values.case, condition, rep },
				{ prompt: values.prompt },
			),
		);
		return 0;
	}
	if (command === "run") {
		const reps = Number(values.reps);
		if (!Number.isInteger(reps) || reps < 1)
			throw new Error("--reps must be an integer >= 1");
		return runCommand({
			name: runName(values.name),
			suite,
			split: parseSplit(values.split),
			conditions: parseConditions(
				values.conditions ??
					defaultConditions(
						suite,
						values.group === undefined ? undefined : parseGroups(values.group),
					),
			),
			groups:
				values.group === undefined
					? groupsOf(suite)
					: parseGroups(values.group),
			reps,
			caseId: values.case,
			resume: values.resume,
			budgetUsd: parseBudget(values["budget-usd"]),
			allowUnverified: values["allow-unverified"],
		});
	}
	console.error(
		"usage: bun eval/main.ts <validate|run|score|trace|judge|label-export|agreement|judge-export|judge-agreement> [options]",
	);
	return 1;
}

if (import.meta.main) {
	main(process.argv.slice(2)).then(
		(code) => process.exit(code),
		(error) => {
			console.error(error instanceof Error ? error.message : String(error));
			process.exit(1);
		},
	);
}
