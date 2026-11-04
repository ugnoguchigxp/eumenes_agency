import { expect, test } from "bun:test";
import { scenes } from "./cases.ts";
import { runTrials } from "./trials.ts";

test("a rejected selection and a provider error leave the planned denominator intact", async () => {
	const records: string[] = [];
	const pair = scenes.slice(0, 2);
	const result = await runTrials(
		pair,
		2,
		async (scene, rep) => {
			if (rep === 1 && scene === pair[0])
				return { outcome: "decision_rejected" };
			if (rep === 1) throw new Error("provider_unavailable");
			return { outcome: "passed" };
		},
		(line) => records.push([line.case, line.rep, line.outcome].join("/")),
	);
	expect(result).toEqual({ planned: 4, completed: 4, failed: 2 });
	expect(records).toEqual([
		"previous-task/1/decision_rejected",
		"past-unrelated/1/runner_error",
		"previous-task/2/passed",
		"past-unrelated/2/passed",
	]);
});
