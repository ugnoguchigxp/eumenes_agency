/**
 * Pure settlement of condition-I interest ops (Agency Next P2-a, H3).
 * Rules (plan §3.1(1), §5.5):
 * - emerging→active, topic rewrite and derivedFrom creation need an independent observation:
 *   not actor=agent, not already in the interest's evidence; tool results count once per causationId.
 * - host_seed interests: no deletion, no topic change, model cannot create them; dormant allowed.
 * - derivedFrom must name an existing interest and may not form a cycle.
 * - capacity: at most `limit` non-faded interests.
 * - faded is not terminal: a faded interest can return to emerging only via a new derived interest.
 */
import type { Interest, InterestOp } from "../../contracts/interest.ts";

export interface ObsInfo {
	readonly actor: "user" | "agent" | "tool" | "host" | string;
	readonly causationId?: string;
}

export interface InterestSettleInput {
	readonly interests: readonly Interest[];
	readonly ops: readonly InterestOp[];
	readonly obs: ReadonlyMap<string, ObsInfo>;
	/** Metadata for older evidence outside the bounded model input. New refs still use obs. */
	readonly history?: ReadonlyMap<string, ObsInfo>;
	readonly limit: number;
	readonly seq: number;
	readonly newId: () => string;
}

export interface InterestReject {
	readonly index: number;
	readonly code: string;
}

export interface InterestSettleResult {
	readonly interests: Interest[];
	readonly rejects: InterestReject[];
}

const transitions: Record<string, readonly string[]> = {
	emerging: ["active", "dormant", "faded"],
	active: ["dormant", "faded"],
	dormant: ["active", "faded"],
	faded: [],
};

/** Independent refs: known, not agent-authored, not already counted, one per tool call. */
export function independentRefs(
	refs: readonly string[],
	counted: readonly string[],
	obs: ReadonlyMap<string, ObsInfo>,
	history: ReadonlyMap<string, ObsInfo> = obs,
): string[] {
	const out: string[] = [];
	const calls = new Set(
		counted.flatMap((r) => {
			const o = history.get(r);
			return o?.actor === "tool" ? [o.causationId ?? `?${r}`] : [];
		}),
	);
	for (const r of new Set(refs)) {
		const o = obs.get(r);
		if (!o || o.actor === "agent" || counted.includes(r)) continue;
		if (o.actor === "tool") {
			const c = o.causationId ?? `?${r}`;
			if (calls.has(c)) continue;
			calls.add(c);
		}
		out.push(r);
	}
	return out;
}

const ancestors = (
	id: string | null,
	byId: Map<string, Interest>,
): Set<string> => {
	const seen = new Set<string>();
	let cur = id;
	while (cur !== null && !seen.has(cur)) {
		seen.add(cur);
		cur = byId.get(cur)?.derivedFrom ?? null;
	}
	return seen;
};

export function settleInterests(
	input: InterestSettleInput,
): InterestSettleResult {
	const list = input.interests.map((i) => ({
		...i,
		evidence: [...i.evidence],
	}));
	const byId = new Map(list.map((i) => [i.id, i]));
	const rejects: InterestReject[] = [];
	const live = () => list.filter((i) => i.status !== "faded").length;
	const independent = (refs: readonly string[], counted: readonly string[]) =>
		independentRefs(refs, counted, input.obs, input.history);
	input.ops.forEach((op, index) => {
		const fail = (code: string) => rejects.push({ index, code });
		const unknown = op.evidenceRefs.filter((r) => !input.obs.has(r));
		if (unknown.length > 0) return fail("unknown_ref");
		if (op.op === "interest.add") {
			if ((op.origin as string) === "host_seed")
				return fail("host_seed_forbidden");
			if (live() >= input.limit) return fail("capacity");
			if (op.derivedFrom !== null) {
				const parent = byId.get(op.derivedFrom);
				if (!parent) return fail("unknown_parent");
				if (independent(op.evidenceRefs, parent.evidence).length === 0)
					return fail("derived_needs_independent");
			}
			if (op.evidenceRefs.length === 0) return fail("no_evidence");
			// A user's interest must rest on something the user (or a tool) did, not on agent talk.
			if (
				op.origin === "user_relation" &&
				independent(op.evidenceRefs, []).length === 0
			)
				return fail("relation_needs_user");
			const it: Interest = {
				id: input.newId(),
				revision: 1,
				topic: op.topic,
				origin: op.origin,
				status: "emerging",
				reason: op.reason,
				evidence: [...new Set(op.evidenceRefs)],
				derivedFrom: op.derivedFrom,
				lastEngagedAt: null,
				createdSeq: input.seq,
			};
			// Self-only evidence is allowed for an emerging interest (personality room),
			// but promotion to active later needs independent support.
			list.push(it);
			byId.set(it.id, it);
			return;
		}
		const cur = byId.get(op.id);
		if (!cur) return fail("unknown_id");
		if (cur.revision !== op.expectedRevision) return fail("stale_revision");
		if (op.topic !== null && op.topic !== cur.topic) {
			if (cur.origin === "host_seed") return fail("host_seed_immutable");
			if (independent(op.evidenceRefs, cur.evidence).length === 0)
				return fail("topic_needs_independent");
		}
		if (op.status !== null && op.status !== cur.status) {
			if (!transitions[cur.status]?.includes(op.status))
				return fail("bad_transition");
			if (cur.origin === "host_seed" && op.status === "faded")
				return fail("host_seed_immutable");
			if (
				op.status === "active" &&
				independent(op.evidenceRefs, cur.evidence).length === 0
			)
				return fail("promotion_needs_independent");
			if (op.status === "active" && live() > input.limit)
				return fail("capacity");
		}
		const changed =
			(op.status !== null && op.status !== cur.status) ||
			(op.topic !== null && op.topic !== cur.topic) ||
			op.evidenceRefs.some((r) => !cur.evidence.includes(r));
		if (!changed) return; // no_change: revision does not advance (§5.5)
		if (op.status !== null) cur.status = op.status;
		if (op.topic !== null) cur.topic = op.topic;
		cur.reason = op.reason;
		cur.evidence = [...new Set([...cur.evidence, ...op.evidenceRefs])];
		cur.revision += 1;
	});
	// Defensive: derivedFrom chains never cycle (ids are fresh, so this only guards bad input).
	for (const i of list)
		if (i.derivedFrom !== null && ancestors(i.derivedFrom, byId).has(i.id)) {
			throw new Error(`interest cycle at ${i.id}`);
		}
	return { interests: list, rejects };
}
