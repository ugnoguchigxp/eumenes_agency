import {
	ObservationConflictError,
	ObservationCapacityError,
} from "../../contracts/errors.ts";
import {
	defaultRetentionLimits,
	retentionLimitsSchema,
	type RetentionLimits,
} from "../../contracts/model.ts";
import type { Observation, ObservationInput } from "../../contracts/model.ts";
import type { ObservationArchive } from "../../contracts/memory.ts";

/** Append-only observation record with a processed cursor. */
export interface Ledger {
	/** Idempotent by id; same id with different content throws. */
	record(input: ObservationInput): Observation;
	get(id: string): Observation | undefined;
	all(): readonly Observation[];
	lastSeq(): number;
	/** Highest seq such that every seq up to it is processed. */
	cursor(): number;
	/** Observations not yet processed, in receipt order, optionally up to a seq. */
	pending(upto?: number): readonly Observation[];
	/** no_change counts as processed; rejected or aborted calls do not call this. */
	markProcessed(seqs: readonly number[]): void;
}

const sameContent = (a: Observation, b: ObservationInput) =>
	a.kind === b.kind &&
	a.actor === b.actor &&
	a.occurredAt === b.occurredAt &&
	a.text === b.text &&
	a.causationId === b.causationId &&
	a.code === b.code &&
	a.interestId === b.interestId &&
	a.workRef === b.workRef &&
	a.workStatus === b.workStatus &&
	a.tts === b.tts &&
	a.deliveryStatus === b.deliveryStatus &&
	a.speechHandoff?.proposedText === b.speechHandoff?.proposedText &&
	JSON.stringify(a.speechHandoff?.findingWorkRefs) ===
		JSON.stringify(b.speechHandoff?.findingWorkRefs) &&
	JSON.stringify(a.refs ?? null) === JSON.stringify(b.refs ?? null);

export const createLedger = (
	inputLimits: RetentionLimits = defaultRetentionLimits,
	restored?: { observations: readonly Observation[]; cursor: number },
	archive?: ObservationArchive,
): Ledger => {
	const limits = retentionLimitsSchema.parse(inputLimits);
	let bytes = 0;
	const list: Observation[] = [];
	const byId = new Map<string, Observation>();
	const done = new Set<number>();
	let cursor = restored?.cursor ?? 0;
	let lastSeq = cursor;
	let restoring = true;
	const lookup = (id: string) => {
		const local = byId.get(id);
		const entry =
			local ?? (restoring ? undefined : archive?.get(id)?.observation);
		if (entry && entry.id !== id)
			throw new TypeError("archive identity mismatch");
		if (
			entry &&
			!local &&
			(!Number.isInteger(entry.seq) || entry.seq < 1 || entry.seq > cursor)
		)
			throw new TypeError("archive sequence outside processed history");
		return local ?? (entry ? Object.freeze(structuredClone(entry)) : undefined);
	};

	const api: Ledger = {
		record(input) {
			const known = lookup(input.id);
			if (known) {
				if (sameContent(known, input)) return known;
				throw new ObservationConflictError(input.id);
			}
			if (list.length >= limits.observations)
				throw new ObservationCapacityError("count");
			if (input.text.length > limits.observationBytes)
				throw new ObservationCapacityError("observation_bytes");
			const size = new TextEncoder().encode(JSON.stringify(input)).byteLength;
			if (size > limits.observationBytes)
				throw new ObservationCapacityError("observation_bytes");
			if (bytes + size > limits.totalObservationBytes)
				throw new ObservationCapacityError("total_bytes");
			const copy = structuredClone(input);
			if (copy.refs) Object.freeze(copy.refs);
			if (copy.speechHandoff) {
				Object.freeze(copy.speechHandoff.findingWorkRefs);
				Object.freeze(copy.speechHandoff);
			}
			const obs: Observation = Object.freeze({
				...copy,
				seq: ++lastSeq,
			});
			list.push(obs);
			bytes += size;
			byId.set(obs.id, obs);
			return obs;
		},
		get: lookup,
		all: () => list.slice(),
		lastSeq: () => lastSeq,
		cursor: () => cursor,
		pending(upto) {
			const end = upto ?? lastSeq;
			return list.filter(
				(o) => o.seq > cursor && o.seq <= end && !done.has(o.seq),
			);
		},
		markProcessed(seqs) {
			for (const s of seqs) if (s > cursor && s <= lastSeq) done.add(s);
			while (done.has(cursor + 1)) {
				cursor += 1;
				done.delete(cursor);
			}
		},
	};
	// Restore original identities and ordering. Validation of sparse checkpoints is at the boundary.
	for (const o of restored?.observations ?? []) {
		const { seq, ...input } = o;
		lastSeq = seq - 1;
		api.record(input);
	}
	lastSeq = Math.max(lastSeq, cursor);
	restoring = false;
	return api;
};
