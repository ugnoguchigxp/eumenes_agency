import type { Scene } from "./cases.ts";

/** Every requested fixture gets a result even if an earlier proposal or provider call failed. */
export async function runTrials<T extends { outcome: string }>(
	scenes: readonly Scene[],
	reps: number,
	run: (scene: Scene, rep: number) => Promise<T>,
	report: (
		result: { case: string; rep: number } & (
			| T
			| { outcome: "runner_error"; error: string }
		),
	) => void,
) {
	let failed = 0;
	let completed = 0;
	for (let rep = 1; rep <= reps; rep++) {
		for (const scene of scenes) {
			let result: T | { outcome: "runner_error"; error: string };
			try {
				result = await run(scene, rep);
			} catch (error) {
				result = {
					outcome: "runner_error",
					error: error instanceof Error ? error.message : String(error),
				};
			}
			report({ case: scene.id, rep, ...result });
			completed++;
			if (result.outcome !== "passed") failed++;
		}
	}
	return { planned: scenes.length * reps, completed, failed };
}
