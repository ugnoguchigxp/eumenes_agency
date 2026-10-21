/**
 * P1-E state-trajectory check (spec §5.2): what the agent holds when an opportunity
 * arrives, judged by the evidence refs of its open items. Deterministic, no model.
 */
import type { OpenItem, StateExpect } from "./contracts.ts";
import type { AgencyState, Condition } from "../src/contracts/model.ts";
import { isOpenCandidate, isOpenIntent } from "../src/contracts/model.ts";
import type { LlmPort, LlmRequest, LlmResult } from "../src/contracts/ports.ts";
import type { AgencyRuntime } from "../src/contracts/runtime.ts";

export interface StateCheck {
	/** Per mustHold group: some open item cites a step of the group (deterministic, scored). */
	readonly mustHold: boolean[];
	/**
	 * mustNotHold steps still cited by an open item. Informational only: citing a step does
	 * not mean the matter is still treated as pending (a note may say "resolved"), so
	 * mustNotHold is scored by the state judge (eval/state-judge.ts), not by this list.
	 */
	readonly violations: string[];
}

/**
 * Evidence arrays of the open items: B1 notes; B2/F open intents and open candidates.
 * Observation ids equal case step ids in replay, so a ref is directly a step id.
 */
export function openEvidence(
	condition: Condition,
	state: AgencyState,
): string[][] {
	if (condition === "B1") return state.notes.map((n) => [...n.evidence]);
	if (condition === "B2" || condition === "F")
		return [
			...state.intents.filter(isOpenIntent).map((i) => [...i.evidence]),
			...state.candidates.filter(isOpenCandidate).map((c) => [...c.evidence]),
		];
	return [];
}

const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();

/** The open items (same set as openEvidence) with the text and state a reader or judge needs. */
export function openItems(
	condition: Condition,
	state: AgencyState,
): OpenItem[] {
	if (condition === "B1")
		return state.notes.map((n) => ({
			id: n.id,
			kind: "note",
			text: oneLine(n.text),
			state: null,
			holdReason: null,
			evidence: [...n.evidence],
		}));
	if (condition === "B2" || condition === "F")
		return [
			...state.intents.filter(isOpenIntent).map((i) => ({
				id: i.id,
				kind: "intent" as const,
				text: oneLine(
					`${i.desiredState} / 動機: ${i.motive} / 完了条件: ${i.completionCondition} / 再開条件: ${i.resumeCondition} / 撤回条件: ${i.withdrawCondition}`,
				),
				state: i.state,
				holdReason: null,
				evidence: [...i.evidence],
			})),
			...state.candidates.filter(isOpenCandidate).map((c) => ({
				id: c.id,
				kind: "candidate" as const,
				text: oneLine(`${c.kind}: ${c.content} / 適用条件: ${c.applyWhen}`),
				state: c.state,
				holdReason: c.holdReason,
				evidence: [...c.evidence],
			})),
		];
	return [];
}

/** null when the opportunity has no stateExpect or the condition keeps no state (B0). */
export function computeStateCheck(
	condition: Condition,
	state: AgencyState,
	expect: StateExpect | null,
): StateCheck | null {
	if (expect === null || condition === "B0") return null;
	const cited = new Set(openEvidence(condition, state).flat());
	return {
		mustHold: expect.mustHold.map((group) => group.some((s) => cited.has(s))),
		violations: expect.mustNotHold.filter((s) => cited.has(s)),
	};
}

/**
 * Captures the state at the moment select is called: after the pre-opportunity
 * update and refresh, before select can reserve, defer or dismiss anything.
 * The runtime has no hook for this, so it is read through the LlmPort wrapper.
 */
export interface SelectProbe {
	/** Wraps the port handed to the runtime. */
	wrap(llm: LlmPort): LlmPort;
	/** Points the probe at the runtime of the current replay. */
	attach(runtime: AgencyRuntime): void;
	/** Clears the capture before an opportunity. */
	reset(): void;
	/** The state seen by the first select call of the opportunity, or null if none was made. */
	captured(): AgencyState | null;
}

export function createSelectProbe(): SelectProbe {
	let runtime: AgencyRuntime | null = null;
	let state: AgencyState | null = null;
	return {
		wrap: (llm) => ({
			complete<T>(
				request: LlmRequest<T>,
				signal: AbortSignal,
			): Promise<LlmResult<T>> {
				if (request.purpose === "select" && runtime && state === null)
					state = runtime.snapshot().state;
				return llm.complete(request, signal);
			},
		}),
		attach(next) {
			runtime = next;
			state = null;
		},
		reset() {
			state = null;
		},
		captured: () => state,
	};
}
