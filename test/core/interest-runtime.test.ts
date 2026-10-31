/** Condition I (F + interestFormation) wiring through the runtime update path (P2-b). */
import { describe, expect, test } from "bun:test";
import { createAgencyRuntime, type LlmPort } from "../../src/index.ts";

const answer = (interestOps: unknown[]) => ({
	summary: "s",
	missingInfo: null,
	focusRefs: [],
	ops: [],
	reconciliations: [],
	interestOps,
});
const add = (origin: string, evidenceRefs: string[]) => ({
	op: "interest.add",
	id: null,
	localId: "n1",
	expectedRevision: null,
	status: null,
	topic: "将棋",
	origin,
	reason: "r",
	derivedFrom: null,
	evidenceRefs,
});
const fake = (value: unknown, seen: string[]): LlmPort => ({
	async complete(req) {
		seen.push(req.system);
		return {
			value: req.schema.parse(value),
			model: "fake",
			inputTokens: 0,
			outputTokens: 0,
			cacheReadTokens: 0,
			latencyMs: 0,
		} as never;
	},
});
const run = async (interestFormation: boolean, value: unknown) => {
	const seen: string[] = [];
	const rt = createAgencyRuntime({
		systemContext: "experimental",
		condition: "F",
		llm: fake(value, seen),
		tools: [],
		...(interestFormation ? { interestFormation } : {}),
	});
	rt.observe({
		id: "u1",
		kind: "exchange.adopted",
		actor: "user",
		occurredAt: 1,
		text: "将棋を勉強したい",
	});
	rt.observe({
		id: "a1",
		kind: "exchange.adopted",
		actor: "agent",
		occurredAt: 2,
		text: "いいですね",
	});
	const out = await rt.runBackground(10_000, new AbortController().signal);
	return { out, snap: rt.snapshot(), seen };
};

describe("condition I runtime", () => {
	test("interestOps are settled into the snapshot and the prompt asks for them", async () => {
		const r = await run(true, answer([add("user_relation", ["u1"])]));
		expect(
			r.snap.state.interests?.map((i) => [i.topic, i.status, i.origin]),
		).toEqual([["将棋", "emerging", "user_relation"]]);
		expect(r.seen[0]).toContain("interestOps");
	});
	test("user_relation from agent talk only is rejected with a code", async () => {
		const r = await run(true, answer([add("user_relation", ["a1"])]));
		expect(r.snap.state.interests).toEqual([]);
		expect(r.out.flatMap((o) => o.rejectCodes)).toContain(
			"interest:relation_needs_user",
		);
	});
	test("without the flag F is unchanged: no interests field, no interest rules", async () => {
		const { interestOps: _, ...plain } = answer([]);
		const r = await run(false, plain);
		expect(r.snap.state.interests).toBeUndefined();
		expect(r.seen[0]).not.toContain("interestOps");
	});
});
