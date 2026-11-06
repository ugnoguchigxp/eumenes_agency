import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanForSecrets } from "../initiative/p0.ts";

test("task file paths are not key tokens, while planted keys still are", () => {
	const dir = mkdtempSync(join(tmpdir(), "agency-secret-scan-"));
	try {
		const manifest = join(dir, "manifest.json");
		writeFileSync(
			manifest,
			JSON.stringify({
				changed: [
					"api/toolchain/task-coordination.ts",
					"scripts/task-measurement.ts",
				],
			}),
		);
		expect(scanForSecrets([manifest]).hits).toEqual([]);
		const planted = join(dir, "planted.txt");
		writeFileSync(planted, 'token="sk-abcdefghijklmnop"');
		expect(scanForSecrets([planted]).hits).toHaveLength(1);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("known credential values are detected even inside another token", () => {
	const dir = mkdtempSync(join(tmpdir(), "agency-secret-scan-"));
	const name = "AGENCY_SCANNER_TEST_API_KEY";
	const before = process.env[name];
	try {
		process.env[name] = "sk-artificial-credential-for-scanner";
		const file = join(dir, "joined.txt");
		writeFileSync(file, `prefix${process.env[name]}suffix`);
		expect(scanForSecrets([file]).hits).toContainEqual({
			file,
			kind: `env:${name}`,
		});
	} finally {
		if (before === undefined) delete process.env[name];
		else process.env[name] = before;
		rmSync(dir, { recursive: true, force: true });
	}
});
