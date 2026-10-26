import { describe, expect, test } from "bun:test";
import { systemPrompt } from "../../src/application/prompts.ts";
import { createAgencyRuntime } from "../../src/application/runtime.ts";
import type { HostTopic } from "../../src/contracts/model.ts";
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
const interests = [{ id: "i1", text: "マイメロディが好き。" }];
const topics: readonly HostTopic[] = [
	{ id: "t1", text: "ユーザーはクロミが好き。" },
	{ id: "t2", text: "最近、散歩を始めたと話していた。" },
];
const matterNote = {
	op: "note.add",
	localId: "n1",
	text: "来週の資料の提出が未解決",
	evidenceRefs: ["o1"],
};

const run = async (o: {
	hostTopics?: boolean;
	socialTopics?: boolean;
	trigger?: "idle" | "turn_end";
	topics?: readonly HostTopic[];
	ambient?: readonly HostTopic[];
	withInterests?: boolean;
	notes?: unknown[];
	selectWhenEmpty?: boolean;
	select?: ReturnType<typeof participation>;
	/** An extra observation with this id (to collide with a note id). */
	alsoObserve?: string;
}) => {
	const llm = fakeLlm();
	const rt = createAgencyRuntime({
		condition: "B1",
		llm,
		tools: [],
		budget: { ...defaultBudget, minIntervalMs: 0 },
		limits: { ...defaultLimits, outboundIntervalMs: 0 },
		selectWhenEmpty: o.selectWhenEmpty ?? false,
		...(o.withInterests ? { standingInterests: interests } : {}),
		...(o.hostTopics === undefined ? {} : { hostTopics: o.hostTopics }),
		...(o.socialTopics === undefined ? {} : { socialTopics: o.socialTopics }),
	});
	rt.observe(obsInput("o1", "user.report", "user", 0, "クロミが好きなんだ"));
	if (o.alsoObserve)
		rt.observe(obsInput(o.alsoObserve, "user.report", "user", 0, "資料はまだ"));
	llm.push("update", b1Proposal(o.notes ?? []));
	llm.push("select", o.select ?? participation());
	const d = await rt.decide(
		opportunity("op0", 10 * MIN, {
			trigger: o.trigger ?? "idle",
			...(o.topics ? { topics: o.topics } : {}),
			...(o.ambient ? { ambient: o.ambient } : {}),
		}),
		sig(),
	);
	return {
		llm,
		d,
		update: llm.requests.find((r) => r.purpose === "update"),
		select: llm.requests.find((r) => r.purpose === "select"),
	};
};

describe("hostTopics", () => {
	test("absent or false: prompts are byte-identical, and Opportunity.topics is ignored", async () => {
		const base = await run({ notes: [matterNote] });
		const off = await run({
			notes: [matterNote],
			hostTopics: false,
			topics,
		});
		const withTopics = await run({ notes: [matterNote], topics });
		expect(off.update).toEqual(base.update);
		expect(off.select).toEqual(base.select);
		expect(withTopics.select).toEqual(base.select);
		expect(base.select?.system).toBe(systemPrompt("select", "B1"));
		expect(base.select?.prompt).not.toContain("記憶にある話題");
		// with interests and social too
		const a = await run({
			notes: [matterNote],
			withInterests: true,
			socialTopics: true,
		});
		const b = await run({
			notes: [matterNote],
			withInterests: true,
			socialTopics: true,
			hostTopics: false,
			topics,
		});
		expect(b.select).toEqual(a.select);
	});

	test("update prompt is the plain B1 one: no topic-seed rules", async () => {
		const { update } = await run({
			notes: [matterNote],
			hostTopics: true,
			topics,
		});
		expect(update?.system).toBe(systemPrompt("update", "B1"));
		expect(update?.system).not.toContain("話題の種");
		expect(update?.system).not.toContain("【話題】");
	});

	test("select prompt: lull rules, memory section, idle closing line", async () => {
		const { select } = await run({
			notes: [matterNote],
			hostTopics: true,
			topics,
		});
		const sys = select?.system ?? "";
		expect(sys).toBe(systemPrompt("select", "B1", { hostTopics: true }));
		expect(sys).toContain("【雑談の間】");
		expect(sys).toContain("「記憶にある話題」");
		expect(sys).toContain("`memory:<id>`");
		expect(sys).toContain("`interest:<id>`");
		expect(sys).not.toContain("「【話題】」（話題の種）");
		const prompt = select?.prompt ?? "";
		expect(prompt).toContain(
			'# 記憶にある話題（ユーザーについて覚えていること。依頼ではない）\n[memory:t1] "ユーザーはクロミが好き。"\n[memory:t2] "最近、散歩を始めたと話していた。"',
		);
		expect(prompt).toContain("記憶にある話題か自分の関心から");
		expect(prompt).toContain("迷っても speak を選ぶ");
		expect(prompt).not.toContain("価値が低い、または迷うなら wait。");
		// turn_end keeps the conservative closing line
		const t = await run({
			notes: [matterNote],
			hostTopics: true,
			topics,
			trigger: "turn_end",
		});
		expect(t.select?.prompt).toContain("価値が低い、または迷うなら wait。");
		expect(t.select?.prompt).not.toContain("迷っても speak");
		// no topics presented: no section, rule text still there
		const none = await run({ notes: [matterNote], hostTopics: true });
		expect(none.select?.prompt).not.toContain("# 記憶にある話題");
		expect(none.select?.system).toContain("【雑談の間】");
	});

	test("hostTopics wins over socialTopics", async () => {
		const both = await run({
			notes: [matterNote],
			hostTopics: true,
			socialTopics: true,
			topics,
		});
		const host = await run({ notes: [matterNote], hostTopics: true, topics });
		expect(both.update).toEqual(host.update);
		expect(both.select).toEqual(host.select);
	});

	test("memory refs are accepted only when presented", async () => {
		const speak = (ref: string) =>
			participation({
				action: "speak",
				utterance: "クロミのどこが好きなの？",
				evidenceRefs: [ref],
			});
		const ok = await run({
			hostTopics: true,
			topics,
			notes: [matterNote],
			select: speak("memory:t1"),
		});
		expect(ok.d.decision.action).toBe("speak");
		const absent = await run({
			hostTopics: true,
			topics,
			notes: [matterNote],
			select: speak("memory:t9"),
		});
		expect(absent.d.decision.rejectCodes).toContain("unknown_ref");
		const notPresented = await run({
			hostTopics: true,
			notes: [matterNote],
			select: speak("memory:t1"),
		});
		expect(notPresented.d.decision.rejectCodes).toContain("unknown_ref");
		const modeOff = await run({
			topics,
			notes: [matterNote],
			select: speak("memory:t1"),
		});
		expect(modeOff.d.decision.rejectCodes).toContain("unknown_ref");
		// an interest still works next to topics
		const interest = await run({
			hostTopics: true,
			topics,
			withInterests: true,
			notes: [matterNote],
			select: speak("interest:i1"),
		});
		expect(interest.d.decision.action).toBe("speak");
	});

	test("a note id is read as the note's evidence (unresolved matter)", async () => {
		const cite = participation({
			action: "speak",
			utterance: "資料の提出はどう？",
			evidenceRefs: ["n1"],
		});
		const host = await run({
			hostTopics: true,
			notes: [matterNote],
			select: cite,
		});
		expect(host.d.decision.action).toBe("speak");
		expect(host.d.decision.evidenceRefs).toEqual(["o1"]);
		// host-rules-4: the same holds without the mode (plain B1)
		const plain = await run({ notes: [matterNote], select: cite });
		expect(plain.d.decision.action).toBe("speak");
		expect(plain.d.decision.evidenceRefs).toEqual(["o1"]);
		// an id that is also an observation's stays that observation (not the note's evidence)
		const clash = await run({
			notes: [matterNote],
			select: cite,
			alsoObserve: "n1",
		});
		expect(clash.d.decision.action).toBe("speak");
		expect(clash.d.decision.evidenceRefs).toEqual(["n1"]);
		// an id that is neither a note nor a presented observation is still rejected
		const bogus = await run({
			notes: [matterNote],
			select: participation({ ...cite, evidenceRefs: ["n9"] }),
		});
		expect(bogus.d.decision.rejectCodes).toContain("unknown_ref");
	});

	test("gate: with no notes, select runs only if topics or interests exist", async () => {
		const idle = await run({ hostTopics: true });
		expect(idle.select).toBeUndefined();
		expect(idle.d.decision.reason).toContain("nothing to offer");
		const withTopics = await run({ hostTopics: true, topics });
		expect(withTopics.select).toBeDefined();
		const withInterests = await run({ hostTopics: true, withInterests: true });
		expect(withInterests.select).toBeDefined();
		// blank topics do not open the gate
		const blank = await run({
			hostTopics: true,
			topics: [
				{ id: "", text: "x" },
				{ id: "t1", text: "  " },
			],
		});
		expect(blank.select).toBeUndefined();
		// mode off: topics do not open the gate
		const off = await run({ topics });
		expect(off.select).toBeUndefined();
	});
});

describe("topic and interest use (social-rules-3)", () => {
	type Status = "succeeded" | "failed" | "interrupted" | "outcome_unknown";
	const twoLulls = async (
		statuses: Status | readonly Status[],
		mode: "host" | "none" = "host",
	) => {
		const llm = fakeLlm();
		const rt = createAgencyRuntime({
			condition: "B1",
			llm,
			tools: [],
			budget: { ...defaultBudget, minIntervalMs: 0 },
			limits: { ...defaultLimits, outboundIntervalMs: 0 },
			...(mode === "host" ? { hostTopics: true } : {}),
			standingInterests: interests,
		});
		rt.observe(obsInput("o1", "user.report", "user", 0, "今日は休み"));
		llm.push("update", b1Proposal([]));
		llm.push(
			"select",
			participation({
				action: "speak",
				utterance: "クロミのどこが好き？",
				evidenceRefs: mode === "host" ? ["memory:t1"] : ["interest:i1"],
			}),
		);
		const first = await rt.decide(
			opportunity("op0", 10 * MIN, { trigger: "idle", topics }),
			sig(),
		);
		const ticket = first.decision.ticket!;
		for (const status of typeof statuses === "string" ? [statuses] : statuses) {
			rt.recordResult({
				ticketId: ticket.id,
				status,
				at: 11 * MIN,
				resultText: ticket.utterance ?? "",
			});
			// each receipt is a new observation: update runs before the second select
			llm.push("update", b1Proposal([]));
		}
		llm.push("select", participation());
		await rt.decide(
			opportunity("op1", 14 * MIN, { trigger: "idle", topics }),
			sig(),
		);
		const selects = llm.requests.filter((r) => r.purpose === "select");
		return { first: selects[0]!.prompt, second: selects[1]!.prompt };
	};

	test("a delivered topic is listed last with its last use; deliveries show their age", async () => {
		const { first, second } = await twoLulls("succeeded");
		expect(first).not.toContain("最後に使った");
		expect(first.indexOf("[memory:t1]")).toBeLessThan(
			first.indexOf("[memory:t2]"),
		);
		expect(second).toContain(
			'[memory:t1] "ユーザーはクロミが好き。"（最後に使った: 3分前）',
		);
		expect(second.indexOf("[memory:t2]")).toBeLessThan(
			second.indexOf("[memory:t1]"),
		);
		// the interest was not used
		expect(second).toContain('[interest:i1] "マイメロディが好き。"\n');
		expect(second).toContain('- （3分前）"クロミのどこが好き？"');
	});

	test("a failed delivery does not count as use", async () => {
		const { second } = await twoLulls("failed");
		expect(second).not.toContain("最後に使った");
	});
	test("an interrupted or unknown outcome followed by a late success counts as use", async () => {
		for (const first of ["interrupted", "outcome_unknown"] as const) {
			const { second } = await twoLulls([first, "succeeded"]);
			expect(second).toContain("（最後に使った: 3分前）");
		}
	});
	test("without a social mode nothing is annotated (interests only)", async () => {
		const { second } = await twoLulls("succeeded", "none");
		expect(second).not.toContain("最後に使った");
		expect(second).not.toMatch(/（\d+分前）"/);
	});

	test("host context (season, weather, news) opens the gate, is shown with context refs and is citable", async () => {
		const ambient = [{ id: "a1", text: "今日は今年いちばんの冷え込み。" }];
		const r = await run({
			hostTopics: true,
			ambient,
			select: participation({
				action: "speak",
				utterance: "今日は冷えるね。",
				evidenceRefs: ["context:a1"],
			}),
		});
		expect(r.select?.prompt).toContain("# いまの話題");
		expect(r.select?.prompt).toContain("[context:a1]");
		expect(r.select?.system).toContain("直前の話の続きや振り返り");
		expect(r.d.decision.action).toBe("speak");
		const off = await run({ hostTopics: false, ambient });
		expect(off.select).toBeUndefined();
	});
});
