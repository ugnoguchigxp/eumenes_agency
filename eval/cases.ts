/** Case loading for the P0-E experiment: `<dir>/<split>/*.json`, validated with caseSchema. */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { caseSchema, type Case } from "./contracts.ts";

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
