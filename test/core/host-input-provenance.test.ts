import { expect, test } from "bun:test";
import {
	createAgencyRuntime,
	defaultBudget,
	emptyState,
	prepareForgetting,
	LlmCallError,
	type RuntimeDeps,
	type HostTopic,
} from "../../src/index.ts";
import {
	fakeLlm,
	obs,
	obsInput,
	opportunity,
	intentAddOp,
	candidateAddOp,
	participation,
	proposal,
} from "./helpers.ts";

const complete = { sources: [] as string[], complete: true };
const context = (): RuntimeDeps["systemContext"] => ({
	update: () => ({ value: "HOST update", input: complete }),
	select: () => ({ value: "HOST select", input: complete }),
});
const signal = () => new AbortController().signal;
const forgotten = () =>
	prepareForgetting(
		{
			condition: "F" as const,
			state: emptyState(),
			cursor: 1,
			observations: [obs(1, "user.report", "user", "erased")],
		},
		["o1"],
	).checkpoint;
const seed = () =>
	proposal([
		intentAddOp("g", { evidenceRefs: ["fresh"] }),
		candidateAddOp("c", "g", { evidenceRefs: ["fresh"] }),
	]);
const setup = (over: Partial<RuntimeDeps> = {}) => {
	const llm = fakeLlm();
	const runtime = createAgencyRuntime({
		condition: "F",
		systemContext: context(),
		restore: forgotten(),
		llm,
		tools: [],
		budget: { ...defaultBudget, minIntervalMs: 0 },
		...over,
	});
	runtime.observe(
		obsInput("fresh", "user.report", "user", 120000, "独立した会話"),
	);
	return { runtime, llm };
};

test("F with a declared owned context accepts fresh receipts after an unrelated forget", async () => {
	const { runtime, llm } = setup();
	llm.push("update", seed());
	llm.push(
		"select",
		participation({
			action: "speak",
			candidateRef: { id: "c2", revision: 1 },
			utterance: "新しい会話の続き",
			evidenceRefs: ["fresh"],
		}),
	);
	const result = await runtime.decide(opportunity("p", 180000), signal());
	expect(result.decision.ticket).toBeDefined();
	expect(() =>
		runtime.recordResult(
			{
				ticketId: result.decision.ticket!.id,
				status: "succeeded",
				at: 180001,
				resultText: "新しい会話の続き",
			},
			complete,
		),
	).not.toThrow();
	expect(
		new Map(runtime.snapshot().provenance!.entries).get("intent:i1")?.complete,
	).toBe(true);
});

test("an undeclared owned context is blocked before inference after forgetting", async () => {
	const { runtime, llm } = setup({
		systemContext: { update: "Legacy update", select: "Legacy select" },
	});
	const result = await runtime.runBackground(180000, signal());
	expect(result.at(-1)?.rejectCodes).toContain("incomplete_input");
	expect(llm.count()).toBe(0);
	expect(runtime.snapshot().cursor).toBe(1);
});

test("shown host topics and todos contribute non-cited inputs without leaking metadata to the prompt", async () => {
	const topic = {
		id: "m1",
		text: "Memory topic",
		input: { sources: ["private-topic-key-v3"], complete: true },
	};
	const todo = {
		id: "t1",
		title: "Host work",
		status: "done" as const,
		result: "Returned result",
		requestedAt: 0,
		input: { sources: ["private-work-key-v2"], complete: true },
	};
	const { runtime, llm } = setup({
		hostTopics: true,
		hostTodos: true,
		topics: () => [topic],
		todos: () => [todo],
	});
	llm.push("update", seed());
	llm.push(
		"select",
		participation({
			action: "speak",
			candidateRef: { id: "c2", revision: 1 },
			utterance: "根拠のある一言",
			evidenceRefs: ["fresh"],
		}),
	);
	const result = await runtime.decide(
		opportunity("p", 180000, { topics: [topic], todos: [todo] }),
		signal(),
	);
	expect(result.decision.ticket).toBeDefined();
	const input = new Map(runtime.snapshot().provenance!.entries).get(
		`attempt:${result.decision.ticket!.id}`,
	)!;
	expect(input.sources).toContain("private-topic-key-v3");
	expect(input.sources).toContain("private-work-key-v2");
	expect(input.complete).toBe(true);
	for (const req of llm.requests) {
		expect(req.prompt).not.toContain("private-topic-key-v3");
		expect(req.prompt).not.toContain("private-work-key-v2");
		expect(req.prompt).not.toContain('"input":');
	}
});

test("an incomplete or forgotten topic blocks F update before a model call", async () => {
	for (const input of [undefined, { sources: ["o1"], complete: true }]) {
		const topic = {
			id: "m1",
			text: "Unavailable",
			...(input ? { input } : {}),
		};
		const { runtime, llm } = setup({ hostTopics: true, topics: () => [topic] });
		const result = await runtime.runBackground(180000, signal());
		expect(result.at(-1)?.code).toBe("rejected:input_dependency");
		expect(llm.count()).toBe(0);
	}
});

test("an unpresented host topic does not taint unrelated work", async () => {
	const topic = {
		id: "unused",
		text: "Unused secret",
		input: { sources: ["o1"], complete: true },
	};
	const { runtime, llm } = setup({
		hostTopics: false,
		topics: () => [topic] as readonly HostTopic[],
	});
	llm.push("update", seed());
	expect((await runtime.runBackground(180000, signal())).at(-1)?.code).toBe(
		"applied",
	);
	expect(llm.count()).toBe(1);
});

test("an undeclared select context is blocked after a fully declared F update", async () => {
	const owned = context();
	if (owned === "experimental") throw Error("fixture");
	const { runtime, llm } = setup({
		systemContext: { ...owned, select: "Legacy select" },
	});
	llm.push("update", seed());
	const result = await runtime.decide(opportunity("select", 180000), signal());
	expect(result.decision.rejectCodes).toContain("incomplete_input");
	expect(result.decision.ticket).toBeNull();
	expect(llm.count("update")).toBe(1);
	expect(llm.count("select")).toBe(0);
});

test("text and input declarations stay captured through a budgeted transport retry", async () => {
	let resolved = 0;
	const declared = { sources: [] as string[], complete: true };
	const owned = context();
	if (owned === "experimental") throw Error("fixture");
	const { runtime, llm } = setup({
		systemContext: {
			...owned,
			update: () => {
				resolved++;
				return { value: "CAPTURED", input: declared };
			},
		},
	});
	llm.push(
		"update",
		() => {
			declared.sources.push("o1");
			return new LlmCallError("connection", true);
		},
		seed(),
	);
	expect((await runtime.runBackground(180000, signal())).at(-1)?.code).toBe(
		"applied",
	);
	expect(resolved).toBe(1);
	expect(llm.requests).toHaveLength(2);
	expect(llm.requests[0]!.system).toBe(llm.requests[1]!.system);
	expect(
		new Map(runtime.snapshot().provenance!.entries).get("intent:i1")!.sources,
	).not.toContain("o1");
});
