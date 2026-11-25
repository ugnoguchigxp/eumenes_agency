import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import type { GoalStep } from "../../src/agenda/index.ts";
import {
	createGoalStore,
	goalMigrations,
	type GoalAccess,
} from "../../runtime/agenda/index.ts";
import { eumenesRoot, hasGoalSource } from "../../runtime/agenda/goal-store.ts";
import {
	contentDigest,
	validateRegisteredGoalDesign,
} from "../../runtime/agenda/goal-design.ts";

const integration = test.skipIf(!hasGoalSource());
type Migration = { id: string; sql: string; after?: readonly string[] };
type SharedStore = Parameters<typeof createGoalStore>[0] & {
	close(): Promise<void>;
};
type Goals = {
	migrations: readonly Migration[];
	createGoalsService(
		clock: () => string,
	): Parameters<typeof createGoalStore>[1];
};
const access: GoalAccess = { principal: "owner", scopeKeys: ["agenda"] };
const scopes = { agendaScopeKey: "agenda", ledgerScopeKey: "explicit" };
const original = "指定の入力から所定の結果を得る";
const source = { namespace: "message", kind: "user", id: "words" };
const input = {
	scopeKey: "agenda",
	desiredState: original,
	priority: 50,
	source,
	operationKey: "register:words",
	sourceMessageIds: ["words"],
};
const options = {
	mode: "goal",
	startedAt: 20,
	sourceRef: "words",
	deliveryConversationId: null,
} as const;
const guard = () => true;

async function fixture() {
	const dir = mkdtempSync(join(tmpdir(), "agency-goal-progress-"));
	const root = eumenesRoot();
	const [goals, sqlite] = await Promise.all([
		import(join(root, "api/domains/goals/index.ts")) as Promise<Goals>,
		import(join(root, "api/infrastructure/sqlite/index.ts")) as Promise<{
			openStore(file: string, migrations: readonly Migration[]): SharedStore;
		}>,
	]);
	const service = goals.createGoalsService(() => new Date(20).toISOString());
	const open = (legacy: boolean | "beforePolicies" = false) =>
		sqlite.openStore(join(dir, "test.sqlite"), [
			...goals.migrations,
			...(legacy === "beforePolicies"
				? goalMigrations.slice(0, -1)
				: legacy
					? goalMigrations.slice(0, -2)
					: goalMigrations),
		]);
	return {
		service,
		open,
		close: () => rmSync(dir, { recursive: true, force: true }),
	};
}

const readPolicy = (workspaceRef: string, policyGeneration = "v1") => ({
	policyKey: workspaceRef,
	policyGeneration,
	workspace: workspaceRef,
	toolchainRevisionId: "read@1",
	impact: "read",
	scope: {
		version: 1 as const,
		basis: { kind: "policy" as const, revision: "read@1" },
		workspaceRef,
		baselineCommit: policyGeneration,
		readablePaths: [workspaceRef],
		writablePaths: [],
		checks: [],
		expiresAtMs: null,
	},
});

integration(
	"read policies coexist with explicit authority and a user-revoked policy is not restored",
	async () => {
		const f = await fixture();
		const db = f.open();
		try {
			const goals = createGoalStore(db, f.service, scopes);
			const key = await db.write((tx) => register(tx, goals));
			const reconcile = (
				digest: string,
				policies: ReturnType<typeof readPolicy>[],
			) =>
				db.write((tx) =>
					goals.reconcileReadPoliciesInTransaction(tx, access, key, {
						digest,
						policies,
						summary: "許可された作業先を更新しました",
					}),
				);
			const initial = await reconcile("digest1", [
				readPolicy("workspace-a"),
				readPolicy("workspace-b"),
				readPolicy("web"),
			]);
			expect(initial.status).toBe("applied");
			expect(
				await reconcile("digest1", [
					readPolicy("workspace-a"),
					readPolicy("workspace-b"),
					readPolicy("web"),
				]),
			).toMatchObject({ status: "replayed", progress: initial.progress });
			const grant = (operationKey: string) =>
				db.write((tx) =>
					goals.authorizeWorkInTransaction(tx, access, key, {
						...readPolicy("workspace-a"),
						operationKey,
						impact: "edit",
						scope: {
							...readPolicy("workspace-a").scope,
							basis: { kind: "message", sourceRefs: ["words"] },
							writablePaths: ["manual"],
						},
					}),
				);
			const prior = await grant("explicit-old");
			const current = await grant("explicit-current");
			const permits = () =>
				db.read((tx) => goals.goalPermitsInTransaction(tx, access, key));
			expect(permits().map(({ id, policyKey }) => policyKey ?? id)).toEqual([
				current.permit.id,
				"web",
				"workspace-b",
				"workspace-a",
			]);
			expect(
				db.read((tx) =>
					goals.goalPermitInTransaction(tx, access, key, prior.permit.id),
				),
			).toMatchObject({ revoked: true, revocationReason: "superseded" });
			const revoked = permits().find(
				({ policyKey }) => policyKey === "workspace-a",
			)!;
			await db.write((tx) =>
				goals.revokeWorkInTransaction(
					tx,
					access,
					key,
					revoked.id,
					revoked.revision,
				),
			);
			const oldWeb = permits().find(({ policyKey }) => policyKey === "web")!;
			await reconcile("digest2", [
				readPolicy("workspace-a", "v2"),
				readPolicy("workspace-b"),
				readPolicy("web", "v2"),
			]);
			expect(
				permits()
					.map(({ id, policyKey }) => policyKey ?? id)
					.sort(),
			).toEqual([current.permit.id, "web", "workspace-b"].sort());
			expect(
				db.read((tx) =>
					goals.goalPermitInTransaction(tx, access, key, revoked.id),
				),
			).toMatchObject({ revoked: true, revocationReason: "user" });
			expect(
				db.read((tx) =>
					goals.goalPermitInTransaction(tx, access, key, oldWeb.id),
				),
			).toMatchObject({ revoked: true, revocationReason: "configuration" });
		} finally {
			await db.close();
			f.close();
		}
	},
);

integration(
	"the policy migration preserves an unchanged active permit and declines an ambiguous old revocation",
	async () => {
		const f = await fixture();
		const old = f.open("beforePolicies");
		const goals = createGoalStore(old, f.service, scopes);
		const key = await old.write((db) => {
			const key = register(db, goals);
			for (const [workspace, revoked] of [
				["active", 0],
				["unknown", 1],
			] as const) {
				const policy = readPolicy(workspace);
				db.query(`INSERT INTO goal_permits (id, principal, scope_key, goal_id, goal_revision, toolchain, workspace, impact, revoked, mode, scope_json)
				VALUES (?, ?, 'explicit', ?, 1, ?, ?, 'read', ?, 'goal', ?)`).run(
					workspace,
					key.principal,
					key.goalId,
					policy.toolchainRevisionId,
					workspace,
					revoked,
					JSON.stringify(policy.scope),
				);
			}
			return key;
		});
		await old.close();
		const db = f.open();
		try {
			const goals = createGoalStore(db, f.service, scopes);
			await db.write((tx) =>
				goals.reconcileReadPoliciesInTransaction(tx, access, key, {
					digest: "added",
					summary: "読取先を確認",
					policies: [readPolicy("active"), readPolicy("unknown")],
				}),
			);
			expect(
				db.read((tx) => goals.goalPermitsInTransaction(tx, access, key)),
			).toMatchObject([{ id: "active", revision: 1, policyKey: "active" }]);
			expect(
				db.read((tx) =>
					goals.goalPermitInTransaction(tx, access, key, "unknown"),
				),
			).toMatchObject({ revoked: true, revocationReason: "legacy_unknown" });
		} finally {
			await db.close();
			f.close();
		}
	},
);

integration(
	"configuration can resolve a current question without storing a fabricated answer",
	async () => {
		const f = await fixture();
		const db = f.open();
		try {
			const goals = createGoalStore(db, f.service, scopes);
			const key = await db.write((tx) => register(tx, goals));
			const first = await db.write((tx) =>
				goals.applyDecisionInTransaction(
					tx,
					access,
					key,
					{
						kind: "ask",
						contextId: "asking",
						progressVersion: 1,
						criterionIds: ["root"],
						reason: "比較材料がない",
						missing: "材料",
						question: "どの資料ですか？",
						review: null,
					},
					{ nowMs: 20, contextId: "asking", current: guard },
				),
			);
			if (first.status !== "applied") throw new Error("fixture_goal_question");
			const configured = await db.write((tx) =>
				goals.reconcileReadPoliciesInTransaction(tx, access, key, {
					digest: "added",
					summary: "資料を読めるようになった",
					policies: [readPolicy("document")],
				}),
			);
			if (configured.status !== "applied")
				throw new Error("fixture_goal_configuration");
			const config = configured.progress.state.configuration!;
			const step = {
				kind: "wait" as const,
				progressVersion: configured.progress.progressVersion,
				contextId: "resolved",
				criterionIds: ["root"],
				watchRef: "document",
				reason: "登録済みの資料に答えがあります",
				review: null,
				resolvedQuestionRefs: [first.resultRef],
			};
			const apply = (configurationRef: string, decision = step) =>
				db.write((tx) =>
					goals.applyDecisionInTransaction(tx, access, key, decision, {
						configurationRef,
						nowMs: 20,
						contextId: step.contextId,
						current: guard,
						watch: {
							ref: "document",
							condition: "到着",
							dueAtMs: null,
							producer: "markdown",
						},
					}),
				);
			expect(await apply("stale")).toEqual({ status: "forbidden" });
			expect(
				await apply(config.ref, {
					...step,
					resolvedQuestionRefs: ["another-goal"],
				}),
			).toEqual({ status: "forbidden" });
			const finished = await apply(config.ref);
			expect(finished).toMatchObject({
				status: "applied",
				progress: {
					state: {
						questions: [
							{
								ref: first.resultRef,
								resolution: {
									observationRef: config.ref,
									contextId: step.contextId,
								},
							},
						],
					},
				},
			});
			if (finished.status === "applied")
				expect(
					finished.progress.state.questions[0]?.answeredBy,
				).toBeUndefined();
			expect(
				await db.write((tx) =>
					goals.answerGoalQuestionInTransaction(
						tx,
						access,
						key,
						first.resultRef,
						"words",
						20,
					),
				),
			).toEqual({ status: "stale" });
		} finally {
			await db.close();
			f.close();
		}
	},
);
function register(db: Database, store: ReturnType<typeof createGoalStore>) {
	const goal = store.registerInTransaction(db, access, 1, input, options);
	return {
		principal: access.principal,
		goalId: goal.id,
		goalRevision: goal.revision,
	};
}

integration(
	"a goal question's identity ignores job and progress changes",
	async () => {
		const f = await fixture();
		const db = f.open();
		try {
			const goals = createGoalStore(db, f.service, scopes);
			const key = await db.write((tx) => register(tx, goals));
			const ask = (missing: string, question: string) =>
				db.write((tx) => {
					const row = goals.progressInTransaction(tx, access, key)!;
					const contextId = "question:" + row.progressVersion;
					return goals.applyDecisionInTransaction(
						tx,
						access,
						row,
						{
							kind: "ask",
							contextId,
							progressVersion: row.progressVersion,
							criterionIds: ["root"],
							reason: "比較する資料が必要",
							missing,
							question,
							review: null,
						},
						{ nowMs: 20, contextId, current: guard },
					);
				});
			const first = await ask("資料", "どの資料ですか？");
			if (first.status !== "applied") throw new Error("fixture_goal_question");
			expect(first.resultRef).toBe(
				contentDigest([
					[key.principal, key.goalId, key.goalRevision],
					["root"],
					"資料",
				]),
			);
			await db.write((tx) => {
				const advanced = goals.transitionProgressInTransaction(
					tx,
					access,
					key,
					first.progress.progressVersion,
					({ state }) => ({
						phase: "ready",
						state: { ...state, problem: "新しい観測" },
					}),
				)!;
				expect(
					goals.bindGoalJobInTransaction(
						tx,
						key,
						advanced.progressVersion,
						"next-job",
					),
				).toBe(true);
			});
			const repeated = await ask(" 資料 ", "どの資料を使いますか？");
			expect(repeated).toMatchObject({
				status: "applied",
				resultRef: first.resultRef,
				progress: { state: { questions: first.progress.state.questions } },
			});
			expect(
				db.read(
					(tx) => goals.progressInTransaction(tx, access, key)?.state.questions,
				),
			).toEqual(first.progress.state.questions);
		} finally {
			await db.close();
			f.close();
		}
	},
);

for (const disposition of ["pending", "answered", "resolved"] as const)
	integration(
		`legacy ${disposition} goal questions keep their issued reference`,
		async () => {
			const f = await fixture();
			const db = f.open();
			try {
				const goals = createGoalStore(db, f.service, scopes);
				const saved = await db.write((tx) => {
					const key = register(tx, goals);
					const designed = goals.adoptGoalCriteriaInTransaction(
						tx,
						access,
						key,
						{
							expectedVersion: 1,
							design: { id: "design", digest: "digest" },
							source: original,
							criteria: [{ sourceQuote: "所定の結果", text: "結果を照合する" }],
						},
					);
					if (designed.status !== "applied")
						throw new Error("fixture_goal_design");
					return goals.transitionProgressInTransaction(
						tx,
						access,
						key,
						designed.progress.progressVersion,
						({ state }) => ({
							phase: "ready",
							state: {
								...state,
								questions: [
									{
										ref: "already-issued-reference",
										criterionIds: ["root.1", "root"],
										missing: " 資料 ",
										question: "元の質問です。",
										...(disposition === "answered" && {
											answeredBy: "earlier-reply",
										}),
										...(disposition === "resolved" && {
											resolution: {
												observationRef: "earlier-configuration",
												contextId: "earlier-context",
												progressVersion: 1,
												reason: "資料を確認できた",
											},
										}),
									},
								],
							},
						}),
					)!;
				});
				const repeated = await db.write((tx) =>
					goals.applyDecisionInTransaction(
						tx,
						access,
						saved,
						{
							kind: "ask",
							contextId: "new-context",
							progressVersion: saved.progressVersion,
							criterionIds: ["root", "root.1"],
							reason: "比較する資料が必要",
							missing: "資料",
							question: "言い換えた質問です。",
							review: null,
						},
						{ nowMs: 20, contextId: "new-context", current: guard },
					),
				);
				if (disposition === "pending")
					expect(repeated).toMatchObject({
						status: "applied",
						resultRef: "already-issued-reference",
					});
				else expect(repeated).toEqual({ status: "forbidden" });
				expect(
					db.read(
						(tx) =>
							goals.progressInTransaction(tx, access, saved)?.state.questions,
					),
				).toEqual(saved.state.questions);
			} finally {
				await db.close();
				f.close();
			}
		},
	);

integration(
	"old rows keep their mock owner and real progress uses the Goals ledger scope",
	async () => {
		const f = await fixture();
		const old = f.open(true);
		const key = await old.write((db) => {
			const goal = f.service.adoptInTransaction(
				db,
				{ ...access, scopeKeys: ["explicit"] },
				{ ...input, scopeKey: "explicit" },
			);
			db.query("INSERT INTO goal_slots VALUES ('owner', 1, ?)").run(goal.id);
			db.query(`INSERT INTO goal_work (id, principal, goal_id, goal_revision, payload, state)
			VALUES ('work', 'owner', ?, 1, '{"request":{"workId":"work"}}', 'accepted')`).run(
				goal.id,
			);
			return { principal: "owner", goalId: goal.id, goalRevision: 1 };
		});
		await old.close();
		const db = f.open();
		try {
			const store = createGoalStore(db, f.service, scopes);
			expect(store.work("owner")[0]?.work.request.workId).toBe("work");
			expect(
				await db.write((tx) =>
					store.activateLegacyGoalsInTransaction(tx, access, 100),
				),
			).toEqual([]);
			await store.setWork("work", "failed");
			const progress = await db.write((tx) =>
				store.activateLegacyGoalsInTransaction(tx, access, 101),
			);
			expect(progress).toHaveLength(1);
			expect(progress[0]).toMatchObject({
				...key,
				ledgerScope: "explicit",
				mode: "goal",
				progressVersion: 1,
				needsEnqueue: true,
				state: {
					sourceRef: null,
					startedAt: 101,
					criteria: [{ id: "root", text: original }],
				},
			});
			expect(
				db.read((tx) => store.goalAttemptsInTransaction(tx, access, key)),
			).toEqual([]);
			expect(store.work("owner")[0]?.state).toBe("failed");
			expect(store.list(access, "mock")[0]?.goal).toBeNull();
		} finally {
			await db.close();
			f.close();
		}
	},
);

integration(
	"first verified design binds immutable source-based goal criteria",
	async () => {
		const f = await fixture();
		const db = f.open();
		try {
			const store = createGoalStore(db, f.service, scopes);
			const key = await db.write((tx) => register(tx, store));
			const modelInput = {
				sourceText: original,
				purpose: original,
				workspace: "workspace",
				analysis: "分析",
				brief: { task: "目標", prompt: original },
				memory: [],
				notes: [],
			};
			const draft = {
				status: "ready",
				title: "確認",
				summary: "検査",
				markdown: "検査する",
				sources: [],
				missing: null,
				criteria: [
					{ sourceQuote: "所定の結果", text: "結果が固定値と一致する" },
				],
			};
			expect(() =>
				validateRegisteredGoalDesign(modelInput, {
					...draft,
					criteria: [{ sourceQuote: "架空", text: "基準" }],
				}),
			).toThrow("goal_criterion_source_invalid");
			const { criteria } = validateRegisteredGoalDesign(modelInput, draft);
			const data = {
				expectedVersion: 1,
				design: { id: "document", digest: "actual" },
				source: original,
				criteria,
			};
			const first = await db.write((tx) =>
				store.adoptGoalCriteriaInTransaction(tx, access, key, data),
			);
			expect(first).toMatchObject({
				status: "applied",
				progress: { progressVersion: 2 },
				criteria: [
					{ id: "root", text: original },
					{ id: "root.1", ...criteria[0] },
				],
			});
			const again = await db.write((tx) =>
				store.adoptGoalCriteriaInTransaction(tx, access, key, data),
			);
			expect(again).toMatchObject({
				status: "replayed",
				criteria: [
					{ id: "root", text: original },
					{ id: "root.1", ...criteria[0] },
				],
			});
			expect(
				await db.write((tx) =>
					store.adoptGoalCriteriaInTransaction(tx, access, key, {
						...data,
						design: { ...data.design, digest: "changed" },
					}),
				),
			).toEqual({ status: "conflict" });
		} finally {
			await db.close();
			f.close();
		}
	},
);

integration(
	"concurrent decisions and receipts reserve, adopt and observe only once",
	async () => {
		const f = await fixture();
		const db = f.open();
		try {
			const store = createGoalStore(db, f.service, scopes);
			const key = await db.write((tx) => register(tx, store));
			const grant = await db.write((tx) =>
				store.authorizeWorkInTransaction(tx, access, key, {
					operationKey: "words:grant",
					toolchainRevisionId: "toolchain:read@1",
					workspace: "workspace",
					impact: "read",
					scope: {
						version: 1,
						basis: { kind: "policy", revision: "1" },
						workspaceRef: "workspace",
						baselineCommit: "head",
						readablePaths: ["*"],
						writablePaths: [],
						checks: [],
						expiresAtMs: null,
					},
				}),
			);
			const step: GoalStep = {
				contextId: "choose",
				progressVersion: grant.progress.progressVersion,
				criterionIds: ["root"],
				reason: "根拠を読む",
				review: null,
				kind: "act",
				capabilityRef: "read",
				request: "参照",
				expectedObservation: "条件と照合",
				evidenceRefs: [],
			};
			const admission = {
				nowMs: 20,
				contextId: step.contextId,
				current: guard,
				act: {
					permitId: grant.permit.id,
					permitRevision: grant.permit.revision,
					bindingRevisionId: "read@1",
					owner: "reader",
				},
			};
			const run = (value: GoalStep) =>
				db.write((tx) =>
					store.applyDecisionInTransaction(tx, access, key, value, admission),
				);
			const [a, b] = await Promise.all([
				run(step),
				run({ ...step, request: "違う依頼" }),
			]);
			expect(a.status).toBe("applied");
			expect(b.status).toBe("conflict");
			const attempt = db.read((tx) =>
				store.goalAttemptsInTransaction(tx, access, key),
			)[0]!;
			expect(await run(step)).toEqual({
				status: "replayed",
				resultRef: attempt.id,
			});
			const observe = (
				version: number,
				digest: string,
				outcome: "running" | "failed",
			) =>
				db.write((tx) =>
					store.observeInTransaction(
						tx,
						access,
						key,
						{
							producer: "reader",
							ref: attempt.dispatchId,
							version: String(version),
							digest,
							attempt: {
								id: attempt.id,
								dispatchId: attempt.dispatchId,
								ownerWorkId: "receipt",
								ownerRevision: version,
								outcome,
								observed: "実測",
								resultRef: null,
							},
						},
						{ current: guard },
					),
				);
			expect((await observe(2, "updated", "failed")).status).toBe("applied");
			expect((await observe(2, "updated", "failed")).status).toBe("replayed");
			expect((await observe(2, "different", "failed")).status).toBe("conflict");
			expect((await observe(1, "old", "running")).status).toBe("stale");
			expect(
				db.read((tx) => store.progressInTransaction(tx, access, key)),
			).toMatchObject({
				phase: "ready",
				progressVersion: step.progressVersion + 2,
			});
			expect(
				db.read((tx) => store.goalAttemptsInTransaction(tx, access, key)),
			).toEqual([
				expect.objectContaining({
					ownerWorkId: "receipt",
					ownerRevision: 2,
					outcome: "failed",
				}),
			]);
		} finally {
			await db.close();
			f.close();
		}
	},
);

integration(
	"a report insertion failure rolls back goal completion and the progress update together",
	async () => {
		const f = await fixture();
		const db = f.open();
		try {
			const store = createGoalStore(db, f.service, scopes);
			const key = await db.write((tx) => register(tx, store));
			const step: GoalStep = {
				contextId: "verify",
				progressVersion: 1,
				criterionIds: ["root"],
				reason: "実物を照合",
				review: null,
				kind: "verify",
				checks: [
					{ checkRef: "compare", criterionId: "root", evidenceRefs: [] },
				],
			};
			const selection = await db.write((tx) =>
				store.applyDecisionInTransaction(tx, access, key, step, {
					contextId: step.contextId,
					nowMs: 20,
					current: guard,
				}),
			);
			if (selection.status !== "applied")
				throw new Error("test_verify_not_adopted");
			const checked = await db.write((tx) =>
				store.recordGoalChecksInTransaction(tx, access, key, {
					expectedVersion: selection.progress.progressVersion,
					current: guard,
					checks: [
						{
							criterionId: "root",
							checkRef: "compare",
							passed: true,
							evidence: {
								ref: "actual-output",
								version: "1",
								digest: "same",
								summary: "実測が一致",
							},
						},
					],
				}),
			);
			const complete = () =>
				db.write((tx) =>
					store.completeInTransaction(tx, access, key, {
						expectedVersion: checked!.progressVersion,
						text: "実測が一致しました",
						current: guard,
					}),
				);
			await db.write((tx) =>
				tx.exec(
					"CREATE TRIGGER reject_report BEFORE INSERT ON goal_reports BEGIN SELECT RAISE(ABORT, 'failed_report'); END",
				),
			);
			await expect(complete()).rejects.toThrow("failed_report");
			expect(store.goal(access, key.goalId)?.status).toBe("adopted");
			expect(
				db.read((tx) => store.progressInTransaction(tx, access, key)?.phase),
			).toBe("verifying");
			expect(
				db.read((tx) => store.goalReportsInTransaction(tx, access)),
			).toEqual([]);
			await db.write((tx) => tx.exec("DROP TRIGGER reject_report"));
			expect((await complete()).status).toBe("applied");
			expect(await complete()).toEqual({
				status: "replayed",
				resultRef: key.goalId + ":2",
			});
			expect(store.goal(access, key.goalId)?.status).toBe("completed");
			expect(
				db.read((tx) => store.goalReportsInTransaction(tx, access)),
			).toEqual([
				expect.objectContaining({
					state: "ledger_only",
					report: expect.objectContaining({ ...key, completedRevision: 2 }),
				}),
			]);
		} finally {
			await db.close();
			f.close();
		}
	},
);
