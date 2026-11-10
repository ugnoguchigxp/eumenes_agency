/** Review fixes in the mock Eumenes pieces: note files, the researcher, the note parser. */
import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMockDocStore } from "../../examples/virtual-eumenes/agenda/docs.ts";
import {
	createMockWebResearch,
	fixedWriter,
} from "../../examples/virtual-eumenes/agenda/research.ts";
import { parseNote } from "../../standalone/agenda-research.ts";

test("note files: a broken or misnamed header is skipped; an edit keeps what it does not change", () => {
	const dir = mkdtempSync(join(tmpdir(), "agenda-notes-"));
	const docs = createMockDocStore({ dir });
	const n = docs.save({
		title: "題",
		summary: "要約",
		markdown: "本文",
		refs: ["u1"],
		at: 1,
	});
	writeFileSync(join(dir, "broken.md"), "<!-- agenda-note {not json} -->\nx");
	writeFileSync(
		join(dir, "n9.md"),
		`<!-- agenda-note ${JSON.stringify({ id: "../escape", title: "t", summary: "s", at: 0, refs: [] })} -->\nx`,
	);
	const again = createMockDocStore({ dir });
	expect(again.list().map((x) => x.id)).toEqual([n.id]);
	again.edit(n.id, { markdown: "直した" });
	expect(again.read(n.id)).toMatchObject({
		title: "題",
		summary: "要約",
		markdown: "直した",
	});
	expect(() => again.edit("../x", { markdown: "y" })).not.toThrow();
});

test("a note that cannot be saved comes back as a failed research, not a stuck one", async () => {
	const docs = createMockDocStore();
	const broken = {
		...docs,
		save: () => {
			throw new Error("disk full");
		},
	};
	const r = createMockWebResearch({
		writer: fixedWriter,
		docs: broken,
		delayMs: 0,
	});
	expect(r.start({ id: "t1", text: "A", refs: [] }, 0)).toBe(true);
	expect(await r.due(0)).toMatchObject({
		ticketId: "t1",
		status: "failed",
		error: "disk full",
	});
	expect(r.running()).toBe(false);
});

test("the note parser takes the separator only on the third line", () => {
	expect(parseNote("題: A\n要約: B\n---\n本文\n---\n続き")).toEqual({
		title: "A",
		summary: "B",
		markdown: "本文\n---\n続き",
	});
	expect(parseNote("題: A\n要約: B\n本文\n---\n続き").markdown).toBe(
		"本文\n---\n続き",
	);
});

test("the reply's earlier tool calls come back in its history as its own", async () => {
	const { createAgendaAgent } = await import("../../src/agenda/index.ts");
	const { agendaReplyMessages } =
		await import("../../standalone/agenda-reply.ts");
	const llm = { complete: () => Promise.reject(new Error("unused")) };
	const agent = createAgendaAgent({ llm, startedAt: 0 });
	agent.observe({ id: "u1", who: "user", text: "明日は京都。おやすみ", at: 0 });
	agent.observe({
		id: "r1",
		who: "reply",
		text: "おやすみなさい。調べておきますね。",
		at: 0,
		calls: [
			{
				name: "start_preparation",
				arguments: '{"request":"京都","askedByUser":false}',
				content: "started: 調べ始めた",
			},
		],
	});
	agent.observe({ id: "u2", who: "user", text: "おはよう！", at: 1 });
	const m = agendaReplyMessages({
		agent,
		known: [],
		notes: [],
		clock: null,
		now: 1,
	});
	expect(m.slice(-5).map((x) => x.role)).toEqual([
		"user",
		"assistant",
		"tool",
		"assistant",
		"user",
	]);
	expect(m.at(-4)!.tool_calls![0]!.function.name).toBe("start_preparation");
	expect(m.at(-3)).toMatchObject({
		content: "started: 調べ始めた",
		tool_call_id: "r1_0",
	});
});

test("a sentence the reply said twice (before and after a tool) is said once", async () => {
	const { dropRepeatedSentences } =
		await import("../../standalone/agenda-reply.ts");
	expect(
		dropRepeatedSentences(
			"おやすみなさい。明日の朝まで話しかけないでおきます。おやすみなさい。京都、楽しんできてね。明日の朝まで話しかけないでおきます。",
		),
	).toBe(
		"おやすみなさい。明日の朝まで話しかけないでおきます。京都、楽しんできてね。",
	);
});

test("back after a while: the reply is told first what was finished meanwhile", async () => {
	const { createAgendaAgent } = await import("../../src/agenda/index.ts");
	const { agendaReplyMessages } =
		await import("../../standalone/agenda-reply.ts");
	const agent = createAgendaAgent({
		llm: { complete: () => Promise.reject(new Error("unused")) },
		startedAt: 0,
	});
	agent.observe({ id: "u1", who: "user", text: "おやすみ", at: 0 });
	agent.observe({
		id: "u2",
		who: "user",
		text: "おはよう！",
		at: 8 * 3_600_000,
	});
	const notes = [
		{ id: "n1", title: "京都", summary: "早朝に回る", at: 120_000, refs: [] },
	];
	const m = agendaReplyMessages({
		agent,
		known: [],
		notes,
		clock: "11/8(日) 6:30",
		now: 8 * 3_600_000,
	});
	expect(m[1]!.content).toContain(
		'"whileAway":{"hoursSinceYourLastWords":8,"finishedMeanwhile":[{"id":"n1"',
	);
});

test("the reply sees when each note was made, so it knows what it said before that was true", async () => {
	const { createAgendaAgent } = await import("../../src/agenda/index.ts");
	const { agendaReplyMessages } =
		await import("../../standalone/agenda-reply.ts");
	const agent = createAgendaAgent({
		llm: { complete: () => Promise.reject(new Error("unused")) },
		startedAt: 0,
	});
	agent.observe({ id: "u1", who: "user", text: "メモできた？", at: 600_000 });
	const notes = [
		{ id: "n1", title: "京都", summary: "早朝に回る", at: 420_000, refs: [] },
	];
	const m = agendaReplyMessages({
		agent,
		known: [],
		notes,
		clock: null,
		now: 600_000,
	});
	expect(m[1]!.content).toContain('"madeMinutesAgo":3');
});

test("the reply always sees the note behind a topic the agent brought up itself", async () => {
	const { createAgendaAgent } = await import("../../src/agenda/index.ts");
	const { agendaReplyMessages } =
		await import("../../standalone/agenda-reply.ts");
	const notes = Array.from({ length: 9 }, (_, k) => ({
		id: `n${k + 1}`,
		title: `メモ${k + 1}`,
		summary: `要約${k + 1}`,
		at: k * 1_000,
		refs: [],
	}));
	const agent = createAgendaAgent({
		startedAt: 0,
		notes: () => notes,
		llm: {
			complete: <T>(req: {
				system: string;
				schema: { parse: (v: unknown) => T };
			}) =>
				Promise.resolve({
					value: req.schema.parse(
						req.system.includes("この呼び出しは「計画」")
							? {
									add: [
										{
											kind: "talk",
											text: "口パクの話",
											refs: ["note:n1"],
											value: 3,
											reason: "r",
										},
									],
									drop: [],
								}
							: {
									utterance: "口パクのメモがあります。",
									emotion: "🙂",
									decline: null,
								},
					),
					model: "scripted",
					inputTokens: 1,
					outputTokens: 1,
					cacheReadTokens: 0,
					latencyMs: 1,
				}),
		},
	});
	const out = await agent.step(
		10_000,
		() => ({ busy: false }),
		new AbortController().signal,
	);
	const t = out.tickets.find((x) => x.kind === "speak")!;
	agent.recordDelivery({ ticketId: t.id, at: 10_000, status: "succeeded" });
	agent.observe({ id: "u1", who: "user", text: "興味ないです", at: 20_000 });
	const m = agendaReplyMessages({
		agent,
		known: [],
		notes,
		clock: null,
		now: 20_000,
	});
	// n1 is the oldest of nine, and the user's words share nothing with it: it is in view only
	// because the agent itself brought it up.
	expect(m[1]!.content).toContain('"id":"n1"');
});

test("Eumenes' way of handing work over: find a toolchain that fits, delegate to it, a TODO comes back", async () => {
	const { createAgendaAgent } = await import("../../src/agenda/index.ts");
	const { createAgendaReplyTools } =
		await import("../../standalone/agenda-reply.ts");
	const { mockToolchainWork } =
		await import("../../examples/virtual-eumenes/agenda/research.ts");
	const agent = createAgendaAgent({
		llm: { complete: () => Promise.reject(new Error("unused")) },
		startedAt: 0,
	});
	agent.observe({ id: "u1", who: "user", text: "いいね、作ってみて", at: 0 });
	const tools = createAgendaReplyTools({
		agent,
		read: () => null,
		now: () => 0,
	});
	const call = async (name: string, args: unknown) =>
		JSON.parse(
			(
				await tools.call(
					{ id: "c", name, arguments: JSON.stringify(args) },
					new AbortController().signal,
				)
			).content as string,
		) as Record<string, unknown>;
	// The mocked catalog always has one that fits what is asked.
	const found = await call("find_toolchain", {
		query: "ジョギングの距離を記録するアプリを作る",
	});
	const [toolchain] = found["candidates"] as {
		toolchain: string;
		description: string;
	}[];
	expect(toolchain!.description).toContain(
		"ジョギングの距離を記録するアプリを作る",
	);
	// A toolchain it has not found is not one to hand work to.
	expect(
		await call("delegate", {
			mode: "execute",
			toolchain: "video.generate",
			request: "x",
			impact: "y",
		}),
	).toMatchObject({ status: "error", error: "unknown_toolchain" });
	// What the user has not said yes to waits for their word.
	expect(
		await call("delegate", {
			mode: "confirm",
			toolchain: toolchain!.toolchain,
			request: "ジョギングの距離を記録するアプリ",
			impact: "アプリが届く",
		}),
	).toMatchObject({ status: "error", error: "needs_user_confirmation" });
	const done = await call("delegate", {
		mode: "execute",
		toolchain: toolchain!.toolchain,
		request: "ジョギングの距離を記録するアプリ",
		impact: "アプリが届く",
	});
	expect(done).toMatchObject({ status: "accepted", revision: 1 });
	expect(agent.view().items.find((i) => i.id === done["todo"])).toMatchObject({
		kind: "research",
		delegatedTo: toolchain!.toolchain,
		requested: true,
	});
	// The work is mocked: a note that says what was done.
	expect(
		(await mockToolchainWork("ジョギングの距離を記録するアプリ", "mock.x"))
			.summary,
	).toContain("（mock）mock.x");
});

test("review 2026-11-10: the tool says research was taken, not started; the reply sees one that failed", async () => {
	const { createAgendaAgent } = await import("../../src/agenda/index.ts");
	const { createAgendaReplyTools, agendaReplyMessages } =
		await import("../../standalone/agenda-reply.ts");
	const agent = createAgendaAgent({
		llm: { complete: () => Promise.reject(new Error("unused")) },
		startedAt: 0,
	});
	agent.observe({ id: "u1", who: "user", text: "京都の朝を調べて", at: 0 });
	const tools = createAgendaReplyTools({
		agent,
		read: () => null,
		now: () => 0,
	});
	const r = await tools.call(
		{
			id: "c",
			name: "start_preparation",
			arguments: JSON.stringify({ request: "京都の朝", askedByUser: true }),
		},
		new AbortController().signal,
	);
	expect(r.content).toStartWith("accepted: 頼んだ");
	expect(agent.view().items[0]).toMatchObject({ status: "open" });
	const out = await agent.step(
		0,
		() => ({ busy: true }),
		new AbortController().signal,
	);
	agent.researchReturned({
		ticketId: out.tickets[0]!.id,
		at: 60_000,
		status: "failed",
		note: null,
	});
	const m = agendaReplyMessages({
		agent,
		known: [],
		notes: [],
		clock: null,
		now: 60_000,
	});
	expect(m[1]!.content).toContain('"status":"調べられなかった"');
});

test("review 2026-11-10: the CLI's snapshot file is written when it changed and set aside when it does not parse", async () => {
	const { openSnapshotFile } =
		await import("../../examples/virtual-eumenes/agenda/state-file.ts");
	const { createAgendaAgent } = await import("../../src/agenda/index.ts");
	const {
		existsSync,
		mkdtempSync,
		readFileSync,
		rmSync,
		statSync,
		writeFileSync,
	} = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const dir = mkdtempSync(join(tmpdir(), "agenda-state-"));
	try {
		const path = join(dir, "sub", "agenda-state.json");
		const empty = openSnapshotFile(path);
		expect(empty).toMatchObject({ loaded: null, problem: null });
		const llm = { complete: () => Promise.reject(new Error("unused")) };
		const a = createAgendaAgent({ llm, startedAt: 0 });
		a.observe({ id: "u1", who: "user", text: "京都の朝を調べて", at: 0 });
		a.requestResearch({ text: "京都の朝", at: 0 });
		empty.save(a.snapshot(1));
		const written = statSync(path).mtimeMs;
		// The same promises at a later time: nothing to write.
		empty.save(a.snapshot(2));
		expect(statSync(path).mtimeMs).toBe(written);
		const back = openSnapshotFile(path);
		expect(back.loaded?.items.map((i) => i.text)).toEqual(["京都の朝"]);
		const b = createAgendaAgent({ llm, startedAt: 3, restore: back.loaded! });
		expect(b.view().items.map((i) => i.text)).toEqual(["京都の朝"]);
		writeFileSync(path, "{ broken");
		const bad = openSnapshotFile(path);
		expect(bad.loaded).toBeNull();
		expect(bad.problem).not.toBeNull();
		expect(existsSync(path)).toBe(false);
		expect(readFileSync(`${path}.bad`, "utf8")).toBe("{ broken");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a reply that follows a note's summary closely has talked about it", async () => {
	const { notesMentioned } = await import("../../standalone/agenda-reply.ts");
	const notes = [
		{
			id: "n1",
			title: "京都日帰りの準備のコツ",
			summary: "見どころの優先順位と移動の段取りを先に決めておくと回りやすい",
			at: 0,
			refs: [],
		},
		{
			id: "n2",
			title: "辛いラーメンの店選び",
			summary: "辛さの段階で選ぶ",
			at: 0,
			refs: [],
		},
	];
	expect(
		notesMentioned(
			"メモができています。見どころの優先順位と移動の段取りを先に決めておくと回りやすいそうです。",
			notes,
		),
	).toEqual(["n1"]);
});
