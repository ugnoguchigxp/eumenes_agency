/**
 * Always-on conversation CLI (spec/always-on-agency-design-2026-11-07.md). The agent keeps
 * thinking on a heartbeat and may speak on its own; typing pauses it. Cost is recorded in
 * data/always-on/usage.jsonl and never capped.
 *
 *   zsh -l scripts/api-entry.zsh standalone/always-on.ts [--interval 10|60|600]
 *       [--interest TEXT]... [--no-interest] [--no-thoughts] [--log PATH | --no-log]
 *       [--state PATH] [--fresh] [--mock-research]
 *
 * The agent (what it knows about the user, its thoughts, prepared material) is saved in
 * data/always-on/state.json and comes back next time; --fresh starts over.
 *
 * Commands: /thoughts /tick /quiet [min] /stop /resume /state
 *           /feedback useful|intrusive|missed [note] /quit
 */
import { emitKeypressEvents, createInterface } from "node:readline";
import { resolve } from "node:path";
import {
	createAlwaysOnAgent,
	runRespond,
	speechIntervals,
	type SpeechIntervalSec,
} from "../src/index.ts";
import {
	createAlwaysOnSession,
	tickAction,
	type SessionEvent,
} from "./always-on-session.ts";
import { createChatLog, chatsDir, printAbove } from "./chat-loop.ts";
import { createProviderLlm, createProviderReply } from "./providers.ts";
import { loadSettings, settingsDigest } from "./settings.ts";
import { defaultInterestText, toStandingInterests } from "./persona.ts";
import {
	alwaysOnStatePath,
	loadAgentState,
	openUncappedMeter,
	replyMessages,
	saveAgentState,
} from "./always-on-host.ts";
import {
	createMockPreparer,
	llmSubagent,
} from "../examples/virtual-eumenes/always-on-mock.ts";
import { webResearcher, webTools } from "./always-on-research.ts";

export interface AlwaysOnArgs {
	readonly interval: SpeechIntervalSec;
	readonly interests: readonly string[];
	readonly thoughts: boolean;
	readonly log: string | null;
	readonly state: string;
	readonly fresh: boolean;
	/** Use the offline mock instead of real web search for preparations. */
	readonly mockResearch: boolean;
}

export function parseAlwaysOnArgs(
	argv: readonly string[],
	now: Date,
): AlwaysOnArgs {
	let interval: SpeechIntervalSec = 10;
	const interests: string[] = [];
	let noInterest = false;
	let thoughts = true;
	let state = alwaysOnStatePath;
	let fresh = false;
	let mockResearch = false;
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
		else if (arg === "--state") state = value();
		else if (arg === "--fresh") fresh = true;
		else if (arg === "--mock-research") mockResearch = true;
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
		state,
		fresh,
		mockResearch,
	};
}

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const localTime = (now: number) =>
	new Date(now).toLocaleString("ja-JP", {
		weekday: "short",
		month: "numeric",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	});

async function main() {
	const args = parseAlwaysOnArgs(process.argv.slice(2), new Date());
	// always-on thinks at effort "high" (background, so it never delays the reply); the reply
	// stays at "medium". AGENCY_SETTINGS overrides.
	const settings = loadSettings(
		process.env.AGENCY_SETTINGS
			? undefined
			: resolve(import.meta.dir, "../config/always-on.json"),
	);
	const meter = openUncappedMeter(settings);
	const llm = createProviderLlm(settings.llm.background, meter);
	const chat = createProviderReply(settings.llm.main, meter);
	const interests = toStandingInterests(args.interests);
	// Preparation runs on the examples mock: no real search or service is used.
	// Preparation searches the web for real (read-only); --mock-research keeps it offline.
	const researcher = args.mockResearch
		? null
		: webResearcher({
				model: settings.llm.background.model,
				meter,
				today: () => localTime(Date.now()),
			});
	const preparer = researcher
		? createMockPreparer({ subagent: researcher, delayMs: 0, tools: webTools })
		: createMockPreparer({ subagent: llmSubagent(llm), delayMs: 60_000 });
	const restore = args.fresh ? null : loadAgentState(args.state);
	const agent = createAlwaysOnAgent({
		...(restore ? { restore } : {}),
		llm,
		interests,
		tools: preparer.tools,
		speechIntervalSec: args.interval,
		clock: localTime,
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
	const sessionStart = meter.spentUsd();
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	rl.setPrompt("> ");
	const out = (text: string) => {
		if (!closed) printAbove(rl, process.stdout, text);
	};

	// The mock's jobs do not outlive the process: what was still out ended with the last run.
	for (const p of agent.view().preparing)
		agent.workReturned({
			ticketId: p.ticketId,
			at: Date.now(),
			status: "failed",
			summary: "前回の終了で中断した",
		});
	const save = () => {
		try {
			saveAgentState(args.state, agent.snapshot());
		} catch (e) {
			console.warn(
				`[warn] state save failed: ${e instanceof Error ? e.message : String(e)}`,
			);
		}
	};

	const show = (e: SessionEvent) => {
		if (e.type !== "error") queueMicrotask(save);
		switch (e.type) {
			case "user":
				log.write({ type: "user", text: e.text });
				return;
			case "reply":
				log.write({ type: "reply", text: e.text, latencyMs: e.latencyMs });
				return out(e.text);
			case "tick": {
				const o = e.outcome;
				log.write({
					type: "tick",
					action: tickAction(o),
					chosen: o.chosen,
					skipped: o.skipped,
					drive: o.thought?.drive ?? null,
					thought: o.thought?.text ?? null,
					text: o.ticket?.utterance ?? null,
					applied: o.applied,
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
				return;
			}
			case "speak":
				log.write({ type: "speak", action: e.action, text: e.text });
				return out(`\n[自分から] ${e.text}`);
			case "prepare":
				log.write({
					type: "prepare",
					toolName: e.toolName,
					toolInput: e.toolInput,
					accepted: e.accepted,
				});
				return out(dim(`  [準備] ${e.toolName}: ${e.toolInput}`));
			case "prepared":
				log.write({ type: "prepared", status: e.status, text: e.text });
				// The whole result is in the log and /state; the terminal shows its head.
				return out(
					dim(
						`  [準備完了] ${e.text.length > 200 ? `${e.text.slice(0, 200).replace(/\s+/g, " ")}…` : e.text}`,
					),
				);
			case "error":
				log.write({ type: "error", where: e.where, message: e.message });
				return out(dim(`  [${e.where}エラー] ${e.message}`));
		}
	};

	const session = createAlwaysOnSession({
		agent,
		preparer,
		now: Date.now,
		setTimer: (fn, ms) => {
			const h = setTimeout(fn, ms);
			h.unref?.();
			return h;
		},
		clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
		emit: show,
		reply: async (a, tools) =>
			(
				await runRespond({
					messages: replyMessages(
						a,
						interests,
						preparer.tools,
						localTime(Date.now()),
					),
					chat,
					tools,
					emotion: false,
					signal: new AbortController().signal,
					onDelta: () => undefined,
				})
			).text,
	});

	const command = async (line: string): Promise<boolean> => {
		const [cmd, ...rest] = line.split(/\s+/);
		if (cmd === "/quit") return false;
		if (cmd === "/thoughts") {
			showThoughts = !showThoughts;
			out(dim(`  thoughts ${showThoughts ? "on" : "off"}`));
		} else if (cmd === "/tick") void session.tickNow();
		else if (cmd === "/quiet") {
			const minutes = Number(rest[0] ?? "30");
			if (!Number.isFinite(minutes) || minutes <= 0) {
				out(dim("  usage: /quiet [分（正の数）]"));
				return true;
			}
			session.mute(minutes);
			out(
				dim(`  ${minutes}分間、自分からは話しかけません（考えるのは続けます）`),
			);
		} else if (cmd === "/stop") {
			session.stop();
			out(dim("  停止しました（/resume で再開）"));
		} else if (cmd === "/resume") {
			session.resume();
			out(dim("  再開しました"));
		} else if (cmd === "/state") {
			const v = agent.view();
			const lines = [
				`observations ${v.observations} / thoughts ${v.thoughts.length} / unanswered ${v.pacing.unanswered} / next tick ${session.status().intervalSec}s / spend this session $${(meter.spentUsd() - sessionStart).toFixed(4)}${researcher ? ` + web search ${researcher.searches()} 回` : ""}`,
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
			`always-on / 調べもの: ${researcher ? "Web検索" : "mock"} / ${restore ? `前回の記憶あり（知っていること${agent.view().facts.length}件）` : "記憶なしで開始"} / 話しかけの最短間隔 ${args.interval}秒 / 好きなもの ${args.interests.join(" | ") || "なし"} / background ${settings.llm.background.model} / log ${args.log ?? "off"}\ncommands: /thoughts /tick /quiet [分] /stop /resume /state /feedback useful|intrusive|missed /quit`,
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
	rl.on("line", (raw) => {
		const line = raw.trim();
		queue = queue
			.then(async () => {
				if (line === "") return;
				if (line.startsWith("/")) {
					if (!(await command(line))) rl.close();
				} else await session.say(line);
				rl.prompt(true);
			})
			// One failed line must not stop every later one.
			.catch((e: unknown) =>
				out(dim(`  [エラー] ${e instanceof Error ? e.message : String(e)}`)),
			);
	});
	rl.on("close", () => {
		closed = true;
		session.close();
		save();
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
	session.start();
}

if (import.meta.main) await main();
