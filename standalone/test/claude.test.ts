import { describe, expect, test } from "bun:test";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { LlmCallError, LlmOutputError } from "../../src/contracts/index.ts";
import {
	type ClaudeRole,
	createClaudeChat,
	createClaudeLlm,
	llmClient,
	type UsageMeter,
} from "../claude.ts";

const role: ClaudeRole = {
	model: "test-model",
	effort: "low",
	thinkingHeadroom: 2800,
};
const usage = {
	input_tokens: 100,
	output_tokens: 50,
	cache_creation_input_tokens: 10,
	cache_read_input_tokens: 5,
} as Anthropic.Usage;

type Params = Record<string, unknown>;

function fakeClient(response: Partial<Anthropic.Message>) {
	const calls: { params: Params; options: { signal?: AbortSignal } }[] = [];
	const client = {
		messages: {
			async create(params: Params, options: { signal?: AbortSignal }) {
				calls.push({ params, options });
				return {
					model: "served-model",
					usage,
					stop_reason: "end_turn",
					content: [],
					...response,
				};
			},
		},
	} as unknown as Anthropic;
	return { client, calls };
}

function fakeMeter() {
	const recorded: { model: string; usage: Anthropic.Usage }[] = [];
	let checks = 0;
	const meter: UsageMeter = {
		record: (model, u) => void recorded.push({ model, usage: u }),
		assertWithinLimit: () => void checks++,
		spentUsd: () => 0,
	};
	return { meter, recorded, checks: () => checks };
}

const text = (t: string) =>
	[{ type: "text", text: t }] as Anthropic.ContentBlock[];
const schema = z.strictObject({ answer: z.string() });
const request = {
	purpose: "update" as const,
	system: "sys",
	prompt: "prompt",
	schema,
	maxOutputTokens: 1200,
};

describe("createClaudeLlm", () => {
	test("sends the documented request shape", async () => {
		const { client, calls } = fakeClient({
			content: text('{"answer":"ok"}'),
		});
		const { meter, recorded, checks } = fakeMeter();
		const signal = new AbortController().signal;
		const result = await createClaudeLlm(role, meter, client).complete(
			request,
			signal,
		);
		const [call] = calls;
		expect(call?.params.model).toBe("test-model");
		expect(call?.params.max_tokens).toBe(1200 + 2800);
		expect(call?.params.system).toBe("sys");
		expect(call?.params.messages).toEqual([
			{ role: "user", content: "prompt" },
		]);
		const output = call?.params.output_config as {
			effort: string;
			format: { type: string };
		};
		expect(output.effort).toBe("low");
		expect(output.format.type).toBe("json_schema");
		expect(call?.options.signal).toBe(signal);
		for (const key of ["temperature", "top_p", "top_k", "seed"])
			expect(call?.params).not.toHaveProperty(key);
		expect(checks()).toBe(1);
		expect(recorded).toHaveLength(1);
		expect(result.value).toEqual({ answer: "ok" });
		expect(result.model).toBe("served-model");
		expect(result.inputTokens).toBe(110);
		expect(result.outputTokens).toBe(50);
		expect(result.cacheReadTokens).toBe(5);
	});

	test("caps max_tokens at 16000", async () => {
		const { client, calls } = fakeClient({ content: text('{"answer":"ok"}') });
		await createClaudeLlm(role, fakeMeter().meter, client).complete(
			{ ...request, maxOutputTokens: 20000 },
			new AbortController().signal,
		);
		expect(calls[0]?.params.max_tokens).toBe(16000);
	});

	const failures: [string, Partial<Anthropic.Message>, string][] = [
		["refusal", { stop_reason: "refusal", content: [] }, "refusal"],
		[
			"max_tokens",
			{ stop_reason: "max_tokens", content: text('{"answer":') },
			"max_tokens",
		],
		["parse", { content: text("not json") }, "parse"],
		["schema", { content: text('{"answer":1}') }, "schema"],
	];
	for (const [name, response, code] of failures) {
		test(`${name} -> LlmOutputError(${code}) after recording usage`, async () => {
			const { client } = fakeClient(response);
			const { meter, recorded } = fakeMeter();
			const error = await createClaudeLlm(role, meter, client)
				.complete(request, new AbortController().signal)
				.then(
					() => null,
					(e: unknown) => e,
				);
			expect(error).toBeInstanceOf(LlmOutputError);
			expect((error as LlmOutputError).reasonCode).toBe(code);
			expect((error as LlmOutputError).model).toBe("served-model");
			// input includes cache creation (100 + 10); cache reads are not counted
			expect((error as LlmOutputError).usage).toEqual({
				inputTokens: 110,
				outputTokens: 50,
			});
			expect(recorded).toHaveLength(1);
			expect(recorded[0]?.model).toBe("served-model");
		});
	}

	test("meter limit becomes a non-retryable spend_limit LlmCallError before the request", async () => {
		const { client, calls } = fakeClient({ content: text('{"answer":"ok"}') });
		const meter: UsageMeter = {
			record: () => {},
			assertWithinLimit: () => {
				throw new Error("spend_limit_reached:1");
			},
			spentUsd: () => 1,
		};
		const error = await createClaudeLlm(role, meter, client)
			.complete(request, new AbortController().signal)
			.then(
				() => null,
				(e: unknown) => e,
			);
		expect(error).toBeInstanceOf(LlmCallError);
		expect(error).toMatchObject({
			reasonCode: "spend_limit",
			retryable: false,
		});
		expect(calls).toHaveLength(0);
	});

	test("the default client never retries inside the SDK", () => {
		expect(llmClient().maxRetries).toBe(0);
	});
});

function throwingClient(error: unknown) {
	return {
		messages: {
			async create() {
				throw error;
			},
		},
	} as unknown as Anthropic;
}

const failWith = async (
	error: unknown,
	signal = new AbortController().signal,
) =>
	createClaudeLlm(role, fakeMeter().meter, throwingClient(error))
		.complete(request, signal)
		.then(
			() => null,
			(e: unknown) => e,
		);

describe("SDK failure mapping", () => {
	const apiCases: [number, string, boolean][] = [
		[400, "invalid_request_error", false],
		[401, "authentication_error", false],
		[429, "rate_limit_error", true],
		[500, "api_error", true],
		[529, "overloaded_error", true],
	];
	for (const [status, type, retryable] of apiCases) {
		test(`API ${status} -> api_${status}:${type} retryable=${retryable}`, async () => {
			const sdkError = Anthropic.APIError.generate(
				status,
				{ type: "error", error: { type, message: "secret body text" } },
				undefined,
				new Headers(),
			);
			const error = await failWith(sdkError);
			expect(error).toBeInstanceOf(LlmCallError);
			expect(error).toMatchObject({
				reasonCode: `api_${status}:${type}`,
				retryable,
			});
			expect((error as Error).message).not.toContain("secret");
		});
	}

	test("connection and timeout errors -> connection, retryable", async () => {
		for (const sdkError of [
			new Anthropic.APIConnectionError({ message: "boom" }),
			new Anthropic.APIConnectionTimeoutError(),
		]) {
			const error = await failWith(sdkError);
			expect(error).toBeInstanceOf(LlmCallError);
			expect(error).toMatchObject({
				reasonCode: "connection",
				retryable: true,
			});
		}
	});

	test("aborts are rethrown as is", async () => {
		const userAbort = new Anthropic.APIUserAbortError();
		expect(await failWith(userAbort)).toBe(userAbort);
		const domAbort = new DOMException("aborted", "AbortError");
		expect(await failWith(domAbort)).toBe(domAbort);
		const controller = new AbortController();
		controller.abort();
		const connection = new Anthropic.APIConnectionError({});
		expect(await failWith(connection, controller.signal)).toBe(connection);
	});

	test("unknown errors are rethrown as is", async () => {
		const odd = new TypeError("bug");
		expect(await failWith(odd)).toBe(odd);
	});

	test("chat maps SDK failures and the spend limit the same way", async () => {
		const sdkError = Anthropic.APIError.generate(
			429,
			{ type: "error", error: { type: "rate_limit_error", message: "x" } },
			undefined,
			new Headers(),
		);
		const error = await createClaudeChat(
			role,
			fakeMeter().meter,
			throwingClient(sdkError),
		)
			.reply("s", [{ role: "user", text: "x" }], new AbortController().signal)
			.then(
				() => null,
				(e: unknown) => e,
			);
		expect(error).toMatchObject({
			reasonCode: "api_429:rate_limit_error",
			retryable: true,
		});
		const limited = await createClaudeChat(
			role,
			{
				record: () => {},
				assertWithinLimit: () => {
					throw new Error("spend_limit_reached:1");
				},
				spentUsd: () => 1,
			},
			throwingClient(sdkError),
		)
			.reply("s", [{ role: "user", text: "x" }], new AbortController().signal)
			.then(
				() => null,
				(e: unknown) => e,
			);
		expect(limited).toMatchObject({
			reasonCode: "spend_limit",
			retryable: false,
		});
	});
});

describe("createClaudeChat", () => {
	test("joins text blocks and ignores others", async () => {
		const { client, calls } = fakeClient({
			content: [
				{ type: "thinking", thinking: "hmm", signature: "s" },
				{ type: "text", text: "こんにちは" },
				{ type: "text", text: "、世界" },
			] as Anthropic.ContentBlock[],
		});
		const { meter, recorded } = fakeMeter();
		const signal = new AbortController().signal;
		const reply = await createClaudeChat(
			{ ...role, effort: "medium", thinkingHeadroom: 4000 },
			meter,
			client,
		).reply(
			"sys",
			[
				{ role: "user", text: "a" },
				{ role: "assistant", text: "b" },
				{ role: "user", text: "c" },
			],
			signal,
		);
		expect(reply).toEqual({ text: "こんにちは、世界", model: "served-model" });
		const params = calls[0]?.params;
		expect(params?.system).toBe("sys");
		expect(params?.messages).toEqual([
			{ role: "user", content: "a" },
			{ role: "assistant", content: "b" },
			{ role: "user", content: "c" },
		]);
		expect(params?.output_config).toEqual({ effort: "medium" });
		expect(params?.max_tokens).toBe(1200 + 4000);
		expect(params).not.toHaveProperty("temperature");
		expect(calls[0]?.options.signal).toBe(signal);
		expect(recorded).toHaveLength(1);
	});

	test("records usage on refusal and max_tokens, then throws", async () => {
		for (const stop of ["refusal", "max_tokens"] as const) {
			const { client } = fakeClient({ stop_reason: stop });
			const { meter, recorded } = fakeMeter();
			const error = await createClaudeChat(role, meter, client)
				.reply("s", [{ role: "user", text: "x" }], new AbortController().signal)
				.then(
					() => null,
					(e: unknown) => e,
				);
			expect(error).toBeInstanceOf(LlmOutputError);
			expect((error as LlmOutputError).reasonCode).toBe(stop);
			expect(recorded).toHaveLength(1);
		}
	});
});
