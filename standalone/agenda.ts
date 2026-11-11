/**
 * The agenda agent's conversation CLI (spec/always-on-agenda-design-2026-11-08.md) in a mock
 * Eumenes with the real memory: eumenes_memory (the vendored Memory host; its own planner writes
 * after each exchange), the researcher's notes (Markdown files) and the agent's snapshot (the
 * promises still open and the quiet, agenda-state.json) stay in data/agenda/; the agent's
 * working memory does not.
 * Cost is recorded in data/agenda/usage.jsonl and never capped.
 *
 *   zsh -l scripts/api-entry.zsh standalone/agenda.ts [--interval 10|60|300]
 *       [--no-plan] [--log PATH | --no-log]
 *       [--fresh] [--mock-research]
 *
 * Commands: /agenda /notes /show <id> /memory /profile /stop /resume /quit
 */
import { emitKeypressEvents, createInterface } from "node:readline";
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { runRespond } from "../src/index.ts";
import {
	createAgendaAgent,
	defaultSpeechIntervalSec,
	speechIntervals,
	type SpeechIntervalSec,
} from "../src/agenda/index.ts";
import {
	createAgendaSession,
	type AgendaSessionEvent,
} from "./agenda-session.ts";
import { agendaReplyMessages, dropRepeatedSentences } from "./agenda-reply.ts";
import { createAgendaReplySteering } from "./agenda-steer.ts";
import { createSteeringInbox } from "eumenes-steer";
import { memoryModel } from "./agenda-memory.ts";
import { codexWebNoteWriter, webNoteWriterFor } from "./agenda-research.ts";
import { createChatLog, chatsDir, printAbove } from "./chat-loop.ts";
import { createProviderLlm, createProviderReply } from "./providers.ts";
import { loadSettings, settingsDigest } from "./settings.ts";
import { openUncappedMeter } from "./always-on-host.ts";
import { createMockDocStore } from "../examples/virtual-eumenes/agenda/docs.ts";
import { openHostMemory } from "../examples/virtual-eumenes/agenda/host-memory.ts";
import { createProfileNote } from "../examples/virtual-eumenes/agenda/profile.ts";
import {
	createMockWebResearch,
	llmWriter,
	mockToolchainWork,
} from "../examples/virtual-eumenes/agenda/research.ts";
import { openSnapshotFile } from "../examples/virtual-eumenes/agenda/state-file.ts";

const dataDir = resolve(import.meta.dir, "../data/agenda");
/** The memory's store (its own SQLite, journal and socket); data/agenda/memory.json was the mock's. */
const memoryDir = resolve(dataDir, "memory-host");
const notesDir = resolve(dataDir, "notes");
/** The user's plans and interests (Markdown; the user may edit it while the CLI runs). */
const profilePath = resolve(dataDir, "profile.md");
/** What outlives a restart: research asked for or promised, results not told yet, the quiet. */
const statePath = resolve(dataDir, "agenda-state.json");

interface Args {
	readonly interval: SpeechIntervalSec;
	readonly showPlan: boolean;
	readonly log: string | null;
	readonly fresh: boolean;
	readonly mockResearch: boolean;
}

export function parseAgendaArgs(argv: readonly string[], now: Date): Args {
	let interval: SpeechIntervalSec = defaultSpeechIntervalSec;
	let showPlan = true;
	let fresh = false;
	let mockResearch = false;
	let log: string | null =
		`${chatsDir}/${now.toISOString().replace(/[:.]/g, "-")}-agenda.jsonl`;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		const value = () => {
			const v = argv[++i];
			if (v === undefined || v.startsWith("--"))
				throw new Error(`usage: ${arg} <value>`);
			return v;
		};
		if (arg === "--interval") {
			const n = Number(value());
			if (!speechIntervals.includes(n as SpeechIntervalSec))
				throw new Error("usage: --interval 10|60|300（秒）");
			interval = n as SpeechIntervalSec;
		} else if (arg === "--no-plan") showPlan = false;
		else if (arg === "--log") log = value();
		else if (arg === "--no-log") log = null;
		else if (arg === "--fresh") fresh = true;
		else if (arg === "--mock-research") mockResearch = true;
		else throw new Error(`unknown argument: ${arg}`);
	}
	return {
		interval,
		showPlan,
		log,
		fresh,
		mockResearch,
	};
}

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
/** Text from the web or a model reaches the terminal without its control characters. */
const clean = (s: string) =>
	[...s]
		.filter((c) => {
			const k = c.codePointAt(0)!;
			// Tab and newline stay; other C0 controls, DEL and CSI do not.
			return k === 9 || k === 10 || (k >= 32 && k !== 127 && k !== 0x9b);
		})
		.join("");
const localTime = (now: number) =>
	new Date(now).toLocaleString("ja-JP", {
		weekday: "short",
		year: "numeric",
		month: "numeric",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	});

async function main() {
	const args = parseAgendaArgs(process.argv.slice(2), new Date());
	// On gpt-6-luna while the Claude API is at its limit (until 2026-12-01); AGENCY_SETTINGS
	// picks another (config/always-on.json: Haiku).
	const settings = loadSettings(
		process.env.AGENCY_SETTINGS
			? undefined
			: resolve(import.meta.dir, "../config/agenda-luna.json"),
	);
	const meter = openUncappedMeter(settings, resolve(dataDir, "usage.jsonl"));
	const llm = createProviderLlm(settings.llm.background, meter);
	const chat = createProviderReply(settings.llm.main, meter);
	if (args.fresh) {
		rmSync(memoryDir, { recursive: true, force: true });
		rmSync(notesDir, { recursive: true, force: true });
		rmSync(profilePath, { force: true });
		rmSync(statePath, { force: true });
	}
	const stateFile = openSnapshotFile(statePath);
	const memory = await openHostMemory({
		dir: memoryDir,
		complete: memoryModel({ role: settings.llm.background, meter }),
		clock: localTime,
	});
	const docs = createMockDocStore({ dir: notesDir });
	// The standard search: the Codex SDK with Luna and Codex's own web search (user, 2026-11-11);
	// without a codex executable, the role's provider searches instead.
	const viaCodex = !args.mockResearch && Bun.which("codex") !== null;
	const searcher = args.mockResearch
		? null
		: viaCodex
			? codexWebNoteWriter({ today: () => localTime(Date.now()) })
			: webNoteWriterFor({
					role: settings.llm.background,
					meter,
					today: () => localTime(Date.now()),
				});
	// Work delegated to a toolchain goes to its mock (Eumenes runs the real toolchain).
	const researchWriter = searcher?.writer ?? llmWriter(llm);
	const research = createMockWebResearch({
		writer: (request, delegatedTo) =>
			delegatedTo
				? mockToolchainWork(request, delegatedTo)
				: researchWriter(request),
		docs,
		// The stand-in's note comes when it is written: no made-up wait on top.
		delayMs: 0,
	});
	const steward = memory.steward;
	const note = createProfileNote({
		llm,
		known: memory.known,
		clock: localTime,
		path: profilePath,
	});
	const agent = createAgendaAgent({
		llm,
		speechIntervalSec: args.interval,
		clock: localTime,
		startedAt: Date.now(),
		known: memory.known,
		notes: docs.list,
		profile: note.get,
		...(stateFile.loaded ? { restore: stateFile.loaded } : {}),
	});
	const restored = agent.view().items;
	// Written after anything happened (a step, a reply, a result), once the host has handled it.
	const saveState = () => {
		try {
			stateFile.save(agent.snapshot(Date.now()));
		} catch (e) {
			console.warn(
				`[warn] agenda state write failed: ${e instanceof Error ? e.message : String(e)}`,
			);
		}
	};
	let saveQueued = false;
	const saveSoon = () => {
		if (saveQueued) return;
		saveQueued = true;
		setTimeout(() => {
			saveQueued = false;
			saveState();
		}, 0);
	};
	const log = createChatLog(args.log, Date.now, (m) =>
		console.warn(`[warn] log write failed: ${m}`),
	);
	log.write({
		type: "session",
		mode: "agenda",
		interval: args.interval,
		settingsDigest: settingsDigest(settings),
		backgroundModel: settings.llm.background.model,
		mainModel: settings.llm.main.model,
	});

	let showPlan = args.showPlan;
	let closed = false;
	const sessionStart = meter.spentUsd();
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	rl.setPrompt("> ");
	// Everything shown goes through clean(): only this CLI's own dim codes reach the terminal.
	const out = (text: string) => {
		if (closed) return;
		const marked = text
			.replaceAll("\x1b[2m", "\ue000")
			.replaceAll("\x1b[0m", "\ue001");
		printAbove(
			rl,
			process.stdout,
			clean(marked)
				.replaceAll("\ue000", "\x1b[2m")
				.replaceAll("\ue001", "\x1b[0m"),
		);
	};

	const show = (e: AgendaSessionEvent) => {
		switch (e.type) {
			case "user":
				log.write({ type: "user", text: e.text });
				return;
			case "reply":
				log.write({
					type: "reply",
					text: e.text,
					emotion: e.emotion,
					latencyMs: e.latencyMs,
					...(e.calls.length ? { calls: e.calls } : {}),
				});
				return out(`${e.emotion ? `${e.emotion} ` : ""}${e.text}`);
			case "step": {
				const o = e.outcome;
				if (o.plan) {
					const p = o.plan;
					log.write({
						type: "plan",
						added: p.added.map((a) => ({
							kind: a.kind,
							text: a.text,
							value: a.value,
						})),
						dropped: p.dropped,
						rejected: p.rejected,
						reasons: p.reasons,
						code: p.call.code,
						changed: p.call.changed,
						latencyMs: p.call.latencyMs,
					});
					if (showPlan && (p.added.length || p.dropped.length))
						out(
							dim(
								[
									...p.added.map(
										(a) => `  💭 + ${a.kind}: ${a.text}（${a.reason}）`,
									),
									...p.dropped.map((d) => `  💭 - ${d}`),
								].join("\n"),
							),
						);
					if (p.call.code === "failed") out(dim("  [計画エラー]"));
				}
				if (o.check && o.check.call.model !== "") {
					log.write({
						type: "check",
						itemId: o.check.itemId,
						verdict: o.check.verdict,
						coveredBy: o.check.coveredBy,
						request: o.check.request,
						reason: o.check.reason,
						latencyMs: o.check.call.latencyMs,
					});
					if (showPlan && o.check.verdict !== "new")
						out(
							dim(
								`  💭 重複チェック ${o.check.verdict}${o.check.coveredBy ? `（${o.check.coveredBy} と同じ）` : ""}: ${o.check.request ?? o.check.reason}`,
							),
						);
				}
				for (const r of o.repeats) {
					log.write({
						type: "ask_repeat",
						itemId: r.itemId,
						text: r.text,
						verdict: r.verdict,
						reason: r.reason,
					});
					if (showPlan)
						out(
							dim(
								`  💭 聞かない（${r.verdict === "asked" ? "もう聞いた" : "もう答えがある"}）: ${r.text} — ${r.reason}`,
							),
						);
				}
				if (o.compose) {
					log.write({
						type: "compose",
						itemId: o.compose.itemId,
						declined: o.compose.declined,
						code: o.compose.call.code,
						latencyMs: o.compose.call.latencyMs,
					});
					if (showPlan && o.compose.declined)
						out(dim(`  💭 見送り: ${o.compose.declined}`));
				}
				return;
			}
			case "speak":
				log.write({
					type: "speak",
					kind: e.kind,
					text: e.text,
					emotion: e.emotion,
				});
				return out(`\n[自分から] ${e.emotion ? `${e.emotion} ` : ""}${e.text}`);
			case "research":
				log.write({
					type: "research",
					text: e.text,
					requested: e.requested,
					accepted: e.accepted,
					...(e.delegatedTo ? { delegatedTo: e.delegatedTo } : {}),
				});
				return out(
					dim(
						`  ${e.delegatedTo ? `🛠 ${e.delegatedTo}:` : "🔎"} ${e.requested ? "[頼まれた] " : ""}${e.text}${e.accepted ? "" : "（受付拒否）"}`,
					),
				);
			case "researched":
				log.write({
					type: "researched",
					status: e.status,
					title: e.title,
					summary: e.summary,
				});
				return out(dim(`  📝 ${e.title ?? e.status}: ${e.summary ?? ""}`));
			case "memory":
			case "profile": {
				log.write({ type: e.type, applied: e.applied, rejected: e.rejected });
				if (!showPlan) return undefined;
				const mark = e.type === "memory" ? "🧠" : "🗓";
				return out(
					dim(
						[
							e.applied.length ? `  ${mark} ${e.applied.join(" / ")}` : null,
							e.rejected.length
								? `  ${mark} 見送り: ${e.rejected.join(" / ")}`
								: null,
						]
							.filter((x) => x !== null)
							.join("\n"),
					),
				);
			}
			case "quiet":
				log.write({ type: "quiet", scope: e.scope, minutes: e.minutes });
				return out(
					dim(
						e.minutes === 0
							? "  🤫 解除"
							: `  🤫 ${e.minutes}分、${e.scope === "all" ? "調べもの・話しかけ・計画を止めます" : "自分から話しかけません（調べものは続けます）"}`,
					),
				);
			case "show":
				log.write({ type: "show", id: e.id });
				return out(`\n──── ${e.title}（${e.id}）\n${e.markdown}\n────`);
			case "error":
				log.write({ type: "error", where: e.where, message: e.message });
				return out(dim(`  [${e.where}エラー] ${e.message}`));
		}
	};

	const session = createAgendaSession({
		agent,
		steward,
		profile: note.writer,
		docs,
		research,
		now: Date.now,
		setTimer: (fn, ms) => {
			const h = setTimeout(fn, ms);
			h.unref?.();
			return h;
		},
		clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
		emit: (e) => {
			show(e);
			saveSoon();
		},
		// Words sent while the reply is written go into its next model call (eumenes-steer). The
		// CLI shows the reply when it is done, so words that come during its last call are taken
		// by one more call (holdsText).
		steering: createAgendaReplySteering({
			inbox: createSteeringInbox({ now: Date.now }),
			read: (id) =>
				agent.view().said.find((x) => x.id === id && x.who === "user")?.text ??
				null,
			now: Date.now,
			holdsText: true,
		}),
		reply: async (a, tools, steer) => {
			const r = await runRespond({
				messages: agendaReplyMessages({
					agent: a,
					known: memory.known(),
					notes: docs.list(),
					profile: note.get(),
					clock: localTime(Date.now()),
					now: Date.now(),
				}),
				chat: steer(chat),
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
	});

	const command = (line: string): boolean => {
		const [cmd, ...rest] = line.split(/\s+/);
		if (cmd === "/quit") return false;
		if (cmd === "/plan") {
			showPlan = !showPlan;
			out(dim(`  plan ${showPlan ? "on" : "off"}`));
		} else if (cmd === "/agenda") {
			const v = agent.view();
			out(
				dim(
					[
						`researching: ${v.researching?.text ?? "なし"} / unanswered ${v.unanswered} / spend $${(meter.spentUsd() - sessionStart).toFixed(4)}${searcher ? ` + web search ${searcher.searches()} 回` : ""}`,
						...v.items
							.filter((i) => i.status === "open" || i.status === "doing")
							.map(
								(i) =>
									`  ${i.id} ${i.status} ${i.kind}(${i.value})${i.requested ? "[頼まれた]" : ""} ${i.text}`,
							),
					].join("\n"),
				),
			);
		} else if (cmd === "/notes") {
			const notes = docs.list();
			out(
				dim(
					notes.length
						? notes.map((n) => `  ${n.id} ${n.title} — ${n.summary}`).join("\n")
						: "  メモはまだありません",
				),
			);
		} else if (cmd === "/show") {
			const d = docs.read(rest[0] ?? "");
			out(
				d
					? `\n──── ${d.title}（${d.id}）\n${d.markdown}\n────`
					: dim("  usage: /show <id>（/notes で一覧）"),
			);
		} else if (cmd === "/memory") {
			const items = memory.known();
			out(
				dim(
					items.length
						? items.map((m) => `  ${m.id} ${m.text}`).join("\n")
						: "  記憶はまだありません",
				),
			);
		} else if (cmd === "/profile") {
			const text = note.get().trim();
			out(
				text
					? `\n──── 予定と関心（${profilePath}）\n${text}\n────`
					: dim("  予定と関心のメモはまだありません"),
			);
		} else if (cmd === "/stop") {
			session.stop();
			out(dim("  停止しました（/resume で再開）"));
		} else if (cmd === "/resume") {
			session.resume();
			out(dim("  再開しました"));
		} else out(dim(`  unknown command: ${cmd}`));
		return true;
	};

	console.log(
		dim(
			`agenda / 調べもの: ${searcher ? (viaCodex ? "Web検索（codex-sdk・Luna）" : "Web検索") : "mock"} / 記憶 ${memory.known().length}件・メモ ${docs.list().length}件 / 話しかけの最短間隔 ${args.interval}秒 / background ${settings.llm.background.model} (${settings.llm.background.effort}) / log ${args.log ?? "off"}\ncommands: /agenda /notes /show <id> /memory /profile /plan /stop /resume /quit`,
		),
	);
	if (restored.length)
		console.log(
			dim(
				`前回から引き継ぎ: 調べもの ${restored.filter((i) => i.kind === "research").length}件・まだ伝えていないこと ${restored.filter((i) => i.kind === "talk").length}件`,
			),
		);
	if (stateFile.problem)
		console.log(
			dim(
				`[warn] ${statePath} が読めないので ${statePath}.bad に退避し、引き継がずに始めます: ${stateFile.problem}`,
			),
		);
	emitKeypressEvents(process.stdin, rl);
	process.stdin.on(
		"keypress",
		(_s: string, key: { name?: string } | undefined) => {
			if (key?.name !== "return" && key?.name !== "enter") session.typed();
		},
	);
	let queue: Promise<unknown> = Promise.resolve();
	const failed = (e: unknown) =>
		out(dim(`  [エラー] ${e instanceof Error ? e.message : String(e)}`));
	rl.on("line", (raw) => {
		const line = raw.trim();
		if (line === "") {
			rl.prompt(true);
			return;
		}
		// Words go to the session at once: while a reply is written, its next model call takes
		// them (steer). The host waits for the replies out when it closes.
		if (!line.startsWith("/")) {
			queue = session
				.say(line)
				.then(() => rl.prompt(true))
				.catch(failed);
			return;
		}
		try {
			// /quit waits for the reply out, so it is shown and kept.
			if (!command(line)) void queue.finally(() => rl.close());
			else rl.prompt(true);
		} catch (e) {
			failed(e);
		}
	});
	rl.on("close", () => {
		closed = true;
		session.close();
		saveState();
		// The exchange in progress (reply, memory, note) finishes first, though not for ever; then
		// the store's owner closes its socket and database before the process ends. The spend is
		// told after it, so the writing behind the last exchange is in it.
		void Promise.race([
			// A failed write is reported where it happens; the state is saved and the end logged
			// either way (review 2026-11-10).
			queue.then(() => session.flush()).catch(() => undefined),
			new Promise((done) => setTimeout(done, 15_000).unref?.()),
		])
			.then(() => {
				// The exchange that finished meanwhile may have asked for research.
				saveState();
				log.write({ type: "end", spentUsd: meter.spentUsd() - sessionStart });
				console.log(
					dim(
						`\nspend this session $${(meter.spentUsd() - sessionStart).toFixed(4)}`,
					),
				);
				return memory.close();
			})
			.finally(() => process.exit(0));
	});
	rl.prompt();
	session.start();
}

if (import.meta.main) await main();
