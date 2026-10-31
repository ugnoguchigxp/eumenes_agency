/** H12 host stand-in: the one SQLite table the host's AgencyDb owns (eval only). */
import { Database } from "bun:sqlite";
import type { ItemRevision, RevisionSink } from "../src/index.ts";
import { REDACTED } from "../src/index.ts";

export const createRevisionDb = (path = ":memory:") => {
	const db = new Database(path);
	db.run(`CREATE TABLE IF NOT EXISTS agency_item_revisions(
		scope TEXT NOT NULL, item_kind TEXT NOT NULL, item_id TEXT NOT NULL, revision INTEGER NOT NULL,
		state_json TEXT NOT NULL, reason TEXT NOT NULL, evidence_json TEXT NOT NULL, call_id TEXT NOT NULL,
		at INTEGER NOT NULL, PRIMARY KEY(scope, item_kind, item_id, revision))`);
	const ins = db.prepare(
		"INSERT INTO agency_item_revisions VALUES (?,?,?,?,?,?,?,?,?)",
	);
	const sink = (scope: string): RevisionSink => ({
		scope,
		append: db.transaction((rows: readonly ItemRevision[]) => {
			for (const r of rows)
				ins.run(
					r.scope,
					r.itemKind,
					r.itemId,
					r.revision,
					r.stateJson,
					r.reason,
					JSON.stringify(r.evidence),
					r.callId,
					r.at,
				);
		}) as unknown as (rows: readonly ItemRevision[]) => void,
	});
	type Row = {
		scope: string;
		item_kind: ItemRevision["itemKind"];
		item_id: string;
		revision: number;
		state_json: string;
		reason: string;
		evidence_json: string;
		call_id: string;
		at: number;
	};
	const rows = (scope: string): ItemRevision[] =>
		(
			db
				.query(
					"SELECT * FROM agency_item_revisions WHERE scope=? ORDER BY rowid",
				)
				.all(scope) as Row[]
		).map((r) => ({
			scope: r.scope,
			itemKind: r.item_kind,
			itemId: r.item_id,
			revision: r.revision,
			stateJson: r.state_json,
			reason: r.reason,
			evidence: JSON.parse(r.evidence_json) as string[],
			callId: r.call_id,
			at: r.at,
		}));
	/** host-contract §5: forgetting reaches the history body of every item that cited the id. */
	const forget = (scope: string, ids: readonly string[]) =>
		db.transaction(() => {
			const hit = db
				.query(
					`SELECT DISTINCT item_kind, item_id FROM agency_item_revisions, json_each(evidence_json)
					 WHERE scope=? AND json_each.value IN (${ids.map(() => "?").join(",")})`,
				)
				.all(scope, ...ids) as { item_kind: string; item_id: string }[];
			const up = db.prepare(
				"UPDATE agency_item_revisions SET state_json=?, reason='', evidence_json='[]' WHERE scope=? AND item_kind=? AND item_id=?",
			);
			for (const h of hit) up.run(REDACTED, scope, h.item_kind, h.item_id);
			return hit.length;
		})();
	const count = () =>
		(
			db.query("SELECT COUNT(*) n FROM agency_item_revisions").get() as {
				n: number;
			}
		).n;
	return { db, sink, rows, forget, count, close: () => db.close() };
};
