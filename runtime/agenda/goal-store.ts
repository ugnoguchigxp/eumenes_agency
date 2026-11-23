import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { NoteRef } from "../../src/agenda/index.ts";
import type { GoalMemoryRef } from "./host-memory.ts";
import type { GoalDesignRef, GoalPreparation } from "./goal-design.ts";

export const GOAL_SLOTS = 10;
export const CLAUDE_CODE = {
	revisionId: "toolchain:claude-code.request@4",
	operation: "claude-code.request",
	description:
		"Claude Code (claude_code)。利用者が指定した作業先でコード・文書の調査、変更、確認を行い、成果物を返す。既存ファイルの変更には利用者の許可が必要。",
	impact: "modify_existing",
} as const;

export interface GoalAccess {
	readonly principal: string;
	readonly scopeKeys: readonly string[];
}

export interface GoalTarget {
	readonly slot: number;
	readonly goalId: string;
	readonly revision: number;
}

type GoalSource = { namespace: string; kind: string; id: string };
type Transition = { expectedRevision: number; source: GoalSource };
type Adoption = {
	scopeKey: string;
	desiredState: string;
	priority: number;
	source: GoalSource;
	operationKey: string;
	sourceMessageIds?: readonly string[];
};
type Revision = Transition & { desiredState?: string; priority?: number };

export interface StoredGoal {
	readonly goalId: string;
	readonly scopeKey: string;
	readonly revision: number;
	readonly desiredState: string;
	readonly priority: number;
	readonly status: "proposed" | "adopted" | "withdrawn" | "completed";
}

export interface WorkRequest {
	readonly workId: string;
	readonly goalId: string;
	readonly goalRevision: number;
	readonly toolchainRevisionId: string;
	readonly operationId: typeof CLAUDE_CODE.operation;
	readonly design?: GoalDesignRef;
	readonly workspace: string;
	readonly args: {
		readonly task: string;
		readonly prompt: string;
		readonly session: "current";
	};
}

export interface GoalWork {
	readonly request: WorkRequest;
	readonly principal: string;
	readonly scopeKey: string;
	readonly permitId: string;
	readonly analysis: string;
	readonly shownMemory: readonly GoalMemoryRef[];
	readonly usedMemory: readonly string[];
}

export interface GoalReport {
	readonly id: string;
	readonly work: GoalWork;
	readonly goalRevision: number;
	readonly artifactId: string;
	readonly text: string;
}

// From the source checkout, the CLI looks next to Agency. An installed host can pass its root.
export const eumenesRoot = () =>
	resolve(
		process.env.EUMENES_ROOT ?? join(import.meta.dir, "../../../eumenes"),
	);
export const hasGoalSource = (root = eumenesRoot()) =>
	existsSync(join(root, "api/domains/goals/index.ts"));
type Migration = { id: string; sql: string; after?: readonly string[] };
interface GoalsModule {
	readonly migrations: readonly Migration[];
	createGoalsService(clock: () => string): {
		listForStewardInTransaction(db: Database, access: GoalAccess): StoredGoal[];
		adoptInTransaction(
			db: Database,
			access: GoalAccess,
			input: Omit<Adoption, "sourceMessageIds"> & {
				sourceMessageIds?: string[];
			},
		): { id: string };
		updateInTransaction(
			db: Database,
			access: GoalAccess,
			id: string,
			input: Revision,
		): unknown;
		withdrawInTransaction(
			db: Database,
			access: GoalAccess,
			id: string,
			input: Transition,
		): unknown;
		completeInTransaction(
			db: Database,
			access: GoalAccess,
			id: string,
			input: Transition,
		): { revision: number };
	};
}
interface Store {
	read<T>(f: (db: Database) => T): T;
	readSnapshot<T>(
		f: (db: Database) => T extends PromiseLike<unknown> ? never : T,
	): T;
	write<T>(f: (db: Database) => T): Promise<T>;
	close(): Promise<void>;
}

export type GoalDocument = NoteRef & {
	readonly documentId: string;
	readonly conversationId: string;
	readonly inputs: readonly string[];
	readonly memory: readonly GoalMemoryRef[];
	readonly goalId: string;
	readonly allResearchInputs?: true;
};

const migration = {
	id: "agency-goals/0001-verification",
	after: ["goals/0003-sources"],
	sql: `
		CREATE TABLE goal_slots (
			principal TEXT NOT NULL, slot INTEGER NOT NULL CHECK(slot BETWEEN 1 AND 10),
			goal_id TEXT NOT NULL UNIQUE REFERENCES goals_ledger(id) ON DELETE CASCADE, PRIMARY KEY(principal, slot)
		);
		CREATE TABLE goal_slot_operations (
			principal TEXT NOT NULL, scope_key TEXT NOT NULL, operation_id TEXT NOT NULL,
			slot INTEGER NOT NULL, PRIMARY KEY(principal, scope_key, operation_id)
		);
		CREATE TABLE goal_permits (
			id TEXT PRIMARY KEY, principal TEXT NOT NULL, scope_key TEXT NOT NULL,
			goal_id TEXT NOT NULL, goal_revision INTEGER NOT NULL, toolchain TEXT NOT NULL,
			workspace TEXT NOT NULL, impact TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0
		);
		CREATE TABLE goal_work (
			id TEXT PRIMARY KEY, principal TEXT NOT NULL, goal_id TEXT NOT NULL,
			goal_revision INTEGER NOT NULL, payload TEXT NOT NULL,
			state TEXT NOT NULL, reason TEXT, acknowledged INTEGER NOT NULL DEFAULT 0
		);
		CREATE UNIQUE INDEX one_open_goal_work ON goal_work(principal)
			WHERE state IN ('reserved', 'accepted', 'confirmation_pending');
		CREATE TABLE goal_reports (
			id TEXT PRIMARY KEY, principal TEXT NOT NULL, payload TEXT NOT NULL,
			state TEXT NOT NULL DEFAULT 'pending'
		);
	`,
} as const;

const preparationMigration = {
	id: "agency-goals/0002-preparation",
	after: [migration.id],
	sql: `CREATE TABLE goal_preparations (
		goal_id TEXT NOT NULL REFERENCES goals_ledger(id) ON DELETE CASCADE,
		goal_revision INTEGER NOT NULL, payload TEXT NOT NULL,
		PRIMARY KEY(goal_id, goal_revision)
	);`,
} as const;

const designPermitMigration = {
	id: "agency-goals/0003-design-permit",
	after: [preparationMigration.id],
	sql: `ALTER TABLE goal_permits ADD COLUMN design_note_id TEXT;
		ALTER TABLE goal_permits ADD COLUMN design_digest TEXT;
		UPDATE goal_permits AS permit
		SET (design_note_id, design_digest) = (
			SELECT json_extract(prep.payload, '$.note.id'), json_extract(prep.payload, '$.note.digest')
			FROM goal_preparations AS prep
			WHERE prep.goal_id=permit.goal_id AND prep.goal_revision=permit.goal_revision
		);`,
} as const;

type WorkState =
	| "reserved"
	| "accepted"
	| "confirmation_pending"
	| "partial"
	| "failed"
	| "invalidated"
	| "completed";
type WorkRow = {
	readonly payload: string;
	readonly state: WorkState;
	readonly reason: string | null;
	readonly acknowledged: number;
};
export interface WorkRecord {
	readonly work: GoalWork;
	readonly state: WorkState;
	readonly reason: string | null;
	readonly acknowledged: boolean;
}
const record = (row: WorkRow): WorkRecord => ({
	work: JSON.parse(row.payload) as GoalWork,
	state: row.state,
	reason: row.reason,
	acknowledged: row.acknowledged === 1,
});

const documentMigration = {
	id: "agency-goals/0004-design-documents",
	after: [designPermitMigration.id],
	sql: `CREATE TABLE goal_design_documents (
		id TEXT PRIMARY KEY, principal TEXT NOT NULL, scope_key TEXT NOT NULL, payload TEXT NOT NULL
	);
	CREATE INDEX goal_design_documents_scope ON goal_design_documents(principal, scope_key);`,
} as const;

export const goalMigrations = [
	migration,
	preparationMigration,
	designPermitMigration,
	documentMigration,
] as const;

export async function openGoalStore(
	dir: string,
	clock: () => number,
	root = eumenesRoot(),
) {
	root = resolve(root);
	if (!hasGoalSource(root))
		throw new Error(`Eumenes Goals source is required at ${root}`);
	const [domain, sqlite] = await Promise.all([
		import(join(root, "api/domains/goals/index.ts")) as Promise<GoalsModule>,
		import(join(root, "api/infrastructure/sqlite/index.ts")) as Promise<{
			openStore(path: string, migrations: readonly Migration[]): Store;
		}>,
	]);
	const store = sqlite.openStore(join(dir, "goals.sqlite3"), [
		...domain.migrations,
		...goalMigrations,
	]);
	const goals = domain.createGoalsService(() =>
		new Date(clock()).toISOString(),
	);
	return { ...createGoalStore(store, goals), close: () => store.close() };
}

export function createGoalStore(
	store: Omit<Store, "close">,
	goals: ReturnType<GoalsModule["createGoalsService"]>,
	registrationScope?: {
		readonly agendaScopeKey: string;
		readonly ledgerScopeKey: string;
	},
) {
	const registrationScopeFor = (access: GoalAccess) =>
		registrationScope &&
		access.scopeKeys.includes(registrationScope.agendaScopeKey)
			? registrationScope
			: undefined;
	const ledgerAccess = (access: GoalAccess): GoalAccess => {
		const scope = registrationScopeFor(access);
		return scope
			? { ...access, scopeKeys: [...access.scopeKeys, scope.ledgerScopeKey] }
			: access;
	};
	const visible = (db: Database, access: GoalAccess) => {
		if (!access.scopeKeys.length) return [];
		const rows = goals.listForStewardInTransaction(db, ledgerAccess(access));
		const scope = registrationScopeFor(access);
		// Keep the Agenda scope used by Memory, design documents and existing work.
		return scope
			? rows.map((goal) =>
					goal.scopeKey === scope.ledgerScopeKey
						? { ...goal, scopeKey: scope.agendaScopeKey }
						: goal,
				)
			: rows;
	};
	const slotNumber = (slot: number) => {
		if (!Number.isInteger(slot) || slot < 1 || slot > GOAL_SLOTS)
			throw new RangeError("invalid_goal_slot");
	};
	const occupant = (db: Database, principal: string, slot: number) =>
		db
			.query<{ goal_id: string }, [string, number]>(
				"SELECT goal_id FROM goal_slots WHERE principal=? AND slot=?",
			)
			.get(principal, slot)?.goal_id;
	const atSlot = (db: Database, access: GoalAccess, target: GoalTarget) => {
		slotNumber(target.slot);
		const id = occupant(db, access.principal, target.slot);
		const goal = visible(db, access).find((g) => g.goalId === id);
		if (!goal) throw new Error("invalid_goal");
		if (goal.goalId !== target.goalId) throw new Error("goal_conflict");
		if (goal.revision !== target.revision) throw new Error("revision_conflict");
		return goal;
	};
	const preparation = (db: Database, goalId: string, revision: number) => {
		const row = db
			.query<{ payload: string }, [string, number]>(
				"SELECT payload FROM goal_preparations WHERE goal_id=? AND goal_revision=?",
			)
			.get(goalId, revision);
		return row ? (JSON.parse(row.payload) as GoalPreparation) : null;
	};
	const workRows = (db: Database, principal: string) =>
		db
			.query<WorkRow, [string]>(
				"SELECT payload, state, reason, acknowledged FROM goal_work WHERE principal=? ORDER BY rowid",
			)
			.all(principal)
			.map(record);
	const activePermit = (
		db: Database,
		principal: string,
		goal: Pick<StoredGoal, "goalId" | "scopeKey" | "revision">,
		workspace: string,
	) =>
		db
			.query<
				{
					id: string;
					design_note_id: string | null;
					design_digest: string | null;
				},
				[string, string, string, number, string, string, string]
			>(`
			SELECT id, design_note_id, design_digest FROM goal_permits WHERE principal=? AND scope_key=? AND goal_id=?
			AND goal_revision=? AND toolchain=? AND workspace=? AND impact=? AND revoked=0
			ORDER BY rowid DESC LIMIT 1
		`)
			.get(
				principal,
				goal.scopeKey,
				goal.goalId,
				goal.revision,
				CLAUDE_CODE.revisionId,
				workspace,
				CLAUDE_CODE.impact,
			);
	const revokePermit = (db: Database, id: string) =>
		db.query("UPDATE goal_permits SET revoked=1 WHERE id=?").run(id);
	const permitMatches = (
		permit: NonNullable<ReturnType<typeof activePermit>>,
		design: GoalDesignRef | null,
	) =>
		permit.design_note_id === (design?.id ?? null) &&
		permit.design_digest === (design?.digest ?? null);
	const setWork = (
		db: Database,
		id: string,
		state: WorkState,
		reason: string | null,
	) =>
		db
			.query(
				"UPDATE goal_work SET state=?, reason=?, acknowledged=MAX(acknowledged, ?) WHERE id=?",
			)
			.run(state, reason, Number(state === "accepted"), id);

	return {
		rememberDocumentInTransaction(
			db: Database,
			principal: string,
			scopeKey: string,
			document: GoalDocument,
		) {
			db.query("INSERT INTO goal_design_documents VALUES (?, ?, ?, ?)").run(
				document.id,
				principal,
				scopeKey,
				JSON.stringify(document),
			);
		},
		documentsInTransaction(db: Database, principal: string, scopeKey: string) {
			return db
				.query<{ payload: string }, [string, string]>(
					"SELECT payload FROM goal_design_documents WHERE principal=? AND scope_key=? ORDER BY rowid",
				)
				.all(principal, scopeKey)
				.map(({ payload }) => JSON.parse(payload) as GoalDocument);
		},
		hasAllResearchInputsInTransaction(db: Database, document: GoalDocument) {
			if (document.allResearchInputs) return true;
			// Older documents only saved the citations chosen by the designer.
			const prior = db
				.query<{ payload: string }, [string, string]>(
					`SELECT payload FROM goal_preparations WHERE goal_id=? AND json_extract(payload, '$.note.id')=?`,
				)
				.get(document.goalId, document.id);
			const input = prior && (JSON.parse(prior.payload) as GoalPreparation);
			return (
				input?.researchVersions?.every(({ id }) =>
					document.refs.includes(`note:${id}`),
				) === true
			);
		},
		forgetDocumentInTransaction(db: Database, id: string) {
			db.query("DELETE FROM goal_design_documents WHERE id=?").run(id);
		},
		preparation: (goalId: string, revision: number) =>
			store.read((db) => preparation(db, goalId, revision)),
		prepare: (
			access: GoalAccess,
			goal: StoredGoal,
			save: (db: Database) => GoalPreparation | null,
		) =>
			store.write((db) => {
				if (
					!visible(db, access).some(
						(g) =>
							g.goalId === goal.goalId &&
							g.revision === goal.revision &&
							g.status === "adopted",
					)
				)
					return null;
				const prepared = save(db);
				if (!prepared) return null;
				if (prepared.note && !preparation(db, goal.goalId, goal.revision)?.note)
					db.query(`UPDATE goal_permits SET design_note_id=?, design_digest=?
					WHERE principal=? AND scope_key=? AND goal_id=? AND goal_revision=?
					AND design_note_id IS NULL AND revoked=0`).run(
						prepared.note.id,
						prepared.note.digest,
						access.principal,
						goal.scopeKey,
						goal.goalId,
						goal.revision,
					);
				db.query(`INSERT INTO goal_preparations VALUES (?, ?, ?)
				ON CONFLICT(goal_id, goal_revision) DO UPDATE SET payload=excluded.payload`).run(
					goal.goalId,
					goal.revision,
					JSON.stringify(prepared),
				);
				return prepared;
			}),
		goal: (access: GoalAccess, id: string) =>
			store.read((db) => visible(db, access).find((g) => g.goalId === id)),
		list: (access: GoalAccess) =>
			store.readSnapshot((db) => {
				const byId = new Map(
					visible(db, access).map((goal) => [goal.goalId, goal]),
				);
				return Array.from({ length: GOAL_SLOTS }, (_, index) => {
					const slot = index + 1;
					const id = occupant(db, access.principal, slot);
					return { slot, goal: id ? (byId.get(id) ?? null) : null };
				});
			}),
		register: (
			access: GoalAccess,
			requestedSlot: number | null,
			input: Adoption,
		) =>
			store.write((db) => {
				if (requestedSlot !== null) slotNumber(requestedSlot);
				if (!access.scopeKeys.includes(input.scopeKey))
					throw new Error("goal_scope_forbidden");
				const ledgerScopeKey =
					registrationScope?.agendaScopeKey === input.scopeKey
						? registrationScope.ledgerScopeKey
						: input.scopeKey;
				// Operations written before the scope change replay against their original goal.
				const replay = db
					.query<
						{ slot: number; scope_key: string },
						[string, string, string, string]
					>(
						"SELECT slot, scope_key FROM goal_slot_operations WHERE principal=? AND scope_key IN (?, ?) AND operation_id=?",
					)
					.get(
						access.principal,
						input.scopeKey,
						ledgerScopeKey,
						input.operationKey,
					);
				const slot =
					requestedSlot ??
					replay?.slot ??
					Array.from({ length: GOAL_SLOTS }, (_, i) => i + 1).find(
						(i) => !occupant(db, access.principal, i),
					);
				if (slot === undefined) throw new Error("goal_slots_full");
				if (replay && replay.slot !== slot)
					throw new Error("operation_conflict");
				if (!replay && occupant(db, access.principal, slot))
					throw new Error("goal_slot_occupied");
				const { sourceMessageIds, ...adoption } = input;
				const goal = goals.adoptInTransaction(db, ledgerAccess(access), {
					...adoption,
					scopeKey: replay?.scope_key ?? ledgerScopeKey,
					...(sourceMessageIds
						? { sourceMessageIds: [...sourceMessageIds] }
						: {}),
				});
				if (!replay) {
					db.query("INSERT INTO goal_slots VALUES (?, ?, ?)").run(
						access.principal,
						slot,
						goal.id,
					);
					db.query("INSERT INTO goal_slot_operations VALUES (?, ?, ?, ?)").run(
						access.principal,
						ledgerScopeKey,
						input.operationKey,
						slot,
					);
				}
				return goal;
			}),
		revise: (
			access: GoalAccess,
			target: GoalTarget,
			input: Omit<Revision, "expectedRevision">,
		) =>
			store.write((db) =>
				goals.updateInTransaction(
					db,
					ledgerAccess(access),
					atSlot(db, access, target).goalId,
					{ ...input, expectedRevision: target.revision },
				),
			),
		withdraw: (
			access: GoalAccess,
			target: GoalTarget,
			input: Omit<Transition, "expectedRevision">,
		) =>
			store.write((db) =>
				goals.withdrawInTransaction(
					db,
					ledgerAccess(access),
					atSlot(db, access, target).goalId,
					{ ...input, expectedRevision: target.revision },
				),
			),
		release: (access: GoalAccess, target: GoalTarget) =>
			store.write((db) => {
				const goal = atSlot(db, access, target);
				if (goal.status !== "completed" && goal.status !== "withdrawn")
					throw new Error("goal_state_conflict");
				db.query("DELETE FROM goal_slots WHERE principal=? AND slot=?").run(
					access.principal,
					target.slot,
				);
			}),
		authorize: (
			access: GoalAccess,
			target: GoalTarget,
			workspace: string,
			expectedDesign: GoalDesignRef | null,
		) =>
			store.write((db) => {
				const goal = atSlot(db, access, target);
				if (goal.status !== "adopted") throw new Error("goal_state_conflict");
				const design =
					preparation(db, goal.goalId, goal.revision)?.note ?? null;
				if (
					design?.id !== expectedDesign?.id ||
					design?.digest !== expectedDesign?.digest
				)
					throw new Error("design_changed");
				const prior = activePermit(db, access.principal, goal, workspace);
				if (prior && permitMatches(prior, design)) return prior.id;
				if (prior?.design_note_id === null && design) {
					// Narrow an early whole-goal permit without replacing the ID of work already using it.
					db.query(
						"UPDATE goal_permits SET design_note_id=?, design_digest=? WHERE id=?",
					).run(design.id, design.digest, prior.id);
					return prior.id;
				}
				if (prior) revokePermit(db, prior.id);
				const id = randomUUID();
				db.query(`INSERT INTO goal_permits (id, principal, scope_key, goal_id, goal_revision, toolchain, workspace, impact, design_note_id, design_digest)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
					id,
					access.principal,
					goal.scopeKey,
					goal.goalId,
					goal.revision,
					CLAUDE_CODE.revisionId,
					workspace,
					CLAUDE_CODE.impact,
					design?.id ?? null,
					design?.digest ?? null,
				);
				return id;
			}),
		revoke: (access: GoalAccess, id: string) =>
			store.write((db) => {
				for (const scope of access.scopeKeys)
					db.query(
						"UPDATE goal_permits SET revoked=1 WHERE id=? AND principal=? AND scope_key=?",
					).run(id, access.principal, scope);
			}),
		permit: (
			principal: string,
			goal: StoredGoal,
			workspace: string,
			design: GoalDesignRef | null,
		) =>
			store.read((db) => {
				const permit = activePermit(db, principal, goal, workspace);
				return permit && permitMatches(permit, design) ? permit.id : undefined;
			}),
		revokeSlot: (access: GoalAccess, target: GoalTarget, workspace: string) =>
			store.write((db) => {
				const goal = atSlot(db, access, target);
				const permit = activePermit(db, access.principal, goal, workspace);
				if (permit) revokePermit(db, permit.id);
			}),
		work: (principal: string) => store.read((db) => workRows(db, principal)),
		reserve: (work: GoalWork, guard: (db: Database) => string | null) =>
			store.write((db) => {
				const reason = guard(db);
				if (reason) return reason;
				db.query(
					"INSERT INTO goal_work (id, principal, goal_id, goal_revision, payload, state) VALUES (?, ?, ?, ?, ?, 'reserved')",
				).run(
					work.request.workId,
					work.principal,
					work.request.goalId,
					work.request.goalRevision,
					JSON.stringify(work),
				);
				return null;
			}),
		setWork: (id: string, state: WorkState, reason: string | null = null) =>
			store.write((db) => setWork(db, id, state, reason)),
		complete: (
			access: GoalAccess,
			work: GoalWork,
			result: { artifactId: string; text: string },
			guard: (db: Database) => string | null,
		) =>
			store.write((db) => {
				const reason = guard(db);
				if (reason) return reason;
				const goal = goals.completeInTransaction(
					db,
					ledgerAccess(access),
					work.request.goalId,
					{
						expectedRevision: work.request.goalRevision,
						source: {
							namespace: "agency",
							kind: "artifact",
							id: result.artifactId,
						},
					},
				);
				const report: GoalReport = {
					...result,
					id: `${work.request.goalId}:${goal.revision}`,
					goalRevision: goal.revision,
					work,
				};
				db.query(
					"INSERT INTO goal_reports (id, principal, payload) VALUES (?, ?, ?)",
				).run(report.id, work.principal, JSON.stringify(report));
				setWork(db, work.request.workId, "completed", null);
				return report;
			}),
		pendingReports: (principal: string) =>
			store.read((db) =>
				db
					.query<{ payload: string }, [string]>(
						"SELECT payload FROM goal_reports WHERE principal=? AND state='pending' ORDER BY rowid",
					)
					.all(principal)
					.map((row) => JSON.parse(row.payload) as GoalReport),
			),
		deliveredReports: (access: GoalAccess) =>
			store.read((db) =>
				db
					.query<{ payload: string }, [string]>(
						"SELECT payload FROM goal_reports WHERE principal=? AND state='delivered' ORDER BY rowid",
					)
					.all(access.principal)
					.map((row) => JSON.parse(row.payload) as GoalReport)
					.filter((report) => access.scopeKeys.includes(report.work.scopeKey))
					.map(({ id, work, goalRevision, text }) => ({
						id,
						goalId: work.request.goalId,
						goalRevision,
						text,
					})),
			),
		setReport: (id: string, state: "delivered" | "invalidated") =>
			store.write((db) => {
				db.query(
					"UPDATE goal_reports SET state=? WHERE id=? AND state='pending'",
				).run(state, id);
			}),
	};
}

export type GoalStore = ReturnType<typeof createGoalStore>;
