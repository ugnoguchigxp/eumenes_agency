import { describe, expect, test } from "bun:test";
import { selectEvidenceIds } from "../../src/application/prompts.ts";
import { createAgencyRuntime } from "../../src/application/runtime.ts";
import type { Condition } from "../../src/contracts/model.ts";
import {
	RECENT_OBSERVATION_WINDOW,
	defaultBudget,
} from "../../src/contracts/runtime.ts";
import {
	MIN,
	applyOrThrow,
	b1Proposal,
	candidateAddOp,
	defaultLimits,
	emptyState,
	fakeLlm,
	intentAddOp,
	obs,
	obsInput,
	opportunity,
	participation,
	proposal,
	tools,
} from "./helpers.ts";

const sig = () => new AbortController().signal;

const make = (condition: Condition, selectWhenEmpty = false) => {
	const llm = fakeLlm();
	const rt = createAgencyRuntime({
		systemContext: "experimental",
		condition,
		llm,
		tools,
		budget: { ...defaultBudget, minIntervalMs: 0, batchSize: 100 },
		limits: { ...defaultLimits, outboundIntervalMs: 0 },
		...(selectWhenEmpty ? { selectWhenEmpty: true } : {}),
	});
	return { llm, rt };
};

/** o1 becomes state evidence, then enough later observations push it out of the window. */
const seedOutsideWindow = async (
	condition: Condition,
	selectWhenEmpty = false,
) => {
	const m = make(condition, selectWhenEmpty);
	m.rt.observe(obsInput("o1", "user.report", "user", 0, "音声比較が未解決"));
	m.llm.push(
		"update",
		condition === "B1"
			? b1Proposal([
					{
						op: "note.add",
						localId: "n",
						text: "音声比較が未解決。後で再開",
						evidenceRefs: ["o1"],
					},
				])
			: proposal([intentAddOp("g"), candidateAddOp("k", "g")]),
	);
	await m.rt.runBackground(MIN, sig());
	// Later observations are interpreted without changing state, so o1 leaves the window.
	for (let n = 2; n < 2 + RECENT_OBSERVATION_WINDOW + 5; n++)
		m.rt.observe(
			obsInput(`o${n}`, "delivery.observed", "agent", n * 1000, `配信 ${n}`),
		);
	m.llm.push("update", condition === "B1" ? b1Proposal() : proposal());
	await m.rt.runBackground(2 * MIN, sig());
	return m;
};

const speak = (refs: string[], candidate: boolean) =>
	participation({
		action: "speak",
		utterance: "続きを確認しますか",
		candidateRef: candidate ? { id: "c2", revision: 1 } : null,
		evidenceRefs: refs,
	});

describe("select evidence refs may cite presented state items' evidence", () => {
	for (const condition of ["B1", "B2", "F"] as const) {
		const cand = condition !== "B1";

		test(`${condition}: an old evidence id shown on a state item is accepted`, async () => {
			const m = await seedOutsideWindow(condition);
			m.llm.push("select", speak(["o1"], cand));
			const r = await m.rt.decide(opportunity("op1", 30 * MIN), sig());
			const prompt = m.llm.requests.at(-1)?.prompt ?? "";
			expect(prompt).toContain("根拠: o1");
			expect(prompt).not.toContain("[o1]");
			expect(r.decision.rejectCodes).toEqual([]);
			expect(r.decision.action).toBe("speak");
		});

		test(`${condition}: an id outside the window and not shown stays unknown_ref`, async () => {
			const m = await seedOutsideWindow(condition);
			m.llm.push("select", speak(["o1", "o2"], cand));
			const r = await m.rt.decide(opportunity("op1", 30 * MIN), sig());
			expect(r.decision.source).toBe("rejected");
			expect(r.decision.rejectCodes).toContain("unknown_ref");
		});
	}
});

describe("B1a (selectWhenEmpty B1 with notes)", () => {
	test("a note's old evidence id is accepted, one not shown stays unknown_ref", async () => {
		const m = await seedOutsideWindow("B1", true);
		m.llm.push("select", speak(["o1"], false));
		const r = await m.rt.decide(opportunity("op1", 30 * MIN), sig());
		expect(m.llm.requests.at(-1)?.prompt ?? "").toContain("根拠: o1");
		expect(r.decision.rejectCodes).toEqual([]);
		expect(r.decision.action).toBe("speak");

		const m2 = await seedOutsideWindow("B1", true);
		m2.llm.push("select", speak(["o1", "o2"], false));
		const r2 = await m2.rt.decide(opportunity("op1", 30 * MIN), sig());
		expect(r2.decision.rejectCodes).toContain("unknown_ref");
	});
});

describe("selectEvidenceIds", () => {
	const o1 = obs(1, "user.report", "user");
	const o2 = obs(2, "user.report", "user");

	test("B2 counts open intents only; closed intents render no evidence", () => {
		const s = applyOrThrow(
			emptyState(),
			proposal([intentAddOp("g", { evidenceRefs: ["o1"] })]),
			[o1, o2],
		);
		expect([...selectEvidenceIds("B2", s)]).toEqual(["o1"]);
		const closed = {
			...s,
			intents: s.intents.map((i) => ({ ...i, state: "abandoned" as const })),
		};
		expect(selectEvidenceIds("B2", closed).size).toBe(0);
	});

	test("F counts open intent evidence, same as B2", () => {
		const s = applyOrThrow(
			emptyState(),
			proposal([intentAddOp("g", { evidenceRefs: ["o1"] })]),
			[o1, o2],
		);
		expect([...selectEvidenceIds("F", s)]).toEqual(["o1"]);
		expect(selectEvidenceIds("F", s)).toEqual(selectEvidenceIds("B2", s));
	});

	test("B1 counts note evidence", () => {
		const s = applyOrThrow(
			emptyState(),
			b1Proposal([
				{ op: "note.add", localId: "n", text: "x", evidenceRefs: ["o2"] },
			]),
			[o1, o2],
			"B1",
		);
		expect([...selectEvidenceIds("B1", s)]).toEqual(["o2"]);
	});
});
