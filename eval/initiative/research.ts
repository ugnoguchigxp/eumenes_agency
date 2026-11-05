import { Database } from "bun:sqlite";
import { resolve } from "node:path";
import type {
	ActionTicket,
	AgencyRuntime,
	ToolCapability,
} from "../../src/index.ts";

/** Use Eumenes' catalog projection and admission transaction with a disposable store and inert worker. */
export async function createResearchFixture(host: string, now: number) {
	const { createAgencyStatePort } = await import(
		resolve(host, "api/domains/dialogue/service/agency-state.ts")
	);
	const { agencyMigration, dispatchClockMigration } = await import(
		resolve(host, "api/domains/dialogue/repository/agency.ts")
	);
	const { researchTools, researchInput } = await import(
		resolve(host, "api/application/agency/research.ts")
	);
	const card = {
		revisionId: "catalog1",
		title: "公開資料調査",
		summary: "公開資料の読み取り調査",
		minImpact: "read",
	};
	const entry = { revisionId: card.revisionId, runtime: { route: "web" } };
	// The inert worker only counts starts; nothing is executed or sent.
	let workerStarts = 0;
	const state = createAgencyStatePort({
		now: () => now,
		toolchains: {
			catalogInTransaction: () => [entry],
			cardInTransaction: () => card,
			resolveInTransaction: () => ({
				...entry,
				packageRevisionId: card.revisionId,
			}),
		},
		agents: {
			startInTransaction: () => {
				workerStarts++;
				return { taskId: "fixture-worker" };
			},
		},
	});
	const db = new Database(":memory:");
	try {
		db.exec(agencyMigration);
		db.exec(dispatchClockMigration);
		const tools: readonly ToolCapability[] = researchTools(
			{ read: (fn: (db: Database) => unknown) => fn(db) },
			state,
		);
		return {
			tools,
			/** `failSave`: the checkpoint write fails inside the admission transaction (P0 save-failure case). */
			admit(
				ticket: ActionTicket,
				runtime: AgencyRuntime,
				scope: string,
				fault: { failSave?: boolean } = {},
			) {
				const input = researchInput(ticket, runtime, scope, scope, 0, now);
				db.transaction(() => {
					if (fault.failSave) throw new Error("fixture_save_failed");
					state.saveInTransaction(
						db,
						{
							conversationId: scope,
							epoch: 0,
							scope,
							snapshot: runtime.snapshot(),
							idle: null,
							settingsDigest: "fixture",
							sourceRefs: input.sourceRefs,
						},
						now,
					);
					state.startInTransaction(db, input);
				})();
			},
			/** Starts of the inert worker and rows the admission left in the disposable store. */
			counts(scope?: string) {
				const rows = (table: string) =>
					(
						db
							.query(
								`SELECT count(*) AS n FROM ${table}${scope === undefined ? "" : " WHERE conversation_id = ?"}`,
							)
							.get(...(scope === undefined ? [] : [scope])) as { n: number }
					).n;
				return {
					workerStarts,
					workRows: rows("dialogue_agency_work"),
					stateRows: rows("dialogue_agency_state"),
				};
			},
			close: () => db.close(),
		};
	} catch (error) {
		db.close();
		throw error;
	}
}
