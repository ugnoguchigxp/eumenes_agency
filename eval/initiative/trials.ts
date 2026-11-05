/**
 * Every requested fixture gets a result even if an earlier proposal or provider call failed.
 * `stop` (checked before each trial) ends the run on a safety, cost or version condition; every remaining
 * planned trial is still reported, as `incomplete` with the stop reason, so the denominator stays intact.
 */
export async function runTrials<
	T extends { outcome: string },
	S extends { readonly id: string },
>(
	scenes: readonly S[],
	reps: number,
	run: (scene: S, rep: number) => Promise<T>,
	report: (
		result: { case: string; rep: number } & (
			| T
			| { outcome: "runner_error"; error: string }
			| { outcome: "incomplete"; reason: string }
		),
	) => void,
	options: { stop?: () => string | null } = {},
) {
	let failed = 0;
	let completed = 0;
	let stopped: string | null = null;
	for (let rep = 1; rep <= reps; rep++) {
		for (const scene of scenes) {
			stopped ??= options.stop?.() ?? null;
			if (stopped) {
				report({ case: scene.id, rep, outcome: "incomplete", reason: stopped });
				failed++;
				continue;
			}
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
	const totals = { planned: scenes.length * reps, completed, failed };
	return options.stop ? { ...totals, stopped } : totals;
}
