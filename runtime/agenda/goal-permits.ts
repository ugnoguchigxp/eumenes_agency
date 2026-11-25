import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { contentDigest } from "./goal-design.ts";
import type {
	GoalPermit,
	GoalPermitGrant,
	GoalPermitScope,
	GoalProgress,
	GoalReadPolicyGrant,
} from "./goal-progress-contracts.ts";

export const goalPolicyMigration = {
	id: "agency-goals/0006-read-policies",
	after: ["agency-goals/0005-progress"],
	sql: `
ALTER TABLE goal_permits ADD COLUMN policy_key TEXT;
ALTER TABLE goal_permits ADD COLUMN policy_generation TEXT;
ALTER TABLE goal_permits ADD COLUMN revocation_reason TEXT;
UPDATE goal_permits SET revocation_reason='legacy_unknown'
  WHERE mode='goal' AND revoked=1 AND json_extract(scope_json, '$.basis.kind')='policy';
CREATE UNIQUE INDEX goal_permits_policy ON goal_permits(principal, goal_id, goal_revision, policy_key)
  WHERE mode='goal' AND revoked=0 AND policy_key IS NOT NULL;
`,
} as const;

type RevocationReason = NonNullable<GoalPermit["revocationReason"]>;
type PermitRow = Omit<
	GoalPermit,
	"scope" | "revoked" | "policyKey" | "policyGeneration" | "revocationReason"
> & {
	scopeJson: string;
	revoked: number;
	policyKey: string | null;
	policyGeneration: string | null;
	revocationReason: RevocationReason | null;
};
export const permitColumns = `id, principal, goal_id AS goalId, goal_revision AS goalRevision,
	scope_key AS ledgerScope, permit_revision AS revision, toolchain AS toolchainRevisionId,
	workspace, impact, scope_json AS scopeJson, revoked, policy_key AS policyKey,
	policy_generation AS policyGeneration, revocation_reason AS revocationReason`;
const permitKey = (row: GoalProgress) =>
	[row.principal, row.goalId, row.goalRevision, row.ledgerScope] as const;
const where =
	"principal=? AND goal_id=? AND goal_revision=? AND scope_key=? AND mode='goal'";

export function decodePermit({
	scopeJson,
	revoked,
	policyKey,
	policyGeneration,
	revocationReason,
	...row
}: PermitRow): GoalPermit {
	const scope = JSON.parse(scopeJson) as GoalPermitScope;
	if (scope.version !== 1) throw new Error("goal_permit_version_unknown");
	return {
		...row,
		scope,
		revoked: revoked === 1,
		...(policyKey && { policyKey }),
		...(policyGeneration && { policyGeneration }),
		...(revocationReason && { revocationReason }),
	};
}

export function readGoalPermits(db: Database, row: GoalProgress) {
	return db
		.query<PermitRow, [...ReturnType<typeof permitKey>]>(
			`SELECT ${permitColumns} FROM goal_permits WHERE ${where} ORDER BY rowid DESC`,
		)
		.all(...permitKey(row))
		.map(decodePermit);
}

export function permitForOperation(
	db: Database,
	principal: string,
	operationKey: string,
) {
	const stored = db
		.query<PermitRow, [string, string]>(
			`SELECT ${permitColumns} FROM goal_permits WHERE principal=? AND grant_operation_key=? AND mode='goal'`,
		)
		.get(principal, operationKey);
	return stored ? decodePermit(stored) : null;
}

export function normalizedPermitScope(scope: GoalPermitScope): GoalPermitScope {
	const sorted = (values: readonly string[]) => [...new Set(values)].sort();
	return {
		version: 1,
		basis:
			scope.basis.kind === "message"
				? { kind: "message", sourceRefs: sorted(scope.basis.sourceRefs) }
				: { kind: "policy", revision: scope.basis.revision },
		workspaceRef: scope.workspaceRef,
		baselineCommit: scope.baselineCommit,
		readablePaths: sorted(scope.readablePaths),
		writablePaths: sorted(scope.writablePaths),
		checks: scope.checks
			.map(({ ref, command, args, cwd, expectationDigest }) => ({
				ref,
				command,
				args,
				cwd,
				...(expectationDigest ? { expectationDigest } : {}),
			}))
			.sort((a, b) => a.ref.localeCompare(b.ref)),
		expiresAtMs: scope.expiresAtMs,
		...(scope.limits
			? { limits: Object.fromEntries(Object.entries(scope.limits).sort()) }
			: {}),
	};
}

export const permitSpec = (
	grant: Pick<
		GoalPermitGrant,
		"toolchainRevisionId" | "workspace" | "impact" | "scope"
	>,
) =>
	contentDigest([
		grant.toolchainRevisionId,
		grant.workspace,
		grant.impact,
		normalizedPermitScope(grant.scope),
	]);

export function insertGoalPermit(
	db: Database,
	row: GoalProgress,
	grant: GoalPermitGrant,
	policy?: GoalReadPolicyGrant,
) {
	const id = randomUUID();
	const scope = normalizedPermitScope(grant.scope);
	db.query(`INSERT INTO goal_permits (id, principal, scope_key, goal_id, goal_revision,
		toolchain, workspace, impact, mode, scope_json, grant_operation_key, policy_key, policy_generation)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'goal', ?, ?, ?, ?)`).run(
		id,
		row.principal,
		row.ledgerScope,
		row.goalId,
		row.goalRevision,
		grant.toolchainRevisionId,
		grant.workspace,
		grant.impact,
		JSON.stringify(scope),
		grant.operationKey,
		policy?.policyKey ?? null,
		policy?.policyGeneration ?? null,
	);
	return readGoalPermits(db, row).find((permit) => permit.id === id)!;
}

export function revokeGoalPermit(
	db: Database,
	permit: GoalPermit,
	reason: RevocationReason,
) {
	db.query(
		"UPDATE goal_permits SET revoked=1, permit_revision=permit_revision+1, revocation_reason=? WHERE id=? AND permit_revision=? AND revoked=0",
	).run(reason, permit.id, permit.revision);
}

export function retireGoalPermits(db: Database, row: GoalProgress) {
	db.query(
		`UPDATE goal_permits SET revoked=1, permit_revision=permit_revision+1, revocation_reason='goal_ended' WHERE ${where} AND revoked=0`,
	).run(...permitKey(row));
}

export function matchesPolicy(permit: GoalPermit, policy: GoalReadPolicyGrant) {
	return (
		permit.scope.basis.kind === "policy" &&
		(permit.policyKey
			? permit.policyKey === policy.policyKey
			: permit.scope.workspaceRef === policy.scope.workspaceRef)
	);
}

export function applyReadPolicy(
	db: Database,
	row: GoalProgress,
	policy: GoalReadPolicyGrant,
) {
	if (
		!policy.policyKey ||
		!policy.policyGeneration ||
		policy.scope.basis.kind !== "policy" ||
		policy.scope.writablePaths.length ||
		policy.impact !== "read"
	)
		throw new Error("goal_policy_read_required");
	const matches = readGoalPermits(db, row).filter((permit) =>
		matchesPolicy(permit, policy),
	);
	const current = matches.find((permit) => !permit.revoked);
	if (current?.policyGeneration === policy.policyGeneration) {
		if (permitSpec(current) !== permitSpec(policy))
			throw new Error("goal_policy_generation_conflict");
		return { status: "replayed", permit: current } as const;
	}
	const unchanged =
		current && !current.policyKey && permitSpec(current) === permitSpec(policy);
	if (unchanged) {
		db.query(
			"UPDATE goal_permits SET policy_key=?, policy_generation=? WHERE id=?",
		).run(policy.policyKey, policy.policyGeneration, current.id);
		return {
			status: "applied",
			permit: {
				...current,
				policyKey: policy.policyKey,
				policyGeneration: policy.policyGeneration,
			},
		} as const;
	}
	if (
		matches.some(
			(permit) =>
				permit.revoked &&
				(permit.revocationReason === "user" ||
					permit.revocationReason === "legacy_unknown"),
		)
	) {
		if (current) revokeGoalPermit(db, current, "configuration");
		return { status: "suppressed" } as const;
	}
	if (current) revokeGoalPermit(db, current, "configuration");
	const operationKey = contentDigest([
		"read-policy",
		row.principal,
		row.goalId,
		row.goalRevision,
		policy.policyKey,
		policy.policyGeneration,
		matches.length,
	]);
	return {
		status: "applied",
		permit: insertGoalPermit(db, row, { ...policy, operationKey }, policy),
	} as const;
}
