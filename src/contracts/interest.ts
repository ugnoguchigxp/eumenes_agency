/**
 * Interest state and condition-I update ops (Agency Next P2-a). Used only by the new
 * condition I; B1/B2/F schemas and prompts are unchanged. No numeric scores: depth,
 * stagnation and surprise live in `reason`, written by the model.
 */
import { z } from "zod";
import { fUpdateSchema } from "./proposals.ts";

export const interestOrigins = ["user_relation", "own", "host_seed"] as const;
export type InterestOrigin = (typeof interestOrigins)[number];
export const interestStatuses = [
	"emerging",
	"active",
	"dormant",
	"faded",
] as const;
export type InterestStatus = (typeof interestStatuses)[number];
export const beliefModes = [
	"observed",
	"inferred",
	"hypothesis",
	"imagined",
	"preference",
] as const;
export type BeliefMode = (typeof beliefModes)[number];

export interface Interest {
	readonly id: string;
	revision: number;
	topic: string;
	readonly origin: InterestOrigin;
	status: InterestStatus;
	reason: string;
	evidence: string[];
	readonly derivedFrom: string | null;
	lastEngagedAt: number | null;
	readonly createdSeq: number;
}

const ref = z.string().min(1).max(64);
const refs = z.array(ref).max(12);
const text = (max: number) => z.string().min(1).max(max);

export const interestAdd = z.strictObject({
	op: z.literal("interest.add"),
	localId: ref,
	topic: text(200),
	/** host_seed is never accepted from the model (settle rejects it). */
	origin: z.enum(["user_relation", "own"]),
	reason: text(300),
	evidenceRefs: refs,
	derivedFrom: ref.nullable(),
});
export const interestUpdate = z.strictObject({
	op: z.literal("interest.update"),
	id: ref,
	expectedRevision: z.int().min(1),
	status: z.enum(interestStatuses).nullable(),
	topic: text(200).nullable(),
	reason: text(300),
	evidenceRefs: refs,
});
export type InterestOp =
	| z.infer<typeof interestAdd>
	| z.infer<typeof interestUpdate>;

export const iUpdateSchema = z.strictObject({
	...fUpdateSchema.shape,
	ops: z
		.array(
			z.union([
				...(fUpdateSchema.shape.ops.element.options as never as z.ZodType[]),
				interestAdd,
				interestUpdate,
			] as never),
		)
		.max(12),
});
