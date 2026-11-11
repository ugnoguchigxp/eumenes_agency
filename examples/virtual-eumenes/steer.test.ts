/**
 * eumenes-steer under the packaged agenda host loop (src/agenda: createAgendaHost and its
 * `addedWords` seam), wired as a host does it: the vendored eumenes-steer (vendor/steer-manifest.json)
 * gives the inbox and the CLI's steer (standalone/agenda-steer.ts) fills the seam; the package has
 * no steer of its own. First the reply loop alone,
 * then the whole host loop with the agenda agent, in the two ways a host shows a reply: streamed as
 * it is written (Eumenes) and shown when it is done (the CLI).
 */
import { expect, test } from "bun:test";
import { createSteeringInbox } from "eumenes-steer";
import {
	runRespond,
	type LlmPort,
	type LlmRequest,
	type ReplyMessage,
	type ReplyPort,
	type ToolPort,
} from "../../src/index.ts";
import {
	createAgendaAgent,
	createAgendaHost,
	READ_NOTE,
	START_PREPARATION,
	type AgendaHostEvent,
} from "../../src/agenda/index.ts";
import {
	createAgendaReplySteering,
	steeredLine,
	type SteerInboxPort,
} from "../../standalone/agenda-steer.ts";
import { createMockDocStore } from "./agenda/docs.ts";

// eumenes-steer's inbox is the package's port as it is (checked by the compiler).
const inboxPort = (): SteerInboxPort =>
	createSteeringInbox({ now: () => 1_000 });

const system: ReplyMessage = { role: "system", content: "返事をします。" };
const userLine: ReplyMessage = {
	role: "user",
	content: "ラーメンのメモある？",
};
const signal = new AbortController().signal;

type Turn = {
	text: string;
	toolCalls?: { id: string; name: string; arguments: string }[];
};

/** A chat port that answers from a script and records what each call was given. */
const scriptedChat = (
	turns: (call: number) => Turn,
	during?: (call: number) => void,
) => {
	const seen: ReplyMessage[][] = [];
	const chat: ReplyPort = {
		complete(request, onDelta) {
			seen.push([...request.messages]);
			const call = seen.length;
			// The user sends words while this model call is out.
			during?.(call);
			const out = turns(call);
			if (out.text) onDelta(out.text);
			return Promise.resolve({
				text: out.text,
				toolCalls: out.toolCalls ?? [],
			});
		},
	};
	return { chat, seen };
};

const readTool = (during: () => void = () => undefined): ToolPort => ({
	tools: [
		{
			name: READ_NOTE,
			description: "メモを読む",
			parameters: { type: "object", properties: {} },
		},
	],
	call() {
		during();
		return Promise.resolve({ content: "メモ: 辛味噌の店" });
	},
});

const users = (messages: readonly ReplyMessage[]) =>
	messages.filter((m) => m.role === "user").map((m) => m.content);

test("words sent during a read tool go into the next model call, and stay in the later ones", async () => {
	const lines = new Map([["u2", "あと、辛さ控えめで"]]);
	const steering = createAgendaReplySteering({
		inbox: inboxPort(),
		read: (id) => lines.get(id) ?? null,
		now: () => 1_000,
	});
	const run = steering.begin("r1");
	let sent = false;
	const { chat, seen } = scriptedChat((call) =>
		call < 3
			? {
					text: "",
					toolCalls: [{ id: `c${call}`, name: READ_NOTE, arguments: "{}" }],
				}
			: { text: "辛さ控えめなら、辛味噌の店の甘口がよさそうです。" },
	);
	const out = await runRespond({
		messages: [system, userLine],
		chat: run.wrap(chat),
		tools: readTool(() => {
			if (sent) return;
			sent = true;
			expect(steering.send("u2")).toBe(true);
		}),
		emotion: false,
		signal,
		onDelta: () => undefined,
	});
	expect(out.text).toBe("辛さ控えめなら、辛味噌の店の甘口がよさそうです。");
	expect(seen.length).toBe(3);
	expect(users(seen[0]!)).toEqual(["ラーメンのメモある？"]);
	// The second call takes them after the tool's answer; the third keeps them in the same place.
	for (const call of [seen[1]!, seen[2]!]) {
		expect(users(call)).toEqual([
			"ラーメンのメモある？",
			steeredLine("あと、辛さ控えめで"),
		]);
		const at = call.findIndex(
			(m) => m.content === steeredLine("あと、辛さ控えめで"),
		);
		expect(call[at - 1]?.role).toBe("tool");
	}
	expect(run.end()).toEqual(["u2"]);
	// The reply is over: nothing is open to send to.
	expect(steering.send("u3")).toBe(false);
});

test("words during the last call: streamed, the answer stands; held (the CLI), one more call answers them", async () => {
	for (const holdsText of [false, true]) {
		const steering = createAgendaReplySteering({
			inbox: inboxPort(),
			read: () => "やっぱり塩で",
			now: () => 1_000,
			holdsText,
		});
		const run = steering.begin("r1");
		const said: string[] = [];
		const { chat, seen } = scriptedChat(
			(call) => ({
				text: call === 1 ? "辛味噌の店があります。" : "塩なら、あの店です。",
			}),
			(call) => {
				if (call === 1) steering.send("u2");
			},
		);
		const out = await runRespond({
			messages: [system, userLine],
			chat: run.wrap(chat),
			tools: readTool(),
			emotion: false,
			signal,
			onDelta: (t) => said.push(t),
		});
		if (holdsText) {
			// The first answer was never said; the second took the words and is the reply.
			expect(seen.length).toBe(2);
			expect(users(seen[1]!).at(-1)).toBe(steeredLine("やっぱり塩で"));
			expect(said).toEqual(["塩なら、あの店です。"]);
			expect(out.text).toBe("塩なら、あの店です。");
			expect(run.end()).toEqual(["u2"]);
		} else {
			expect(seen.length).toBe(1);
			expect(said).toEqual(["辛味噌の店があります。"]);
			// Not taken: the host answers the words with a reply of their own.
			expect(run.end()).toEqual([]);
		}
	}
});

test("words forgotten before a call takes them are not given; a failed call gives them to the next", async () => {
	const lines = new Map([
		["u2", "忘れて"],
		["u3", "やっぱり塩で"],
	]);
	const steering = createAgendaReplySteering({
		inbox: inboxPort(),
		read: (id) => lines.get(id) ?? null,
		now: () => 1_000,
	});
	const run = steering.begin("r1");
	steering.send("u2");
	steering.send("u3");
	lines.delete("u2");
	let fail = true;
	const seen: ReplyMessage[][] = [];
	const chat = run.wrap({
		complete(request) {
			seen.push([...request.messages]);
			if (fail) {
				fail = false;
				return Promise.reject(new Error("connection"));
			}
			return Promise.resolve({ text: "塩ですね。", toolCalls: [] });
		},
	});
	const request = { messages: [system, userLine], tools: [] };
	await expect(chat.complete(request, () => undefined, signal)).rejects.toThrow(
		"connection",
	);
	await chat.complete(request, () => undefined, signal);
	expect(users(seen[1]!)).toEqual([
		"ラーメンのメモある？",
		steeredLine("やっぱり塩で"),
	]);
	expect(run.end()).toEqual(["u3"]);
});

/** The agenda agent's own calls (plan, compose, checks), kept quiet: nothing to plan. */
const quietModel: LlmPort = {
	complete<T>(req: LlmRequest<T>) {
		const value = req.system.includes("この呼び出しは「計画」")
			? { add: [], drop: [], focus: "" }
			: req.system.includes("重複チェック")
				? { verdict: "new", coveredBy: null, request: null, reason: "新しい" }
				: {
						utterance: null,
						emotion: null,
						decline: "なし",
						questions: 0,
						choice: false,
					};
		return Promise.resolve({
			value: req.schema.parse(value),
			model: "scripted",
			inputTokens: 1,
			outputTokens: 1,
			cacheReadTokens: 0,
			latencyMs: 1,
		});
	},
};

/**
 * A virtual Eumenes around the packaged host loop: its documents for notes, its researcher
 * behind the research port (results come back through researchReturned), one steer inbox per
 * server, and the reply over runRespond.
 */
const virtualEumenes = (
	turns: (call: number) => Turn,
	during: (say: (text: string) => Promise<void>, call: number) => void,
	holdsText = false,
) => {
	const events: AgendaHostEvent[] = [];
	const docs = createMockDocStore();
	const agent = createAgendaAgent({
		llm: quietModel,
		startedAt: 0,
		notes: docs.list,
	});
	const started: string[] = [];
	const replyCalls: ReplyMessage[][] = [];
	const said: string[] = [];
	let calls = 0;
	const host = createAgendaHost({
		agent,
		notes: { read: (id) => docs.read(id), list: () => docs.list() },
		research: {
			start: (t) => {
				started.push(t.text);
				return true;
			},
		},
		addedWords: createAgendaReplySteering({
			inbox: inboxPort(),
			read: (id) =>
				agent.view().said.find((s) => s.id === id && s.who === "user")?.text ??
				null,
			now: () => 1_000,
			holdsText,
		}),
		reply: async (a, tools, steer) => {
			const chat: ReplyPort = {
				complete(request, onDelta) {
					calls++;
					replyCalls.push([...request.messages]);
					// The user sends words while this model call is out.
					during((text) => host.say(text), calls);
					const out = turns(calls);
					if (out.text) onDelta(out.text);
					return Promise.resolve({
						text: out.text,
						toolCalls: out.toolCalls ?? [],
					});
				},
			};
			const r = await runRespond({
				messages: [
					system,
					...a.view().said.map((s): ReplyMessage => ({
						role: s.who === "user" ? "user" : "assistant",
						content: s.text,
					})),
				],
				chat: steer(chat),
				tools,
				emotion: false,
				signal,
				onDelta: (t) => said.push(t),
			});
			return { text: r.text, calls: r.calls };
		},
		now: () => 1_000,
		setTimer: () => 0,
		clearTimer: () => undefined,
		emit: (e) => events.push(e),
		idPrefix: "ve",
	});
	const lines = () =>
		events
			.filter((e) => e.type === "user" || e.type === "reply")
			.map((e) => [e.type, "text" in e ? e.text : ""]);
	return { host, agent, events, lines, replyCalls, started, said };
};

const research = (id: string, request: string) => ({
	text: "",
	toolCalls: [
		{
			id,
			name: START_PREPARATION,
			arguments: JSON.stringify({ request, askedByUser: true }),
		},
	],
});

test("Eumenes host: a request added while the reply asks for research is taken by the same reply", async () => {
	const pending: Promise<void>[] = [];
	const ve = virtualEumenes(
		(call) =>
			call === 1
				? research("c1", "明日の東京の天気")
				: call === 2
					? research("c2", "明日の大阪の天気")
					: { text: "東京と大阪、両方の天気を頼みました。" },
		(say, call) => {
			// The user adds Osaka while the first model call is out.
			if (call === 1) pending.push(say("あと、大阪もお願い"));
		},
	);
	await ve.host.say("明日の東京の天気を調べて");
	await Promise.all(pending);
	await ve.host.flush();
	expect(ve.lines()).toEqual([
		["user", "明日の東京の天気を調べて"],
		["user", "あと、大阪もお願い"],
		["reply", "東京と大阪、両方の天気を頼みました。"],
	]);
	expect(users(ve.replyCalls[1]!).at(-1)).toBe(
		steeredLine("あと、大阪もお願い"),
	);
	// Both requests are on the agent's agenda, asked for by the user.
	expect(
		ve.agent
			.view()
			.items.filter((i) => i.kind === "research" && i.requested)
			.map((i) => i.text),
	).toEqual(["明日の東京の天気", "明日の大阪の天気"]);
	ve.host.close();
});

test("Eumenes host: words during the reply's last call get a reply of their own right after", async () => {
	const pending: Promise<void>[] = [];
	const ve = virtualEumenes(
		(call) => ({
			text: call === 1 ? "辛味噌の店があります。" : "塩なら、あの店です。",
		}),
		(say, call) => {
			if (call === 1) pending.push(say("やっぱり塩で"));
		},
	);
	await ve.host.say("ラーメンのメモある？");
	await Promise.all(pending);
	await ve.host.flush();
	expect(ve.lines()).toEqual([
		["user", "ラーメンのメモある？"],
		["user", "やっぱり塩で"],
		["reply", "辛味噌の店があります。"],
		["reply", "塩なら、あの店です。"],
	]);
	// The second reply reads the words from the record, not as steered words.
	expect(users(ve.replyCalls[1]!)).toEqual([
		"ラーメンのメモある？",
		"やっぱり塩で",
	]);
	ve.host.close();
});

test("CLI host (shown when done): words during the last call are answered in the same reply", async () => {
	const pending: Promise<void>[] = [];
	const ve = virtualEumenes(
		(call) => ({
			text: call === 1 ? "辛味噌の店があります。" : "塩なら、あの店です。",
		}),
		(say, call) => {
			if (call === 1) pending.push(say("やっぱり塩で"));
		},
		true,
	);
	await ve.host.say("ラーメンのメモある？");
	await Promise.all(pending);
	await ve.host.flush();
	expect(ve.lines()).toEqual([
		["user", "ラーメンのメモある？"],
		["user", "やっぱり塩で"],
		["reply", "塩なら、あの店です。"],
	]);
	expect(ve.said).toEqual(["塩なら、あの店です。"]);
	ve.host.close();
});

test("several words taken by one call, and words taken by a retake, stay in the order sent", async () => {
	const lines = new Map([
		["u2", "あと辛さ控えめで"],
		["u3", "やっぱり塩で"],
		["u4", "麺は細めで"],
	]);
	const steering = createAgendaReplySteering({
		inbox: inboxPort(),
		read: (id) => lines.get(id) ?? null,
		now: () => 1_000,
		holdsText: true,
	});
	const run = steering.begin("r1");
	const { chat, seen } = scriptedChat(
		(call) =>
			call === 1
				? {
						text: "",
						toolCalls: [{ id: "c1", name: READ_NOTE, arguments: "{}" }],
					}
				: { text: call === 2 ? "塩ですね。" : "細めの塩ですね。" },
		(call) => {
			if (call === 1) {
				steering.send("u2");
				steering.send("u3");
			}
			// Comes during the last call: one more call takes it after the others.
			if (call === 2) steering.send("u4");
		},
	);
	const out = await runRespond({
		messages: [system, userLine],
		chat: run.wrap(chat),
		tools: readTool(),
		emotion: false,
		signal,
		onDelta: () => undefined,
	});
	expect(out.text).toBe("細めの塩ですね。");
	expect(users(seen[1]!)).toEqual([
		"ラーメンのメモある？",
		steeredLine("あと辛さ控えめで"),
		steeredLine("やっぱり塩で"),
	]);
	expect(users(seen[2]!)).toEqual([
		"ラーメンのメモある？",
		steeredLine("あと辛さ控えめで"),
		steeredLine("やっぱり塩で"),
		steeredLine("麺は細めで"),
	]);
	expect(run.end()).toEqual(["u2", "u3", "u4"]);
});

test("Eumenes host: when the reply fails after taking words, they get the next reply; the target is closed", async () => {
	const pending: Promise<void>[] = [];
	let fail = true;
	const opened: string[] = [];
	const inbox = inboxPort();
	const counted: SteerInboxPort = {
		open(targetId, generation) {
			opened.push(targetId);
			return inbox.open(targetId, generation);
		},
	};
	const events: AgendaHostEvent[] = [];
	const docs = createMockDocStore();
	const agent = createAgendaAgent({
		llm: quietModel,
		startedAt: 0,
		notes: docs.list,
	});
	let calls = 0;
	const host = createAgendaHost({
		agent,
		notes: { read: (id) => docs.read(id), list: () => docs.list() },
		research: { start: () => true },
		addedWords: createAgendaReplySteering({
			inbox: counted,
			read: (id) =>
				agent.view().said.find((s) => s.id === id && s.who === "user")?.text ??
				null,
			now: () => 1_000,
		}),
		reply: async (a, tools, steer) => {
			const chat: ReplyPort = {
				complete() {
					calls++;
					if (calls === 1) {
						pending.push(host.say("やっぱり塩で"));
						return Promise.resolve({
							text: "",
							toolCalls: [{ id: "c1", name: READ_NOTE, arguments: "{}" }],
						});
					}
					// The call that took the words fails: no reply comes out of it.
					if (fail) {
						fail = false;
						return Promise.reject(new Error("connection"));
					}
					return Promise.resolve({
						text: "塩なら、あの店です。",
						toolCalls: [],
					});
				},
			};
			const r = await runRespond({
				messages: [system, userLine],
				chat: steer(chat),
				tools,
				emotion: false,
				signal,
				onDelta: () => undefined,
			});
			return { text: r.text, calls: r.calls };
		},
		now: () => 1_000,
		setTimer: () => 0,
		clearTimer: () => undefined,
		emit: (e) => events.push(e),
		idPrefix: "ve",
	});
	await host.say("ラーメンのメモある？");
	await Promise.all(pending);
	await host.flush();
	expect(
		events
			.filter((e) => e.type === "reply" || e.type === "error")
			.map((e) => e.type),
	).toEqual(["error", "reply"]);
	expect(events.find((e) => e.type === "reply")).toMatchObject({
		text: "塩なら、あの店です。",
	});
	// Each reply's target was closed: the same ids can open again.
	for (const id of opened) expect(inbox.open(id, "1").status).toBe("opened");
	host.close();
});
