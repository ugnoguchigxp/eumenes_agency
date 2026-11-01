import { expect, test } from "bun:test";
import { stageFactory } from "../action-steps/samples.ts";
import {
	fakeLlm,
	participation,
	proposal,
	intentAddOp,
	intentUpdateOp,
	candidateAddOp,
} from "../../test/core/helpers.ts";
import {
	experimentBudget,
	experimentLimits,
	experimentTools,
} from "../live-b1-f/run.ts";
import { createBudget } from "../../src/application/budget.ts";
import { ActivityBudget } from "../../src/application/activity-budget.ts";
import { createAgencyRuntime } from "../../src/index.ts";
const signal = () => new AbortController().signal;
const op = () => ({
	id: "op",
	at: 0,
	trigger: "idle" as const,
	presence: "quiet" as const,
	foregroundBusy: false,
	playerBusy: false,
});
const setup = (stage: "A0" | "A1" | "A2" | "A3" | "A4", max = 12) => {
	const llm = fakeLlm();
	const rt = stageFactory(stage)({
		condition: "F",
		systemContext: "experimental",
		llm,
		tools: experimentTools,
		budget: { ...experimentBudget, maxCallsPerWindow: max },
		limits: experimentLimits,
	});
	rt.observe({
		id: "o1",
		actor: "user",
		kind: "exchange.adopted",
		occurredAt: 0,
		text: "比較条件を調べてほしい",
	});
	llm.push("update", {
		...proposal([
			intentAddOp("g"),
			candidateAddOp("step", "g", {
				kind: "tool",
				toolName: "lookup",
				toolInput: "比較条件",
			}),
		]),
		interestOps: [],
	});
	return { rt, llm };
};
const choose = (candidate: string, revision: number, refs = ["o1"]) =>
	participation({
		action: "tool",
		candidateRef: { id: candidate, revision },
		toolName: "lookup",
		toolInput: null,
		evidenceRefs: refs,
	});

test("reference catalog mirrors native citable observations and excludes intent IDs", async () => {
	const { rt, llm } = setup("A1");
	await rt.runBackground(0, signal());
	const c = rt.snapshot().state.candidates[0]!;
	llm.push("select", choose(c.id, c.revision));
	await rt.decide(op(), signal());
	const data = JSON.parse(llm.requests.at(-1)!.prompt);
	expect(data.referenceCatalog.evidenceRefs).toContain("o1");
	expect(data.referenceCatalog.evidenceRefs).not.toContain(
		rt.snapshot().state.intents[0]!.id,
	);
	expect(data.referenceCatalog.candidateRefs[0].id).toBe(c.id);
});

test("one reference correction uses native reservation and records the extra shared-budget call", async () => {
	const { rt, llm } = setup("A2", 3);
	await rt.runBackground(0, signal());
	const c = rt.snapshot().state.candidates[0]!;
	llm.push(
		"select",
		choose(c.id, c.revision, ["i1"]),
		choose(c.id, c.revision),
	);
	const result = await rt.decide(op(), signal());
	expect(result.decision.ticket?.toolName).toBe("lookup");
	expect(llm.count("select")).toBe(2);
	expect(
		JSON.parse(llm.requests.at(-1)!.prompt).validationFeedback.codes,
	).toContain("unknown_ref");
	rt.recordResult({
		ticketId: result.decision.ticket!.id,
		at: 0,
		status: "succeeded",
		resultText: "条件の一部が分かった",
	});
	const after = await rt.runBackground(0, signal());
	expect(after.some((o) => o.code === "skipped:budget")).toBe(true);
	expect(llm.count()).toBe(3);
});

test("repair is bounded and a missing call budget prevents another API request", async () => {
	const { rt, llm } = setup("A2", 2);
	await rt.runBackground(0, signal());
	const c = rt.snapshot().state.candidates[0]!;
	llm.push(
		"select",
		choose(c.id, c.revision, ["bad"]),
		choose(c.id, c.revision),
	);
	expect((await rt.decide(op(), signal())).decision.ticket).toBeNull();
	expect(llm.count("select")).toBe(1);
	const b = setup("A2");
	await b.rt.runBackground(0, signal());
	const c2 = b.rt.snapshot().state.candidates[0]!;
	b.llm.push(
		"select",
		choose(c2.id, c2.revision, ["bad"]),
		choose(c2.id, c2.revision, ["still-bad"]),
	);
	expect((await b.rt.decide(op(), signal())).decision.ticket).toBeNull();
	expect(b.llm.count("select")).toBe(2);
});

test("approval rejection is never repaired or reserved", async () => {
	const llm = fakeLlm();
	const rt = stageFactory("A2")({
		condition: "F",
		systemContext: "experimental",
		llm,
		tools: experimentTools,
		budget: experimentBudget,
		limits: experimentLimits,
	});
	rt.observe({
		id: "o1",
		actor: "user",
		kind: "exchange.adopted",
		occurredAt: 0,
		text: "資料を調べたい",
	});
	llm.push("update", {
		...proposal([
			intentAddOp("g"),
			candidateAddOp("step", "g", {
				kind: "tool",
				toolName: "delete_files",
				toolInput: "records",
			}),
		]),
		interestOps: [],
	});
	await rt.runBackground(0, signal());
	const c = rt.snapshot().state.candidates[0]!;
	llm.push(
		"select",
		participation({
			action: "tool",
			candidateRef: { id: c.id, revision: c.revision },
			toolName: "delete_files",
			toolInput: "records",
			evidenceRefs: ["o1"],
		}),
	);
	const r = await rt.decide(op(), signal());
	expect(r.decision.ticket).toBeNull();
	expect(r.decision.rejectCodes).toContain("approval_required");
	expect(llm.count("select")).toBe(1);
	expect(rt.snapshot().state.attempts).toHaveLength(0);
});

test("invalidation during the first response prevents reference repair", async () => {
	const { rt, llm } = setup("A2");
	await rt.runBackground(0, signal());
	const c = rt.snapshot().state.candidates[0]!;
	llm.push("select", () => {
		rt.invalidate("speech_started", 0);
		return choose(c.id, c.revision, ["bad"]);
	});
	expect((await rt.decide(op(), signal())).decision.ticket).toBeNull();
	expect(llm.count("select")).toBe(1);
});

test("A3 asks for an actual utterance; A4 exposes the native activity meter and returned result", async () => {
	const { rt, llm } = setup("A4");
	await rt.runBackground(0, signal());
	const c = rt.snapshot().state.candidates[0]!;
	llm.push("select", choose(c.id, c.revision));
	const first = await rt.decide(op(), signal());
	rt.recordResult({
		ticketId: first.decision.ticket!.id,
		at: 0,
		status: "succeeded",
		resultText: "SOURCE-RESULT",
	});
	llm.push("update", { ...proposal([]), interestOps: [] });
	await rt.runBackground(3_600_000, signal());
	const req = llm.requests.at(-1)!;
	const data = JSON.parse(req.prompt);
	expect(req.system).toContain("利用者へ実際に話す完成した文");
	expect(data.executionContext.activities[0].canIssueTool).toBe(false);
	expect(data.executionContext.activities[0].usage.toolCalls).toBe(1);
	expect(data.executionContext.returnedResults[0].text).toContain(
		"SOURCE-RESULT",
	);
});

test("host-injected meters are the runtime meters and default behavior stays native", async () => {
	const callBudget = createBudget({
			...experimentBudget,
			maxCallsPerWindow: 1,
		}),
		activity = new ActivityBudget();
	const llm = fakeLlm();
	llm.push("update", { ...proposal([]), interestOps: [] });
	const rt = createAgencyRuntime({
		condition: "F",
		interestFormation: true,
		systemContext: "experimental",
		llm,
		tools: experimentTools,
		budget: experimentBudget,
		callBudgetMeter: callBudget,
		activityBudgetMeter: activity,
	});
	rt.observe({
		id: "o1",
		actor: "user",
		kind: "exchange.adopted",
		occurredAt: 0,
		text: "hello",
	});
	await rt.runBackground(0, signal());
	expect(callBudget.remaining(0)).toBe(0);
});

test("stale update gets one model correction without altering the proposed transition", async () => {
	const { rt, llm } = setup("A2");
	await rt.runBackground(0, signal());
	const i = rt.snapshot().state.intents[0]!;
	rt.observe({
		id: "o2",
		actor: "user",
		kind: "exchange.adopted",
		occurredAt: 1,
		text: "調査を止めてほしい",
	});
	llm.push(
		"update",
		{
			...proposal([
				intentUpdateOp(i.id, i.revision + 1, {
					transition: "held",
					evidenceRefs: ["o2"],
				}),
			]),
			interestOps: [],
		},
		{
			...proposal([
				intentUpdateOp(i.id, i.revision, {
					transition: "held",
					evidenceRefs: ["o2"],
				}),
			]),
			interestOps: [],
		},
	);
	await rt.runBackground(1, signal());
	expect(llm.count("update")).toBe(3);
	expect(rt.snapshot().state.intents[0]!.state).toBe("held");
	expect(
		JSON.parse(llm.requests.at(-1)!.prompt).validationFeedback.codes,
	).toContain("stale_revision");
});
