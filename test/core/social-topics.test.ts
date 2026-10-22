import { describe, expect, test } from "bun:test";
import { systemPrompt } from "../../src/application/prompts.ts";
import { createAgencyRuntime } from "../../src/application/runtime.ts";
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
	proposal,
	tools,
} from "./helpers.ts";

const sig = () => new AbortController().signal;
const interests = [{ id: "i1", text: "マイメロディが好き。" }];

const seedNote = {
	op: "note.add",
	localId: "n1",
	text: "【話題】ユーザーはクロミが好き。どこが好きか聞いてみたい",
	evidenceRefs: ["o1"],
};

const run = async (
	c: Condition,
	o: {
		social?: boolean;
		trigger?: "idle" | "turn_end";
		withInterests?: boolean;
		select?: ReturnType<typeof participation>;
	} = {},
) => {
	const llm = fakeLlm();
	const rt = createAgencyRuntime({
		condition: c,
		llm,
		tools,
		budget: { ...defaultBudget, minIntervalMs: 0 },
		limits: { ...defaultLimits, outboundIntervalMs: 0 },
		selectWhenEmpty: c === "B1",
		...(o.withInterests ? { standingInterests: interests } : {}),
		...(o.social === undefined ? {} : { socialTopics: o.social }),
	});
	rt.observe(obsInput("o1", "user.report", "user", 0, "クロミが好きなんだ"));
	llm.push("update", c === "B1" ? b1Proposal([seedNote]) : proposal());
	llm.push("select", o.select ?? participation());
	const d = await rt.decide(
		opportunity("op0", 10 * MIN, { trigger: o.trigger ?? "idle" }),
		sig(),
	);
	return {
		llm,
		d,
		update: llm.requests.find((r) => r.purpose === "update"),
		select: llm.requests.find((r) => r.purpose === "select"),
	};
};

describe("socialTopics", () => {
	test("absent or false: update and select prompts are byte-identical to before", async () => {
		for (const c of ["B1", "B2", "F"] as const) {
			const base = await run(c);
			const off = await run(c, { social: false });
			expect(off.update).toEqual(base.update);
			expect(off.select).toEqual(base.select);
			expect(base.update?.system).toBe(systemPrompt("update", c));
			expect(base.update?.system).not.toContain("話題の種");
			// B2/F select only runs with a candidate; B1 here has notes.
			if (c === "B1") {
				expect(base.select?.system).toBe(systemPrompt("select", c));
				expect(base.select?.system).not.toContain("雑談の間");
				expect(base.select?.prompt).toContain(
					"価値が低い、または迷うなら wait。",
				);
			}
		}
		// with interests too
		const a = await run("B1", { withInterests: true });
		const b = await run("B1", { withInterests: true, social: false });
		expect(b.select).toEqual(a.select);
	});

	test("B1 social: update prompt asks for 【話題】 topic seeds", async () => {
		const { update } = await run("B1", { social: true });
		const sys = update?.system ?? "";
		expect(sys).toContain("【話題の種】");
		expect(sys).toContain("最大5件");
		expect(sys).toContain("「【話題】」を付ける");
		expect(sys).toContain("機微な情報");
		expect(sys).toBe(systemPrompt("update", "B1", { social: true }));
		// the base rules are still all there
		expect(
			sys.startsWith(systemPrompt("update", "B1").split("\n")[0] ?? ""),
		).toBe(true);
		expect(sys).toContain(systemPrompt("update", "B1").split("\n")[1] ?? "x");
	});

	test("B1 social: select prompt has the lull rules; idle closing line yields to speaking", async () => {
		const idle = await run("B1", { social: true, trigger: "idle" });
		const sys = idle.select?.system ?? "";
		expect(sys).toContain("【雑談の間】");
		expect(sys).toContain("wait より speak を選ぶ");
		expect(sys).toContain("`interest:<id>`");
		expect(sys).toContain("turn_end");
		expect(idle.select?.prompt).not.toContain(
			"価値が低い、または迷うなら wait。",
		);
		expect(idle.select?.prompt).toContain("迷っても speak を選ぶ");
		// turn_end keeps the conservative closing line
		const turnEnd = await run("B1", { social: true, trigger: "turn_end" });
		expect(turnEnd.select?.prompt).toContain(
			"価値が低い、または迷うなら wait。",
		);
		expect(turnEnd.select?.prompt).not.toContain("迷っても speak");
		// the user prompt differs from the non-social one only at idle
		const plain = await run("B1", { trigger: "turn_end" });
		expect(turnEnd.select?.prompt).toBe(plain.select?.prompt);
	});

	test("B2/F ignore socialTopics entirely", async () => {
		for (const c of ["B2", "F"] as const) {
			const base = await run(c);
			const social = await run(c, { social: true });
			expect(social.update).toEqual(base.update);
			expect(social.select).toEqual(base.select);
		}
	});

	test("speaking from a topic seed (note evidence) or an interest is accepted at idle", async () => {
		const seed = await run("B1", {
			social: true,
			select: participation({
				action: "speak",
				utterance: "クロミのどこが好きなの？",
				evidenceRefs: ["o1"],
			}),
		});
		expect(seed.d.decision.action).toBe("speak");
		expect(seed.d.decision.ticket?.utterance).toBe("クロミのどこが好きなの？");
		expect(seed.select?.prompt).toContain("【話題】ユーザーはクロミが好き");
		const interest = await run("B1", {
			social: true,
			withInterests: true,
			select: participation({
				action: "speak",
				utterance: "わたしはマイメロディが好きだよ。",
				evidenceRefs: ["interest:i1"],
			}),
		});
		expect(interest.d.decision.action).toBe("speak");
		expect(interest.select?.system).toContain("【自分の関心】");
		expect(interest.select?.system).toContain("【雑談の間】");
		// an interest that is not presented is still rejected
		const bogus = await run("B1", {
			social: true,
			select: participation({
				action: "speak",
				utterance: "x",
				evidenceRefs: ["interest:i1"],
			}),
		});
		expect(bogus.d.decision.rejectCodes).toContain("unknown_ref");
	});
});
