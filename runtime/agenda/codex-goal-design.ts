import { z } from "zod";
import {
	createDesignGenerator,
	designInputForGoal,
	GOAL_DESIGNER,
	goalDesignSchema,
	type GoalDesigner,
} from "./goal-design.ts";
import { codexSdkTurn, type CodexTurn } from "./web-research.ts";

export function codexGoalDesigner(
	input: {
		readonly turn?: CodexTurn;
		readonly apiKey?: string | undefined;
		readonly record?: (result: Awaited<ReturnType<CodexTurn>>) => void;
	} = {},
): GoalDesigner {
	const key = input.apiKey;
	const turn =
		input.turn ??
		codexSdkTurn({
			...GOAL_DESIGNER,
			...(key ? { apiKey: key } : {}),
			webSearchMode: "disabled",
			outputSchema: z.toJSONSchema(goalDesignSchema),
		});
	const generate = createDesignGenerator(
		async ({ instructions, data, signal }) => {
			const result = await turn(
				`${instructions}\n\n<design_context>${data}</design_context>`,
				signal,
			);
			input.record?.(result);
			return JSON.parse(result.text);
		},
	);
	return (context, signal) => generate(designInputForGoal(context), signal);
}
