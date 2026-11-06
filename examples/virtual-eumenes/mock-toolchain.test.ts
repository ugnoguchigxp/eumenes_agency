import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createMockScene,
	fixtureAnswer,
	MIN,
	mockRevision,
	runMockConversation,
} from "./mock-scenario.ts";
import { MockToolchain } from "./mock-toolchain.ts";

const directories: string[] = [];
afterEach(() => {
	for (const path of directories.splice(0))
		rmSync(path, { recursive: true, force: true });
});
async function idea(
	scene: ReturnType<typeof createMockScene>,
	revision = mockRevision,
) {
	scene.host.observe({
		id: "o1",
		kind: "user.report",
		actor: "user",
		occurredAt: 0,
		text: "部屋で育てる植物を考えている。",
	});
	scene.setViews(
		[
			{
				id: "m1",
				text: scene.host.memory.get("o1")!.observation.text,
				input: { sources: ["o1"], complete: true },
			},
		],
		[],
	);
	scene.queueIdea(revision);
	const result = await scene.host.decide(scene.opportunity("idea", MIN));
	expect(result.decision.ticket?.action).toBe("tool");
	return result.decision.ticket!;
}

test("conversation -> Agency idea -> toolchain -> bundle -> subagent -> result -> grounded speech", async () => {
	const result = await runMockConversation();
	expect(result.success).toBe(true);
	expect(result.apiCalls).toBe(0);
	expect(result.events.map((e) => e.stage)).toEqual([
		"agency.idea",
		"toolchain.accepted",
		"bundle.started",
		"subagent.started",
		"subagent.returned",
		"result.accepted",
		"agency.speech",
	]);
	expect(result.utterance).toContain("明るい日陰");
});

test("the validated request reaches the mock subagent once and its return reaches the next Agency prompt", async () => {
	const calls: { question: string; acceptance: string }[] = [];
	const scene = createMockScene({
		async run(input) {
			calls.push(input);
			return { summary: fixtureAnswer, status: "succeeded" };
		},
	});
	try {
		const ticket = await idea(scene);
		expect(scene.chain.start(scene.host, ticket, MIN).started).toBe(true);
		expect(scene.chain.start(scene.host, ticket, MIN).started).toBe(false);
		expect(calls).toHaveLength(0);
		const returned = await scene.chain.finish(scene.host, ticket.id, 2 * MIN);
		if (!returned.accepted) throw Error("missing return");
		expect(calls).toHaveLength(1);
		expect(calls[0]!.question).toContain("出典の範囲");
		expect(calls[0]!.acceptance).not.toBe("");
		expect(
			scene.host.memory.get(returned.observationId)?.observation.text,
		).toBe(fixtureAnswer);
		const count = scene.host.snapshot().observations.length;
		expect(
			await scene.chain.finish(scene.host, ticket.id, 3 * MIN),
		).toMatchObject({ accepted: true, duplicate: true });
		expect(calls).toHaveLength(1);
		expect(scene.host.snapshot().observations).toHaveLength(count);
		scene.setViews(
			[],
			[
				{
					id: ticket.id,
					title: "Mock work",
					status: "done",
					result: fixtureAnswer,
					requestedAt: MIN,
					input: { sources: [returned.observationId], complete: true },
				},
			],
		);
		scene.queueSpeech("記録では明るい日陰を希望していたね。", [
			returned.observationId,
		]);
		const result = await scene.host.decide(scene.opportunity("share", 4 * MIN));
		scene.publish(result.decision.ticket!, 4 * MIN + 1);
		expect(scene.llm.requests.at(-1)!.prompt).toContain(fixtureAnswer);
		expect(scene.host.snapshot().state.intents[0]!.workRef).toBeNull();
		expect(
			scene.host
				.snapshot()
				.state.attempts.every((a) => a.status === "succeeded"),
		).toBe(true);
	} finally {
		scene.close();
	}
});

test("unknown or approval-required bundle revisions are refused without a mock subagent run", async () => {
	for (const mode of ["unknown", "approval"]) {
		const scene = createMockScene();
		let called = 0;
		try {
			const revision = mode === "unknown" ? "missing@1" : mockRevision;
			const ticket = await idea(scene, revision);
			const chain =
				mode === "approval"
					? new MockToolchain([
							{
								revisionId: mockRevision,
								title: "Restricted",
								description: "Requires grant",
								requiresApproval: true,
								subagent: {
									async run() {
										called++;
										return { summary: "not allowed", status: "succeeded" };
									},
								},
							},
						])
					: scene.chain;
			expect(chain.handoff(scene.host, ticket, MIN)).toMatchObject({
				accepted: false,
			});
			expect(called).toBe(0);
			expect(chain.events.some((e) => e.stage === "subagent.started")).toBe(
				false,
			);
			expect(scene.host.snapshot().state.attempts[0]!.status).toBe("failed");
			expect(scene.host.snapshot().state.intents[0]!.workRef).toBeNull();
		} finally {
			scene.close();
		}
	}
});

test("failed mock work is recorded as failure and cannot count as successful completion", async () => {
	const scene = createMockScene({
		async run() {
			return { summary: "mock failure", status: "failed" };
		},
	});
	try {
		const ticket = await idea(scene);
		scene.chain.start(scene.host, ticket, MIN);
		const result = await scene.chain.finish(scene.host, ticket.id, 2 * MIN);
		expect(result.accepted).toBe(true);
		expect(scene.host.snapshot().state.intents[0]!.lastReturn?.status).toBe(
			"failed",
		);
		expect(scene.host.snapshot().state.attempts[0]!.status).toBe("failed");
		expect(scene.host.snapshot().state.intents[0]!.state).toBe("held");
	} finally {
		scene.close();
	}
});

test("handoff checks current Memory availability even if an upstream deletion bypasses the runtime", async () => {
	const scene = createMockScene();
	try {
		const ticket = await idea(scene);
		expect(scene.host.memory.forget("o1").completed).toBe(true);
		expect(() => scene.chain.start(scene.host, ticket, MIN)).toThrow(
			"source unavailable",
		);
		expect(scene.chain.events).toEqual([]);
	} finally {
		scene.close();
	}
});

test("forgetting fences a running mock subagent and rejects its late return", async () => {
	let release!: (value: { summary: string; status: "succeeded" }) => void;
	let began!: () => void;
	const gate = new Promise<{ summary: string; status: "succeeded" }>(
		(resolve) => {
			release = resolve;
		},
	);
	const started = new Promise<void>((resolve) => {
		began = resolve;
	});
	const scene = createMockScene({
		async run() {
			began();
			return gate;
		},
	});
	try {
		const ticket = await idea(scene);
		scene.chain.start(scene.host, ticket, MIN);
		const pending = scene.chain.finish(scene.host, ticket.id, 2 * MIN);
		await started;
		scene.setViews([], []);
		expect(scene.host.forget("o1").completed).toBe(true);
		release({ summary: "忘却対象からの古い結果", status: "succeeded" });
		expect(await pending).toMatchObject({
			accepted: false,
			reason: "cancelled",
		});
		expect(scene.host.memory.get(`mock-return:${ticket.id}`)).toBeUndefined();
		expect(scene.host.snapshot().state.intents).toEqual([]);
		expect(scene.chain.events.some((e) => e.stage === "result.accepted")).toBe(
			false,
		);
	} finally {
		release({ summary: "discard", status: "succeeded" });
		scene.close();
	}
});

test("F owned instructions/topics/todos continue an independent conversation after forgetting and restart", async () => {
	const path = mkdtempSync(join(tmpdir(), "agency-independent-"));
	directories.push(path);
	let scene = createMockScene(undefined, path);
	try {
		scene.host.observe({
			id: "old",
			kind: "user.report",
			actor: "user",
			occurredAt: 0,
			text: "削除する会話",
		});
		expect(scene.host.forget("old").completed).toBe(true);
		scene.host.observe({
			id: "fresh",
			kind: "user.report",
			actor: "user",
			occurredAt: MIN,
			text: "今日は絵を見るのが楽しかった。",
		});
		scene.setViews(
			[
				{
					id: "m-new",
					text: scene.host.memory.get("fresh")!.observation.text,
					input: { sources: ["fresh"], complete: true },
				},
			],
			[
				{
					id: "t-new",
					title: "独立した話題の資料",
					status: "done",
					requestedAt: MIN,
					result: "新しい会話の資料",
					input: { sources: ["fresh"], complete: true },
				},
			],
		);
		scene.queueNewConversation("fresh", "どの絵が気になった？");
		const first = await scene.host.decide(scene.opportunity("new", 2 * MIN));
		expect(first.decision.ticket).toBeDefined();
		scene.publish(first.decision.ticket!, 2 * MIN + 1);
		scene.close();
		scene = createMockScene(undefined, path);
		expect(
			scene.host
				.snapshot()
				.observations.some((o) => o.text.includes("削除する会話")),
		).toBe(false);
		scene.host.observe({
			id: "next",
			kind: "user.report",
			actor: "user",
			occurredAt: 12 * MIN,
			text: "風景画の色がよかった。",
		});
		scene.queueNewConversation("next", "その色が印象に残ったんだね。");
		const second = await scene.host.decide(
			scene.opportunity("continue", 13 * MIN),
		);
		expect(second.decision.ticket).toBeDefined();
		scene.publish(second.decision.ticket!, 13 * MIN + 1);
		expect(scene.host.snapshot().cursor).toBeGreaterThan(1);
	} finally {
		scene.close();
	}
});
