/**
 * A full run seen through the quick suite (scenarios.ts `quickSuite`): for each of its scenarios
 * the events up to the window's end go to a new run dir `<run>-q`, and the judge scores that part
 * again (the original is kept). A window is the first part of the full scenario, and neither the
 * agent nor the simulated user knows when it ends, so the cut run is what a quick run of the same
 * version would have been: the baseline for a quick run without running the agent again. The cost
 * and wall time of the cut part are estimated from its share of the agent's tokens. The judge's
 * cost is recorded.
 *
 *   zsh -l scripts/api-entry.zsh eval/agenda/window.ts <run> [<run>...]
 *   bun eval/agenda/compare.ts <run>-q,... <quick run>,...
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createClaudeClient } from "../../standalone/claude.ts";
import { openUncappedMeter } from "../../standalone/always-on-host.ts";
import { createProviderLlm } from "../../standalone/providers.ts";
import { loadSettings } from "../../standalone/settings.ts";
import { judgeStored, load } from "./rejudge.ts";
import { agendaScenarios, inWindow, quickSuite } from "./scenarios.ts";
import type { AgendaSimEvent } from "./sim.ts";

/** When the scenario's current session starts on its clock (after the earlier one, if any). */
const startMs = (name: string) => {
	const s = agendaScenarios.find((x) => x.name === name);
	return s?.previous
		? (s.previous.minutes * 60 + s.previous.gapHours * 3600) * 1000
		: 0;
};

const tokens = (events: readonly AgendaSimEvent[]) =>
	events.reduce((n, e) => {
		const u = (e as { usage?: { inputTokens?: number; outputTokens?: number } })
			.usage;
		return n + (u ? (u.inputTokens ?? 0) + (u.outputTokens ?? 0) : 0);
	}, 0);

if (import.meta.main) {
	const runs = process.argv.slice(2);
	if (runs.length === 0) throw new Error("usage: window.ts <run> [<run>...]");
	const settings = loadSettings(
		resolve(process.env.AGENCY_SETTINGS ?? "config/always-on.json"),
	);
	const meter = openUncappedMeter(settings, resolve("data/agenda/usage.jsonl"));
	const spentBefore = meter.spentUsd();
	const client = createClaudeClient({ maxRetries: 8, timeout: 120_000 });
	const llm = createProviderLlm(settings.llm.background, meter, client);
	const jobs = runs.flatMap((run) => {
		const dir = resolve("data/agenda/runs", run);
		if (!existsSync(dir)) throw new Error(`no run: ${dir}`);
		const out = `${dir}-q`;
		mkdirSync(out, { recursive: true });
		return quickSuite.map((q) => ({ run, dir, out, ...q }));
	});
	const missing: string[] = [];
	const cutOne = async (job: (typeof jobs)[number]) => {
		const { dir, out, name, minutes } = job;
		const f = join(dir, `${name}.summary.json`);
		if (!existsSync(f)) {
			missing.push(`${job.run}/${name}`);
			return;
		}
		const summary = JSON.parse(readFileSync(f, "utf8")) as {
			scenario: string;
			expect: string;
			minutes: number;
			usd: number;
			wallSec?: number;
			notes?: readonly { readonly at: number }[];
			judge?: unknown;
		};
		if (minutes > summary.minutes)
			throw new Error(`${job.run}/${name}: ${summary.minutes} minutes only`);
		const all = load(join(dir, `${name}.jsonl`));
		const events = inWindow(all, minutes);
		const previous = load(join(dir, `${name}.previous.jsonl`));
		const share = tokens(all) > 0 ? tokens(events) / tokens(all) : 1;
		const judge = await judgeStored(llm, {
			scenario: name,
			expect: summary.expect,
			previous,
			events,
		});
		writeFileSync(
			join(out, `${name}.jsonl`),
			events.map((e) => JSON.stringify(e)).join("\n") + "\n",
		);
		if (previous.length)
			writeFileSync(
				join(out, `${name}.previous.jsonl`),
				previous.map((e) => JSON.stringify(e)).join("\n") + "\n",
			);
		writeFileSync(
			join(out, `${name}.summary.json`),
			JSON.stringify(
				{
					...summary,
					minutes,
					suite: "quick",
					windowOf: { run: job.run, minutes: summary.minutes },
					// The notes made within the window (as a quick run would list them); the memory and
					// the plans note are the full run's last state, not the window's.
					notes: (summary.notes ?? []).filter(
						(n) => n.at <= startMs(name) + minutes * 60_000,
					),
					finalState: "memory and profile: the full run's, at its end",
					usd: summary.usd * share,
					wallSec: Math.round((summary.wallSec ?? 0) * share),
					estimated:
						"usd and wallSec: the full run's, times the window's share of the agent's tokens (the reply's and the simulated user's calls are not in the events, so this is rough)",
					judge,
					judgeFull: summary.judge,
				},
				null,
				"\t",
			),
		);
	};
	const queue = [...jobs];
	await Promise.all(
		Array.from({ length: Math.min(8, queue.length) }, async () => {
			for (let j = queue.shift(); j; j = queue.shift()) await cutOne(j);
		}),
	);
	if (missing.length) console.log(`記録のないシナリオ: ${missing.join(" ")}`);
	console.log(
		`切り出した: ${jobs.length - missing.length}シナリオ、判定役 $${(meter.spentUsd() - spentBefore).toFixed(3)}。比較: bun eval/agenda/compare.ts ${runs.map((r) => `${r}-q`).join(",")} <quick run>`,
	);
}
