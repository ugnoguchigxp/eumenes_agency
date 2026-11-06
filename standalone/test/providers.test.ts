import { expect, test } from "bun:test";
import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { mkdtempSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProviderLlm, createProviderReply } from "../providers.ts";
import {
	openApiMeter,
	usageUsd,
	maximumCallUsd,
	type ProviderUsage,
} from "../usage.ts";
import { LlmCallError, LlmOutputError, runRespond } from "../../src/index.ts";

const role = {
	provider: "openai" as const,
	model: "gpt-6-luna",
	effort: "low" as const,
	thinkingHeadroom: 100,
};
const usage = {
	input_tokens: 100,
	output_tokens: 20,
	total_tokens: 120,
	input_tokens_details: { cached_tokens: 10, cache_write_tokens: 0 },
	output_tokens_details: { reasoning_tokens: 5 },
};
const meter = (limit = 10) =>
	openApiMeter(
		join(mkdtempSync(join(tmpdir(), "agency-api-meter-")), "usage.jsonl"),
		limit,
	);
const signal = () => new AbortController().signal;

function fixture(responses: Record<string, unknown>[]) {
	const requests: Record<string, unknown>[] = [];
	const client = new OpenAI({
		apiKey: "fixture-key",
		maxRetries: 0,
		fetch: async (_url, init) => {
			requests.push(
				JSON.parse(init!.body as string) as Record<string, unknown>,
			);
			const response = responses.shift();
			if (!response) throw new Error("fixture exhausted");
			return new Response(
				JSON.stringify({
					id: "response-" + requests.length,
					model: role.model,
					status: "completed",
					usage,
					output: [],
					...response,
				}),
				{ headers: { "content-type": "application/json" } },
			);
		},
	});
	return { client, requests };
}
const message = (text: string) => ({
	type: "message",
	id: "m1",
	role: "assistant",
	status: "completed",
	content: [{ type: "output_text", text, annotations: [] }],
});

test("the stateless Anthropic SDK request is uncached and reserves its full uncached envelope", async () => {
	const m = meter(0.7),
		requests: Record<string, unknown>[] = [];
	const client = new Anthropic({
		apiKey: "fixture-key",
		maxRetries: 0,
		fetch: async (_url, init) => {
			requests.push(JSON.parse(init!.body as string));
			return new Response(
				JSON.stringify({
					id: "msg-uncached",
					type: "message",
					role: "assistant",
					model: "claude-haiku-5-5",
					stop_reason: "end_turn",
					content: [{ type: "text", text: '{"answer":"ok"}' }],
					usage: {
						input_tokens: 100,
						output_tokens: 20,
						cache_creation_input_tokens: 0,
						cache_read_input_tokens: 0,
					},
				}),
				{ headers: { "content-type": "application/json" } },
			);
		},
	});
	const result = await createProviderLlm(
		{ ...role, provider: "anthropic", model: "claude-haiku-5-5" },
		m,
		client,
	).complete(
		{
			purpose: "select",
			system: "host",
			prompt: "data",
			schema: z.strictObject({ answer: z.string() }),
			maxOutputTokens: 100,
		},
		signal(),
	);
	expect(result.value).toEqual({ answer: "ok" });
	expect(requests).toHaveLength(1);
	expect(requests[0]).toMatchObject({
		model: "claude-haiku-5-5",
		max_tokens: 200,
		system: "host",
		messages: [{ role: "user", content: "data" }],
	});
	expect(JSON.stringify(requests[0])).not.toContain('"cache_control"');
	expect(m.summary()).toMatchObject({ calls: 1, uncertain: 0 });
	expect(m.spentUsd()).toBeCloseTo(0.00002, 12);
});

test("Responses transports host instructions separately, validates JSON, accounts cached/reasoning once", async () => {
	const m = meter();
	const f = fixture([{ output: [message('{"answer":"ok"}')] }]);
	const llm = createProviderLlm(role, m, f.client);
	const r = await llm.complete(
		{
			purpose: "update",
			system: " host instructions \n",
			prompt: "data",
			schema: z.strictObject({ answer: z.string() }),
			maxOutputTokens: 100,
		},
		signal(),
	);
	expect(r.value).toEqual({ answer: "ok" });
	expect(r.inputTokens).toBe(100);
	expect(r.outputTokens).toBe(20);
	expect(f.requests[0]).toMatchObject({
		instructions: " host instructions \n",
		input: "data",
		store: false,
		service_tier: "default",
		reasoning: { effort: "low" },
		max_output_tokens: 200,
	});
	expect(m.summary()).toMatchObject({ calls: 1, uncertain: 0 });
	expect(m.spentUsd()).toBeCloseTo((90 * 0.1 + 10 * 0.01 + 20 * 0.5) / 1e6, 12);
});

test.each([
	[
		{
			status: "incomplete",
			incomplete_details: { reason: "max_output_tokens" },
		},
		"max_tokens",
	],
	[
		{
			output: [
				{ type: "message", content: [{ type: "refusal", refusal: "no" }] },
			],
		},
		"refusal",
	],
	[{ output: [message("not JSON")] }, "parse"],
	[{ output: [message('{"wrong":true}')] }, "schema"],
] as const)(
	"bad responses are charged and rejected: %s",
	async (response, code) => {
		const m = meter();
		const f = fixture([response]);
		try {
			await createProviderLlm(role, m, f.client).complete(
				{
					purpose: "select",
					system: "host",
					prompt: "data",
					schema: z.strictObject({ answer: z.string() }),
					maxOutputTokens: 100,
				},
				signal(),
			);
			throw new Error("expected rejection");
		} catch (e) {
			expect(e).toBeInstanceOf(LlmOutputError);
			expect((e as LlmOutputError).reasonCode).toBe(code);
		}
		expect(m.spentUsd()).toBeGreaterThan(0);
		expect(m.summary().calls).toBe(1);
	},
);

test("reply tool calls retain opaque continuation and use call_id for tool results", async () => {
	const m = meter();
	const f = fixture([
		{
			output: [
				{
					type: "reasoning",
					id: "r1",
					summary: [],
					encrypted_content: "opaque",
				},
				{
					type: "function_call",
					id: "fc1",
					call_id: "call1",
					name: "lookup",
					arguments: "{}",
				},
			],
		},
		{ output: [message("結果です")] },
	]);
	const reply = await runRespond({
		chat: createProviderReply(role, m, f.client),
		emotion: false,
		signal: signal(),
		onDelta() {},
		messages: [
			{ role: "system", content: "host" },
			{ role: "user", content: "質問" },
		],
		tools: {
			tools: [
				{
					name: "lookup",
					description: "read",
					parameters: {
						type: "object",
						properties: {},
						additionalProperties: false,
					},
				},
			],
			async call() {
				return { content: "fixture result" };
			},
		},
	});
	expect(reply.text).toBe("結果です");
	expect(f.requests[1]?.input).toContainEqual({
		type: "function_call_output",
		call_id: "call1",
		output: "fixture result",
	});
	expect(f.requests[1]?.input).toContainEqual({
		type: "reasoning",
		id: "r1",
		summary: [],
		encrypted_content: "opaque",
	});
	expect(m.summary()).toMatchObject({ calls: 2, uncertain: 0 });
});

test("independent meter instances reserve against one durable budget, unknown outcomes stay reserved", () => {
	const path = join(
		mkdtempSync(join(tmpdir(), "agency-api-shared-")),
		"usage.jsonl",
	);
	const a = openApiMeter(path, 1);
	const b = openApiMeter(path, 1);
	a.reserve("openai", "gpt-6-luna", 100);
	expect(() => b.reserve("openai", "gpt-6-luna", 100)).toThrow(LlmCallError);
	expect(b.summary()).toMatchObject({ calls: 1, uncertain: 1 });
	expect(() => openApiMeter(path, 2)).toThrow("policy mismatch");
});

test("shared totals and per-process evaluation cost stay distinct", () => {
	const path = join(
		mkdtempSync(join(tmpdir(), "agency-api-local-")),
		"usage.jsonl",
	);
	const a = openApiMeter(path, 9),
		b = openApiMeter(path, 9);
	const id = a.reserve("openai", role.model, 100);
	a.recordProvider(
		{
			provider: "openai",
			model: role.model,
			requestId: "r",
			inputTokens: 100,
			outputTokens: 20,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			cacheWriteAccounting: "reported",
			reasoningTokens: 0,
		},
		id,
	);
	expect(a.localSpentUsd()).toBeCloseTo(0.00002, 10);
	expect(b.localSpentUsd()).toBe(0);
	expect(b.spentUsd()).toBe(a.spentUsd());
});

test("Anthropic failures include cached tokens and settle billed usage exactly once", async () => {
	const m = meter();
	const client = new Anthropic({
		apiKey: "fixture-key",
		maxRetries: 0,
		fetch: async () =>
			new Response(
				JSON.stringify({
					id: "msg-fixture",
					type: "message",
					role: "assistant",
					model: "claude-haiku-5-5",
					stop_reason: "max_tokens",
					content: [],
					usage: {
						input_tokens: 100,
						output_tokens: 20,
						cache_creation_input_tokens: 10,
						cache_read_input_tokens: 5,
					},
				}),
				{ headers: { "content-type": "application/json" } },
			),
	});
	let caught: unknown;
	try {
		await createProviderLlm(
			{ ...role, provider: "anthropic", model: "claude-haiku-5-5" },
			m,
			client,
		).complete(
			{
				purpose: "update",
				system: "host",
				prompt: "data",
				schema: z.strictObject({ answer: z.string() }),
				maxOutputTokens: 100,
			},
			signal(),
		);
	} catch (e) {
		caught = e;
	}
	expect(caught).toBeInstanceOf(LlmOutputError);
	expect((caught as LlmOutputError).usage).toEqual({
		inputTokens: 115,
		outputTokens: 20,
	});
	expect(m.summary()).toMatchObject({ calls: 1, uncertain: 0 });
	expect(m.spentUsd()).toBeGreaterThan(0);
});

test("pre-aborted API work neither calls HTTP nor reserves dollars", async () => {
	const m = meter();
	const f = fixture([]);
	const ac = new AbortController();
	ac.abort();
	await expect(
		createProviderLlm(role, m, f.client).complete(
			{
				purpose: "update",
				system: "host",
				prompt: "data",
				schema: z.strictObject({ answer: z.string() }),
				maxOutputTokens: 100,
			},
			ac.signal,
		),
	).rejects.toBeDefined();
	expect(f.requests).toHaveLength(0);
	expect(m.summary()).toMatchObject({ calls: 0, reservedUsd: 0 });
});

test("settlements cannot be duplicated and unknown models never become free", () => {
	const m = meter();
	const id = m.reserve("openai", role.model, 100);
	const u: ProviderUsage = {
		provider: "openai",
		model: role.model,
		requestId: "id",
		inputTokens: 100,
		outputTokens: 20,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		cacheWriteAccounting: "reported",
		reasoningTokens: 5,
	};
	m.recordProvider(u, id);
	expect(() => m.recordProvider(u, id)).toThrow("already settled");
	expect(() => usageUsd({ ...u, model: "unknown" })).toThrow(
		"spend_price_missing",
	);
	expect(maximumCallUsd("openai", role.model, 128000)).toBeGreaterThan(
		usageUsd({ ...u, inputTokens: 900000, outputTokens: 128000 }),
	);
});

test("concurrent processes settle one shared budget without duplicate or lost usage", async () => {
	const path = join(
		mkdtempSync(join(tmpdir(), "agency-api-concurrent-")),
		"usage.jsonl",
	);
	const source = new URL("../usage.ts", import.meta.url).pathname;
	const code = `import {openApiMeter} from ${JSON.stringify(source)};
const m=openApiMeter(process.argv[1],9);
for(let i=0;i<20;i++){const id=m.reserve("openai","gpt-6-luna",100);m.recordProvider({provider:"openai",model:"gpt-6-luna",requestId:crypto.randomUUID(),inputTokens:100,outputTokens:20,cacheReadTokens:0,cacheWriteTokens:0,cacheWriteAccounting:"reported",reasoningTokens:0},id);}`;
	const results = await Promise.all(
		Array.from({ length: 4 }, async () => {
			const p = Bun.spawn(
				[process.execPath, "--no-env-file", "--eval", code, path],
				{ stdout: "pipe", stderr: "pipe" },
			);
			const [exit, err] = await Promise.all([
				p.exited,
				new Response(p.stderr).text(),
			]);
			return { exit, err };
		}),
	);
	for (const r of results) {
		expect(r.err).toBe("");
		expect(r.exit).toBe(0);
	}
	const m = openApiMeter(path, 9);
	expect(m.summary()).toMatchObject({
		calls: 80,
		uncertain: 0,
		reservedUsd: 0,
	});
	expect(m.spentUsd()).toBeCloseTo(80 * 0.00002, 10);
}, 10_000);

test("edited or repeated ledger entries fail closed before another reservation", () => {
	const path = join(
		mkdtempSync(join(tmpdir(), "agency-api-corrupt-")),
		"usage.jsonl",
	);
	const m = openApiMeter(path, 9);
	const id = m.reserve("openai", "gpt-6-luna", 100);
	const row = {
		kind: "usage",
		id,
		usd: 0,
		usage: {
			provider: "openai",
			model: "gpt-6-luna",
			requestId: "r",
			inputTokens: 100,
			outputTokens: 20,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			cacheWriteAccounting: "reported",
			reasoningTokens: 0,
		},
		at: 0,
	};
	appendFileSync(path, JSON.stringify(row) + "\n");
	expect(() => m.reserve("openai", "gpt-6-luna", 100)).toThrow(
		"corrupt API ledger",
	);
});
