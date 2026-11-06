import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import {
	createAgencyRuntime,
	defaultBudget,
	defaultRetentionLimits,
	emptyState,
	prepareCompaction,
	prepareForgetting,
	RevisionTracker,
	redactRevisions,
	stateFromRevisions,
	type AgencySnapshot,
} from "../../src/index.ts";
import { ProvenanceTracker } from "../../src/application/provenance.ts";
import { validateRestore } from "../../src/application/snapshot.ts";
import { createLedger } from "../../src/domains/experience/ledger.ts";
import { CheckpointStore } from "../../standalone/checkpoint-store.ts";
import { fakeLlm, obsInput, proposal } from "./helpers.ts";

const signal = () => new AbortController().signal;
const runtime = (restore?: AgencySnapshot, extra = {}) =>
	createAgencyRuntime({
		condition: "B1",
		systemContext: "experimental",
		llm: fakeLlm(),
		tools: [],
		...(restore ? { restore } : {}),
		...extra,
	});
const fixture = (count = 100, cursor = 90): AgencySnapshot => ({
	condition: "B1",
	state: emptyState(),
	cursor,
	observations: Array.from({ length: count }, (_, i) => ({
		...obsInput(`o${i + 1}`, "user.report", "user", i, `原文${i + 1}`),
		seq: i + 1,
	})),
});

test("all presented inputs propagate across state and restart even when the model cites another observation", async () => {
	const llm = fakeLlm();
	const rt = runtime(undefined, {
		llm,
		budget: { ...defaultBudget, minIntervalMs: 0 },
	});
	rt.observe(obsInput("secret", "user.report", "user", 0, "忘れる原文"));
	rt.observe(obsInput("public", "user.report", "user", 1, "公開情報"));
	llm.push(
		"update",
		proposal([
			{
				op: "note.add",
				localId: "a",
				text: "派生した秘密",
				evidenceRefs: ["public"],
			},
		]),
	);
	await rt.runBackground(2, signal());
	const original = rt.snapshot();
	expect(original.state.notes.length).toBe(1);
	expect(
		new Map(original.provenance!.entries).get("note:n1")!.sources,
	).toContain("secret");
	const restarted = runtime(original, {
		llm,
		budget: { ...defaultBudget, minIntervalMs: 0 },
	});
	restarted.observe(obsInput("new", "user.report", "user", 3, "次の材料"));
	llm.push(
		"update",
		proposal([
			{
				op: "note.add",
				localId: "b",
				text: "二次の派生",
				evidenceRefs: ["new"],
			},
		]),
	);
	await restarted.runBackground(4, signal());
	const plan = prepareForgetting(restarted.snapshot(), ["secret"]);
	expect(plan.checkpoint.state.notes).toEqual([]);
	expect(JSON.stringify(plan.checkpoint)).not.toContain("忘れる原文");
	expect(JSON.stringify(plan.checkpoint)).not.toContain("派生した秘密");
	expect(runtime(plan.checkpoint).projection(10).items).toEqual([]);
	expect(() =>
		runtime(plan.checkpoint).observe(
			obsInput("secret", "user.report", "user", 0, "再投入"),
		),
	).toThrow("forgotten");
	// Negative control: citations alone miss the non-cited dependency.
	expect(original.state.notes[0]!.evidence).not.toContain("secret");
});

test("revision-only restore retains complete input metadata; forget redacts every version", () => {
	const s = emptyState();
	s.notes.push({
		id: "n",
		revision: 1,
		text: "派生本文",
		evidence: ["public"],
	});
	const p = {
		version: 1 as const,
		entries: [
			["note:n", { sources: ["secret", "public"], complete: true }],
		] as const,
	};
	const tracker = new RevisionTracker("test");
	const rows = tracker.diff(s, "update", 1, p);
	tracker.commit(rows);
	const restored = stateFromRevisions(rows)!;
	expect(restored.provenance).toEqual(p);
	const next = new RevisionTracker("test");
	next.prime(restored.state, restored.revs, restored.provenance);
	expect(next.diff(restored.state, "restore", 2, restored.provenance)).toEqual(
		[],
	);
	const redacted = redactRevisions(rows, new Set(["secret"]));
	expect(JSON.stringify(redacted)).not.toContain("派生本文");
	expect(stateFromRevisions(redacted)!.state.notes).toEqual([]);
	expect(
		runtime(
			{ ...fixture(0, 0), ...restored },
			{ forgottenRefs: ["secret"] },
		).snapshot().state.notes,
	).toEqual([]);
});

test("legacy or unknown host provenance is forgotten conservatively, while unrelated complete inputs survive", () => {
	const s = fixture(2, 2);
	s.state.notes.push(
		{ id: "old", revision: 1, text: "未知の派生", evidence: ["o2"] },
		{ id: "safe", revision: 1, text: "独立", evidence: ["o2"] },
	);
	const next = prepareForgetting(
		{
			...s,
			provenance: {
				version: 1,
				entries: [["note:safe", { sources: ["o2"], complete: true }]],
			},
		},
		["o1"],
	).checkpoint;
	expect(next.state.notes.map((n) => n.id)).toEqual(["safe"]);
	expect(() =>
		runtime(next).observe(
			obsInput("agent", "exchange.adopted", "agent", 3, "不明な派生"),
		),
	).toThrow("forgotten");
	expect(
		runtime(next).observe(
			obsInput("agent", "exchange.adopted", "agent", 3, "独立の派生"),
			{ sources: ["o2"], complete: true },
		).id,
	).toBe("agent");
});

test("forgetting a pending input erases its body without acknowledging other pending events", () => {
	const next = prepareForgetting(fixture(5, 2), ["o4"]).checkpoint;
	expect(next.cursor).toBe(2);
	expect(next.observations.find((o) => o.id === "o4")!.text).toBe("");
	const rt = runtime(next);
	expect(
		rt
			.snapshot()
			.observations.filter((o) => o.seq > 2)
			.map((o) => o.id),
	).toEqual(["o3", "o4", "o5"]);
});

test("archival compaction preserves seq, pending, recent context, archive identity and idempotence", () => {
	const before = fixture();
	const plan = prepareCompaction(before, 30);
	expect(plan.archive).toHaveLength(70);
	expect(plan.checkpoint.observations.filter((o) => o.seq > 90)).toEqual(
		before.observations.slice(90),
	);
	expect(plan.checkpoint.observations.slice(-30)).toEqual(
		before.observations.slice(-30),
	);
	const entries = new Map(plan.archive.map((e) => [e.observation.id, e]));
	const ledger = createLedger(
		defaultRetentionLimits,
		{ observations: plan.checkpoint.observations, cursor: 90 },
		{ get: (id) => entries.get(id) },
	);
	expect(ledger.get("o1")).toEqual(before.observations[0]);
	expect(ledger.pending()).toEqual(before.observations.slice(90));
	expect(
		ledger.record(obsInput("o1", "user.report", "user", 0, "原文1")).seq,
	).toBe(1);
	expect(ledger.lastSeq()).toBe(100);
	expect(() =>
		ledger.record(obsInput("o1", "user.report", "user", 0, "別本文")),
	).toThrow();
	expect(
		ledger.record(obsInput("new", "user.report", "user", 101, "続き")).seq,
	).toBe(101);
	expect(prepareCompaction(plan.checkpoint, 30).archive).toEqual([]);
});

test("compaction pins old state evidence and the latest user input", () => {
	const before = fixture();
	before.state.notes.push({
		id: "n",
		revision: 1,
		text: "参照",
		evidence: ["o1"],
	});
	const next = prepareCompaction(before, 30).checkpoint;
	expect(next.observations.some((o) => o.id === "o1")).toBe(true);
	expect(() =>
		validateRestore(
			{ ...next, observations: next.observations.filter((o) => o.seq !== 95) },
			"B1",
		),
	).toThrow();
	expect(() =>
		validateRestore({ ...next, compactedThrough: 91 }, "B1"),
	).toThrow();
});

test("metadata capacity fails before mutation", () => {
	const p = new ProvenanceTracker(undefined, 70);
	const before = p.snapshot();
	expect(() =>
		p.set("note:n", { sources: ["x".repeat(100)], complete: true }),
	).toThrow("capacity");
	expect(p.snapshot()).toEqual(before);
});

test("durable store atomically archives, rejects stale writers, purges histories, and fences old backups", () => {
	const dir = mkdtempSync(join(tmpdir(), "agency-memory-"));
	const path = join(dir, "memory.sqlite");
	let store = new CheckpointStore(path);
	try {
		const old = fixture();
		const tracker = new RevisionTracker("s");
		const rows = tracker.diff(old.state, "x", 1);
		expect(store.save(old, 0, rows)).toBe(1);
		expect(store.compact(1, 30)).toBe(2);
		expect(store.get("o1")!.observation.text).toBe("原文1");
		expect(() =>
			store.save(store.load()!.checkpoint, 2, [
				{ ...rows[0]!, reason: "conflict" },
			]),
		).toThrow("conflicting item revision");
		expect(() => store.save(old, 1)).toThrow("stale");
		store.close();
		store = new CheckpointStore(path);
		expect(store.load()!.checkpoint.observations[0]!.seq).toBe(71);
		expect(store.forget(["o1"], 2)).toBe(3);
		expect(store.get("o1")).toBeUndefined();
		expect(store.save(old, 3)).toBe(4);
		expect(JSON.stringify(store.load())).not.toContain('原文1"');
		expect(store.journal()).toContain("o1");
	} finally {
		store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("storage failure rolls back archive and checkpoint together", () => {
	const dir = mkdtempSync(join(tmpdir(), "agency-memory-fault-"));
	const path = join(dir, "memory.sqlite");
	const store = new CheckpointStore(path);
	const sql = new Database(path);
	try {
		store.save(fixture(), 0);
		sql.exec(
			"CREATE TRIGGER reject_checkpoint BEFORE INSERT ON checkpoint BEGIN SELECT RAISE(ABORT, 'fault injection'); END;",
		);
		expect(() => store.compact(1, 30)).toThrow("fault injection");
		expect(store.get("o1")).toBeUndefined();
		expect(store.load()!.generation).toBe(1);
		expect(store.load()!.checkpoint.observations).toHaveLength(100);
	} finally {
		sql.close();
		store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("saving a compaction plan without its archive cannot discard observations", () => {
	const dir = mkdtempSync(join(tmpdir(), "agency-memory-admission-"));
	const store = new CheckpointStore(join(dir, "memory.sqlite"));
	try {
		const original = fixture();
		const compacted = prepareCompaction(original, 30).checkpoint;
		expect(() => store.save(compacted, 0)).toThrow("full checkpoint");
		store.save(original, 0);
		expect(() => store.save(compacted, 1)).toThrow("atomic archive");
		expect(store.load()!.generation).toBe(1);
		expect(store.load()!.checkpoint.observations).toHaveLength(100);
	} finally {
		store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("host-derived reference chains retain dependencies even when the caller omits a redundant context", () => {
	const rt = runtime();
	rt.observe(obsInput("root", "user.report", "user", 0, "秘密の原文"));
	rt.observe(obsInput("derived", "action.observed", "tool", 1, "一次の派生"), {
		sources: ["root"],
		complete: true,
	});
	rt.observe({
		...obsInput("again", "action.observed", "tool", 2, "二次の秘密"),
		refs: ["derived"],
	});
	const next = prepareForgetting(rt.snapshot(), ["root"]).checkpoint;
	expect(JSON.stringify(next)).not.toContain("二次の秘密");
});

test("SIGKILL before/after archive and forget commit preserves one complete durable generation", async () => {
	const dir = mkdtempSync(join(tmpdir(), "agency-memory-kill-"));
	try {
		for (const operation of ["compact", "forget"])
			for (const phase of ["before", "after"]) {
				const path = join(dir, `${operation}-${phase}.sqlite`);
				let store = new CheckpointStore(path);
				store.save(fixture(), 0);
				store.close();
				const worker = Bun.spawn(
					[process.execPath, "eval/memory-worker.ts", path, operation, phase],
					{ stdout: "pipe", stderr: "pipe" },
				);
				const reader = worker.stdout.getReader();
				const first = await reader.read();
				expect(new TextDecoder().decode(first.value)).toContain(
					phase === "before" ? "inside-transaction" : "committed",
				);
				worker.kill("SIGKILL");
				await worker.exited;
				reader.releaseLock();
				store = new CheckpointStore(path);
				const restored = store.load()!;
				expect(restored.generation).toBe(phase === "before" ? 1 : 2);
				expect(
					restored.checkpoint.observations
						.filter((o) => o.seq > 90)
						.map((o) => o.id),
				).toEqual(
					fixture()
						.observations.slice(90)
						.map((o) => o.id),
				);
				if (operation === "compact") {
					expect(restored.checkpoint.observations.length).toBe(
						phase === "before" ? 100 : 30,
					);
					expect(store.get("o1") !== undefined).toBe(phase === "after");
				} else {
					expect(store.journal().includes("o1")).toBe(phase === "after");
					expect(JSON.stringify(restored).includes('原文1"')).toBe(
						phase === "before",
					);
				}
				store.close();
			}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}, 15000);

test("two standalone writer processes cannot both commit the same checkpoint generation", async () => {
	const dir = mkdtempSync(join(tmpdir(), "agency-memory-race-"));
	const path = join(dir, "memory.sqlite");
	try {
		const store = new CheckpointStore(path);
		store.save(fixture(), 0);
		store.close();
		const workers = [0, 1].map(() =>
			Bun.spawn(
				[process.execPath, "eval/memory-worker.ts", path, "save", "none"],
				{ stdout: "pipe", stderr: "pipe" },
			),
		);
		const results = await Promise.all(
			workers.map(async (worker) => {
				const out = await new Response(worker.stdout).text();
				expect(await worker.exited).toBe(0);
				return out.trim();
			}),
		);
		expect(results.sort()).toEqual(["saved", "stale"]);
		const restored = new CheckpointStore(path);
		expect(restored.load()!.generation).toBe(2);
		restored.close();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}, 15000);

test("pending observations larger than the recent window cannot be compacted", () => {
	const original = fixture(100, 20);
	const plan = prepareCompaction(original, 30);
	expect(plan.checkpoint.observations.filter((o) => o.seq > 20)).toEqual(
		original.observations.slice(20),
	);
	expect(plan.archive.every((entry) => entry.observation.seq <= 20)).toBe(true);
});

test("legacy orphan ticket bodies are conservatively erased on forgetting", () => {
	const snapshot: AgencySnapshot = {
		...fixture(0, 0),
		continuity: {
			calls: [],
			activities: [],
			issued: [
				{
					id: "orphan",
					opportunityId: "p",
					action: "tool",
					candidateId: null,
					candidateRevision: null,
					stateRevision: 0,
					utterance: null,
					toolName: "tool",
					toolInput: "派生した秘密",
					origin: "autonomous",
					tts: false,
				},
			],
			receipts: [],
			topics: [],
			lastUsed: [],
			feelings: [],
			failures: 0,
			quarantined: false,
			diagnostics: ["診断内の秘密"],
		},
	};
	const next = prepareForgetting(snapshot, ["source"]).checkpoint;
	expect(next.continuity!.issued).toEqual([]);
	expect(JSON.stringify(next)).not.toContain("秘密");
});

test("invalid host dependency contexts fail before admitting an observation", () => {
	const rt = runtime();
	expect(() =>
		rt.observe(obsInput("bad", "action.observed", "tool", 0, "本文"), {
			sources: ["source"],
			complete: "false",
		} as never),
	).toThrow("dependency context");
	expect(rt.snapshot().observations).toEqual([]);
});

test("rewritten speech receipts do not claim complete dependencies from the selection alone", async () => {
	const llm = fakeLlm();
	const rt = runtime(fixture(100, 100), {
		llm,
		selectWhenEmpty: true,
		budget: { ...defaultBudget, minIntervalMs: 0 },
	});
	const { participation, opportunity } = await import("./helpers.ts");
	llm.push(
		"select",
		participation({
			action: "speak",
			utterance: "公開した提案",
			evidenceRefs: ["o100"],
		}),
	);
	const { decision } = await rt.decide(opportunity("out", 101), signal());
	expect(decision.ticket).not.toBeNull();
	rt.recordResult({
		ticketId: decision.ticket!.id,
		status: "succeeded",
		at: 102,
		resultText: "古い会話を使って別モデルが表現した秘密",
	});
	const next = prepareForgetting(rt.snapshot(), ["o1"]).checkpoint;
	expect(JSON.stringify(next)).not.toContain("別モデルが表現した秘密");
});

test("forgetting journal fences unknown receipt inputs before admission", async () => {
	const llm = fakeLlm();
	const { participation, opportunity } = await import("./helpers.ts");
	const rt = runtime(fixture(100, 100), {
		llm,
		selectWhenEmpty: true,
		forgottenRefs: ["ancient"],
		budget: { ...defaultBudget, minIntervalMs: 0 },
	});
	llm.push(
		"select",
		participation({
			action: "speak",
			utterance: "公開した提案",
			evidenceRefs: ["o100"],
		}),
	);
	const { decision } = await rt.decide(opportunity("out", 101), signal());
	const receipt = {
		ticketId: decision.ticket!.id,
		status: "succeeded" as const,
		at: 102,
		resultText: "外部の生成文",
	};
	const before = rt.snapshot();
	expect(() => rt.recordResult(receipt)).toThrow("forgotten");
	expect(rt.snapshot()).toEqual(before);
	expect(
		rt.recordResult(receipt, { sources: ["o100"], complete: true }).text,
	).toContain("外部の生成文");
});

test("forgotten pending tombstones do not become sources of a new unrelated item", async () => {
	const llm = fakeLlm();
	const saved = prepareForgetting(fixture(1, 0), ["o1"]).checkpoint;
	const rt = runtime(saved, {
		llm,
		budget: { ...defaultBudget, minIntervalMs: 0 },
	});
	rt.observe(obsInput("public", "user.report", "user", 2, "新しい依頼"));
	llm.push(
		"update",
		proposal([
			{
				op: "note.add",
				localId: "safe",
				text: "公開の仕事",
				evidenceRefs: ["public"],
			},
		]),
	);
	await rt.runBackground(3, signal());
	const input = new Map(rt.snapshot().provenance!.entries).get("note:n1")!;
	expect(input.sources).not.toContain("o1");
	expect(input.complete).toBe(true);
	expect(rt.snapshot().cursor).toBe(2);
});

test("state never presented to the model does not make an unrelated new note depend on it", async () => {
	const original = fixture(100, 100);
	original.state.nextId = 2;
	original.state.attempts.push({
		id: "a1",
		candidateId: null,
		candidateRevision: null,
		opportunityId: "old",
		action: "speak",
		status: "succeeded",
		startedAt: 0,
	});
	const saved = {
		...original,
		provenance: {
			version: 1 as const,
			entries: [["attempt:a1", { sources: ["o1"], complete: true }]] as const,
		},
	};
	const llm = fakeLlm();
	const rt = runtime(saved, {
		llm,
		budget: { ...defaultBudget, minIntervalMs: 0 },
	});
	rt.observe(obsInput("new", "user.report", "user", 101, "独立した依頼"));
	llm.push(
		"update",
		proposal([
			{
				op: "note.add",
				localId: "independent",
				text: "独立した仕事",
				evidenceRefs: ["new"],
			},
		]),
	);
	await rt.runBackground(102, signal());
	const note = rt.snapshot().state.notes[0]!;
	expect(
		new Map(rt.snapshot().provenance!.entries).get("note:" + note.id)!.sources,
	).not.toContain("o1");
	expect(
		prepareForgetting(rt.snapshot(), ["o1"]).checkpoint.state.notes,
	).toEqual([note]);
});

test("an ordinary input is admitted when it does not allocate dependency metadata", () => {
	const saved = fixture(0, 0);
	saved.state.notes.push(
		{ id: "n1", revision: 1, text: "一つ目", evidence: ["x"] },
		{ id: "n2", revision: 1, text: "二つ目", evidence: ["y"] },
	);
	const provenance = {
		version: 1 as const,
		entries: [
			["note:n1", { sources: ["x".repeat(100)], complete: true }],
			["note:n2", { sources: ["y".repeat(100)], complete: true }],
		] as const,
	};
	const bytes = new TextEncoder().encode(
		JSON.stringify(provenance.entries),
	).byteLength;
	const rt = runtime(
		{ ...saved, provenance },
		{
			retentionLimits: {
				...defaultRetentionLimits,
				totalObservationBytes: bytes + 1,
			},
		},
	);
	expect(
		rt.observe(obsInput("new", "user.report", "user", 1, "新しい入力")).id,
	).toBe("new");
	expect(rt.snapshot().provenance).toEqual(provenance);
});
