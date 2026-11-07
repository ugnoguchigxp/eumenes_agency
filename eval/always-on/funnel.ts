/**
 * Stage 0/4 of spec/always-on-agency-design-2026-11-07.md: where did the agent's own activity
 * stop in real CLI sessions? Reads standalone CLI JSONL logs (legacy and always-on) and counts
 * events only; no utterance text is printed.
 *
 *   bun eval/always-on/funnel.ts data/chats/*.jsonl
 */
import { readFileSync } from "node:fs";

export interface Funnel {
	sessions: number;
	userTurns: number;
	/** Minutes from each session's first to last event, summed. */
	minutes: number;
	/** Legacy background decisions by action and source (e.g. `wait/llm`). */
	decisions: Record<string, number>;
	/** Automatic utterances that reached the user (legacy `proactive`, always-on `speak`). */
	ownUtterances: number;
	/** Legacy idle cycles by why the next one was blocked (`-` = still planned). */
	idleBlocked: Record<string, number>;
	/** always-on ticks by action. */
	ticks: Record<string, number>;
	/** always-on autonomous preparations started. */
	prepares: number;
}

const bump = (m: Record<string, number>, key: string) => {
	m[key] = (m[key] ?? 0) + 1;
};

export function funnel(logs: readonly string[]): Funnel {
	const f: Funnel = {
		sessions: 0,
		userTurns: 0,
		minutes: 0,
		decisions: {},
		ownUtterances: 0,
		idleBlocked: {},
		ticks: {},
		prepares: 0,
	};
	for (const text of logs) {
		let first: number | null = null;
		let last: number | null = null;
		for (const line of text.split("\n")) {
			if (line.trim() === "") continue;
			const e = JSON.parse(line) as Record<string, unknown>;
			const at = typeof e["at"] === "number" ? e["at"] : null;
			if (at !== null) {
				first ??= at;
				last = at;
			}
			switch (e["type"]) {
				case "session":
					f.sessions++;
					break;
				case "user":
					f.userTurns++;
					break;
				case "decision":
					bump(f.decisions, `${String(e["action"])}/${String(e["source"])}`);
					break;
				case "proactive":
					f.ownUtterances++;
					break;
				case "idle_cycle":
					bump(f.idleBlocked, String(e["blockedBy"] ?? "-"));
					break;
				case "tick":
					bump(f.ticks, String(e["action"] ?? "none"));
					if (e["action"] === "speak" || e["action"] === "ask")
						f.ownUtterances++;
					if (e["action"] === "prepare") f.prepares++;
					break;
			}
		}
		if (first !== null && last !== null) f.minutes += (last - first) / 60_000;
	}
	f.minutes = Math.round(f.minutes * 10) / 10;
	return f;
}

if (import.meta.main) {
	const paths = process.argv.slice(2);
	if (paths.length === 0) throw new Error("usage: funnel.ts <log.jsonl>...");
	console.log(
		JSON.stringify(
			funnel(paths.map((p) => readFileSync(p, "utf8"))),
			null,
			"\t",
		),
	);
}
