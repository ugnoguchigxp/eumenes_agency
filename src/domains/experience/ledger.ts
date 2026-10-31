import { ObservationConflictError } from "../../contracts/errors.ts";
import type { Observation, ObservationInput } from "../../contracts/model.ts";

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
	a.causationId === b.causationId;

export const createLedger = (): Ledger => {
	const list: Observation[] = [];
	const byId = new Map<string, Observation>();
	const done = new Set<number>();
	let cursor = 0;

	return {
		record(input) {
			const known = byId.get(input.id);
			if (known) {
				if (sameContent(known, input)) return known;
				throw new ObservationConflictError(input.id);
			}
			const obs: Observation = Object.freeze({
				...input,
				seq: list.length + 1,
			});
			list.push(obs);
			byId.set(obs.id, obs);
			return obs;
		},
		get: (id) => byId.get(id),
		all: () => list.slice(),
		lastSeq: () => list.length,
		cursor: () => cursor,
		pending(upto) {
			const end = upto ?? list.length;
			return list.filter(
				(o) => o.seq > cursor && o.seq <= end && !done.has(o.seq),
			);
		},
		markProcessed(seqs) {
			for (const s of seqs) if (s > cursor) done.add(s);
			while (done.has(cursor + 1)) {
				cursor += 1;
				done.delete(cursor);
			}
		},
	};
};
