import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { READ_NOTE, SHOW_NOTE } from "../../src/agenda/index.ts";
import { RESEARCH_RETRY_MS } from "../../src/agenda/contracts.ts";
import { withGoalReplyTools } from "../../runtime/agenda/agenda-goals.ts";
import {
	openGoalHost,
	type GoalHost,
	type GoalHostOptions,
} from "../../runtime/agenda/goal-host.ts";
import { openClaudeCodeMock } from "../../runtime/agenda/goal-mock.ts";
import { GOAL_ANALYSIS_MS } from "../../runtime/agenda/goal-design.ts";
import {
	hasGoalSource,
	openGoalStore,
} from "../../runtime/agenda/goal-store.ts";
import {
	bunExample,
	CLI_KEY,
	cliPreference,
	fixtureDelegation,
	fixtureDesigner,
	fixtureEnvironment,
	fixturePlan,
	goalChild,
	goalInput,
	npmExample,
	readmeFiles,
	runGoalScenario,
	source,
} from "../../eval/agenda/goal-scenario.ts";

const integration = test.skipIf(!hasGoalSource());
const temp = () => mkdtempSync(join(tmpdir(), "ag-"));
const clean = (dir: string) => rmSync(dir, { recursive: true, force: true });

integration(
	"ten slots belong to the principal across scopes and preserve Eumenes goal revisions",
	async () => {
		const dir = temp();
		const owner = { principal: "owner", scopeKeys: ["work", "personal"] };
		const work = { ...owner, scopeKeys: ["work"] };
		const other = { principal: "other", scopeKeys: owner.scopeKeys };
		let store = await openGoalStore(dir, () => 0);
		try {
			const first = await store.register(owner, 3, goalInput("a", "work"));
			const firstTarget = { slot: 3, goalId: first.id, revision: 1 };
			expect(store.list(owner)).toHaveLength(10);
			expect(
				store.list(owner).flatMap((s) => (s.goal ? [s.slot] : [])),
			).toEqual([3]);
			await store.close();
			store = await openGoalStore(dir, () => 0);
			expect(store.list(work)[2]).toMatchObject({
				slot: 3,
				goal: {
					goalId: first.id,
					revision: 1,
					priority: 60,
					desiredState: goalInput("a").desiredState,
				},
			});
			expect(
				store.list({ ...owner, scopeKeys: ["personal"] })[2]?.goal,
			).toBeNull();
			expect(store.list(other).every((s) => s.goal === null)).toBe(true);
			await expect(
				store.revise(other, firstTarget, {
					source: source("b"),
					priority: 100,
				}),
			).rejects.toThrow("invalid_goal");
			await expect(
				store.revise({ ...owner, scopeKeys: ["personal"] }, firstTarget, {
					source: source("b"),
					priority: 100,
				}),
			).rejects.toThrow("invalid_goal");
			expect((await store.register(owner, 3, goalInput("a", "work"))).id).toBe(
				first.id,
			);
			await expect(
				store.register(owner, 4, goalInput("a", "work")),
			).rejects.toThrow("operation_conflict");
			await expect(
				store.register(owner, 3, { ...goalInput("a", "work"), priority: 1 }),
			).rejects.toThrow("operation_conflict");
			await store.revise(work, firstTarget, {
				source: source("b"),
				priority: 70,
				desiredState: "手順と確認結果を保存する",
			});
			await expect(
				store.revise(work, firstTarget, {
					source: source("c"),
					priority: 1,
				}),
			).rejects.toThrow("revision_conflict");
			expect(store.list(work)[2]?.goal).toMatchObject({
				priority: 70,
				revision: 2,
			});
			const contenders = await Promise.allSettled([
				store.register(owner, 1, goalInput("racer-one", "work")),
				store.register(owner, 1, goalInput("racer-two", "work")),
			]);
			expect(contenders.filter((r) => r.status === "fulfilled")).toHaveLength(
				1,
			);
			const loser =
				contenders[0]?.status === "rejected" ? "racer-one" : "racer-two";
			await store.register(owner, 2, goalInput(loser, "work"));
			for (const slot of [4, 5, 6, 7, 8, 9, 10])
				await store.register(
					owner,
					slot,
					goalInput(`slot-${slot}`, slot < 7 ? "work" : "personal"),
				);
			const filled = store.list(owner);
			expect(filled.filter((s) => s.goal?.scopeKey === "work")).toHaveLength(6);
			expect(
				filled.filter((s) => s.goal?.scopeKey === "personal"),
			).toHaveLength(4);
			await expect(
				store.register(owner, 11, goalInput("overflow")),
			).rejects.toThrow("invalid_goal_slot");
			await expect(
				store.register(owner, 3, goalInput("another")),
			).rejects.toThrow("goal_slot_occupied");
			expect(store.list(owner)).toEqual(filled);
			await store.register(other, 3, goalInput("another"));
			await store.withdraw(
				work,
				{ ...firstTarget, revision: 2 },
				{
					source: source("withdraw"),
				},
			);
			expect(store.list(work)[2]?.goal).toMatchObject({
				status: "withdrawn",
				revision: 3,
			});
			await store.release(work, { ...firstTarget, revision: 3 });
			await store.register(work, 3, goalInput("a", "work"));
			expect(store.list(work)[2]?.goal).toBeNull();
			const replacement = await store.register(
				work,
				3,
				goalInput("new-goal", "work"),
			);
			expect(replacement.id).not.toBe(first.id);
			await expect(
				store.authorize(work, firstTarget, "mock", null),
			).rejects.toThrow("goal_conflict");
			await expect(
				store.withdraw(work, firstTarget, { source: source("stale") }),
			).rejects.toThrow("goal_conflict");
			expect(store.list(work)[2]?.goal).toMatchObject({
				goalId: replacement.id,
				status: "adopted",
				revision: 1,
			});
		} finally {
			await store.close();
			clean(dir);
		}
	},
);

const targetFor = (host: GoalHost, slot = 3) => {
	const goal = host.list()[slot - 1]?.goal;
	if (!goal) throw new Error(`missing goal in slot ${slot}`);
	return { slot, goalId: goal.goalId, revision: goal.revision };
};

const designFor = (host: GoalHost) => {
	const slot = host.list()[2];
	if (!slot?.designNoteId || !slot.designDigest)
		throw new Error("missing design in slot 3");
	return { id: slot.designNoteId, digest: slot.designDigest };
};

async function hostFixture(
	input: {
		command?: string;
		decide?: Parameters<typeof fixturePlan>[0];
		prepare?: Parameters<typeof fixturePlan>[0];
		overrides?: (
			mock: ReturnType<typeof openClaudeCodeMock>,
		) => Partial<GoalHostOptions>;
	} = {},
) {
	const dir = temp();
	const env = fixtureEnvironment(input.command);
	const mock = openClaudeCodeMock(dir);
	const host = await openGoalHost({
		...env.options,
		dir,
		llm: fixturePlan((ctx, prompt) => {
			const choose = ctx.goals.some((goal) => goal.phase === "execute")
				? input.decide
				: input.prepare;
			return choose ? choose(ctx, prompt) : fixtureDelegation(ctx);
		}),
		worker: mock,
		reports: mock,
		...input.overrides?.(mock),
	});
	const register = async (allow = true) => {
		const goal = await host.register(3, goalInput("main"));
		return allow
			? host.authorize({ slot: 3, goalId: goal.id, revision: 1 })
			: undefined;
	};
	return {
		...env,
		host,
		mock,
		register,
		prepare: async () => {
			await host.tick();
			expect(mock.requests()).toHaveLength(0);
			env.clock.at += GOAL_ANALYSIS_MS;
		},
		close: async () => {
			await host.close();
			mock.close();
			clean(dir);
		},
	};
}

const expectOpen = (host: GoalHost) =>
	expect(host.list()[2]?.goal?.status).toBe("adopted");

integration(
	"a failed preparation plan wakes again without waiting for the next conversation",
	async () => {
		let calls = 0;
		const f = await hostFixture({
			prepare(ctx) {
				if (++calls === 1) throw new Error("temporarily unavailable");
				return fixtureDelegation(ctx);
			},
		});
		try {
			await f.register();
			await f.host.tick();
			expect(f.host.notes()).toHaveLength(0);
			expect(f.host.nextAt()).toBe(f.clock.at + RESEARCH_RETRY_MS);
			f.clock.at += RESEARCH_RETRY_MS;
			await f.host.tick();
			expect(calls).toBe(2);
			expect(f.host.notes()).toHaveLength(1);
			expect(f.mock.requests()).toHaveLength(0);
		} finally {
			await f.close();
		}
	},
);

integration(
	"appended Memory and research keep a viewed design and its accepted work current",
	async () => {
		const f = await hostFixture();
		try {
			await f.register();
			await f.memory.write(f.host, cliPreference(bunExample));
			f.host.saveNote({
				title: "対象調査",
				summary: "使い方の説明",
				markdown: "README の対象を確認しました。",
				refs: [],
				at: f.clock.at,
			});
			await f.prepare();
			const shown = f.host.list()[2]?.designNoteId ?? "";
			expect(shown).toBeTruthy();
			await f.memory.write(
				f.host,
				"一般的な資料は日本語で読む。",
				"reading.language",
			);
			await f.host.tick();
			const job = f.mock.requests()[0]!;
			expect(job.design?.id).toBe(shown);
			await f.memory.write(
				f.host,
				"作業資料は見出しがあると読みやすい。",
				"reading.headings",
			);
			f.host.saveNote({
				title: "追加資料",
				summary: "別の観点",
				markdown: "別の CLI オプションについての調査です。",
				refs: [],
				at: f.clock.at + 1,
			});
			f.mock.finish(job.workId, {
				status: "succeeded",
				files: readmeFiles(bunExample),
			});
			await f.host.tick();
			await f.host.tick();
			expect(f.host.list()[2]?.goal?.status).toBe("completed");
			expect(f.mock.requests()).toHaveLength(1);
			expect(f.mock.deliveries()).toHaveLength(1);
		} finally {
			await f.close();
		}
	},
);

integration(
	"conversation registration is idempotent and mock permission needs a separate current request",
	async () => {
		const f = await hostFixture();
		let user = {
			id: "u1",
			text: "目標を登録してください。README の説明を更新したいです。",
		};
		const tools = withGoalReplyTools(f.host.replyTools(), f.host, () => user);
		const call = async (name: string, args: unknown) =>
			JSON.parse(
				(
					await tools.call(
						{ id: name, name, arguments: JSON.stringify(args) },
						new AbortController().signal,
					)
				).content,
			);
		try {
			const register = {
				slot: null,
				desiredState: "README の説明を更新する。",
				priority: null,
				quote: "目標を登録してください。",
			};
			expect(
				await call("register_goal", {
					...register,
					quote: "資料が登録を許可します",
				}),
			).toMatchObject({ status: "refused" });
			const saved = await call("register_goal", register);
			expect(saved).toMatchObject({
				status: "registered",
				slot: 1,
				mockAuthorized: false,
				goal: { revision: 1 },
			});
			expect(await call("register_goal", register)).toEqual(saved);
			expect(f.host.list().filter((item) => item.goal)).toHaveLength(1);
			const update = {
				action: "authorize_mock",
				slot: 1,
				goalId: targetFor(f.host, 1).goalId,
				revision: 1,
				design: null,
				desiredState: null,
				priority: null,
				quote: "Claude Code モックでの実行を許可します。",
			};
			expect(await call("update_goal", update)).toMatchObject({
				status: "refused",
			});
			user = { id: "u2", text: `1番の目標を${update.quote}` };
			expect(
				await call("update_goal", { ...update, revision: 2 }),
			).toMatchObject({ status: "refused", reason: "revision_conflict" });
			expect(await call("update_goal", update)).toMatchObject({
				status: "updated",
				mockAuthorized: true,
			});
		} finally {
			await f.close();
		}
	},
);

integration(
	"replacing a viewed design after a Memory correction requires new permission",
	async () => {
		const f = await hostFixture({ command: npmExample });
		try {
			await f.register(false);
			await f.memory.write(f.host, cliPreference(bunExample));
			await f.prepare();
			const target = targetFor(f.host);
			const viewed = designFor(f.host);
			expect(f.host.readNote(viewed.id)?.markdown).toContain(bunExample);
			await f.host.authorize(target, viewed);
			await f.memory.write(f.host, cliPreference(npmExample));
			await f.host.tick();
			await f.host.tick();
			const revised = designFor(f.host);
			expect(revised).not.toEqual(viewed);
			expect(f.host.list()[2]?.mockAuthorized).toBe(false);
			expect(f.mock.requests()).toHaveLength(0);
			await expect(f.host.authorize(target, viewed)).rejects.toThrow(
				"design_changed",
			);
			await expect(
				f.host.authorize(target, { id: revised.id, digest: viewed.digest }),
			).rejects.toThrow("design_changed");
			await f.host.authorize(target, revised);
			await f.host.tick();
			expect(f.mock.requests()).toHaveLength(1);
			expect(f.mock.requests()[0]?.args.prompt).toBe(
				f.host.readNote(revised.id)?.markdown,
			);
			expect(f.mock.requests()[0]?.args.prompt).toContain(npmExample);
		} finally {
			await f.close();
		}
	},
);

integration(
	"after a late first idle, Codex notes stay readable through restart and their exact body becomes the work request",
	async () => {
		const dir = temp();
		const env = fixtureEnvironment();
		const worker = openClaudeCodeMock(dir);
		const markdown =
			"# README 設計書\n\n調査結果に従いプレビュー節を更新する。";
		let designs = 0;
		const open = () =>
			openGoalHost({
				...env.options,
				dir,
				worker,
				reports: worker,
				llm: fixturePlan((ctx) => fixtureDelegation(ctx)),
				designer: async (context) => {
					designs++;
					expect(context.notes).toHaveLength(32);
					expect(context.notes[31]?.markdown).toContain("決定済みの見出し");
					expect(JSON.stringify(context)).not.toContain("another-scope-secret");
					return {
						status: "ready",
						title: "README 設計書",
						summary: "プレビュー節を更新する",
						markdown,
						sources: ["note:" + context.notes[31]?.id],
						missing: null,
					};
				},
			});
		let host = await open();
		try {
			const goal = await host.register(3, goalInput("manual"));
			await host.authorize({ slot: 3, goalId: goal.id, revision: 1 });
			for (let i = 0; i < 32; i++)
				host.saveNote({
					title: `調査 ${i}`,
					summary: "調査結果",
					markdown:
						i === 31 ? "決定済みの見出しはプレビュー。" : `調査メモ ${i}`,
					at: env.clock.at + i,
					refs: [],
				});
			host.saveNote(
				{
					title: "別スコープ",
					summary: "別件",
					markdown: "another-scope-secret",
					at: env.clock.at,
					refs: [],
				},
				"work",
			);
			env.clock.at += 30 * 60_000;
			await host.tick();
			expect(worker.requests()).toHaveLength(0);
			const note = host
				.notes()
				.find((n) => n.refs.includes(`goal-design:${goal.id}:1`));
			expect(note).toBeDefined();
			const id = note!.id;
			env.opportunity.busy = true;
			expect(host.readNote(id)?.markdown).toBe(markdown);
			const shown: string[] = [];
			const tools = host.replyTools({
				onShow: (note) => shown.push(note.markdown),
			});
			const signal = new AbortController().signal;
			const read = await tools.call(
				{ id: "read", name: READ_NOTE, arguments: JSON.stringify({ id }) },
				signal,
			);
			expect(read.content).toContain(JSON.stringify(markdown));
			await tools.call(
				{ id: "show", name: SHOW_NOTE, arguments: JSON.stringify({ id }) },
				signal,
			);
			expect(shown).toEqual([markdown]);
			await host.close();
			host = await open();
			expect(host.readNote(id)?.markdown).toBe(markdown);
			env.opportunity.busy = false;
			env.clock.at += GOAL_ANALYSIS_MS - 1;
			await host.tick();
			expect(worker.requests()).toHaveLength(0);
			env.clock.at++;
			await host.tick();
			expect(designs).toBe(1);
			expect(worker.requests()).toHaveLength(1);
			expect(worker.requests()[0]).toMatchObject({
				design: { id },
				args: { prompt: markdown },
			});
		} finally {
			await host.close();
			worker.close();
			clean(dir);
		}
	},
);

integration(
	"a blocked design stays in analysis and a revised goal starts a fresh waiting period",
	async () => {
		let calls = 0;
		const f = await hostFixture({
			overrides: () => ({
				designer: async (input, signal) => {
					calls++;
					if (input.goal.revision === 1)
						return {
							status: "blocked",
							title: "調査メモ",
							summary: "対象を確認する",
							markdown: null,
							sources: [],
							missing: "作業対象の確認が必要です。",
						};
					return fixtureDesigner(input, signal);
				},
			}),
		});
		try {
			await f.register();
			await f.prepare();
			await f.host.tick();
			expect(calls).toBe(1);
			expect(f.host.notes()).toHaveLength(0);
			expect(f.mock.requests()).toHaveLength(0);
			await f.host.revise(targetFor(f.host), {
				source: source("specified"),
				desiredState: "README.md の実行例を改訂する。",
			});
			await f.host.authorize(targetFor(f.host));
			await f.host.tick();
			expect(calls).toBe(2);
			expect(f.host.notes()).toHaveLength(1);
			expect(f.mock.requests()).toHaveLength(0);
			f.clock.at += GOAL_ANALYSIS_MS;
			await f.host.tick();
			expect(f.mock.requests()[0]?.goalRevision).toBe(2);
		} finally {
			await f.close();
		}
	},
);

integration(
	"planning sees a source on the second Memory page and only the conversation scope",
	async () => {
		let planned = 0;
		const f = await hostFixture({
			prepare: (ctx) =>
				fixtureDelegation(
					ctx,
					ctx.goals[0],
					ctx.memory.filter((m) => m.text.includes(bunExample)),
				),
			decide: (ctx, prompt) => {
				planned++;
				expect(ctx.memory).toHaveLength(21);
				expect(
					ctx.memory.findIndex((item) => item.text.includes(bunExample)),
				).toBeGreaterThanOrEqual(20);
				expect(prompt).not.toContain("work-only-secret");
				return fixtureDelegation(
					ctx,
					ctx.goals[0],
					ctx.memory.filter((m) => m.text.includes(bunExample)),
				);
			},
		});
		try {
			await f.register();
			f.opportunity.scopeKey = "work";
			f.host.observe({
				id: "other",
				who: "user",
				text: "work-only-secret from conversation",
				at: f.clock.at,
			});
			await f.memory.write(
				f.host,
				"work-only-secret from Memory",
				CLI_KEY,
				"work",
			);
			f.opportunity.scopeKey = "personal";
			await f.memory.write(f.host, cliPreference(bunExample));
			await f.memory.writeBatch(
				f.host,
				Array.from({ length: 20 }, (_, index) => ({
					text: `別件のメモ ${index}`,
					key: `other-${index}`,
				})),
			);
			await f.prepare();
			await f.host.tick();
			expect(planned).toBe(1);
			const work = f.host.work()[0]?.work;
			expect(work?.shownMemory).toHaveLength(21);
			expect(work?.usedMemory).toHaveLength(1);
			expect(
				work?.shownMemory.find((ref) => ref.id === work?.usedMemory[0]),
			).toMatchObject({
				scopeKey: "personal",
				revision: 1,
				sources: [{ kind: "message" }],
			});
			expect(f.mock.requests()[0]?.args.prompt).toContain(bunExample);
		} finally {
			await f.close();
		}
	},
);

integration(
	"requires user permission and uses the live opportunity at admission",
	async () => {
		let calls = 0;
		let startConversation = () => {};
		const f = await hostFixture({
			decide: (ctx) => {
				calls++;
				if (calls === 1) expect(ctx.goals[0]?.authorization).toBeNull();
				else
					expect(ctx.goals[0]?.authorization).toMatchObject({
						workspace: "isolated-sample-cli",
						impact: "modify_existing",
					});
				if (calls === 2) startConversation();
				return fixtureDelegation(ctx);
			},
		});
		try {
			await f.register(false);
			f.opportunity.active = false;
			await f.host.tick();
			f.opportunity.active = true;
			f.host.setQuiet({ scope: "all", minutes: 1, at: f.clock.at });
			await f.host.tick();
			expect(calls).toBe(0);
			f.host.setQuiet({ scope: "all", minutes: 0, at: f.clock.at });
			await f.prepare();
			await f.host.tick();
			expect(f.host.list()[2]?.progress).toEqual({
				state: "確認待ち",
				reason: "permission_required",
			});
			expect(f.mock.requests()).toHaveLength(0);
			await f.host.authorize(targetFor(f.host), designFor(f.host));
			startConversation = () => {
				f.opportunity.busy = true;
			};
			await f.host.tick();
			expect(f.mock.requests()).toHaveLength(0);
			f.opportunity.busy = false;
			await Promise.all([f.host.tick(), f.host.tick()]);
			expect(f.mock.requests()).toHaveLength(1);
			expect(f.host.work()).toHaveLength(1);
		} finally {
			await f.close();
		}
	},
);

integration(
	"rejects a proposal whose goal, revision, toolchain or evidence was not offered",
	async () => {
		const bad = [
			{ goalId: "foreign" },
			{ goalRevision: 19 },
			{ toolchainRevisionId: "foreign" },
			{ memoryIds: ["other-scope"] },
		];
		const f = await hostFixture({
			decide: (ctx) => {
				const valid = fixtureDelegation(ctx);
				return {
					...valid,
					delegation: { ...valid.delegation, ...bad.shift() },
				};
			},
		});
		try {
			await f.register();
			await f.prepare();
			for (let i = 0; i < 4; i++) await f.host.tick();
			expect(f.events.filter((e) => e.type === "plan_rejected")).toHaveLength(
				4,
			);
			expect(f.mock.requests()).toHaveLength(0);
			await f.host.tick();
			expect(f.mock.requests()).toHaveLength(1);
		} finally {
			await f.close();
		}
	},
);

integration(
	"correction during planning blocks the stale request, then only current Memory is shown",
	async () => {
		let correct: () => Promise<unknown>;
		const prompts: string[] = [];
		const f = await hostFixture({
			command: npmExample,
			decide: async (ctx, prompt) => {
				prompts.push(prompt);
				if (prompts.length === 1) await correct();
				return fixtureDelegation(ctx);
			},
		});
		try {
			await f.register();
			await f.memory.write(f.host, cliPreference(bunExample));
			correct = () => f.memory.write(f.host, cliPreference(npmExample));
			await f.prepare();
			await f.host.tick();
			expect(f.mock.requests()).toHaveLength(0);
			expect(
				f.events.some(
					(e) =>
						e.type === "work_blocked" &&
						JSON.stringify(e.data).includes("memory_changed"),
				),
			).toBe(true);
			await f.host.tick();
			await f.host.tick();
			expect(prompts[1]).not.toContain(bunExample);
			expect(f.mock.requests()).toHaveLength(0);
			expect(f.host.list()[2]?.mockAuthorized).toBe(false);
			await f.host.authorize(targetFor(f.host), designFor(f.host));
			await f.host.tick();
			expect(f.mock.requests()[0]?.args.prompt).toContain(npmExample);
		} finally {
			await f.close();
		}
	},
);

for (const invalidate of [
	"forget",
	"revise",
	"withdraw",
	"revoke",
	"scope",
] as const) {
	integration(
		`${invalidate} invalidates an accepted result before goal completion`,
		async () => {
			const prompts: string[] = [];
			const f = await hostFixture({
				decide: (ctx, prompt) => {
					prompts.push(prompt);
					return fixtureDelegation(ctx);
				},
			});
			try {
				const permit = await f.register();
				await f.memory.write(f.host, cliPreference(bunExample));
				await f.prepare();
				await f.host.tick();
				const id = f.mock.requests()[0]!.workId;
				if (invalidate === "forget")
					await f.memory.write(
						f.host,
						"サンプル CLI の実行例の指定は忘れてください。",
						CLI_KEY,
						"personal",
						"forget",
					);
				if (invalidate === "revise")
					await f.host.revise(targetFor(f.host), {
						source: source("revision"),
						priority: 80,
					});
				if (invalidate === "withdraw")
					await f.host.withdraw(targetFor(f.host), {
						source: source("withdraw"),
					});
				if (invalidate === "revoke") await f.host.revoke(permit!);
				if (invalidate === "scope") f.config.scopes = ["work"];
				f.mock.finish(id, {
					status: "succeeded",
					files: readmeFiles(bunExample),
				});
				await f.host.tick();
				expect(f.host.list()[2]?.goal?.status).not.toBe("completed");
				expect(f.mock.deliveries()).toHaveLength(0);
				if (invalidate !== "scope")
					expect(f.host.work()[0]?.state).toBe("invalidated");
				if (invalidate === "forget") {
					expect(f.host.notes()).toHaveLength(0);
					await f.host.tick();
					await f.host.tick();
					expect(prompts[1]).not.toContain(bunExample);
				}
			} finally {
				await f.close();
			}
		},
	);
}

integration(
	"unknown lookup holds the reservation; definitive absence retries the same ID",
	async () => {
		let known = false;
		const sent: string[] = [];
		const f = await hostFixture({
			overrides: (mock) => ({
				worker: {
					...mock,
					submit: (request) => {
						sent.push(request.workId);
						if (sent.length === 1)
							throw new Error("connection lost before acceptance");
						return mock.submit(request);
					},
					lookup: (id) => (known ? mock.lookup(id) : { status: "unknown" }),
				},
			}),
		});
		try {
			await f.register();
			await f.prepare();
			await f.host.tick();
			await f.host.tick();
			expect(sent).toHaveLength(1);
			expect(f.host.list()[2]?.progress).toMatchObject({
				state: "確認待ち",
				reason: "work_lookup_unknown",
			});
			expect(f.mock.requests()).toHaveLength(0);
			known = true;
			await f.host.tick();
			await f.host.tick();
			expect(sent).toHaveLength(2);
			expect(sent[1]).toBe(sent[0]);
			const saved = f.mock.requests()[0]!;
			expect(f.mock.submit(saved)).toEqual({
				status: "accepted",
				workId: saved.workId,
			});
			expect(() => f.mock.submit({ ...saved, workspace: "elsewhere" })).toThrow(
				"mock_work_id_conflict",
			);
			expect(f.mock.requests()).toHaveLength(1);
		} finally {
			await f.close();
		}
	},
);

integration(
	"ignores a result for another work ID and waits for the actual worker result",
	async () => {
		let corrupt = true;
		const f = await hostFixture({
			overrides: (mock) => ({
				worker: {
					...mock,
					lookup: (id) => {
						const receipt = mock.lookup(id);
						return corrupt && "workId" in receipt
							? { ...receipt, workId: "unknown" }
							: receipt;
					},
				},
			}),
		});
		try {
			await f.register();
			await f.prepare();
			await f.host.tick();
			f.mock.finish(f.mock.requests()[0]!.workId, {
				status: "succeeded",
				files: readmeFiles(bunExample),
			});
			await f.host.tick();
			expectOpen(f.host);
			expect(f.mock.deliveries()).toHaveLength(0);
			corrupt = false;
			await f.host.tick();
			expect(f.host.list()[2]?.goal?.status).toBe("completed");
			await f.host.tick();
			expect(f.mock.deliveries()).toHaveLength(1);
		} finally {
			await f.close();
		}
	},
);

integration(
	"a valid mock success with the old example is partial and the next request receives the missing condition",
	async () => {
		const progress: (string | null)[] = [];
		const f = await hostFixture({
			command: npmExample,
			decide: (ctx) => {
				if (ctx.goals[0]!.authorization) progress.push(ctx.goals[0]!.progress);
				return fixtureDelegation(ctx);
			},
		});
		try {
			await f.register();
			await f.memory.write(f.host, cliPreference(npmExample));
			await f.prepare();
			await f.host.tick();
			f.mock.finish(f.mock.requests()[0]!.workId, {
				status: "succeeded",
				files: readmeFiles(bunExample),
			});
			await f.host.tick();
			expectOpen(f.host);
			expect(f.mock.deliveries()).toHaveLength(0);
			expect(f.host.work()[0]?.state).toBe("partial");
			await f.host.tick();
			expect(f.mock.requests()).toHaveLength(1);
			await f.host.tick();
			expect(f.mock.requests()).toHaveLength(1);
			expect(f.host.list()[2]?.mockAuthorized).toBe(false);
			await f.host.authorize(targetFor(f.host), designFor(f.host));
			await f.host.tick();
			expect(f.mock.requests()).toHaveLength(2);
			expect(progress).toEqual([null, "現在の Memory で指定した実行例"]);
			const next = f.mock.requests()[1]!;
			expect(next.args.prompt).toContain(npmExample);
			f.mock.finish(next.workId, {
				status: "succeeded",
				files: readmeFiles(npmExample),
			});
			await f.host.tick();
			const completed = f.host.list()[2]?.goal;
			expect(completed).toMatchObject({ status: "completed", revision: 2 });
			await f.host.tick();
			await f.host.release(targetFor(f.host));
			expect(f.host.list()[2]?.goal).toBeNull();
			expect(f.mock.deliveries()).toHaveLength(1);
		} finally {
			await f.close();
		}
	},
);

for (const mode of ["missing", "unreadable", "failed", "budget"] as const) {
	integration(
		`${mode} prevents unverified completion and a report`,
		async () => {
			let drain = () => {};
			const f = await hostFixture({
				decide(ctx) {
					if (mode === "budget") drain();
					return fixtureDelegation(ctx);
				},
				overrides: (mock) =>
					mode === "unreadable"
						? {
								worker: {
									...mock,
									readArtifact() {
										throw new Error("cannot read persisted diff");
									},
								},
							}
						: {},
			});
			try {
				await f.register();
				drain = () => {
					f.config.limit = 0;
				};
				await f.prepare();
				await f.host.tick();
				if (mode === "budget") {
					expect(f.mock.requests()).toHaveLength(0);
					expect(f.host.list()[2]?.progress?.reason).toBe("budget_exhausted");
				} else {
					const request = f.mock.requests()[0]!;
					f.mock.finish(request.workId, {
						status: mode === "failed" ? "failed" : "succeeded",
						...(mode === "unreadable"
							? { files: readmeFiles(bunExample) }
							: {}),
					});
					await f.host.tick();
					await f.host.tick();
					expect(f.host.work()[0]?.state).toBe(
						mode === "unreadable" ? "confirmation_pending" : "failed",
					);
					expect(f.mock.requests()).toHaveLength(1);
				}
				expectOpen(f.host);
				expect(f.mock.deliveries()).toHaveLength(0);
			} finally {
				await f.close();
			}
		},
	);
}

integration(
	"a plan for a different type of document uses its own goal and scoped constraint",
	async () => {
		const f = await hostFixture({
			overrides: () => ({
				verify: (goal, _work, artifact) => ({
					checks: [
						{
							condition: "US English",
							passed:
								goal.desiredState.includes("release notes") &&
								artifact.files[0]?.content === "Color palette updated.",
						},
					],
					summary: "Release notes updated.",
				}),
			}),
		});
		try {
			await f.host.register(3, {
				...goalInput("release"),
				desiredState:
					"Adjust the release notes in CHANGELOG.md. The entries should be in the saved locale.",
			});
			await f.host.authorize(targetFor(f.host));
			await f.memory.write(
				f.host,
				"Use US English for release notes.",
				"release-notes.locale",
			);
			await f.prepare();
			await f.host.tick();
			const request = f.mock.requests()[0]!;
			expect(request.args.prompt).toContain("CHANGELOG.md");
			expect(request.args.prompt).toContain("US English");
			f.mock.finish(request.workId, {
				status: "succeeded",
				files: [{ path: "CHANGELOG.md", content: "Color palette updated." }],
			});
			await f.host.tick();
			await f.host.tick();
			expect(f.mock.deliveries()[0]?.text).toBe(
				"できました。Release notes updated.",
			);
		} finally {
			await f.close();
		}
	},
);

integration(
	"a process killed after worker acceptance recovers task and report by the saved IDs",
	async () => {
		const dir = temp();
		try {
			const initialPid = await goalChild<number>("crash", dir);
			const worker = await goalChild<{
				pid: number;
				reports: { id: string }[];
			}>("work", dir);
			const report = await goalChild<typeof worker>("report", dir);
			expect(new Set([initialPid, worker.pid, report.pid]).size).toBe(3);
			expect(report.reports).toHaveLength(1);
			expect(report.reports[0]?.id).toBe(worker.reports[0]?.id);
		} finally {
			clean(dir);
		}
	},
);

integration(
	"empty and revised Memory scenarios run the same admission and recovery paths",
	async () => {
		const never = fixturePlan(() => {
			throw new Error("no goals, no planning");
		});
		expect(await runGoalScenario("goal-empty", never)).toMatchObject({
			modelCalls: 0,
			requests: 0,
			reports: 0,
		});
		const revised = await runGoalScenario(
			"goal-memory-revised",
			fixturePlan((ctx) =>
				fixtureDelegation(
					ctx,
					ctx.goals.find((g) => g.priority === 60),
					ctx.memory.filter((m) => m.text.includes(npmExample)),
				),
			),
		);
		expect(revised).toMatchObject({ requests: 1, reports: 1 });
	},
);

test("Agenda CLI rejects unknown case names before touching the settings or running any cases", async () => {
	for (const names of [
		["invalid-goal-case"],
		["goal-empty", "invalid-goal-case"],
	]) {
		const name = `agenda-unknown-${crypto.randomUUID()}`;
		const child = Bun.spawn(
			[
				process.execPath,
				resolve(import.meta.dir, "../../eval/agenda/live.ts"),
				name,
				...names,
			],
			{
				env: {
					...process.env,
					AGENCY_SETTINGS: "/does-not-exist/agenda-settings.json",
				},
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const [status, stderr] = await Promise.all([
			child.exited,
			child.stderr.text(),
		]);
		expect(status).not.toBe(0);
		expect(stderr).toContain("未登録のシナリオ: invalid-goal-case");
		expect(
			existsSync(resolve(import.meta.dir, `../../data/agenda/runs/${name}`)),
		).toBe(false);
	}
});
