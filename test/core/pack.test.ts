import { describe, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkTarball, pack } from "../../scripts/pack.ts";

describe("pack", () => {
	test("builds a dist-only tarball that imports and exposes the host API", async () => {
		const out = mkdtempSync(join(tmpdir(), "agency-pack-out-"));
		try {
			const built = await pack(out);
			expect(await checkTarball(built.tgz)).toEqual([]);
			const manifest = JSON.parse(readFileSync(built.manifestPath, "utf8"));
			expect(manifest.artifact).toMatch(
				/^eumenes-agency-\d+\.\d+\.\d+-[0-9a-f]{12}\.tgz$/,
			);
			expect(manifest.sha256).toMatch(/^[0-9a-f]{64}$/);
			expect(manifest.INSTRUCTION_VERSION).toBeString();
			expect(manifest.HOST_RULES_VERSION).toBeString();
		} finally {
			rmSync(out, { recursive: true, force: true });
		}
	}, 60_000);

	test("rejects a tarball that carries standalone/, .env or sources", async () => {
		const dir = mkdtempSync(join(tmpdir(), "agency-pack-bad-"));
		try {
			const pkg = join(dir, "stage", "package");
			mkdirSync(join(pkg, "dist"), { recursive: true });
			mkdirSync(join(pkg, "standalone"));
			writeFileSync(join(pkg, "package.json"), "{}");
			writeFileSync(join(pkg, "dist", "index.js"), "export {};");
			writeFileSync(join(pkg, "dist", "index.d.ts"), "export {};");
			writeFileSync(join(pkg, "standalone", "cli.ts"), "");
			writeFileSync(join(pkg, ".env"), "");
			const tgz = join(dir, "bad.tgz");
			const tar = Bun.spawnSync([
				"tar",
				"-czf",
				tgz,
				"-C",
				join(dir, "stage"),
				"package",
			]);
			expect(tar.exitCode).toBe(0);
			const errors = await checkTarball(tgz);
			expect(errors.some((e) => e.includes("standalone/cli.ts"))).toBe(true);
			expect(errors.some((e) => e.includes(".env"))).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
