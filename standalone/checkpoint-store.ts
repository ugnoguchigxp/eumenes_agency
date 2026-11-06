/** Optional standalone SQLite host adapter. The library core remains storage independent. */
import { Database } from "bun:sqlite";
import type {
	AgencySnapshot,
	ArchivedObservation,
	ItemRevision,
} from "../src/index.ts";
import {
	prepareCompaction,
	prepareForgetting,
	redactRevisions,
} from "../src/index.ts";
import { dependsOn } from "../src/application/memory.ts";
import { validateRestore } from "../src/application/snapshot.ts";

export class CheckpointStore {
	private readonly db: Database;
	constructor(path: string) {
		this.db = new Database(path, { create: true, strict: true });
		this.db
			.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
			CREATE TABLE IF NOT EXISTS checkpoint(id INTEGER PRIMARY KEY CHECK(id=1), generation INTEGER NOT NULL, body TEXT NOT NULL);
			CREATE TABLE IF NOT EXISTS archive(id TEXT PRIMARY KEY, body TEXT NOT NULL);
			CREATE TABLE IF NOT EXISTS forgotten(id TEXT PRIMARY KEY);
			CREATE TABLE IF NOT EXISTS revisions(kind TEXT, id TEXT, revision INTEGER, body TEXT NOT NULL, PRIMARY KEY(kind,id,revision));`);
	}
	close() {
		this.db.close();
	}
	journal(): string[] {
		return this.db
			.query<{ id: string }, []>("SELECT id FROM forgotten ORDER BY id")
			.all()
			.map((r) => r.id);
	}
	load(): { generation: number; checkpoint: AgencySnapshot } | undefined {
		const row = this.db
			.query<{ generation: number; body: string }, []>(
				"SELECT generation,body FROM checkpoint WHERE id=1",
			)
			.get();
		if (!row) return undefined;
		const raw = JSON.parse(row.body) as AgencySnapshot;
		return {
			generation: row.generation,
			checkpoint: this.journal().length
				? prepareForgetting(raw, this.journal()).checkpoint
				: raw,
		};
	}
	get(id: string): ArchivedObservation | undefined {
		const row = this.db
			.query<{ body: string }, [string]>("SELECT body FROM archive WHERE id=?")
			.get(id);
		if (!row) return undefined;
		const entry = JSON.parse(row.body) as ArchivedObservation;
		const forgotten = new Set(this.journal());
		return !forgotten.has(id) && !dependsOn(entry.input, forgotten)
			? entry
			: undefined;
	}
	rows(): ItemRevision[] {
		return this.db
			.query<{ body: string }, []>("SELECT body FROM revisions ORDER BY rowid")
			.all()
			.map((r) => JSON.parse(r.body));
	}
	private assertGeneration(expected: number) {
		const actual =
			this.db
				.query<{ generation: number }, []>(
					"SELECT generation FROM checkpoint WHERE id=1",
				)
				.get()?.generation ?? 0;
		if (actual !== expected) throw new Error("stale checkpoint generation");
	}
	private write(
		checkpoint: AgencySnapshot,
		expected: number,
		rows: readonly ItemRevision[],
	) {
		if (!checkpoint.condition)
			throw new TypeError("checkpoint condition required");
		validateRestore(checkpoint, checkpoint.condition);
		this.assertGeneration(expected);
		for (const id of checkpoint.forgottenRefs ?? [])
			this.db.query("INSERT OR IGNORE INTO forgotten VALUES (?)").run(id);
		const forgotten = new Set(this.journal());
		const safe = forgotten.size
			? prepareForgetting(checkpoint, [...forgotten]).checkpoint
			: checkpoint;
		const previous = this.load()?.checkpoint;
		if (
			!previous &&
			safe.compactedThrough &&
			safe.observations.length <
				Math.max(safe.cursor, safe.observations.at(-1)?.seq ?? 0)
		)
			throw new Error("import a full checkpoint before compaction");
		const retained = new Map(safe.observations.map((o) => [o.id, o]));
		for (const old of previous?.observations ?? []) {
			if (forgotten.has(old.id)) continue;
			const kept = retained.get(old.id);
			if (!kept && !this.get(old.id))
				throw new Error("removed observation requires atomic archive");
			if (kept && JSON.stringify(kept) !== JSON.stringify(old))
				throw new Error("observation identity conflict");
		}
		const history = redactRevisions([...this.rows(), ...rows], forgotten);
		const versions = new Map<string, string>();
		for (const row of history) {
			const key = JSON.stringify([row.itemKind, row.itemId, row.revision]);
			const body = JSON.stringify(row);
			if (versions.has(key) && versions.get(key) !== body)
				throw new Error("conflicting item revision");
			versions.set(key, body);
		}
		for (const row of history)
			this.db
				.query("INSERT OR REPLACE INTO revisions VALUES (?,?,?,?)")
				.run(row.itemKind, row.itemId, row.revision, JSON.stringify(row));
		this.db
			.query("INSERT OR REPLACE INTO checkpoint VALUES (1,?,?)")
			.run(expected + 1, JSON.stringify(safe));
		return expected + 1;
	}
	/** Checkpoint and the revision batch are one durable transaction; callers keep their old runtime until success. */
	save(
		checkpoint: AgencySnapshot,
		expected: number,
		rows: readonly ItemRevision[] = [],
	): number {
		return this.db
			.transaction(() => this.write(checkpoint, expected, rows))
			.immediate();
	}
	compact(expected: number, keepRecent = 64): number {
		return this.db
			.transaction(() => {
				this.assertGeneration(expected);
				const current = this.load();
				if (!current) throw new Error("no checkpoint");
				const plan = prepareCompaction(current.checkpoint, keepRecent);
				for (const entry of plan.archive) {
					const known = this.get(entry.observation.id);
					if (known && JSON.stringify(known) !== JSON.stringify(entry))
						throw new Error("archive identity conflict");
					this.db
						.query("INSERT OR IGNORE INTO archive VALUES (?,?)")
						.run(entry.observation.id, JSON.stringify(entry));
				}
				return this.write(plan.checkpoint, expected, []);
			})
			.immediate();
	}
	forget(refs: readonly string[], expected: number): number {
		return this.db
			.transaction(() => {
				this.assertGeneration(expected);
				const current = this.load();
				if (!current) throw new Error("no checkpoint");
				const plan = prepareForgetting(current.checkpoint, refs);
				const forgotten = new Set(plan.checkpoint.forgottenRefs);
				for (const row of this.db
					.query<{ id: string; body: string }, []>(
						"SELECT id,body FROM archive",
					)
					.all()) {
					const entry = JSON.parse(row.body) as ArchivedObservation;
					if (forgotten.has(row.id) || dependsOn(entry.input, forgotten)) {
						forgotten.add(row.id);
						this.db.query("DELETE FROM archive WHERE id=?").run(row.id);
					}
				}
				return this.write(
					{ ...plan.checkpoint, forgottenRefs: [...forgotten] },
					expected,
					[],
				);
			})
			.immediate();
	}
}
