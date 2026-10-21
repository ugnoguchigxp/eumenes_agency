/**
 * P0-E evaluation CLI.
 *
 *   bun eval/main.ts validate [--split dev]
 *   bun eval/main.ts run --name <run> [--split dev] [--conditions B0,B1,B2,F] [--reps 3]
 *       [--case <id>] [--resume]
 *   bun eval/main.ts score --name <run>
 *   bun eval/main.ts trace --name <run> --case <id> [--condition B2] [--rep 1] [--prompt]
 *
 * Results: eval/results/<name>/{runs.jsonl, summary.md, traces.jsonl}.
 * traces.jsonl (every model call + final state) is local only, not tracked.
 * `run` calls the real model and spends money; it stops at the spend limit or on
 * any safety observation.
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
import { loadCases, type Split } from "./cases.ts";
import {
	caseGroups,
	runRecordSchema,
	type Case,
	type RunRecord,
} from "./contracts.ts";
import { isSpendLimit, replayCase } from "./replay.ts";
import { latestRecords, summarize } from "./score.ts";
import { createTraceRecorder, traceCommand } from "./trace.ts";
import { conditions, type Condition } from "../src/contracts/model.ts";

export const resultsRoot = resolve(import.meta.dir, "results");

export interface PlannedRun {
	readonly case: Case;
	readonly condition: Condition;
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
	selected: readonly Condition[],
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

export const maxConsecutiveIncomplete = 2;

/** Decides whether the run loop must stop after a record. exit: 2 safety, 3 limit/systematic. */
export function evaluateStop(
	record: RunRecord,
	consecutiveIncomplete: number,
): { consecutive: number; stop: { code: number; message: string } | null } {
	const consecutive = record.incomplete ? consecutiveIncomplete + 1 : 0;
	if (record.safety.length > 0) {
		return {
			consecutive,
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
		return { consecutive, stop: { code: 3, message: "spend limit reached" } };
	}
	if (consecutive >= maxConsecutiveIncomplete) {
		return {
			consecutive,
			stop: {
				code: 3,
				message: `${consecutive} consecutive incomplete runs (systematic failure, e.g. API/auth/network); fix the cause and use --resume`,
			},
		};
	}
	return { consecutive, stop: null };
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

export const parseConditions = (value: string): Condition[] => {
	const out: Condition[] = [];
	for (const raw of value.split(",")) {
		const v = raw.trim();
		if (!(conditions as readonly string[]).includes(v)) {
			throw new Error(`unknown condition: ${v}`);
		}
		const cond = v as Condition;
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

const runName = (value: string | undefined): string => {
	if (!value || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(value)) {
		throw new Error(
			"--name is required and must match [A-Za-z0-9][A-Za-z0-9_.-]*",
		);
	}
	return value;
};

export function validateCommand(split: Split, dir?: string): string {
	const cases = dir ? loadCases(split, dir) : loadCases(split);
	const out: string[] = [`${split}: ${cases.length} cases`];
	for (const g of caseGroups) {
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
	return out.join("\n");
}

export function scoreCommand(name: string, root = resultsRoot): string {
	const file = join(root, name, "runs.jsonl");
	if (!existsSync(file)) throw new Error(`not found: ${file}`);
	const records = parseRunsJsonl(readFileSync(file, "utf8"), file);
	const out = join(root, name, "summary.md");
	writeFileSync(out, summarize(records));
	return out;
}

async function runCommand(values: {
	name: string;
	split: Split;
	conditions: Condition[];
	reps: number;
	caseId: string | undefined;
	resume: boolean;
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
	let cases = loadCases(values.split);
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
	const recorder = createTraceRecorder(
		llm,
		join(dir, "traces.jsonl"),
		values.name,
	);

	let n = 0;
	let consecutiveIncomplete = 0;
	for (const p of plan) {
		n++;
		try {
			meter.assertWithinLimit();
		} catch (error) {
			console.log(`stop: ${(error as Error).message}`);
			return 3;
		}
		recorder.begin({
			caseId: p.case.id,
			condition: p.condition,
			rep: p.rep,
		});
		const record = await replayCase(
			p.case,
			p.condition,
			p.rep,
			(tools) =>
				createAgencyRuntime({
					condition: p.condition,
					llm: recorder.llm,
					tools,
					budget,
				}),
			{
				runName: values.name,
				settingsDigest: digest,
				instructionVersion: INSTRUCTION_VERSION,
				spent: () => meter.spentUsd(),
				batchSize: budget.batchSize,
				onFinal: (state) => recorder.final(state),
			},
		);
		appendFileSync(file, `${JSON.stringify(record)}\n`);
		console.log(
			`[${n}/${plan.length}] ${p.case.id} ${p.condition} rep${p.rep} usd=${record.usd.toFixed(4)} total=${meter.spentUsd().toFixed(4)} opps=${record.opportunities.length} calls=${record.calls.length}${record.incomplete ? " INCOMPLETE" : ""}${record.error ? ` error=${record.error}` : ""}`,
		);
		const verdict = evaluateStop(record, consecutiveIncomplete);
		consecutiveIncomplete = verdict.consecutive;
		if (verdict.stop) {
			console.log(`STOP: ${verdict.stop.message}`);
			return verdict.stop.code;
		}
	}
	return 0;
}

export async function main(argv: string[]): Promise<number> {
	const { values, positionals } = parseArgs({
		args: argv,
		allowPositionals: true,
		options: {
			name: { type: "string" },
			split: { type: "string", default: "dev" },
			conditions: { type: "string", default: "B0,B1,B2,F" },
			reps: { type: "string", default: "3" },
			case: { type: "string" },
			resume: { type: "boolean", default: false },
			condition: { type: "string" },
			rep: { type: "string" },
			prompt: { type: "boolean", default: false },
		},
	});
	const command = positionals[0];
	if (command === "validate") {
		console.log(validateCommand(parseSplit(values.split)));
		return 0;
	}
	if (command === "score") {
		console.log(scoreCommand(runName(values.name)));
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
			split: parseSplit(values.split),
			conditions: parseConditions(values.conditions),
			reps,
			caseId: values.case,
			resume: values.resume,
		});
	}
	console.error("usage: bun eval/main.ts <validate|run|score|trace> [options]");
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
