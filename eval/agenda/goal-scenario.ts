import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	AgendaGoalContext,
	GoalWorkPlan,
} from "../../src/agenda/index.ts";
import type { LlmPort } from "../../src/index.ts";
import {
	openGoalHost,
	type GoalHost,
	type GoalHostEvent,
	type GoalHostOptions,
} from "../../runtime/agenda/goal-host.ts";
import {
	openClaudeCodeMock,
	type GoalArtifact,
} from "../../runtime/agenda/goal-mock.ts";
import { CLAUDE_CODE } from "../../runtime/agenda/goal-store.ts";
import {
	GOAL_ANALYSIS_MS,
	type GoalDesigner,
} from "../../runtime/agenda/goal-design.ts";
import type { Complete } from "../../runtime/agenda/host-memory.ts";

export const goalScenarioNames = [
	"goal-claude-code",
	"goal-empty",
	"goal-memory-revised",
] as const;
export type GoalScenarioName = (typeof goalScenarioNames)[number];
export const isGoalScenario = (name: string): name is GoalScenarioName =>
	goalScenarioNames.some((candidate) => candidate === name);

export const bunExample = "bun run sample -- --dry-run";
export const npmExample = "npm run sample -- --dry-run";
export const otherExample = "pnpm run sample-web -- --dry-run";
export const CLI_KEY = "sample-cli.readme.example";
const BASE_TIME = Date.parse("2026-11-21T09:00:00+09:00");

export const source = (id: string) => ({
	namespace: "conversation",
	kind: "message",
	id,
});
export const goalInput = (operationKey: string, scopeKey = "personal") => ({
	scopeKey,
	priority: 60,
	operationKey,
	source: source(operationKey),
	desiredState:
		"サンプル CLI の README.md に --dry-run の説明と私が指定した形式の実行例を追加する。達成条件は、README.md だけを変更し、実行前に変更内容を確認できてファイルは変更しない旨と、指定形式の実行例を含む差分を返すこと。",
});

export const readmeFiles = (command: string): GoalArtifact["files"] => [
	{
		path: "README.md",
		content: `## プレビュー\n\n\`--dry-run\` で実行前に変更内容を確認できます。ファイルは変更しません。\n\n\`\`\`sh\n${command}\n\`\`\`\n`,
	},
];

export function verifyReadme(command: string, artifact: GoalArtifact) {
	const readme =
		artifact.files.find((f) => f.path === "README.md")?.content ?? "";
	return {
		checks: [
			{
				condition: "変更対象は README.md のみ",
				passed:
					artifact.files.length === 1 &&
					artifact.files[0]?.path === "README.md",
			},
			{
				condition: "--dry-run の説明",
				passed:
					readme.includes("--dry-run") &&
					readme.includes("ファイルは変更しません"),
			},
			{
				condition: "現在の Memory で指定した実行例",
				passed: readme.includes(`\n${command}\n`),
			},
		],
		summary:
			"サンプル CLI の README に `--dry-run` の説明と実行例を追加しました。",
	};
}

/** Only the Memory model is scripted. The real host runs source, context, plan and apply. */
export function fixtureMemory() {
	const actions = new Map<
		string,
		{ key: string; mode: "remember" | "forget" }
	>();
	const complete: Complete = async (packet) => {
		const { source, items } = JSON.parse(packet) as {
			source: string;
			items: { itemId: string; semanticKey: string }[];
		};
		const spec = actions.get(source);
		assert.ok(spec, "unexpected request to the fixture Memory planner");
		const replaced = items.find(
			(item) => item.semanticKey === spec.key,
		)?.itemId;
		if (spec.mode === "forget")
			assert.ok(replaced, "the forgotten item must exist");
		const action =
			spec.mode === "forget"
				? { type: "forget", itemId: replaced }
				: {
						type: "remember",
						subject: "self",
						kind: "constraint",
						semanticKey: spec.key,
						quote: source,
						value: { text: source, polarity: "affirmed" },
						replacesItemId: replaced ?? null,
					};
		return {
			raw: JSON.stringify({
				proposal: {
					decision: { clarification: null, actions: [action] },
					relations: [
						{
							actionIndex: 0,
							relation:
								spec.mode === "forget"
									? "forget"
									: replaced
										? "supersedes"
										: "new",
							relatedItemIds: replaced ? [replaced] : [],
						},
					],
					groups: [[0]],
				},
				evidence:
					spec.mode === "forget" ? [] : [{ actionIndex: 0, occurrence: 0 }],
			}),
			threadId: null,
			usage: null,
		};
	};
	const writeBatch = async (
		host: GoalHost,
		entries: readonly {
			text: string;
			key: string;
			mode?: "remember" | "forget";
		}[],
		scopeKey = "personal",
	) => {
		const said = entries.map(({ text, key, mode = "remember" }, index) => {
			actions.set(text, { key, mode });
			return { id: `fixture-user-${index}`, who: "user", text };
		});
		const result = await host.remember(
			{ said, fresh: said.map((entry) => entry.id), at: BASE_TIME },
			scopeKey,
		);
		assert.deepEqual(result.rejected, []);
		assert.equal(result.applied.length, entries.length);
		return result;
	};
	return {
		complete,
		writeBatch,
		write: (
			host: GoalHost,
			text: string,
			key = CLI_KEY,
			scopeKey = "personal",
			mode: "remember" | "forget" = "remember",
		) => writeBatch(host, [{ text, key, mode }], scopeKey),
	};
}

export const cliPreference = (example: string) =>
	`サンプル CLI の README で使う実行例は \`${example}\` の形式で書いてください。`;

export const fixtureDesigner: GoalDesigner = async ({
	goal,
	brief,
	memory,
	notes,
}) => ({
	status: "ready",
	title: `設計書 ${brief.task}`,
	summary: "対象、作業範囲と確認条件をまとめた依頼書です。",
	markdown: [
		`# ${brief.task}`,
		goal.desiredState,
		brief.prompt,
		...notes.map((n) => n.markdown),
	].join("\n\n"),
	sources: [
		...memory
			.filter((m) => brief.prompt.includes(m.text))
			.map((m) => `memory:${m.id}`),
		...notes.map((n) => `note:${n.id}`),
	],
	missing: null,
});

export function fixtureEnvironment(command = bunExample) {
	const clock = { at: BASE_TIME };
	const opportunity = { active: true, busy: false, scopeKey: "personal" };
	const config = { limit: 4, scopes: ["personal", "work"] };
	const memory = fixtureMemory();
	const events: GoalHostEvent[] = [];
	const options = {
		principal: "fixture-user",
		workspace: "isolated-sample-cli",
		now: () => clock.at,
		opportunity: () => opportunity,
		workLimit: () => config.limit,
		scopes: () => config.scopes,
		memoryModel: memory.complete,
		designer: fixtureDesigner,
		verify: (_goal, _work, artifact) => verifyReadme(command, artifact),
		trace: (event) => events.push(event),
	} satisfies Omit<GoalHostOptions, "dir" | "llm" | "worker" | "reports">;
	return { clock, opportunity, config, memory, options, events };
}

export function fixturePlan(
	decide: (
		ctx: AgendaGoalContext,
		prompt: string,
	) => GoalWorkPlan | Promise<GoalWorkPlan>,
): LlmPort {
	return {
		async complete(req) {
			const material = req.prompt.match(
				/<goal_context>([^]*?)<\/goal_context>/u,
			)?.[1];
			assert.ok(material, "expected Agenda goal planning context");
			return {
				value: req.schema.parse({
					add: [],
					drop: [],
					focus: "",
					goalWork: await decide(
						JSON.parse(material) as AgendaGoalContext,
						req.prompt,
					),
				}),
				model: "fixture",
				inputTokens: 0,
				outputTokens: 0,
				cacheReadTokens: 0,
				latencyMs: 0,
			};
		},
	};
}

export function fixtureDelegation(
	ctx: AgendaGoalContext,
	selected = ctx.goals[0]!,
	memory = ctx.memory.slice(0, 20),
) {
	return {
		analysis: "対象と達成条件から次の作業を選びました。",
		delegation: {
			goalId: selected.id,
			goalRevision: selected.revision,
			toolchainRevisionId: CLAUDE_CODE.revisionId,
			memoryIds: memory.map((m) => m.id),
			request: {
				task: "目標に沿った更新",
				prompt: [selected.desiredState, ...memory.map((m) => m.text)].join(
					"\n",
				),
			},
		},
	} satisfies GoalWorkPlan;
}

const noModel = (): LlmPort => ({
	async complete() {
		throw new Error("the restart must not ask the model again");
	},
});

const seedCliGoal = async (
	host: GoalHost,
	env: ReturnType<typeof fixtureEnvironment>,
	revised: boolean,
) => {
	const goal = await host.register(3, goalInput("goal-cli"));
	await host.authorize({ slot: 3, goalId: goal.id, revision: 1 });
	const unready = await host.register(1, {
		...goalInput("unready"),
		priority: 90,
		desiredState:
			"対象を指定したら設定ファイルの説明を直す。現在はファイル名も対象プロジェクトも未指定。",
	});
	await host.authorize({ slot: 1, goalId: unready.id, revision: 1 });
	await env.memory.write(host, cliPreference(bunExample));
	await env.memory.write(
		host,
		`サンプル Web（別プロジェクト）の実行例は \`${otherExample}\` を使う。`,
		"sample-web.example",
	);
	await env.memory.write(
		host,
		"仕事側の別プロジェクトでは操作記録を work-only.yaml に書く。",
		"work-project.example",
		"work",
	);
	if (revised) await env.memory.write(host, cliPreference(npmExample));
	return goal.id;
};

const checkAck = (
	host: GoalHost,
	mock: ReturnType<typeof openClaudeCodeMock>,
) => {
	const requests = mock.requests();
	assert.equal(requests.length, 1);
	const request = requests[0]!;
	assert.equal(host.work()[0]?.work.request.workId, request.workId);
	assert.equal(host.list()[2]?.goal?.status, "adopted");
	assert.equal(mock.deliveries().length, 0);
	return request;
};

async function recover(dir: string, command: string, phase: "work" | "report") {
	const env = fixtureEnvironment(command);
	env.clock.at += GOAL_ANALYSIS_MS + 10_000;
	env.config.limit = 1;
	const mock = openClaudeCodeMock(dir);
	const host = await openGoalHost({
		...env.options,
		dir,
		llm: noModel(),
		worker: mock,
		reports: {
			...mock,
			publish(report, at) {
				mock.publish(report, at);
				throw new Error("simulated delivery acknowledgement loss");
			},
		},
	});
	try {
		if (phase === "work") {
			const request = checkAck(host, mock);
			const before = mock.events().length;
			env.clock.at += 1_000;
			env.opportunity.busy = true;
			await host.tick();
			assert.deepEqual(mock.events()[before], {
				type: "lookup",
				id: request.workId,
			});
			assert.equal(host.work()[0]?.state, "accepted");
			assert.equal(host.list()[2]?.goal?.status, "adopted");
			host.setQuiet({ scope: "speech", minutes: 1, at: env.clock.at });
			env.clock.at += 1_000;
			const receipt = mock.finish(request.workId, {
				status: "succeeded",
				files: readmeFiles(command),
			});
			assert.equal(receipt.summary, "できました");
			await host.tick();
			assert.equal(host.list()[2]?.goal?.status, "completed");
			assert.equal(mock.deliveries().length, 0);
			env.opportunity.busy = false;
			await host.tick();
			assert.equal(mock.deliveries().length, 0);
			env.clock.at += 61_000;
			await host.tick();
			assert.equal(mock.deliveries().length, 1);
		} else {
			const prior = mock.deliveries()[0];
			assert.ok(prior);
			const before = mock.events().length;
			env.clock.at += 70_000;
			await host.tick();
			assert.deepEqual(mock.events()[before], {
				type: "lookupReport",
				id: prior.id,
			});
			assert.deepEqual(mock.deliveries(), [prior]);
		}
		assert.ok(!env.events.some((e) => e.type === "plan_call"));
		const timeline = mock.events();
		assert.equal(timeline.filter((e) => e.type === "submit").length, 1);
		assert.equal(timeline.filter((e) => e.type === "finish").length, 1);
		assert.equal(timeline.filter((e) => e.type === "publish").length, 1);
		return {
			pid: process.pid,
			events: env.events,
			timeline,
			goals: host.list(),
			reports: mock.deliveries(),
			artifact: mock.readArtifact(`artifact:${mock.requests()[0]!.workId}`),
		};
	} finally {
		await host.close();
		mock.close();
	}
}

export async function goalChild<T>(
	phase: "work" | "report" | "crash",
	dir: string,
	command = bunExample,
) {
	const child = Bun.spawn(
		[process.execPath, "--no-env-file", import.meta.path, phase, dir, command],
		{ stdout: "pipe", stderr: "pipe" },
	);
	const timer = setTimeout(() => child.kill(), 15_000);
	try {
		const [code, stdout, stderr] = await Promise.all([
			child.exited,
			child.stdout.text(),
			child.stderr.text(),
		]);
		if (phase === "crash") {
			assert.equal(code, 73, stderr);
			return child.pid as T;
		}
		assert.equal(code, 0, stderr);
		return JSON.parse(stdout) as T;
	} finally {
		clearTimeout(timer);
	}
}

export async function runGoalScenario(
	name: GoalScenarioName,
	llm: LlmPort,
	onEvent?: (event: GoalHostEvent) => void,
	designer: GoalDesigner = fixtureDesigner,
) {
	const dir = mkdtempSync(join(tmpdir(), "ag-"));
	try {
		const revised = name === "goal-memory-revised";
		const command = revised ? npmExample : bunExample;
		const env = fixtureEnvironment(command);
		const trace = (event: GoalHostEvent) => {
			env.options.trace(event);
			onEvent?.(event);
		};
		const mock = openClaudeCodeMock(dir);
		let modelCalls = 0;
		const host = await openGoalHost({
			...env.options,
			designer,
			trace,
			dir,
			llm: {
				complete(req, signal) {
					modelCalls++;
					return llm.complete(req, signal);
				},
			},
			worker: {
				...mock,
				submit(request) {
					mock.submit(request);
					throw new Error("simulated worker acknowledgement loss");
				},
			},
			reports: mock,
		});
		let request: ReturnType<typeof checkAck>;
		let work: ReturnType<GoalHost["work"]>[number];
		let design: NonNullable<ReturnType<GoalHost["readNote"]>>;
		try {
			if (name === "goal-empty") {
				await host.tick();
				assert.equal(host.list().length, 10);
				assert.ok(host.list().every((slot) => slot.goal === null));
				assert.equal(mock.requests().length, 0);
				assert.equal(mock.deliveries().length, 0);
				assert.equal(modelCalls, 0);
				return {
					scenario: name,
					passed: true,
					modelCalls,
					requests: 0,
					executions: 0,
					reports: 0,
					claudeCodeProcesses: 0,
					webSearches: 0,
					goals: host.list(),
					events: env.events,
				};
			}
			env.opportunity.busy = true;
			const goalId = await seedCliGoal(host, env, revised);
			const researched = host.saveNote({
				title: "サンプル CLI の確認結果",
				summary: "コマンドの安全な説明方法を確認",
				markdown:
					"README では実行前プレビューの節に使用例を置き、実行例自体は起動しない。",
				refs: [],
				at: env.clock.at,
			});
			for (let i = 0; i < 24; i++)
				host.saveNote({
					title: `別テーマの調査 ${i}`,
					summary: "別プロジェクトの調査",
					markdown: `案件 ${i} の資料には色の設定方法がある。`,
					refs: [],
					at: env.clock.at + i,
				});
			host.observe({
				id: "user-chat",
				who: "user",
				text: "今日は曇りで涼しかったです。",
				at: env.clock.at,
			});
			await host.tick();
			assert.equal(modelCalls, 0);
			assert.equal(mock.requests().length, 0);
			trace({
				type: "conversation_idle",
				at: ++env.clock.at,
				data: { priorRequests: 0 },
			});
			env.opportunity.busy = false;
			await host.tick(AbortSignal.timeout(90_000));
			assert.equal(modelCalls, 1);
			assert.equal(
				mock.requests().length,
				0,
				"design and initial analysis must precede execution",
			);
			const designRef = host
				.notes()
				.find((n) => n.refs.includes(`goal-design:${goalId}:1`));
			assert.ok(designRef, JSON.stringify(env.events));
			const document = host.readNote(designRef.id);
			assert.ok(document);
			design = document;
			if (designer !== fixtureDesigner)
				assert.ok(design.refs.includes(`note:${researched.id}`));
			env.clock.at += GOAL_ANALYSIS_MS - 1;
			await host.tick(AbortSignal.timeout(90_000));
			assert.equal(mock.requests().length, 0);
			env.clock.at++;
			await host.tick(AbortSignal.timeout(90_000));
			request = checkAck(host, mock);
			assert.equal(request.design?.id, design.id);
			assert.equal(request.args.prompt, design.markdown);
			assert.equal(request.goalId, goalId);
			assert.equal(request.toolchainRevisionId, CLAUDE_CODE.revisionId);
			assert.equal(request.operationId, CLAUDE_CODE.operation);
			assert.equal(request.workspace, env.options.workspace);
			assert.ok(request.args.prompt.includes("README.md"));
			assert.ok(request.args.prompt.includes(command));
			assert.ok(!request.args.prompt.includes(otherExample));
			assert.ok(!request.args.prompt.includes("work-only.yaml"));
			if (revised) assert.ok(!request.args.prompt.includes(bunExample));
			work = host.work()[0]!;
			assert.equal(work.state, "confirmation_pending");
			assert.equal(work.work.usedMemory.length, 1);
			assert.equal(work.work.shownMemory.length, 2);
			const refs = work.work.shownMemory.filter((m) =>
				work.work.usedMemory.includes(m.id),
			);
			const expectedSource = createHash("sha256")
				.update(cliPreference(command))
				.digest("hex");
			assert.ok(refs[0]?.sources.some((ref) => ref.digest === expectedSource));
			const types = env.events.map((event) => event.type);
			assert.ok(
				types.includes("goal_analysis") &&
					types.indexOf("goal_analysis") < types.indexOf("submission"),
			);
		} finally {
			await host.close();
			mock.close();
		}
		const restarted = await goalChild<Awaited<ReturnType<typeof recover>>>(
			"work",
			dir,
			command,
		);
		const reportRestart = await goalChild<Awaited<ReturnType<typeof recover>>>(
			"report",
			dir,
			command,
		);
		assert.equal(
			new Set([process.pid, restarted.pid, reportRestart.pid]).size,
			3,
		);
		assert.equal(restarted.artifact?.workId, request.workId);
		assert.ok(restarted.artifact?.files[0]?.content.includes(command));
		assert.equal(reportRestart.reports.length, 1);
		return {
			scenario: name,
			passed: true,
			modelCalls,
			requests: 1,
			executions: 1,
			reports: 1,
			claudeCodeProcesses: 0,
			webSearches: 0,
			pid: process.pid,
			analysis: work.work.analysis,
			design,
			request,
			memory: { shown: work.work.shownMemory, selected: work.work.usedMemory },
			events: env.events,
			restarted,
			reportRestart,
		};
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

if (import.meta.main) {
	const [phase, dir, command] = process.argv.slice(2);
	assert.ok(dir && command);
	if (phase === "crash") {
		const env = fixtureEnvironment(command);
		const mock = openClaudeCodeMock(dir);
		const host = await openGoalHost({
			...env.options,
			dir,
			llm: fixturePlan((ctx) =>
				fixtureDelegation(
					ctx,
					ctx.goals.find((g) => g.priority === 60),
					ctx.memory.slice(0, 1),
				),
			),
			worker: {
				...mock,
				submit(request) {
					mock.submit(request);
					process.exit(73);
				},
			},
			reports: mock,
		});
		await seedCliGoal(host, env, false);
		await host.tick();
		env.clock.at += GOAL_ANALYSIS_MS;
		await host.tick();
		throw new Error("mock work was never submitted");
	}
	assert.ok(phase === "work" || phase === "report");
	console.log(JSON.stringify(await recover(dir, command, phase)));
}
