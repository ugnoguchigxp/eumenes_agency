import type { AgencySnapshot } from "../contracts/runtime.ts";
import type { ArchivedObservation, InputContext } from "../contracts/memory.ts";
import {
	mergeInputs,
	observationInput,
	stateEntries,
	stateLists,
	unknownInput,
} from "./provenance.ts";
import { validateRestore } from "./snapshot.ts";

export const dependsOn = (
	input: InputContext,
	forgotten: ReadonlySet<string>,
) =>
	forgotten.size > 0 &&
	(!input.complete || input.sources.some((id) => forgotten.has(id)));

/** Pure plan. The host must atomically persist the journal, redactions and checkpoint. */
export function prepareForgetting(
	snapshot: AgencySnapshot,
	refs: readonly string[],
) {
	const next = structuredClone(snapshot);
	const forgotten = new Set([...(snapshot.forgottenRefs ?? []), ...refs]);
	if ([...forgotten].some((id) => !id.length))
		throw new TypeError("empty forget reference");
	const inputs = new Map(snapshot.provenance?.entries);
	const removed = new Set<string>();
	const affected = (key: string, cited: readonly string[] = []) =>
		dependsOn(
			mergeInputs(inputs.get(key) ?? unknownInput, {
				sources: cited,
				complete: true,
			}),
			forgotten,
		);
	for (const [key, item] of stateEntries(next.state)) {
		const v = item as { evidence?: string[] };
		if (affected(key, v.evidence)) removed.add(key);
	}
	// Referential integrity, not semantic classification. Never leave runnable children of removed state.
	let changed = true;
	while (changed) {
		changed = false;
		const add = (key: string, hit: boolean) => {
			if (hit && !removed.has(key)) {
				removed.add(key);
				changed = true;
			}
		};
		for (const c of next.state.candidates)
			add(`candidate:${c.id}`, removed.has(`intent:${c.intentId}`));
		for (const a of next.state.attempts)
			add(
				`attempt:${a.id}`,
				a.candidateId !== null && removed.has(`candidate:${a.candidateId}`),
			);
		for (const d of next.state.desires)
			add(
				`desire:${d.id}`,
				d.beliefRefs.some((id) => removed.has(`belief:${id}`)),
			);
		for (const i of next.state.intents)
			add(
				`intent:${i.id}`,
				i.desireRef !== null && removed.has(`desire:${i.desireRef}`),
			);
	}
	for (const [kind, field] of stateLists) {
		// Each list retains its original item type.
		if (next.state[field] === undefined) continue;
		(next.state[field] as unknown[]) = (next.state[field] ?? []).filter(
			(x) => !removed.has(`${kind}:${x.id}`),
		);
	}
	const liveIds = new Set(
		stateEntries(next.state).map(([key]) => key.slice(key.indexOf(":") + 1)),
	);
	next.state.focus = next.state.focus.filter((id) => liveIds.has(id));
	const erasedObservations: string[] = [];
	const observations = next.observations.flatMap((o) => {
		const input = inputs.get(`observation:${o.id}`) ?? observationInput(o);
		if (!forgotten.has(o.id) && !dependsOn(input, forgotten)) return [o];
		erasedObservations.push(o.id);
		removed.add(`observation:${o.id}`);
		// A forgotten pending event keeps a bodyless slot until processed; no other input is acknowledged.
		return o.seq > next.cursor
			? [
					{
						id: o.id,
						seq: o.seq,
						kind: o.kind,
						actor: "host" as const,
						occurredAt: o.occurredAt,
						text: "",
					},
				]
			: [];
	});
	const c = next.continuity;
	const continuity = c
		? {
				...c,
				issued: c.issued.filter(
					(t) =>
						!removed.has(`attempt:${t.id}`) && !affected(`attempt:${t.id}`),
				),
				receipts: c.receipts.filter(
					([, o]) =>
						!removed.has(`observation:${o.id}`) &&
						!affected(`observation:${o.id}`),
				),
				topics: c.topics.filter(([id]) => !removed.has(`attempt:${id}`)),
				feelings: c.feelings.filter(
					([id]) => !removed.has(`observation:${id}`),
				),
				// Untracked diagnostics / topic strings may contain a source's body. Clear conservatively.
				diagnostics: [],
				lastUsed: [],
			}
		: undefined;
	const { scheduling: _scheduling, continuity: _continuity, ...base } = next;
	const checkpoint: AgencySnapshot = {
		...base,
		observations,
		...(continuity ? { continuity } : {}),
		compactedThrough: next.cursor,
		forgottenRefs: [...new Set([...forgotten, ...erasedObservations])],
		provenance: {
			version: 1,
			entries: [...inputs].filter(([key]) => !removed.has(key)),
		},
		// Scheduling uses entity IDs and fault codes; rebuild from retained state on next wake.
	};
	if (checkpoint.condition) validateRestore(checkpoint, checkpoint.condition);
	return {
		checkpoint,
		removedKeys: [...removed],
		erasedObservations,
		forgotten: [...forgotten],
	};
}

/** Lossless archival compaction. Summaries never replace the source or pending events. */
export function prepareCompaction(snapshot: AgencySnapshot, keepRecent = 64) {
	if (!Number.isInteger(keepRecent) || keepRecent < 30)
		throw new RangeError("keepRecent must be >= 30");
	const pinned = new Set(
		snapshot.observations.slice(-keepRecent).map((o) => o.id),
	);
	const lastUser = [...snapshot.observations]
		.reverse()
		.find((o) => o.actor === "user");
	if (lastUser) pinned.add(lastUser.id);
	// Preserve all evidence used by settlement and all last delivery records used by selection.
	for (const [, value] of stateEntries(snapshot.state)) {
		const v = value as { evidence?: string[] };
		for (const ref of v.evidence ?? []) pinned.add(ref);
	}
	for (const o of snapshot.observations
		.filter((o) => o.kind === "delivery.observed")
		.slice(-30))
		pinned.add(o.id);
	const inputs = new Map(snapshot.provenance?.entries);
	const archive: ArchivedObservation[] = [];
	const observations = snapshot.observations.filter((o) => {
		if (o.seq > snapshot.cursor || pinned.has(o.id)) return true;
		archive.push({
			observation: structuredClone(o),
			input: structuredClone(
				inputs.get(`observation:${o.id}`) ?? observationInput(o),
			),
		});
		inputs.delete(`observation:${o.id}`);
		return false;
	});
	const checkpoint: AgencySnapshot = {
		...structuredClone(snapshot),
		observations: structuredClone(observations),
		compactedThrough: snapshot.cursor,
		provenance: { version: 1, entries: [...inputs] },
	};
	if (checkpoint.condition) validateRestore(checkpoint, checkpoint.condition);
	return { checkpoint, archive };
}
