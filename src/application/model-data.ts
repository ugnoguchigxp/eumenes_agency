import { isOpenCandidate, isOpenIntent } from "../contracts/model.ts";
import type { AgencyState, Condition } from "../contracts/model.ts";
import type {
	ModelStateData,
	SelectModelData,
	UpdateModelData,
} from "../contracts/system-context.ts";
import type { SelectPromptInput, UpdatePromptInput } from "./prompts.ts";

/** Same visibility bounds as the experimental renderers; no behavioral ordering. */
const stateData = (
	condition: Condition,
	state: AgencyState,
	select: boolean,
): ModelStateData => ({
	revision: state.revision,
	notes: condition === "B1" ? state.notes : [],
	intents:
		condition === "B1"
			? []
			: [
					...state.intents.filter(isOpenIntent),
					...state.intents.filter((i) => !isOpenIntent(i)).slice(-5),
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
		observations: i.observations,
		freshIds: [...i.freshIds],
		state: stateData(i.condition, i.state, false),
		due: i.due,
		delivered: i.delivered,
		tools: i.tools,
		limits: i.limits,
		minutesSinceUserInput: i.minutesSinceUserInput,
		...(i.todos ? { todos: i.todos } : {}),
	});

export const selectModelData = (i: SelectPromptInput): SelectModelData => {
	const { id, at, trigger, presence, foregroundBusy, playerBusy } =
		i.opportunity;
	return structuredClone({
		condition: i.condition,
		now: i.now,
		opportunity: { id, at, trigger, presence, foregroundBusy, playerBusy },
		observations: i.observations,
		freshIds: [...i.freshIds],
		state: stateData(i.condition, i.state, true),
		candidates: [...i.candidates],
		delivered: i.delivered,
		...(i.deliveredMinutesAgo
			? { deliveredMinutesAgo: i.deliveredMinutesAgo }
			: {}),
		...(i.deliveredEmotions ? { deliveredEmotions: i.deliveredEmotions } : {}),
		...(i.lastUsedMinutesAgo
			? { lastUsedMinutesAgo: [...i.lastUsedMinutesAgo] }
			: {}),
		...(i.interests ? { interests: i.interests } : {}),
		...(i.topics ? { topics: i.topics } : {}),
		...(i.ambient ? { ambient: i.ambient } : {}),
		...(i.todos ? { todos: i.todos } : {}),
		tools: i.tools,
		limits: i.limits,
		minutesSinceUserInput: i.minutesSinceUserInput,
	});
};
