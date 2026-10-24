/** Case and run-record shapes for the P0-E experiment (eval only, not shipped). */
import { z } from "zod";
import {
	actors,
	conditions,
	observationKinds,
	type Condition,
} from "../src/contracts/model.ts";
import { emotionNames } from "../src/contracts/emotion.ts";
import { participationActions } from "../src/contracts/proposals.ts";

export const caseGroups = [
	"resume",
	"no_speak",
	"later",
	"resolved",
	"refusal",
	"contrast",
	"longterm",
	"injection",
	// P1-E (spec/p1e-experiment.md §4)
	"causal",
	"transfer",
	"premise",
	"amplify",
	"concurrent",
	"dilution",
	// Social lull experiment (spec/social-lull-experiment.md); run only with --group social.
	"social",
] as const;
export type CaseGroup = (typeof caseGroups)[number];

export const failureTypes = [
	"unnecessary",
	"missed",
	"wrong_content",
	"resolved_reproposal",
	"refusal_reproposal",
	"injection_followed",
	"self_evidence",
	"schema",
	"refusal",
	"max_tokens",
	"budget",
	"rejected",
	"error",
	/** Chose an action outside expect.accept while acting outward (counted with TP). */
	"wrong_action",
	/** Tried to run a tool that needs approval (host refused). */
	"unauthorized_attempt",
	/** API/connection/quarantine failure made the opportunity undecidable (excluded). */
	"infra",
] as const;
export type FailureType = (typeof failureTypes)[number];

export const suites = ["p0e", "p1e"] as const;
export type Suite = (typeof suites)[number];

/**
 * Conditions an eval run may use: the runtime ones plus
 * - B1a (ablation): B1 with `selectWhenEmpty`, i.e. select is called even with 0 notes
 *   (removes the host_no_candidates gate; scored, state-checked and judged like B1),
 * - B1h (social lull): B1a plus the host-topics mode (`hostTopics`), with the case's
 *   `interests` as standing interests and each opportunity's `topics` as host topics,
 * - D (diagnostic, no stored state).
 */
export const evalConditions = [...conditions, "B1a", "B1h", "D"] as const;
export type EvalCondition = (typeof evalConditions)[number];

/** The runtime condition an eval condition runs as (B1a/B1h run as B1); null for D (own runtime). */
export const runtimeConditionOf = (c: EvalCondition): Condition | null =>
	c === "D" ? null : c === "B1a" || c === "B1h" ? "B1" : c;

/**
 * A host-memory topic or a standing interest given by a social case. Shown only to B1h
 * (as `memory:<id>` / `interest:<id>`) and to the judge as case facts.
 */
export const socialItemSchema = z.strictObject({
	id: z.string().regex(/^[a-z][a-z0-9]{0,15}$/),
	text: z.string().min(1),
});

/** A host work item in a case (HostTodo with times in minutes from case start). */
export const caseTodoSchema = z.strictObject({
	id: z.string().regex(/^[a-z][a-z0-9]{0,15}$/),
	title: z.string().min(1),
	status: z.enum(["todo", "done"]),
	outcome: z.enum(["succeeded", "partial", "failed"]).optional(),
	result: z.string().min(1).optional(),
	nextActions: z.array(z.string().min(1)).optional(),
	requestedAt: z.number().min(0),
	doneAt: z.number().min(0).optional(),
	/** errand (the user's own task with a deadline): kind, deadline and reminder window start. */
	kind: z.enum(["work", "errand"]).optional(),
	dueAt: z.number().min(0).optional(),
	remindFrom: z.number().min(0).optional(),
	dueLabel: z.string().min(1).optional(),
});
export type CaseTodo = z.infer<typeof caseTodoSchema>;

export const expectSchema = z.strictObject({
	/** Whether an outward action (speak/tool) is needed at this opportunity. */
	needed: z.boolean(),
	/** Acceptable actions. */
	accept: z.array(z.enum(participationActions)).min(1),
	/** If acting outward, evidence must include at least one of these step ids (empty = no check). */
	evidenceAny: z.array(z.string()),
	/** Failure label when the agent acts outward although not needed. */
	failureIfOutward: z.enum([
		"unnecessary",
		"resolved_reproposal",
		"refusal_reproposal",
		"injection_followed",
	]),
	/** Why this is the expected choice (for the human labeler). */
	note: z.string().min(1),
});
export type Expect = z.infer<typeof expectSchema>;

const stepId = z.string().regex(/^s\d+$/);

/**
 * What the agent's open state should (not) be grounded on at an opportunity (P1-E §5.2).
 * Checked against evidence refs of open items (B1 notes, B2 intents/candidates).
 */
export const stateExpectSchema = z.strictObject({
	/** Each group: some open item cites at least one of these steps. */
	mustHold: z.array(z.array(stepId).min(1)),
	/** No open item cites any of these steps (resolved, refused, superseded). */
	mustNotHold: z.array(stepId),
});
export type StateExpect = z.infer<typeof stateExpectSchema>;

export const stepSchema = z.discriminatedUnion("type", [
	z.strictObject({
		type: z.literal("observation"),
		id: stepId,
		/** Minutes from case start. */
		t: z.number().min(0),
		kind: z.enum(observationKinds),
		actor: z.enum(actors),
		text: z.string().min(1),
	}),
	z.strictObject({
		type: z.literal("opportunity"),
		id: stepId,
		t: z.number().min(0),
		trigger: z.enum(["turn_end", "idle", "result_received"]),
		presence: z.enum(["quiet", "speaking", "unknown"]),
		foregroundBusy: z.boolean(),
		playerBusy: z.boolean(),
		/** null = ambiguous: recorded, excluded from scoring. */
		expect: expectSchema.nullable(),
		/** P1-E: expected state grounding at this opportunity (null = not checked). */
		stateExpect: stateExpectSchema.nullable().default(null),
		/** P1-E condition D: steps shown directly at selection (besides the last 4 observations). */
		present: z.array(stepId).default([]),
		/**
		 * P1-E: content criteria for an outward action, judged by the judge model.
		 * These are written for an utterance (action "speak"). A tool action is judged by
		 * `judgeTool` instead (a tool input is a request, not a narration of facts).
		 */
		judge: z.array(z.string().min(1)).default([]),
		/**
		 * P1-E: criteria for a tool action. Absent or empty: when `judge` is non-empty, the
		 * judge's built-in generic tool criterion (judge.ts `genericToolCriterion`) is used;
		 * when `judge` is empty nothing is judged. Optional without a default, so a case that
		 * does not use it keeps its caseHash.
		 */
		judgeTool: z.array(z.string().min(1)).optional(),
		/**
		 * Social cases: what the host's memory offers as topics at this opportunity (B1h only).
		 * Optional without a default, so other cases keep their caseHash.
		 */
		topics: z.array(socialItemSchema).optional(),
		/**
		 * Social cases: host work items (asked-for background work) at this opportunity, shown to
		 * B1h only (hostTodos). Times are minutes from case start. Optional, no default.
		 */
		todos: z.array(caseTodoSchema).optional(),
		/**
		 * Emotion cases: the feelings that fit a speak here (utteranceEmotion, B1h). Scored
		 * without the judge; optional, no default, so other cases keep their caseHash.
		 */
		feelOk: z.array(z.enum(emotionNames)).min(1).optional(),
	}),
]);
export type Step = z.infer<typeof stepSchema>;

export const toolScriptSchema = z.strictObject({
	name: z.string().regex(/^[a-z][a-z0-9_]{1,40}$/),
	description: z.string().min(1),
	/** Destructive or user-granted tools; an autonomous run is a safety observation. */
	requiresApproval: z.boolean().default(false),
	/** Consumed in order per call; when exhausted the call fails. */
	results: z.array(
		z.strictObject({
			status: z.enum(["succeeded", "failed", "outcome_unknown"]),
			text: z.string().min(1),
		}),
	),
});

export const caseSchema = z
	.strictObject({
		id: z.string().regex(/^[a-z_]+-\d{2}$/),
		suite: z.enum(suites).default("p0e"),
		group: z.enum(caseGroups),
		split: z.enum(["dev", "unseen"]),
		title: z.string().min(1),
		description: z.string().min(1),
		/** Draft labels need the user's confirmation before they count. */
		labelStatus: z.enum(["draft", "confirmed"]),
		tools: z.array(toolScriptSchema),
		/** Social cases: the persona's standing interests (B1h only). Optional, no default. */
		interests: z.array(socialItemSchema).optional(),
		steps: z.array(stepSchema).min(2),
	})
	.superRefine((c, ctx) => {
		const ids = new Set<string>();
		// mustHold/mustNotHold/present/evidenceAny name observations, never opportunities.
		const observationIds = new Set<string>();
		let last = -1;
		for (const s of c.steps) {
			if (ids.has(s.id))
				ctx.addIssue({ code: "custom", message: `dup ${s.id}` });
			ids.add(s.id);
			if (s.t < last)
				ctx.addIssue({ code: "custom", message: `time order ${s.id}` });
			last = s.t;
			if (s.type === "observation") observationIds.add(s.id);
			if (s.type === "opportunity") {
				const refs = [
					...(s.expect?.evidenceAny ?? []),
					...(s.stateExpect?.mustHold.flat() ?? []),
					...(s.stateExpect?.mustNotHold ?? []),
					...s.present,
				];
				for (const e of refs)
					if (!observationIds.has(e))
						ctx.addIssue({
							code: "custom",
							message: ids.has(e)
								? `${s.id} ref ${e} is an opportunity, not an observation step`
								: `${s.id} ref ${e} not an earlier observation step`,
						});
				if (c.suite === "p1e" && s.expect !== null && s.stateExpect === null)
					ctx.addIssue({
						code: "custom",
						message: `${s.id} p1e opportunity needs stateExpect`,
					});
				// D needs a non-empty `present` at every scored p1e opportunity: an empty one
				// at "not needed" opportunities would make D's input shape itself a hint.
				if (c.suite === "p1e" && s.expect !== null && s.present.length === 0)
					ctx.addIssue({
						code: "custom",
						message: `${s.id} p1e opportunity needs present (condition D), needed or not`,
					});
			}
		}
		if (!c.steps.some((s) => s.type === "opportunity"))
			ctx.addIssue({ code: "custom", message: "no opportunity" });
	});
export type Case = z.infer<typeof caseSchema>;

/** An open item of the agent's state at an opportunity (enough for a reader / the state judge). */
export const openItemSchema = z.strictObject({
	id: z.string(),
	kind: z.enum(["note", "intent", "candidate"]),
	text: z.string(),
	/** Intent/candidate state; null for notes. */
	state: z.string().nullable(),
	holdReason: z.string().nullable(),
	evidence: z.array(z.string()),
});
export type OpenItem = z.infer<typeof openItemSchema>;

/** Why an opportunity is outside the state-check denominators (P1-E §5.2). */
export const stateExcludedReasons = ["blocked", "empty", "infra"] as const;

export const opportunityRecordSchema = z.strictObject({
	opportunityId: z.string(),
	expect: expectSchema.nullable(),
	action: z.enum(participationActions),
	source: z.string(),
	utterance: z.string().nullable(),
	toolName: z.string().nullable(),
	/** Tool input text of a tool action (judge input). Absent in records made before 2026-10-22. */
	toolInput: z.string().nullable().optional(),
	evidenceRefs: z.array(z.string()),
	reason: z.string(),
	/** Feeling chosen with a speak (utteranceEmotion mode, condition B1h); absent otherwise. */
	emotion: z.enum(emotionNames).optional(),
	/** The case step's feelOk, copied at replay (absent when the step has none). */
	feelOk: z.array(z.enum(emotionNames)).optional(),
	rejectCodes: z.array(z.string()),
	/** Evidence refs authored by the agent itself (actor=agent). */
	agentAuthoredRefs: z.array(z.string()),
	/** P1-E state check at this opportunity (null when not checked or condition D). */
	stateCheck: z
		.strictObject({
			/** Per mustHold group: satisfied? */
			mustHold: z.array(z.boolean()),
			/** Informational only, not scored: mustNotHold steps still cited by an open item. */
			violations: z.array(z.string()),
		})
		.nullable()
		.default(null),
	/** Open items at the check, recorded when the opportunity has mustNotHold (for the state judge). */
	stateItems: z.array(openItemSchema).nullable().default(null),
	/** Set when the state check was skipped for this opportunity; stateCheck is then null. */
	stateExcluded: z.enum(stateExcludedReasons).nullable().default(null),
});
export type OpportunityRecord = z.infer<typeof opportunityRecordSchema>;

export const callRecordSchema = z.strictObject({
	purpose: z.string(),
	at: z.number(),
	code: z.string(),
	model: z.string().nullable(),
	inputTokens: z.number(),
	outputTokens: z.number(),
	latencyMs: z.number(),
	rejectCodes: z.array(z.string()),
});

export const runRecordSchema = z.strictObject({
	runName: z.string(),
	caseId: z.string(),
	suite: z.enum(suites).default("p0e"),
	group: z.enum(caseGroups),
	condition: z.enum(evalConditions),
	rep: z.int().min(1),
	labelStatus: z.enum(["draft", "confirmed"]),
	/** Content hash of the case file at run time (cases.ts caseHash). Absent in older records. */
	caseHash: z.string().optional(),
	/** Experiment settings digest (model route, effort, budgets), no secrets. */
	settingsDigest: z.string(),
	instructionVersion: z.string(),
	opportunities: z.array(opportunityRecordSchema),
	calls: z.array(callRecordSchema),
	usd: z.number(),
	finalState: z.strictObject({
		openIntents: z.int(),
		openCandidates: z.int(),
		notes: z.int(),
		beliefs: z.int(),
		desires: z.int(),
	}),
	/** Safety observations (must stay empty): unauthorized tool, receipt-less success, stale ticket. */
	safety: z.array(z.string()),
	error: z.string().nullable(),
	/** Run stopped early or every model call failed; not counted as done on --resume. */
	incomplete: z.boolean(),
});
export type RunRecord = z.infer<typeof runRecordSchema>;

/** One judge-model verdict on one criterion of one outward action (P1-E §5.3). */
export const judgmentSchema = z.strictObject({
	runName: z.string(),
	caseId: z.string(),
	condition: z.enum(evalConditions),
	rep: z.int().min(1),
	opportunityId: z.string(),
	criterion: z.string(),
	verdict: z.enum(["pass", "fail", "unclear"]),
	reason: z.string(),
	model: z.string(),
	/** Judge route + system prompt digest at judging time (resume refuses a different one). */
	judgeDigest: z.string().default(""),
});
export type Judgment = z.infer<typeof judgmentSchema>;

/**
 * Judge-model verdict on one mustNotHold matter (a step) of one opportunity: does the
 * agent's open state still treat it as a valid pending item? (P1-E §5.2)
 */
export const stateJudgmentSchema = z.strictObject({
	runName: z.string(),
	caseId: z.string(),
	condition: z.enum(evalConditions),
	rep: z.int().min(1),
	opportunityId: z.string(),
	/** The mustNotHold step whose observation is the matter. */
	step: stepId,
	verdict: z.enum(["still_active", "handled", "absent", "unclear"]),
	reason: z.string(),
	model: z.string(),
	judgeDigest: z.string().default(""),
});
export type StateJudgment = z.infer<typeof stateJudgmentSchema>;

/**
 * True for the automatic "no open items at all" verdict (model "none", no call made).
 * It says nothing about whether the agent let the matter go, so it is reported apart
 * from a judged `absent` (items exist, none about this matter).
 */
export const isEmptyStateJudgment = (j: StateJudgment): boolean =>
	j.verdict === "absent" && j.model === "none";
