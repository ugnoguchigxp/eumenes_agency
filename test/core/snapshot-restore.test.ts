import { describe, expect, test } from "bun:test";
import type { z } from "zod";
import { createAgencyRuntime } from "../../src/application/runtime.ts";
import { ObservationConflictError } from "../../src/contracts/errors.ts";
import type { noteAdd, noteUpdate } from "../../src/contracts/proposals.ts";
import type { AgencySnapshot } from "../../src/contracts/runtime.ts";
import { HOUR, MIN, b1Proposal, fakeLlm, obsInput, toWire } from "./helpers.ts";

type Of<T extends z.ZodType> = z.infer<T>;

const T0 = 1_700_000_000_000;
const signal = () => new AbortController().signal;

const noteAddOp = (
	localId: string,
	o: Partial<Of<typeof noteAdd>> = {},
): Of<typeof noteAdd> => ({
	op: "note.add",
	localId,
	text: "登山への関心",
	evidenceRefs: ["o1"],
	kind: "interest",
	status: "active",
	origin: "experienced",
	derivedFromRefs: [],
	interestRef: null,
	reviewAfterHours: 1,
	...o,
});
const noteUpdateOp = (
	id: string,
	expectedRevision: number,
	o: Partial<Of<typeof noteUpdate>> = {},
): Of<typeof noteUpdate> => ({
	op: "note.update",
	id,
	expectedRevision,
	text: "登山への関心（更新）",
	evidenceRefs: [],
	status: null,
	reviewAfterHours: null,
	derivedFromRefs: [],
	interestRef: null,
	...o,
});

const deps = (llm: ReturnType<typeof fakeLlm>) => ({
	condition: "B1" as const,
	systemContext: "experimental" as const,
	typedNotes: true,
	llm,
	tools: [],
});

/** A runtime with one typed interest (review 1h after T0) and its snapshot. */
const buildOriginal = async () => {
	const llm = fakeLlm();
	const rt = createAgencyRuntime(deps(llm));
	rt.observe(
		obsInput(
			"o1",
			"exchange.adopted",
			"user",
			T0,
			"登山にハマって、月2回は低山に登っている",
		),
	);
	llm.push("update", toWire(b1Proposal([noteAddOp("new1")])));
	await rt.runBackground(T0, signal());
	expect(llm.count("update")).toBe(1);
	return { rt, llm, snapshot: rt.snapshot() };
};

describe("snapshot restore (S4)", () => {
	test("round-trips exactly and both runtimes continue identically", async () => {
		const { rt: a, llm: llmA, snapshot } = await buildOriginal();
		const llmB = fakeLlm();
		const b = createAgencyRuntime(deps(llmB), snapshot);
		expect(b.snapshot()).toEqual(snapshot);
		expect(b.projection(10)).toEqual(a.projection(10));

		// Continue both with the same new observation and the same scripted update.
		const cont = () =>
			toWire(
				b1Proposal([
					noteUpdateOp("n1", 1, { evidenceRefs: ["o2"], reviewAfterHours: 2 }),
				]),
			);
		llmA.push("update", cont());
		llmB.push("update", cont());
		for (const rt of [a, b])
			rt.observe(
				obsInput(
					"o2",
					"exchange.adopted",
					"user",
					T0 + 30 * MIN,
					"今週末は陣馬山に行く予定",
				),
			);
		await a.runBackground(T0 + 30 * MIN, signal());
		await b.runBackground(T0 + 30 * MIN, signal());
		expect(b.snapshot()).toEqual(a.snapshot());
		const reqA = llmA.requests.filter((r) => r.purpose === "update").at(-1);
		const reqB = llmB.requests.filter((r) => r.purpose === "update").at(-1);
		expect(reqB?.system).toBe(reqA?.system);
		expect(reqB?.prompt).toBe(reqA?.prompt);
	});

	test("processed observations are not re-interpreted after restore", async () => {
		const { snapshot } = await buildOriginal();
		const llm = fakeLlm();
		const b = createAgencyRuntime(deps(llm), snapshot);
		// Nothing new, review not yet due (T0+1h): zero model calls.
		await b.runBackground(T0 + 30 * MIN, signal());
		expect(llm.count()).toBe(0);
	});

	test("a review that came due during downtime wakes the restored runtime once", async () => {
		const { snapshot } = await buildOriginal();
		const llm = fakeLlm();
		const b = createAgencyRuntime(deps(llm), snapshot);
		llm.push(
			"update",
			toWire(b1Proposal([noteUpdateOp("n1", 1, { reviewAfterHours: 1 })])),
		);
		await b.runBackground(T0 + 2 * HOUR, signal());
		expect(llm.count("update")).toBe(1);
		await b.runBackground(T0 + 2 * HOUR + MIN, signal());
		expect(llm.count("update")).toBe(1);
	});

	test("observation idempotence and conflicts survive restore", async () => {
		const { snapshot } = await buildOriginal();
		const b = createAgencyRuntime(deps(fakeLlm()), snapshot);
		const same = b.observe(
			obsInput(
				"o1",
				"exchange.adopted",
				"user",
				T0,
				"登山にハマって、月2回は低山に登っている",
			),
		);
		expect(same.seq).toBe(1);
		expect(() =>
			b.observe(obsInput("o1", "exchange.adopted", "user", T0, "別の内容")),
		).toThrow(ObservationConflictError);
	});

	test("continuing the restored runtime does not mutate the snapshot object", async () => {
		const { snapshot } = await buildOriginal();
		const before = structuredClone(snapshot);
		const llm = fakeLlm();
		const b = createAgencyRuntime(deps(llm), snapshot);
		b.observe(obsInput("o2", "exchange.adopted", "user", T0 + MIN, "別の話題"));
		llm.push(
			"update",
			toWire(
				b1Proposal([
					noteAddOp("new2", {
						text: "別のメモ",
						evidenceRefs: ["o2"],
						kind: null,
						status: null,
						origin: null,
						reviewAfterHours: null,
					}),
				]),
			),
		);
		await b.runBackground(T0 + MIN, signal());
		expect(b.snapshot().state.notes.length).toBe(2);
		expect(snapshot).toEqual(before);
	});

	test("malformed snapshots are rejected", async () => {
		const { snapshot } = await buildOriginal();
		const badSeq: AgencySnapshot = {
			...snapshot,
			observations: snapshot.observations.map((o) => ({ ...o, seq: 9 })),
		};
		expect(() => createAgencyRuntime(deps(fakeLlm()), badSeq)).toThrow(
			/invalid snapshot/,
		);
		const badCursor: AgencySnapshot = { ...snapshot, cursor: 99 };
		expect(() => createAgencyRuntime(deps(fakeLlm()), badCursor)).toThrow(
			/invalid snapshot/,
		);
		const badState = {
			...snapshot,
			state: { ...snapshot.state, notes: "nope" },
		} as unknown as AgencySnapshot;
		expect(() => createAgencyRuntime(deps(fakeLlm()), badState)).toThrow(
			/invalid snapshot/,
		);
	});
});
