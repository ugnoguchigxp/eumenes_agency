import { describe, expect, test } from "bun:test";
import { systemPrompt } from "../../src/application/prompts.ts";
import { createAgencyRuntime } from "../../src/application/runtime.ts";
import {
	emotionEmoji,
	emotionName,
	emotions,
} from "../../src/contracts/emotion.ts";
import type { Condition } from "../../src/contracts/model.ts";
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
const speak = (emotion: unknown) => ({
	...participation({
		action: "speak",
		utterance: "おっ、雨やんだね。",
		evidenceRefs: ["o1"],
	}),
	emotion,
});

const setup = (o: { utteranceEmotion?: boolean; condition?: Condition }) => {
	const llm = fakeLlm();
	const rt = createAgencyRuntime({
		systemContext: "experimental",
		condition: o.condition ?? "B1",
		llm,
		tools: [],
		selectWhenEmpty: true,
		hostTopics: true,
		budget: { ...defaultBudget, minIntervalMs: 0 },
		limits: { ...defaultLimits, outboundIntervalMs: 0 },
		...(o.utteranceEmotion === undefined
			? {}
			: { utteranceEmotion: o.utteranceEmotion }),
	});
	rt.observe(obsInput("o1", "user.report", "user", 0, "雨やんだみたい"));
	llm.push("update", b1Proposal([]));
	return { llm, rt };
};

const selects = (llm: ReturnType<typeof fakeLlm>) =>
	llm.requests.filter((r) => r.purpose === "select");

describe("utterance emotion", () => {
	test("the table is one emoji per name, both ways", () => {
		expect(new Set(emotions.map((e) => e.emoji)).size).toBe(emotions.length);
		expect(new Set(emotions.map((e) => e.name)).size).toBe(emotions.length);
		for (const e of emotions) {
			expect(emotionName(e.emoji)).toBe(e.name);
			expect(emotionEmoji(e.name)).toBe(e.emoji);
		}
	});

	test("absent or false: prompt and schema are unchanged, no emotion on the decision", async () => {
		expect(systemPrompt("select", "B1", { emotion: false })).toBe(
			systemPrompt("select", "B1"),
		);
		expect(systemPrompt("select", "B1")).not.toContain("発話の気持ち");
		const { llm, rt } = setup({});
		llm.push("select", speak(null));
		// the plain schema is strict: an extra emotion field fails it
		const d = await rt.decide(opportunity("op1", 1 * MIN), sig());
		expect(d.decision.source).not.toBe("llm");
		expect(d.decision.emotion).toBeUndefined();
		const r = setup({});
		r.llm.push(
			"select",
			participation({
				action: "speak",
				utterance: "おっ、雨やんだね。",
				evidenceRefs: ["o1"],
			}),
		);
		const plain = await r.rt.decide(opportunity("op1", 1 * MIN), sig());
		expect(plain.decision.action).toBe("speak");
		expect(plain.decision.emotion).toBeUndefined();
		expect(plain.decision.ticket?.emotion).toBeUndefined();
	});

	test("on: the rules are shown and the chosen feeling reaches decision and ticket by name", async () => {
		const { llm, rt } = setup({ utteranceEmotion: true });
		llm.push("select", speak("😌"));
		const d = await rt.decide(opportunity("op1", 1 * MIN), sig());
		expect(selects(llm)[0]?.system).toContain("【発話の気持ち】");
		expect(d.decision.action).toBe("speak");
		expect(d.decision.emotion).toBe("relief");
		expect(d.decision.ticket?.emotion).toBe("relief");
	});

	test("on: a speak with null emotion stays unspecified (no silent calm)", async () => {
		const { llm, rt } = setup({ utteranceEmotion: true });
		llm.push("select", speak(null));
		const d = await rt.decide(opportunity("op1", 1 * MIN), sig());
		expect(d.decision.action).toBe("speak");
		expect(d.decision.emotion).toBeUndefined();
		expect(d.decision.ticket?.emotion).toBeUndefined();
	});

	test("on: an emoji outside the set fails the select schema", async () => {
		const { llm, rt } = setup({ utteranceEmotion: true });
		llm.push("select", speak("🤯"), speak("🤯"));
		const d = await rt.decide(opportunity("op1", 1 * MIN), sig());
		expect(d.decision.source).not.toBe("llm");
		expect(d.decision.ticket).toBeNull();
	});

	test("on: a delivered utterance is shown with its feeling; a failed one without", async () => {
		const { llm, rt } = setup({ utteranceEmotion: true });
		llm.push("select", speak("😮"));
		const first = await rt.decide(opportunity("op1", 1 * MIN), sig());
		const ticket = first.decision.ticket!;
		rt.recordResult({
			ticketId: ticket.id,
			status: "succeeded",
			at: 2 * MIN,
			resultText: "おっ、雨やんだね。",
		});
		llm.push("update", b1Proposal([]));
		llm.push("select", participation());
		await rt.decide(opportunity("op2", 5 * MIN), sig());
		expect(selects(llm)[1]?.prompt).toContain("（3分前・😮）");
	});

	test("B2 ignores the option", () => {
		expect(systemPrompt("select", "B2", { emotion: true })).toBe(
			systemPrompt("select", "B2"),
		);
	});
});
