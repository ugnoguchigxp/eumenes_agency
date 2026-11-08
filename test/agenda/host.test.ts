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
