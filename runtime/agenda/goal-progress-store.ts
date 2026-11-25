import type { Database } from "bun:sqlite";
import {
	canResolveGoalQuestion,
	goalOwnerQuestionCriteria,
} from "./goal-progress-contracts.ts";
import { randomUUID } from "node:crypto";
import { goalStepSchema, type GoalStep } from "../../src/agenda/index.ts";
import {
	contentDigest,
	type GoalDesignRef,
	type GoalDesignCriterion,
} from "./goal-design.ts";
import type {
	GoalAttempt,
	GoalEvidence,
	GoalMode,
	GoalObservation,
	GoalPermitGrant,
	GoalReadPolicyGrant,
	GoalPhase,
	GoalProgress,
	GoalProgressKey,
	GoalProgressState,
	GoalQuestion,
	GoalReportV1,
	GoalWatch,
} from "./goal-progress-contracts.ts";
import type { GoalAccess, GoalSource, StoredGoal } from "./goal-store.ts";
import {
	applyReadPolicy,
	insertGoalPermit,
	matchesPolicy,
	permitForOperation,
	permitSpec,
	readGoalPermits,
	retireGoalPermits,
	revokeGoalPermit,
} from "./goal-permits.ts";

export const progressMigration = {
	id: "agency-goals/0005-progress",
	after: ["agency-goals/0004-design-documents"],
	sql: `
CREATE TABLE goal_progress (
  principal TEXT NOT NULL, goal_id TEXT NOT NULL REFERENCES goals_ledger(id) ON DELETE CASCADE,
  goal_revision INTEGER NOT NULL, ledger_scope TEXT NOT NULL,
  mode TEXT NOT NULL CHECK(mode IN ('mock','goal')),
  progress_version INTEGER NOT NULL CHECK(progress_version >= 1),
  phase TEXT NOT NULL CHECK(phase IN ('ready','dispatch','observing','waiting','needs_user','verifying','completed','withdrawn','superseded')),
  current_work_id TEXT, delivery_conversation_id TEXT, job_id TEXT, due_at_ms INTEGER,
  needs_enqueue INTEGER NOT NULL DEFAULT 0 CHECK(needs_enqueue IN (0,1)),
  state_json TEXT NOT NULL, PRIMARY KEY(principal, goal_id, goal_revision)
);
CREATE INDEX goal_progress_pending ON goal_progress(needs_enqueue, due_at_ms) WHERE needs_enqueue=1;
CREATE TABLE goal_observations (
  principal TEXT NOT NULL, goal_id TEXT NOT NULL, goal_revision INTEGER NOT NULL,
  producer TEXT NOT NULL, ref TEXT NOT NULL, version TEXT NOT NULL, digest TEXT NOT NULL,
  PRIMARY KEY(principal, goal_id, goal_revision, producer, ref, version),
  FOREIGN KEY(principal, goal_id, goal_revision) REFERENCES goal_progress ON DELETE CASCADE
);
CREATE TABLE goal_scope_controls (
  principal TEXT NOT NULL, scope_key TEXT NOT NULL, generation INTEGER NOT NULL,
  speech_until_ms INTEGER, all_until_ms INTEGER,
  PRIMARY KEY(principal, scope_key)
);
ALTER TABLE goal_permits ADD COLUMN mode TEXT NOT NULL DEFAULT 'mock' CHECK(mode IN ('mock','goal'));
ALTER TABLE goal_permits ADD COLUMN permit_revision INTEGER NOT NULL DEFAULT 1;
ALTER TABLE goal_permits ADD COLUMN scope_json TEXT;
ALTER TABLE goal_permits ADD COLUMN grant_operation_key TEXT;
CREATE UNIQUE INDEX goal_permits_operation ON goal_permits(principal, grant_operation_key)
  WHERE mode='goal' AND grant_operation_key IS NOT NULL;
ALTER TABLE goal_work ADD COLUMN mode TEXT NOT NULL DEFAULT 'mock' CHECK(mode IN ('mock','goal'));
ALTER TABLE goal_work ADD COLUMN dispatch_id TEXT;
CREATE UNIQUE INDEX goal_work_dispatch ON goal_work(dispatch_id) WHERE dispatch_id IS NOT NULL;
ALTER TABLE goal_reports ADD COLUMN mode TEXT NOT NULL DEFAULT 'mock' CHECK(mode IN ('mock','goal'));
`,
} as const;

const keyArgs = ({ principal, goalId, goalRevision }: GoalProgressKey) =>
	[principal, goalId, goalRevision] as const;
const goalQuestionRef = (
	key: GoalProgressKey,
	{ criterionIds, missing }: Pick<GoalQuestion, "criterionIds" | "missing">,
) =>
	contentDigest([
		keyArgs(key),
		[...new Set(criterionIds)].sort(),
		missing.trim(),
	]);
const keyWhere = "principal=? AND goal_id=? AND goal_revision=?";
const terminal = (phase: GoalPhase) =>
	phase === "completed" || phase === "withdrawn" || phase === "superseded";
const enqueueable = (phase: GoalPhase, dueAtMs: number | null) =>
	phase === "ready" ||
	phase === "dispatch" ||
	phase === "observing" ||
	phase === "verifying" ||
	((phase === "waiting" || phase === "needs_user") && dueAtMs !== null);

type ProgressRow = Omit<GoalProgress, "state" | "needsEnqueue"> & {
	stateJson: string;
	needsEnqueue: number;
};
const progressColumns = `principal, goal_id AS goalId, goal_revision AS goalRevision,
	ledger_scope AS ledgerScope, mode, progress_version AS progressVersion, phase,
	current_work_id AS currentWorkId, delivery_conversation_id AS deliveryConversationId,
	job_id AS jobId, due_at_ms AS dueAtMs, needs_enqueue AS needsEnqueue, state_json AS stateJson`;
function decodeProgress({
	stateJson,
	needsEnqueue,
	...row
}: ProgressRow): GoalProgress {
	const state = JSON.parse(stateJson) as GoalProgressState;
	if (state.version !== 1) throw new Error("goal_progress_version_unknown");
	return { ...row, needsEnqueue: needsEnqueue === 1, state };
}

function decodeAttempt(payload: string): GoalAttempt {
	const attempt = JSON.parse(payload) as GoalAttempt;
	if (attempt.version !== 1) throw new Error("goal_attempt_version_unknown");
	return attempt;
}

type Change =
	| { status: "applied"; progress: GoalProgress; resultRef: string }
	| { status: "replayed"; resultRef: string }
	| { status: "stale" | "conflict" | "busy" | "forbidden" };
type Advance = Pick<GoalProgress, "phase" | "state"> &
	Partial<Pick<GoalProgress, "currentWorkId" | "dueAtMs">>;

function readyOrNeedsUser(
	criteria: GoalProgressState["criteria"],
	questions: readonly GoalQuestion[],
): GoalPhase {
	const blocked = goalOwnerQuestionCriteria(questions, criteria);
	return blocked.size &&
		!criteria.some(({ id, status }) => status === "open" && !blocked.has(id))
		? "needs_user"
		: "ready";
}

type Admit = {
	permitId: string;
	permitRevision: number;
	bindingRevisionId: string;
	owner: string;
	operationRef?: string;
};
export interface GoalDecisionAdmission {
	readonly contextId: string;
	readonly nowMs: number;
	readonly current: (db: Database, progress: GoalProgress) => boolean;
	readonly act?: Admit;
	readonly watch?: GoalWatch;
	readonly canProceedWhileAsking?: boolean;
	readonly retryWhileAsking?: GoalWatch;
	readonly questionSources?: readonly string[];
	readonly configurationRef?: string;
}

function withEvidence(
	state: GoalProgressState,
	additions: readonly GoalEvidence[],
) {
	const evidence = new Map(state.evidence.map((item) => [item.ref, item]));
	const changed = new Set<string>();
	for (const item of additions) {
		const old = evidence.get(item.ref);
		if (old && (old.version !== item.version || old.digest !== item.digest))
			changed.add(item.ref);
		evidence.set(item.ref, item);
	}
	return {
		...state,
		evidence: [...evidence.values()],
		criteria: state.criteria.map((criterion) =>
			criterion.evidenceRefs.some((ref) => changed.has(ref))
				? { ...criterion, status: "open" as const, evidenceRefs: [] }
				: criterion,
		),
	};
}

export function createGoalProgressStore(owners: {
	ledgerAccess(access: GoalAccess): GoalAccess;
	goal(
		db: Database,
		access: GoalAccess,
		goalId: string,
	): StoredGoal | undefined;
	complete(
		db: Database,
		access: GoalAccess,
		key: GoalProgressKey,
		source: GoalSource,
	): { revision: number };
}) {
	const allowed = (access: GoalAccess, key: GoalProgressKey, scope: string) =>
		access.principal === key.principal &&
		owners.ledgerAccess(access).scopeKeys.includes(scope);
	const read = (db: Database, access: GoalAccess, key: GoalProgressKey) => {
		const row = db
			.query<ProgressRow, [string, string, number]>(
				`SELECT ${progressColumns} FROM goal_progress WHERE ${keyWhere}`,
			)
			.get(...keyArgs(key));
		return row && allowed(access, key, row.ledgerScope)
			? decodeProgress(row)
			: null;
	};
	const active = (db: Database, access: GoalAccess, key: GoalProgressKey) => {
		const progress = read(db, access, key);
		if (!progress || progress.mode !== "goal" || terminal(progress.phase))
			return null;
		const goal = owners.goal(db, access, key.goalId);
		return goal?.status === "adopted" &&
			goal.revision === key.goalRevision &&
			goal.scopeKey === progress.ledgerScope
			? progress
			: null;
	};
	const permit = (
		db: Database,
		access: GoalAccess,
		key: GoalProgressKey,
		id?: string,
	) => {
		const progress = active(db, access, key);
		if (!progress) return null;
		const permits = readGoalPermits(db, progress);
		if (id !== undefined)
			return permits.find((permit) => permit.id === id) ?? null;
		return (
			permits.find(
				(permit) => !permit.revoked && permit.scope.basis.kind === "message",
			) ??
			permits.find((permit) => !permit.revoked) ??
			null
		);
	};
	const attempts = (db: Database, access: GoalAccess, key: GoalProgressKey) =>
		read(db, access, key)
			? db
					.query<{ payload: string }, [string, string, number]>(
						`SELECT payload FROM goal_work WHERE ${keyWhere} AND mode='goal' ORDER BY rowid`,
					)
					.all(...keyArgs(key))
					.map(({ payload }) => decodeAttempt(payload))
			: [];
	const attemptAt = (db: Database, key: GoalProgressKey, id: string) => {
		const row = db
			.query<{ payload: string }, [string, string, number, string]>(
				`SELECT payload FROM goal_work WHERE ${keyWhere} AND id=? AND mode='goal'`,
			)
			.get(...keyArgs(key), id);
		return row ? decodeAttempt(row.payload) : null;
	};
	const parkedAttempts = (db: Database, key: GoalProgressKey) =>
		db
			.query<{ payload: string }, [string, string, number]>(
				`SELECT payload FROM goal_work WHERE ${keyWhere} AND mode='goal' AND state='waiting_user' ORDER BY rowid`,
			)
			.all(...keyArgs(key))
			.map(({ payload }) => decodeAttempt(payload));
	const isParked = (db: Database, key: GoalProgressKey, id: string) =>
		!!db
			.query(
				`SELECT 1 FROM goal_work WHERE ${keyWhere} AND mode='goal' AND state='waiting_user' AND id=?`,
			)
			.get(...keyArgs(key), id);
	const updateAttempt = (
		db: Database,
		attempt: GoalAttempt,
		waiting = false,
	) => {
		const state = waiting
			? "waiting_user"
			: attempt.outcome === "running"
				? "accepted"
				: attempt.outcome;
		db.query(
			`UPDATE goal_work SET payload=?, state=?, reason=? WHERE ${keyWhere} AND id=? AND mode='goal'`,
		).run(
			JSON.stringify(attempt),
			state,
			attempt.observed,
			...keyArgs(attempt),
			attempt.id,
		);
	};
	const openWork = (db: Database, principal: string) =>
		Boolean(
			db
				.query(
					`SELECT 1 FROM goal_work WHERE principal=? AND state IN ('reserved','accepted','confirmation_pending')`,
				)
				.get(principal),
		);
	const advance = (db: Database, current: GoalProgress, next: Advance) => {
		const due = next.dueAtMs ?? null;
		const work =
			next.currentWorkId === undefined
				? current.currentWorkId
				: next.currentWorkId;
		const needs =
			current.mode === "goal" &&
			(enqueueable(next.phase, due) ||
				(terminal(next.phase) &&
					(work !== null || parkedAttempts(db, current).length > 0)));
		const changed = db
			.query(`UPDATE goal_progress SET progress_version=progress_version+1,
			phase=?, current_work_id=?, due_at_ms=?, needs_enqueue=?, state_json=?
			WHERE ${keyWhere} AND progress_version=?`)
			.run(
				next.phase,
				work,
				due,
				Number(needs),
				JSON.stringify(next.state),
				...keyArgs(current),
				current.progressVersion,
			);
		if (changed.changes !== 1) return null;
		return {
			...current,
			...next,
			currentWorkId: work,
			dueAtMs: due,
			needsEnqueue: needs,
			progressVersion: current.progressVersion + 1,
		};
	};
	const initialize = (
		db: Database,
		principal: string,
		goal: StoredGoal,
		setup: {
			mode: GoalMode;
			sourceRef: string | null;
			startedAt: number;
			deliveryConversationId: string | null;
		},
	) => {
		const state: GoalProgressState = {
			version: 1,
			sourceRef: setup.sourceRef,
			startedAt: setup.startedAt,
			criteria: [
				{
					id: "root",
					text: goal.desiredState,
					sourceQuote: null,
					status: "open",
					evidenceRefs: [],
				},
			],
			evidence: [],
			design: null,
			watch: null,
			questions: [],
			next: null,
			review: null,
			reviewedAttemptCount: 0,
			lastDecision: null,
			problem: null,
		};
		db.query(`INSERT INTO goal_progress
			(principal, goal_id, goal_revision, ledger_scope, mode, progress_version, phase, delivery_conversation_id, needs_enqueue, state_json)
			VALUES (?, ?, ?, ?, ?, 1, 'ready', ?, ?, ?)
			ON CONFLICT(principal, goal_id, goal_revision) DO NOTHING`).run(
			principal,
			goal.goalId,
			goal.revision,
			goal.scopeKey,
			setup.mode,
			setup.deliveryConversationId,
			Number(setup.mode === "goal"),
			JSON.stringify(state),
		);
	};
	const reportRows = (db: Database, principal?: string) =>
		db
			.query<
				{
					payload: string;
					state: "pending" | "delivered" | "ledger_only" | "invalidated";
				},
				[string | null, string | null]
			>(
				"SELECT payload, state FROM goal_reports WHERE mode='goal' AND (? IS NULL OR principal=?) ORDER BY rowid",
			)
			.all(principal ?? null, principal ?? null)
			.map(({ payload, state }) => ({
				report: JSON.parse(payload) as GoalReportV1,
				state,
			}));

	const canActivateLegacy = (
		db: Database,
		access: GoalAccess,
		goal: StoredGoal,
	) => {
		const key = {
			principal: access.principal,
			goalId: goal.goalId,
			goalRevision: goal.revision,
		};
		const prior = read(db, access, key);
		if (prior && (prior.mode !== "mock" || prior.phase !== "ready"))
			return false;
		return (
			!db
				.query(`SELECT 1 FROM goal_work WHERE principal=? AND goal_id=? AND mode='mock'
			AND state IN ('reserved','accepted','confirmation_pending')`)
				.get(key.principal, key.goalId) &&
			!db
				.query(`SELECT 1 FROM goal_reports WHERE principal=? AND mode='mock' AND state='pending'
			AND json_extract(payload, '$.work.request.goalId')=?`)
				.get(key.principal, key.goalId)
		);
	};
	return {
		initialize,
		canActivateLegacyInTransaction: canActivateLegacy,
		progressInTransaction: read,
		activeProgressInTransaction: active,
		recoverGoalDeliveryInTransaction(
			db: Database,
			access: GoalAccess,
			key: GoalProgressKey,
			sourceRef: string,
			conversationId: string,
		) {
			const row = active(db, access, key);
			if (
				!row ||
				row.deliveryConversationId !== null ||
				row.state.sourceRef !== sourceRef
			)
				return false;
			return (
				db
					.query(
						`UPDATE goal_progress SET delivery_conversation_id=? WHERE ${keyWhere} AND delivery_conversation_id IS NULL`,
					)
					.run(conversationId, ...keyArgs(key)).changes === 1
			);
		},
		goalPermitInTransaction: permit,
		goalPermitsInTransaction(
			db: Database,
			access: GoalAccess,
			key: GoalProgressKey,
		) {
			const row = active(db, access, key);
			return row
				? readGoalPermits(db, row).filter(({ revoked }) => !revoked)
				: [];
		},
		goalAttemptsInTransaction: attempts,
		parkedGoalAttemptsInTransaction(
			db: Database,
			access: GoalAccess,
			key: GoalProgressKey,
		) {
			return read(db, access, key) ? parkedAttempts(db, key) : [];
		},
		parkReleasedGoalAttemptInTransaction(
			db: Database,
			access: GoalAccess,
			key: GoalProgressKey,
		) {
			const row = active(db, access, key);
			if (
				row?.phase !== "needs_user" ||
				!row.currentWorkId ||
				!isParked(db, key, row.currentWorkId)
			)
				return null;
			return advance(db, row, {
				phase: readyOrNeedsUser(row.state.criteria, row.state.questions),
				currentWorkId: null,
				state: { ...row.state, next: null },
			});
		},
		goalAttemptInTransaction(
			db: Database,
			access: GoalAccess,
			key: GoalProgressKey,
			id: string,
		) {
			return read(db, access, key) ? attemptAt(db, key, id) : null;
		},
		progressRowsInTransaction(db: Database, onlyPending = false) {
			return db
				.query<ProgressRow, []>(`SELECT ${progressColumns} FROM goal_progress
				WHERE mode='goal' ${onlyPending ? "AND needs_enqueue=1" : ""}
				ORDER BY rowid`)
				.all()
				.map(decodeProgress);
		},
		claimGoalProgressInTransaction(
			db: Database,
			key: GoalProgressKey,
			progressVersion: number,
			jobId: string,
		) {
			const row = db
				.query<ProgressRow, [string, string, number, number, string]>(
					`SELECT ${progressColumns} FROM goal_progress WHERE ${keyWhere}
				AND mode='goal' AND progress_version=? AND job_id=?`,
				)
				.get(...keyArgs(key), progressVersion, jobId);
			return row ? decodeProgress(row) : null;
		},
		deferGoalCleanupInTransaction(
			db: Database,
			access: GoalAccess,
			key: GoalProgressKey,
			expectedVersion: number,
			dueAtMs: number,
		) {
			const row = read(db, access, key);
			return row?.mode === "goal" &&
				terminal(row.phase) &&
				(row.currentWorkId || parkedAttempts(db, row).length) &&
				row.progressVersion === expectedVersion
				? advance(db, row, { phase: row.phase, state: row.state, dueAtMs })
				: null;
		},
		transitionProgressInTransaction(
			db: Database,
			access: GoalAccess,
			key: GoalProgressKey,
			expectedVersion: number,
			change: (progress: GoalProgress) => Advance | null,
		) {
			const progress = active(db, access, key);
			if (!progress || progress.progressVersion !== expectedVersion)
				return null;
			const next = change(progress);
			return next ? advance(db, progress, next) : null;
		},
		retireProgressInTransaction(
			db: Database,
			access: GoalAccess,
			key: GoalProgressKey,
			phase: "superseded" | "withdrawn" | "completed",
		) {
			const progress = read(db, access, key);
			if (progress?.mode === "goal" && !terminal(progress.phase))
				retireGoalPermits(db, progress);
			return progress && !terminal(progress.phase)
				? advance(db, progress, {
						phase,
						state: { ...progress.state, next: null, watch: null },
					})
				: null;
		},
		bindGoalJobInTransaction(
			db: Database,
			key: GoalProgressKey,
			expectedVersion: number,
			id: string,
		) {
			return (
				db
					.query(`UPDATE goal_progress SET job_id=?, needs_enqueue=0
				WHERE ${keyWhere} AND mode='goal' AND progress_version=? AND needs_enqueue=1`)
					.run(id, ...keyArgs(key), expectedVersion).changes === 1
			);
		},
		clearGoalJobInTransaction(db: Database, key: GoalProgressKey, id: string) {
			return (
				db
					.query(
						`UPDATE goal_progress SET job_id=NULL WHERE ${keyWhere} AND mode='goal' AND job_id=?`,
					)
					.run(...keyArgs(key), id).changes === 1
			);
		},
		activateLegacyProgressInTransaction(
			db: Database,
			access: GoalAccess,
			goal: StoredGoal,
			startedAt: number,
			sourceRef: string | null = null,
		) {
			const key = {
				principal: access.principal,
				goalId: goal.goalId,
				goalRevision: goal.revision,
			};
			const current = owners.goal(db, access, goal.goalId);
			if (current?.revision !== goal.revision || current.status !== "adopted")
				return null;
			if (!canActivateLegacy(db, access, goal)) return null;
			initialize(db, key.principal, current, {
				mode: "goal",
				sourceRef,
				startedAt,
				deliveryConversationId: null,
			});
			db.query(`UPDATE goal_progress SET mode='goal', needs_enqueue=1,
				state_json=json_set(state_json, '$.startedAt', ?, '$.sourceRef', ?)
				WHERE ${keyWhere} AND mode='mock' AND phase='ready'`).run(
				startedAt,
				sourceRef,
				...keyArgs(key),
			);
			return active(db, access, key);
		},
		authorizeWorkInTransaction(
			db: Database,
			access: GoalAccess,
			key: GoalProgressKey,
			grant: GoalPermitGrant,
		) {
			const progress = active(db, access, key);
			if (!progress) throw new Error("goal_state_conflict");
			const prior = permitForOperation(db, key.principal, grant.operationKey);
			if (
				grant.scope.basis.kind === "policy" &&
				grant.scope.writablePaths.length
			)
				throw new Error("goal_policy_write_forbidden");
			if (prior) {
				if (
					prior.goalId !== key.goalId ||
					prior.goalRevision !== key.goalRevision ||
					prior.ledgerScope !== progress.ledgerScope ||
					permitSpec(prior) !== permitSpec(grant)
				)
					throw new Error("operation_conflict");
				return { status: "replayed", permit: prior, progress } as const;
			}
			for (const existing of readGoalPermits(db, progress)) {
				if (
					!existing.revoked &&
					existing.scope.basis.kind === grant.scope.basis.kind &&
					(grant.scope.basis.kind === "message" ||
						existing.scope.workspaceRef === grant.scope.workspaceRef)
				)
					revokeGoalPermit(
						db,
						existing,
						grant.scope.basis.kind === "message"
							? "superseded"
							: "configuration",
					);
			}
			const saved = insertGoalPermit(db, progress, grant);
			const advanced = advance(db, progress, {
				phase: progress.currentWorkId ? "observing" : "ready",
				state: { ...progress.state, watch: null, next: null, problem: null },
			});
			if (!advanced) throw new Error("goal_progress_conflict");
			return { status: "applied", permit: saved, progress: advanced } as const;
		},
		authorizeReadPolicyInTransaction(
			db: Database,
			access: GoalAccess,
			key: GoalProgressKey,
			policy: GoalReadPolicyGrant,
		) {
			const progress = active(db, access, key);
			if (!progress) return { status: "stale" as const };
			const result = applyReadPolicy(db, progress, policy);
			if (result.status !== "applied") return { ...result, progress };
			const advanced = advance(db, progress, {
				phase: progress.currentWorkId
					? progress.phase
					: readyOrNeedsUser(progress.state.criteria, progress.state.questions),
				state: progress.state,
			});
			if (!advanced) throw new Error("goal_progress_conflict");
			return { ...result, progress: advanced };
		},
		reconcileReadPoliciesInTransaction(
			db: Database,
			access: GoalAccess,
			key: GoalProgressKey,
			configuration: {
				readonly digest: string;
				readonly summary: string;
				readonly policies: readonly GoalReadPolicyGrant[];
			},
		) {
			const progress = active(db, access, key);
			if (!progress) return { status: "stale" as const };
			if (progress.state.configuration?.digest === configuration.digest)
				return { status: "replayed" as const, progress };
			if (
				new Set(configuration.policies.map(({ policyKey }) => policyKey))
					.size !== configuration.policies.length
			)
				throw new Error("goal_policy_key_conflict");
			for (const existing of readGoalPermits(db, progress)) {
				if (
					!existing.revoked &&
					existing.scope.basis.kind === "policy" &&
					!configuration.policies.some((policy) =>
						matchesPolicy(existing, policy),
					)
				)
					revokeGoalPermit(db, existing, "configuration");
			}
			for (const policy of configuration.policies)
				applyReadPolicy(db, progress, policy);
			const phase =
				progress.currentWorkId || progress.phase === "verifying"
					? progress.phase
					: readyOrNeedsUser(progress.state.criteria, progress.state.questions);
			const advanced = advance(db, progress, {
				phase,
				dueAtMs: phase === "ready" ? null : progress.dueAtMs,
				state: {
					...progress.state,
					...(phase === "ready" && { watch: null, next: null, problem: null }),
					configuration: {
						digest: configuration.digest,
						ref: contentDigest([
							key.principal,
							key.goalId,
							key.goalRevision,
							progress.progressVersion,
							configuration.digest,
						]),
						summary: configuration.summary,
					},
				},
			});
			if (!advanced) throw new Error("goal_progress_conflict");
			return { status: "applied" as const, progress: advanced };
		},
		revokeWorkInTransaction(
			db: Database,
			access: GoalAccess,
			key: GoalProgressKey,
			permitId: string,
			revision: number,
		) {
			const progress = active(db, access, key);
			const saved = permit(db, access, key, permitId);
			if (!progress || !saved) return { status: "stale" } as const;
			if (saved.revoked && saved.revision === revision + 1)
				return { status: "replayed", progress } as const;
			if (saved.revision !== revision || saved.revoked)
				return { status: "stale" } as const;
			revokeGoalPermit(db, saved, "user");
			const advanced = advance(db, progress, {
				phase: progress.currentWorkId ? "observing" : "ready",
				state: {
					...progress.state,
					watch: null,
					next: null,
					problem: "permit_revoked",
					questions: progress.state.questions.filter(
						(question) => question.owner || question.answeredBy,
					),
				},
			});
			if (!advanced) throw new Error("goal_progress_conflict");
			return { status: "applied", progress: advanced } as const;
		},
		applyDecisionInTransaction(
			db: Database,
			access: GoalAccess,
			key: GoalProgressKey,
			value: GoalStep,
			admission: GoalDecisionAdmission,
		): Change {
			const progress = active(db, access, key);
			if (!progress) return { status: "stale" };
			const step = goalStepSchema.parse(value);
			const digest = contentDigest(step);
			const prior = progress.state.lastDecision;
			if (prior?.contextId === step.contextId)
				return prior.digest === digest
					? { status: "replayed", resultRef: prior.resultRef }
					: { status: "conflict" };
			if (
				progress.phase !== "ready" ||
				progress.progressVersion !== step.progressVersion ||
				admission.contextId !== step.contextId ||
				!admission.current(db, progress)
			)
				return { status: "stale" };
			const blocked = goalOwnerQuestionCriteria(
				progress.state.questions,
				progress.state.criteria,
			);
			if (
				step.kind !== "wait" &&
				step.criterionIds.some((id) => blocked.has(id))
			)
				return { status: "forbidden" };
			if (
				step.criterionIds.some(
					(id) =>
						!progress.state.criteria.some((criterion) => criterion.id === id),
				)
			)
				return { status: "stale" };

			let phase: GoalPhase;
			let resultRef: string;
			let attempt: GoalAttempt | null = null;
			let watch: GoalWatch | null = null;
			let questions = progress.state.questions;
			const requested = new Set(step.resolvedQuestionRefs ?? []);
			const observation = progress.state.configuration;
			const eligible =
				observation && admission.configurationRef === observation.ref
					? questions.filter((question) =>
							canResolveGoalQuestion(progress.state, question),
						)
					: [];
			if (
				requested.size !== (step.resolvedQuestionRefs?.length ?? 0) ||
				[...requested].some((id) => !eligible.some(({ ref }) => ref === id))
			)
				return { status: "forbidden" };
			if (observation && eligible.length) {
				questions = questions.map((question) =>
					!eligible.includes(question)
						? question
						: {
								...question,
								evaluatedConfiguration: observation.ref,
								...(requested.has(question.ref) && {
									resolution: {
										observationRef: observation.ref,
										contextId: step.contextId,
										progressVersion: progress.progressVersion,
										reason: step.reason,
									},
								}),
							},
				);
			}
			switch (step.kind) {
				case "act": {
					const allowed =
						admission.act && permit(db, access, key, admission.act.permitId);
					if (
						!admission.act ||
						!allowed ||
						allowed.revoked ||
						allowed.revision !== admission.act.permitRevision ||
						(allowed.scope.expiresAtMs !== null &&
							allowed.scope.expiresAtMs <= admission.nowMs)
					)
						return { status: "forbidden" };
					if (openWork(db, key.principal)) return { status: "busy" };
					resultRef = randomUUID();
					attempt = {
						version: 1,
						...key,
						...admission.act,
						id: resultRef,
						dispatchId: randomUUID(),
						step,
						ownerWorkId: null,
						ownerRevision: null,
						outcome: "reserved",
						observed: null,
						evidenceRefs: [],
						resultRef: null,
					};
					phase = "dispatch";
					break;
				}
				case "wait":
					if (
						admission.watch?.ref !== step.watchRef ||
						(admission.watch.dueAtMs === null && !admission.watch.producer)
					)
						return { status: "forbidden" };
					watch = admission.watch;
					resultRef = watch.ref;
					phase = "waiting";
					break;
				case "ask": {
					const id = goalQuestionRef(key, step);
					const matching = questions.filter(
						(question) =>
							!question.owner && goalQuestionRef(key, question) === id,
					);
					if (
						matching.some(
							(question) => question.answeredBy || question.resolution,
						)
					)
						return { status: "forbidden" };
					const prior = matching.at(0);
					resultRef = prior?.ref ?? id;
					if (!prior)
						questions = [
							...questions,
							{
								ref: resultRef,
								criterionIds: step.criterionIds,
								missing: step.missing,
								question: step.question,
								...(observation && {
									configurationAtCreation: observation.ref,
								}),
								...(admission.questionSources && {
									inputSources: admission.questionSources,
								}),
							},
						];
					if (
						admission.retryWhileAsking?.dueAtMs &&
						admission.retryWhileAsking.dueAtMs > admission.nowMs
					) {
						watch = admission.retryWhileAsking;
						phase = "waiting";
					} else
						phase =
							!prior && admission.canProceedWhileAsking
								? "ready"
								: "needs_user";
					break;
				}
				case "verify":
					resultRef = step.contextId;
					phase = "verifying";
					break;
			}
			const state: GoalProgressState = {
				...progress.state,
				next: step,
				watch,
				questions,
				problem: null,
				review: step.review ?? progress.state.review,
				reviewedAttemptCount:
					step.review === null
						? progress.state.reviewedAttemptCount
						: attempts(db, access, key).filter(
								({ outcome }) =>
									outcome !== "reserved" && outcome !== "running",
							).length,
				lastDecision: { contextId: step.contextId, digest, resultRef },
			};
			const updated = advance(db, progress, {
				phase,
				state,
				currentWorkId: attempt?.id ?? null,
				dueAtMs: watch?.dueAtMs ?? null,
			});
			if (!updated) return { status: "stale" };
			if (attempt)
				db.query(`INSERT INTO goal_work
				(id, principal, goal_id, goal_revision, payload, state, mode, dispatch_id)
				VALUES (?, ?, ?, ?, ?, 'reserved', 'goal', ?)`).run(
					attempt.id,
					...keyArgs(key),
					JSON.stringify(attempt),
					attempt.dispatchId,
				);
			return { status: "applied", progress: updated, resultRef };
		},
		observeInTransaction(
			db: Database,
			access: GoalAccess,
			key: GoalProgressKey,
			observation: GoalObservation,
			options: {
				readonly current: (
					db: Database,
					progress: GoalProgress,
					attempt: GoalAttempt | null,
				) => boolean;
				readonly expectedVersion?: number;
				readonly dueAtMs?: number | null;
			},
		): Change {
			const progress = active(db, access, key);
			if (!progress) return { status: "stale" };
			const identity = [
				...keyArgs(key),
				observation.producer,
				observation.ref,
				observation.version,
			] as const;
			const seen = db
				.query<{ digest: string }, [...typeof identity]>(
					`SELECT digest FROM goal_observations WHERE ${keyWhere} AND producer=? AND ref=? AND version=?`,
				)
				.get(...identity);
			if (seen)
				return seen.digest === observation.digest
					? { status: "replayed", resultRef: observation.ref }
					: { status: "conflict" };
			if (
				options.expectedVersion !== undefined &&
				options.expectedVersion !== progress.progressVersion
			)
				return { status: "stale" };

			let observedAttempt: GoalAttempt | null = null;
			let phase = progress.phase;
			let work = progress.currentWorkId;
			let retainSchedule = false;
			let parked = false;
			let questions = progress.state.questions;
			const update = observation.attempt;
			if (update) {
				const attempt = attemptAt(db, key, update.id);
				const detached = attempt?.id !== work && isParked(db, key, update.id);
				if (
					!attempt ||
					(attempt.id !== work && !detached) ||
					attempt.dispatchId !== update.dispatchId ||
					attempt.dispatchId !== observation.ref ||
					attempt.owner !== observation.producer ||
					(attempt.ownerWorkId !== null &&
						attempt.ownerWorkId !== update.ownerWorkId) ||
					(attempt.ownerRevision !== null &&
						update.ownerRevision <= attempt.ownerRevision) ||
					String(update.ownerRevision) !== observation.version
				)
					return { status: "stale" };
				if (!options.current(db, progress, attempt))
					return { status: "forbidden" };
				const question =
					update.outcome === "running" ? update.question : undefined;
				const previous =
					question && questions.find(({ ref }) => ref === question.ref);
				questions = questions.filter(
					(item) =>
						item.owner?.attemptId !== attempt.id ||
						item.answeredBy ||
						item.ref === question?.ref,
				);
				if (question) {
					if (previous?.owner && previous.owner.attemptId !== attempt.id)
						return { status: "conflict" };
					const saved: GoalQuestion = {
						...previous,
						ref: question.ref,
						question: question.prompt,
						missing: question.prompt,
						criterionIds: attempt.step.criterionIds,
						owner: {
							attemptId: attempt.id,
							ownerWorkId: update.ownerWorkId,
							expiresAtMs: question.expiresAtMs,
							released: detached || question.released,
						},
					};
					questions = previous
						? questions.map((item) => (item === previous ? saved : item))
						: [...questions, saved];
				}
				parked =
					update.outcome === "running" && (detached || !!question?.released);
				if (detached) {
					retainSchedule = true;
					if (!work && phase !== "verifying" && (!parked || !question)) {
						phase = readyOrNeedsUser(progress.state.criteria, questions);
						retainSchedule = false;
					}
				} else if (
					update.outcome !== "running" ||
					(parked && !previous?.answeredBy)
				) {
					work = null;
					phase = readyOrNeedsUser(progress.state.criteria, questions);
				} else {
					phase = "observing";
				}
				observedAttempt = {
					...attempt,
					ownerWorkId: update.ownerWorkId,
					ownerRevision: update.ownerRevision,
					outcome: update.outcome,
					observed: update.observed,
					resultRef: update.resultRef,
					evidenceRefs: observation.evidence?.map(({ ref }) => ref) ?? [],
				};
			} else {
				if (phase === "waiting") {
					const watch = progress.state.watch;
					if (
						watch?.producer !== observation.producer ||
						(watch.subjectRef !== undefined &&
							watch.subjectRef !== observation.ref)
					)
						return { status: "stale" };
					phase = "ready";
				}
				if (!options.current(db, progress, null))
					return { status: "forbidden" };
			}
			const state = withEvidence(progress.state, observation.evidence ?? []);
			const next = advance(db, progress, {
				phase,
				currentWorkId: work,
				dueAtMs: retainSchedule
					? progress.dueAtMs
					: work
						? (options.dueAtMs ?? null)
						: null,
				state: {
					...state,
					questions,
					watch: retainSchedule ? state.watch : null,
					next: phase === "ready" && !retainSchedule ? null : state.next,
					problem:
						update?.outcome === "failed" ||
						update?.outcome === "partial" ||
						update?.outcome === "rejected"
							? update.observed
							: state.problem,
				},
			});
			if (!next) return { status: "stale" };
			if (observedAttempt) updateAttempt(db, observedAttempt, parked);
			db.query(`INSERT INTO goal_observations
				(principal, goal_id, goal_revision, producer, ref, version, digest) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
				...identity,
				observation.digest,
			);
			return { status: "applied", progress: next, resultRef: observation.ref };
		},
		releaseGoalAttemptInTransaction(
			db: Database,
			access: GoalAccess,
			key: GoalProgressKey,
			id: string,
			observed: string,
		) {
			const progress = read(db, access, key);
			const attempt = attemptAt(db, key, id);
			if (!progress || !attempt) return null;
			const detached = progress.currentWorkId !== id;
			if (detached && !isParked(db, key, id)) return null;
			updateAttempt(db, { ...attempt, outcome: "cancelled", observed });
			const questions = progress.state.questions.filter(
				(item) => item.owner?.attemptId !== id || item.answeredBy,
			);
			const preserve =
				terminal(progress.phase) ||
				(detached && progress.currentWorkId !== null);
			const advanced = advance(db, progress, {
				phase: preserve
					? progress.phase
					: readyOrNeedsUser(progress.state.criteria, questions),
				currentWorkId: detached ? progress.currentWorkId : null,
				...(preserve &&
					!terminal(progress.phase) && { dueAtMs: progress.dueAtMs }),
				state: {
					...progress.state,
					next: preserve ? progress.state.next : null,
					watch: preserve ? progress.state.watch : null,
					problem: observed,
					questions,
				},
			});
			if (!advanced) throw new Error("goal_progress_conflict");
			return advanced;
		},
		answerGoalQuestionInTransaction(
			db: Database,
			access: GoalAccess,
			key: GoalProgressKey,
			ref: string,
			sourceRef: string,
			nowMs = Date.now(),
		) {
			const progress = active(db, access, key);
			const question = progress?.state.questions.find(
				(item) => item.ref === ref,
			);
			if (
				!progress ||
				!question ||
				question.resolution ||
				(question.owner &&
					!question.answeredBy &&
					(question.owner.expiresAtMs <= nowMs ||
						(progress.currentWorkId !== question.owner.attemptId &&
							!isParked(db, key, question.owner.attemptId))))
			)
				return { status: "stale" } as const;
			if (question.answeredBy)
				return {
					status: question.answeredBy === sourceRef ? "replayed" : "conflict",
					progress,
				} as const;
			const preserve =
				progress.phase === "verifying" ||
				(progress.currentWorkId !== null &&
					progress.currentWorkId !== question.owner?.attemptId);
			const advanced = advance(db, progress, {
				phase: preserve
					? progress.phase
					: question.owner && progress.currentWorkId
						? "observing"
						: question.owner || progress.phase === "needs_user"
							? "ready"
							: progress.phase,
				dueAtMs: preserve || !question.owner ? progress.dueAtMs : null,
				state: {
					...progress.state,
					questions: progress.state.questions.map((item) =>
						item.ref === ref ? { ...item, answeredBy: sourceRef } : item,
					),
				},
			});
			return advanced
				? ({ status: "applied", progress: advanced } as const)
				: ({ status: "stale" } as const);
		},
		goalWorkSlotOpenInTransaction: (db: Database, principal: string) =>
			!openWork(db, principal),
		admitGoalAnswerInTransaction(
			db: Database,
			access: GoalAccess,
			key: GoalProgressKey,
			attemptId: string,
			questionRef: string,
		) {
			const progress = active(db, access, key);
			const question = progress?.state.questions.find(
				({ ref }) => ref === questionRef,
			);
			if (
				!progress ||
				question?.owner?.attemptId !== attemptId ||
				!question.answeredBy ||
				question.delivered
			)
				return "stale";
			if (
				progress.currentWorkId !== null &&
				progress.currentWorkId !== attemptId
			)
				return "busy";
			if (question.owner.released && openWork(db, key.principal)) return "busy";
			if (question.owner.released) {
				const resumed = db
					.query(
						`UPDATE goal_work SET state='accepted' WHERE ${keyWhere} AND mode='goal' AND id=? AND state='waiting_user'`,
					)
					.run(...keyArgs(key), attemptId);
				if (resumed.changes !== 1) return "stale";
			}
			if (progress.currentWorkId === null) {
				const attempt = attemptAt(db, key, attemptId);
				if (!attempt || !question.owner.released)
					throw new Error("goal_resume_conflict");
				const resumed = advance(db, progress, {
					phase: "observing",
					currentWorkId: attemptId,
					state: {
						...progress.state,
						next: attempt.step,
						watch: null,
						lastDecision: {
							contextId: attempt.step.contextId,
							digest: contentDigest(attempt.step),
							resultRef: attempt.id,
						},
					},
				});
				if (!resumed) throw new Error("goal_resume_conflict");
			}
			return "ready";
		},
		recordGoalAnswerInTransaction(
			db: Database,
			access: GoalAccess,
			key: GoalProgressKey,
			questionRef: string,
		) {
			const progress = active(db, access, key);
			if (!progress) return null;
			const questions = progress.state.questions.map((item): GoalQuestion =>
				item.ref === questionRef ? { ...item, delivered: true } : item,
			);
			return advance(db, progress, {
				phase: "observing",
				state: { ...progress.state, questions },
			});
		},
		recordGoalChecksInTransaction(
			db: Database,
			access: GoalAccess,
			key: GoalProgressKey,
			input: {
				readonly expectedVersion: number;
				readonly checks: readonly {
					criterionId: string;
					checkRef: string;
					passed: boolean;
					evidence: GoalEvidence;
				}[];
				readonly current: (db: Database, progress: GoalProgress) => boolean;
			},
		) {
			const progress = active(db, access, key);
			const step = progress?.state.next;
			if (
				!progress ||
				progress.phase !== "verifying" ||
				step?.kind !== "verify" ||
				progress.progressVersion !== input.expectedVersion ||
				!input.current(db, progress)
			)
				return null;
			if (
				!input.checks.length ||
				input.checks.some(
					(check) =>
						!step.checks.some(
							(selected) =>
								selected.criterionId === check.criterionId &&
								selected.checkRef === check.checkRef,
						),
				)
			)
				return null;
			const state = withEvidence(
				progress.state,
				input.checks.map(({ evidence }) => evidence),
			);
			const criteria = state.criteria.map((criterion) => {
				if (!step.criterionIds.includes(criterion.id)) return criterion;
				const results = input.checks.filter(
					(check) => check.criterionId === criterion.id,
				);
				const selected = step.checks.filter(
					(check) => check.criterionId === criterion.id,
				);
				const passed =
					selected.every((wanted) =>
						results.some(
							(check) => wanted.checkRef === check.checkRef && check.passed,
						),
					) && results.every((check) => check.passed);
				return {
					...criterion,
					status: passed ? ("passed" as const) : ("open" as const),
					evidenceRefs: passed
						? [...new Set(results.map(({ evidence }) => evidence.ref))]
						: [],
				};
			});
			const allPassed = criteria.every(({ status }) => status === "passed");
			return advance(db, progress, {
				phase: allPassed
					? "verifying"
					: readyOrNeedsUser(criteria, state.questions),
				state: {
					...state,
					criteria,
					next: null,
					problem: allPassed ? null : "verification_incomplete",
				},
			});
		},
		completeInTransaction(
			db: Database,
			access: GoalAccess,
			key: GoalProgressKey,
			input: {
				readonly expectedVersion: number;
				readonly text: string;
				readonly current: (db: Database, progress: GoalProgress) => boolean;
			},
		): Change {
			const progress = read(db, access, key);
			if (!progress || progress.mode !== "goal") return { status: "stale" };
			const id = `${key.goalId}:${key.goalRevision + 1}`;
			const evidence = progress.state.evidence.filter(({ ref }) =>
				progress.state.criteria.some((criterion) =>
					criterion.evidenceRefs.includes(ref),
				),
			);
			const evidenceDigest = contentDigest([progress.state.criteria, evidence]);
			if (progress.phase === "completed") {
				const saved = db
					.query<{ payload: string }, [string, string]>(
						"SELECT payload FROM goal_reports WHERE principal=? AND id=? AND mode='goal' AND state<>'invalidated'",
					)
					.get(key.principal, id);
				return saved &&
					(JSON.parse(saved.payload) as GoalReportV1).evidenceDigest ===
						evidenceDigest
					? { status: "replayed", resultRef: id }
					: { status: "conflict" };
			}
			if (
				!active(db, access, key) ||
				progress.progressVersion !== input.expectedVersion ||
				progress.phase !== "verifying" ||
				progress.currentWorkId !== null ||
				!input.current(db, progress)
			)
				return { status: "stale" };
			if (
				!progress.state.criteria.length ||
				progress.state.criteria.some(
					(criterion) =>
						criterion.status !== "passed" ||
						!criterion.evidenceRefs.length ||
						criterion.evidenceRefs.some(
							(ref) => !evidence.some((item) => item.ref === ref),
						),
				)
			)
				return { status: "forbidden" };
			const finished = advance(db, progress, {
				phase: "completed",
				state: { ...progress.state, next: null },
			});
			if (!finished) return { status: "stale" };
			retireGoalPermits(db, progress);
			const goal = owners.complete(db, access, key, {
				namespace: "agency",
				kind: "goal_report",
				id,
			});
			if (goal.revision !== key.goalRevision + 1)
				throw new Error("goal_completion_revision_invalid");
			const report: GoalReportV1 = {
				version: 1,
				...key,
				id,
				completedRevision: goal.revision,
				ledgerScope: progress.ledgerScope,
				deliveryConversationId: progress.deliveryConversationId,
				text: input.text,
				criteria: progress.state.criteria,
				evidence,
				evidenceDigest,
			};
			db.query(
				"INSERT INTO goal_reports (id, principal, payload, state, mode) VALUES (?, ?, ?, ?, 'goal')",
			).run(
				id,
				key.principal,
				JSON.stringify(report),
				progress.deliveryConversationId ? "pending" : "ledger_only",
			);
			return { status: "applied", progress: finished, resultRef: id };
		},
		goalReportsInTransaction(db: Database, access: GoalAccess) {
			return reportRows(db, access.principal).filter(
				({ report, state }) =>
					state !== "invalidated" &&
					allowed(access, report, report.ledgerScope),
			);
		},
		forgetGoalInputsInTransaction(
			db: Database,
			access: GoalAccess,
			change: {
				readonly goalIds: readonly string[];
				readonly sourceCurrent: (ref: string) => boolean;
			},
		) {
			const excluded = new Set(change.goalIds);
			const rows = db
				.query<ProgressRow, [string]>(
					`SELECT ${progressColumns} FROM goal_progress WHERE principal=? AND mode='goal'`,
				)
				.all(access.principal)
				.map(decodeProgress);
			const result: {
				row: GoalProgress;
				documentId: string | null;
				attempts: readonly GoalAttempt[];
				reportIds: readonly string[];
				questionRefs: readonly string[];
			}[] = [];
			for (const row of rows) {
				if (!allowed(access, row, row.ledgerScope)) continue;
				const sourceGone =
					excluded.has(row.goalId) ||
					(row.state.sourceRef !== null &&
						!change.sourceCurrent(row.state.sourceRef));
				if (
					sourceGone &&
					row.phase === "withdrawn" &&
					!row.state.sourceRef &&
					!row.state.criteria.length
				)
					continue;
				const stale = row.state.evidence.filter(({ sources }) =>
					sources?.some((ref) => !change.sourceCurrent(ref)),
				);
				const invalid = new Set(stale.map(({ ref }) => ref));
				const rawPermits = readGoalPermits(db, row);
				const revoke = rawPermits.filter(
					(saved) =>
						sourceGone ||
						(saved.scope.basis.kind === "message" &&
							saved.scope.basis.sourceRefs.some(
								(ref) => !change.sourceCurrent(ref),
							)),
				);
				const questionSourceGone = row.state.questions.some(
					({ inputSources, answeredBy }) =>
						inputSources?.some((ref) => !change.sourceCurrent(ref)) ||
						(answeredBy !== undefined && !change.sourceCurrent(answeredBy)),
				);
				if (
					!sourceGone &&
					!invalid.size &&
					!revoke.length &&
					!questionSourceGone
				)
					continue;
				for (const saved of revoke)
					db.query(
						"UPDATE goal_permits SET revoked=1, permit_revision=permit_revision+1, revocation_reason='forgotten', scope_json=? WHERE id=?",
					).run(
						JSON.stringify({
							...saved.scope,
							basis: { kind: "message", sourceRefs: [] },
						}),
						saved.id,
					);
				const affected = attempts(db, access, row).filter(
					(attempt) =>
						sourceGone ||
						revoke.some(({ id }) => id === attempt.permitId) ||
						[...attempt.evidenceRefs, ...attempt.step.evidenceRefs].some(
							(ref) => invalid.has(ref),
						),
				);
				for (const attempt of affected) {
					const occupied =
						row.currentWorkId === attempt.id &&
						db
							.query(
								"SELECT 1 FROM goal_work WHERE id=? AND state IN ('reserved','accepted','confirmation_pending')",
							)
							.get(attempt.id);
					updateAttempt(db, {
						...attempt,
						step: {
							...attempt.step,
							request: "",
							expectedObservation: "",
							reason: "",
							review: null,
							evidenceRefs: [],
						},
						evidenceRefs: [],
						observed: null,
						resultRef: null,
						outcome: "cancelled",
					});
					if (occupied)
						db.query(
							"UPDATE goal_work SET state='confirmation_pending' WHERE id=?",
						).run(attempt.id);
				}
				const state: GoalProgressState = {
					...row.state,
					sourceRef: sourceGone ? null : row.state.sourceRef,
					design: null,
					next: null,
					lastDecision: null,
					watch: null,
					review: null,
					problem: null,
					evidence: sourceGone
						? []
						: row.state.evidence.filter(({ ref }) => !invalid.has(ref)),
					criteria: sourceGone
						? []
						: row.state.criteria.map((criterion) =>
								criterion.evidenceRefs.some((ref) => invalid.has(ref))
									? { ...criterion, status: "open", evidenceRefs: [] }
									: criterion,
							),
					questions: [],
				};
				const next = advance(db, row, {
					phase: sourceGone
						? "withdrawn"
						: terminal(row.phase)
							? row.phase
							: row.currentWorkId
								? "observing"
								: "ready",
					state,
					...(sourceGone ? { currentWorkId: null } : {}),
				});
				const reports = db
					.query<{ id: string }, [string, string, number]>(
						`DELETE FROM goal_reports WHERE principal=? AND mode='goal' AND
					json_extract(payload,'$.goalId')=? AND json_extract(payload,'$.goalRevision')=?
					RETURNING id`,
					)
					.all(...keyArgs(row));
				if (next)
					result.push({
						row: next,
						documentId: row.state.design?.id ?? null,
						attempts: affected,
						reportIds: reports.map(({ id }) => id),
						questionRefs: row.state.questions.map(({ ref }) => ref),
					});
			}
			return result;
		},
		releaseForgottenGoalWorkInTransaction(
			db: Database,
			key: GoalProgressKey,
			attemptId: string,
			dispatchId: string,
			permitId: string,
			permitRevision: number,
		) {
			const attempt = attemptAt(db, key, attemptId);
			if (
				!attempt ||
				attempt.dispatchId !== dispatchId ||
				attempt.permitId !== permitId ||
				attempt.permitRevision !== permitRevision ||
				attempt.step.request !== ""
			)
				return;
			db.query(
				`UPDATE goal_work SET state='cancelled' WHERE ${keyWhere} AND mode='goal' AND id=? AND state='confirmation_pending'`,
			).run(...keyArgs(key), attemptId);
		},
		pendingGoalReportsInTransaction(db: Database) {
			return reportRows(db)
				.filter(({ state }) => state === "pending")
				.map(({ report }) => report);
		},
		setGoalReportInTransaction(
			db: Database,
			access: GoalAccess,
			id: string,
			state: "delivered" | "invalidated",
		) {
			const row = reportRows(db, access.principal).find(
				({ report }) => report.id === id,
			);
			if (!row || !allowed(access, row.report, row.report.ledgerScope))
				return false;
			return (
				db
					.query(
						"UPDATE goal_reports SET state=? WHERE principal=? AND id=? AND mode='goal' AND state='pending'",
					)
					.run(state, access.principal, id).changes === 1
			);
		},
		goalScopeControlInTransaction(
			db: Database,
			access: GoalAccess,
			scope: string,
		) {
			if (!owners.ledgerAccess(access).scopeKeys.includes(scope)) return null;
			return (
				db
					.query<
						{
							generation: number;
							speechUntilMs: number | null;
							allUntilMs: number | null;
						},
						[string, string]
					>(
						`SELECT generation, speech_until_ms AS speechUntilMs, all_until_ms AS allUntilMs
				FROM goal_scope_controls WHERE principal=? AND scope_key=?`,
					)
					.get(access.principal, scope) ?? {
					generation: 0,
					speechUntilMs: null,
					allUntilMs: null,
				}
			);
		},
		setGoalScopeControlInTransaction(
			db: Database,
			access: GoalAccess,
			scope: string,
			value: {
				readonly speechUntilMs: number | null;
				readonly allUntilMs: number | null;
			},
		) {
			if (!owners.ledgerAccess(access).scopeKeys.includes(scope))
				throw new Error("goal_scope_forbidden");
			db.query(`INSERT INTO goal_scope_controls (principal, scope_key, generation, speech_until_ms, all_until_ms)
				VALUES (?, ?, 1, ?, ?) ON CONFLICT(principal, scope_key) DO UPDATE SET
				generation=goal_scope_controls.generation+1, speech_until_ms=excluded.speech_until_ms, all_until_ms=excluded.all_until_ms
				WHERE goal_scope_controls.speech_until_ms IS NOT excluded.speech_until_ms OR goal_scope_controls.all_until_ms IS NOT excluded.all_until_ms`).run(
				access.principal,
				scope,
				value.speechUntilMs,
				value.allUntilMs,
			);
		},
		adoptGoalCriteriaInTransaction(
			db: Database,
			access: GoalAccess,
			key: GoalProgressKey,
			input: {
				readonly expectedVersion: number;
				readonly design: GoalDesignRef;
				readonly source: string;
				readonly criteria: readonly GoalDesignCriterion[];
			},
		) {
			const progress = active(db, access, key);
			if (!progress) return { status: "stale" } as const;
			if (progress.state.design !== null)
				return progress.state.design.id === input.design.id &&
					progress.state.design.digest === input.design.digest
					? ({ status: "replayed", criteria: progress.state.criteria } as const)
					: ({ status: "conflict" } as const);
			if (
				progress.progressVersion !== input.expectedVersion ||
				progress.phase !== "ready"
			)
				return { status: "stale" } as const;
			const criteria =
				progress.state.criteria.length > 1
					? progress.state.criteria
					: [
							...progress.state.criteria,
							...input.criteria.map((item, index) => {
								if (
									!item.text.trim() ||
									!item.sourceQuote.trim() ||
									!input.source.includes(item.sourceQuote)
								)
									throw new Error("goal_criterion_source_invalid");
								return {
									...item,
									id: `root.${index + 1}`,
									status: "open" as const,
									evidenceRefs: [],
								};
							}),
						];
			const updated = advance(db, progress, {
				phase: "ready",
				state: {
					...progress.state,
					design: input.design,
					criteria,
				},
			});
			return updated
				? ({ status: "applied", progress: updated, criteria } as const)
				: ({ status: "stale" } as const);
		},
	};
}
