import { expect, test } from "bun:test";
import { createAgencyRuntime } from "../../src/application/runtime.ts";
import type { LlmRequest } from "../../src/contracts/ports.ts";
import {
	fakeLlm,
	obsInput,
	intentAddOp,
	candidateAddOp,
	proposal,
	participation,
	opportunity,
} from "./helpers.ts";

const signal = () => new AbortController().signal;
const setup = () => {
	const llm = fakeLlm();
	const runtime = createAgencyRuntime({
		condition: "F",
		interestFormation: true,
		hostTopics: true,
		hostTodos: true,
		utteranceEmotion: true,
		topics: () => [{ id: "m1", text: "Memory data" }],
		standingInterests: [{ id: "s1", text: "Persona interest" }],
		todos: () => [
			{
				id: "t1",
				title: "Work",
				status: "waiting",
				question: "Which?",
				requestedAt: 0,
			},
		],
		systemContext: { update: () => "Host update", select: () => "Host select" },
		llm,
		tools: [],
	});
	runtime.observe(obsInput("o1", "user.report", "user", 0, "Continue later"));
	return { llm, runtime };
};

test("F host data reaches both purposes and candidate speech retains emotion", async () => {
	const { llm, runtime } = setup();
	llm.push(
		"update",
		proposal([intentAddOp("g"), candidateAddOp("c", "g")], { interestOps: [] }),
	);
	llm.push("select", (request: LlmRequest<unknown>) => {
		const data = JSON.parse(request.prompt);
		return {
			...participation({
				action: "speak",
				candidateRef: {
					id: data.candidates[0].id,
					revision: data.candidates[0].revision,
				},
				utterance: "Here is the actual explanation.",
				evidenceRefs: ["memory:m1", "todo:t1", "interest:s1"],
			}),
			emotion: "😊",
		};
	});
	const result = await runtime.decide(
		opportunity("op1", 0, {
			topics: [{ id: "m1", text: "Memory data" }],
			todos: [
				{
					id: "t1",
					title: "Work",
					status: "waiting",
					question: "Which?",
					requestedAt: 0,
				},
			],
		}),
		signal(),
	);
	expect(result.decision.ticket).toMatchObject({
		action: "speak",
		emotion: "joy",
		utterance: "Here is the actual explanation.",
	});
	const data = JSON.parse(llm.requests[0]!.prompt);
	expect(data.topics).toEqual([{ id: "m1", text: "Memory data" }]);
	expect(data.interests).toEqual([{ id: "s1", text: "Persona interest" }]);
	expect(data.todos[0].id).toBe("t1");
});

test("F host material does not bypass observation evidence or candidate validation", async () => {
	const { llm, runtime } = setup();
	llm.push(
		"update",
		proposal([intentAddOp("g", { evidenceRefs: ["memory:m1"] })], {
			interestOps: [],
		}),
	);
	const rejected = await runtime.runBackground(0, signal());
	expect(rejected.at(-1)?.rejectCodes).toContain("unknown_ref");
	llm.push(
		"update",
		proposal([intentAddOp("g"), candidateAddOp("c", "g")], { interestOps: [] }),
	);
	llm.push("select", {
		...participation({
			action: "speak",
			utterance: "No candidate",
			evidenceRefs: ["o1"],
		}),
		emotion: null,
	});
	const result = await runtime.decide(opportunity("op2", 60_000), signal());
	expect(result.decision.ticket).toBeNull();
	expect(result.decision.rejectCodes).toContain("missing_candidate");
});

test("F skips selection after no_change even when standing interests and host material are present", async () => {
	const { runtime, llm } = setup();
	llm.push("update", proposal([], { interestOps: [] }));
	const result = await runtime.decide(
		opportunity("proof", 60_000, {
			topics: [{ id: "m1", text: "現在の関心" }],
		}),
		signal(),
	);
	expect(result.decision.source).toBe("host_no_candidates");
	expect(llm.count("select")).toBe(0);
	expect(result.decision.ticket).toBeNull();
});
