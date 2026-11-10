/**
 * Live check of the agenda agent in a mock Eumenes, on a virtual clock, with the configured
 * models (Haiku; spec 2026-11-08: effort low). Scenarios run side by side (12 at once; `--jobs N`
 * to change it); `--samples N` takes N samples at once (run dirs <name>-1..N). Cost is recorded,
 * never capped.
 *
 *   zsh -l scripts/api-entry.zsh eval/agenda/live.ts <run-name> [--web | --mock-research]
 *       [--jobs N] [--samples N] [scenario...]
 *   bun eval/agenda/compare.ts <runs of A> <runs of B>   (comma-separated runs per group)
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
import { createClaudeClient } from "../../standalone/claude.ts";
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
	mockToolchainWork,
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
		case "repeat":
			return `${t} ↩ 聞かない（${e.verdict === "asked" ? "もう聞いた" : "もう答えがある"}）: ${e.text}`;
		case "reply_ask":
			return null;
		default:
			return `${t} ${e.type}: ${e.text}`;
	}
};

if (import.meta.main) {
	const argv = process.argv.slice(2);
	const flag = (name: string) => {
		const i = argv.indexOf(name);
		return i >= 0 ? argv[i + 1] : undefined;
	};
	// Web search: every scenario with --web, none with --mock-research, else the ones marked web.
	const allWeb = argv.includes("--web");
	const noWeb = argv.includes("--mock-research");
	const count = (name: string, fallback: number) => {
		const n = Number(flag(name) ?? fallback);
		if (!Number.isInteger(n) || n < 1)
			throw new Error(`${name} needs a whole number of at least 1`);
		return n;
	};
	// Samples of every scenario, run side by side (run dirs <name>-1, <name>-2...).
	const samples = count("--samples", 1);
	const valued = new Set([flag("--jobs"), flag("--samples")]);
	const [name, ...wanted] = argv.filter(
		(a, i) =>
			!a.startsWith("--") && !(valued.has(a) && argv[i - 1]?.startsWith("--")),
	);
	if (!name)
		throw new Error(
			"usage: live.ts <run-name> [--web | --mock-research] [--jobs N] [--samples N] [scenario...]",
		);
	const settings = loadSettings(
		resolve(process.env.AGENCY_SETTINGS ?? "config/always-on.json"),
	);
	const runDirs = Array.from({ length: samples }, (_, k) =>
		resolve("data/agenda/runs", samples > 1 ? `${name}-${k + 1}` : name),
	);
	for (const d of runDirs) mkdirSync(d, { recursive: true });
	const selected = agendaScenarios.filter(
		(x) => wanted.length === 0 || wanted.includes(x.name),
	);
	const queue = runDirs.flatMap((d, k) =>
		selected.map((s) => ({
			s,
			dir: d,
			label: samples > 1 ? `${s.name}#${k + 1}` : s.name,
		})),
	);
	// Side by side (12 at once by default, within the API's rate limit): a run takes about as
	// long as its slowest scenario.
	const jobs = count("--jobs", 12);
	const failed: string[] = [];
	const walls: { label: string; sec: number }[] = [];

	const runScenario = async (job: (typeof queue)[number]) => {
		const { s, dir } = job;
		const startedWall = performance.now();
		// A meter per scenario, so each one's cost is its own when scenarios run side by side.
		const meter = openUncappedMeter(
			settings,
			resolve("data/agenda/usage.jsonl"),
		);
		// Many scenarios at once meet the API's rate limit: a check waits and tries again
		// (the SDK honours retry-after) instead of failing the scenario.
		const client = createClaudeClient({ maxRetries: 8, timeout: 120_000 });
		const llm = createProviderLlm(settings.llm.background, meter, client);
		const chat = createProviderReply(settings.llm.main, meter, client);
		const say = (line: string) =>
			console.log(jobs > 1 ? line.replace(/^/gmu, `[${job.label}] `) : line);
		const spentBefore = meter.spentUsd();
		const clockAt = clockFrom(s.clockStart ?? "2026-11-07T19:00:00+09:00");
		// The real memory, one store per scenario (both sessions of a scenario share it).
		const memoryDir = mkdtempSync(join(tmpdir(), "agm-"));
		const memory = await openHostMemory({
			dir: memoryDir,
			complete: claudeMemoryModel({
				role: settings.llm.background,
				meter,
				client,
			}),
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
						client,
					})
				: null;
			let planted = false;
			const researchWriter = searcher?.writer ?? llmWriter(llm);
			const research = createMockWebResearch({
				// Work delegated to a toolchain goes to its mock, as in the CLI (Eumenes runs the real
				// one); only research is written by the researcher's stand-in.
				writer: (request, delegatedTo) =>
					delegatedTo
						? mockToolchainWork(request, delegatedTo)
						: researchWriter(request),
				docs,
				// A research takes minutes, web or not: it runs beside the agent and the virtual clock
				// does not wait for the real search, so without this a note would be ready at once.
				delayMs: 120_000,
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
						if (line) say(line);
					},
					user: llmUser(llm, s.persona),
				});
			say(`=== ${s.name}`);
			let startMs = 0;
			let previousEvents: AgendaSimEvent[] = [];
			if (s.previous) {
				say(`  (前の会話: ${s.previous.minutes}分)`);
				await session(s.previous.minutes, s.previous.turns, 0, llm);
				previousEvents = [...events];
				events.length = 0;
				startMs = (s.previous.minutes * 60 + s.previous.gapHours * 3600) * 1000;
				say(
					`  (${s.previous.gapHours}時間後。agent は新しく、記憶とメモは残る)`,
				);
			}
			const result = await session(s.minutes, s.turns, startMs, llm);
			// The judge reads the whole conversation; its scores are measurement, never the agent's.
			const judge = await judgeScenario(llm, {
				expect: s.expect,
				previous: previousEvents,
				events,
				clock: {
					previous: (sec) => clockAt(sec * 1000),
					current: (sec) => clockAt(startMs + sec * 1000),
				},
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
				wallSec: Math.round((performance.now() - startedWall) / 1000),
				judge,
			};
			walls.push({ label: job.label, sec: summary.wallSec });
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
			say(
				`  $${summary.usd.toFixed(4)}  memory ${summary.memory.length}  notes ${summary.notes.length}${judged}`,
			);
		} finally {
			// A scenario that throws still closes its store and removes it (the user's words are in it).
			await memory.close();
			rmSync(memoryDir, { recursive: true, force: true });
		}
	};

	const started = performance.now();
	await Promise.all(
		Array.from({ length: Math.min(jobs, queue.length) }, async () => {
			for (let j = queue.shift(); j; j = queue.shift())
				// One scenario that fails does not stop the others; it is reported at the end.
				await runScenario(j).catch((e: unknown) => {
					failed.push(j.label);
					console.error(
						`[${j.label}] 失敗: ${e instanceof Error ? e.message : String(e)}`,
					);
				});
		}),
	);
	const slow = [...walls].sort((a, b) => b.sec - a.sec).slice(0, 3);
	if (failed.length) console.log(`\n失敗したシナリオ: ${failed.join(" ")}`);
	console.log(
		`\n実時間 ${Math.round((performance.now() - started) / 1000)}秒（遅い順: ${slow.map((w) => `${w.label} ${w.sec}秒`).join("、")}）。比較: bun eval/agenda/compare.ts ${runDirs.map((d) => d.split("/").at(-1)).join(",")}`,
	);
}
