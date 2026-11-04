import {
	isOpenIntent,
	type AgencyState,
	type Intent,
	type Observation,
	type WorkReturn,
} from "../contracts/model.ts";

type Finding = Intent & { lastReturn: WorkReturn };

export const isFindingReturn = (
	o: Observation | undefined,
	workRef: string,
): o is Observation => o?.kind === "work.returned" && o.workRef === workRef;

export const recentFindings = (
	intents: readonly Intent[],
	limit: number,
): Finding[] =>
	intents
		.filter((i): i is Finding => !!i.lastReturn)
		.reverse()
		.sort((a, b) => b.lastReturn.at - a.lastReturn.at)
		.slice(0, limit);

export const findingIntents = (state: AgencyState) =>
	recentFindings(
		state.intents.filter((i) => !isOpenIntent(i)),
		5,
	);

/** Host observation IDs are free-form. Only issue finding references that are unambiguous in this request. */
export function selectionFindingRefs(
	findings: readonly Finding[],
	evidence: ReadonlySet<string>,
	observation: (id: string) => Observation | undefined,
) {
	const workByRef = new Map<string, string>();
	const occupied = (id: string) =>
		evidence.has(id) || observation(id) !== undefined || workByRef.has(id);
	const shown = findings.map((i) => {
		let ref = `finding:${i.id}`;
		while (occupied(ref)) ref = `finding:${ref}`;
		workByRef.set(ref, i.lastReturn.workRef);
		// Older hosts cite the bare intent ID. Preserve that form only when it cannot name an observation.
		if (!occupied(i.id)) workByRef.set(i.id, i.lastReturn.workRef);
		for (const id of i.evidence) {
			const o = observation(id);
			if (isFindingReturn(o, i.lastReturn.workRef))
				workByRef.set(id, i.lastReturn.workRef);
		}
		return { intentId: i.id, ref };
	});
	// A regular candidate can also cite a work return before its intent is closed.
	// Recording its origin does not grant the candidate-free speech exception.
	function citedWorkRefs(refs: readonly string[]): string[] {
		const units = new Set<string>();
		for (const ref of refs) {
			const o = observation(ref);
			const work = o?.kind === "work.returned" ? o.workRef : workByRef.get(ref);
			if (work) units.add(work);
		}
		return [...units];
	}
	return { shown, accepted: new Set(workByRef.keys()), citedWorkRefs };
}
