import { Database } from "bun:sqlite";
import { join } from "node:path";
import type { GoalReport, WorkRequest } from "./goal-store.ts";
import type { GoalMemoryGuard } from "./host-memory.ts";

export interface GoalArtifact {
	readonly id: string;
	readonly workId: string;
	readonly workspace: string;
	readonly files: readonly { path: string; content: string }[];
}

export type WorkReceipt =
	| { status: "absent" | "unknown" }
	| { status: "accepted"; workId: string; resumeRequired?: true }
	| {
			status: "succeeded" | "failed";
			workId: string;
			goalId: string;
			goalRevision: number;
			artifactId: string | null;
			summary: string;
	  };

export interface GoalWorker {
	submit(request: WorkRequest, stillCurrent?: () => boolean): WorkReceipt;
	lookup(workId: string): WorkReceipt;
	resume?(request: WorkRequest, stillCurrent: () => boolean): WorkReceipt;
	readArtifact(id: string): GoalArtifact | null;
}

export interface GoalReportSink {
	lookupReport(id: string): "absent" | "unknown" | "delivered";
	publish(
		report: GoalReport,
		at: number,
		stillCurrent: GoalMemoryGuard,
	): void | Promise<void>;
}

/** A separate durable ledger simulates a worker that may commit before the host sees its reply. */
export function openClaudeCodeMock(dir: string) {
	const db = new Database(join(dir, "mock.sqlite3"));
	db.exec(`
		PRAGMA journal_mode=WAL;
		PRAGMA busy_timeout=5000;
		CREATE TABLE IF NOT EXISTS mock_requests (id TEXT PRIMARY KEY, payload TEXT NOT NULL, result TEXT);
		CREATE TABLE IF NOT EXISTS mock_artifacts (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
		CREATE TABLE IF NOT EXISTS mock_deliveries (id TEXT PRIMARY KEY, text TEXT NOT NULL, at INTEGER NOT NULL);
		CREATE TABLE IF NOT EXISTS mock_presented_reports (id TEXT PRIMARY KEY);
		CREATE TABLE IF NOT EXISTS mock_events (type TEXT NOT NULL, id TEXT NOT NULL);
	`);
	const findRequest = db.query<
		{ payload: string; result: string | null },
		[string]
	>("SELECT payload, result FROM mock_requests WHERE id=?");
	const log = (type: string, id: string) =>
		db.query("INSERT INTO mock_events VALUES (?, ?)").run(type, id);
	const status = (id: string): WorkReceipt => {
		const row = findRequest.get(id);
		if (!row) return { status: "absent" };
		return row.result
			? (JSON.parse(row.result) as WorkReceipt)
			: { status: "accepted", workId: id };
	};
	const submit: GoalWorker["submit"] = db.transaction(
		(request: WorkRequest) => {
			const payload = JSON.stringify(request);
			const prior = findRequest.get(request.workId);
			if (prior && prior.payload !== payload)
				throw new Error("mock_work_id_conflict");
			log("submit", request.workId);
			if (!prior)
				db.query("INSERT INTO mock_requests(id, payload) VALUES (?, ?)").run(
					request.workId,
					payload,
				);
			return status(request.workId);
		},
	).immediate;
	const finish = db.transaction(
		(
			workId: string,
			input: { status: "succeeded" | "failed"; files?: GoalArtifact["files"] },
		) => {
			const row = findRequest.get(workId);
			if (!row) throw new Error("mock_work_not_accepted");
			if (row.result) throw new Error("mock_work_already_finished");
			const { goalId, goalRevision, workspace } = JSON.parse(
				row.payload,
			) as WorkRequest;
			const artifactId = input.files ? `artifact:${workId}` : null;
			if (artifactId) {
				const artifact = {
					id: artifactId,
					workId,
					workspace,
					files: input.files,
				};
				db.query("INSERT INTO mock_artifacts VALUES (?, ?)").run(
					artifactId,
					JSON.stringify(artifact),
				);
			}
			const result: WorkReceipt = {
				status: input.status,
				workId,
				goalId,
				goalRevision,
				artifactId,
				summary:
					input.status === "succeeded" ? "できました" : "作業に失敗しました",
			};
			db.query("UPDATE mock_requests SET result=? WHERE id=?").run(
				JSON.stringify(result),
				workId,
			);
			log("finish", workId);
			return result;
		},
	).immediate;
	const findReport = db.query<
		{ id: string; text: string; at: number },
		[string]
	>("SELECT id, text, at FROM mock_deliveries WHERE id=?");
	const publish = db.transaction((report: GoalReport, at: number) => {
		const prior = findReport.get(report.id);
		if (prior && prior.text !== report.text)
			throw new Error("mock_report_id_conflict");
		if (!prior) {
			db.query("INSERT INTO mock_deliveries VALUES (?, ?, ?)").run(
				report.id,
				report.text,
				at,
			);
			log("publish", report.id);
		}
	}).immediate;
	const presented = db.query<{ id: string }, [string]>(
		"SELECT id FROM mock_presented_reports WHERE id=?",
	);
	const presentReport = db.transaction((id: string, show: () => void) => {
		if (presented.get(id)) return;
		show();
		db.query("INSERT INTO mock_presented_reports VALUES (?)").run(id);
	}).immediate;
	return {
		submit,
		lookup: (id: string) => {
			log("lookup", id);
			return status(id);
		},
		readArtifact: (id: string) => {
			const row = db
				.query<{ payload: string }, [string]>(
					"SELECT payload FROM mock_artifacts WHERE id=?",
				)
				.get(id);
			return row ? (JSON.parse(row.payload) as GoalArtifact) : null;
		},
		finish,
		lookupReport: (id: string) => {
			log("lookupReport", id);
			return findReport.get(id) ? ("delivered" as const) : ("absent" as const);
		},
		publish,
		presentReport,
		reportPresented: (id: string) => presented.get(id) !== null,
		requests: () =>
			db
				.query<{ payload: string }, []>(
					"SELECT payload FROM mock_requests ORDER BY rowid",
				)
				.all()
				.map((r) => JSON.parse(r.payload) as WorkRequest),
		deliveries: () =>
			db
				.query<{ id: string; text: string; at: number }, []>(
					"SELECT id, text, at FROM mock_deliveries ORDER BY rowid",
				)
				.all(),
		events: () =>
			db
				.query<{ type: string; id: string }, []>(
					"SELECT type, id FROM mock_events ORDER BY rowid",
				)
				.all(),
		close: () => db.close(),
	};
}
