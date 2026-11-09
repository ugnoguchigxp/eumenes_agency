/**
 * Judge stored runs again with the current judge, without simulating again: the events are read
 * back and the judge's scores go to a new run dir `<run>-j2` (the original is kept). Used when the
 * judge itself changes, so that a baseline and a change are scored the same way. Cost is recorded.
 *
 *   zsh -l scripts/api-entry.zsh eval/agenda/rejudge.ts <run> [<run>...]
 */
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { createClaudeClient } from "../../standalone/claude.ts";
import { openUncappedMeter } from "../../standalone/always-on-host.ts";
import { createProviderLlm } from "../../standalone/providers.ts";
import { loadSettings } from "../../standalone/settings.ts";
import { judgeScenario } from "./judge.ts";
import { clockFrom } from "./live.ts";
import { agendaScenarios } from "./scenarios.ts";
import type { AgendaSimEvent } from "./sim.ts";

const load = (f: string): AgendaSimEvent[] =>
	existsSync(f)
		? readFileSync(f, "utf8")
				.split("\n")
				.filter(Boolean)
				.map((l) => JSON.parse(l) as AgendaSimEvent)
		: [];

if (import.meta.main) {
	const runs = process.argv.slice(2);
	if (runs.length === 0) throw new Error("usage: rejudge.ts <run> [<run>...]");
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
		const out = `${dir}-j2`;
		mkdirSync(out, { recursive: true });
		for (const f of readdirSync(dir).filter((x) => x.endsWith(".jsonl")))
			copyFileSync(join(dir, f), join(out, f));
		return readdirSync(dir)
			.filter((f) => f.endsWith(".summary.json"))
			.map((f) => ({ dir, out, f }));
	});
	const judgeOne = async ({ dir, out, f }: (typeof jobs)[number]) => {
		const summary = JSON.parse(readFileSync(join(dir, f), "utf8")) as {
			scenario: string;
			expect: string;
			judge?: unknown;
		};
		const s = agendaScenarios.find((x) => x.name === summary.scenario);
		if (!s) throw new Error(`no scenario: ${summary.scenario}`);
		const clockAt = clockFrom(s.clockStart ?? "2026-11-07T19:00:00+09:00");
		const startMs = s.previous
			? (s.previous.minutes * 60 + s.previous.gapHours * 3600) * 1000
			: 0;
		const name = f.replace(".summary.json", "");
		const judge = await judgeScenario(llm, {
			expect: summary.expect,
			previous: load(join(dir, `${name}.previous.jsonl`)),
			events: load(join(dir, `${name}.jsonl`)),
			clock: {
				previous: (sec) => clockAt(sec * 1000),
				current: (sec) => clockAt(startMs + sec * 1000),
			},
		}).catch((e: unknown) => ({
			error: e instanceof Error ? e.message : String(e),
		}));
		writeFileSync(
			join(out, f),
			JSON.stringify(
				{ ...summary, judge, judgeBefore: summary.judge },
				null,
				2,
			),
		);
	};
	// A few at a time, within the API's rate limit.
	const queue = [...jobs];
	await Promise.all(
		Array.from({ length: Math.min(8, queue.length) }, async () => {
			for (let j = queue.shift(); j; j = queue.shift()) await judgeOne(j);
		}),
	);
	console.log(
		`判定し直した: ${jobs.length}シナリオ、$${(meter.spentUsd() - spentBefore).toFixed(3)}。比較: bun eval/agenda/compare.ts ${runs.map((r) => `${r}-j2`).join(",")}`,
	);
}
