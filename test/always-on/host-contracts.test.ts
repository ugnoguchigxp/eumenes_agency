import { expect, test } from "bun:test";
import {
	createAlwaysOnAgent,
	PREPARING_TTL_MS,
	prepareAlwaysOnForgetting,
} from "../../src/index.ts";
import { idle, op, say, scriptedThink, signal, wait } from "./helpers.ts";

const user = (id: string, at = 0) => ({
	id,
	kind: "exchange.adopted" as const,
	actor: "user" as const,
	occurredAt: at,
	text: `fixture ${id}`,
});
const tool = {
	name: "reader",
	description: "fixture read",
	effect: "read" as const,
	requiresApproval: false,
	input: { sources: ["capability:rev"], complete: true },
};

test("forgetting an issued speech refuses a late receipt, including after source leaves the window", async () => {
	const agent = createAlwaysOnAgent({
		llm: scriptedThink(() => say("fixture speech")),
	});
	agent.observe(user("a"), {
		sources: ["record:a", "record:b"],
		complete: true,
	});
	const out = await agent.tick(10_000, idle, signal());
	agent.forget(["record:b"]);
	expect(
		agent.recordResult({
			ticketId: out.ticket!.id,
			status: "succeeded",
			at: 11_000,
		}),
	).toBeNull();
	expect(agent.view().observations).toBe(0);
	expect(agent.view().pacing.unanswered).toBe(0);
});

test("thoughts inherit all displayed input sources without requiring a model citation", async () => {
	const llm = scriptedThink((data, n) => {
		if (n === 2)
			expect(JSON.stringify(data["thoughts"])).toContain("dependent material");
		return wait({ thought: "dependent material" });
	});
	const agent = createAlwaysOnAgent({ llm });
	agent.observe(user("old"), { sources: ["source:old"], complete: true });
	await agent.tick(10_000, idle, signal());
	for (let i = 0; i < 201; i++) agent.observe(user(`new${i}`, 20_000 + i));
	await agent.tick(30_000, idle, signal());
	expect(llm.requests[1]!.input?.sources).toContain("source:old");
	agent.forget(["source:old"]);
	expect(agent.view().thoughts).toHaveLength(0);
});

test("expired preparation return is refused without an intervening tick and after restore", () => {
	const deps = { llm: scriptedThink(() => wait()), tools: [tool] };
	const agent = createAlwaysOnAgent(deps);
	agent.observe(user("a"));
	const result = agent.requestPrepare({
		toolName: tool.name,
		toolInput: "fixture",
		at: 0,
	});
	if (!("ticket" in result)) throw new Error("fixture refused");
	const restored = createAlwaysOnAgent({ ...deps, restore: agent.snapshot() });
	for (const value of [agent, restored]) {
		expect(
			value.workReturned({
				ticketId: result.ticket.id,
				at: PREPARING_TTL_MS,
				status: "succeeded",
				summary: "expired",
			}),
		).toBeNull();
		expect(value.view().stock).toHaveLength(0);
		expect(value.view().preparing).toHaveLength(0);
	}
});

test("requested preparations bind the original user and inherit capability and reply inputs", () => {
	const agent = createAlwaysOnAgent({
		llm: scriptedThink(() => wait()),
		tools: [tool],
	});
	agent.observe(user("a"));
	agent.observe(user("b", 1));
	expect(
		agent.requestPrepare({
			toolName: tool.name,
			toolInput: "fixture",
			at: 2,
			observationId: "a",
		}),
	).toEqual({ rejected: "stale_user_request" });
	const result = agent.requestPrepare({
		toolName: tool.name,
		toolInput: "fixture",
		at: 2,
		observationId: "b",
		input: { sources: ["memory:reply"], complete: true },
	});
	if (!("ticket" in result)) throw new Error("fixture refused");
	expect(result.ticket.inputs).toEqual(["b", "capability:rev", "memory:reply"]);
	agent.forget(["capability:rev"]);
	expect(agent.view().preparing).toHaveLength(0);
});

test("an explicitly supplied empty host memory owns facts, but hypotheses remain possible", async () => {
	const llm = scriptedThink(() =>
		wait({
			userOps: [
				op({
					op: "fact.add",
					aspect: "likes",
					basis: "stated",
					text: "fixture fact",
					evidenceRefs: ["a"],
				}),
				op({
					op: "fact.add",
					aspect: "likes",
					basis: "hypothesis",
					text: "fixture guess",
				}),
			],
		}),
	);
	const agent = createAlwaysOnAgent({ llm, known: () => [] });
	agent.observe(user("a"));
	const out = await agent.tick(10_000, idle, signal());
	expect(out.rejected).toContain("fact.add:host_owned_fact");
	expect(agent.view().facts.map((f) => f.basis)).toEqual(["hypothesis"]);
	expect(llm.requests[0]!.system).toContain("正本");
	const restored = createAlwaysOnAgent({
		llm,
		known: () => [],
		restore: agent.snapshot(),
	});
	expect(restored.view().facts.map((f) => f.basis)).toEqual(["hypothesis"]);
});

test("voice receipts record actual text and identity exactly once", async () => {
	const agent = createAlwaysOnAgent({
		llm: scriptedThink(() => say("proposal")),
	});
	const { ticket } = await agent.tick(0, idle, signal());
	const receipt = {
		ticketId: ticket!.id,
		at: 1,
		status: "succeeded" as const,
		text: "actual transcript",
		observationId: "voice:actual",
	};
	expect(agent.recordResult(receipt)).toMatchObject({
		id: "voice:actual",
		text: "actual transcript",
	});
	expect(agent.recordResult(receipt)).toBeNull();
	expect(agent.view().pacing.unanswered).toBe(1);
});

test("abort after provider completion never keeps derived state", async () => {
	const controller = new AbortController();
	const agent = createAlwaysOnAgent({
		llm: scriptedThink(() => {
			controller.abort();
			return wait();
		}),
	});
	await agent.tick(0, idle, controller.signal);
	expect(agent.view().thoughts).toHaveLength(0);
});

test("recovery records a verified delivery once and pure forgetting removes its sources", async () => {
	const llm = scriptedThink(() => say("delivered"));
	const agent = createAlwaysOnAgent({ llm });
	agent.observe(user("a"), { sources: ["record:original"], complete: true });
	const { ticket } = await agent.tick(10_000, idle, signal());
	const restored = createAlwaysOnAgent({ llm, restore: agent.snapshot() });
	const receipt = {
		ticketId: ticket!.id,
		at: 11_000,
		status: "succeeded" as const,
		observationId: "actual-delivery",
	};
	expect(restored.recordResult(receipt, ticket!)).not.toBeNull();
	restored.recordResult(receipt, ticket!);
	expect(restored.view().pacing.unanswered).toBe(1);
	const forgotten = prepareAlwaysOnForgetting(restored.snapshot(), [
		"record:original",
	]);
	expect(forgotten.observations).toHaveLength(0);
	expect(forgotten.state.thoughts).toHaveLength(0);
	expect(restored.snapshot().observations).toHaveLength(2);
});
