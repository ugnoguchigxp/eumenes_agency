/** Case loading for the P0-E experiment: `<dir>/<split>/*.json`, validated with caseSchema. */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { caseSchema, type Case, type Suite } from "./contracts.ts";

export const defaultCasesDir = resolve(import.meta.dir, "cases");

export type Split = "dev" | "unseen";

export class CaseLoadError extends Error {
	constructor(readonly problems: readonly string[]) {
		super(`case load failed:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
		this.name = "CaseLoadError";
	}
}

export function loadCases(split: Split, dir: string = defaultCasesDir): Case[] {
	const splitDir = join(dir, split);
	if (!existsSync(splitDir)) {
		throw new CaseLoadError([`directory not found: ${splitDir}`]);
	}
	const files = readdirSync(splitDir)
		.filter((f) => f.endsWith(".json"))
		.sort();
	const problems: string[] = [];
	const cases: Case[] = [];
	const seen = new Map<string, string>();
	for (const file of files) {
		let raw: unknown;
		try {
			raw = JSON.parse(readFileSync(join(splitDir, file), "utf8"));
		} catch (error) {
			problems.push(`${file}: invalid JSON (${(error as Error).message})`);
			continue;
		}
		const parsed = caseSchema.safeParse(raw);
		if (!parsed.success) {
			for (const issue of parsed.error.issues) {
				problems.push(
					`${file}: ${issue.path.join(".") || "(root)"}: ${issue.message}`,
				);
			}
			continue;
		}
		const c = parsed.data;
		if (c.split !== split) {
			problems.push(
				`${file}: split is "${c.split}" but the file is under "${split}"`,
			);
		}
		const prior = seen.get(c.id);
		if (prior) {
			problems.push(`${file}: duplicate case id ${c.id} (also in ${prior})`);
			continue;
		}
		seen.set(c.id, file);
		cases.push(c);
	}
	if (problems.length > 0) throw new CaseLoadError(problems);
	return cases;
}

/** p0e cases live directly under `cases/<split>`, p1e under `cases/p1e/<split>`. */
export const suiteDir = (
	suite: Suite,
	root: string = defaultCasesDir,
): string => (suite === "p0e" ? root : join(root, suite));

/** Loads one suite/split and checks every case declares that suite. */
export function loadSuiteCases(
	suite: Suite,
	split: Split,
	root: string = defaultCasesDir,
): Case[] {
	const cases = loadCases(split, suiteDir(suite, root));
	const wrong = cases.filter((c) => c.suite !== suite);
	if (wrong.length > 0) {
		throw new CaseLoadError(
			wrong.map((c) => `${c.id}: suite is "${c.suite}" but is under ${suite}`),
		);
	}
	return cases;
}

/** Every case of the suite found under either split (a missing split directory counts as empty). */
export function loadAllSuiteCases(
	suite: Suite,
	root: string = defaultCasesDir,
): Case[] {
	const out: Case[] = [];
	for (const split of ["dev", "unseen"] as const) {
		if (!existsSync(join(suiteDir(suite, root), split))) continue;
		out.push(...loadSuiteCases(suite, split, root));
	}
	return out;
}

/** JSON with object keys sorted at every level, so equal content gives equal text. */
export function stableJson(value: unknown): string {
	const sort = (v: unknown): unknown => {
		if (Array.isArray(v)) return v.map(sort);
		if (v !== null && typeof v === "object")
			return Object.fromEntries(
				Object.entries(v as Record<string, unknown>)
					.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
					.map(([k, x]) => [k, sort(x)]),
			);
		return v;
	};
	return JSON.stringify(sort(value));
}

/**
 * Content hash of a case (stable JSON of the parsed case file; schema defaults are
 * filled in, so adding an explicit default does not change it). Recorded in every
 * run record and label/judge key: any edit to the case changes it. `labelStatus` is
 * left out: confirming labels must not invalidate runs (the label content itself, e.g.
 * `expect`, still counts).
 */
export const caseHash = (c: Case): string =>
	createHash("sha256")
		.update(
			stableJson(
				Object.fromEntries(
					Object.entries(c).filter(([k]) => k !== "labelStatus"),
				),
			),
		)
		.digest("hex")
		.slice(0, 16);

/** A record or key made against another version of the case than the current one. */
export interface CaseVersionIssue {
	readonly caseId: string;
	readonly recorded: string;
	readonly current: string;
}

/**
 * Cases whose recorded hash differs from the current case. Records without a hash
 * (made before hashing) cannot be verified: they are counted in `unverified`, not
 * reported as mismatches. Records of unknown cases are ignored.
 */
export function caseVersionIssues(
	recorded: readonly {
		readonly caseId: string;
		readonly caseHash?: string | undefined;
	}[],
	cases: readonly Case[],
): { issues: CaseVersionIssue[]; unverified: number } {
	const current = new Map(cases.map((c) => [c.id, caseHash(c)]));
	const issues = new Map<string, CaseVersionIssue>();
	let unverified = 0;
	for (const r of recorded) {
		const now = current.get(r.caseId);
		if (now === undefined) continue;
		if (r.caseHash === undefined) unverified++;
		else if (r.caseHash !== now && !issues.has(r.caseId))
			issues.set(r.caseId, {
				caseId: r.caseId,
				recorded: r.caseHash,
				current: now,
			});
	}
	return { issues: [...issues.values()], unverified };
}

/** Wording shared by the refusals so the way out is always named. */
export const allowUnverifiedHint =
	"pass --allow-unverified to accept records/keys made before case hashing";

/**
 * Throws when any recorded case hash differs from the current case, and when a record or
 * key has no hash at all (its case version cannot be verified) unless `allowUnverified`
 * (the --allow-unverified flag). `what` names the command for the message.
 */
export function assertCaseVersions(
	recorded: readonly {
		readonly caseId: string;
		readonly caseHash?: string | undefined;
	}[],
	cases: readonly Case[],
	what: string,
	allowUnverified = false,
): { unverified: number } {
	const { issues, unverified } = caseVersionIssues(recorded, cases);
	if (issues.length > 0)
		throw new Error(
			`${what}: the case file changed since it was recorded (${issues.map((i) => `${i.caseId} ${i.recorded} -> ${i.current}`).join(", ")}). Use a new --name / re-export the sheet.`,
		);
	if (unverified > 0 && !allowUnverified)
		throw new Error(
			`${what}: ${unverified} record(s)/key entries have no caseHash, so their case version cannot be verified; ${allowUnverifiedHint}.`,
		);
	return { unverified };
}
