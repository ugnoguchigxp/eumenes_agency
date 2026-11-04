import { describe, expect, test } from "bun:test";
import { createAgencyRuntime, type AgencyState } from "../../src/index.ts";
import {
	HOUR,
	fakeLlm,
	intentAddOp,
	obsInput,
	opportunity,
	participation,
	proposal,
	tools,
} from "./helpers.ts";

const D = 24 * HOUR;
const NOW = 10 * D;
const sig = () => new AbortController().signal;

const withFinding = async (): Promise<AgencyState> => {
	const llm = fakeLlm();
	const rt = createAgencyRuntime({
		systemContext: "experimental",
		condition: "F",
		llm,
		tools: [],
	});
	rt.observe(obsInput("u1", "user.report", "user", 0, "角換わりを調べて"));
	llm.push(
		"update",
		proposal([
			intentAddOp("g", {
				evidenceRefs: ["u1"],
				desiredState: "角換わりを調べる",
			}),
		]),
	);
	await rt.runBackground(1, sig());
	const s = structuredClone(rt.snapshot().state) as any;
	s.intents[0] = {
		...s.intents[0],
		state: "completed",
		evidence: ["u1", "w1"],
		lastReturn: {
			at: NOW - 3 * D,
			workRef: "work:1",
			status: "partial",
			summary: "3系統に整理",
			question: null,
		},
	};
	return s;
};

const make = async (findings: boolean) => {
	const llm = fakeLlm();
	const rt = createAgencyRuntime({
		systemContext: "experimental",
		condition: "F",
		llm,
		tools,
		restore: { state: await withFinding() },
		...(findings ? { findings: true } : {}),
	});
	rt.observe(
		obsInput("w1", "work.returned", "tool", NOW - 3 * D, "3系統に整理"),
	);
	rt.observe(obsInput("u9", "user.report", "user", NOW, "角換わりどう指そう"));
	llm.push("update", proposal([]));
	return { llm, rt };
};

describe("P5-a findings in conversation", () => {
	test("findings shown with age and certainty; speak without candidate allowed; tts false", async () => {
		const m = await make(true);
		m.llm.push(
			"select",
			participation({
				action: "speak",
				evidenceRefs: ["u9", "w1"],
				utterance: "3日前に調べた範囲では3系統です（一部のみ確認）",
			}),
		);
		const d = await m.rt.decide(
			{ ...opportunity("op", NOW + 1), trigger: "turn_end" } as never,
			sig(),
		);
		const sel = m.llm.requests.find((r) => r.purpose === "select")!;
		expect(sel.prompt).toContain("調べた時期: 3日前");
		expect(sel.prompt).toContain("確度: 一部のみ確認");
		expect(sel.prompt).toContain("いつ調べたか");
		expect(d.decision.action).toBe("speak");
		expect(d.decision.ticket?.tts).toBe(false);
	});
	test.each([true, false])(
		"original request still needs a candidate (observation retained: %s)",
		async (retained) => {
			const m = await make(true);
			if (retained)
				m.rt.observe(
					obsInput("u1", "user.report", "user", 0, "角換わりを調べて"),
				);
			m.llm.push("update", proposal());
			m.llm.push(
				"select",
				participation({
					action: "speak",
					evidenceRefs: ["u1"],
					utterance: "x",
				}),
			);
			const d = await m.rt.decide(
				{ ...opportunity("op", NOW + 1), trigger: "turn_end" } as never,
				sig(),
			);
			expect(d.decision.action).toBe("wait");
			expect(d.decision.source).toBe("rejected");
		},
	);
	test("speak citing no finding still needs a candidate", async () => {
		const m = await make(true);
		m.llm.push(
			"select",
			participation({ action: "speak", evidenceRefs: ["u9"], utterance: "x" }),
		);
		const d = await m.rt.decide(
			{ ...opportunity("op", NOW + 1), trigger: "turn_end" } as never,
			sig(),
		);
		expect(d.decision.action).toBe("wait");
		expect(d.decision.rejectCodes).toContain("missing_candidate");
	});
	test("without findings mode: no select call (today's behavior)", async () => {
		const m = await make(false);
		const d = await m.rt.decide(
			{ ...opportunity("op", NOW + 1), trigger: "turn_end" } as never,
			sig(),
		);
		expect(m.llm.requests.some((r) => r.purpose === "select")).toBe(false);
		expect(d.decision.action).toBe("wait");
	});
});

test("host select sees the contracted finding even after newer intents close", async () => {
	const state = await withFinding();
	const finding = state.intents[0]!;
	const llm = fakeLlm();
	let contract = "";
	const rt = createAgencyRuntime({
		condition: "F",
		findings: true,
		systemContext: {
			update: "update",
			select: ({ outputContract }) => {
				contract = outputContract.description;
				return contract;
			},
		},
		llm,
		tools: [],
		restore: {
			state: {
				...state,
				intents: [
					finding,
					...Array.from({ length: 6 }, (_, n) => ({
						...finding,
						id: "later-" + n,
						evidence: [],
						lastReturn: null,
					})),
				],
			},
		},
	});
	llm.push(
		"select",
		participation({
			action: "speak",
			utterance: "3日前に確認できたのは3系統までです。",
			evidenceRefs: [finding.id],
		}),
	);
	const { decision } = await rt.decide(opportunity("idle", NOW), sig());
	const data = JSON.parse(llm.requests[0]!.prompt);
	expect(data.state.intents).toContainEqual(finding);
	expect(contract).toContain("closed intent with lastReturn");
	expect(decision.ticket?.utterance).toBe(
		"3日前に確認できたのは3系統までです。",
	);
});
