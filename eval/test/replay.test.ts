import { describe, expect, test } from "bun:test";
import { computeIncomplete, replayCase } from "../replay.ts";
import {
	decision,
	outcome,
	sampleCase,
	StubRuntime,
	ticketFor,
} from "./fixtures.ts";
import type { Case } from "../contracts.ts";

const opts = (spent: () => number = () => 0) => ({
	runName: "r",
	settingsDigest: "d",
	instructionVersion: "v1",
	spent,
});

describe("replayCase", () => {
	test("runs background after the same-t group and decides at opportunities", async () => {
		const rt = new StubRuntime({
			decisions: {},
			background: [outcome("applied")],
		});
		const rec = await replayCase(sampleCase, "B1", 1, () => rt, opts());
		expect(rt.log).toEqual([
			"observe:s1",
			"observe:s2",
			"observe:s3",
			"background@300000",
			"decide:s4@300000",
			"decide:s5@600000",
		]);
		expect(rec.opportunities.map((o) => o.opportunityId)).toEqual(["s4", "s5"]);
		expect(rec.opportunities[1]?.expect).toBeNull();
		// 1 background run x1 call + 2 decide calls
		expect(rec.calls.map((c) => c.purpose)).toEqual([
			"update",
			"select",
			"select",
		]);
		expect(rec.incomplete).toBe(false);
		expect(rec.error).toBeNull();
		expect(rec.safety).toEqual([]);
		expect(rec.runName).toBe("r");
		expect(rec.labelStatus).toBe("draft");
	});

	test("speak ticket gets a succeeded receipt carrying the utterance", async () => {
		const rt = new StubRuntime({
			decisions: {
				s4: decision({
					opportunityId: "s4",
					action: "speak",
					utterance: "hello",
					evidenceRefs: ["s1", "s3"],
					ticket: ticketFor("s4", "speak", { utterance: "hello" }),
				}),
			},
		});
		const rec = await replayCase(sampleCase, "B1", 1, () => rt, opts());
		expect(rt.receipts).toEqual([
			{
				ticketId: "t-s4",
				status: "succeeded",
				at: 300_000,
				resultText: "hello",
			},
		]);
		expect(rec.opportunities[0]?.agentAuthoredRefs).toEqual(["s3"]);
		expect(rec.safety).toEqual([]);
	});

	test("tool script is consumed in order and exhaustion fails without a safety flag", async () => {
		const c: Case = {
			...sampleCase,
			steps: [
				...sampleCase.steps.slice(0, 4),
				{ ...(sampleCase.steps[4] as Case["steps"][number]), id: "s5", t: 6 },
				{ ...(sampleCase.steps[4] as Case["steps"][number]), id: "s6", t: 7 },
			],
		};
		const tool = (id: string) =>
			decision({
				opportunityId: id,
				action: "tool",
				toolName: "search_notes",
				ticket: ticketFor(id, "tool", { toolName: "search_notes" }),
			});
		const rt = new StubRuntime({
			decisions: { s4: tool("s4"), s5: tool("s5"), s6: tool("s6") },
		});
		const rec = await replayCase(c, "B2", 1, () => rt, opts());
		expect(rt.receipts.map((r) => [r.status, r.resultText])).toEqual([
			["succeeded", "found A"],
			["failed", "boom"],
			["failed", "tool script exhausted: search_notes"],
		]);
		expect(rec.safety).toEqual([]);
	});

	test("unauthorized tool is failed and flagged", async () => {
		const rt = new StubRuntime({
			decisions: {
				s4: decision({
					opportunityId: "s4",
					action: "tool",
					toolName: "rm_rf",
					ticket: ticketFor("s4", "tool", { toolName: "rm_rf" }),
				}),
			},
		});
		const rec = await replayCase(sampleCase, "B2", 1, () => rt, opts());
		expect(rt.receipts[0]?.status).toBe("failed");
		expect(rec.safety).toEqual(["unauthorized_tool:rm_rf"]);
	});

	test("ticket while not quiet or busy is flagged and never delivered", async () => {
		const c: Case = {
			...sampleCase,
			steps: sampleCase.steps.map((s) =>
				s.id === "s4" && s.type === "opportunity"
					? { ...s, presence: "speaking" }
					: s,
			),
		};
		const rt = new StubRuntime({
			decisions: {
				s4: decision({
					opportunityId: "s4",
					action: "speak",
					utterance: "x",
					ticket: ticketFor("s4", "speak", { utterance: "x" }),
				}),
			},
		});
		const rec = await replayCase(c, "B2", 1, () => rt, opts());
		expect(rec.safety).toEqual(["blocked_ticket:s4"]);
		expect(rt.receipts[0]?.status).toBe("failed");
	});

	test("usd is the spent() delta", async () => {
		let spent = 1;
		const rt = new StubRuntime({ decisions: {} });
		const origDecide = rt.decide.bind(rt);
		rt.decide = async (op) => {
			spent += 0.25;
			return origDecide(op);
		};
		const rec = await replayCase(
			sampleCase,
			"B1",
			1,
			() => rt,
			opts(() => spent),
		);
		expect(rec.usd).toBeCloseTo(0.5, 10);
	});

	test("a throw is captured, the partial record is kept", async () => {
		const rt = new StubRuntime({
			decisions: {
				s4: decision({ opportunityId: "s4" }),
			},
			throwOn: "background",
		});
		const rec = await replayCase(sampleCase, "B1", 2, () => rt, opts());
		expect(rec.error).toContain("bg boom");
		expect(rec.rep).toBe(2);
		expect(rec.opportunities).toEqual([]);
	});

	test("decide throw keeps earlier opportunities; makeRuntime throw is captured", async () => {
		const c: Case = {
			...sampleCase,
			steps: [
				...sampleCase.steps.slice(0, 4),
				{ ...(sampleCase.steps[4] as Case["steps"][number]), id: "s5", t: 6 },
			],
		};
		const rt = new StubRuntime({ decisions: {} });
		const orig = rt.decide.bind(rt);
		rt.decide = async (op) => {
			if (op.id === "s5") throw new Error("late boom");
			return orig(op);
		};
		const rec = await replayCase(c, "B1", 1, () => rt, opts());
		expect(rec.opportunities).toHaveLength(1);
		expect(rec.error).toContain("late boom");

		const rec2 = await replayCase(
			c,
			"B1",
			1,
			() => {
				throw new Error("no runtime");
			},
			opts(),
		);
		expect(rec2.error).toContain("no runtime");
		expect(rec2.finalState.notes).toBe(0);
	});
});

describe("replay granularity and integrity", () => {
	test("pending observations reach batchSize before the turn ends", async () => {
		const rt = new StubRuntime({ decisions: {} });
		await replayCase(sampleCase, "B1", 1, () => rt, {
			...opts(),
			batchSize: 2,
		});
		expect(rt.log.slice(0, 4)).toEqual([
			"observe:s1",
			"observe:s2",
			"background@0",
			"observe:s3",
		]);
		// pending resets after the background run: s3 alone (turn end) triggers the next one
		expect(rt.log).toContain("background@300000");
	});

	test("background is not run for user-only observations; decide handles them", async () => {
		const c: Case = {
			...sampleCase,
			steps: sampleCase.steps.filter((s) => s.id !== "s3"),
		};
		const rt = new StubRuntime({ decisions: {} });
		await replayCase(c, "B1", 1, () => rt, opts());
		expect(rt.log.some((l) => l.startsWith("background"))).toBe(false);
	});

	test("requiresApproval is passed to the runtime and a ticket for such a tool is a safety stop", async () => {
		const c: Case = {
			...sampleCase,
			tools: [
				{
					name: "send_mail",
					description: "d",
					requiresApproval: true,
					results: [],
				},
			],
		};
		let seen: unknown;
		const rt = new StubRuntime({
			decisions: {
				s4: decision({
					opportunityId: "s4",
					action: "tool",
					toolName: "send_mail",
					ticket: ticketFor("s4", "tool", { toolName: "send_mail" }),
				}),
			},
		});
		const rec = await replayCase(
			c,
			"B2",
			1,
			(tools) => {
				seen = tools;
				return rt;
			},
			opts(),
		);
		expect(seen).toEqual([
			{ name: "send_mail", description: "d", requiresApproval: true },
		]);
		expect(rec.safety).toEqual(["unauthorized_tool:send_mail"]);
		expect(rt.receipts[0]?.status).toBe("failed");
	});

	test("failed decide-time model calls are marked on the opportunity", async () => {
		const rt = new StubRuntime({ decisions: {} });
		rt.decide = async (op) => ({
			decision: decision({ opportunityId: op.id, source: "error" }),
			calls: [outcome("llm_call:connection", "select")],
		});
		const rec = await replayCase(sampleCase, "B1", 1, () => rt, opts());
		expect(rec.opportunities[0]?.rejectCodes).toEqual([
			"call:llm_call:connection",
		]);
	});

	test("incomplete: exception, spend limit, all calls failed (non-B0 only)", () => {
		const call = (code: string) => outcome(code);
		expect(computeIncomplete("B1", [], "boom")).toBe(true);
		expect(computeIncomplete("B1", [call("llm_call:spend_limit")], null)).toBe(
			true,
		);
		expect(
			computeIncomplete(
				"B2",
				[call("llm_call:connection"), call("error:X")],
				null,
			),
		).toBe(true);
		// Agent output failures never make a run incomplete (only infra does).
		expect(computeIncomplete("B2", [call("llm:refusal")], null)).toBe(false);
		expect(
			computeIncomplete("B2", [call("llm:schema"), call("rejected:x")], null),
		).toBe(false);
		expect(computeIncomplete("B2", [call("aborted")], null)).toBe(true);
		expect(
			computeIncomplete(
				"B2",
				[call("llm_call:connection"), call("applied")],
				null,
			),
		).toBe(false);
		expect(computeIncomplete("B2", [], null)).toBe(false);
		expect(computeIncomplete("B0", [call("error:X")], null)).toBe(false);
	});

	test("replayCase flags an exception run as incomplete", async () => {
		const rt = new StubRuntime({ decisions: {}, throwOn: "decide" });
		const rec = await replayCase(sampleCase, "B1", 1, () => rt, opts());
		expect(rec.incomplete).toBe(true);
	});
});
