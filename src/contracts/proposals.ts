/**
 * LLM-facing output schemas. Structured outputs drop length/range constraints from the
 * JSON schema, so limits here are enforced on receipt by Zod and again by the settle checks.
 * Optional fields are `nullable` (always present) to keep the schema strict.
 */
import { z } from "zod";
import { emotionEmojis } from "./emotion.ts";

const ref = z.string().min(1).max(64);
const refs = z.array(ref).max(12);
const text = (max: number) => z.string().min(1).max(max);

// B1: free-text notes only.
export const noteAdd = z.strictObject({
	op: z.literal("note.add"),
	localId: ref,
	text: text(400),
	evidenceRefs: refs,
});
export const noteUpdate = z.strictObject({
	op: z.literal("note.update"),
	id: ref,
	expectedRevision: z.int().min(1),
	text: text(400),
	evidenceRefs: refs,
});
export const noteDelete = z.strictObject({
	op: z.literal("note.delete"),
	id: ref,
	expectedRevision: z.int().min(1),
});

// B2 and F: intents and candidates.
export const intentAdd = z.strictObject({
	op: z.literal("intent.add"),
	localId: ref,
	/** "held": created already set aside (e.g. the user said to put it aside). */
	initialState: z.enum(["proposed", "adopted", "held"]),
	desiredState: text(400),
	motive: text(300),
	completionCondition: text(300),
	resumeCondition: text(300),
	withdrawCondition: text(300),
	reviewAfterHours: z.int().min(1).max(168),
	evidenceRefs: refs,
	/** F only: desire id or localId. Must be null in B2. */
	desireRef: ref.nullable(),
});
export const intentUpdate = z.strictObject({
	op: z.literal("intent.update"),
	id: ref,
	expectedRevision: z.int().min(1),
	transition: z.enum(["adopted", "held", "completed", "abandoned"]).nullable(),
	reason: text(300),
	evidenceRefs: refs,
	desiredState: text(400).nullable(),
	completionCondition: text(300).nullable(),
	resumeCondition: text(300).nullable(),
	reviewAfterHours: z.int().min(1).max(168).nullable(),
});
export const candidateAdd = z.strictObject({
	op: z.literal("candidate.add"),
	localId: ref,
	/** Existing intent id or a localId from this proposal. */
	intentRef: ref,
	kind: z.enum(["question", "propose", "share", "tool"]),
	content: text(400),
	toolName: ref.nullable(),
	toolInput: text(400).nullable(),
	applyWhen: text(300),
	expireAfterHours: z.int().min(1).max(168),
	evidenceRefs: refs,
	supersedes: ref.nullable(),
});
export const candidateClose = z.strictObject({
	op: z.literal("candidate.close"),
	id: ref,
	expectedRevision: z.int().min(1),
	reason: z.enum(["superseded", "dismissed", "expired", "fulfilled"]),
	evidenceRefs: refs,
});

// F only: beliefs and desires.
export const beliefAdd = z.strictObject({
	op: z.literal("belief.add"),
	localId: ref,
	content: text(400),
	confidence: z.enum(["low", "medium", "high"]),
	evidenceRefs: refs,
});
export const beliefUpdate = z.strictObject({
	op: z.literal("belief.update"),
	id: ref,
	expectedRevision: z.int().min(1),
	status: z.enum(["active", "disputed", "superseded", "retracted"]),
	content: text(400).nullable(),
	confidence: z.enum(["low", "medium", "high"]).nullable(),
	evidenceRefs: refs,
});
export const desireAdd = z.strictObject({
	op: z.literal("desire.add"),
	localId: ref,
	kind: z.enum(["understand", "finish", "share"]),
	object: text(400),
	reason: text(300),
	evidenceRefs: refs,
	beliefRefs: refs,
});
export const desireUpdate = z.strictObject({
	op: z.literal("desire.update"),
	id: ref,
	expectedRevision: z.int().min(1),
	status: z.enum(["open", "held", "satisfied", "withdrawn"]),
	reason: text(300),
	evidenceRefs: refs,
});

/** A normal response already conveyed this candidate (reconciled inside the update call). */
export const reconciliation = z.strictObject({
	candidateId: ref,
	observationRef: ref,
});

/** hostTodos mode: a normal response already conveyed this finished work item. */
export const reportedTodo = z.strictObject({
	todoId: ref,
	observationRef: ref,
});
export type ReportedTodo = z.infer<typeof reportedTodo>;

const proposalBase = {
	/** Short structured rationale; stored, not logged by default. */
	summary: text(600),
	/** What is missing to decide, when the update is deferred. */
	missingInfo: text(300).nullable(),
	focusRefs: z.array(ref).max(7),
};

export const b1UpdateSchema = z.strictObject({
	...proposalBase,
	ops: z
		.array(z.discriminatedUnion("op", [noteAdd, noteUpdate, noteDelete]))
		.max(8),
});
export const b2UpdateSchema = z.strictObject({
	...proposalBase,
	ops: z
		.array(
			z.discriminatedUnion("op", [
				intentAdd,
				intentUpdate,
				candidateAdd,
				candidateClose,
			]),
		)
		.max(8),
	reconciliations: z.array(reconciliation).max(4),
});
export const fUpdateSchema = z.strictObject({
	...proposalBase,
	ops: z
		.array(
			z.discriminatedUnion("op", [
				intentAdd,
				intentUpdate,
				candidateAdd,
				candidateClose,
				beliefAdd,
				beliefUpdate,
				desireAdd,
				desireUpdate,
			]),
		)
		.max(12),
	reconciliations: z.array(reconciliation).max(4),
});

export type B1Update = z.infer<typeof b1UpdateSchema>;
export type B2Update = z.infer<typeof b2UpdateSchema>;
export type FUpdate = z.infer<typeof fUpdateSchema>;
export type UpdateProposal = B1Update | B2Update | FUpdate;
export type UpdateOp = FUpdate["ops"][number] | B1Update["ops"][number];

export const participationActions = [
	"speak",
	"tool",
	"reflect",
	"wait",
	"discard",
] as const;
export type ParticipationAction = (typeof participationActions)[number];

/**
 * One choice per opportunity. B2/F: speak/tool/discard need candidateRef.
 * B1 has no candidates: speak carries the utterance, tool carries toolName/toolInput.
 */
export const participationSchema = z.strictObject({
	action: z.enum(participationActions),
	candidateRef: z
		.strictObject({ id: ref, revision: z.int().min(1) })
		.nullable(),
	/** Final wording to say (B1 required for speak; B2/F optional rewrite of the candidate). */
	utterance: text(400).nullable(),
	toolName: ref.nullable(),
	toolInput: text(400).nullable(),
	evidenceRefs: refs,
	valueNow: text(300),
	userBurden: text(300),
	lossIfWait: text(300),
	conflicts: text(300).nullable(),
	reason: text(300),
});
export type ParticipationProposal = z.infer<typeof participationSchema>;

/** Utterance-emotion mode: the same choice plus one emoji for the feeling of a speak (else null). */
export const participationEmotionSchema = participationSchema.extend({
	emotion: z.enum(emotionEmojis).nullable(),
});

// ---------------------------------------------------------------------------
// Wire shape. Structured-output grammars reject large unions, so the model fills
// ONE flat op object for every condition (enum/nullable only; no transforms).
// `fromWire` maps it onto the typed ops above and re-validates with the strict
// schemas; the settle step never sees the wire shape.
// ---------------------------------------------------------------------------

export const wireOpNames = {
	B1: ["note.add", "note.update", "note.delete"],
	B2: ["intent.add", "intent.update", "candidate.add", "candidate.close"],
	F: [
		"intent.add",
		"intent.update",
		"candidate.add",
		"candidate.close",
		"belief.add",
		"belief.update",
		"desire.add",
		"desire.update",
	],
} as const;
export type WireOpName =
	| (typeof wireOpNames)["F"][number]
	| (typeof wireOpNames)["B1"][number];

/** `state` carries: initialState, intent transition, belief/desire status, or candidate close reason. */
const wireStates = [
	"proposed",
	"adopted",
	"held",
	"completed",
	"abandoned",
	"active",
	"disputed",
	"superseded",
	"retracted",
	"open",
	"satisfied",
	"withdrawn",
	"dismissed",
	"expired",
	"fulfilled",
] as const;
const wireKinds = [
	"question",
	"propose",
	"share",
	"tool",
	"understand",
	"finish",
] as const;

const wireOpShape = <N extends string>(names: readonly [N, ...N[]]) =>
	z.strictObject({
		op: z.enum(names),
		/** Existing item id (update/close/delete). */
		id: ref.nullable(),
		/** Name for a new item, used only inside this proposal. */
		localId: ref.nullable(),
		expectedRevision: z.int().min(1).nullable(),
		state: z.enum(wireStates).nullable(),
		/** desiredState / candidate content / note text / belief content / desire object. */
		text: z.string().max(400).nullable(),
		/** intent motive, change reason, desire reason. */
		reason: z.string().max(300).nullable(),
		completionCondition: z.string().max(300).nullable(),
		resumeCondition: z.string().max(300).nullable(),
		withdrawCondition: z.string().max(300).nullable(),
		applyWhen: z.string().max(300).nullable(),
		/** reviewAfterHours (intent) or expireAfterHours (candidate). */
		hours: z.int().min(1).max(168).nullable(),
		intentRef: ref.nullable(),
		desireRef: ref.nullable(),
		supersedes: ref.nullable(),
		kind: z.enum(wireKinds).nullable(),
		confidence: z.enum(["low", "medium", "high"]).nullable(),
		toolName: ref.nullable(),
		toolInput: z.string().max(400).nullable(),
		evidenceRefs: refs,
		beliefRefs: refs,
	});

const wireUpdate = <N extends string>(
	names: readonly [N, ...N[]],
	maxOps: number,
	maxReconciliations: number,
) =>
	z.strictObject({
		...proposalBase,
		ops: z.array(wireOpShape(names)).max(maxOps),
		reconciliations: z.array(reconciliation).max(maxReconciliations),
	});

const wireSchemas = {
	B1: wireUpdate(wireOpNames.B1, 8, 0),
	B2: wireUpdate(wireOpNames.B2, 8, 4),
	F: wireUpdate(wireOpNames.F, 12, 4),
};

/** B1 in hostTodos mode: the same update plus the work items a normal reply conveyed. */
const wireB1Todos = wireSchemas.B1.extend({
	reportedTodos: z.array(reportedTodo).max(4),
});

export type WireOp = z.infer<ReturnType<typeof wireOpShape<WireOpName>>>;
export type WireUpdate = Omit<z.infer<(typeof wireSchemas)["F"]>, "ops"> & {
	ops: WireOp[];
	/** Present only in the hostTodos update schema. */
	reportedTodos?: ReportedTodo[];
};

/** `hostTodos`: B1 only, adds the reportedTodos array; every other schema is unchanged. */
export const wireUpdateSchema = (
	condition: "B1" | "B2" | "F",
	options: { readonly hostTodos?: boolean } = {},
): z.ZodType<WireUpdate> =>
	(condition === "B1" && options.hostTodos === true
		? wireB1Todos
		: wireSchemas[condition]) as z.ZodType<WireUpdate>;

/**
 * Placeholder for a missing intent.update reason; settle stores it as lastReason. Only for
 * updates without a terminal transition: completing or abandoning keeps requiring a reason.
 */
const NO_REASON = "(理由なし)";

/**
 * Normalizations here fill only omissions that carry no meaning of their own (an unreferenced
 * localId, a missing change reason, tool content already present in toolInput). A missing
 * candidate content otherwise, or any other null, still fails the strict re-validation.
 */
const typedOp = (
	w: WireOp,
	index: number,
	used: ReadonlySet<string>,
): Record<string, unknown> => {
	const base = { op: w.op };
	switch (w.op) {
		case "note.add":
			return {
				...base,
				localId: w.localId,
				text: w.text,
				evidenceRefs: w.evidenceRefs,
			};
		case "note.update":
			return {
				...base,
				id: w.id,
				expectedRevision: w.expectedRevision,
				text: w.text,
				evidenceRefs: w.evidenceRefs,
			};
		case "note.delete":
			return { ...base, id: w.id, expectedRevision: w.expectedRevision };
		case "intent.add":
			return {
				...base,
				localId: w.localId,
				initialState: w.state,
				desiredState: w.text,
				motive: w.reason,
				completionCondition: w.completionCondition,
				resumeCondition: w.resumeCondition,
				withdrawCondition: w.withdrawCondition,
				reviewAfterHours: w.hours,
				evidenceRefs: w.evidenceRefs,
				desireRef: w.desireRef,
			};
		case "intent.update":
			return {
				...base,
				id: w.id,
				expectedRevision: w.expectedRevision,
				transition: w.state,
				reason:
					w.state === "completed" || w.state === "abandoned"
						? w.reason
						: (w.reason ?? NO_REASON),
				evidenceRefs: w.evidenceRefs,
				desiredState: w.text,
				completionCondition: w.completionCondition,
				resumeCondition: w.resumeCondition,
				reviewAfterHours: w.hours,
			};
		case "candidate.add":
			return {
				...base,
				localId: w.localId ?? freshLocalId(index, used),
				intentRef: w.intentRef,
				kind: w.kind,
				content: w.text ?? toolContent(w),
				toolName: w.toolName,
				toolInput: w.toolInput,
				applyWhen: w.applyWhen,
				expireAfterHours: w.hours,
				evidenceRefs: w.evidenceRefs,
				supersedes: w.supersedes,
			};
		case "candidate.close":
			return {
				...base,
				id: w.id,
				expectedRevision: w.expectedRevision,
				reason: w.state,
				evidenceRefs: w.evidenceRefs,
			};
		case "belief.add":
			return {
				...base,
				localId: w.localId,
				content: w.text,
				confidence: w.confidence,
				evidenceRefs: w.evidenceRefs,
			};
		case "belief.update":
			return {
				...base,
				id: w.id,
				expectedRevision: w.expectedRevision,
				status: w.state,
				content: w.text,
				confidence: w.confidence,
				evidenceRefs: w.evidenceRefs,
			};
		case "desire.add":
			return {
				...base,
				localId: w.localId,
				kind: w.kind,
				object: w.text,
				reason: w.reason,
				evidenceRefs: w.evidenceRefs,
				beliefRefs: w.beliefRefs,
			};
		case "desire.update":
			return {
				...base,
				id: w.id,
				expectedRevision: w.expectedRevision,
				status: w.state,
				reason: w.reason,
				evidenceRefs: w.evidenceRefs,
			};
	}
};

/** A tool candidate whose content lives only in toolInput: "<toolName>: <toolInput>". */
const toolContent = (w: WireOp): string | null =>
	w.kind === "tool" && w.toolName !== null && w.toolInput
		? `${w.toolName}: ${w.toolInput}`.slice(0, 400)
		: null;

/** `auto<index>`, extended until it collides with no id or localId the model used in this proposal. */
const freshLocalId = (index: number, used: ReadonlySet<string>): string => {
	let id = `auto${index}`;
	while (used.has(id)) id += "_";
	return id;
};

const typedSchemas = {
	B1: b1UpdateSchema,
	B2: b2UpdateSchema,
	F: fUpdateSchema,
};

/** Maps the flat wire update to typed ops and re-validates them strictly. */
export const fromWire = (
	wire: WireUpdate,
	condition: "B1" | "B2" | "F",
): { ok: true; proposal: UpdateProposal } | { ok: false } => {
	const used = new Set<string>();
	for (const w of wire.ops) {
		for (const v of [w.id, w.localId, w.intentRef, w.supersedes, w.desireRef])
			if (v !== null) used.add(v);
		for (const v of [...w.evidenceRefs, ...w.beliefRefs]) used.add(v);
	}
	const candidate = {
		summary: wire.summary,
		missingInfo: wire.missingInfo,
		focusRefs: wire.focusRefs,
		ops: wire.ops.map((w, i) => typedOp(w, i, used)),
		...(condition === "B1" ? {} : { reconciliations: wire.reconciliations }),
	};
	const parsed = typedSchemas[condition].safeParse(candidate);
	return parsed.success ? { ok: true, proposal: parsed.data } : { ok: false };
};
