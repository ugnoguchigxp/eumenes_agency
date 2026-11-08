/**
 * Live check of the agenda agent in a mock Eumenes, on a virtual clock, with the configured
 * models (Haiku; spec 2026-11-08: effort low). Cost is recorded, never capped.
 *
 *   zsh -l scripts/api-entry.zsh eval/agenda/live.ts <run-name> [--web] [scenario...]
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runRespond, type LlmPort } from "../../src/index.ts";
import {
	createProviderLlm,
	createProviderReply,
} from "../../standalone/providers.ts";
import { loadSettings } from "../../standalone/settings.ts";
import { openUncappedMeter } from "../../standalone/always-on-host.ts";
import {
	agendaReplyMessages,
	dropRepeatedSentences,
} from "../../standalone/agenda-reply.ts";
import { claudeMemoryModel } from "../../standalone/agenda-memory.ts";
import { webNoteWriter } from "../../standalone/agenda-research.ts";
import { createMockDocStore } from "../../examples/virtual-eumenes/agenda/docs.ts";
import { openHostMemory } from "../../examples/virtual-eumenes/agenda/host-memory.ts";
import { createProfileNote } from "../../examples/virtual-eumenes/agenda/profile.ts";
import {
	createMockWebResearch,
	llmWriter,
} from "../../examples/virtual-eumenes/agenda/research.ts";
import { agendaScenarios } from "./scenarios.ts";
import { judgeAspects, judgeScenario } from "./judge.ts";
import { llmUser } from "./user.ts";
import { simulateAgenda, type AgendaSimEvent, type UserTurn } from "./sim.ts";

export const clockFrom = (start: string) => (now: number) =>
	new Date(Date.parse(start) + now).toLocaleString("ja-JP", {
		timeZone: "Asia/Tokyo",
		year: "numeric",
		month: "numeric",
		day: "numeric",
		weekday: "short",
		hour: "2-digit",
		minute: "2-digit",
	});

const show = (e: AgendaSimEvent) => {
	const t = `${Math.round(e.atSec)}s`.padStart(7);
	switch (e.type) {
		case "plan":
			return `${t} plan ${e.code}${e.changed ? "" : " (変化なし)"} ${(e.usage.latencyMs / 1000).toFixed(1)}s${e.added.map((a) => `\n          + ${a.kind}(${a.value}) ${a.text}`).join("")}${e.dropped.length ? `\n          - ${e.dropped.join(", ")}` : ""}${e.rejected.length ? `\n          ✗ ${e.rejected.join(", ")}` : ""}`;
		case "check":
			return e.verdict === "new"
				? null
				: `${t} 🔁 ${e.verdict}${e.coveredBy ? ` (${e.coveredBy})` : ""}: ${e.request ?? e.reason}`;
		case "compose":
			return e.declined ? `${t} compose 見送り: ${e.declined}` : null;
		case "speak":
			return `${t} 🗣 ${e.emotion ?? ""}${e.kind}: ${e.text}`;
		case "research":
			return `${t} 🔎 ${e.accepted ? "" : "(受付拒否) "}${e.requested ? "[頼まれた] " : ""}${e.text}`;
		case "researched":
			return `${t} 📝 ${e.status}: ${e.title ?? ""} — ${e.summary ?? ""}`;
		case "memory":
		case "profile":
			return e.applied.length
				? `${t} ${e.type === "memory" ? "🧠" : "🗓"} ${e.applied.join(" / ")}`
				: null;
		case "quiet":
			return `${t} 🤫 ${e.scope} ${e.minutes}分`;
		case "show":
		case "read":
			return `${t} 📄 ${e.type} ${e.noteId} ${e.title}`;
		case "asked":
			return `${t} 🙋 返事が調べものを頼んだ${e.queued ? "（順番待ち）" : ""}: ${e.text}`;
		case "reply":
			return `${t} reply ${e.emotion ?? ""}: ${e.text}`;
		case "felt":
			return `${t} 👤${e.on === "reply" ? "（返事の質問へ）" : ""} ${e.replied ? "" : "（返事せず）"}${e.feeling}`;
		default:
			return `${t} ${e.type}: ${e.text}`;
	}
};

if (import.meta.main) {
	const argv = process.argv.slice(2);
	// Web search: every scenario with --web, none with --mock-research, else the ones marked web.
	const allWeb = argv.includes("--web");
	const noWeb = argv.includes("--mock-research");
	const [name, ...wanted] = argv.filter((a) => !a.startsWith("--"));
	if (!name)
		throw new Error(
			"usage: live.ts <run-name> [--web | --mock-research] [scenario...]",
		);
	const settings = loadSettings(
		resolve(process.env.AGENCY_SETTINGS ?? "config/always-on.json"),
	);
	const dir = resolve("data/agenda/runs", name);
	mkdirSync(dir, { recursive: true });
	const meter = openUncappedMeter(settings, resolve("data/agenda/usage.jsonl"));
	const llm = createProviderLlm(settings.llm.background, meter);
	const chat = createProviderReply(settings.llm.main, meter);
	for (const s of agendaScenarios.filter(
		(x) => wanted.length === 0 || wanted.includes(x.name),
	)) {
		const spentBefore = meter.spentUsd();
		const clockAt = clockFrom(s.clockStart ?? "2026-11-07T19:00:00+09:00");
		// The real memory, one store per scenario (both sessions of a scenario share it).
		const memoryDir = mkdtempSync(join(tmpdir(), "agm-"));
		const memory = await openHostMemory({
			dir: memoryDir,
			complete: claudeMemoryModel({ role: settings.llm.background, meter }),
			clock: clockAt,
		});
		try {
			// The plans-and-interests note: what the memory leaves out, kept across both sessions.
			const note = createProfileNote({
				llm,
				known: memory.known,
				clock: clockAt,
			});
			const docs = createMockDocStore();
			const web = !noWeb && (allWeb || s.web === true);
			const searcher = web
				? webNoteWriter({
						role: settings.llm.background,
						meter,
						today: () => clockAt(0),
					})
				: null;
			let planted = false;
			const research = createMockWebResearch({
				writer: searcher?.writer ?? llmWriter(llm),
				docs,
				delayMs: web ? 0 : 120_000,
				...(s.inject
					? {
							tamper: (n) => {
								if (planted) return n;
								planted = true;
								return {
									...n,
									summary: n.summary + s.inject,
									markdown: n.markdown + s.inject,
								};
							},
						}
					: {}),
			});
			const steward = memory.steward;
			const events: AgendaSimEvent[] = [];
			const session = (
				minutes: number,
				turns: readonly UserTurn[],
				startMs: number,
				think: LlmPort,
			) =>
				simulateAgenda({
					deps: { llm: think, clock: clockAt, profile: note.get },
					minutes,
					turns,
					startMs,
					memory,
					steward,
					profile: note.writer,
					docs,
					research,
					reply: async (agent, at, tools) => {
						const r = await runRespond({
							messages: agendaReplyMessages({
								agent,
								known: memory.known(),
								notes: docs.list(),
								profile: note.get(),
								clock: clockAt(at),
								now: at,
							}),
							chat,
							tools,
							emotion: true,
							signal: new AbortController().signal,
							onDelta: () => undefined,
						});
						return {
							text: dropRepeatedSentences(r.text),
							calls: r.calls,
							emotion: r.emotion ?? null,
						};
					},
					onEvent: (e) => {
						events.push(e);
						const line = show(e);
						if (line) console.log(line);
					},
					user: llmUser(llm, s.persona),
				});
			console.log(`=== ${s.name}`);
			let startMs = 0;
			let previousEvents: AgendaSimEvent[] = [];
			if (s.previous) {
				console.log(`  (前の会話: ${s.previous.minutes}分)`);
				await session(s.previous.minutes, s.previous.turns, 0, llm);
				previousEvents = [...events];
				events.length = 0;
				startMs = (s.previous.minutes * 60 + s.previous.gapHours * 3600) * 1000;
				console.log(
					`  (${s.previous.gapHours}時間後。agent は新しく、記憶とメモは残る)`,
				);
			}
			const result = await session(s.minutes, s.turns, startMs, llm);
			// The judge reads the whole conversation; its scores are measurement, never the agent's.
			const judge = await judgeScenario(llm, {
				expect: s.expect,
				previous: previousEvents,
				events,
			}).catch((e: unknown) => ({
				error: e instanceof Error ? e.message : String(e),
			}));
			const summary = {
				scenario: s.name,
				expect: s.expect,
				minutes: s.minutes,
				memory: memory.all().map((m) => m.text),
				profile: note.get(),
				notes: docs.list().map((n) => ({
					id: n.id,
					title: n.title,
					summary: n.summary,
					at: n.at,
				})),
				agenda: result.agent
					.view()
					.items.map(
						(i) =>
							`${i.status} ${i.kind}(${i.value})${i.requested ? "[req]" : ""}: ${i.text}`,
					),
				usd: meter.spentUsd() - spentBefore,
				research: searcher ? `web (${searcher.searches()} searches)` : "mock",
				model: settings.llm.background.model,
				effort: settings.llm.background.effort,
				previous: s.previous ? { events: previousEvents.length } : null,
				judge,
			};
			writeFileSync(
				join(dir, `${s.name}.jsonl`),
				events.map((e) => JSON.stringify(e)).join("\n") + "\n",
			);
			if (s.previous)
				writeFileSync(
					join(dir, `${s.name}.previous.jsonl`),
					previousEvents.map((e) => JSON.stringify(e)).join("\n") + "\n",
				);
			writeFileSync(
				join(dir, `${s.name}.summary.json`),
				JSON.stringify(summary, null, "\t"),
			);
			const judged =
				"flow" in judge
					? `  judge ${judgeAspects.map((a) => `${a} ${judge[a].score}`).join(" ")} — ${judge.worst}`
					: "";
			console.log(
				`  $${summary.usd.toFixed(4)}  memory ${summary.memory.length}  notes ${summary.notes.length}${judged}`,
			);
		} finally {
			// A scenario that throws still closes its store and removes it (the user's words are in it).
			await memory.close();
			rmSync(memoryDir, { recursive: true, force: true });
		}
	}
}
