import { isOpenCandidate, isOpenIntent } from "../contracts/model.ts";
import type { AgencyState, Condition } from "../contracts/model.ts";
import type {
	ModelStateData,
	SelectModelData,
	UpdateModelData,
} from "../contracts/system-context.ts";
import { findingIntents } from "./findings.ts";
import type { SelectPromptInput, UpdatePromptInput } from "./prompts.ts";
import { withoutInput } from "./provenance.ts";
import { outboundWaitMs } from "../domains/agency/participation.ts";

const opportunityData = (
	opportunity: import("../contracts/model.ts").Opportunity,
) => ({
	...opportunity,
	...(opportunity.topics ? { topics: withoutInput(opportunity.topics) } : {}),
	...(opportunity.ambient
		? { ambient: withoutInput(opportunity.ambient) }
		: {}),
	...(opportunity.todos ? { todos: withoutInput(opportunity.todos) } : {}),
});

/** Same visibility bounds as the experimental renderers; no behavioral ordering. */
const stateData = (
	condition: Condition,
	state: AgencyState,
	select: boolean,
	findings = false,
): ModelStateData => ({
	revision: state.revision,
	...(condition === "F" && state.interests !== undefined
		? { interests: state.interests.filter((i) => i.status !== "faded") }
		: {}),
	notes: condition === "B1" ? state.notes : [],
	intents:
		condition === "B1"
			? []
			: [
					...state.intents.filter(isOpenIntent),
					...state.intents
						.filter((i) => !isOpenIntent(i) && !(findings && i.lastReturn))
						.slice(-5),
					...(findings ? findingIntents(state) : []),
				],
	candidates:
		condition === "B1" || select
			? []
			: [
					...state.candidates.filter(isOpenCandidate),
					...state.candidates.filter((c) => !isOpenCandidate(c)).slice(-5),
				],
	beliefs:
		condition !== "F" || select
			? []
			: [
					...state.beliefs.filter(
						(b) => b.status === "active" || b.status === "disputed",
					),
					...state.beliefs
						.filter(
							(b) => b.status === "retracted" || b.status === "superseded",
						)
						.reverse()
						.sort(
							(a, b) =>
								(b.updatedSeq ?? b.createdSeq ?? 0) -
								(a.updatedSeq ?? a.createdSeq ?? 0),
						)
						.slice(0, 5),
				],
	desires:
		condition !== "F" || select
			? []
			: state.desires.filter((d) => d.status === "open" || d.status === "held"),
});

export const updateModelData = (i: UpdatePromptInput): UpdateModelData =>
	structuredClone({
		condition: i.condition,
		now: i.now,
		...(i.opportunity ? { opportunity: opportunityData(i.opportunity) } : {}),
		...(i.validationCodes?.length
			? { validationCodes: i.validationCodes }
			: {}),
		observations: i.observations,
		freshIds: [...i.freshIds],
		state: stateData(i.condition, i.state, false, i.findings),
		due: i.due,
		delivered: i.delivered,
		tools: withoutInput(i.tools),
		limits: i.limits,
		minutesSinceUserInput: i.minutesSinceUserInput,
		...(i.todos ? { todos: withoutInput(i.todos) } : {}),
		...(i.topics ? { topics: withoutInput(i.topics) } : {}),
		...(i.interests ? { interests: withoutInput(i.interests) } : {}),
	});

export const selectModelData = (i: SelectPromptInput): SelectModelData => {
	const {
		id,
		at,
		trigger,
		presence,
		foregroundBusy,
		playerBusy,
		speechAllowed,
	} = i.opportunity;
	return structuredClone({
		condition: i.condition,
		now: i.now,
		opportunity: {
			id,
			at,
			trigger,
			presence,
			foregroundBusy,
			playerBusy,
			...(speechAllowed === undefined ? {} : { speechAllowed }),
		},
		observations: i.observations,
		freshIds: [...i.freshIds],
		state: stateData(i.condition, i.state, true, i.findings),
		candidates: [...i.candidates],
		outboundWaitMs: outboundWaitMs(i.state, i.limits, i.now),
		...(i.findingRefs?.length ? { findingRefs: i.findingRefs } : {}),
		delivered: i.delivered,
		...(i.deliveredMinutesAgo
			? { deliveredMinutesAgo: i.deliveredMinutesAgo }
			: {}),
		...(i.deliveredEmotions ? { deliveredEmotions: i.deliveredEmotions } : {}),
		...(i.lastUsedMinutesAgo
			? { lastUsedMinutesAgo: [...i.lastUsedMinutesAgo] }
			: {}),
		...(i.interests ? { interests: withoutInput(i.interests) } : {}),
		...(i.topics ? { topics: withoutInput(i.topics) } : {}),
		...(i.ambient ? { ambient: withoutInput(i.ambient) } : {}),
		...(i.todos ? { todos: withoutInput(i.todos) } : {}),
		tools: withoutInput(i.tools),
		limits: i.limits,
		minutesSinceUserInput: i.minutesSinceUserInput,
	});
};
