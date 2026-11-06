/** Local structural synergy measurement. This does not grade model behavior. */
import {
	mkdtempSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { MemoryBridge } from "./memory-bridge.ts";
import { sourceFixture } from "./fixtures.ts";

const output = resolve(
	process.argv[2] ?? "artifacts/memory-synergy-2026-11-06",
);
mkdirSync(output, { recursive: true });
const directory = mkdtempSync(join(tmpdir(), "agency-synergy-"));
const memory = new MemoryBridge(directory);
const bytes = (x: unknown) => Buffer.byteLength(JSON.stringify(x));
const p95 = (values: number[]) =>
	[...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1]!;
try {
	const before = sourceFixture(1000);
	const start = performance.now();
	memory.save(before);
	const initialSaveMs = performance.now() - start;
	const compactStart = performance.now();
	const archived = memory.compact();
	const compactMs = performance.now() - compactStart;
	const after = memory.load()!;
	const lookup: number[] = [];
	const reload: number[] = [];
	const commit: number[] = [];
	for (let i = 0; i < 50; i++) {
		let start = performance.now();
		const source = memory.get("o1");
		lookup.push(performance.now() - start);
		if (source?.observation.text !== before.observations[0]!.text)
			throw new Error("source mismatch");
		start = performance.now();
		const saved = memory.load()!;
		reload.push(performance.now() - start);
		start = performance.now();
		memory.save(saved);
		commit.push(performance.now() - start);
	}
	const rawCheckpoint = memory.db
		.query<{ body: string }, []>("SELECT body FROM example_checkpoint")
		.get()!.body;
	const result = {
		scope:
			"Synthetic 1000 independent user observations; no LLM/API/network. Same originals, Memory public package, local SQLite. Not an action-quality or production load score.",
		memory: JSON.parse(
			readFileSync(join(import.meta.dir, "vendor/manifest.json"), "utf8"),
		),
		sampleCount: 50,
		baseline: {
			kind: "full Agency RAM checkpoint; no durable archive port",
			observations: before.observations.length,
			checkpointBytes: bytes(before),
			sourceReadAfterDiscardingOldObservations: after.observations.some(
				(o) => o.id === "o1",
			),
		},
		connected: {
			kind: "same Agency checkpoint compacted, Memory canonical records + archive port",
			observations: after.observations.length,
			archived,
			checkpointBytes: bytes(after),
			storedHostEnvelopeBytes: Buffer.byteLength(rawCheckpoint),
			originalTextDuplicatedInHostEnvelope: before.observations.some((o) =>
				rawCheckpoint.includes(o.text),
			),
			oldSourceReadable:
				memory.get("o1")?.observation.text === before.observations[0]!.text,
		},
		timingMs: {
			initialSave: initialSaveMs,
			compact: compactMs,
			sourceLookupP95: p95(lookup),
			reload30P95: p95(reload),
			commit30P95: p95(commit),
		},
		limits: [
			"Memory consumes additional disk space for canonical records, revisions, dependency metadata and journal; reduced RAM checkpoint bytes are not total storage savings.",
			"Source lookup is by an already selected ID, not semantic retrieval. A restored synthetic note in adapter tests selects the old ID; no claim that an LLM would discover it.",
			"No equivalence to real Eumenes scheduling, Memory curation, recall or production deletion is established.",
		],
	};
	writeFileSync(
		join(output, "structural-metrics.json"),
		JSON.stringify(result, null, 2) + "\n",
	);
	console.log(JSON.stringify(result, null, 2));
} finally {
	memory.close();
	rmSync(directory, { recursive: true, force: true });
}
