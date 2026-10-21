import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { checkSource } from "../../scripts/check-boundaries.ts";

const root = resolve("/repo/src");
const check = (rel: string, text: string) =>
	checkSource(root, resolve(root, rel), text);

describe("checkSource", () => {
	test("accepts host-neutral code and allowed Math members", () => {
		expect(
			check(
				"domains/a/x.ts",
				`import { z } from "zod";
import { t } from "../../contracts/index.ts";
export const f = (n: number, o: { Date: number }) => Math.max(Math.round(n), o.Date);
export const g = { Date: 1, Math: 2 };`,
			),
		).toEqual([]);
	});

	test("reports banned ambient identifiers with line numbers", () => {
		const errors = check(
			"a.ts",
			`const a = Date.now();
const b = Math.random();
const c = performance.now();
setTimeout(() => {}, 1);
const d = globalThis;
await fetch("x");
process.exit(1);
Bun.file("x");`,
		);
		expect(errors).toEqual([
			"a.ts:1: ambient Date",
			"a.ts:2: ambient Math",
			"a.ts:3: ambient performance",
			"a.ts:4: ambient setTimeout",
			"a.ts:5: ambient globalThis",
			"a.ts:6: ambient fetch",
			"a.ts:7: ambient process",
			"a.ts:8: ambient Bun",
		]);
	});

	test("reports node:/bun: imports and imports escaping src", () => {
		const errors = check(
			"domains/a/x.ts",
			`import { readFileSync } from "node:fs";
import { Database } from "bun:sqlite";
import { x } from "../../../standalone/claude.ts";
import { y } from "../../../eval/contracts.ts";
export { z } from "../../../scripts/verify.ts";
const m = await import("node:path");`,
		);
		expect(errors).toEqual([
			"domains/a/x.ts:1: host module node:fs",
			"domains/a/x.ts:2: host module bun:sqlite",
			"domains/a/x.ts:3: imports outside src (../../../standalone/claude.ts)",
			"domains/a/x.ts:4: imports outside src (../../../eval/contracts.ts)",
			"domains/a/x.ts:5: imports outside src (../../../scripts/verify.ts)",
			"domains/a/x.ts:6: host module node:path",
		]);
	});

	test("skips test files", () => {
		expect(check("domains/a/x.test.ts", `Date.now();`)).toEqual([]);
		expect(check("domains/a/test/helper.ts", `import "node:fs";`)).toEqual([]);
	});
});
