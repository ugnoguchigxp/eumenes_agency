import { describe, expect, test } from "bun:test";
import { createAgencyRuntime, type AgencyState } from "../../src/index.ts";
import {
	HOUR,
	fakeLlm,
	candidateAddOp,
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

const make = async (findings: boolean, workRef = "work:1") => {
	const llm = fakeLlm();
	const rt = createAgencyRuntime({
		systemContext: "experimental",
		condition: "F",
		llm,
		tools,
		restore: { state: await withFinding() },
		...(findings ? { findings: true } : {}),
	});
	rt.observe({
		...obsInput("w1", "work.returned", "tool", NOW - 3 * D, "3系統に整理"),
		workRef,
	});
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

test("a return from a different work unit cannot authorize speech for this finding", async () => {
	const m = await make(true, "other-work");
	m.llm.push(
		"select",
		participation({
			action: "speak",
			evidenceRefs: ["w1"],
			utterance: "result",
		}),
	);
	const { decision } = await m.rt.decide(opportunity("op", NOW), sig());
	expect(decision.rejectCodes).toContain("missing_candidate");
	expect(decision.ticket).toBeNull();
});

test("host observation IDs never grant the finding exception, even when they look like finding refs", async () => {
	const m = await make(true);
	for (const id of ["i1", "finding:i1"])
		m.rt.observe(obsInput(id, "user.report", "user", NOW, "other observation"));
	for (const [n, ref] of ["i1", "finding:i1"].entries()) {
		m.llm.push(
			"select",
			participation({
				action: "speak",
				evidenceRefs: [ref],
				utterance: "result",
			}),
		);
		const { decision } = await m.rt.decide(
			opportunity("op" + n, NOW + n),
			sig(),
		);
		expect(decision.rejectCodes).toContain("missing_candidate");
		expect(decision.ticket).toBeNull();
	}
	// The same finding still has a usable reference even when both earlier names collide.
	m.llm.push(
		"select",
		participation({
			action: "speak",
			evidenceRefs: ["finding:finding:i1"],
			utterance: "result",
		}),
	);
	const { decision } = await m.rt.decide(opportunity("ok", NOW + 2), sig());
	expect(decision.ticket?.findingWorkRefs).toEqual(["work:1"]);
});

test("the newest returned work remains selectable when five later-created intents returned earlier", async () => {
	const state = await withFinding();
	const first = state.intents[0]!;
	const intents = Array.from({ length: 6 }, (_, n) => ({
		...first,
		id: "i" + (n + 1),
		lastReturn: {
			...first.lastReturn!,
			workRef: "work:" + n,
			at: n === 0 ? NOW : NOW - n * D,
		},
	}));
	const llm = fakeLlm();
	const rt = createAgencyRuntime({
		condition: "F",
		findings: true,
		systemContext: { update: "host", select: "host" },
		llm,
		tools: [],
		restore: { state: { ...state, intents } },
	});
	llm.push(
		"select",
		participation({
			action: "speak",
			evidenceRefs: ["finding:i1"],
			utterance: "result",
		}),
	);
	const { decision } = await rt.decide(opportunity("op", NOW), sig());
	const data = JSON.parse(llm.requests[0]!.prompt);
	expect(data.state.intents.map((i: { id: string }) => i.id)).toEqual([
		"i1",
		"i2",
		"i3",
		"i4",
		"i5",
	]);
	expect(data.findingRefs[0]).toEqual({ intentId: "i1", ref: "finding:i1" });
	expect(decision.ticket?.action).toBe("speak");
	expect(
		rt
			.projection(8)
			.items.filter((i) => i.kind === "finding")
			.map((i) => i.id),
	).toEqual(["finding:i1", "finding:i2", "finding:i3"]);
});

test("routing two different findings leaves distinguishable evidence without claiming playback, across restore", async () => {
	const base = await withFinding();
	const intents = ["i10", "i11"].map((id) => ({
		...base.intents[0]!,
		id,
		lastReturn: { ...base.intents[0]!.lastReturn!, workRef: "work-" + id },
	}));
	for (const intent of intents) {
		const llm = fakeLlm();
		const deps = {
			condition: "F" as const,
			findings: true,
			llm,
			tools: [],
			systemContext: { update: "host", select: "host" },
		};
		const rt = createAgencyRuntime({
			...deps,
			restore: { state: { ...base, nextId: 20, intents } },
		});
		llm.push(
			"select",
			participation({
				action: "speak",
				utterance: "same wording",
				evidenceRefs: ["finding:" + intent.id],
			}),
		);
		const { decision } = await rt.decide(opportunity("first", NOW), sig());
		const afterReservation = createAgencyRuntime({
			...deps,
			restore: rt.snapshot(),
		});
		afterReservation.recordResult({
			ticketId: decision.ticket!.id,
			status: "succeeded",
			at: NOW + 1,
			resultText: "offered to Live; playback unconfirmed",
			speechHandoff: true,
		});
		const resumed = createAgencyRuntime({
			...deps,
			restore: afterReservation.snapshot(),
		});
		llm.push("update", proposal());
		llm.push("select", participation({ action: "wait" }));
		await resumed.decide(opportunity("second", NOW + 61000), sig());
		const data = JSON.parse(llm.requests.at(-1)!.prompt);
		const delivery = data.observations.find(
			(o: { kind: string }) => o.kind === "delivery.observed",
		);
		expect(delivery.text).toBe("offered to Live; playback unconfirmed");
		expect(delivery.speechHandoff).toEqual({
			proposedText: "same wording",
			findingWorkRefs: [intent.lastReturn.workRef],
		});
	}
});

test("a candidate that cites a returned work unit retains that unit on its speech ticket", async () => {
	const llm = fakeLlm();
	const rt = createAgencyRuntime({
		condition: "F",
		findings: true,
		systemContext: { update: "host", select: "host" },
		llm,
		tools: [],
	});
	rt.observe({
		...obsInput("r1", "work.returned", "tool", NOW, "partial result"),
		workRef: "work-A",
	});
	llm.push(
		"update",
		proposal([
			intentAddOp("g", { evidenceRefs: ["r1"] }),
			candidateAddOp("c", "g", { evidenceRefs: ["r1"] }),
		]),
	);
	llm.push(
		"select",
		participation({
			action: "speak",
			candidateRef: { id: "c2", revision: 1 },
			evidenceRefs: ["r1"],
			utterance: "partial result",
		}),
	);
	const { decision } = await rt.decide(opportunity("op", NOW), sig());
	expect(decision.ticket?.findingWorkRefs).toEqual(["work-A"]);
});

test("opportunity planning can build on an earlier work return and new user evidence", async () => {
	const state = await withFinding();
	const finding = state.intents[0]!;
	const later = Array.from({ length: 6 }, (_, n) => ({
		...finding,
		id: "later" + n,
		lastReturn: null,
		evidence: [],
	}));
	const body = "Previous comparison details ".repeat(40);
	const history = [
		{
			...obsInput("w1", "work.returned", "tool", 0, body),
			workRef: "work:1",
		},
		...Array.from({ length: 32 }, (_, n) =>
			obsInput("old" + n, "user.report", "user", n + 1, "Other conversation"),
		),
	].map((o, n) => ({ ...o, seq: n + 1 }));
	const llm = fakeLlm();
	const rt = createAgencyRuntime({
		condition: "F",
		findings: true,
		planOnOpportunity: true,
		systemContext: { update: "host", select: "host" },
		llm,
		tools: [],
		restore: {
			state: { ...state, intents: [finding, ...later] },
			observations: history,
			cursor: history.length,
		},
	});
	rt.observe(
		obsInput(
			"now",
			"exchange.adopted",
			"user",
			NOW,
			"The requirements have changed",
		),
	);
	const evidenceRefs = ["w1", "now"];
	llm.push(
		"update",
		proposal([
			intentAddOp("g", { evidenceRefs }),
			candidateAddOp("c", "g", { evidenceRefs }),
		]),
	);
	llm.push("select", participation({ action: "wait" }));
	const result = await rt.decide(opportunity("idle", NOW), sig());
	const data = JSON.parse(llm.requests[0]!.prompt);
	expect(data.state.intents).toContainEqual(finding);
	expect(data.observations).toContainEqual({
		...history[0],
		text: body.slice(0, 400) + "…",
	});
	expect(rt.snapshot().observations[0]?.text).toBe(body);
	expect(data.freshIds).toEqual(["now"]);
	expect(result.calls[0]?.code).toBe("applied");
	expect(rt.snapshot().state.candidates.at(-1)?.evidence).toEqual(evidenceRefs);
});
