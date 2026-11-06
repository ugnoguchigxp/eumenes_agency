import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
	copyFileSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	captureRecord,
	listMemoryChanges,
	migrations,
	readRecord,
} from "eumenes-memory/sqlite";
import {
	createAgencyRuntime,
	defaultBudget,
	LlmCallError,
} from "../../src/index.ts";
import {
	fakeLlm,
	obsInput,
	opportunity,
	participation,
	proposal,
} from "../../test/core/helpers.ts";
import { VirtualEumenes } from "./adapter.ts";
import { exampleAccess, MemoryBridge } from "./memory-bridge.ts";
import { sourceFixture as fixture } from "./fixtures.ts";

const directories: string[] = [];
const directory = () => {
	const path = mkdtempSync(join(tmpdir(), "agency-memory-"));
	directories.push(path);
	return path;
};
afterEach(() => {
	for (const dir of directories.splice(0))
		rmSync(dir, { recursive: true, force: true });
});
const signal = () => new AbortController().signal;
const budget = { ...defaultBudget, minIntervalMs: 0 };

test("pinned Memory public API captures, reads, enforces access and rejects writes outside a transaction", () => {
	const db = new Database(":memory:");
	try {
		for (const sql of migrations) db.exec(sql);
		const input = {
			contractVersion: 1 as const,
			access: exampleAccess,
			scopeKey: "conversation:virtual",
			clock: { atMs: 1 },
			origin: { namespace: "example", kind: "source", id: "one" },
			mediaType: "text/plain" as const,
			content: "原文",
			captureState: "complete" as const,
		};
		expect(() => captureRecord(db, input)).toThrow();
		const result = db.transaction(() => captureRecord(db, input))();
		expect(result.status).toBe("captured");
		if (result.status !== "captured") throw Error("capture");
		const read = {
			contractVersion: 1 as const,
			access: exampleAccess,
			scopeKey: "conversation:virtual",
			recordId: result.recordId,
		};
		expect(readRecord(db, read)).toMatchObject({
			status: "available",
			content: "原文",
		});
		expect(
			readRecord(db, {
				...read,
				access: { ...exampleAccess, principal: "another" },
			}).status,
		).toBe("missing"); // Another principal must not learn whether the record exists.
		expect(
			readRecord(db, { ...read, access: { ...exampleAccess, scopeKeys: [] } }),
		).toEqual({ status: "not_permitted" });
	} finally {
		db.close();
	}
});

test("canonical bodies live in Memory, archive survives restart, and source references are chunked at the public limit", () => {
	const dir = directory();
	let memory = new MemoryBridge(dir);
	try {
		memory.save(fixture());
		const stored = memory.db
			.query<{ body: string }, []>("SELECT body FROM example_checkpoint")
			.get()!.body;
		expect(stored).not.toContain("原観測：素材");
		expect(
			memory.db
				.query<{ n: number }, []>(
					"SELECT count(*) AS n FROM example_dependents",
				)
				.get()!.n,
		).toBe(3);
		expect(memory.compact()).toBe(50);
		expect(memory.load()!.observations).toHaveLength(30);
		memory.close();
		memory = new MemoryBridge(dir);
		expect(memory.get("o1")!.observation.text).toContain("10枚当たり");
		expect(memory.get("o1")!.observation.seq).toBe(1);
		expect(memory.load()!.observations).toHaveLength(30);
	} finally {
		memory.close();
	}
});

test("a restored Agency note receives the archived source; disabling the archive loses only that source", async () => {
	const memory = new MemoryBridge(directory());
	try {
		memory.save(fixture());
		memory.compact();
		const saved = memory.load()!;
		saved.state.notes.push({
			id: "n1",
			revision: 1,
			text: "単価の基準を確認して比較する",
			evidence: ["o1"],
		});
		const restored = {
			...saved,
			provenance: {
				version: 1 as const,
				entries: [["note:n1", { sources: ["o1"], complete: true }]] as const,
			},
		};
		for (const enabled of [false, true]) {
			const llm = fakeLlm();
			llm.push("select", participation());
			const runtime = createAgencyRuntime({
				condition: "B1",
				systemContext: "experimental",
				tools: [],
				llm,
				restore: restored,
				...(enabled ? { archive: memory } : {}),
				budget,
			});
			await runtime.decide(opportunity("read", 90 * 60000), signal());
			expect(llm.requests[0]!.prompt.includes("原観測：素材")).toBe(enabled);
			expect(llm.requests[0]!.prompt).toContain("別の観測79");
		}
	} finally {
		memory.close();
	}
});

test("restarting through Agency preserves observation identity regardless of JSON key order", () => {
	const dir = directory();
	const memory = new MemoryBridge(dir);
	memory.save(fixture());
	memory.compact();
	memory.close();
	const host = new VirtualEumenes(dir, fakeLlm());
	try {
		host.observe(
			obsInput("fresh", "user.report", "user", 90 * 60000, "再起動後の入力"),
		);
		expect(host.memory.get("o79")?.observation.text).toBe("別の観測78");
		expect(host.snapshot().observations).toHaveLength(31);
	} finally {
		host.close();
	}
});

test("Memory forgetting removes non-cited Agency state, tickets and canonical derived bodies before acknowledgement", async () => {
	const llm = fakeLlm();
	const host = new VirtualEumenes(directory(), llm, {
		condition: "B1",
		tools: [],
		budget,
	});
	try {
		host.observe(obsInput("secret", "user.report", "user", 1, "忘却する原文"));
		host.observe(obsInput("public", "user.report", "user", 2, "別の公開情報"));
		llm.push(
			"update",
			proposal([
				{
					op: "note.add",
					localId: "derived",
					text: "秘密から作ったメモ",
					evidenceRefs: ["public"],
				},
			]),
		);
		await host.update(3);
		llm.push(
			"select",
			participation({
				action: "speak",
				utterance: "秘密の派生発言",
				evidenceRefs: ["public"],
			}),
		);
		const decision = await host.decide(opportunity("say", 4));
		expect(decision.decision.ticket).toBeDefined();
		host.observe(
			obsInput(
				"derived",
				"external.event",
				"host",
				5,
				"秘密から作った派生本文",
			),
			{ sources: ["secret"], complete: true },
		);
		const receipt = host.forget("secret");
		expect(receipt.completed).toBe(true);
		expect(receipt.external).toBe("confirmed");
		expect(host.snapshot().state.notes).toEqual([]);
		expect(host.snapshot().continuity?.issued).toEqual([]);
		expect(JSON.stringify(host.snapshot())).not.toContain("秘密");
		expect(host.memory.get("secret")).toBeUndefined();
		expect(host.memory.get("derived")).toBeUndefined();
		expect(host.memory.get("public")!.observation.text).toBe("別の公開情報");
		const row = host.memory.db
			.query<{ record_id: string }, []>(
				"SELECT record_id FROM example_sources WHERE id='derived'",
			)
			.get()!;
		expect(
			readRecord(host.memory.db, {
				contractVersion: 1,
				access: exampleAccess,
				scopeKey: "conversation:virtual",
				recordId: row.record_id,
			}).status,
		).toBe("forgotten");
	} finally {
		host.close();
	}
});

test("the external Memory journal prevents resurrection after restoring an older host DB", () => {
	const dir = directory();
	let memory = new MemoryBridge(dir);
	try {
		memory.save(fixture());
		memory.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
		const backup = join(dir, "older.sqlite");
		copyFileSync(memory.databasePath, backup);
		expect(memory.forget("o1").completed).toBe(true);
		memory.close();
		copyFileSync(backup, join(dir, "host.sqlite"));
		memory = new MemoryBridge(dir);
		expect(memory.get("o1")).toBeUndefined();
		expect(memory.load()!.observations.some((o) => o.id === "o1")).toBe(false);
		expect(JSON.stringify(memory.load())).not.toContain("原観測：素材");
		expect(() => memory.save(fixture())).toThrow();
	} finally {
		memory.close();
	}
});

test("failure after Memory deletion leaves acknowledgement pending and restart finishes Agency deletion", async () => {
	const dir = directory();
	const llm = fakeLlm();
	const host = new VirtualEumenes(dir, llm, {
		condition: "B1",
		tools: [],
		budget,
	});
	host.observe(obsInput("secret", "user.report", "user", 1, "秘密の元情報"));
	llm.push(
		"update",
		proposal([
			{
				op: "note.add",
				localId: "n",
				text: "派生した秘密",
				evidenceRefs: ["secret"],
			},
		]),
	);
	await host.update(2);
	host.memory.db.exec(
		"CREATE TEMP TRIGGER fail_after_forget BEFORE INSERT ON example_checkpoint BEGIN SELECT RAISE(ABORT,'injected after Memory forget'); END;",
	);
	expect(() => host.forget("secret")).toThrow("injected");
	const entry = JSON.parse(
		readFileSync(host.memory.journalPath, "utf8").trim().split("\n")[0]!,
	);
	expect(host.memory.receipt(entry.forgetId).completed).toBe(false);
	host.close();
	const restarted = new VirtualEumenes(dir, fakeLlm());
	try {
		expect(restarted.snapshot().state.notes).toEqual([]);
		expect(restarted.memory.get("secret")).toBeUndefined();
		expect(restarted.memory.receipt(entry.forgetId).completed).toBe(true);
	} finally {
		restarted.close();
	}
});

test("a failed host checkpoint rolls back Memory capture and stops publication", () => {
	const host = new VirtualEumenes(directory(), fakeLlm());
	try {
		host.memory.db.exec(
			"CREATE TEMP TRIGGER fail_checkpoint BEFORE INSERT ON example_checkpoint BEGIN SELECT RAISE(ABORT,'injected checkpoint failure'); END;",
		);
		expect(() =>
			host.observe(obsInput("new", "user.report", "user", 1, "保存失敗の本文")),
		).toThrow("injected");
		const changes = listMemoryChanges(host.memory.db, {
			contractVersion: 1,
			access: exampleAccess,
			scopeKeys: ["conversation:virtual"],
			afterSeq: 0,
			limit: 500,
		});
		expect(changes).toMatchObject({ status: "ok", changes: [] });
		expect(() => host.snapshot()).toThrow("stopped");
	} finally {
		host.close();
	}
});

test("stale writers, foreign owners and truncated journals fail closed", () => {
	const dir = directory();
	const first = new MemoryBridge(dir);
	const stale = new MemoryBridge(dir);
	try {
		first.save(fixture());
		expect(() => stale.save(fixture())).toThrow("stale");
	} finally {
		first.close();
		stale.close();
	}
	expect(
		() => new MemoryBridge(dir, { ...exampleAccess, principal: "other" }),
	).toThrow("scope");
	writeFileSync(join(dir, "memory-forget.jsonl"), '{"incomplete":');
	expect(() => new MemoryBridge(dir)).toThrow("truncated");
});

test("a missing canonical source is a recovery error, never an inferred forget", () => {
	const memory = new MemoryBridge(directory());
	try {
		memory.save(fixture());
		const before = memory.db
			.query<{ body: string }, []>("SELECT body FROM example_checkpoint")
			.get()!.body;
		memory.db
			.query("UPDATE example_sources SET record_id=? WHERE id='o1'")
			.run(`rec:${"0".repeat(64)}`);
		expect(() => memory.load()).toThrow("unavailable");
		expect(
			memory.db
				.query<{ body: string }, []>("SELECT body FROM example_checkpoint")
				.get()!.body,
		).toBe(before);
	} finally {
		memory.close();
	}
});

test("pinned artifact hash matches the Eumenes adopted manifest", async () => {
	const manifest = JSON.parse(
		readFileSync(join(import.meta.dir, "vendor/manifest.json"), "utf8"),
	);
	const hash = new Bun.CryptoHasher("sha256")
		.update(readFileSync(join(import.meta.dir, "vendor", manifest.artifact)))
		.digest("hex");
	expect(hash).toBe(manifest.sha256);
});

test("an archived observation stays pinned to its captured Memory revision", () => {
	const memory = new MemoryBridge(directory());
	try {
		memory.save(fixture());
		memory.compact();
		const before = memory.get("o1")!;
		memory.db.transaction(() =>
			captureRecord(memory.db, {
				contractVersion: 1,
				access: exampleAccess,
				scopeKey: "conversation:virtual",
				clock: { atMs: 999 },
				origin: { namespace: "agency-example", kind: "observation", id: "o1" },
				mediaType: "application/json",
				content: JSON.stringify({
					...before,
					observation: { ...before.observation, text: "後から変わった内容" },
				}),
				captureState: "complete",
			}),
		)();
		expect(memory.get("o1")).toEqual(before);
		expect(memory.forget("o1").completed).toBe(true);
		expect(memory.get("o1")).toBeUndefined();
	} finally {
		memory.close();
	}
});

test("forgetting fences an in-flight inference before its output can be committed", async () => {
	let release!: () => void;
	let began!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const started = new Promise<void>((resolve) => {
		began = resolve;
	});
	const base = fakeLlm();
	base.push(
		"update",
		proposal([
			{
				op: "note.add",
				localId: "old",
				text: "忘却前の推論結果",
				evidenceRefs: ["secret"],
			},
		]),
	);
	const host = new VirtualEumenes(directory(), {
		async complete(req, signal) {
			began();
			await gate;
			return base.complete(req, signal);
		},
	});
	try {
		host.observe(
			obsInput("secret", "user.report", "user", 1, "削除対象の入力"),
		);
		const pending = host.update(2).then(
			() => "unexpected success",
			(error) => (error as Error).message,
		);
		await started;
		expect(host.forget("secret").completed).toBe(true);
		release();
		expect(await pending).toContain("invalidated");
		expect(host.snapshot().state.notes).toEqual([]);
		expect(JSON.stringify(host.snapshot())).not.toContain("忘却前の推論結果");
	} finally {
		release();
		host.close();
	}
});

test("forgetting aborts a retryable pending call before another model invocation", async () => {
	let release!: () => void;
	let began!: () => void;
	let calls = 0;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const started = new Promise<void>((resolve) => {
		began = resolve;
	});
	const host = new VirtualEumenes(directory(), {
		async complete() {
			calls++;
			began();
			await gate;
			throw new LlmCallError("connection", true);
		},
	});
	try {
		host.observe(obsInput("secret", "user.report", "user", 1, "消す入力"));
		const pending = host.update(2).catch((error) => (error as Error).message);
		await started;
		expect(host.forget("secret").completed).toBe(true);
		release();
		await pending;
		expect(calls).toBe(1);
		expect(host.snapshot().state.notes).toEqual([]);
	} finally {
		release();
		host.close();
	}
});
