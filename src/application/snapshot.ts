/** Structural checkpoint validation, adapted from work/autonomous-interest S4. */
import { z } from "zod";
import {
	actors,
	conditions,
	observationKinds,
	workStatuses,
	type Condition,
} from "../contracts/model.ts";
import type { AgencyRestore } from "../contracts/runtime.ts";

// Items come from settle (or the host's revision table). Validate the envelope and ledger
// needed for faithful replay, without inventing a second implementation of settlement.
const observation = z.object({
	id: z.string().min(1),
	seq: z.int().positive(),
	kind: z.enum(observationKinds),
	actor: z.enum(actors),
	occurredAt: z.number(),
	text: z.string(),
	causationId: z.string().optional(),
	tts: z.boolean().optional(),
	refs: z.array(z.string()).optional(),
	interestId: z.string().optional(),
	code: z.string().optional(),
	workRef: z.string().optional(),
	workStatus: z.enum(workStatuses).optional(),
});
const scheduling = z.object({
	review: z.array(z.string()),
	pressure: z.array(z.enum(["intents", "candidates"])),
	wake: z.object({
		review: z.array(z.string()),
		recall: z.array(z.string()),
		events: z.array(z.string()),
		faultUntil: z.array(z.tuple([z.string(), z.number()])),
		perDay: z.array(z.tuple([z.string(), z.int().nonnegative()])),
	}),
	wakeCount: z.int().nonnegative(),
});
const envelope = z.object({
	state: z.object({
		revision: z.int().nonnegative(),
		nextId: z.int().positive(),
		intents: z.array(z.unknown()),
		candidates: z.array(z.unknown()),
		attempts: z.array(z.unknown()),
		beliefs: z.array(z.unknown()),
		desires: z.array(z.unknown()),
		notes: z.array(z.unknown()),
		focus: z.array(z.string()),
		lastOutboundAt: z.number().nullable(),
		interests: z.array(z.unknown()).optional(),
	}),
	condition: z.enum(conditions).optional(),
	observations: z.array(observation).optional(),
	cursor: z.int().nonnegative().optional(),
	scheduling: scheduling.optional(),
});

export const validateRestore = (
	value: AgencyRestore,
	condition: Condition,
): void => {
	const parsed = envelope.safeParse(value);
	if (!parsed.success)
		throw new TypeError(`invalid snapshot: ${parsed.error.message}`);
	const s = parsed.data;
	if (s.condition !== undefined && s.condition !== condition)
		throw new TypeError(
			`invalid snapshot: condition ${s.condition} does not match ${condition}`,
		);
	if ((s.observations === undefined) !== (s.cursor === undefined))
		throw new TypeError(
			"invalid snapshot: observations and cursor must be provided together",
		);
	if (s.scheduling !== undefined && s.observations === undefined)
		throw new TypeError(
			"invalid snapshot: scheduling requires an observation ledger",
		);
	if (s.observations === undefined) return;
	if (s.cursor! > s.observations.length)
		throw new TypeError("invalid snapshot: cursor outside observation list");
	const ids = new Set<string>();
	for (const [index, o] of s.observations.entries()) {
		if (o.seq !== index + 1)
			throw new TypeError(
				"invalid snapshot: observations must have consecutive seqs",
			);
		if (ids.has(o.id))
			throw new TypeError(`invalid snapshot: duplicate observation id ${o.id}`);
		ids.add(o.id);
	}
};
