import type { AgencyState, Observation } from "../contracts/model.ts";
import type { InputContext, InputProvenance } from "../contracts/memory.ts";

export const stateLists = [
	["intent", "intents"],
	["candidate", "candidates"],
	["attempt", "attempts"],
	["belief", "beliefs"],
	["desire", "desires"],
	["note", "notes"],
	["interest", "interests"],
] as const;
export const stateEntries = (
	state: Partial<AgencyState>,
): [string, unknown][] =>
	stateLists.flatMap(([kind, field]) =>
		(state[field] ?? []).map(
			(item) => [`${kind}:${item.id}`, item] as [string, unknown],
		),
	);
export const unknownInput: InputContext = { sources: [], complete: false };
/** Preserve the metadata of exactly the host values selected for this call. */
export const hostInputs = (
	values: readonly { readonly input?: InputContext }[],
): InputContext[] =>
	values.map((value) => structuredClone(value.input ?? unknownInput));
export const withoutInput = <T extends { readonly input?: InputContext }>(
	values: readonly T[],
) => values.map(({ input: _input, ...value }) => value);
export const mergeInputs = (
	...inputs: readonly InputContext[]
): InputContext => {
	for (const input of inputs)
		if (
			typeof input.complete !== "boolean" ||
			!Array.isArray(input.sources) ||
			!input.sources.every((id) => typeof id === "string" && id.length > 0)
		)
			throw new TypeError("invalid input dependency context");
	return {
		sources: [...new Set(inputs.flatMap((x) => x.sources))].sort(),
		complete: inputs.every((x) => x.complete),
	};
};
export const observationInput = (o: Observation): InputContext => ({
	sources: [o.id, ...(o.refs ?? [])],
	complete: o.actor === "user",
});

/** Bounded metadata only. Never asks a model which inputs it happened to cite. */
export class ProvenanceTracker {
	private entries: Map<string, InputContext>;
	constructor(
		value?: InputProvenance,
		private readonly maxBytes = 16 * 1024 * 1024,
	) {
		this.entries = new Map(
			value?.entries.map(([k, v]) => [k, structuredClone(v)]),
		);
		this.check(this.entries);
	}
	private check(entries: Map<string, InputContext>) {
		if (
			new TextEncoder().encode(JSON.stringify([...entries])).byteLength >
			this.maxBytes
		)
			throw new RangeError("input provenance capacity exhausted");
	}
	find(key: string): InputContext | undefined {
		return this.entries.get(key);
	}
	get(key: string): InputContext {
		return this.entries.get(key) ?? unknownInput;
	}
	set(key: string, input: InputContext): void {
		const next = new Map(this.entries);
		next.set(key, mergeInputs(input));
		this.check(next);
		this.entries = next;
	}
	/** The caller supplies the same bounded state view it actually presented to the model. */
	capture(
		state: Partial<AgencyState>,
		observations: readonly Observation[],
		extra: readonly InputContext[] = [],
	): InputContext {
		return mergeInputs(
			...observations.map(
				(o) => this.entries.get(`observation:${o.id}`) ?? observationInput(o),
			),
			...stateEntries(state).map(([key]) => this.get(key)),
			...extra,
		);
	}
	track(before: AgencyState, after: AgencyState, input: InputContext): void {
		const old = new Map(
			stateEntries(before).map(([k, v]) => [k, JSON.stringify(v)]),
		);
		const next = new Map(this.entries);
		const present = new Set<string>();
		for (const [key, value] of stateEntries(after)) {
			present.add(key);
			if (old.get(key) === JSON.stringify(value)) continue;
			const own = old.has(key)
				? this.get(key)
				: { sources: [], complete: true };
			next.set(key, mergeInputs(own, input));
		}
		for (const key of old.keys()) if (!present.has(key)) next.delete(key);
		this.check(next);
		this.entries = next;
	}
	snapshot(): InputProvenance {
		return { version: 1, entries: structuredClone([...this.entries]) };
	}
}
