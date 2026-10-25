import { describe, expect, test } from "bun:test";
import { createMockToolPort } from "../../src/application/mock-tool-port.ts";

const signal = new AbortController().signal;
const use = async (
	port: ReturnType<typeof createMockToolPort>,
	name: string,
	args: unknown,
) => {
	const { content } = await port.call(
		{ id: "x", name, arguments: JSON.stringify(args) },
		signal,
	);
	return JSON.parse(content) as Record<string, unknown>;
};
const delegateArgs = {
	mode: "execute",
	toolchain: "web.search",
	request: "明日の天気を調べる",
	impact: "none",
};

describe("createMockToolPort", () => {
	test("offers the Eumenes tool names with JSON Schema parameters", () => {
		const port = createMockToolPort();
		expect(port.tools.map((t) => t.name)).toEqual([
			"find_toolchain",
			"delegate",
			"work",
			"memory",
		]);
		for (const t of port.tools) {
			expect(t.description).not.toBe("");
			expect(t.parameters.type).toBe("object");
		}
		const work = port.tools.find((t) => t.name === "work")?.parameters as {
			properties: { operation: { enum: string[] } };
		};
		expect(work.properties.operation.enum).toEqual([
			"check",
			"answer",
			"amend",
			"cancel",
		]);
		expect(JSON.stringify(port.tools)).not.toContain("archive");
		expect(JSON.stringify(port.tools)).not.toContain("told");
	});

	test("find_toolchain returns fixed candidates", async () => {
		const port = createMockToolPort();
		const a = await use(port, "find_toolchain", { query: "天気" });
		const b = await use(port, "find_toolchain", { query: "音楽" });
		expect(a).toEqual(b);
		expect(
			(a.candidates as { toolchain: string }[]).map((c) => c.toolchain),
		).toContain("web.search");
		expect((await use(port, "find_toolchain", {})).status).toBe("error");
	});

	test("delegate creates a todo and accepts; bad input does not", async () => {
		let clock = 100;
		const port = createMockToolPort({ now: () => clock++ });
		const accepted = await use(port, "delegate", delegateArgs);
		expect(accepted).toEqual({ status: "accepted", todo: "t1", revision: 1 });
		expect(port.todos()).toEqual([
			{
				id: "t1",
				title: "明日の天気を調べる",
				status: "todo",
				requestedAt: 100,
			},
		]);
		for (const bad of [
			{ ...delegateArgs, mode: "run" },
			{ ...delegateArgs, toolchain: "nope" },
			{ ...delegateArgs, request: " " },
		])
			expect((await use(port, "delegate", bad)).status).toBe("error");
		expect(port.todos()).toHaveLength(1);
		const { content } = await port.call(
			{ id: "y", name: "delegate", arguments: "not json" },
			signal,
		);
		expect(content).toContain("invalid_arguments");
	});

	test("complete marks a todo done with its result", async () => {
		let clock = 0;
		const port = createMockToolPort({ now: () => ++clock });
		await use(port, "delegate", delegateArgs);
		const done = port.complete("t1", {
			outcome: "succeeded",
			result: "晴れ、最高気温18度",
			nextActions: ["詳しく聞く"],
		});
		expect(done).toMatchObject({
			id: "t1",
			status: "done",
			outcome: "succeeded",
			result: "晴れ、最高気温18度",
			nextActions: ["詳しく聞く"],
		});
		expect(done.doneAt).toBeGreaterThan(done.requestedAt);
		expect(port.todos()[0]).toEqual(done);
		expect(() =>
			port.complete("t1", { outcome: "failed", result: "x" }),
		).toThrow();
		expect(() =>
			port.complete("zz", { outcome: "failed", result: "x" }),
		).toThrow();
		const check = await use(port, "work", {
			todo: "t1",
			operation: "check",
			revision: 1,
		});
		expect(check).toMatchObject({
			status: "done",
			result: "晴れ、最高気温18度",
		});
	});

	test("ask puts a todo into waiting and answer returns it to work", async () => {
		const port = createMockToolPort();
		await use(port, "delegate", delegateArgs);
		const waiting = port.ask("t1", "どの地域ですか？");
		expect(waiting).toMatchObject({
			status: "waiting",
			question: "どの地域ですか？",
		});
		const check = await use(port, "work", {
			todo: "t1",
			operation: "check",
			revision: 1,
		});
		expect(check).toMatchObject({
			status: "waiting",
			question: "どの地域ですか？",
		});
		const questionId = check.questionId as string;
		expect(
			(
				await use(port, "work", {
					todo: "t1",
					operation: "answer",
					revision: 1,
					questionId: "no",
					text: "東京",
				})
			).status,
		).toBe("error");
		expect(
			await use(port, "work", {
				todo: "t1",
				operation: "answer",
				revision: 1,
				questionId,
				text: "東京",
			}),
		).toEqual({ status: "accepted", revision: 2 });
		const back = port.todos()[0];
		expect(back?.status).toBe("todo");
		expect(back).not.toHaveProperty("question");
	});

	test("work: revision conflict, amend, cancel, unknown todo", async () => {
		const port = createMockToolPort();
		await use(port, "delegate", delegateArgs);
		expect(
			(await use(port, "work", { todo: "t1", operation: "check", revision: 5 }))
				.error,
		).toBe("revision_conflict");
		expect(
			await use(port, "work", {
				todo: "t1",
				operation: "amend",
				revision: 1,
				text: "東京の",
			}),
		).toEqual({ status: "accepted", revision: 2 });
		expect(
			(await use(port, "work", { todo: "t9", operation: "check", revision: 1 }))
				.status,
		).toBe("error");
		expect(
			await use(port, "work", { todo: "t1", operation: "cancel", revision: 2 }),
		).toEqual({ status: "cancelled" });
		expect(port.todos()).toEqual([]);
	});

	test("memory read returns the canned result; request is accepted; archive removes a todo", async () => {
		const port = createMockToolPort({ memory: "猫が好き" });
		expect(
			await use(port, "memory", { operation: "read", query: "好み" }),
		).toEqual({
			result: "猫が好き",
		});
		expect(
			await use(port, "memory", { operation: "request", text: "覚えて" }),
		).toEqual({
			status: "accepted",
		});
		expect((await use(port, "memory", { operation: "drop" })).status).toBe(
			"error",
		);
		expect((await use(port, "nothing", {})).error).toBe("unknown_tool");
		await use(port, "delegate", delegateArgs);
		expect(port.archive("t1")).toBe(true);
		expect(port.archive("t1")).toBe(false);
		expect(port.todos()).toEqual([]);
	});

	test("its todos fit the runtime getter and the call honours the abort", async () => {
		const port = createMockToolPort();
		const controller = new AbortController();
		controller.abort();
		await expect(
			port.call(
				{ id: "x", name: "memory", arguments: "{}" },
				controller.signal,
			),
		).rejects.toBeDefined();
	});
});
