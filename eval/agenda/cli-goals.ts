/** Drives the normal Agenda CLI through a goal from a chat turn to a mock completion. */
import assert from "node:assert/strict";
import { Database } from "bun:sqlite";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createMockDocStore } from "../../runtime/agenda/docs.ts";
import type { WorkRequest } from "../../runtime/agenda/goal-store.ts";

interface Event {
	readonly type: string;
	readonly at: number;
	readonly id?: string;
	readonly noteId?: string;
	readonly workId?: string;
	readonly reportId?: string;
	readonly state?: string;
	readonly reason?: string;
	readonly text?: string;
	readonly calls?: readonly {
		readonly name: string;
		readonly content: string;
	}[];
}

const run = process.argv[2];
assert.ok(
	run && /^[a-zA-Z0-9_-]+$/u.test(run),
	"usage: cli-goals.ts <new-run-name>",
);
const root = resolve(import.meta.dir, "../..");
const output = join(root, "data/agenda/runs", run);
mkdirSync(output);
const workspace = mkdtempSync(join(tmpdir(), "ag-cli-"));
const log = join(output, "conversation.jsonl");
const cli = Bun.spawn(
	[
		process.execPath,
		"--no-env-file",
		join(root, "standalone/agenda.ts"),
		"--data-dir",
		workspace,
		"--mock-research",
		"--goal-analysis-seconds",
		"5",
		"--log",
		log,
		"--no-plan",
	],
	{
		cwd: root,
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	},
);
const stdout = cli.stdout.text();
const stderr = cli.stderr.text();
let closed = false;
void cli.exited.then(() => {
	closed = true;
});
const events = (): Event[] =>
	existsSync(log)
		? readFileSync(log, "utf8")
				.split("\n")
				.slice(0, -1)
				.map((line) => JSON.parse(line) as Event)
		: [];
const waitFor = async (label: string, find: (e: Event) => boolean) => {
	const until = Date.now() + 120_000;
	while (Date.now() < until && !closed) {
		const event = events().find(find);
		if (event) return event;
		await Bun.sleep(150);
	}
	throw new Error(`${label} を確認できませんでした。${log}`);
};
const say = (text: string) => {
	cli.stdin.write(text + "\n");
	cli.stdin.flush();
};
const registration =
	"3番の目標に登録してください。サンプル CLI の README.md に --dry-run の説明と実行例を追加したいです。達成条件は README.md だけを対象にし、ファイルを変更せず事前に予定内容を見られる旨と、`bun run sample -- --dry-run` の実行例を記載することです。今は目標の登録と設計をお願いします。";
const view = "3番の目標に対応する設計書をメモとして見せてください。";
const permission =
	"3番の目標の現行の設計書を使って、Claude Code モックで作業することを許可します。";

try {
	await waitFor("Agenda の起動", (e) => e.type === "ready");
	say(registration);
	await waitFor(
		"会話ツールによる目標登録",
		(e) =>
			e.type === "reply" &&
			(e.calls?.some(
				(c) =>
					c.name === "register_goal" &&
					JSON.parse(c.content).status === "registered",
			) ??
				false),
	);
	const saved = await waitFor(
		"Codex の設計書",
		(e) => e.type === "goal_design_saved" && e.noteId !== undefined,
	);
	assert.ok(!events().some((e) => e.type === "goal_submitted"));
	say(view);
	await waitFor(
		"会話での設計書表示",
		(e) => e.type === "show" && e.id === saved.noteId,
	);
	assert.ok(!events().some((e) => e.type === "goal_submitted"));
	say(permission);
	const approved = await waitFor(
		"会話ツールによるモック許可",
		(e) =>
			e.type === "reply" &&
			(e.calls?.some(
				(c) =>
					c.name === "update_goal" &&
					JSON.parse(c.content).action === "authorize_mock" &&
					JSON.parse(c.content).mockAuthorized,
			) ??
				false),
	);
	const sent = await waitFor(
		"Claude Code モックへの送信",
		(e) => e.type === "goal_submitted",
	);
	const report = await waitFor(
		"会話の完了報告",
		(e) =>
			e.type === "goal_report" ||
			(e.type === "work_state" &&
				e.workId === sent.workId &&
				["partial", "invalidated", "failed"].includes(e.state ?? "")),
	);
	assert.equal(report.type, "goal_report", report.reason);
	assert.ok(sent.at >= approved.at && report.at >= sent.at);
	assert.ok(report.text?.includes("Claude Code モック"));
	say("/goals");
	say("/quit");
	assert.equal(await cli.exited, 0);
	assert.equal(events().filter((e) => e.type === "goal_report").length, 1);
	assert.ok(
		!events().some((e) => e.calls?.some((call) => call.name === "delegate")),
	);
	const mock = new Database(join(workspace, "goals/mock.sqlite3"), {
		readonly: true,
	});
	try {
		const jobs = mock
			.query<{ payload: string; result: string }, []>(
				"SELECT payload, result FROM mock_requests",
			)
			.all();
		assert.equal(jobs.length, 1);
		const work = JSON.parse(jobs[0]!.payload) as WorkRequest;
		assert.equal(work.design?.id, saved.noteId);
		assert.ok(work.design?.id);
		const note = createMockDocStore({ dir: join(workspace, "notes") }).read(
			work.design.id,
		);
		assert.ok(note);
		assert.equal(work.args.prompt, note.markdown);
		assert.ok(note.markdown.includes("bun run sample -- --dry-run"));
		const receipt = JSON.parse(jobs[0]!.result) as {
			status: string;
			artifactId: string;
		};
		assert.equal(receipt.status, "succeeded");
		const artifact = mock
			.query<{ payload: string }, [string]>(
				"SELECT payload FROM mock_artifacts WHERE id=?",
			)
			.get(receipt.artifactId);
		assert.ok(artifact);
		assert.equal(
			mock
				.query<{ count: number }, []>(
					"SELECT COUNT(*) AS count FROM mock_deliveries",
				)
				.get()?.count,
			1,
		);
		const goals = new Database(join(workspace, "goals/goals.sqlite3"), {
			readonly: true,
		});
		try {
			assert.equal(
				goals
					.query<{ status: string }, [string]>(
						"SELECT status FROM goals_ledger WHERE id=?",
					)
					.get(work.goalId)?.status,
				"completed",
			);
		} finally {
			goals.close();
		}
		writeFileSync(join(output, "design.md"), note.markdown);
		writeFileSync(
			join(output, "result.json"),
			JSON.stringify(
				{ passed: true, work, artifact: JSON.parse(artifact.payload), report },
				null,
				2,
			),
		);
	} finally {
		mock.close();
	}
	console.log(`通常の Agenda で登録・表示・委譲・報告を確認 ${output}`);
} finally {
	if (!closed) cli.kill();
	const [out, err] = await Promise.all([stdout, stderr]);
	writeFileSync(join(output, "terminal.log"), out + err);
	rmSync(workspace, { recursive: true, force: true });
}
