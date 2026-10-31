import type { z } from "zod";
import type {
	AgencyState,
	Condition,
	HostTodo,
	HostTopic,
	Limits,
	Observation,
	Opportunity,
	ToolCapability,
} from "./model.ts";
import type { EmotionEmoji } from "./emotion.ts";
import type { ParticipationProposal, WireUpdate } from "./proposals.ts";
import type { StandingInterest } from "./runtime.ts";

/** Public execution contract. Its description is never inserted into model messages. */
export interface AgencyOutputContract<T> {
	readonly schema: z.ZodType<T>;
	readonly description: string;
}

/** A bounded view of existing state, not a second state store. */
export type ModelStateData = Pick<
	AgencyState,
	"revision" | "notes" | "intents" | "candidates" | "beliefs" | "desires"
>;

interface ModelData {
	readonly condition: Condition;
	readonly now: number;
	readonly observations: readonly Observation[];
	readonly freshIds: readonly string[];
	readonly state: ModelStateData;
	readonly delivered: readonly string[];
	readonly tools: readonly ToolCapability[];
	readonly limits: Limits;
	readonly minutesSinceUserInput: number | null;
	readonly todos?: readonly HostTodo[];
}

export interface UpdateModelData extends ModelData {
	readonly due: {
		readonly reviewIntentIds: readonly string[];
		readonly pressure: readonly ("intents" | "candidates")[];
	};
}

export interface SelectModelData extends ModelData {
	readonly opportunity: Omit<Opportunity, "topics" | "ambient" | "todos">;
	readonly candidates: AgencyState["candidates"];
	readonly deliveredMinutesAgo?: readonly number[];
	readonly deliveredEmotions?: readonly (EmotionEmoji | null)[];
	readonly lastUsedMinutesAgo?: readonly (readonly [string, number])[];
	readonly interests?: readonly StandingInterest[];
	readonly topics?: readonly HostTopic[];
	readonly ambient?: readonly HostTopic[];
}

export type ParticipationOutput = ParticipationProposal & {
	readonly emotion?: EmotionEmoji | null;
};

export interface UpdateSystemContextInput {
	readonly data: UpdateModelData;
	readonly outputContract: AgencyOutputContract<WireUpdate>;
}

export interface SelectSystemContextInput {
	readonly data: SelectModelData;
	readonly outputContract: AgencyOutputContract<ParticipationOutput>;
}

/** Resolved once per logical call, before the budgeted attempt (including its retry). */
export type SystemContextSource<T> = string | ((input: T) => string);

export interface BackgroundSystemContext {
	readonly update: SystemContextSource<UpdateSystemContextInput>;
	readonly select: SystemContextSource<SelectSystemContextInput>;
}
