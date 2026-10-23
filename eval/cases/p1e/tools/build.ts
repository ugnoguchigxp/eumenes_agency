/**
 * Builds the static P1-E case JSON from the authoring sources in this directory.
 *   bun run eval/cases/p1e/tools/build.ts          # write eval/cases/p1e/{dev,unseen}/*.json
 *   bun run eval/cases/p1e/tools/build.ts --check  # fail if the files on disk differ (after oxfmt)
 * Run `bunx oxfmt eval/cases/p1e` afterwards (formatting is applied in a second step).
 */
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { join, resolve } from "node:path";
import { amplifyDev, amplifyUnseen } from "./amplify.ts";
import type { Case } from "../../../contracts.ts";
import { checkCues, formatReport } from "./cues.ts";
import { causalDev, causalUnseenA, causalUnseenB } from "./causal.ts";
import { concurrentDev, concurrentUnseen } from "./concurrent.ts";
import { dilutionDev, dilutionUnseen } from "./dilution.ts";
import { build, oppCounts, type CaseDef } from "./dsl.ts";
import { premiseDev, premiseUnseen } from "./premise.ts";
import { socialDev, socialUnseen } from "./social.ts";
import { transferDev, transferUnseen } from "./transfer.ts";

export const devDefs: CaseDef[] = [
	...causalDev,
	...transferDev,
	...premiseDev,
	...amplifyDev,
	...concurrentDev,
	...dilutionDev,
	...socialDev,
];
export const unseenDefs: CaseDef[] = [
	...causalUnseenA,
	...causalUnseenB,
	...transferUnseen,
	...premiseUnseen,
	...amplifyUnseen,
	...concurrentUnseen,
	...dilutionUnseen,
	...socialUnseen,
];

const root = resolve(import.meta.dir, "..");

/** Builds every case in memory: split -> id -> case. Throws on any DSL/schema error. */
function buildAll(): Record<"dev" | "unseen", Map<string, unknown>> {
	const out = {
		dev: new Map<string, unknown>(),
		unseen: new Map<string, unknown>(),
	};
	for (const [split, defs] of [
		["dev", devDefs],
		["unseen", unseenDefs],
	] as const) {
		for (const d of defs) {
			// Ids are unique across splits too: judge and agreement look a case up in both.
			if (out.dev.has(d.id) || out.unseen.has(d.id))
				throw new Error(`duplicate id ${d.id}`);
			if (d.split !== split) throw new Error(`${d.id}: split mismatch`);
			out[split].set(d.id, build(d));
		}
	}
	return out;
}

function writeAll(built: ReturnType<typeof buildAll>) {
	for (const split of ["dev", "unseen"] as const) {
		const dir = join(root, split);
		mkdirSync(dir, { recursive: true });
		for (const f of readdirSync(dir))
			if (f.endsWith(".json")) rmSync(join(dir, f));
		for (const [id, c] of built[split])
			writeFileSync(
				join(dir, `${id}.json`),
				`${JSON.stringify(c, null, "\t")}\n`,
			);
	}
}

/** Compares the in-memory build with the files on disk (parsed, so formatting is ignored). */
function checkAll(built: ReturnType<typeof buildAll>): string[] {
	const problems: string[] = [];
	for (const split of ["dev", "unseen"] as const) {
		const dir = join(root, split);
		const onDisk = existsSync(dir)
			? readdirSync(dir).filter((f) => f.endsWith(".json"))
			: [];
		const expected = new Set(
			[...built[split].keys()].map((id) => `${id}.json`),
		);
		for (const f of onDisk)
			if (!expected.has(f))
				problems.push(`${split}/${f}: not generated (stale file)`);
		for (const [id, c] of built[split]) {
			const file = join(dir, `${id}.json`);
			if (!existsSync(file)) {
				problems.push(`${split}/${id}.json: missing`);
				continue;
			}
			let disk: unknown;
			try {
				disk = JSON.parse(readFileSync(file, "utf8"));
			} catch {
				problems.push(`${split}/${id}.json: invalid JSON`);
				continue;
			}
			if (!isDeepStrictEqual(disk, JSON.parse(JSON.stringify(c))))
				problems.push(`${split}/${id}.json: differs from the generated case`);
		}
	}
	return problems;
}

/** Surface-cue balance check (review 2026-10-22 E3): prints the tables, returns false on failure. */
function cueCheck(built: ReturnType<typeof buildAll>): boolean {
	const cases = [...built.dev.values(), ...built.unseen.values()] as Case[];
	const { reports, failed: bad } = checkCues(cases);
	console.log(formatReport(reports));
	if (bad.length > 0)
		console.error(`cue check failed in: ${bad.map((r) => r.key).join(", ")}`);
	return bad.length === 0;
}

if (import.meta.main) {
	const built = buildAll();
	if (process.argv.includes("--check")) {
		const problems = checkAll(built);
		const cuesOk = cueCheck(built);
		if (!cuesOk) process.exit(1);
		if (problems.length > 0) {
			console.error(
				`p1e cases are out of date:\n${problems.map((p) => `  - ${p}`).join("\n")}`,
			);
			process.exit(1);
		}
		console.log(
			`p1e cases up to date (${built.dev.size + built.unseen.size} files)`,
		);
		process.exit(0);
	}
	writeAll(built);
	const tally: Record<
		string,
		{ cases: number; total: number; needed: number }
	> = {};
	for (const [split, defs] of [
		["dev", devDefs],
		["unseen", unseenDefs],
	] as const) {
		for (const d of defs) {
			const k = `${split}/${d.group}`;
			const c = oppCounts(build(d));
			const t = (tally[k] ??= { cases: 0, total: 0, needed: 0 });
			t.cases += 1;
			t.total += c.total;
			t.needed += c.needed;
		}
	}
	console.table(tally);
	const sum = (s: string) =>
		Object.entries(tally)
			.filter(([k]) => k.startsWith(s))
			.reduce(
				(x, [, v]) => ({
					cases: x.cases + v.cases,
					total: x.total + v.total,
					needed: x.needed + v.needed,
				}),
				{ cases: 0, total: 0, needed: 0 },
			);
	console.log("dev", sum("dev/"), "unseen", sum("unseen/"));
	if (!cueCheck(built)) process.exit(1);
}
