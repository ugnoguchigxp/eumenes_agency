import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
const worker = join(import.meta.dir, "../../eval/recovery-worker.ts");
async function run(path: string, phase: string) {
	const child = Bun.spawn(
		[process.execPath, "--no-env-file", worker, path, phase],
		{ stdout: "pipe", stderr: "pipe" },
	);
	const [code, out, err] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	return { code, out, err };
}
test("separate-process crash rolls back admission, preserves committed checkpoint, reconciles effects once", async () => {
	const dir = mkdtempSync(join(tmpdir(), "agency-crash-"));
	const before = join(dir, "before.sqlite");
	expect((await run(before, "before-commit")).code).not.toBe(0);
	const a = new Database(before);
	expect(a.query("SELECT COUNT(*) n FROM checkpoint").get()).toEqual({ n: 0 });
	expect(a.query("SELECT COUNT(*) n FROM outbox").get()).toEqual({ n: 0 });
	a.close();
	const after = join(dir, "after.sqlite");
	expect((await run(after, "after-commit")).code).not.toBe(0);
	expect((await run(after, "effect-before-ack")).code).not.toBe(0);
	for (let i = 0; i < 2; i++) {
		const r = await run(after, "recover");
		expect(r.err).toBe("");
		expect(r.code).toBe(0);
		expect(JSON.parse(r.out)).toEqual({ intents: 1, effects: 1 });
	}
});
