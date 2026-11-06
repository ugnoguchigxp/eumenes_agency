import { expect, test } from "bun:test";
import {
	createAgencyRuntime,
	defaultBudget,
	emptyState,
	prepareCompaction,
	prepareForgetting,
	type AgencySnapshot,
} from "../../src/index.ts";
import {
	applyOrThrow,
	fakeLlm,
	intentAddOp,
	obs,
	opportunity,
	participation,
	proposal,
} from "./helpers.ts";

const source = (): AgencySnapshot => {
	const state = emptyState();
	state.notes.push({
		id: "n1",
		revision: 1,
		text: "過去に検証した条件を参照する",
		evidence: ["o1"],
	});
	return {
		condition: "B1",
		state,
		cursor: 80,
		observations: Array.from({ length: 80 }, (_, i) =>
			obs(i + 1, "user.report", "user", i === 0 ? "参照先の原文" : `別件${i}`),
		),
	};
};

test("a visible note recalls its original evidence beyond the recent observation window", async () => {
	const llm = fakeLlm();
	llm.push("select", participation());
	const rt = createAgencyRuntime({
		condition: "B1",
		systemContext: "experimental",
		restore: source(),
		llm,
		tools: [],
		budget: { ...defaultBudget, minIntervalMs: 0 },
	});
	await rt.decide(opportunity("p", 81 * 60_000), new AbortController().signal);
	expect(llm.requests.at(-1)?.prompt).toContain("参照先の原文");
	expect(llm.requests.at(-1)?.prompt).toContain("別件79");
});

test("recall uses an archive but never resurrects forgotten evidence", async () => {
	const snapshot = source();
	const plan = prepareCompaction({
		...snapshot,
		state: emptyState(),
	});
	const archive = {
		get: (id: string) => plan.archive.find((x) => x.observation.id === id),
	};
	const llm = fakeLlm();
	llm.push("select", participation());
	const rt = createAgencyRuntime({
		condition: "B1",
		systemContext: "experimental",
		restore: { ...plan.checkpoint, state: snapshot.state },
		archive,
		llm,
		tools: [],
	});
	await rt.decide(opportunity("p", 81 * 60_000), new AbortController().signal);
	expect(llm.requests.at(-1)?.prompt).toContain("参照先の原文");
	const forgotten = prepareForgetting(rt.snapshot(), ["o1"]);
	const after = fakeLlm();
	const clean = createAgencyRuntime({
		condition: "B1",
		systemContext: "experimental",
		restore: forgotten.checkpoint,
		archive,
		llm: after,
		tools: [],
	});
	await clean.decide(
		opportunity("q", 82 * 60_000),
		new AbortController().signal,
	);
	expect(after.requests.length).toBe(0);
});

test("note-mode recall does not retrieve evidence from hidden intent state", async () => {
	const saved = source();
	saved.state.notes[0]!.evidence = ["o2"];
	saved.state.intents = applyOrThrow(
		emptyState(),
		proposal([intentAddOp("old")]),
		saved.observations,
		"B2",
	).intents;
	const llm = fakeLlm();
	llm.push("select", participation());
	const rt = createAgencyRuntime({
		condition: "B1",
		systemContext: "experimental",
		restore: saved,
		llm,
		tools: [],
	});
	await rt.decide(opportunity("p", 81 * 60_000), new AbortController().signal);
	expect(llm.requests.at(-1)?.prompt).toContain("別件1");
	expect(llm.requests.at(-1)?.prompt).not.toContain("参照先の原文");
});

test("recall stays bounded and preserves the recent observation window", async () => {
	const saved = source();
	saved.state.notes[0]!.evidence = saved.observations
		.slice(0, 40)
		.map((o) => o.id);
	const llm = fakeLlm();
	llm.push("select", participation());
	const rt = createAgencyRuntime({
		condition: "B1",
		systemContext: "experimental",
		restore: saved,
		llm,
		tools: [],
	});
	await rt.decide(opportunity("p", 81 * 60_000), new AbortController().signal);
	const prompt = llm.requests.at(-1)!.prompt;
	expect([...prompt.matchAll(/\[o\d+\]/g)].length).toBeLessThanOrEqual(46);
	expect(prompt).toContain("別件39");
	expect(prompt).toContain("別件79");
});

for (const condition of ["B1", "F"] as const) {
	test(`${condition} shared citations do not crowd a distinct source out of recall`, async () => {
		const saved = source();
		if (condition === "B1") {
			for (let i = 0; i < 8; i++)
				saved.state.notes.push({
					id: `tail-${i}`,
					revision: 1,
					text: "同じ二つの出典を参照",
					evidence: ["o2", "o3"],
				});
		} else {
			saved.state.intents = applyOrThrow(
				emptyState(),
				proposal(
					Array.from({ length: 9 }, (_, i) =>
						intentAddOp(`g${i}`, {
							evidenceRefs: i === 0 ? ["o1"] : ["o2", "o3"],
						}),
					),
				),
				saved.observations,
				"F",
			).intents;
		}
		const llm = fakeLlm();
		llm.push("update", proposal());
		llm.push("select", participation());
		const rt = createAgencyRuntime({
			condition,
			systemContext: "experimental",
			restore: { ...saved, condition },
			llm,
			tools: [],
			planOnOpportunity: true,
			budget: { ...defaultBudget, minIntervalMs: 0 },
		});
		await rt.decide(
			opportunity("p", 81 * 60_000),
			new AbortController().signal,
		);
		expect(llm.requests[0]!.prompt).toContain("参照先の原文");
		expect(llm.requests[0]!.prompt).toContain("別件79");
	});
}

test("opportunity planning delivers the host opportunity to experimental update instructions", async () => {
	const llm = fakeLlm();
	llm.push("update", proposal());
	llm.push("select", participation());
	const rt = createAgencyRuntime({
		condition: "B1",
		systemContext: "experimental",
		restore: source(),
		llm,
		tools: [],
		planOnOpportunity: true,
		budget: { ...defaultBudget, minIntervalMs: 0 },
	});
	await rt.decide(
		opportunity("p", 81 * 60_000, { trigger: "idle" }),
		new AbortController().signal,
	);
	const update = llm.requests.find((r) => r.purpose === "update")!;
	expect(update.prompt).toContain("trigger=idle");
	expect(update.prompt).toContain("presence=quiet");
	expect(update.prompt).toContain("foregroundBusy=false");
});

test("a budgeted update repair receives the rejection codes in experimental text", async () => {
	const llm = fakeLlm();
	llm.push(
		"update",
		proposal([
			{
				op: "note.update",
				id: "absent",
				expectedRevision: 1,
				text: "受理されてはいけない内容",
				evidenceRefs: ["o1"],
			},
		]),
		proposal(),
	);
	llm.push("select", participation());
	const rt = createAgencyRuntime({
		condition: "B1",
		systemContext: "experimental",
		restore: source(),
		llm,
		tools: [],
		planOnOpportunity: true,
		repairUpdates: true,
		budget: { ...defaultBudget, minIntervalMs: 0 },
	});
	const result = await rt.decide(
		opportunity("p", 81 * 60_000),
		new AbortController().signal,
	);
	const updates = llm.requests.filter((r) => r.purpose === "update");
	expect(updates).toHaveLength(2);
	expect(updates[0]!.prompt).not.toContain("unknown_ref");
	expect(updates[1]!.prompt).toContain("unknown_ref");
	expect(result.calls.some((c) => c.code === "rejected:unknown_ref")).toBe(
		true,
	);
	expect(rt.snapshot().state.notes[0]!.text).toBe(
		"過去に検証した条件を参照する",
	);
});
