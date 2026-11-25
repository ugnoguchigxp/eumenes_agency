/**
 * Work handed to a toolchain is the agenda agent's own item, like research (spec
 * toolchain-assignment-as-research-2026-11-25): it runs beside the researcher, a quiet does not
 * hold it, its question is asked of the user by the agent, and its end is reported.
 */
import { expect, test } from "bun:test";
import type { LlmPort, LlmRequest } from "../../src/index.ts";
import {
	agendaSnapshotSchema,
	createAgendaAgent,
	RESEARCH_RETRY_MS,
	RESEARCH_TTL_MS,
	type AgendaTicket,
	type NoteRef,
} from "../../src/agenda/index.ts";
import { agendaReplyMessages } from "../../src/agenda/reply.ts";

/** The plan adds nothing, nothing is covered, every utterance is said. */
const quietLlm = (): { llm: LlmPort; kinds: string[] } => {
	const kinds: string[] = [];
	const llm: LlmPort = {
		complete<T>(req: LlmRequest<T>) {
			const kind = req.system.includes("この呼び出しは「計画」")
				? "plan"
				: req.system.includes("重複チェック")
					? "check"
					: req.system.includes("質問の聞き直しチェック")
						? "ask_check"
						: "compose";
			kinds.push(kind);
			const value =
				kind === "plan"
					? { add: [], drop: [], focus: "" }
					: kind === "check"
						? {
								verdict: "new",
								coveredBy: null,
								request: null,
								reason: "新しい",
							}
						: kind === "ask_check"
							? { verdicts: [] }
							: {
									utterance: "お知らせです",
									decline: null,
									emotion: "🙂",
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
	return { llm, kinds };
};

const idle = () => ({ busy: false });
const sig = () => new AbortController().signal;
const research = (tickets: readonly AgendaTicket[]) =>
	tickets.filter(
		(t): t is Extract<AgendaTicket, { kind: "research" }> =>
			t.kind === "research",
	);

const noteStore: NoteRef[] = [];
const setup = () => {
	const m = quietLlm();
	noteStore.length = 0;
	const agent = createAgendaAgent({
		llm: m.llm,
		startedAt: 0,
		notes: () => noteStore,
	});
	agent.observe({ id: "u1", who: "user", text: "Claude Codeで作って", at: 0 });
	agent.observe({ id: "r1", who: "reply", text: "頼みました。", at: 0 });
	return { agent, m };
};
const assign = (
	agent: ReturnType<typeof createAgendaAgent>,
	text = "Live2Dの背景色を設定から変えられるようにする",
	delegatedTo = "claude.code",
) => {
	const r = agent.requestResearch({ text, at: 0, delegatedTo });
	if (!("item" in r)) throw new Error(`rejected: ${r.rejected}`);
	return r;
};
const talks = (agent: ReturnType<typeof createAgendaAgent>) =>
	agent
		.view()
		.items.filter((i) => i.kind === "talk")
		.map((i) => i.text);

test("the same assignee and the same request is refused while open or doing; it does not queue behind the researcher", () => {
	const { agent } = setup();
	const first = assign(agent);
	expect(first.queued).toBe(false);
	expect(
		agent.requestResearch({
			text: " Live2Dの背景色を設定から変えられるようにする ",
			at: 1,
			delegatedTo: "claude.code",
		}),
	).toEqual({ rejected: "duplicate" });
	// Another assignee, or plain research, is not the same work.
	expect(
		agent.requestResearch({
			text: "Live2Dの背景色を設定から変えられるようにする",
			at: 1,
			delegatedTo: "other.tool",
		}),
	).toHaveProperty("item");
	expect(
		agent.requestResearch({
			text: "Live2Dの背景色を設定から変えられるようにする",
			at: 1,
		}),
	).toHaveProperty("item");
});

test("an assignment is issued at once beside a running research, one ticket per item", async () => {
	const { agent, m } = setup();
	const plain = agent.requestResearch({ text: "京都の朝", at: 0 });
	expect("item" in plain && plain.queued).toBe(false);
	const a = assign(agent, "背景色", "claude.code");
	const b = assign(agent, "音声設定", "claude.code");
	const out = await agent.step(0, idle, sig());
	const tickets = research(out.tickets);
	expect(tickets.map((t) => [t.text, t.delegatedTo ?? null])).toEqual([
		["背景色", "claude.code"],
		["音声設定", "claude.code"],
		["京都の朝", null],
	]);
	expect(agent.view().researching?.text).toBe("京都の朝");
	// Nothing was written or planned about the assignments.
	expect(m.kinds.filter((k) => k === "compose")).toEqual([]);
	expect(
		agent
			.view()
			.items.filter((i) => i.id === a.item.id || i.id === b.item.id)
			.map((i) => i.status),
	).toEqual(["doing", "doing"]);
	expect(tickets[0]).toMatchObject({
		kind: "research",
		requested: true,
		refs: ["u1"],
	});
	// The researcher's queue and the plan do not see them.
	const researchLater = agent.requestResearch({ text: "別の調べもの", at: 1 });
	expect("item" in researchLater && researchLater.queued).toBe(true);
});

test("a quiet does not hold an assignment; only the host's stop does", async () => {
	const { agent } = setup();
	agent.setQuiet({ scope: "all", minutes: 30, at: 0 });
	assign(agent);
	expect(agent.nextAt(0)).toBe(0);
	const out = await agent.step(0, idle, sig());
	expect(out.skipped).toBeNull();
	expect(research(out.tickets)).toMatchObject([{ delegatedTo: "claude.code" }]);

	const stopped = setup();
	assign(stopped.agent);
	stopped.agent.setStopped(true);
	const held = await stopped.agent.step(0, idle, sig());
	expect(held.skipped).toBe("stopped");
	expect(held.tickets).toEqual([]);
	stopped.agent.setStopped(false);
	expect(
		research((await stopped.agent.step(0, idle, sig())).tickets),
	).toHaveLength(1);
});

test("a refused start goes back to open and is tried again after the retry time", async () => {
	const { agent } = setup();
	const { item } = assign(agent);
	const out = await agent.step(0, idle, sig());
	const t = research(out.tickets)[0]!;
	agent.researchStarted(t.id, false, 1_000);
	const view = () => agent.view().items.find((i) => i.id === item.id)!;
	expect(view()).toMatchObject({
		status: "open",
		deferUntil: 1_000 + RESEARCH_RETRY_MS,
	});
	expect(research((await agent.step(2_000, idle, sig())).tickets)).toEqual([]);
	const again = await agent.step(1_000 + RESEARCH_RETRY_MS, idle, sig());
	expect(research(again.tickets)).toMatchObject([
		{ itemId: item.id, delegatedTo: "claude.code" },
	]);
	expect(view().status).toBe("doing");
	// An accepted start changes nothing.
	agent.researchStarted(research(again.tickets)[0]!.id, true, 20_000);
	expect(view().status).toBe("doing");
});

test("the researcher's time limit does not end an assignment", async () => {
	const { agent } = setup();
	const { item } = assign(agent);
	await agent.step(0, idle, sig());
	await agent.step(RESEARCH_TTL_MS * 3, idle, sig());
	expect(agent.view().items.find((i) => i.id === item.id)?.status).toBe(
		"doing",
	);
	expect(talks(agent)).toEqual([]);
});

test("a new question is asked of the user once, by a talk item; progress is kept", async () => {
	const { agent } = setup();
	const { item } = assign(agent);
	const t = research((await agent.step(0, idle, sig())).tickets)[0]!;
	const ask = "背景色設定は、どの画面や領域に適用する想定ですか？";
	agent.assignmentObserved({
		ticketId: t.id,
		at: 1_000,
		progress: "実行中です",
		question: null,
	});
	expect(talks(agent)).toEqual([]);
	agent.assignmentObserved({
		ticketId: t.id,
		at: 2_000,
		progress: "質問を待っています",
		question: ask,
	});
	agent.assignmentObserved({
		ticketId: t.id,
		at: 3_000,
		progress: "質問を待っています",
		question: ask,
	});
	const line = `担当（claude.code）から質問:「${ask}」`;
	expect(talks(agent)).toEqual([line]);
	expect(agent.view().items.find((i) => i.id === item.id)).toMatchObject({
		question: ask,
		progress: "質問を待っています",
	});
	expect(agent.view().items.find((i) => i.text === line)).toMatchObject({
		kind: "talk",
		value: 5,
		promised: true,
		refs: ["u1"],
	});
	// It is said on its own.
	// (written ahead of the gap since it last spoke, said when the gap ends)
	await agent.step(10_000, idle, sig());
	const said = await agent.step(100_000, idle, sig());
	expect(said.tickets).toMatchObject([{ kind: "speak", itemKind: "talk" }]);
	// A different question is a new line; an answered one (null) clears the question.
	agent.assignmentObserved({
		ticketId: t.id,
		at: 20_000,
		progress: null,
		question: "別の質問",
	});
	expect(talks(agent)).toHaveLength(2);
	agent.assignmentObserved({
		ticketId: t.id,
		at: 30_000,
		progress: "再開しました",
		question: null,
	});
	expect(agent.view().items.find((i) => i.id === item.id)?.question).toBeNull();
	// The line that was not said yet goes with its question.
	expect(
		agent.view().items.find((i) => i.text.includes("別の質問"))?.status,
	).toBe("dropped");
	// Unknown tickets are ignored.
	agent.assignmentObserved({
		ticketId: "t999",
		at: 40_000,
		progress: "x",
		question: "y",
	});
	expect(talks(agent)).toHaveLength(2);
});

test("a cancelled assignment is dropped without a failure told, and its result is not taken later", async () => {
	const { agent } = setup();
	const { item } = assign(agent);
	const t = research((await agent.step(0, idle, sig())).tickets)[0]!;
	agent.assignmentObserved({
		ticketId: t.id,
		at: 1_000,
		progress: null,
		question: "どの画面？",
	});
	agent.assignmentEnded({ itemId: item.id, at: 5_000, status: "dropped" });
	const ended = agent.view().items.find((i) => i.id === item.id)!;
	expect(ended).toMatchObject({ status: "dropped", endedAt: 5_000 });
	expect(ended.question).toBeUndefined();
	expect(
		talks(agent).filter((x) => x.includes("やり遂げられなかった")),
	).toEqual([]);
	// The question line, not said yet, is gone too.
	expect(talks(agent).length).toBe(1);
	expect(agent.view().items.find((i) => i.kind === "talk")?.status).toBe(
		"dropped",
	);
	// The ticket is no longer waited for.
	const late: NoteRef = {
		id: "n1",
		title: "遅れて来た結果",
		summary: "s",
		at: 6_000,
		refs: [],
	};
	agent.researchReturned({
		ticketId: t.id,
		at: 6_000,
		status: "succeeded",
		note: late,
	});
	expect(agent.view().items.find((i) => i.id === item.id)?.status).toBe(
		"dropped",
	);
	expect(talks(agent)).toHaveLength(1);
	// Ending what is not an open assignment does nothing.
	agent.assignmentEnded({ itemId: "nope", at: 7_000, status: "dropped" });
});

test("a finished assignment becomes done with its note, and the agent reports it on its own", async () => {
	const { agent } = setup();
	const { item } = assign(agent, "背景色を変えられるようにする");
	const t = research((await agent.step(0, idle, sig())).tickets)[0]!;
	agent.assignmentObserved({
		ticketId: t.id,
		at: 1_000,
		progress: "実行中",
		question: "どの画面？",
	});
	const note: NoteRef = {
		id: "n7",
		title: "背景色の設定を足した",
		summary: "設定に項目を追加",
		at: 60_000,
		refs: [],
	};
	noteStore.push(note);
	agent.researchReturned({
		ticketId: t.id,
		at: 60_000,
		status: "succeeded",
		note,
	});
	const done = agent.view().items.find((i) => i.id === item.id)!;
	expect(done).toMatchObject({
		status: "done",
		resultNoteId: "n7",
		endedAt: 60_000,
	});
	expect(done.question).toBeUndefined();
	expect(done.progress).toBeUndefined();
	const report = agent
		.view()
		.items.find((i) => i.kind === "talk" && i.noteId === "n7")!;
	expect(report).toMatchObject({
		text: "頼まれた「背景色を変えられるようにする」を担当（claude.code）が終えた（メモ 背景色の設定を足した）",
		value: 5,
		promised: true,
		refs: ["note:n7", "u1"],
	});
	const spoken: AgendaTicket[] = [];
	for (const now of [70_000, 200_000, 400_000])
		spoken.push(...(await agent.step(now, idle, sig())).tickets);
	expect(spoken).toMatchObject([
		{ kind: "speak", itemKind: "talk", noteId: "n7" },
	]);
});

test("a failed assignment is told as a failure", async () => {
	const { agent } = setup();
	const { item } = assign(agent, "背景色を変える");
	const t = research((await agent.step(0, idle, sig())).tickets)[0]!;
	agent.researchReturned({
		ticketId: t.id,
		at: 1_000,
		status: "failed",
		note: null,
	});
	expect(agent.view().items.find((i) => i.id === item.id)?.status).toBe(
		"failed",
	);
	expect(talks(agent)).toEqual([
		"頼まれた「背景色を変える」は、担当（claude.code）がやり遂げられなかった",
	]);
});

test("delegatedTo, question and progress survive a restart; old snapshots still load", async () => {
	const { agent } = setup();
	const { item } = assign(agent);
	const t = research((await agent.step(0, idle, sig())).tickets)[0]!;
	agent.assignmentObserved({
		ticketId: t.id,
		at: 1_000,
		progress: "実行中",
		question: "どの画面？",
	});
	const snap = agendaSnapshotSchema.parse(
		JSON.parse(JSON.stringify(agent.snapshot(2_000))),
	);
	const kept = snap.items.find((i) => i.id === item.id);
	expect(kept).toMatchObject({
		delegatedTo: "claude.code",
		question: "どの画面？",
		progress: "実行中",
	});
	const m = quietLlm();
	const back = createAgendaAgent({
		llm: m.llm,
		startedAt: 3_000,
		restore: snap,
	});
	expect(back.view().items.find((i) => i.id === item.id)).toMatchObject({
		delegatedTo: "claude.code",
		question: "どの画面？",
		progress: "実行中",
		status: "open",
	});
	// Back in line, it is issued again at the first step.
	back.observe({ id: "u9", who: "user", text: "どう？", at: 3_000 });
	expect(research((await back.step(3_000, idle, sig())).tickets)).toMatchObject(
		[{ itemId: item.id, delegatedTo: "claude.code" }],
	);
	// A snapshot from before the fields existed.
	const old = {
		...snap,
		items: snap.items.map(({ question: _q, progress: _p, ...rest }) => rest),
	};
	expect(() => agendaSnapshotSchema.parse(old)).not.toThrow();
});

test("the reply's state has assignments, with the statuses the reply says them with", async () => {
	const { agent } = setup();
	const wait = assign(agent, "待たされる作業", "a.tool");
	const run = assign(agent, "進める作業", "claude.code");
	const ask = assign(agent, "質問する作業", "claude.code");
	const fin = assign(agent, "終える作業", "claude.code");
	const bad = assign(agent, "失敗する作業", "claude.code");
	const off = assign(agent, "やめる作業", "claude.code");
	const out = await agent.step(0, idle, sig());
	const ticketOf = (id: string) =>
		research(out.tickets).find((t) => t.itemId === id)!;
	// One waits for its retry.
	agent.researchStarted(ticketOf(wait.item.id).id, false, 0);
	agent.assignmentObserved({
		ticketId: ticketOf(run.item.id).id,
		at: 0,
		progress: "Claude Code が実行中です",
		question: null,
	});
	agent.assignmentObserved({
		ticketId: ticketOf(ask.item.id).id,
		at: 0,
		progress: null,
		question: "どの画面？",
	});
	agent.researchReturned({
		ticketId: ticketOf(fin.item.id).id,
		at: 0,
		status: "succeeded",
		note: { id: "n3", title: "できた", summary: "s", at: 0, refs: [] },
	});
	agent.researchReturned({
		ticketId: ticketOf(bad.item.id).id,
		at: 0,
		status: "failed",
		note: null,
	});
	agent.assignmentEnded({ itemId: off.item.id, at: 0, status: "dropped" });

	const messages = agendaReplyMessages({
		agent,
		known: [],
		notes: [],
		clock: null,
		now: 5 * 60_000,
	});
	const text = messages[1]!.content as string;
	const state = JSON.parse(
		text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1),
	) as {
		assignments?: Record<string, unknown>[];
		researching: unknown;
		waitingResearch: unknown[];
		researchLog: unknown[];
	};
	expect(state.assignments).toEqual([
		{
			id: wait.item.id,
			assignee: "a.tool",
			request: "待たされる作業",
			status: "待っている",
			minutesAgo: 5,
			askedByUser: true,
		},
		{
			id: run.item.id,
			assignee: "claude.code",
			request: "進める作業",
			status: "進めている",
			progress: "Claude Code が実行中です",
			minutesAgo: 5,
			askedByUser: true,
		},
		{
			id: ask.item.id,
			assignee: "claude.code",
			request: "質問する作業",
			status: "質問がある",
			question: "どの画面？",
			minutesAgo: 5,
			askedByUser: true,
		},
		{
			id: fin.item.id,
			assignee: "claude.code",
			request: "終える作業",
			status: "終わった（メモ n3 になった）",
			minutesAgo: 5,
			askedByUser: true,
		},
		{
			id: bad.item.id,
			assignee: "claude.code",
			request: "失敗する作業",
			status: "やり遂げられなかった",
			minutesAgo: 5,
			askedByUser: true,
		},
		{
			id: off.item.id,
			assignee: "claude.code",
			request: "やめる作業",
			status: "やめた",
			minutesAgo: 5,
			askedByUser: true,
		},
	]);
	// The researcher's lists are for research only.
	expect(state.researching).toBeNull();
	expect(state.waitingResearch).toEqual([]);
	expect(state.researchLog).toEqual([]);
	expect(messages[0]!.content as string).toContain(
		"状態の assignments にあるときだけです",
	);
});

test("no assignments key when there are none; only the last 3 ended ones are kept, each cut to its head", async () => {
	const { agent } = setup();
	const state = (now: number) => {
		const text = agendaReplyMessages({
			agent,
			known: [],
			notes: [],
			clock: null,
			now,
		})[1]!.content as string;
		return JSON.parse(
			text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1),
		) as {
			assignments?: { request: string }[];
		};
	};
	expect(state(0)).not.toHaveProperty("assignments");
	for (let i = 0; i < 10; i++) {
		const { item } = assign(agent, `作業${i}`);
		agent.assignmentEnded({ itemId: item.id, at: 0, status: "dropped" });
	}
	expect(state(0).assignments?.map((a) => a.request)).toEqual(
		Array.from({ length: 3 }, (_, i) => `作業${i + 7}`),
	);
	assign(agent, "あ".repeat(200));
	const long = state(0).assignments!.find((a) => a.request.startsWith("あ"))!;
	expect(long.request).toBe(`${"あ".repeat(79)}…`);
});

test("an assignment the user sent from a screen rests on that message, with no words heard", () => {
	const { agent } = setup();
	const r = agent.requestResearch({
		text: "絵を描く",
		at: 0,
		delegatedTo: "画像",
		userRef: { id: "form-1" },
	});
	// The item rests on the screen's message, not on the last words heard (u1).
	expect("item" in r && r.item.refs).toEqual(["form-1"]);
});
