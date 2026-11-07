/**
 * Always-on conversation CLI (spec/always-on-agency-design-2026-11-07.md). The agent keeps
 * thinking on a heartbeat and may speak on its own; typing pauses it. Cost is recorded in
 * data/always-on/usage.jsonl and never capped.
 *
 *   zsh -l scripts/api-entry.zsh standalone/always-on.ts [--interval 10|60|600]
 *       [--interest TEXT]... [--no-interest] [--no-thoughts] [--log PATH | --no-log]
 *
 * Commands: /thoughts /tick /quiet [min] /stop /resume /state
 *           /feedback useful|intrusive|missed [note] /quit
 */
import { emitKeypressEvents, createInterface } from "node:readline";
import {
	createAlwaysOnAgent,
	createHeartbeat,
	createHeartbeatScheduler,
	defaultHeartbeat,
	runRespond,
	speechIntervals,
	type SpeechIntervalSec,
	type TickOutcome,
} from "../src/index.ts";
import { createChatLog, chatsDir, printAbove } from "./chat-loop.ts";
import { createProviderLlm, createProviderReply } from "./providers.ts";
import { loadSettings, settingsDigest } from "./settings.ts";
import { defaultInterestText, toStandingInterests } from "./persona.ts";
import { noTools, openUncappedMeter, replyMessages } from "./always-on-host.ts";
import {
	createMockPreparer,
	llmSubagent,
} from "../examples/virtual-eumenes/always-on-mock.ts";

export interface AlwaysOnArgs {
	readonly interval: SpeechIntervalSec;
	readonly interests: readonly string[];
	readonly thoughts: boolean;
	readonly log: string | null;
}

export function parseAlwaysOnArgs(
	argv: readonly string[],
	now: Date,
): AlwaysOnArgs {
	let interval: SpeechIntervalSec = 10;
	const interests: string[] = [];
	let noInterest = false;
	let thoughts = true;
	let log: string | null =
		`${chatsDir}/${now.toISOString().replace(/[:.]/g, "-")}-always-on.jsonl`;
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
				throw new Error("usage: --interval 10|60|600");
			interval = n as SpeechIntervalSec;
		} else if (arg === "--interest") interests.push(value());
		else if (arg === "--no-interest") noInterest = true;
		else if (arg === "--no-thoughts") thoughts = false;
		else if (arg === "--log") log = value();
		else if (arg === "--no-log") log = null;
		else throw new Error(`unknown argument: ${arg}`);
	}
	return {
		interval,
		interests: noInterest
			? []
			: interests.length
				? interests
				: [defaultInterestText],
		thoughts,
		log,
	};
}

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const TYPING_IDLE_MS = 4_000;

async function main() {
	const args = parseAlwaysOnArgs(process.argv.slice(2), new Date());
	const settings = loadSettings();
	const meter = openUncappedMeter(settings);
	const llm = createProviderLlm(settings.llm.background, meter);
	const chat = createProviderReply(settings.llm.main, meter);
	const interests = toStandingInterests(args.interests);
	// Preparation runs on the examples mock: no real search or service is used.
	const preparer = createMockPreparer({
		subagent: llmSubagent(llm),
		delayMs: 60_000,
	});
	const agent = createAlwaysOnAgent({
		llm,
		interests,
		tools: preparer.tools,
		speechIntervalSec: args.interval,
		clock: (now) =>
			new Date(now).toLocaleString("ja-JP", {
				weekday: "short",
				month: "numeric",
				day: "numeric",
				hour: "2-digit",
				minute: "2-digit",
			}),
	});
	const log = createChatLog(args.log, Date.now, (m) =>
		console.warn(`[warn] log write failed: ${m}`),
	);
	log.write({
		type: "session",
		mode: "always-on",
		interval: args.interval,
		interests,
		settingsDigest: settingsDigest(settings),
		backgroundModel: settings.llm.background.model,
		mainModel: settings.llm.main.model,
	});

	let showThoughts = args.thoughts;
	let closed = false;
	let n = 0;
	const sessionStart = meter.spentUsd();
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	rl.setPrompt("> ");
	const out = (text: string) => {
		if (!closed) printAbove(rl, process.stdout, text);
	};
	const heartbeat = createHeartbeat(defaultHeartbeat, Date.now());
	heartbeat.event(Date.now());

	// Typing pauses the heartbeat: the agent never talks over the user.
	let typing: ReturnType<typeof setTimeout> | null = null;
	const typingDone = () => {
		if (typing === null) return;
		clearTimeout(typing);
		typing = null;
		heartbeat.leave(Date.now());
		scheduler.rearm();
	};
	const typed = () => {
		if (typing === null) {
			heartbeat.enter();
			scheduler.rearm();
		} else clearTimeout(typing);
		typing = setTimeout(typingDone, TYPING_IDLE_MS);
	};
	let replying = false;
	const busy = () => ({ busy: typing !== null || replying });

	const showTick = (o: TickOutcome) => {
		log.write({
			type: "tick",
			action: o.skipped ? "skipped" : o.ticket ? "speak" : "wait",
			chosen: o.chosen,
			skipped: o.skipped,
			drive: o.thought?.drive ?? null,
			thought: o.thought?.text ?? null,
			text: o.ticket?.utterance ?? null,
			rejected: o.rejected,
			next: o.next,
			latencyMs: o.call?.latencyMs ?? null,
			inputTokens: o.call?.inputTokens ?? 0,
			outputTokens: o.call?.outputTokens ?? 0,
		});
		if (o.call && o.skipped === "failed")
			out(dim(`  [思考エラー] ${o.call.code}`));
		if (showThoughts && o.thought)
			out(
				dim(
					`  💭 [${o.thought.drive}] ${o.thought.text}${o.rejected.length ? ` (${o.rejected.join(",")})` : ""}`,
				),
			);
	};

	let inFlight: AbortController | null = null;
	const scheduler = createHeartbeatScheduler({
		heartbeat,
		now: Date.now,
		setTimer: (fn, ms) => {
			const h = setTimeout(fn, ms);
			h.unref?.();
			return h;
		},
		clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
		run: async () => {
			if (closed) return null;
			inFlight = new AbortController();
			try {
				const o = await agent.tick(Date.now(), busy, inFlight.signal);
				showTick(o);
				if (o.ticket?.action === "prepare" && !closed) {
					const ticket = o.ticket;
					const accepted = preparer.start(ticket, Date.now());
					agent.recordResult({
						ticketId: ticket.id,
						status: accepted ? "succeeded" : "failed",
						at: Date.now(),
					});
					log.write({
						type: "prepare",
						toolName: ticket.toolName,
						toolInput: ticket.toolInput,
						accepted,
					});
					out(dim(`  [準備] ${ticket.toolName}: ${ticket.toolInput}`));
					const done = setTimeout(async () => {
						for (const r of await preparer.due(Date.now())) {
							agent.workReturned(r);
							log.write({
								type: "prepared",
								status: r.status,
								text: r.summary,
							});
							out(dim(`  [準備完了] ${r.summary}`));
						}
						heartbeat.event(Date.now());
						scheduler.rearm();
					}, 60_000);
					done.unref?.();
				} else if (o.ticket && !closed) {
					out(`\n[自分から] ${o.ticket.utterance}`);
					agent.recordResult({
						ticketId: o.ticket.id,
						status: "succeeded",
						at: Date.now(),
					});
					log.write({ type: "speak", text: o.ticket.utterance });
				}
				return o.skipped ? null : { next: o.next, wakeAt: o.wakeAt };
			} catch (e) {
				out(
					dim(`  [思考エラー] ${e instanceof Error ? e.message : String(e)}`),
				);
				return null;
			} finally {
				inFlight = null;
			}
		},
	});

	const reply = async (text: string) => {
		n++;
		agent.invalidate();
		agent.observe({
			id: `u${n}`,
			kind: "exchange.adopted",
			actor: "user",
			occurredAt: Date.now(),
			text,
		});
		log.write({ type: "user", text });
		replying = true;
		heartbeat.enter();
		const started = performance.now();
		try {
			const r = await runRespond({
				messages: replyMessages(agent, interests),
				chat,
				tools: noTools,
				emotion: false,
				signal: new AbortController().signal,
				onDelta: () => undefined,
			});
			if (r.text === "") return out(dim("  (返答なし)"));
			agent.observe({
				id: `r${n}`,
				kind: "exchange.adopted",
				actor: "agent",
				occurredAt: Date.now(),
				text: r.text,
			});
			log.write({
				type: "reply",
				text: r.text,
				latencyMs: performance.now() - started,
			});
			out(r.text);
		} catch (e) {
			out(dim(`  [返答エラー] ${e instanceof Error ? e.message : String(e)}`));
		} finally {
			replying = false;
			heartbeat.leave(Date.now());
			heartbeat.event(Date.now());
			scheduler.rearm();
		}
	};

	const command = async (line: string): Promise<boolean> => {
		const [cmd, ...rest] = line.split(/\s+/);
		if (cmd === "/quit") return false;
		if (cmd === "/thoughts") {
			showThoughts = !showThoughts;
			out(dim(`  thoughts ${showThoughts ? "on" : "off"}`));
		} else if (cmd === "/tick") void scheduler.fireNow();
		else if (cmd === "/quiet") {
			const minutes = Number(rest[0] ?? "30");
			if (!Number.isFinite(minutes) || minutes <= 0) {
				out(dim("  usage: /quiet [分（正の数）]"));
				return true;
			}
			agent.mute(Date.now() + minutes * 60_000);
			out(
				dim(`  ${minutes}分間、自分からは話しかけません（考えるのは続けます）`),
			);
		} else if (cmd === "/stop") {
			agent.setStopped(true);
			heartbeat.stop();
			inFlight?.abort();
			out(dim("  停止しました（/resume で再開）"));
		} else if (cmd === "/resume") {
			agent.setStopped(false);
			agent.mute(null);
			heartbeat.resume(Date.now());
			scheduler.rearm();
			out(dim("  再開しました"));
		} else if (cmd === "/state") {
			const v = agent.view();
			const lines = [
				`observations ${v.observations} / thoughts ${v.thoughts.length} / unanswered ${v.pacing.unanswered} / next tick ${heartbeat.status().intervalSec}s / spend this session $${(meter.spentUsd() - sessionStart).toFixed(4)}`,
				...v.facts.map(
					(f) => `  fact ${f.id} [${f.basis}/${f.aspect}] ${f.text}`,
				),
				...v.gaps
					.filter((g) => g.status === "open")
					.map((g) => `  gap ${g.id} ${g.question}`),
				...v.preparing.map((p) => `  preparing ${p.toolName}: ${p.toolInput}`),
				...v.stock.map(
					(x) =>
						`  stock ${x.id} [${x.kind}${x.usedAt === null ? "" : ", used"}] ${x.text.slice(0, 80)}`,
				),
			];
			out(dim(lines.join("\n")));
		} else if (cmd === "/feedback") {
			const [kind, ...note] = rest;
			if (kind !== "useful" && kind !== "intrusive" && kind !== "missed")
				out(dim("  usage: /feedback useful|intrusive|missed [note]"));
			else {
				log.write({ type: "feedback", kind, note: note.join(" ") || null });
				out(dim(`  feedback ${kind} を記録しました`));
			}
		} else out(dim(`  unknown command: ${cmd}`));
		return true;
	};

	console.log(
		dim(
			`always-on / 話しかけの最短間隔 ${args.interval}秒 / 好きなもの ${args.interests.join(" | ") || "なし"} / background ${settings.llm.background.model} / log ${args.log ?? "off"}\ncommands: /thoughts /tick /quiet [分] /stop /resume /state /feedback useful|intrusive|missed /quit`,
		),
	);
	emitKeypressEvents(process.stdin, rl);
	process.stdin.on(
		"keypress",
		(_s: string, key: { name?: string } | undefined) => {
			if (key?.name !== "return" && key?.name !== "enter") typed();
		},
	);
	let queue: Promise<unknown> = Promise.resolve();
	rl.on("line", (raw) => {
		const line = raw.trim();
		typingDone();
		queue = queue
			.then(async () => {
				if (line === "") return;
				if (line.startsWith("/")) {
					if (!(await command(line))) rl.close();
				} else await reply(line);
				rl.prompt(true);
			})
			// One failed line must not stop every later one.
			.catch((e: unknown) =>
				out(dim(`  [エラー] ${e instanceof Error ? e.message : String(e)}`)),
			);
	});
	rl.on("close", () => {
		closed = true;
		scheduler.dispose();
		inFlight?.abort();
		log.write({
			type: "end",
			spentUsd: meter.spentUsd() - sessionStart,
		});
		console.log(
			dim(
				`\nspend this session $${(meter.spentUsd() - sessionStart).toFixed(4)}`,
			),
		);
		process.exit(0);
	});
	rl.prompt();
	scheduler.rearm();
}

if (import.meta.main) await main();
