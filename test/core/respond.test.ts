import { describe, expect, test } from "bun:test";
import { runRespond } from "../../src/application/respond.ts";
import type {
	ReplyMessage,
	ReplyPort,
	ReplyToolCall,
	ToolDefinition,
	ToolPort,
} from "../../src/contracts/ports.ts";

interface Step {
	/** Streamed pieces; the returned text is their join. */
	readonly deltas: readonly string[];
	readonly toolCalls?: readonly ReplyToolCall[];
	/** Return the text without streaming it. */
	readonly silent?: boolean;
}

const fakeChat = (steps: readonly Step[]) => {
	const requests: {
		messages: readonly ReplyMessage[];
		tools: readonly ToolDefinition[];
	}[] = [];
	const chat: ReplyPort = {
		async complete(request, onDelta) {
			requests.push({
				messages: [...request.messages],
				tools: [...request.tools],
			});
			const step = steps[requests.length - 1];
			if (!step) throw new Error("no scripted chat step");
			if (!step.silent) for (const d of step.deltas) onDelta(d);
			return {
				text: step.deltas.join(""),
				toolCalls: [...(step.toolCalls ?? [])],
			};
		},
	};
	return { chat, requests };
};

const toolDef: ToolDefinition = {
	name: "find_toolchain",
	description: "d",
	parameters: { type: "object" },
};
const call = (
	id: string,
	name = "find_toolchain",
	args = "{}",
): ReplyToolCall => ({
	id,
	name,
	arguments: args,
});

const fakeTools = (
	results: Record<string, { content: string; end?: boolean }>,
) => {
	const executed: ReplyToolCall[] = [];
	const port: ToolPort = {
		tools: [toolDef],
		async call(c) {
			executed.push(c);
			return results[c.id] ?? { content: `result:${c.id}` };
		},
	};
	return { port, executed };
};

const base = (
	o: Partial<Parameters<typeof runRespond>[0]> &
		Pick<Parameters<typeof runRespond>[0], "chat">,
) => {
	const deltas: string[] = [];
	const tools = o.tools ?? fakeTools({}).port;
	return {
		deltas,
		input: {
			messages: [
				{ role: "system" as const, content: "sys" },
				{ role: "user" as const, content: "こんにちは" },
			],
			tools,
			emotion: false,
			signal: new AbortController().signal,
			onDelta: (t: string) => void deltas.push(t),
			...o,
		},
	};
};

describe("runRespond", () => {
	test("a plain reply streams its deltas and ends without tool calls", async () => {
		const { chat, requests } = fakeChat([{ deltas: ["やあ、", "元気？"] }]);
		const { input, deltas } = base({ chat });
		const result = await runRespond(input);
		expect(result).toEqual({ text: "やあ、元気？", ended: false, calls: [] });
		expect(deltas).toEqual(["やあ、", "元気？"]);
		expect(requests).toHaveLength(1);
		expect(requests[0]?.tools).toEqual([toolDef]);
		expect(requests[0]?.messages).toEqual(input.messages);
	});

	test("a port that does not stream still delivers the text", async () => {
		const { chat } = fakeChat([{ deltas: ["そのまま"], silent: true }]);
		const { input, deltas } = base({ chat });
		const result = await runRespond(input);
		expect(result.text).toBe("そのまま");
		expect(deltas).toEqual(["そのまま"]);
	});

	test("a tool call runs, its result goes back as a tool message and the chat continues", async () => {
		const { chat, requests } = fakeChat([
			{
				deltas: ["調べるね。"],
				toolCalls: [call("c1", "find_toolchain", '{"query":"天気"}')],
			},
			{ deltas: ["見つかったよ。"] },
		]);
		const tools = fakeTools({ c1: { content: '{"candidates":[]}' } });
		const { input, deltas } = base({ chat, tools: tools.port });
		const result = await runRespond(input);
		expect(result.text).toBe("調べるね。見つかったよ。");
		expect(deltas).toEqual(["調べるね。", "見つかったよ。"]);
		expect(result.ended).toBe(false);
		expect(result.calls).toEqual([
			{
				name: "find_toolchain",
				arguments: '{"query":"天気"}',
				content: '{"candidates":[]}',
			},
		]);
		expect(tools.executed).toHaveLength(1);
		expect(requests[1]?.messages.slice(2)).toEqual([
			{
				role: "assistant",
				content: "調べるね。",
				tool_calls: [
					{
						id: "c1",
						type: "function",
						function: { name: "find_toolchain", arguments: '{"query":"天気"}' },
					},
				],
			},
			{ role: "tool", content: '{"candidates":[]}', tool_call_id: "c1" },
		]);
	});

	test("several calls in one output run in order, one tool message each", async () => {
		const { chat, requests } = fakeChat([
			{ deltas: [], toolCalls: [call("a"), call("b")] },
			{ deltas: ["済み"] },
		]);
		const tools = fakeTools({});
		const { input } = base({ chat, tools: tools.port });
		const result = await runRespond(input);
		expect(tools.executed.map((c) => c.id)).toEqual(["a", "b"]);
		expect(requests[1]?.messages.slice(-2)).toEqual([
			{ role: "tool", content: "result:a", tool_call_id: "a" },
			{ role: "tool", content: "result:b", tool_call_id: "b" },
		]);
		expect(result.text).toBe("済み");
	});

	test("a result with end: true ends the reply without another chat call", async () => {
		const { chat, requests } = fakeChat([
			{ deltas: ["切り替えるよ。"], toolCalls: [call("a"), call("b")] },
			{ deltas: ["呼ばれない"] },
		]);
		const tools = fakeTools({ a: { content: "handed over", end: true } });
		const { input } = base({ chat, tools: tools.port });
		const result = await runRespond(input);
		expect(result.ended).toBe(true);
		expect(result.text).toBe("切り替えるよ。");
		expect(requests).toHaveLength(1);
		expect(tools.executed.map((c) => c.id)).toEqual(["a"]);
		expect(result.calls).toHaveLength(1);
	});

	test("after maxToolCalls the next chat call gets no tools; surplus calls are answered as not run", async () => {
		const { chat, requests } = fakeChat([
			{ deltas: [], toolCalls: [call("a"), call("b"), call("c")] },
			{ deltas: ["ここまで"], toolCalls: [call("d")] },
		]);
		const tools = fakeTools({});
		const { input } = base({ chat, tools: tools.port, maxToolCalls: 2 });
		const result = await runRespond(input);
		expect(tools.executed.map((c) => c.id)).toEqual(["a", "b"]);
		expect(requests[0]?.tools).toHaveLength(1);
		expect(requests[1]?.tools).toEqual([]);
		const notRun = requests[1]?.messages.at(-1);
		expect(notRun).toMatchObject({ role: "tool", tool_call_id: "c" });
		// a tool call the model still makes without tools is ignored: the reply ends
		expect(requests).toHaveLength(2);
		expect(result.text).toBe("ここまで");
		expect(result.calls.map((c) => c.name)).toHaveLength(2);
	});

	test("the default limit is four calls", async () => {
		const steps: Step[] = [
			...[1, 2, 3, 4].map((n) => ({ deltas: [], toolCalls: [call(`c${n}`)] })),
			{ deltas: ["終わり"] },
		];
		const { chat, requests } = fakeChat(steps);
		const { input } = base({ chat });
		await runRespond(input);
		expect(requests.map((r) => r.tools.length)).toEqual([1, 1, 1, 1, 0]);
	});

	test("rejects a bad limit", async () => {
		const { chat } = fakeChat([{ deltas: ["x"] }]);
		const { input } = base({ chat, maxToolCalls: -1 });
		await expect(runRespond(input)).rejects.toThrow("maxToolCalls");
	});

	describe("emotion", () => {
		const run = async (pieces: string[], emotion = true) => {
			const { chat } = fakeChat([{ deltas: pieces }]);
			const { input, deltas } = base({ chat, emotion });
			const result = await runRespond(input);
			return { result, deltas };
		};

		test("the leading emoji is removed from the stream and returned", async () => {
			const { result, deltas } = await run(["😊", "いいね！", "続きも"]);
			expect(result.emotion).toBe("😊");
			expect(result.text).toBe("いいね！続きも");
			expect(deltas.join("")).toBe("いいね！続きも");
		});

		test("split deltas: whitespace first, the emoji alone, a split surrogate pair", async () => {
			const first = await run([" ", "\n", "🤔", " ", "うーん"]);
			expect(first.result.emotion).toBe("🤔");
			expect(first.deltas.join("")).toBe("うーん");
			const emoji = "🙏";
			const split = await run([emoji.slice(0, 1), emoji.slice(1), "ごめん"]);
			expect(split.result.emotion).toBe("🙏");
			expect(split.deltas.join("")).toBe("ごめん");
		});

		test("text is held back only until the first non-space character decides", async () => {
			const { chat } = fakeChat([{ deltas: ["  ", "こ", "んにちは"] }]);
			const seen: string[] = [];
			const { input } = base({ chat, onDelta: (t) => void seen.push(t) });
			await runRespond({ ...input, emotion: true });
			expect(seen).toEqual(["  こ", "んにちは"]);
		});

		test("no emoji: the text is untouched and there is no emotion", async () => {
			const { result, deltas } = await run(["こんにちは"]);
			expect(result.emotion).toBeUndefined();
			expect(deltas).toEqual(["こんにちは"]);
		});

		test("an emoji outside the 15 is removed but gives no emotion; a later emoji stays text", async () => {
			const { result, deltas } = await run(["🚀", "出発 😊"]);
			expect(result.emotion).toBeUndefined();
			expect(deltas.join("")).toBe("出発 😊");
		});

		test("emotion off: nothing is stripped", async () => {
			const { result, deltas } = await run(["😊うれしい"], false);
			expect(result.emotion).toBeUndefined();
			expect(deltas.join("")).toBe("😊うれしい");
		});

		test("works in a non-streamed reply and across a tool call", async () => {
			const { chat } = fakeChat([
				{ deltas: ["🤔調べるね。"], toolCalls: [call("a")], silent: true },
				{ deltas: ["😊", "あったよ"] },
			]);
			const { input, deltas } = base({ chat });
			const result = await runRespond({ ...input, emotion: true });
			expect(result.emotion).toBe("🤔");
			expect(result.text).toBe("調べるね。あったよ");
			expect(deltas.join("")).toBe("調べるね。あったよ");
		});
	});

	describe("abort", () => {
		test("an already aborted signal makes no call", async () => {
			const { chat, requests } = fakeChat([{ deltas: ["x"] }]);
			const controller = new AbortController();
			controller.abort();
			const { input } = base({ chat, signal: controller.signal });
			await expect(runRespond(input)).rejects.toThrow();
			expect(requests).toHaveLength(0);
		});

		test("aborting during a chat call rejects at once, even if the port ignores the signal", async () => {
			const controller = new AbortController();
			const chat: ReplyPort = {
				complete: () => new Promise(() => undefined),
			};
			const { input } = base({ chat, signal: controller.signal });
			const pending = runRespond(input);
			controller.abort();
			await expect(pending).rejects.toBeDefined();
		});

		test("aborting during a tool call stops before the next chat call", async () => {
			const controller = new AbortController();
			const { chat, requests } = fakeChat([
				{ deltas: [], toolCalls: [call("a"), call("b")] },
				{ deltas: ["x"] },
			]);
			const executed: string[] = [];
			const tools: ToolPort = {
				tools: [toolDef],
				async call(c) {
					executed.push(c.id);
					controller.abort();
					return { content: "r" };
				},
			};
			const { input } = base({ chat, tools, signal: controller.signal });
			await expect(runRespond(input)).rejects.toBeDefined();
			expect(executed).toEqual(["a"]);
			expect(requests).toHaveLength(1);
		});

		test("deltas after the abort are not forwarded", async () => {
			const controller = new AbortController();
			const seen: string[] = [];
			const chat: ReplyPort = {
				async complete(_r, onDelta) {
					onDelta("a");
					controller.abort();
					onDelta("b");
					return { text: "ab", toolCalls: [] };
				},
			};
			const { input } = base({
				chat,
				signal: controller.signal,
				onDelta: (t) => void seen.push(t),
			});
			await expect(runRespond(input)).rejects.toBeDefined();
			expect(seen).toEqual(["a"]);
		});
	});
});
