import { describe, expect, test } from "bun:test";
import { createAlwaysOnAgent, type AlwaysOnTool } from "../../src/index.ts";
import { replyMessages } from "../../standalone/always-on-host.ts";
import {
	idle,
	op,
	prepare,
	say,
	scriptedThink,
	signal,
	wait,
} from "./helpers.ts";

const tools: AlwaysOnTool[] = [
	{
		name: "research",
		description: "調べもの",
		effect: "read",
		requiresApproval: false,
	},
	{
		name: "make_note",
		description: "メモを作る",
		effect: "create",
		requiresApproval: false,
	},
	{
		name: "send_mail",
		description: "メールを送る",
		effect: "external",
		requiresApproval: true,
	},
	{
		name: "edit_calendar",
		description: "予定を書き換える",
		effect: "modify",
		requiresApproval: false,
	},
];

const user = (id: string, at: number, text: string) => ({
	id,
	kind: "exchange.adopted" as const,
	actor: "user" as const,
	occurredAt: at,
	text,
});

const likesRamen = op({
	op: "fact.add",
	aspect: "likes",
	basis: "stated",
	text: "辛いラーメンが好き",
	evidenceRefs: ["u1"],
});

describe("preparation", () => {
	test("prepares silently for what the user likes, without any intent or candidate first", async () => {
		const agent = createAlwaysOnAgent({
			llm: scriptedThink(() =>
				prepare("research", "近所で評判の辛いラーメン店", ["u1"], {
					userOps: [likesRamen],
				}),
			),
			tools,
		});
		agent.observe(user("u1", 0, "辛いラーメンにハマってる"));
		const out = await agent.tick(10_000, idle, signal());
		expect(out.ticket).toMatchObject({
			action: "prepare",
			toolName: "research",
			toolInput: "近所で評判の辛いラーメン店",
			utterance: null,
		});
		expect(agent.view().preparing.length).toBe(1);
		// Preparing never counts as speaking.
		expect(agent.view().pacing.lastAgentAt).toBeNull();
	});

	test("only read/create tools without approval; every preparation names what it is for", async () => {
		const tries = [
			prepare("send_mail", "宛先に送る", ["u1"]),
			prepare("edit_calendar", "予定を変える", ["u1"]),
			prepare("nope", "x", ["u1"]),
			prepare("research", "理由のない調べもの", []),
			prepare("research", " ", ["u1"]),
		];
		const agent = createAlwaysOnAgent({
			llm: scriptedThink((_d, n) => tries[n - 1]!),
			tools,
		});
		agent.observe(user("u1", 0, "こんにちは"));
		const codes: string[][] = [];
		for (let i = 0; i < tries.length; i++)
			codes.push([
				...(await agent.tick(10_000 * (i + 1), idle, signal())).rejected,
			]);
		expect(codes).toEqual([
			["tool_not_autonomous"],
			["tool_not_autonomous"],
			["unknown_tool"],
			["needs_reason"],
			["empty_input"],
		]);
	});

	test("the model is shown only the usable tools", async () => {
		const llm = scriptedThink(() => wait());
		const agent = createAlwaysOnAgent({ llm, tools });
		await agent.tick(0, idle, signal());
		const data = JSON.parse(llm.requests[0]!.prompt) as {
			tools: { name: string }[];
		};
		expect(data.tools.map((t) => t.name)).toEqual(["research", "make_note"]);
	});

	test("the same preparation is not started twice while it runs", async () => {
		const agent = createAlwaysOnAgent({
			llm: scriptedThink(() => prepare("research", "辛いラーメン店", ["u1"])),
			tools,
		});
		agent.observe(user("u1", 0, "辛いラーメン好き"));
		await agent.tick(10_000, idle, signal());
		const again = await agent.tick(20_000, idle, signal());
		expect(again.rejected).toEqual(["duplicate_prepare"]);
	});

	test("a result becomes a finding written by code; sharing it marks it used", async () => {
		let n = 0;
		const agent = createAlwaysOnAgent({
			llm: scriptedThink((d) => {
				n++;
				if (n === 1) return prepare("research", "辛いラーメン店", ["u1"]);
				const stock = d["stock"] as {
					id: string;
					kind: string;
					text: string;
				}[];
				expect(stock[0]).toMatchObject({
					kind: "finding",
					text: "A店の担々麺が評判",
				});
				return say("気になって調べておいたよ。A店の担々麺が評判みたい", [
					stock[0]!.id,
				]);
			}),
			tools,
		});
		agent.observe(user("u1", 0, "辛いラーメン好き"));
		const t = await agent.tick(10_000, idle, signal());
		agent.recordResult({
			ticketId: t.ticket!.id,
			status: "succeeded",
			at: 10_000,
		});
		const o = agent.workReturned({
			ticketId: t.ticket!.id,
			at: 60_000,
			status: "succeeded",
			summary: "A店の担々麺が評判",
		});
		expect(o?.kind).toBe("work.returned");
		expect(agent.view().preparing).toEqual([]);
		const shared = await agent.tick(70_000, idle, signal());
		agent.recordResult({
			ticketId: shared.ticket!.id,
			status: "succeeded",
			at: 70_000,
		});
		expect(agent.view().stock[0]!.usedAt).toBe(70_000);
		// The reply can answer follow-up questions about it.
		expect(
			replyMessages(agent, [])
				.map((m) => m.content)
				.join("\n"),
		).toContain("A店の担々麺が評判");
	});

	test("a refused start or a failed result leaves no finding", async () => {
		const agent = createAlwaysOnAgent({
			llm: scriptedThink((_d, n) =>
				prepare("research", `調べもの${n}`, ["u1"]),
			),
			tools,
		});
		agent.observe(user("u1", 0, "x"));
		const a = await agent.tick(10_000, idle, signal());
		expect(
			agent.recordResult({
				ticketId: a.ticket!.id,
				status: "failed",
				at: 11_000,
			})?.kind,
		).toBe("action.observed");
		const b = await agent.tick(20_000, idle, signal());
		agent.workReturned({
			ticketId: b.ticket!.id,
			at: 30_000,
			status: "failed",
			summary: "見つからなかった",
		});
		expect(agent.view().stock).toEqual([]);
		expect(agent.view().preparing).toEqual([]);
	});

	test("ideas and questions are the agent's own stock; findings cannot be written by the model", async () => {
		const agent = createAlwaysOnAgent({
			llm: scriptedThink(() =>
				wait({
					stockOps: [
						{
							op: "stock.add",
							id: null,
							kind: "idea",
							text: "モンハンの新作の話を振ってみたい",
							targets: ["u1"],
						},
						{
							op: "stock.add",
							id: null,
							kind: "question",
							text: "好きな武器は？",
							targets: ["nope"],
						},
					],
				}),
			),
			tools,
		});
		agent.observe(user("u1", 0, "モンハン好き"));
		const out = await agent.tick(10_000, idle, signal());
		expect(out.applied).toEqual([expect.stringMatching(/^stock\.add s/)]);
		expect(out.rejected).toEqual(["stock.add:unknown_ref"]);
		expect(agent.view().stock.map((s) => s.kind)).toEqual(["idea"]);
	});

	test("stale stock is dropped after its freshness ends", async () => {
		const agent = createAlwaysOnAgent({
			llm: scriptedThink((_d, n) =>
				n === 1
					? wait({
							stockOps: [
								{
									op: "stock.add",
									id: null,
									kind: "idea",
									text: "今夜の話題",
									targets: [],
								},
							],
						})
					: wait(),
			),
		});
		await agent.tick(0, idle, signal());
		expect(agent.view().stock.length).toBe(1);
		await agent.tick(25 * 3_600_000, idle, signal());
		expect(agent.view().stock).toEqual([]);
	});

	test("the user's wish to be left alone mutes speech or preparation, read from new words", async () => {
		let n = 0;
		const agent = createAlwaysOnAgent({
			llm: scriptedThink(() => {
				n++;
				if (n === 1)
					return wait({
						pace: { op: "mute_speech", minutes: 30, evidenceRefs: ["u1"] },
					});
				if (n === 2) return say("ねえ");
				if (n === 3) return prepare("research", "集中に効く音楽", ["u1"]);
				// Re-reading the same words does not extend the mute.
				return wait({
					pace: { op: "mute_all", minutes: 600, evidenceRefs: ["u1"] },
				});
			}),
			tools,
		});
		agent.observe(user("u1", 0, "集中したいから30分は話しかけないで"));
		expect((await agent.tick(10_000, idle, signal())).applied).toEqual([
			"mute_speech 30",
		]);
		expect((await agent.tick(60_000, idle, signal())).rejected).toEqual([
			"speech_muted",
		]);
		expect((await agent.tick(120_000, idle, signal())).ticket?.action).toBe(
			"prepare",
		);
		expect((await agent.tick(180_000, idle, signal())).rejected).toEqual([
			"mute_all:needs_user_evidence",
		]);
	});

	test("forgetting what the user said drops the stock and preparations made for it", async () => {
		let n = 0;
		const agent = createAlwaysOnAgent({
			llm: scriptedThink(() => {
				n++;
				if (n === 1)
					return prepare("research", "辛いラーメン店", ["fact:f2"], {
						userOps: [likesRamen],
					});
				return prepare("make_note", "辛いラーメンの店リスト", ["fact:f2"]);
			}),
			tools,
		});
		agent.observe(user("u1", 0, "辛いラーメン好き"));
		// A fact made in this tick can already be cited by its action.
		const first = await agent.tick(10_000, idle, signal());
		expect(first.ticket?.action).toBe("prepare");
		const second = await agent.tick(20_000, idle, signal());
		agent.workReturned({
			ticketId: second.ticket!.id,
			at: 30_000,
			status: "succeeded",
			summary: "店リスト",
		});
		expect(agent.view().stock.length).toBe(1);
		expect(agent.view().preparing.length).toBe(1);
		agent.forget(["u1"]);
		expect(agent.view().stock).toEqual([]);
		expect(agent.view().preparing).toEqual([]);
		expect(agent.view().facts).toEqual([]);
	});
});
