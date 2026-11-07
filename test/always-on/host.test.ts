/** The host-owned path (spec phase 5): instructions, contract and input provenance. */
import { describe, expect, test } from "bun:test";
import {
	alwaysOnOutputContract,
	alwaysOnSystem,
	alwaysOnSystemParts,
	createAlwaysOnAgent,
	stockOpSchema,
	userOpKinds,
} from "../../src/index.ts";
import { idle, op, say, scriptedThink, signal, wait } from "./helpers.ts";

const user = (id: string, at: number, text: string) => ({
	id,
	kind: "exchange.adopted" as const,
	actor: "user" as const,
	occurredAt: at,
	text,
});

describe("host-owned instructions", () => {
	test("the host's text is sent as is, with its sources among the call's inputs", async () => {
		const llm = scriptedThink(() => wait());
		const agent = createAlwaysOnAgent({
			llm,
			system: () => ({
				value: "HOST INSTRUCTIONS",
				input: { sources: ["persona:eumenes@1"], complete: true },
			}),
		});
		agent.observe(user("u1", 0, "こんにちは"));
		await agent.tick(10_000, idle, signal());
		expect(llm.requests[0]!.system).toBe("HOST INSTRUCTIONS");
		expect(llm.requests[0]!.input).toEqual({
			sources: ["u1", "persona:eumenes@1"],
			complete: true,
		});
	});

	test("a host replaces only the parts it owns; the contract names every operation", () => {
		const text = alwaysOnSystem({ persona: "あなたは Eumenes。" });
		expect(text).toContain("あなたは Eumenes。");
		expect(text).not.toContain(alwaysOnSystemParts().persona);
		expect(text).toContain(alwaysOnSystemParts().safety);
		expect(text).toContain(alwaysOnSystemParts().frame);
		for (const kind of [
			...userOpKinds,
			...stockOpSchema.shape.op.options,
			"mute_speech",
			"prepare",
		])
			expect(alwaysOnOutputContract.description).toContain(kind);
	});

	test("forgetting a host source drops what was derived from it and stops ticks that still use it", async () => {
		let source = "persona:eumenes@1";
		const llm = scriptedThink((_d, n) =>
			n === 1
				? say("ねえ", [], {
						userOps: [
							op({
								op: "fact.add",
								aspect: "likes",
								basis: "hypothesis",
								text: "猫が好きかも",
								reason: "-",
							}),
						],
					})
				: wait(),
		);
		const agent = createAlwaysOnAgent({
			llm,
			system: () => ({
				value: "HOST",
				input: { sources: [source], complete: true },
			}),
		});
		const t = await agent.tick(10_000, idle, signal());
		agent.recordResult({
			ticketId: t.ticket!.id,
			status: "succeeded",
			at: 10_000,
		});
		expect(agent.view().thoughts[0]!.inputs).toContain("persona:eumenes@1");
		agent.forget(["persona:eumenes@1"]);
		expect(agent.view().facts).toEqual([]);
		expect(agent.view().thoughts).toEqual([]);
		expect(agent.snapshot().observations).toEqual([]);
		// The host still hands over the forgotten source: no model call until it rebuilds.
		expect((await agent.tick(20_000, idle, signal())).skipped).toBe(
			"forgotten_input",
		);
		expect(llm.requests.length).toBe(1);
		source = "persona:eumenes@2";
		expect((await agent.tick(30_000, idle, signal())).skipped).toBeNull();
	});

	test("an input that does not name its sources runs until something is forgotten, then stops", async () => {
		const llm = scriptedThink(() => wait());
		const agent = createAlwaysOnAgent({
			llm,
			system: () => ({
				value: "HOST",
				input: { sources: [], complete: false },
			}),
		});
		agent.observe(user("u1", 0, "x"));
		expect((await agent.tick(10_000, idle, signal())).skipped).toBeNull();
		agent.forget(["u1"]);
		expect((await agent.tick(20_000, idle, signal())).skipped).toBe(
			"incomplete_input",
		);
		expect(llm.requests.length).toBe(1);
	});

	test("interests and tools carry their sources into the tick's inputs", async () => {
		const llm = scriptedThink(() => wait());
		const agent = createAlwaysOnAgent({
			llm,
			interests: [
				{
					id: "i1",
					text: "マイメロディ",
					input: { sources: ["memory:m9"], complete: true },
				},
			],
			tools: [
				{
					name: "research",
					description: "d",
					effect: "read",
					requiresApproval: false,
					input: { sources: ["catalog:r3"], complete: true },
				},
			],
		});
		await agent.tick(10_000, idle, signal());
		expect(agent.view().thoughts[0]!.inputs).toEqual([
			"memory:m9",
			"catalog:r3",
		]);
		agent.forget(["memory:m9"]);
		expect(agent.view().thoughts).toEqual([]);
	});

	test("what the host's memory knows is shown read-only, citable, and forgotten with its ref", async () => {
		let n = 0;
		const llm = scriptedThink((d) => {
			n++;
			const user = d["user"] as {
				fromMemory?: { items: { id: string; text: string }[] };
			};
			if (n === 1) {
				expect(user.fromMemory?.items).toEqual([
					{ id: "memory:s1", text: "辛いラーメンが好き" },
				]);
				return say("この前の辛いラーメンの話、また聞かせて", ["memory:s1"]);
			}
			return wait();
		});
		let items = [
			{
				id: "s1",
				text: "辛いラーメンが好き",
				input: { sources: ["record:r1"], complete: true },
			},
		];
		const agent = createAlwaysOnAgent({ llm, known: () => items });
		const t = await agent.tick(10_000, idle, signal());
		expect(t.ticket?.evidenceRefs).toEqual(["memory:s1"]);
		agent.recordResult({
			ticketId: t.ticket!.id,
			status: "succeeded",
			at: 10_000,
		});
		expect(agent.view().thoughts[0]!.inputs).toEqual([
			"record:r1",
			"memory:s1",
		]);
		agent.forget(["memory:s1"]);
		expect(agent.view().thoughts).toEqual([]);
		expect(agent.snapshot().observations).toEqual([]);
		expect((await agent.tick(20_000, idle, signal())).skipped).toBe(
			"forgotten_input",
		);
		items = [];
		expect((await agent.tick(30_000, idle, signal())).skipped).toBeNull();
		expect(
			(JSON.parse(llm.requests.at(-1)!.prompt) as { user: object }).user,
		).not.toHaveProperty("fromMemory");
	});
});
