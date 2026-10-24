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
	llm.push("update", b1Proposal([]));
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
			"[todo:w1] 完了（成功）: 楽曲の生成（夜のドライブ向け） / 結果: 3分12秒の曲 / 次にできること: 再生する / 依頼: 10分前・完了: 1分前",
		);
		expect(p).toContain("[todo:w2] 進行中: 画像の生成 / 依頼: 5分前");
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
			"[todo:e1] 用事: 大家さんへ更新書類を返送 / 期限: 30分後",
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
