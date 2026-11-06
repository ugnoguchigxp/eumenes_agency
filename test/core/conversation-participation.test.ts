import { expect, test } from "bun:test";
import {
	createAgencyRuntime,
	defaultBudget,
	prepareForgetting,
	type RuntimeDeps,
} from "../../src/index.ts";
import {
	fakeLlm,
	obsInput,
	opportunity,
	participation,
	proposal,
} from "./helpers.ts";

const staticSystem = {
	update: { value: "update", input: { sources: [], complete: true } },
	select: { value: "select", input: { sources: [], complete: true } },
};
const make = (enabled = true, condition: "F" | "B2" = "F") => {
	const llm = fakeLlm();
	const settings: RuntimeDeps = {
		condition,
		systemContext: staticSystem,
		llm,
		tools: [
			{
				name: "inspect",
				description: "read only",
				requiresApproval: false,
				input: { sources: [], complete: true },
			},
		],
		conversationParticipation: enabled,
		planOnOpportunity: true,
		budget: { ...defaultBudget, minIntervalMs: 0 },
	};
	const rt = createAgencyRuntime(settings);
	return { llm, rt };
};

test("opt-in F conversation can speak from a presented external observation without persistent intent", async () => {
	const { llm, rt } = make();
	rt.observe(
		obsInput("o1", "user.report", "user", 0, "一緒に見ている場で変化があった"),
	);
	llm.push("update", proposal());
	llm.push(
		"select",
		participation({
			action: "speak",
			utterance: "変化が見えたね。",
			evidenceRefs: ["o1"],
		}),
	);
	const result = await rt.decide(
		opportunity("p", 60000),
		new AbortController().signal,
	);
	expect(result.decision.ticket?.action).toBe("speak");
	expect(rt.snapshot().state.intents).toEqual([]);
	expect(
		JSON.parse(llm.requests.at(-1)!.prompt).conversationEvidenceRefs,
	).toEqual(["o1"]);
	expect(() =>
		rt.recordResult(
			{
				ticketId: result.decision.ticket!.id,
				status: "succeeded",
				at: 60001,
				resultText: "変化が見えたね。",
			},
			{ sources: [], complete: true },
		),
	).not.toThrow();
});

for (const [enabled, condition] of [
	[false, "F"],
	[true, "B2"],
] as const) {
	test(`candidate-free conversation stays opt-in and F-only: ${enabled}/${condition}`, async () => {
		const { llm, rt } = make(enabled, condition);
		rt.observe(obsInput("o1", "user.report", "user", 0, "新しい外部の観測"));
		llm.push("update", proposal());
		const result = await rt.decide(
			opportunity("p", 60000),
			new AbortController().signal,
		);
		expect(result.decision.source).toBe("host_no_candidates");
		expect(llm.count("select")).toBe(0);
	});
}

for (const [action, refs] of [
	["speak", []],
	["speak", ["absent"]],
	["tool", ["o1"]],
] as const) {
	test(`conversation never authorizes an ungrounded speech or candidate-free tool: ${action}/${refs}`, async () => {
		const { llm, rt } = make();
		rt.observe(obsInput("o1", "user.report", "user", 0, "新しい外部の観測"));
		llm.push("update", proposal());
		llm.push(
			"select",
			participation({
				action,
				utterance: "根拠のある発話",
				evidenceRefs: [...refs],
				toolName: action === "tool" ? "inspect" : null,
				toolInput: action === "tool" ? "{}" : null,
			}),
		);
		const result = await rt.decide(
			opportunity("p", 60000),
			new AbortController().signal,
		);
		expect(result.decision.ticket).toBeNull();
		expect(result.decision.source).toBe("rejected");
	});
}

test("agent-only observations cannot open the conversation gate", async () => {
	const { llm, rt } = make();
	rt.observe(obsInput("o1", "exchange.adopted", "agent", 0, "自分の発話"), {
		sources: [],
		complete: true,
	});
	llm.push("update", proposal());
	const result = await rt.decide(
		opportunity("p", 60000),
		new AbortController().signal,
	);
	expect(result.decision.source).toBe("host_no_candidates");
	expect(llm.count("select")).toBe(0);
});

test("conversation without a candidate retains full forgetting and fresh-restart protection", async () => {
	const { llm, rt } = make();
	rt.observe(
		obsInput("o1", "user.report", "user", 0, "削除対象の独立した本文"),
	);
	llm.push("update", proposal());
	llm.push(
		"select",
		participation({
			action: "speak",
			utterance: "削除対象の独立した本文への反応",
			evidenceRefs: ["o1"],
		}),
	);
	const old = await rt.decide(
		opportunity("p", 60000),
		new AbortController().signal,
	);
	const plan = prepareForgetting(rt.snapshot(), ["o1"]);
	expect(JSON.stringify(plan.checkpoint)).not.toContain(
		"削除対象の独立した本文",
	);
	const fresh = createAgencyRuntime({
		condition: "F",
		systemContext: staticSystem,
		llm,
		tools: [],
		conversationParticipation: true,
		planOnOpportunity: true,
		restore: plan.checkpoint,
		budget: { ...defaultBudget, minIntervalMs: 0 },
	});
	expect(() =>
		fresh.recordResult(
			{
				ticketId: old.decision.ticket!.id,
				status: "succeeded",
				at: 60001,
				resultText: "遅れて戻った結果",
			},
			{ sources: [], complete: true },
		),
	).toThrow();
	fresh.observe(
		obsInput("o2", "user.report", "user", 120000, "無関係な新しい出来事"),
	);
	llm.push("update", proposal());
	llm.push(
		"select",
		participation({
			action: "speak",
			utterance: "新しい出来事への反応",
			evidenceRefs: ["o2"],
		}),
	);
	const next = await fresh.decide(
		opportunity("q", 180000),
		new AbortController().signal,
	);
	expect(next.decision.ticket?.action).toBe("speak");
	expect(() =>
		fresh.recordResult(
			{
				ticketId: next.decision.ticket!.id,
				status: "succeeded",
				at: 180001,
				resultText: "新しい出来事への反応",
			},
			{ sources: [], complete: true },
		),
	).not.toThrow();
});

test("adopted normal replies are already delivered context with full source dependencies, even beyond the recent window", async () => {
	const { llm, rt } = make();
	rt.observe(obsInput("o1", "user.report", "user", 0, "原資料の本文"));
	rt.observe(
		obsInput(
			"reply",
			"exchange.adopted",
			"agent",
			1,
			"通常応答で既に伝えた内容",
		),
		{ sources: ["o1"], complete: true },
	);
	for (let i = 2; i < 40; i++)
		rt.observe(
			obsInput(`o${i}`, "user.report", "user", i * 1000, `別の出来事${i}`),
		);
	// A restored processed ledger isolates selection from background update batching.
	const saved = rt.snapshot();
	const fresh = createAgencyRuntime({
		condition: "F",
		systemContext: staticSystem,
		llm,
		tools: [],
		conversationParticipation: true,
		restore: { ...saved, cursor: 40 },
		budget: { ...defaultBudget, minIntervalMs: 0 },
	});
	llm.push(
		"select",
		participation({
			action: "speak",
			utterance: "今の出来事への反応",
			evidenceRefs: ["o39"],
		}),
	);
	const result = await fresh.decide(
		opportunity("p", 60000),
		new AbortController().signal,
	);
	const data = JSON.parse(llm.requests.at(-1)!.prompt);
	expect(data.delivered).toContain("通常応答で既に伝えた内容");
	expect(data.observations.some((o: { id: string }) => o.id === "reply")).toBe(
		false,
	);
	const input = new Map(fresh.snapshot().provenance!.entries).get(
		`attempt:${result.decision.ticket!.id}`,
	)!;
	expect(input.complete).toBe(true);
	expect(input.sources).toContain("o1");
	expect(input.sources).toContain("reply");
	const forgotten = prepareForgetting(fresh.snapshot(), ["o1"]);
	expect(
		forgotten.checkpoint.continuity?.issued.some(
			(t) => t.id === result.decision.ticket!.id,
		),
	).toBe(false);
});

test("the model sees the actual autonomous cooldown and the runtime still enforces it", async () => {
	const { llm, rt } = make();
	rt.observe(obsInput("o1", "user.report", "user", 0, "新しい出来事"));
	rt.observe(
		obsInput("normal", "exchange.adopted", "agent", 1000, "通常の返答"),
		{ sources: ["o1"], complete: true },
	);
	llm.push("update", proposal());
	llm.push(
		"select",
		participation({
			action: "speak",
			utterance: "新しい違いへの反応",
			evidenceRefs: ["o1"],
		}),
	);
	const first = await rt.decide(
		opportunity("p", 60000),
		new AbortController().signal,
	);
	expect(JSON.parse(llm.requests.at(-1)!.prompt).outboundWaitMs).toBe(0);
	rt.recordResult(
		{
			ticketId: first.decision.ticket!.id,
			status: "succeeded",
			at: 60001,
			resultText: "新しい違いへの反応",
		},
		{ sources: [], complete: true },
	);
	rt.observe(obsInput("o2", "user.report", "user", 61000, "別の変化"));
	llm.push("update", proposal());
	llm.push(
		"select",
		participation({
			action: "speak",
			utterance: "次の反応",
			evidenceRefs: ["o2"],
		}),
	);
	const blocked = await rt.decide(
		opportunity("q", 61000),
		new AbortController().signal,
	);
	expect(JSON.parse(llm.requests.at(-1)!.prompt).outboundWaitMs).toBe(59000);
	expect(blocked.decision.rejectCodes).toContain("outbound_interval");
	expect(blocked.decision.ticket).toBeNull();
});
