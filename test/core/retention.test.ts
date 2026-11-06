import { expect, test } from "bun:test";
import {
	createAgencyRuntime,
	defaultBudget,
	defaultLimits,
	defaultRetentionLimits,
	ObservationCapacityError,
} from "../../src/index.ts";
import { createLedger } from "../../src/domains/experience/ledger.ts";
import {
	fakeLlm,
	obsInput,
	proposal,
	intentAddOp,
	candidateAddOp,
	participation,
	opportunity,
	tools,
} from "./helpers.ts";

const signal = () => new AbortController().signal;

test("full ledger rejects input without advancing identity/cursor and keeps idempotent replay", () => {
	const l = createLedger({ ...defaultRetentionLimits, observations: 1 });
	const input = obsInput("a", "user.report", "user", 0, "入力");
	const a = l.record(input);
	expect(() => l.record({ ...input, id: "b" })).toThrow(
		ObservationCapacityError,
	);
	expect(l.lastSeq()).toBe(1);
	expect(l.cursor()).toBe(0);
	expect(l.record(input)).toBe(a);
	expect(l.pending()).toEqual([a]);
});

test("UTF-8 byte boundaries include metadata and multi-byte text", () => {
	const input = obsInput("a", "user.report", "user", 0, "日本語");
	const bytes = new TextEncoder().encode(JSON.stringify(input)).byteLength;
	const exact = createLedger({
		...defaultRetentionLimits,
		observationBytes: bytes,
		totalObservationBytes: bytes,
	});
	expect(exact.record(input).seq).toBe(1);
	expect(() => exact.record({ ...input, id: "b" })).toThrow(
		ObservationCapacityError,
	);
	const small = createLedger({
		...defaultRetentionLimits,
		observationBytes: bytes - 1,
	});
	expect(() => small.record(input)).toThrow(ObservationCapacityError);
	expect(small.lastSeq()).toBe(0);
});

async function reserved(observations = 100) {
	const f = fakeLlm();
	const rt = createAgencyRuntime({
		condition: "B2",
		systemContext: "experimental",
		llm: f,
		tools: [
			...tools,
			{ name: "delegate", description: "fixture", requiresApproval: false },
		],
		retentionLimits: { ...defaultRetentionLimits, observations },
		budget: { ...defaultBudget, minIntervalMs: 0 },
		limits: { ...defaultLimits, outboundIntervalMs: 0 },
	});
	rt.observe(obsInput("o1", "user.report", "user", 0, "比較"));
	f.push(
		"update",
		proposal([
			intentAddOp("g"),
			candidateAddOp("c", "g", {
				kind: "tool",
				toolName: "delegate",
				toolInput: "question",
			}),
		]),
	);
	f.push(
		"select",
		participation({
			action: "tool",
			candidateRef: { id: "c2", revision: 1 },
			evidenceRefs: ["o1"],
		}),
	);
	const r = await rt.decide(opportunity("p", 1), signal());
	expect(r.decision.ticket).not.toBeNull();
	return { rt, f, ticket: r.decision.ticket! };
}

test("receipt backpressure cannot half-apply attempt success or consume an id", async () => {
	const { rt, ticket } = await reserved(1);
	const before = rt.snapshot();
	expect(() =>
		rt.recordResult({
			ticketId: ticket.id,
			at: 2,
			status: "succeeded",
			resultText: "result",
		}),
	).toThrow(ObservationCapacityError);
	expect(rt.snapshot()).toEqual(before);
});

test("retained state capacity rejects the complete update and keeps the batch pending", async () => {
	const f = fakeLlm();
	const rt = createAgencyRuntime({
		condition: "B2",
		systemContext: "experimental",
		llm: f,
		tools: [],
		retentionLimits: { ...defaultRetentionLimits, stateItems: 1 },
	});
	rt.observe(obsInput("o1", "user.report", "user", 0, "比較"));
	f.push("update", proposal([intentAddOp("g"), candidateAddOp("c", "g")]));
	const calls = await rt.runBackground(0, signal());
	expect(calls[0]?.code).toBe("rejected:retention_capacity");
	expect(rt.snapshot().state.intents).toEqual([]);
	expect(rt.snapshot().cursor).toBe(0);
});

test("host usage is idempotent across restart; conflicting and unknown receipts are rejected", async () => {
	const { rt, ticket } = await reserved();
	const receipt = {
		id: "usage-1",
		ticketId: ticket.id,
		at: 2,
		inputTokens: 30,
		outputTokens: 20,
	};
	rt.recordUsage!(receipt);
	rt.recordUsage!(receipt);
	expect(rt.snapshot().continuity?.activities[0]?.[1].tokens).toBe(170);
	expect(() => rt.recordUsage!({ ...receipt, outputTokens: 21 })).toThrow(
		"conflict",
	);
	const restored = createAgencyRuntime({
		condition: "B2",
		systemContext: "experimental",
		llm: fakeLlm(),
		tools,
		restore: rt.snapshot(),
	});
	restored.recordUsage!(receipt);
	expect(restored.snapshot().continuity?.activities[0]?.[1].tokens).toBe(170);
	expect(() =>
		restored.recordUsage!({ ...receipt, id: "other", ticketId: "missing" }),
	).toThrow("unknown");
});

test("late usage is recorded without restarting a returned activity", async () => {
	const { rt, ticket } = await reserved();
	rt.observe({
		...obsInput("returned", "work.returned", "tool", 2, "done"),
		workRef: ticket.id,
		workStatus: "succeeded",
	});
	expect(rt.snapshot().continuity?.activities).toEqual([]);
	rt.recordUsage!({
		id: "late",
		ticketId: ticket.id,
		at: 3,
		inputTokens: 30,
		outputTokens: 20,
	});
	expect(rt.snapshot().continuity?.activities).toEqual([]);
	expect(rt.snapshot().continuity?.usageReceipts).toHaveLength(1);
});

test("late usage cannot charge a later activity that starts in the same clock tick", async () => {
	const { rt, f, ticket } = await reserved();
	rt.observe({
		...obsInput("returned", "work.returned", "tool", 1, "done"),
		workRef: ticket.id,
		workStatus: "succeeded",
	});
	f.push(
		"update",
		proposal([
			candidateAddOp("again", "i1", {
				kind: "tool",
				toolName: "delegate",
				toolInput: "next",
			}),
		]),
	);
	f.push(
		"select",
		participation({
			action: "tool",
			candidateRef: { id: "c4", revision: 1 },
			evidenceRefs: ["o1"],
		}),
	);
	const next = await rt.decide(opportunity("second", 1), signal());
	expect(next.decision.ticket).not.toBeNull();
	const before = rt.snapshot().continuity!.activities[0]![1].tokens;
	rt.recordUsage!({
		id: "late-old",
		ticketId: ticket.id,
		at: 2,
		inputTokens: 30,
		outputTokens: 20,
	});
	expect(rt.snapshot().continuity!.activities[0]![1].tokens).toBe(before);
	const restored = createAgencyRuntime({
		condition: "B2",
		systemContext: "experimental",
		llm: fakeLlm(),
		tools,
		restore: rt.snapshot(),
	});
	restored.recordUsage!({
		id: "late-old-after-restart",
		ticketId: ticket.id,
		at: 2,
		inputTokens: 30,
		outputTokens: 20,
	});
	expect(restored.snapshot().continuity!.activities[0]![1].tokens).toBe(before);
	const receipt = {
		id: "current",
		ticketId: next.decision.ticket!.id,
		at: 2,
		inputTokens: 30,
		outputTokens: 20,
	};
	restored.recordUsage!(receipt);
	restored.recordUsage!(receipt);
	expect(restored.snapshot().continuity!.activities[0]![1].tokens).toBe(
		before + 50,
	);
});
