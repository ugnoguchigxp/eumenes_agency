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
											topic: "",
										},
									],
									drop: [],
									focus: "",
								}
							: {
									utterance: "口パクのメモがあります。",
									emotion: "🙂",
									decline: null,
									questions: 1,
									choice: false,
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

test("review 2026-11-10 §3: soft words get a short pause whatever length the model names; a length said is kept", async () => {
	const { createAgendaAgent, SOFT_QUIET_MIN, DEFAULT_QUIET_MIN } =
		await import("../../src/agenda/index.ts");
	const { createAgendaReplyTools } =
		await import("../../standalone/agenda-reply.ts");
	const agent = createAgendaAgent({
		llm: { complete: () => Promise.reject(new Error("unused")) },
		startedAt: 0,
	});
	const set: { scope: string; minutes: number }[] = [];
	const tools = createAgendaReplyTools({
		agent,
		read: () => null,
		now: () => 0,
		events: { onQuiet: (q) => set.push(q) },
	});
	const quiet = (args: Record<string, unknown>) =>
		tools.call(
			{ id: "c", name: "set_quiet", arguments: JSON.stringify(args) },
			new AbortController().signal,
		);
	// The model's 720 minutes for «今日はそっとしておいて» become the short pause.
	const soft = await quiet({ scope: "speech", kind: "soft", minutes: 720 });
	expect(soft.content).toContain(`${SOFT_QUIET_MIN}分の短い一時停止`);
	expect(agent.view().quiet.speechUntil).toBe(SOFT_QUIET_MIN * 60_000);
	await quiet({ scope: "speech", kind: "asked" });
	expect(agent.view().quiet.speechUntil).toBe(DEFAULT_QUIET_MIN * 60_000);
	await quiet({ scope: "all", kind: "said", minutes: 30 });
	expect(agent.view().quiet.allUntil).toBe(30 * 60_000);
	// Leaving needs its length (おやすみ: till morning); without it nothing is set.
	const leaving = await quiet({ scope: "speech", kind: "leaving" });
	expect(leaving.content).toStartWith("refused: minutes_needed");
	// Older callers without kind name a length.
	await quiet({ scope: "speech", minutes: 45 });
	expect(agent.view().quiet.speechUntil).toBe(45 * 60_000);
	await quiet({ scope: "speech", kind: "said", minutes: 0 });
	expect(agent.view().quiet).toMatchObject({
		speechUntil: null,
		allUntil: null,
	});
	expect(set.map((q) => q.minutes)).toEqual([
		SOFT_QUIET_MIN,
		DEFAULT_QUIET_MIN,
		30,
		45,
		0,
	]);
	// A model that writes minutes: null for soft words still gets its pause.
	await quiet({ scope: "speech", kind: "soft", minutes: null });
	expect(agent.view().quiet.speechUntil).toBe(SOFT_QUIET_MIN * 60_000);
	expect((await quiet({ scope: "speech", kind: "later" })).content).toBe(
		"refused: invalid_arguments",
	);
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

test("CLI 2026-11-10: a note from an earlier session is in view when the user asks for it among notes that share more letters", async () => {
	const { relevantNotes } = await import("../../standalone/agenda-reply.ts");
	const note = (id: string, title: string, summary: string, at: number) => ({
		id,
		title,
		summary,
		at,
		refs: [],
	});
	const newest = [73, 74, 75, 76, 77, 78].map((k) =>
		note(`n${k}`, `辻堂の上映時間 ${k}`, "", 1_000 + k),
	);
	// The notes that shared letters with the line, as they were (titles and summaries).
	const older = [
		note(
			"n68",
			"Claude Fable 5.2の公開リリース確認（2026年11月9日）",
			"Claude Fable 5.2は2026年11月9日（月）に公開され、有料プランとClaude Platform・Claude Codeで使えるようになったと、Anthropicの公式ページと公式Xアカウントで確認できた。「Fable5.2」は、Anthropicの「Claude Fable 5.2」を指すと判断した。",
			0,
		),
		note(
			"n48",
			"GPT-6.2 Astra のリリース状況（2026/11/10時点）",
			"GPT-6.2 Astra について、OpenAIによる公式発表は確認できなかった。Codexの利用画面やGoogle Cloudのクォータページに現れたという非公式の痕跡と、報道ベースの「金曜リリース」観測があるが、いずれも未確認。",
			1,
		),
		note(
			"n38",
			"七里ヶ浜の地名の由来と、ジョギングで見たい海岸の特徴",
			"地名の由来は「7里あるから」という説が一般的ですが、距離が合わないため別の説も出ています。海岸は約2.9kmの直線状で、眺望と波の景色が見どころです。",
			2,
		),
		note(
			"n33",
			"Qwen4のリリース時期の確認状況（2026年11月9日時点）",
			"Qwen4は2026年11月7日時点で未公開で、Alibabaは発売日を公表していません。公式に確認できたのは「学習中」とプレビュー版の存在までで、「来週発売」や具体的なモデル構成は伝聞または噂の段階です。",
			3,
		),
		note(
			"n1",
			"Qwen4のリリース状況（確定情報と未確認の噂）",
			"2026/11/8時点で、Qwen4はまだ公開されておらず、公式な発表日もありません。確定しているのは「開発中であること」と「Qwen3.8-Flash-Nextが先行プレビューであること」だけです。「来週リリース」などの話は参加者の報告で、Alibabaは確認していません。",
			4,
		),
		note(
			"n67",
			"2026年11月前半のAIエージェント・Qwen関連ニュース（自律行動・安全性の話題中心）",
			"自律的に動くAIエージェントは、製品投入と同時にセキュリティ事故や制御の難しさも目立ってきた。Qwenについては、Cohereが報告したエージェントの予期しない外部通信が注目されているが、2026年11月に出たQwen本体の新発表は今回の検索では確認できなかった。",
			5,
		),
		note(
			"n10",
			"Qwen4の時期に関する言及の確認（2026年11月8日以降）",
			"2026年11月8日以降にAlibabaまたはQwenチームがQwen4の時期に言及したことは、検索では確認できなかった。公式の目安時期は示されていないため、確定的な時期は言えない。",
			6,
		),
		note(
			"n7",
			"GPT-6.2 Astra の噂と公開状況（2026年11月9日時点）",
			"GPT-6.2 Astra は、2026年11月9日時点で公式発表もリリースも確認できていません。Codex の利用画面に出た識別子が噂の出どころで、信頼性は低いと判断します。",
			7,
		),
		note(
			"n63",
			"Qwen4のリリース時期は未発表（2026/11/10時点）",
			"2026/11/10時点で、Qwen4の公開日はAlibabaから発表されておらず、モデルも公開されていないことを確認できませんでした。公式が確認しているのは「開発中」で「近いうちに」という表現までで、「来週」などの報道は未確認です。",
			8,
		),
	];
	const seen = relevantNotes(
		[...older, ...newest],
		"ところでさっき、Fable5.2のまえにAIニュース調べてといったはずですが、調べてある？",
	).map((n) => n.id);
	expect(seen).toContain("n67");
	expect(seen.slice(0, 6)).toEqual(["n78", "n77", "n76", "n75", "n74", "n73"]);
});

test("without the host's toolchains, the reply has neither find_toolchain/delegate nor their rules", async () => {
	const { createAgendaAgent, createAgendaReplyTools, agendaReplyMessages } =
		await import("../../src/agenda/index.ts");
	const agent = createAgendaAgent({
		llm: { complete: () => Promise.reject(new Error("unused")) },
		startedAt: 0,
	});
	const tools = createAgendaReplyTools({
		agent,
		read: () => null,
		now: () => 0,
	});
	expect(tools.tools.map((t) => t.name)).not.toContain("find_toolchain");
	expect(tools.tools.map((t) => t.name)).not.toContain("delegate");
	const bare = agendaReplyMessages({
		agent,
		known: [],
		notes: [],
		clock: null,
		now: 0,
	})[0]!.content;
	expect(bare).not.toContain("find_toolchain");
	const offered = agendaReplyMessages({
		agent,
		known: [],
		notes: [],
		clock: null,
		now: 0,
		toolchains: true,
	})[0]!.content;
	expect(offered).toContain("find_toolchain");
});
