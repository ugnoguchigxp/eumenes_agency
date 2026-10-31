import { describe, expect, test } from "bun:test";
import { systemPrompt } from "../../src/application/prompts.ts";
import { createAgencyRuntime } from "../../src/application/runtime.ts";
import { reportedTodoIds } from "../../src/application/todos.ts";
import type { HostTodo } from "../../src/contracts/model.ts";
import { defaultBudget } from "../../src/contracts/runtime.ts";
import {
	MIN,
	b1Proposal,
	defaultLimits,
	fakeLlm,
	obsInput,
	opportunity,
	participation,
	toWire,
} from "./helpers.ts";

const sig = () => new AbortController().signal;
const song: HostTodo = {
	id: "w1",
	title: "楽曲の生成（夜のドライブ向け）",
	status: "done",
	outcome: "succeeded",
	result: "3分12秒の曲",
	nextActions: ["再生する"],
	requestedAt: 0,
	doneAt: 9 * MIN,
};
const image: HostTodo = {
	id: "w2",
	title: "画像の生成",
	status: "todo",
	requestedAt: 5 * MIN,
};

const run = async (o: {
	hostTodos?: boolean;
	todos?: readonly HostTodo[];
	trigger?: "idle" | "turn_end" | "result_received";
	select?: ReturnType<typeof participation>;
}) => {
	const llm = fakeLlm();
	const rt = createAgencyRuntime({
		systemContext: "experimental",
		condition: "B1",
		llm,
		tools: [],
		budget: { ...defaultBudget, minIntervalMs: 0 },
		limits: { ...defaultLimits, outboundIntervalMs: 0 },
		...(o.hostTodos === undefined ? {} : { hostTodos: o.hostTodos }),
	});
	rt.observe(
		obsInput("o1", "user.report", "user", 0, "夜のドライブ向けの曲を作って"),
	);
	// hostTodos asks the update for reportedTodos too.
	llm.push(
		"update",
		o.hostTodos
			? { ...toWire(b1Proposal([])), reportedTodos: [] }
			: b1Proposal([]),
	);
	llm.push("select", o.select ?? participation());
	const d = await rt.decide(
		opportunity("op0", 10 * MIN, {
			trigger: o.trigger ?? "result_received",
			...(o.todos ? { todos: o.todos } : {}),
		}),
		sig(),
	);
	return { d, select: llm.requests.find((r) => r.purpose === "select") };
};

describe("hostTodos (work reports)", () => {
	test("absent or false: prompts are unchanged and Opportunity.todos is ignored", async () => {
		const off = await run({ todos: [song] });
		expect(off.select).toBeUndefined(); // no notes, no todos mode: gate stays shut
		expect(off.d.decision.reason).toContain("nothing to offer");
		expect(systemPrompt("select", "B1")).not.toContain("依頼された仕事");
		expect(systemPrompt("select", "B1", { hostTodos: false })).toBe(
			systemPrompt("select", "B1"),
		);
	});

	test("a done item opens the gate and is rendered with result and next actions", async () => {
		const r = await run({ hostTodos: true, todos: [image, song] });
		expect(r.select?.system).toContain("【依頼された仕事】");
		const p = r.select?.prompt ?? "";
		expect(p).toContain(
			'[todo:w1] 完了（成功）: "楽曲の生成（夜のドライブ向け）" / 結果: "3分12秒の曲" / 次にできること: "再生する" / 依頼: 10分前・完了: 1分前',
		);
		expect(p).toContain('[todo:w2] 進行中: "画像の生成" / 依頼: 5分前');
		// done first
		expect(p.indexOf("[todo:w1]")).toBeLessThan(p.indexOf("[todo:w2]"));
		expect(p).toContain("雑談より先にその報告を選ぶ");
	});

	test("open items alone do not open the gate", async () => {
		const r = await run({ hostTodos: true, todos: [image] });
		expect(r.select).toBeUndefined();
	});

	test("a report citing todo:<id> is accepted and the host can read the reported ids", async () => {
		const r = await run({
			hostTodos: true,
			todos: [song],
			select: participation({
				action: "speak",
				utterance: "さっき頼まれていた曲、できたよ。すぐ再生する？",
				evidenceRefs: ["todo:w1"],
			}),
		});
		expect(r.d.decision.action).toBe("speak");
		expect(reportedTodoIds(r.d.decision.evidenceRefs)).toEqual(["w1"]);
		// an item that was not presented is unknown
		const bogus = await run({
			hostTodos: true,
			todos: [song],
			select: participation({
				action: "speak",
				utterance: "x",
				evidenceRefs: ["todo:w9"],
			}),
		});
		expect(bogus.d.decision.rejectCodes).toContain("unknown_ref");
	});

	test("reportedTodoIds keeps only todo refs, once", () => {
		expect(
			reportedTodoIds(["o1", "todo:a", "todo:a", "memory:t1", "todo:"]),
		).toEqual(["a"]);
	});

	test("an errand is shown only inside its reminder window, first and with its deadline", async () => {
		const errand: HostTodo = {
			id: "e1",
			kind: "errand",
			title: "大家さんへ更新書類を返送",
			status: "todo",
			requestedAt: 0,
			remindFrom: 5 * MIN,
			dueAt: 40 * MIN,
		};
		// the opportunity is at 10 min: inside [5, 40)
		const inside = await run({
			hostTodos: true,
			todos: [song, errand],
			trigger: "idle",
		});
		const p = inside.select?.prompt ?? "";
		expect(p).toContain(
			'[todo:e1] 用事: "大家さんへ更新書類を返送" / 期限: 30分後',
		);
		expect(p.indexOf("[todo:e1]")).toBeLessThan(p.indexOf("[todo:w1]"));
		// before the window, and once the deadline passed: not shown, and alone it opens no select
		for (const shifted of [
			{ ...errand, remindFrom: 20 * MIN },
			{ ...errand, dueAt: 10 * MIN },
		]) {
			const out = await run({
				hostTodos: true,
				todos: [shifted],
				trigger: "idle",
			});
			expect(out.select).toBeUndefined();
		}
		const alone = await run({
			hostTodos: true,
			todos: [errand],
			trigger: "idle",
		});
		expect(alone.select?.prompt).toContain("[todo:e1]");
	});
});

const waiting: HostTodo = {
	id: "w3",
	title: "ロゴ画像の生成",
	status: "waiting",
	question: "背景は白と黒のどちらにしますか？",
	requestedAt: 2 * MIN,
};

describe("hostTodos: a waiting item (the sub-agent asked a question)", () => {
	test("is rendered before done items with its question and opens the gate", async () => {
		const r = await run({
			hostTodos: true,
			todos: [image, song, waiting],
			trigger: "result_received",
		});
		const p = r.select?.prompt ?? "";
		expect(p).toContain(
			'[todo:w3] 質問待ち: "ロゴ画像の生成" / 質問: "背景は白と黒のどちらにしますか？" / 依頼: 8分前',
		);
		expect(p.indexOf("[todo:w3]")).toBeLessThan(p.indexOf("[todo:w1]"));
		expect(p).toContain("その質問を選ぶ");
		expect(r.select?.system).toContain("【仕事の質問】");
		const alone = await run({ hostTodos: true, todos: [waiting] });
		expect(alone.select).toBeDefined();
	});

	test("prompts are unchanged while no waiting item is present", async () => {
		const r = await run({ hostTodos: true, todos: [image, song] });
		expect(r.select?.system).not.toContain("【仕事の質問】");
		expect(r.select?.prompt).not.toContain("質問待ち");
		expect(r.select?.prompt).not.toContain("その質問を選ぶ");
	});

	test("a waiting item without a question is not shown", async () => {
		const { question: _q, ...noQuestion } = waiting;
		const r = await run({ hostTodos: true, todos: [noQuestion] });
		expect(r.select).toBeUndefined();
	});

	test("citing it is accepted by the validation (the host never archives it)", async () => {
		const r = await run({
			hostTodos: true,
			todos: [waiting],
			select: participation({
				action: "speak",
				utterance: "ロゴの背景、白と黒のどっちがいい？",
				evidenceRefs: ["todo:w3"],
			}),
		});
		expect(r.d.decision.action).toBe("speak");
		expect(reportedTodoIds(r.d.decision.evidenceRefs)).toEqual(["w3"]);
	});
});

describe("hostTodos: reconciling a normal reply with a finished item", () => {
	const reportRun = async (o: {
		todos: readonly HostTodo[];
		reports: unknown[];
		observe?: boolean;
		hostTodos?: boolean;
	}) => {
		const llm = fakeLlm();
		const rt = createAgencyRuntime({
			systemContext: "experimental",
			condition: "B1",
			llm,
			tools: [],
			budget: { ...defaultBudget, minIntervalMs: 0 },
			limits: { ...defaultLimits, outboundIntervalMs: 0 },
			...(o.hostTodos === false
				? {}
				: { hostTodos: true, todos: () => o.todos }),
		});
		rt.observe(obsInput("u1", "user.report", "user", 8 * MIN, "曲はどう？"));
		if (o.observe !== false)
			rt.observe(
				obsInput(
					"r1",
					"exchange.adopted",
					"agent",
					10 * MIN,
					"曲、できているよ。",
				),
			);
		llm.push("update", {
			...toWire(b1Proposal([])),
			reportedTodos: o.reports,
		});
		const outcomes = await rt.runBackground(11 * MIN, sig());
		return { rt, llm, outcomes };
	};

	test("a shown done item conveyed by an agent reply is reported once, then drained", async () => {
		const { rt, llm, outcomes } = await reportRun({
			todos: [song, image],
			reports: [{ todoId: "w1", observationRef: "r1" }],
		});
		expect(outcomes.at(-1)?.code).not.toMatch(/^rejected/);
		const req = llm.requests.find((r) => r.purpose === "update");
		expect(req?.system).toContain("【仕事の報告の照合】");
		expect(req?.prompt).toContain("# 依頼された仕事");
		expect(req?.prompt).toContain("[todo:w1] 完了（成功）");
		expect(rt.takeReportedTodos()).toEqual([
			{ todoId: "w1", observationId: "r1" },
		]);
		expect(rt.takeReportedTodos()).toEqual([]);
	});

	test("the todo: prefix is accepted", async () => {
		const { rt } = await reportRun({
			todos: [song],
			reports: [{ todoId: "todo:w1", observationRef: "r1" }],
		});
		expect(rt.takeReportedTodos()).toEqual([
			{ todoId: "w1", observationId: "r1" },
		]);
	});

	test("refs that were not shown, unfinished items, unknown or non-agent observations are dropped", async () => {
		const { rt } = await reportRun({
			todos: [song, image, waiting],
			reports: [
				{ todoId: "w9", observationRef: "r1" }, // not shown
				{ todoId: "w2", observationRef: "r1" }, // still running
				{ todoId: "w3", observationRef: "r1" }, // waiting for the user
				{ todoId: "w1", observationRef: "r9" }, // no such observation
				{ todoId: "w1", observationRef: "u1" }, // a user observation
			],
		});
		expect(rt.takeReportedTodos()).toEqual([]);
	});

	test("a reply from before the item was done does not report it", async () => {
		const { rt } = await reportRun({
			todos: [{ ...song, doneAt: 10 * MIN + 1 }],
			reports: [{ todoId: "w1", observationRef: "r1" }],
		});
		expect(rt.takeReportedTodos()).toEqual([]);
	});

	test("errands are not reportable", async () => {
		const errand: HostTodo = {
			id: "e1",
			kind: "errand",
			title: "返送",
			status: "done",
			requestedAt: 0,
			doneAt: 0,
		};
		const { rt, llm } = await reportRun({
			todos: [errand],
			reports: [{ todoId: "e1", observationRef: "r1" }],
		});
		expect(rt.takeReportedTodos()).toEqual([]);
		expect(llm.requests[0]?.prompt).not.toContain("todo:e1");
	});

	test("outside hostTodos mode the schema, prompt and reports are as before", async () => {
		const llm = fakeLlm();
		const rt = createAgencyRuntime({
			systemContext: "experimental",
			condition: "B1",
			llm,
			tools: [],
			budget: { ...defaultBudget, minIntervalMs: 0 },
			todos: () => [song],
		});
		rt.observe(obsInput("u1", "user.report", "user", 0, "曲を作って"));
		llm.push("update", b1Proposal([]));
		await rt.runBackground(11 * MIN, sig());
		const req = llm.requests[0];
		expect(req?.prompt).not.toContain("依頼された仕事");
		expect(req?.system).toBe(systemPrompt("update", "B1"));
		expect(rt.takeReportedTodos()).toEqual([]);
		expect(systemPrompt("update", "B1", { hostTodos: true })).toContain(
			"reportedTodos",
		);
		expect(systemPrompt("update", "B1")).not.toContain("reportedTodos");
	});
});
