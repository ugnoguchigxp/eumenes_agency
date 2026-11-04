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
		agents: { startInTransaction: () => ({ taskId: "fixture-worker" }) },
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
			admit(ticket: ActionTicket, runtime: AgencyRuntime, scope: string) {
				const input = researchInput(ticket, runtime, scope, scope, 0, now);
				db.transaction(() => {
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
			close: () => db.close(),
		};
	} catch (error) {
		db.close();
		throw error;
	}
}
