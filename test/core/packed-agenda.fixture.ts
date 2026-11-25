// This file runs from an isolated tarball installation using package-name imports.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import type { LlmRequest } from "eumenes-agency";
import {
	READ_NOTE,
	SHOW_NOTE,
	decideGoalStep,
	goalStepSchema,
	type GoalStepContext,
	type AgendaGoalContext,
} from "eumenes-agency/agenda";
import {
	CLAUDE_CODE,
	goalMigrations,
	codexGoalDesigner,
	codexWebNoteWriter,
	openAgendaGoals,
	openClaudeCodeMock,
	withGoalReplyTools,
	type Complete,
	type GoalReport,
	type GoalTarget,
} from "eumenes-agency/agenda/runtime";

const eumenesRoot = process.argv[2];
assert.ok(eumenesRoot);
const dir = mkdtempSync("/tmp/agency-pack-goal-");
let now = 1000;
let phase: "accept" | "interrupt" | "report" = "accept";
let interrupted = false;
const reports: GoalReport[] = [];
const lookups: string[] = [];
const example = "Use bun run sample -- --dry-run in the README.";
const finding = "Put the dry-run example in the preview section.";
const markdown = `# Design\n\n${finding}\n\n${example}`;
const respond = <T>(request: LlmRequest<T>, value: unknown) => ({
	value: request.schema.parse(value),
	model: "fixture",
	inputTokens: 0,
	outputTokens: 0,
	cacheReadTokens: 0,
	latencyMs: 0,
});
const snapshot: GoalStepContext = {
	version: 1,
	contextId: "packed:1",
	goal: {
		id: "packed",
		revision: 1,
		desiredState: "Verify a saved artifact",
		sourceRef: null,
	},
	progressVersion: 1,
	criteria: [
		{
			id: "root",
			status: "open",
			text: "Verify a saved artifact",
			evidenceRefs: [],
		},
	],
	evidence: [],
	attempts: [],
	capabilities: [],
	watches: [],
	checks: [],
	openQuestions: [],
	reviewRequired: false,
};
const proposed = goalStepSchema.parse({
	contextId: snapshot.contextId,
	progressVersion: 1,
	criterionIds: ["root"],
	kind: "ask",
	missing: "artifact",
	question: "Where is the artifact?",
	reason: "The artifact location is unavailable.",
	review: null,
});
assert.deepEqual(
	await decideGoalStep(
		{
			async complete(request) {
				return respond(request, { step: proposed });
			},
		},
		snapshot,
		{ sources: [], complete: true },
		new AbortController().signal,
	),
	{ status: "chosen", step: proposed },
);
assert.equal(goalMigrations.at(-1)?.id, "agency-goals/0006-read-policies");
const memoryModel: Complete = async () => ({
	raw: JSON.stringify({
		proposal: {
			decision: {
				clarification: null,
				actions: [
					{
						type: "remember",
						subject: "self",
						kind: "constraint",
						semanticKey: "sample.readme",
						quote: example,
						value: { text: example, polarity: "affirmed" },
						replacesItemId: null,
					},
				],
			},
			relations: [{ actionIndex: 0, relation: "new", relatedItemIds: [] }],
			groups: [[0]],
		},
		evidence: [{ actionIndex: 0, occurrence: 0 }],
	}),
	threadId: null,
	usage: null,
});

const open = () =>
	openAgendaGoals({
		dir,
		eumenesRoot,
		principal: "pack-fixture",
		memoryModel,
		now: () => now,
		scopes: () => ["personal"],
		opportunity: () => ({ active: true, busy: false, scopeKey: "personal" }),
		workLimit: () => 1,
		analysisMs: 1000,
		designer: codexGoalDesigner({
			turn: async (prompt) => {
				assert.ok(prompt.includes(finding));
				assert.ok(prompt.includes(example));
				return {
					text: JSON.stringify({
						status: "ready",
						title: "Design",
						summary: "README preview section",
						markdown,
						sources: [],
						missing: null,
					}),
					searches: 0,
					usage: null,
				};
			},
		}),
		llm: {
			async complete(request, signal) {
				const raw = request.prompt.match(
					/<goal_context>([^]*?)<\/goal_context>/u,
				)?.[1];
				if (raw) {
					const context = JSON.parse(raw) as AgendaGoalContext;
					const goal = context.goals[0]!;
					const memory = context.memory.find((item) => item.text === example);
					assert.ok(memory);
					return respond(request, {
						add: [],
						drop: [],
						focus: "",
						goalWork: {
							analysis:
								"Use the user's saved command and preview-section research.",
							delegation: {
								goalId: goal.id,
								goalRevision: goal.revision,
								toolchainRevisionId: CLAUDE_CODE.revisionId,
								memoryIds: [memory.id],
								request: { task: "Update README", prompt: memory.text },
							},
						},
					});
				}
				assert.equal(JSON.parse(request.prompt).request, markdown);
				if (phase === "accept") {
					signal.throwIfAborted();
					await new Promise<never>((_resolve, reject) => {
						signal.addEventListener("abort", () => reject(signal.reason), {
							once: true,
						});
					});
				}
				return respond(request, {
					files: [{ path: "README.md", content: `# Preview\n\n${example}` }],
				});
			},
		},
		judge: {
			async complete(request) {
				const input = JSON.parse(request.prompt);
				const passed =
					input.files.length === 1 &&
					input.files[0].path === "README.md" &&
					input.files[0].content.includes(example);
				return respond(request, {
					checks: [{ condition: "README example", passed }],
					summary: "Verified the preview example.",
				});
			},
		},
		tell(report) {
			if (phase === "interrupt") {
				interrupted = true;
				throw new Error("interrupted before showing the completion report");
			}
			reports.push(report);
		},
		trace(event) {
			if (event.type === "work_lookup")
				lookups.push((event.data as { workId: string }).workId);
		},
	});

try {
	let host = await open();
	let target: GoalTarget;
	let workId: string;
	let noteId: string;
	try {
		let user = {
			id: "register",
			text: "Register a goal to update the README's preview example.",
		};
		const shown: string[] = [];
		const tools = withGoalReplyTools(
			host.replyTools({ onShow: (note) => shown.push(note.markdown) }),
			host,
			() => user,
		);
		const call = async (name: string, args: object) =>
			(
				await tools.call(
					{
						id: name,
						name,
						arguments: JSON.stringify(args),
					},
					new AbortController().signal,
				)
			).content;
		const saved = JSON.parse(
			await call("register_goal", {
				slot: 3,
				desiredState: user.text,
				priority: null,
				quote: user.text,
			}),
		);
		assert.equal(saved.status, "registered");
		target = { slot: 3, goalId: saved.goal.goalId, revision: 1 };
		assert.equal(JSON.parse(await call("list_goals", {})).slots.length, 10);
		const remembered = await host.remember(
			{
				said: [{ id: "memory", who: "user", text: example }],
				fresh: ["memory"],
				at: now,
			},
			"personal",
		);
		assert.equal(remembered.applied.length, 1, remembered.rejected.join(", "));
		const researcher = codexWebNoteWriter({
			today: () => "2026-11-21",
			turn: async () => ({
				text: `題: Research\n要約: README preview\n---\n${finding}`,
				searches: 1,
				usage: null,
			}),
		});
		host.saveNote({
			...(await researcher.writer("Find the relevant section.")),
			at: now,
			refs: [],
		});
		assert.equal(researcher.searches(), 1);
		await host.tick();
		assert.equal(host.work().length, 0);
		const goal = host.list()[2];
		const savedNoteId = goal?.designNoteId;
		assert.ok(savedNoteId);
		assert.ok(goal.designDigest);
		noteId = savedNoteId;
		const read = await call(READ_NOTE, { id: noteId });
		const noteData = /^<メモ [^>]*>(.+)<\/メモ>$/su.exec(read)?.[1];
		assert.ok(noteData);
		assert.equal(JSON.parse(noteData).markdown, markdown);
		await call(SHOW_NOTE, { id: noteId });
		assert.deepEqual(shown, [markdown]);
		user = {
			id: "approve",
			text: "Use the displayed design with the Claude Code mock.",
		};
		const approved = JSON.parse(
			await call("update_goal", {
				...target,
				action: "authorize_mock",
				design: { id: noteId, digest: goal.designDigest },
				desiredState: null,
				priority: null,
				quote: user.text,
			}),
		);
		assert.equal(approved.mockAuthorized, true);
		now += 999;
		await host.tick();
		assert.equal(host.work().length, 0);
		now += 1;
		await host.tick();
		const entry = host.work()[0];
		assert.equal(entry?.state, "accepted");
		assert.equal(entry.work.request.args.prompt, markdown);
		workId = entry.work.request.workId;
	} finally {
		await host.close();
	}

	phase = "interrupt";
	host = await open();
	try {
		assert.equal(host.list()[2]?.goal?.goalId, target.goalId);
		assert.equal(host.readNote(noteId)?.markdown, markdown);
		for (let attempt = 0; attempt < 5 && !interrupted; attempt++) {
			now += 1000;
			await host.tick();
		}
		assert.ok(interrupted);
		assert.ok(lookups.includes(workId));
		assert.equal(host.list()[2]?.goal?.status, "completed");
		assert.equal(host.reports().length, 0);
	} finally {
		await host.close();
	}

	phase = "report";
	host = await open();
	try {
		await host.tick();
		await host.tick();
		assert.equal(reports.length, 1);
		assert.equal(reports[0]?.work.request.workId, workId);
		assert.equal(host.reports()[0]?.id, reports[0]?.id);
		assert.equal(host.reports().length, 1);
	} finally {
		await host.close();
	}
	const mock = openClaudeCodeMock(dir);
	try {
		assert.equal(mock.requests().length, 1);
		assert.equal(mock.deliveries().length, 1);
		assert.equal(
			mock.events().filter((event) => event.type === "publish").length,
			1,
		);
		assert.equal(
			mock.readArtifact(reports[0]!.artifactId)?.files[0]?.path,
			"README.md",
		);
	} finally {
		mock.close();
	}
} finally {
	rmSync(dir, { recursive: true, force: true });
}
