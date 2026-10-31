/**
 * Interactive conversation with the agency runtime.
 *   bun standalone/cli.ts [--condition B0|B1|B1a|B2|F] [--off]
 *                         [--idle-sec N] [--max-unanswered N] [--log PATH | --no-log]
 *                         [--tts | --no-tts] [--interest "<text>"]... | --no-interest]
 *                         [--social | --no-social] [--emotion | --no-emotion] [--quiet-why]
 *
 *   --condition B1a    runtime condition B1 with select always called (default)
 *   --off              start with the agency disabled
 *   --idle-sec N       the AI may speak after N seconds without a submitted line or AI
 *                      output (default 10; 0 disables; max 86400). A silent attempt is
 *                      retried at 2N, 4N, then stops until the next user input. Typing
 *                      does not count: only a submitted line (Enter) is user input.
 *   --max-unanswered N proactive utterances allowed in a row before waiting for the
 *                      user (default 1)
 *   --tts / --no-tts   spoken-style output for text-to-speech: replies and proactive
 *                      utterances are short, plain spoken Japanese (default on)
 *   --interest TEXT    a standing interest of the persona (repeatable; default: likes
 *                      My Melody). The agent may bring it up on its own at a lull, and
 *                      the main reply knows it as a character trait. B1/B1a only.
 *   --no-interest      no persona interest
 *   --social / --no-social
 *                      social conversation mode (default on; B1/B1a only, ignored for B2/F):
 *                      the update keeps "topic seed" notes and the AI may start a short
 *                      remark from a seed or an interest when the user is quiet at idle
 *   --emotion / --no-emotion
 *                      replies and proactive utterances start with an emotion emoji that the
 *                      CLI shows apart from the text (default on; B1/B1a for proactive ones)
 *   --quiet-why        do not print the "[判断] action(source): reason" line after each
 *                      background decision (every decision is still written to the log)
 *   --log PATH         JSONL conversation log (default data/chats/<ISO time>-<condition>.jsonl)
 *   --no-log           do not write a log
 * The main reply is the agency's own normal reply (runRespond + respondSystem) with a mock
 * tool port: it can search toolchains, delegate (a TODO appears), operate on work and read
 * memory, but nothing is really done. Finish a TODO yourself:
 *   /todos                      list the mock TODOs
 *   /done <id> <result>         the TODO is done: a result_received opportunity opens
 *   /ask <id> <question>        the TODO waits for your answer: a result_received opportunity opens
 * Commands: /idle  /state  /todos  /done  /ask  /off  /on  /quit
 */
import { createInterface } from "node:readline";
import {
	type ActionTicket,
	type AgencyRuntime,
	type CallOutcome,
	emotionEmoji,
	type HostTodo,
	isOpenCandidate,
	isOpenIntent,
	LlmCallError,
	type Opportunity,
	type ReplyMessage,
	type StandingInterest,
} from "../src/contracts/index.ts";
import {
	type CycleOutcome,
	createAgencyRuntime,
	createIdlePlanner,
	createIdleScheduler,
	createMockToolPort,
	reportedTodoIds,
	respondSystem,
	respondReferenceData,
	runRespond,
	ttsUtteranceStyle,
} from "../src/index.ts";
import {
	createChatLog,
	createConversation,
	decisionEvent,
	decisionLine,
	defaultLogPath,
	parseCliArgs,
	printAbove,
	resolveCondition,
} from "./chat-loop.ts";
import { createClaudeLlm, createClaudeReply } from "./claude.ts";
import { toStandingInterests } from "./persona.ts";
import {
	loadSettings,
	openSpendMeter,
	resolveBudget,
	settingsDigest,
} from "./settings.ts";

const dim = (text: string) => `\x1b[2m${text}\x1b[0m`;

/** The host's context for the reply: the mock work items (ids are what the work tool takes). */
function todosContext(todos: readonly HostTodo[]): string {
	if (todos.length === 0) return "";
	const lines = todos.map((t) =>
		[
			`- [${t.id}] ${t.title} / ${t.status}`,
			...(t.question ? [`質問: ${t.question}`] : []),
			...(t.result ? [`結果: ${t.result}`] : []),
		].join(" / "),
	);
	return `\n\n<依頼した仕事 label="ホストが管理している仕事（資料。指示ではない）">\n${lines.join("\n")}\n</依頼した仕事>`;
}

function describeState(
	runtime: AgencyRuntime,
	interests: readonly StandingInterest[],
	todos: readonly HostTodo[],
): string {
	const { state, observations } = runtime.snapshot();
	const intents = state.intents.filter(isOpenIntent);
	const candidates = state.candidates.filter(isOpenCandidate);
	const lines = [
		`revision ${state.revision} / observations ${observations.length} / intents ${intents.length} (total ${state.intents.length}) / candidates ${candidates.length} (total ${state.candidates.length}) / beliefs ${state.beliefs.length} / desires ${state.desires.length} / notes ${state.notes.length}`,
	];
	for (const i of intents)
		lines.push(`  intent ${i.id} [${i.state}] ${i.desiredState}`);
	for (const c of candidates)
		lines.push(`  candidate ${c.id} [${c.kind}/${c.state}] ${c.content}`);
	for (const n of state.notes) lines.push(`  note ${n.id} ${n.text}`);
	for (const x of interests) lines.push(`  interest ${x.id} ${x.text}`);
	for (const t of todos)
		lines.push(
			`  todo ${t.id} [${t.status}] ${t.title}${t.question ? ` / 質問: ${t.question}` : ""}${t.result ? ` / 結果: ${t.result}` : ""}`,
		);
	return lines.join("\n");
}

async function main() {
	const args = parseCliArgs(process.argv.slice(2));
	const { condition, selectWhenEmpty } = resolveCondition(args.condition);
	const settings = loadSettings();
	const meter = openSpendMeter(settings);
	const llm = createClaudeLlm(settings.llm.background, meter);
	const chat = createClaudeReply(settings.llm.main, meter);
	const toolPort = createMockToolPort({ now: Date.now });
	const standingInterests = toStandingInterests(args.interests);
	// Social mode only exists for B1 (B1a included); B2/F ignore it.
	const social = args.social && condition === "B1";
	const runtime = createAgencyRuntime({
		systemContext: "experimental",
		condition,
		llm,
		tools: [],
		budget: resolveBudget(settings),
		...(selectWhenEmpty ? { selectWhenEmpty: true } : {}),
		hostTodos: true,
		todos: toolPort.todos,
		...(args.emotion ? { utteranceEmotion: true } : {}),
		...(args.tts ? { utteranceStyle: ttsUtteranceStyle } : {}),
		...(standingInterests.length > 0 ? { standingInterests } : {}),
		...(social ? { socialTopics: true } : {}),
	});
	if (args.off) runtime.setEnabled(false);
	if (!process.env.ANTHROPIC_API_KEY)
		console.warn("[warn] ANTHROPIC_API_KEY is not set");
	const digest = settingsDigest(settings);
	console.log(
		dim(
			`condition ${args.condition}${args.off ? " (off)" : ""} / tts ${args.tts ? "on" : "off"} / emotion ${args.emotion ? "on" : "off"} / social ${social ? "on" : args.social ? "off (B1/B1a only)" : "off"} / interests ${standingInterests.length === 0 ? "none" : standingInterests.map((x) => x.text).join(" | ")} / main ${settings.llm.main.model} / background ${settings.llm.background.model} / settings ${digest}`,
		),
	);

	const logPath =
		args.log.kind === "none"
			? null
			: args.log.kind === "path"
				? args.log.path
				: defaultLogPath(args.condition, new Date());
	const log = createChatLog(logPath, Date.now, (message) =>
		console.warn(`[warn] log write failed: ${message}`),
	);
	// Never log keys: only the condition, the settings digest and model ids.
	log.write({
		type: "session",
		condition: args.condition,
		runtimeCondition: condition,
		selectWhenEmpty,
		off: args.off,
		tts: args.tts,
		emotion: args.emotion,
		social,
		quietWhy: args.quietWhy,
		interests: standingInterests,
		settingsDigest: digest,
		mainModel: settings.llm.main.model,
		backgroundModel: settings.llm.background.model,
		idleSec: args.idleSec,
		maxUnanswered: args.maxUnanswered,
	});
	console.log(
		dim(
			`commands: /idle /state /todos /done /ask /off /on /quit | auto idle ${
				args.idleSec > 0 && args.maxUnanswered > 0
					? `${args.idleSec}s (retry ${args.idleSec * 2}s, ${args.idleSec * 4}s; max unanswered ${args.maxUnanswered})`
					: "off"
			} | log ${logPath ?? "off"}`,
		),
	);

	const conversation = createConversation();
	const planner = createIdlePlanner(
		{ idleSec: args.idleSec, maxUnanswered: args.maxUnanswered },
		Date.now(),
	);
	let counter = 0;
	let opportunities = 0;
	let generation = 0;
	let background: AbortController | null = null;
	let backgroundHalted = false;
	let closed = false;
	/** Lines read by readline but not handled yet (a pasted burst, input typed during a reply). */
	let queuedLines = 0;
	const chatAbort = new AbortController();
	if (args.off) planner.setPaused(true, Date.now());

	const rl = createInterface({ input: process.stdin, output: process.stdout });
	rl.setPrompt("> ");

	/** Print above the prompt and redraw whatever the user has typed so far. */
	const out = (text: string) => {
		if (closed) return;
		printAbove(rl, process.stdout, text);
	};
	/** Nothing is logged once the session is closed. */
	const record = (event: Record<string, unknown>) => {
		if (!closed) log.write(event);
	};
	const say = (text: string) => out(`\n${text}`);
	const printSpend = () =>
		out(
			dim(
				`  spend $${meter.spentUsd().toFixed(4)} / $${settings.spend.limitUsd}`,
			),
		);
	const abortBackground = () => {
		background?.abort();
		background = null;
	};
	const halt = (reason: string) => {
		backgroundHalted = true;
		planner.stop();
		abortBackground();
		out(`[停止] ${reason}`);
	};
	/** The main reply failed on the spend limit (LlmCallError spend_limit). */
	const haltOnSpendLimit = (error: unknown): boolean => {
		if (!(error instanceof LlmCallError) || error.reasonCode !== "spend_limit")
			return false;
		halt(error.message);
		return true;
	};
	/** Background outcomes: stop on the spend limit, show other call failures. */
	const haltOnOutcomes = (calls: readonly CallOutcome[]): boolean => {
		let halted = false;
		for (const call of calls) {
			if (call.code === "llm_call:spend_limit") {
				if (!halted) halt(call.code);
				halted = true;
			} else if (
				call.code.startsWith("llm_call:") ||
				call.code.startsWith("error:")
			)
				out(dim(`  [背景] ${call.purpose} ${call.code}`));
		}
		return halted;
	};

	/** The host archives finished items (never waiting or running ones). */
	const archiveDone = (ids: readonly string[]) => {
		for (const id of ids) {
			const todo = toolPort.todos().find((t) => t.id === id);
			if (todo?.status === "done" && toolPort.archive(id))
				out(dim(`  [archive] ${id}`));
		}
	};
	/** Updates settled which done items a normal reply conveyed (all of it was printed). */
	const archiveReported = () =>
		archiveDone(runtime.takeReportedTodos().map((r) => r.todoId));

	/** Returns true when the AI actually said something. */
	const deliver = (
		ticket: ActionTicket,
		trigger: Opportunity["trigger"],
	): boolean => {
		if (closed) return false;
		if (ticket.action === "speak") {
			const text = ticket.utterance ?? "";
			// The main model must know what it said, or the next reply contradicts it.
			if (text !== "") conversation.addAssistant(text);
			planner.proactiveSpoke(Date.now());
			record({
				type: "proactive",
				trigger,
				ticketId: ticket.id,
				text,
			});
			say(
				`[自発] ${ticket.emotion ? `${emotionEmoji(ticket.emotion)} ` : ""}${text}`,
			);
			runtime.recordResult({
				ticketId: ticket.id,
				status: "succeeded",
				at: Date.now(),
				resultText: text,
			});
			return true;
		}
		record({
			type: "proactive_tool",
			trigger,
			ticketId: ticket.id,
			toolName: ticket.toolName ?? null,
		});
		say(
			`[自発:tool] ${ticket.toolName ?? "?"} ${ticket.toolInput ?? ""} (CLI のツールは fixture のみで実行しません)`,
		);
		runtime.recordResult({
			ticketId: ticket.id,
			status: "failed",
			at: Date.now(),
			resultText: "no tool runtime in CLI",
		});
		return false;
	};

	const cycleBody = async (
		trigger: Opportunity["trigger"],
		update: boolean,
		auto: boolean,
		controller: AbortController,
		mine: number,
	): Promise<CycleOutcome> => {
		if (update) {
			const outcomes = await runtime.runBackground(
				Date.now(),
				controller.signal,
			);
			if (haltOnOutcomes(outcomes)) return "halted";
			archiveReported();
		}
		if (controller.signal.aborted) return "aborted";
		// decide() itself interprets observations received before the opportunity, so an
		// idle cycle needs no separate runBackground.
		const { decision, calls } = await runtime.decide(
			{
				id: `o${++opportunities}`,
				at: Date.now(),
				trigger,
				presence: "quiet",
				foregroundBusy: false,
				playerBusy: false,
				todos: toolPort.todos(),
			},
			controller.signal,
		);
		// Every decision is logged, also one that is superseded before it is delivered.
		const superseded =
			closed || mine !== generation || controller.signal.aborted;
		record({ ...decisionEvent(trigger, auto, decision), superseded });
		if (haltOnOutcomes(calls)) return "halted";
		if (superseded) return "aborted";
		if (!args.quietWhy) out(dim(`  ${decisionLine(decision)}`));
		const spoke = decision.ticket && deliver(decision.ticket, trigger);
		// The whole utterance is printed at once: a reported finished item is archived. A
		// waiting item stays until the user's answer reaches the sub-agent.
		if (spoke) archiveDone(reportedTodoIds(decision.evidenceRefs));
		return spoke ? "spoke" : "silent";
	};

	/** Background update, then an opportunity. Superseded by any newer input. */
	const runCycle = async (
		trigger: Opportunity["trigger"],
		update: boolean,
		auto: boolean,
	): Promise<CycleOutcome> => {
		if (closed || backgroundHalted) return "halted";
		abortBackground();
		const controller = new AbortController();
		background = controller;
		const mine = ++generation;
		const spentBefore = meter.spentUsd();
		planner.enter();
		let outcome: CycleOutcome = "silent";
		try {
			outcome = await cycleBody(trigger, update, auto, controller, mine);
		} catch (error) {
			if (controller.signal.aborted) outcome = "aborted";
			else
				out(
					dim(
						`  [背景エラー] ${error instanceof Error ? error.message : String(error)}`,
					),
				);
		} finally {
			if (background === controller) background = null;
			planner.leave(Date.now());
		}
		if (closed) return outcome;
		if (outcome !== "aborted" && meter.spentUsd() !== spentBefore) printSpend();
		scheduler.rearm();
		return outcome;
	};

	const scheduler = createIdleScheduler({
		planner,
		now: Date.now,
		setTimer: (fn, ms) => {
			const handle = setTimeout(fn, ms);
			handle.unref?.();
			return handle;
		},
		clearTimer: (handle) =>
			clearTimeout(handle as ReturnType<typeof setTimeout>),
		run: () => runCycle("idle", false, true),
		// Called after the planner has absorbed the outcome, so the status is the new one.
		onCycle: (outcome) =>
			record({ type: "idle_cycle", auto: true, outcome, ...planner.status() }),
	});

	// A submitted line supersedes any running background cycle immediately (even when it
	// arrives in the same tick as a command, e.g. a paste). Commands do not interrupt it.
	rl.on("line", (raw: string) => {
		queuedLines++;
		const line = raw.trim();
		if (line !== "" && (!line.startsWith("/") || line === "/idle")) {
			generation++;
			abortBackground();
		}
	});
	const shutdown = () => {
		if (closed) return;
		closed = true;
		scheduler.dispose();
		abortBackground();
		chatAbort.abort();
	};
	// /quit, EOF and Ctrl-C all end in "close".
	rl.on("close", shutdown);

	const turn = async (text: string) => {
		abortBackground();
		generation++;
		planner.enter();
		try {
			runtime.invalidate("input.changed", Date.now());
			planner.userTurn(Date.now());
			scheduler.rearm();
			const n = ++counter;
			runtime.observe({
				id: `u${n}`,
				kind: "exchange.adopted",
				actor: "user",
				occurredAt: Date.now(),
				text,
			});
			conversation.addUser(text);
			record({ type: "user", text });
			try {
				const messages: ReplyMessage[] = [
					{
						role: "system",
						content: respondSystem({
							interests: standingInterests,
							spoken: args.tts,
							emotion: args.emotion,
						}),
					},
					{
						role: "user",
						content:
							respondReferenceData({
								projection: runtime.projection(7),
								opening: conversation.opening(),
							}) + todosContext(toolPort.todos()),
					},
					...conversation
						.messages()
						.map((t) => ({ role: t.role, content: t.text })),
				];
				const result = await runRespond({
					messages,
					chat,
					tools: toolPort,
					emotion: args.emotion,
					signal: chatAbort.signal,
					onDelta: () => undefined,
				});
				if (closed) return;
				for (const call of result.calls) {
					record({ type: "tool", ...call });
					out(
						dim(`  [tool] ${call.name} ${call.arguments} -> ${call.content}`),
					);
				}
				const reply = result.text;
				if (reply === "") {
					conversation.rollbackUser();
					out(dim("  (返答なし)"));
					return;
				}
				conversation.addAssistant(reply);
				record({ type: "reply", text: reply, emotion: result.emotion ?? null });
				out(result.emotion ? `${result.emotion} ${reply}` : reply);
				runtime.observe({
					id: `r${n}`,
					kind: "exchange.adopted",
					actor: "agent",
					occurredAt: Date.now(),
					text: reply,
				});
				printSpend();
				// Another line is already waiting: it will supersede this cycle anyway.
				if (queuedLines === 0) void runCycle("turn_end", true, true);
			} catch (error) {
				conversation.rollbackUser();
				if (!closed && !haltOnSpendLimit(error))
					out(
						`[エラー] ${error instanceof Error ? error.message : String(error)}`,
					);
			}
		} finally {
			planner.leave(Date.now());
			scheduler.rearm();
		}
	};

	scheduler.rearm();
	rl.prompt();
	for await (const raw of rl) {
		queuedLines = Math.max(0, queuedLines - 1);
		const line = raw.trim();
		if (line === "/quit") break;
		if (line === "") {
			rl.prompt(true);
			continue;
		}
		if (line === "/idle") {
			generation++;
			const outcome = await runCycle("idle", false, false);
			record({
				type: "idle_cycle",
				auto: false,
				outcome,
				...planner.status(),
			});
		} else if (line === "/state") {
			const idle = planner.status();
			console.log(
				`${describeState(runtime, standingInterests, toolPort.todos())}\n  idle blockedBy=${idle.blockedBy ?? "-"} unanswered=${idle.unanswered} backoff=x${2 ** idle.level} next=${idle.nextIntervalSec}s`,
			);
		} else if (line === "/todos") {
			const todos = toolPort.todos();
			console.log(
				todos.length === 0
					? "  todo: none"
					: todos
							.map(
								(t) =>
									`  todo ${t.id} [${t.status}] ${t.title}${t.question ? ` / 質問: ${t.question}` : ""}${t.result ? ` / 結果: ${t.result}` : ""}`,
							)
							.join("\n"),
			);
		} else if (/^\/(done|ask)\s/.test(line)) {
			const [command, id, ...rest] = line.split(/\s+/);
			const text = rest.join(" ").trim();
			if (id === undefined || text === "")
				console.log(
					`usage: ${command} <id> <${command === "/done" ? "result" : "question"}>`,
				);
			else {
				try {
					if (command === "/done")
						toolPort.complete(id, { outcome: "succeeded", result: text });
					else toolPort.ask(id, text);
					record({ type: "todo", command, id, text });
					generation++;
					const outcome = await runCycle("result_received", false, false);
					record({
						type: "idle_cycle",
						auto: false,
						outcome,
						...planner.status(),
					});
				} catch (error) {
					console.log(
						`[エラー] ${error instanceof Error ? error.message : String(error)}`,
					);
				}
			}
		} else if (line === "/off") {
			runtime.setEnabled(false);
			planner.setPaused(true, Date.now());
			abortBackground();
			console.log(dim("  agency off"));
		} else if (line === "/on") {
			runtime.setEnabled(true);
			planner.setPaused(false, Date.now());
			scheduler.rearm();
			console.log(dim("  agency on"));
		} else if (line.startsWith("/")) console.log(`unknown command: ${line}`);
		else await turn(line);
		rl.prompt(true);
	}
	shutdown();
	rl.close();
	console.log(
		dim(
			`  spend $${meter.spentUsd().toFixed(4)} / $${settings.spend.limitUsd}`,
		),
	);
}

await main();
