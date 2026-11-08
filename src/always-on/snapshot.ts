import type { AlwaysOnSnapshot } from "./contracts.ts";
import { forgetDerived } from "./forgetting.ts";

/** Pure persisted-state counterpart of agent.forget; no model or execution dependency. */
export function prepareAlwaysOnForgetting(
	snapshot: AlwaysOnSnapshot,
	refs: readonly string[],
): AlwaysOnSnapshot {
	const next = structuredClone(snapshot);
	const erased = forgetDerived(next.state, next.observations, refs);
	return {
		...next,
		observations: erased.observations,
		forgotten: [...new Set([...next.forgotten, ...erased.gone])],
		observationInputs: (next.observationInputs ?? []).filter(
			([id]) => !erased.gone.has(id),
		),
	};
}
