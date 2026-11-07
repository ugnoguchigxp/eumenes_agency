/** Regression tests for the independent review of the always-on agent (2026-11-07). */
import { describe, expect, test } from "bun:test";
import {
	createAlwaysOnAgent,
	createHeartbeat,
	createHeartbeatScheduler,
	defaultHeartbeat,
	PREPARING_TTL_MS,
	type AlwaysOnTool,
} from "../../src/index.ts";
import { replyMessages } from "../../standalone/always-on-host.ts";
import { createMockPreparer } from "../../examples/virtual-eumenes/always-on-mock.ts";
import {
	idle,
	op,
	prepare,
	say,
	scriptedThink,
	signal,
	wait,
} from "./helpers.ts";

const user = (id: string, at: number, text: string) => ({
	id,
	kind: "exchange.adopted" as const,
	actor: "user" as const,
	occurredAt: at,
	text,
});
const tools: AlwaysOnTool[] = [
	{
		name: "research",
		description: "d",
		effect: "read",
		requiresApproval: false,
	},
];

describe("review fixes", () => {
	test("R1: forgetting reaches guesses, questions, ideas and what the agent said from them", async () => {
		const agent = createAlwaysOnAgent({
			llm: scriptedThink((_d, n) => {
				if (n === 1)
					return wait({
						userOps: [
							op({
								op: "fact.add",
								aspect: "likes",
								basis: "hypothesis",
								text: "辛いラーメンが好き",
								reason: "言っていた",
							}),
							op({ op: "gap.add", text: "担々麺は好き？", reason: "-" }),
						],
						stockOps: [
							{
								op: "stock.add",
								id: null,
								kind: "idea",
								text: "辛いラーメンの話を振る",
								targets: [],
							},
						],
					});
				return say("辛いラーメン好きなんだね", ["u1"]);
			}),
		});
		agent.observe(user("u1", 0, "辛いラーメンが好き"));
		await agent.tick(1_000, idle, signal());
		const t = await agent.tick(20_000, idle, signal());
		agent.recordResult({
			ticketId: t.ticket!.id,
			status: "succeeded",
			at: 20_001,
		});
		agent.forget(["u1"]);
		const v = agent.view();
		expect([v.facts, v.gaps, v.stock, v.thoughts]).toEqual([[], [], [], []]);
		expect(agent.snapshot().observations).toEqual([]);
		expect(
			replyMessages(agent, [])
				.map((m) => m.content)
				.join(""),
		).not.toContain("辛いラーメン");
	});

	test("R1: a result prepared from forgotten words goes, with its returned observation", async () => {
		const agent = createAlwaysOnAgent({
			llm: scriptedThink(() => prepare("research", "辛いラーメン店", ["u1"])),
			tools,
		});
		agent.observe(user("u1", 0, "辛いラーメンが好き"));
		agent.observe(user("u2", 1, "別の話"));
		const t = await agent.tick(10_000, idle, signal());
		agent.workReturned({
			ticketId: t.ticket!.id,
			at: 20_000,
			status: "succeeded",
			summary: "A店",
		});
		agent.forget(["u1"]);
		expect(agent.view().stock).toEqual([]);
		expect(agent.snapshot().observations.map((o) => o.id)).toEqual(["u2"]);
	});

	test("R2: a stated fact cannot be rewritten by downgrading it to a guess", async () => {
		const agent = createAlwaysOnAgent({
			llm: scriptedThink((_d, n) =>
				n === 1
					? wait({
							userOps: [
								op({
									op: "fact.add",
									aspect: "likes",
									basis: "stated",
									text: "辛いのが好き",
									evidenceRefs: ["u1"],
								}),
							],
						})
					: wait({
							userOps: [
								op({
									op: "fact.update",
									id: "f2",
									basis: "hypothesis",
									text: "辛いのは苦手",
								}),
								op({ op: "fact.update", id: "f2", evidenceRefs: ["u1"] }),
							],
						}),
			),
		});
		agent.observe(user("u1", 0, "辛いのが好き"));
		await agent.tick(1_000, idle, signal());
		const o = await agent.tick(20_000, idle, signal());
		expect(o.rejected).toEqual([
			"fact.update:needs_user_evidence",
			"fact.update:already_read",
		]);
		expect(agent.view().facts[0]).toMatchObject({
			basis: "stated",
			text: "辛いのが好き",
		});
	});

	test("R3: forgetting follows fact→gap and gap→gap chains to the end", async () => {
		const agent = createAlwaysOnAgent({
			llm: scriptedThink((_d, n) =>
				n === 1
					? wait({
							userOps: [
								op({ op: "gap.add", text: "休日は？", evidenceRefs: ["u1"] }),
							],
						})
					: wait({
							userOps: [
								op({
									op: "fact.add",
									aspect: "routine",
									basis: "hypothesis",
									text: "休日は家",
									evidenceRefs: ["gap:g2"],
								}),
							],
						}),
			),
		});
		agent.observe(user("u1", 0, "x"));
		await agent.tick(1_000, idle, signal());
		// The second tick is shown nothing forgotten later, so only the chain links it to u1.
		agent.observe(user("u2", 10_000, "y"));
		await agent.tick(20_000, idle, signal());
		expect(agent.view().facts.length).toBe(1);
		agent.forget(["u1"]);
		expect(agent.view().gaps).toEqual([]);
		expect(agent.view().facts).toEqual([]);
	});

	test("R4: a preparation that never returns expires; an unknown outcome is not a failure", async () => {
		const agent = createAlwaysOnAgent({
			llm: scriptedThink(() => prepare("research", "q", ["u1"])),
			tools,
		});
		agent.observe(user("u1", 0, "x"));
		const t = await agent.tick(1_000, idle, signal());
		agent.recordResult({
			ticketId: t.ticket!.id,
			status: "outcome_unknown",
			at: 2_000,
		});
		expect(agent.view().preparing.length).toBe(1);
		const restored = createAlwaysOnAgent({
			llm: scriptedThink(() => prepare("research", "q", ["u1"])),
			tools,
			restore: agent.snapshot(),
		});
		const again = await restored.tick(1_000 + PREPARING_TTL_MS, idle, signal());
		expect(again.rejected).toEqual([]);
		expect(again.ticket?.action).toBe("prepare");
	});

	test("R5: a failing mock subagent becomes a failed result, not an unhandled rejection", async () => {
		const preparer = createMockPreparer({
			subagent: { run: () => Promise.reject(new Error("api down")) },
			delayMs: 10,
		});
		const accepted = preparer.start(
			{
				id: "t1",
				tickId: "k1",
				action: "prepare",
				utterance: null,
				toolName: "research",
				toolInput: "q",
				drive: "delight",
				evidenceRefs: ["u1"],
				inputs: [],
				at: 0,
			},
			0,
		);
		expect(accepted).toBe(true);
		await new Promise((r) => setTimeout(r, 5));
		expect(await preparer.due(10)).toEqual([
			{ ticketId: "t1", at: 10, status: "failed", summary: "api down" },
		]);
	});

	test("R7: a mute needs a finite time", () => {
		const agent = createAlwaysOnAgent({ llm: scriptedThink(() => wait()) });
		expect(() => agent.mute(Number.NaN)).toThrow(RangeError);
		agent.mute(null);
	});

	test("R8: declined questions are kept even after many answered ones", async () => {
		let n = 0;
		const agent = createAlwaysOnAgent({
			llm: scriptedThink(() => {
				n++;
				if (n === 1)
					return wait({
						userOps: [op({ op: "gap.add", text: "家族構成", reason: "-" })],
					});
				if (n === 2)
					return wait({
						userOps: [
							op({
								op: "gap.close",
								id: "g2",
								status: "declined",
								evidenceRefs: [`u${n}`],
							}),
						],
					});
				// Each later tick adds a question and closes it with the new answer.
				return wait({
					userOps: [op({ op: "gap.add", text: `問い${n}`, reason: "-" })],
				});
			}),
		});
		await agent.tick(0, idle, signal());
		agent.observe(user("u2", 1, "家族の話はちょっと"));
		await agent.tick(10_000, idle, signal());
		for (let i = 0; i < 40; i++) await agent.tick(20_000 + i, idle, signal());
		expect(agent.view().gaps.some((g) => g.status === "declined")).toBe(true);
	});

	test("R9: a reply that resets the heartbeat is not overwritten by the tick in flight", async () => {
		let now = 0;
		const h = createHeartbeat(defaultHeartbeat, 0);
		h.ticked(0, "later");
		let release: () => void = () => undefined;
		const s = createHeartbeatScheduler({
			heartbeat: h,
			now: () => now,
			setTimer: () => 1,
			clearTimer: () => undefined,
			run: () =>
				new Promise((resolve) => {
					release = () => resolve({ next: "later", wakeAt: null });
				}),
		});
		const running = s.fireNow();
		now = 5_000;
		h.event(now);
		release();
		await running;
		expect(h.delayMs(now)).toBe(10_000);
	});
});
