/** Example host storage: Memory owns source bodies and the forgetting journal protocol. */
import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import {
	closeSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
	LIMITS_EXTERNAL,
	verifyForgetJournal,
	type AccessContext,
	type ForgetJournalEntry,
	type ForgetReceipt,
} from "eumenes-memory";
import {
	applyForget,
	assertMemorySchema,
	captureRecord,
	getForgetReceipt,
	listMemoryChanges,
	migrations,
	planForget,
	readRecord,
	reconcileForgetJournal,
	recordExternalDeletion,
	registerExternalDependents,
	unregisterExternalDependents,
} from "eumenes-memory/sqlite";
import {
	prepareCompaction,
	prepareForgetting,
	type AgencySnapshot,
	type ArchivedObservation,
	type InputContext,
	type Observation,
} from "../../src/index.ts";
import { dependsOn } from "../../src/application/memory.ts";

const providerRef = "agency-example";
const scopeKey = "conversation:virtual";
export const exampleAccess: AccessContext = {
	principal: "example-user",
	scopeKeys: [scopeKey],
	purpose: "agency-evaluation",
	policyRevision: "1",
};
interface SourceRow {
	id: string;
	record_id: string;
	revision: string;
	source_key: string;
	input: string;
}
interface Envelope {
	checkpoint: Omit<AgencySnapshot, "observations">;
	observations: Pick<Observation, "id" | "seq" | "kind" | "occurredAt">[];
}

export class MemoryBridge {
	readonly db: Database;
	readonly databasePath: string;
	readonly journalPath: string;
	private generation = 0;
	private clock = 0;
	private failed = false;
	constructor(
		directory: string,
		readonly access: AccessContext = exampleAccess,
	) {
		mkdirSync(directory, { recursive: true });
		this.databasePath = join(directory, "host.sqlite");
		this.journalPath = join(directory, "memory-forget.jsonl");
		const fresh = !existsSync(this.databasePath);
		this.db = new Database(this.databasePath, { create: true, strict: true });
		try {
			this.db.exec(
				"PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;",
			);
			if (fresh)
				this.db
					.transaction(() => {
						for (const sql of migrations) this.db.exec(sql);
					})
					.immediate();
			assertMemorySchema(this.db);
			this.db
				.exec(`CREATE TABLE IF NOT EXISTS example_owner(id INTEGER PRIMARY KEY CHECK(id=1), principal TEXT NOT NULL, scope TEXT NOT NULL);
			CREATE TABLE IF NOT EXISTS example_sources(id TEXT PRIMARY KEY, record_id TEXT UNIQUE NOT NULL, revision TEXT NOT NULL, source_key TEXT UNIQUE NOT NULL, input TEXT NOT NULL);
			CREATE TABLE IF NOT EXISTS example_checkpoint(id INTEGER PRIMARY KEY CHECK(id=1), generation INTEGER NOT NULL, body TEXT NOT NULL);
			CREATE TABLE IF NOT EXISTS example_dependents(id TEXT PRIMARY KEY);
			CREATE TABLE IF NOT EXISTS example_feed(id INTEGER PRIMARY KEY CHECK(id=1), seq INTEGER NOT NULL);`);
			this.db
				.transaction(() => {
					this.db
						.query("INSERT OR IGNORE INTO example_owner VALUES (1,?,?)")
						.run(access.principal, scopeKey);
					const owner = this.db
						.query<{ principal: string; scope: string }, []>(
							"SELECT principal,scope FROM example_owner WHERE id=1",
						)
						.get()!;
					if (
						owner.principal !== access.principal ||
						owner.scope !== scopeKey ||
						!access.scopeKeys.includes(scopeKey)
					)
						throw new Error("host scope not permitted");
				})
				.immediate();
			const result = this.db
				.transaction(() =>
					reconcileForgetJournal(this.db, {
						contractVersion: 1,
						entries: this.entries(),
						clock: this.now(),
					}),
				)
				.immediate();
			if (result.status !== "ok")
				throw new Error(`Memory journal: ${result.reasonCode}`);
			// Startup always resyncs: an operator may have restored an older DB even without a new forget.
			this.db.query("INSERT OR REPLACE INTO example_feed VALUES (1,0)").run();
			this.generation = this.current()?.generation ?? 0;
			this.synchronize();
		} catch (error) {
			this.db.close();
			throw error;
		}
	}
	private now() {
		return { atMs: ++this.clock };
	}
	private header() {
		return {
			contractVersion: 1 as const,
			access: this.access,
			scopeKey,
			clock: this.now(),
		};
	}
	private check() {
		if (this.failed)
			throw new Error("host requires restart after failed mutation");
	}
	private entries(): ForgetJournalEntry[] {
		const text = existsSync(this.journalPath)
			? readFileSync(this.journalPath, "utf8")
			: "";
		if (text && !text.endsWith("\n"))
			throw new Error("truncated Memory journal");
		const entries = text.trim()
			? text
					.trim()
					.split("\n")
					.map((line) => JSON.parse(line) as ForgetJournalEntry)
			: [];
		if (verifyForgetJournal(entries).status !== "ok")
			throw new Error("invalid Memory journal");
		return entries;
	}
	private append(entry: ForgetJournalEntry) {
		const fd = openSync(this.journalPath, "a", 0o600);
		try {
			writeFileSync(fd, JSON.stringify(entry) + "\n");
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		const dir = openSync(join(this.journalPath, ".."), "r");
		try {
			fsyncSync(dir);
		} finally {
			closeSync(dir);
		}
	}
	private current() {
		return this.db
			.query<{ generation: number; body: string }, []>(
				"SELECT generation,body FROM example_checkpoint WHERE id=1",
			)
			.get();
	}
	private sources() {
		return this.db
			.query<SourceRow, []>("SELECT * FROM example_sources ORDER BY rowid")
			.all();
	}
	private source(id: string) {
		return this.db
			.query<SourceRow, [string]>("SELECT * FROM example_sources WHERE id=?")
			.get(id);
	}
	private read(row: SourceRow) {
		return readRecord(this.db, {
			contractVersion: 1,
			access: this.access,
			scopeKey,
			recordId: row.record_id,
			revision: row.revision,
		});
	}
	get(id: string): ArchivedObservation | undefined {
		this.check();
		return this.db.transaction(() => {
			const row = this.source(id);
			if (!row) return undefined;
			const result = this.read(row);
			if (result.status === "forgotten") return undefined;
			if (result.status !== "available")
				throw new Error("canonical Memory source unavailable");
			const input = JSON.parse(row.input) as InputContext;
			// Do not expose a derived record while a source deletion still awaits synchronization.
			if (!input.complete)
				throw new Error("incomplete canonical input manifest");
			if (
				input.sources.some((ref) => {
					const source = this.source(ref);
					if (!source) throw new Error("canonical input source missing");
					const dependency = this.read(source);
					if (dependency.status === "forgotten") return true;
					if (dependency.status !== "available")
						throw new Error("canonical input source unavailable");
					return false;
				})
			)
				return undefined;
			return JSON.parse(result.content) as ArchivedObservation;
		})();
	}
	load(): AgencySnapshot | undefined {
		this.check();
		const row = this.current();
		if (!row) return undefined;
		const envelope = JSON.parse(row.body) as Envelope;
		const forgotten = new Set(envelope.checkpoint.forgottenRefs);
		const observations = envelope.observations.flatMap((meta) => {
			const entry = this.get(meta.id);
			if (entry) {
				if (
					entry.observation.id !== meta.id ||
					entry.observation.seq !== meta.seq
				)
					throw new Error("canonical observation identity mismatch");
				return [entry.observation];
			}
			if (!this.source(meta.id))
				throw new Error("checkpoint source mapping missing");
			forgotten.add(meta.id);
			return meta.seq > envelope.checkpoint.cursor
				? [{ ...meta, actor: "host" as const, text: "" }]
				: [];
		});
		const snapshot = {
			...envelope.checkpoint,
			observations,
			compactedThrough: envelope.checkpoint.cursor,
		};
		return forgotten.size
			? prepareForgetting(snapshot, [...forgotten]).checkpoint
			: snapshot;
	}
	save(snapshot: AgencySnapshot): void {
		this.check();
		try {
			this.db.transaction(() => this.write(snapshot)).immediate();
		} catch (error) {
			this.failed = true;
			throw error;
		}
		this.generation++;
	}
	private write(snapshot: AgencySnapshot) {
		if ((this.current()?.generation ?? 0) !== this.generation)
			throw new Error("stale host generation");
		const provenance = new Map(snapshot.provenance?.entries);
		for (const observation of snapshot.observations) {
			if (snapshot.forgottenRefs?.includes(observation.id)) continue;
			const input = provenance.get(`observation:${observation.id}`) ?? {
				sources: [observation.id, ...(observation.refs ?? [])],
				complete: observation.actor === "user",
			};
			if (!input.complete)
				throw new Error("complete host input provenance required");
			const entry: ArchivedObservation = { observation, input };
			const previous = this.source(observation.id);
			if (previous) {
				const known = this.read(previous);
				if (
					known.status !== "available" ||
					!isDeepStrictEqual(JSON.parse(known.content), entry)
				)
					throw new Error("immutable observation conflict");
				continue;
			}
			const result = captureRecord(this.db, {
				...this.header(),
				origin: {
					namespace: "agency-example",
					kind: "observation",
					id: observation.id,
				},
				mediaType: "application/json",
				content: JSON.stringify(entry),
				captureState: "complete",
			});
			if (result.status !== "captured")
				throw new Error(`Memory capture: ${result.reasonCode}`);
			// SourceKey's documented tuple format; no private Memory imports.
			const key = JSON.stringify([
				result.ref.namespace,
				result.ref.kind,
				result.ref.id,
				result.ref.representation ?? null,
			]);
			this.db
				.query("INSERT INTO example_sources VALUES (?,?,?,?,?)")
				.run(
					observation.id,
					result.recordId,
					result.revision,
					key,
					JSON.stringify(input),
				);
		}
		const ids = new Set([
			...snapshot.observations
				.filter((o) => !snapshot.forgottenRefs?.includes(o.id))
				.map((o) => o.id),
			...[...provenance.values()].flatMap((input) => {
				if (!input.complete) throw new Error("incomplete derived provenance");
				return input.sources;
			}),
		]);
		const dependencies = [...ids].map((id) => {
			const row = this.source(id);
			if (!row || this.read(row).status !== "available")
				throw new Error("unavailable Memory dependency");
			return { type: "source" as const, id: row.source_key };
		});
		const old = this.db
			.query<{ id: string }, []>("SELECT id FROM example_dependents")
			.all();
		const newIds: string[] = [];
		// Memory permits 32 dependencies per dependent. Each chunk protects the same checkpoint.
		for (
			let start = 0;
			start < dependencies.length;
			start += LIMITS_EXTERNAL.maxDependenciesPerDependent
		) {
			const id = `${randomUUID()}:${start}`;
			const result = registerExternalDependents(this.db, {
				...this.header(),
				dependents: [
					{
						providerRef,
						externalId: id,
						dependsOn: dependencies.slice(
							start,
							start + LIMITS_EXTERNAL.maxDependenciesPerDependent,
						),
					},
				],
			});
			if (result.status !== "registered")
				throw new Error(`Memory dependencies: ${result.reasonCode}`);
			newIds.push(id);
		}
		const { observations, ...checkpoint } = snapshot;
		const envelope: Envelope = {
			checkpoint,
			observations: observations.map(({ id, seq, kind, occurredAt }) => ({
				id,
				seq,
				kind,
				occurredAt,
			})),
		};
		this.db
			.query("INSERT OR REPLACE INTO example_checkpoint VALUES (1,?,?)")
			.run(this.generation + 1, JSON.stringify(envelope));
		for (const dependent of old) {
			const result = unregisterExternalDependents(this.db, {
				...this.header(),
				dependents: [{ providerRef, externalId: dependent.id }],
			});
			if (result.status !== "unregistered")
				throw new Error("Memory unregister blocked");
		}
		this.db.query("DELETE FROM example_dependents").run();
		for (const id of newIds)
			this.db.query("INSERT INTO example_dependents VALUES (?)").run(id);
	}
	compact(keepRecent = 30) {
		const snapshot = this.load();
		if (!snapshot) throw new Error("no checkpoint");
		const plan = prepareCompaction(snapshot, keepRecent);
		for (const entry of plan.archive)
			if (!isDeepStrictEqual(this.get(entry.observation.id), entry))
				throw new Error("Memory archive mismatch");
		this.save(plan.checkpoint);
		return plan.archive.length;
	}
	private forgetRecord(recordId: string): ForgetReceipt {
		const result = planForget(this.db, {
			contractVersion: 1,
			access: this.access,
			target: { type: "record", recordId, scopeKey },
			clock: this.now(),
		});
		if (result.status !== "planned")
			throw new Error(`Memory forget blocked: ${result.reasonCode}`);
		this.append(result.plan.entry);
		return this.db
			.transaction(() =>
				applyForget(this.db, {
					contractVersion: 1,
					entry: result.plan.entry,
					clock: this.now(),
				}),
			)
			.immediate();
	}
	forget(id: string): ForgetReceipt {
		this.check();
		try {
			const row = this.source(id);
			if (!row) throw new Error("unknown observation");
			const receipt = this.forgetRecord(row.record_id);
			this.synchronize();
			return this.receipt(receipt.forgetId);
		} catch (error) {
			this.failed = true;
			throw error;
		}
	}
	receipt(forgetId: string): ForgetReceipt {
		const result = getForgetReceipt(this.db, {
			contractVersion: 1,
			access: this.access,
			forgetId,
		});
		if (result.status !== "found")
			throw new Error("forget receipt unavailable");
		return result.receipt;
	}
	synchronize() {
		this.check();
		const forgotten = new Set<string>();
		let after =
			this.db
				.query<{ seq: number }, []>("SELECT seq FROM example_feed WHERE id=1")
				.get()?.seq ?? 0;
		for (;;) {
			const page = listMemoryChanges(this.db, {
				contractVersion: 1,
				access: this.access,
				scopeKeys: [scopeKey],
				afterSeq: after,
				limit: 500,
			});
			if (page.status !== "ok") throw new Error("Memory feed blocked");
			for (const change of page.changes)
				if (change.status === "forgotten") {
					const row = this.db
						.query<SourceRow, [string, string]>(
							"SELECT * FROM example_sources WHERE record_id=? OR source_key=?",
						)
						.get(change.targetId, change.targetId);
					if (row) forgotten.add(row.id);
				}
			after = page.nextAfterSeq;
			if (!page.hasMore) break;
		}
		const rows = this.sources();
		let expanded = true;
		while (expanded) {
			expanded = false;
			for (const row of rows)
				if (
					!forgotten.has(row.id) &&
					dependsOn(JSON.parse(row.input) as InputContext, forgotten)
				) {
					forgotten.add(row.id);
					expanded = true;
				}
		}
		// Derived observation bodies are also Memory Records; delete them through Memory, too.
		for (const row of rows)
			if (forgotten.has(row.id) && this.read(row).status === "available")
				this.forgetRecord(row.record_id);
		const snapshot = this.load();
		if (snapshot && forgotten.size)
			this.save(prepareForgetting(snapshot, [...forgotten]).checkpoint);
		this.db
			.transaction(() => {
				for (const entry of this.entries()) {
					const receipt = this.receipt(entry.forgetId);
					for (const external of receipt.externalDeletions)
						if (
							external.providerRef === providerRef &&
							external.externalId !== null
						) {
							if (
								this.db
									.query("SELECT id FROM example_dependents WHERE id=?")
									.get(external.externalId)
							)
								throw new Error("dependent still retained");
							const result = recordExternalDeletion(this.db, {
								contractVersion: 1,
								access: this.access,
								clock: this.now(),
								forgetId: entry.forgetId,
								providerRef,
								externalId: external.externalId,
								state: "confirmed",
							});
							if (result.status !== "recorded")
								throw new Error("Memory deletion acknowledgement failed");
						}
				}
				this.db
					.query("INSERT OR REPLACE INTO example_feed VALUES (1,?)")
					.run(after);
			})
			.immediate();
	}
	close() {
		this.db.close();
	}
}
