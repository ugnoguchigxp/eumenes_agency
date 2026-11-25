import type { GoalStep, GoalStepContext } from "../../src/agenda/index.ts";
import type { GoalDesignRef } from "./goal-design.ts";

export type GoalMode = "mock" | "goal";
export type GoalPhase =
	| "ready"
	| "dispatch"
	| "observing"
	| "waiting"
	| "needs_user"
	| "verifying"
	| "completed"
	| "withdrawn"
	| "superseded";

export interface GoalProgressKey {
	readonly principal: string;
	readonly goalId: string;
	readonly goalRevision: number;
}

export interface GoalEvidence {
	readonly ref: string;
	readonly version: string;
	readonly digest: string;
	readonly summary: string;
	readonly sources?: readonly string[];
}

export interface GoalCriterion {
	readonly id: string;
	readonly text: string;
	readonly sourceQuote: string | null;
	readonly status: "open" | "passed";
	readonly evidenceRefs: readonly string[];
}

export interface GoalWatch {
	readonly ref: string;
	readonly condition: string;
	readonly dueAtMs: number | null;
	readonly producer?: string;
	readonly subjectRef?: string;
}

export interface GoalQuestion {
	readonly ref: string;
	readonly criterionIds: readonly string[];
	readonly missing: string;
	readonly question: string;
	readonly inputSources?: readonly string[];
	readonly configurationAtCreation?: string;
	readonly evaluatedConfiguration?: string;
	readonly resolution?: {
		readonly observationRef: string;
		readonly contextId: string;
		readonly progressVersion: number;
		readonly reason: string;
	};
	readonly answeredBy?: string;
	readonly delivered?: boolean;
	readonly owner?: {
		readonly attemptId: string;
		readonly ownerWorkId: string;
		readonly expiresAtMs: number;
		readonly released: boolean;
	};
}

export function goalOwnerQuestionCriteria(
	questions: readonly GoalQuestion[],
	criteria: readonly GoalCriterion[],
) {
	const blocked = questions.flatMap((question) =>
		question.owner?.released && !question.delivered
			? question.criterionIds
			: [],
	);
	return new Set(
		criteria.flatMap(({ id }) =>
			blocked.some(
				(item) =>
					id === item || id.startsWith(item + ".") || item.startsWith(id + "."),
			)
				? [id]
				: [],
		),
	);
}

export interface GoalProgressState {
	readonly version: 1;
	readonly sourceRef: string | null;
	readonly startedAt: number;
	readonly criteria: readonly GoalCriterion[];
	readonly evidence: readonly GoalEvidence[];
	readonly design: GoalDesignRef | null;
	readonly watch: GoalWatch | null;
	readonly questions: readonly GoalQuestion[];
	readonly next: GoalStep | null;
	readonly review: string | null;
	readonly reviewedAttemptCount: number;
	readonly lastDecision: {
		readonly contextId: string;
		readonly digest: string;
		readonly resultRef: string;
	} | null;
	readonly problem: string | null;
	readonly configuration?: GoalConfigurationObservation;
}

export interface GoalConfigurationObservation {
	readonly digest: string;
	readonly ref: string;
	readonly summary: string;
}

export function canResolveGoalQuestion(
	state: GoalProgressState,
	question: GoalQuestion,
) {
	const configuration = state.configuration;
	return (
		!!configuration &&
		!question.owner &&
		!question.answeredBy &&
		!question.resolution &&
		question.configurationAtCreation !== configuration.ref &&
		question.evaluatedConfiguration !== configuration.ref
	);
}

export interface GoalProgress extends GoalProgressKey {
	readonly ledgerScope: string;
	readonly mode: GoalMode;
	readonly progressVersion: number;
	readonly phase: GoalPhase;
	readonly currentWorkId: string | null;
	readonly deliveryConversationId: string | null;
	readonly jobId: string | null;
	readonly dueAtMs: number | null;
	readonly needsEnqueue: boolean;
	readonly state: GoalProgressState;
}

export interface GoalCheckAuthorization {
	readonly ref: string;
	readonly command: string;
	readonly args: readonly string[];
	readonly cwd: string;
	readonly expectationDigest?: string;
}

export interface GoalPermitScope {
	readonly version: 1;
	readonly basis:
		| { readonly kind: "message"; readonly sourceRefs: readonly string[] }
		| { readonly kind: "policy"; readonly revision: string };
	readonly workspaceRef: string;
	readonly baselineCommit: string;
	readonly readablePaths: readonly string[];
	readonly writablePaths: readonly string[];
	readonly checks: readonly GoalCheckAuthorization[];
	readonly expiresAtMs: number | null;
	readonly limits?: Readonly<Record<string, number>>;
}

export interface GoalPermit extends GoalProgressKey {
	readonly id: string;
	readonly revision: number;
	readonly ledgerScope: string;
	readonly toolchainRevisionId: string;
	readonly workspace: string;
	readonly impact: string;
	readonly scope: GoalPermitScope;
	readonly revoked: boolean;
	readonly policyKey?: string;
	readonly policyGeneration?: string;
	readonly revocationReason?:
		| "user"
		| "configuration"
		| "superseded"
		| "goal_ended"
		| "forgotten"
		| "legacy_unknown";
}

export interface GoalPermitGrant {
	readonly operationKey: string;
	readonly toolchainRevisionId: string;
	readonly workspace: string;
	readonly impact: string;
	readonly scope: GoalPermitScope;
}

export interface GoalReadPolicyGrant extends Omit<
	GoalPermitGrant,
	"operationKey"
> {
	readonly policyKey: string;
	readonly policyGeneration: string;
}

export interface GoalAttempt extends GoalProgressKey {
	readonly version: 1;
	readonly id: string;
	readonly dispatchId: string;
	readonly step: Extract<GoalStep, { kind: "act" }>;
	readonly permitId: string;
	readonly permitRevision: number;
	readonly bindingRevisionId: string;
	readonly owner: string;
	readonly operationRef?: string;
	readonly ownerWorkId: string | null;
	readonly ownerRevision: number | null;
	readonly outcome: GoalStepContext["attempts"][number]["outcome"];
	readonly observed: string | null;
	readonly evidenceRefs: readonly string[];
	readonly resultRef: string | null;
}

export interface GoalObservation {
	readonly producer: string;
	readonly ref: string;
	readonly version: string;
	readonly digest: string;
	readonly evidence?: readonly GoalEvidence[];
	readonly attempt?: {
		readonly id: string;
		readonly dispatchId: string;
		readonly ownerWorkId: string;
		readonly ownerRevision: number;
		readonly outcome: Exclude<GoalAttempt["outcome"], "reserved">;
		readonly observed: string | null;
		readonly resultRef: string | null;
		readonly question?: {
			readonly ref: string;
			readonly prompt: string;
			readonly expiresAtMs: number;
			readonly released: boolean;
		};
	};
}

export interface GoalReportV1 extends GoalProgressKey {
	readonly version: 1;
	readonly id: string;
	readonly completedRevision: number;
	readonly ledgerScope: string;
	readonly deliveryConversationId: string | null;
	readonly text: string;
	readonly criteria: readonly GoalCriterion[];
	readonly evidence: readonly GoalEvidence[];
	readonly evidenceDigest: string;
}
