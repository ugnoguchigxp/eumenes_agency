import type { Observation } from "./model.ts";

/** Input dependency, deliberately separate from the model's cited evidence. */
export interface InputContext {
	readonly sources: readonly string[];
	/** False for legacy or host-derived data whose complete inputs are unavailable. */
	readonly complete: boolean;
}
/** Host value and its additional input dependencies, captured together. */
export interface WithInput<T> {
	readonly value: T;
	readonly input: InputContext;
}
export interface InputProvenance {
	readonly version: 1;
	readonly entries: readonly (readonly [string, InputContext])[];
}
export interface ArchivedObservation {
	readonly observation: Observation;
	readonly input: InputContext;
}
/** Host owns durable storage. Lookups must respect its forgetting journal. */
export interface ObservationArchive {
	get(id: string): ArchivedObservation | undefined;
}
