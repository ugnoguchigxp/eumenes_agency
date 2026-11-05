/**
 * P0 trial records: one terminal record per planned case × rep × step, validated against the plan fixed in the
 * run manifest before the run. Aggregates are regenerated from the raw JSONL only; a missing raw record is
 * reported as `incomplete:record_missing` in the aggregate and the raw file is never patched.
 */
import { z } from "zod";
import { canonical, digest } from "./baseline.ts";

export const outcomes = [
	"passed",
	"behavior_mismatch",
	"decision_rejected",
	"model_error",
	"runner_error",
	"incomplete",
] as const;
export type Outcome = (typeof outcomes)[number];

const count = z.number().int().nonnegative();
const usage = z.strictObject({
	model: z.string().nullable(),
	inputTokens: count.nullable(),
	outputTokens: count.nullable(),
	cacheReadTokens: count.nullable(),
});
export const needs = [
	"required",
	"optional",
	"prohibited",
	"undetermined",
] as const;

export const trialRecordSchema = z.strictObject({
	schema: z.literal("agency-p0-trial.v2"),
	runId: z.string().min(1),
	trialId: z.string().min(1),
	caseId: z.string().min(1),
	rep: z.number().int().positive(),
	step: z.string().min(1),
	split: z.enum(["dev", "mechanism", "fault-injection"]),
	lane: z.literal("fixture"),
	variant: z.string().min(1),
	digests: z.strictObject({
		manifest: z.string(),
		input: z.string(),
		requests: z.array(z.string()),
		responses: z.array(z.string()),
		finalSnapshot: z.string().nullable(),
	}),
	/** What the model output said, from the served select response; null when select was not reached. */
	proposal: z.strictObject({
		action: z.enum(["speak", "tool", "wait", "discard"]).nullable(),
		candidateRef: z
			.strictObject({ id: z.string(), revision: z.number() })
			.nullable(),
		evidenceRefs: z.array(z.string()),
		reason: z.string().nullable(),
		valueNow: z.string().nullable(),
		lossIfWait: z.string().nullable(),
		nullReason: z.string().nullable(),
	}),
	core: z.strictObject({
		eligibleAction: z.enum(["speak", "tool"]).nullable(),
		decisionAction: z.string().nullable(),
		source: z.string().nullable(),
		rejectCodes: z.array(z.string()),
		blockCodes: z.array(z.string()),
		wakeReasons: z.array(z.string()),
		ticketId: z.string().nullable(),
		candidateId: z.string().nullable(),
	}),
	hostAdmission: z.strictObject({
		status: z.enum(["allowed", "rejected", "not_checked"]),
		gate: z.string().nullable(),
		at: z.number().nullable(),
		basis: z.enum(["fixture_only"]).nullable(),
		code: z.string().nullable(),
	}),
	/** observe is not implemented in P0: always not_applicable outside mock aggregation tests. */
	suppression: z.strictObject({
		status: z.enum(["not_applicable", "suppressed"]),
		reason: z.string().nullable(),
		source: z.enum(["none", "mock"]),
	}),
	effects: z.strictObject({
		ticketsIssued: count,
		reservations: count,
		fixtureDelegationsStarted: count,
		fixtureWorkRows: count,
		speech: count,
		notifications: count,
		productWrites: count,
		actionReceipts: count,
		observeEffects: count,
		outboundNetwork: count,
		controlReceiptsAccepted: count,
		controlReceiptsRejected: count,
	}),
	measurement: z.strictObject({
		calls: z.array(
			z.strictObject({
				purpose: z.string(),
				code: z.string(),
				rejectCodes: z.array(z.string()),
				reportedInputTokens: count,
				reportedOutputTokens: count,
			}),
		),
		logicalCalls: count,
		/** Physical attempts for which a fixture response (value or error) was served. */
		attempts: count,
		/** Attempts that reached the boundary but were refused before anything was served. */
		refusedAttempts: count,
		refusals: z.array(
			z.strictObject({
				seq: z.number().int(),
				purpose: z.string(),
				reason: z.enum([
					"attempt_cap",
					"request_digest_mismatch",
					"response_digest_mismatch",
					"extra_call",
					"identity_conflict",
					"script_exhausted",
				]),
			}),
		),
		providerCalls: count,
		attemptUsage: z.array(
			z.strictObject({
				attemptId: z.string(),
				purpose: z.string(),
				usage: usage.nullable(),
				/** What the fixture served: a value or an error response (refused attempts are not here). */
				served: z.enum(["value", "error"]),
			}),
		),
		/** The core's CallOutcome counts came from the product port's 0-fill when the raw usage was absent. */
		zeroFilledUsage: count,
		clock: z.array(z.number()),
		wallMs: z.number().nonnegative(),
		cost: z.strictObject({ amount: z.number().nullable(), basis: z.string() }),
		missing: z.array(z.string()),
	}),
	result: z.strictObject({
		outcome: z.enum(outcomes),
		basis: z.string(),
		recordComplete: z.boolean(),
		scorable: z.boolean(),
		expectedRejection: z.boolean().nullable(),
		mismatches: z.array(z.string()),
	}),
	label: z
		.strictObject({
			need: z.enum(needs),
			allowedActions: z.array(z.string()),
			origin: z.string(),
		})
		.nullable(),
});
export type TrialRecord = z.infer<typeof trialRecordSchema>;

export const trialId = (caseId: string, rep: number, step: string) =>
	`${caseId}/r${rep}/${step}`;

export function parseJsonl<T>(
	text: string,
	schema: z.ZodType<T>,
	source: string,
) {
	const out: T[] = [];
	const errors: string[] = [];
	text.split("\n").forEach((line, i) => {
		if (!line.trim()) return;
		try {
			const parsed = schema.safeParse(JSON.parse(line));
			if (parsed.success) out.push(parsed.data);
			else errors.push(`${source}:${i + 1}: schema`);
		} catch {
			errors.push(`${source}:${i + 1}: json`);
		}
	});
	return { records: out, errors };
}

/** Planned IDs come from the manifest written before the run; the records are checked against it only. */
export function validateRecords(
	planned: readonly string[],
	records: readonly Pick<TrialRecord, "trialId">[],
) {
	const plan = new Set(planned);
	const seen = new Map<string, number>();
	for (const r of records) seen.set(r.trialId, (seen.get(r.trialId) ?? 0) + 1);
	return {
		planned: planned.length,
		recorded: records.length,
		missing: planned.filter((id) => !seen.has(id)),
		duplicate: [...seen].filter(([, n]) => n > 1).map(([id]) => id),
		unknown: [...seen.keys()].filter((id) => !plan.has(id)),
		plannedDuplicates: planned.length - plan.size,
	};
}

const tally = <T extends string | null>(values: readonly T[]) => {
	const out: Record<string, number> = {};
	for (const v of values) out[String(v)] = (out[String(v)] ?? 0) + 1;
	return Object.fromEntries(Object.entries(out).sort());
};

/** Known counts are summed; any absent count makes the total unknown (null) and is listed, never 0. */
export function usageTotals(records: readonly TrialRecord[]) {
	const all = records.flatMap((r) => r.measurement.attemptUsage);
	const sum = (k: "inputTokens" | "outputTokens" | "cacheReadTokens") => {
		const known = all.filter((a) => a.usage?.[k] != null);
		return {
			known: known.reduce((n, a) => n + (a.usage![k] as number), 0),
			unknownAttempts: all.length - known.length,
			total:
				known.length === all.length
					? known.reduce((n, a) => n + (a.usage![k] as number), 0)
					: null,
		};
	};
	return {
		attempts: all.length,
		inputTokens: sum("inputTokens"),
		outputTokens: sum("outputTokens"),
		cacheReadTokens: sum("cacheReadTokens"),
		models: tally(all.map((a) => a.usage?.model ?? "unknown")),
	};
}

/**
 * Wait, host rejection and observe suppression are separate buckets. A reference rejection is a contract
 * rejection, never a fitting wait, and a suppression is neither.
 */
export function decisionBuckets(records: readonly TrialRecord[]) {
	let modelWait = 0;
	let coreRejected = 0;
	let hostAdmissionRejected = 0;
	let suppressed = 0;
	let hostGate = 0;
	let notReached = 0;
	let eligible = 0;
	for (const r of records) {
		if (r.suppression.status === "suppressed") suppressed++;
		if (r.hostAdmission.status === "rejected") hostAdmissionRejected++;
		if (r.core.source === "rejected") coreRejected++;
		else if (r.core.source?.startsWith("host_")) hostGate++;
		if (r.proposal.action === "wait" && r.core.source === "llm") modelWait++;
		if (r.proposal.action === null) notReached++;
		if (r.core.eligibleAction) eligible++;
	}
	return {
		modelWait,
		coreRejected,
		hostAdmissionRejected,
		suppressed,
		hostGate,
		selectNotReached: notReached,
		coreEligibleOutward: eligible,
	};
}

/**
 * Label-based counts for a semantic lane (defined in P0; not applied to scripted fixture responses).
 * FP counts the model's outward proposal in a prohibited case even when a gate stopped it; undetermined
 * (unscorable) trials widen the range instead of being dropped.
 */
export function semanticCounts(records: readonly TrialRecord[]) {
	const of = (need: string) => records.filter((r) => r.label?.need === need);
	const outward = (r: TrialRecord) =>
		r.proposal.action === "speak" || r.proposal.action === "tool";
	const prohibited = of("prohibited");
	const required = of("required");
	const fp = prohibited.filter((r) => r.result.scorable && outward(r)).length;
	const fpUnknown = prohibited.filter((r) => !r.result.scorable).length;
	const range = (f: number, u: number, n: number) =>
		n === 0 ? null : [f / n, (f + u) / n];
	const fnCauses = {
		modelWait: 0,
		contractRejected: 0,
		hostRejected: 0,
		unobserved: 0,
	};
	for (const r of required) {
		if (!r.result.scorable) fnCauses.unobserved++;
		else if (r.proposal.action === "wait") fnCauses.modelWait++;
		else if (r.core.source === "rejected") fnCauses.contractRejected++;
		else if (r.hostAdmission.status === "rejected") fnCauses.hostRejected++;
	}
	return {
		prohibited: {
			planned: prohibited.length,
			fp,
			undetermined: fpUnknown,
			fpRate: range(fp, fpUnknown, prohibited.length),
		},
		required: { planned: required.length, fnCauses },
		optionalWaitNotCountedAsMiss: of("optional").filter(
			(r) => r.proposal.action === "wait",
		).length,
		undeterminedLabel: of("undetermined").length,
	};
}

export const outwardEffects = (r: TrialRecord) =>
	r.effects.speech +
	r.effects.notifications +
	r.effects.productWrites +
	r.effects.actionReceipts +
	r.effects.observeEffects +
	r.effects.outboundNetwork;

/** The aggregate is a pure function of the manifest plan and the raw records (P0-A08 regeneration). */
export function aggregate(
	planned: readonly string[],
	records: readonly TrialRecord[],
) {
	const check = validateRecords(planned, records);
	const byId = new Map(records.map((r) => [r.trialId, r]));
	const rows = planned.map((id) => {
		const r = byId.get(id);
		return r
			? {
					trialId: id,
					outcome: r.result.outcome as string,
					basis: r.result.basis,
				}
			: { trialId: id, outcome: "incomplete", basis: "record_missing" };
	});
	const present = planned
		.map((id) => byId.get(id))
		.filter((r): r is TrialRecord => !!r);
	const sumEffect = (k: keyof TrialRecord["effects"]) =>
		present.reduce((n, r) => n + r.effects[k], 0);
	const effects = Object.fromEntries(
		(
			Object.keys(present[0]?.effects ?? {}) as (keyof TrialRecord["effects"])[]
		).map((k) => [k, sumEffect(k)]),
	);
	return {
		schema: "agency-p0-aggregate.v1",
		validation: check,
		denominator: planned.length,
		outcomes: tally(rows.map((r) => r.outcome)),
		incomplete: rows
			.filter((r) => r.outcome === "incomplete")
			.map((r) => `${r.trialId}:${r.basis}`),
		bySplit: Object.fromEntries(
			[...new Set(present.map((r) => r.split))]
				.sort()
				.map((s) => [
					s,
					tally(
						present.filter((r) => r.split === s).map((r) => r.result.outcome),
					),
				]),
		),
		expectedRejections: present.filter(
			(r) => r.result.expectedRejection === true,
		).length,
		unexpectedRejections: present.filter(
			(r) =>
				r.result.expectedRejection === false &&
				(r.core.source === "rejected" || r.hostAdmission.status === "rejected"),
		).length,
		proposalActions: tally(present.map((r) => r.proposal.action)),
		coreSources: tally(present.map((r) => r.core.source)),
		ticketActions: tally(
			present.filter((r) => r.core.ticketId).map((r) => r.core.eligibleAction),
		),
		hostAdmission: tally(present.map((r) => r.hostAdmission.status)),
		hostAdmissionCodes: tally(
			present
				.filter((r) => r.hostAdmission.code)
				.map((r) => r.hostAdmission.code),
		),
		coreRejectCodes: tally(present.flatMap((r) => r.core.rejectCodes)),
		buckets: decisionBuckets(present),
		effects,
		outwardEffects: present.reduce((n, r) => n + outwardEffects(r), 0),
		calls: {
			logical: present.reduce((n, r) => n + r.measurement.logicalCalls, 0),
			attempts: present.reduce((n, r) => n + r.measurement.attempts, 0),
			refusedBeforeServe: present.reduce(
				(n, r) => n + r.measurement.refusedAttempts,
				0,
			),
			refusalReasons: tally(
				present.flatMap((r) => r.measurement.refusals.map((x) => x.reason)),
			),
			providerCalls: present.reduce(
				(n, r) => n + r.measurement.providerCalls,
				0,
			),
			zeroFilledUsage: present.reduce(
				(n, r) => n + r.measurement.zeroFilledUsage,
				0,
			),
			byCode: tally(
				present.flatMap((r) =>
					r.measurement.calls.map((c) => `${c.purpose}:${c.code}`),
				),
			),
		},
		usage: usageTotals(present),
		mismatches: present.flatMap((r) =>
			r.result.mismatches.map((m) => `${r.trialId}:${m}`),
		),
	};
}
export type Aggregate = ReturnType<typeof aggregate>;

/** Fields excluded from behavioural comparison: run identity and wall time, never content. */
const NON_BEHAVIOURAL = new Set([
	"runId",
	"variant",
	"digests.manifest",
	"measurement.wallMs",
]);

const flatten = (
	value: unknown,
	prefix = "",
	out: Record<string, string> = {},
) => {
	if (value && typeof value === "object" && !Array.isArray(value)) {
		for (const [k, v] of Object.entries(value))
			flatten(v, prefix ? `${prefix}.${k}` : k, out);
	} else out[prefix] = canonical(value);
	return out;
};

/**
 * P0-A02 comparator: action, refs, gates, state digest, calls and attempts must be equal per trial. Only the
 * declared transport identities may differ, and only through the replayer's one-to-one map.
 */
export function compareRecords(
	a: readonly TrialRecord[],
	b: readonly TrialRecord[],
) {
	const diffs: { trialId: string; field: string }[] = [];
	const bb = new Map(b.map((r) => [r.trialId, r]));
	for (const ra of a) {
		const rb = bb.get(ra.trialId);
		if (!rb) {
			diffs.push({ trialId: ra.trialId, field: "<missing>" });
			continue;
		}
		// Attempt ids are transport identities: the replayer binds them one-to-one; the rest is compared as is.
		const strip = (r: TrialRecord) => ({
			...r,
			measurement: {
				...r.measurement,
				attemptUsage: r.measurement.attemptUsage.map(
					({ attemptId: _a, ...u }) => u,
				),
			},
		});
		const fa = flatten(strip(ra));
		const fb = flatten(strip(rb));
		for (const k of new Set([...Object.keys(fa), ...Object.keys(fb)]))
			if (!NON_BEHAVIOURAL.has(k) && fa[k] !== fb[k])
				diffs.push({ trialId: ra.trialId, field: k });
	}
	for (const rb of b)
		if (!a.some((r) => r.trialId === rb.trialId))
			diffs.push({ trialId: rb.trialId, field: "<unexpected>" });
	return diffs;
}

export interface PairDeclaration {
	/** Manifest paths (prefixes) the comparison changes on purpose. */
	readonly intervention: readonly string[];
	/** Paths that must be equal; any other difference is undeclared. */
	readonly fixed: readonly string[];
	/** Paths never compared (run id, time of the run). */
	readonly meta: readonly string[];
	/** Paths that must be present in both manifests. */
	readonly required: readonly string[];
}

const under = (path: string, prefixes: readonly string[]) =>
	prefixes.some((p) => path === p || path.startsWith(p + "."));

/** P0-A01: missing required identity, a fixed-item difference or an undeclared difference makes the pair not comparable (保留). */
export function checkPair(a: unknown, b: unknown, decl: PairDeclaration) {
	const fa = flatten(a);
	const fb = flatten(b);
	const missing = decl.required.filter(
		(p) =>
			![fa, fb].every((f) =>
				Object.entries(f).some(
					([k, v]) =>
						(k === p || k.startsWith(p + ".")) &&
						v !== "null" &&
						v !== '""' &&
						v !== "undefined",
				),
			),
	);
	const declared: string[] = [];
	const fixedMismatch: string[] = [];
	const undeclared: string[] = [];
	for (const k of [
		...new Set([...Object.keys(fa), ...Object.keys(fb)]),
	].sort()) {
		if (fa[k] === fb[k] || under(k, decl.meta)) continue;
		if (under(k, decl.intervention)) declared.push(k);
		else if (under(k, decl.fixed)) fixedMismatch.push(k);
		else undeclared.push(k);
	}
	const comparable =
		!missing.length && !fixedMismatch.length && !undeclared.length;
	return {
		comparable,
		verdict: comparable ? "comparable" : "hold",
		missing,
		declared,
		fixedMismatch,
		undeclared,
		digestA: digest(a),
		digestB: digest(b),
	};
}
