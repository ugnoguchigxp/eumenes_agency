import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ResponseUsage } from "openai/resources/responses/responses";
import {
	openApiMeter,
	openaiUsage,
	maximumCallUsd,
	usageUsd,
	type ProviderUsage,
} from "../usage.ts";

const raw = {
	input_tokens: 1000,
	output_tokens: 20,
	total_tokens: 1020,
	input_tokens_details: { cached_tokens: 20, cache_write_tokens: 40 },
	output_tokens_details: { reasoning_tokens: 0 },
};
const legacy: ProviderUsage = {
	provider: "openai",
	model: "gpt-6-luna",
	requestId: "legacy-response",
	inputTokens: 1000,
	outputTokens: 20,
	cacheReadTokens: 20,
	cacheWriteTokens: 0,
	reasoningTokens: 0,
};
const location = () =>
	join(mkdtempSync(join(tmpdir(), "agency-usage-correction-")), "usage.jsonl");

test("OpenAI cache writes are normalized and charged conservatively", () => {
	const usage = openaiUsage("gpt-6-luna", raw, "response");
	expect(usage.cacheWriteTokens).toBe(40);
	expect(usage.cacheWriteAccounting).toBe("reported");
	expect(usageUsd(usage)).toBeCloseTo(0.0001142, 12);
});
test("a missing cache-write field is an upper bound, never an assumed zero", () => {
	const { cache_write_tokens: _write, ...oldDetails } =
		raw.input_tokens_details;
	const usage = openaiUsage(
		"gpt-6-luna",
		{ ...raw, input_tokens_details: oldDetails } as ResponseUsage,
		"response",
	);
	expect(usage.cacheWriteTokens).toBe(980);
	expect(usage.cacheWriteAccounting).toBe("upper_bound");
	expect(usageUsd(usage)).toBeCloseTo(0.0002552, 12);
});
test("only explicitly uncached Anthropic requests omit the cache-write multiplier", () => {
	expect(maximumCallUsd("anthropic", "claude-haiku-5-5", 8400)).toBeCloseTo(
		1.2252,
		12,
	);
	expect(
		maximumCallUsd("anthropic", "claude-haiku-5-5", 8400, "disabled"),
	).toBeCloseTo(0.6252, 12);
	expect(() =>
		maximumCallUsd("openai", "gpt-6-luna", 8400, "disabled"),
	).toThrow();
});
test("uncached reservations retain the full context, output and margin and never resize older holds", () => {
	const path = location(),
		meter = openApiMeter(path, 2);
	const old = meter.reserve("anthropic", "claude-haiku-5-5", 8400);
	const current = meter.reserve(
		"anthropic",
		"claude-haiku-5-5",
		8400,
		"disabled",
	);
	expect(openApiMeter(path, 2).summary()).toMatchObject({ uncertain: 2 });
	expect(meter.summary().reservedUsd).toBeCloseTo(1.8504, 12);
	const rows = readFileSync(path, "utf8")
		.trim()
		.split("\n")
		.map((x) => JSON.parse(x));
	expect(rows.find((x) => x.id === old).usd).toBeCloseTo(1.2252, 12);
	expect(rows.find((x) => x.id === current)).toMatchObject({
		usd: 0.6252,
		cacheWrites: "disabled",
	});
	expect(() =>
		meter.reserve("anthropic", "claude-haiku-5-5", 8400, "disabled"),
	).toThrow("spend_limit");
});
test("legacy cache uncertainty is added without rewriting the ledger or releasing reservations", () => {
	const path = location(),
		meter = openApiMeter(path, 9);
	const id = meter.reserve("openai", "gpt-6-luna", 100);
	meter.recordProvider(legacy, id);
	const pending = meter.reserve("anthropic", "claude-haiku-5-5", 100);
	const bytes = readFileSync(path, "utf8");
	const summary = openApiMeter(path, 9).summary();
	expect(summary.legacyCacheWriteUpperUsd).toBeCloseTo(0.000147, 12);
	expect(summary.reservedUsd).toBeCloseTo(
		maximumCallUsd("anthropic", "claude-haiku-5-5", 100) + 0.000147,
		12,
	);
	expect(summary).toMatchObject({
		calls: 2,
		uncertain: 1,
		legacyCacheWriteCalls: 1,
	});
	expect(readFileSync(path, "utf8")).toBe(bytes);
	expect(bytes).toContain(pending);
});
test("the legacy cache-write bound prevents a new call crossing the limit", () => {
	const path = location(),
		meter = openApiMeter(
			path,
			maximumCallUsd("openai", "gpt-6-luna", 100) + 0.00012,
		);
	const id = meter.reserve("openai", "gpt-6-luna", 100);
	meter.recordProvider(legacy, id);
	expect(() => meter.reserve("openai", "gpt-6-luna", 100)).toThrow(
		"spend_limit",
	);
});
test("an explicit bounded budget grant preserves all usage and records its authorization", () => {
	const path = location(),
		meter = openApiMeter(path, 1);
	meter.reserve("openai", "gpt-6-luna", 100);
	const before = readFileSync(path, "utf8");
	meter.raiseLimit(2, {
		maximumUsd: 2,
		reason: "User authorizes up to USD2 including previous spending",
	});
	expect(readFileSync(path, "utf8")).toBe(before);
	expect(meter.summary()).toMatchObject({
		limitUsd: 2,
		calls: 1,
		uncertain: 1,
	});
	expect(() => openApiMeter(path, 1)).toThrow("policy mismatch");
	expect(openApiMeter(path, 2).summary()).toMatchObject({
		calls: 1,
		uncertain: 1,
	});
	const history = JSON.parse(
		readFileSync(path + ".policy-history.jsonl", "utf8").trim(),
	);
	expect(history).toMatchObject({
		fromUsd: 1,
		toUsd: 2,
		authorization: { maximumUsd: 2 },
	});
	expect(history.ledgerSha256).toHaveLength(64);
	expect(() => meter.reserve("openai", "gpt-6-luna", 100)).not.toThrow();
});
test("a changed parameter cannot raise the budget without a bounded explicit grant", () => {
	const path = location(),
		meter = openApiMeter(path, 1);
	const before = readFileSync(path + ".policy.json", "utf8");
	for (const [next, max, reason] of [
		[3, 2, "authorized only2"],
		[2, 2, ""],
		[0.5, 2, "lower"],
		[Infinity, 2, "invalid"],
	] as const)
		expect(() => meter.raiseLimit(next, { maximumUsd: max, reason })).toThrow();
	expect(readFileSync(path + ".policy.json", "utf8")).toBe(before);
	expect(() => openApiMeter(path, 2)).toThrow("policy mismatch");
});
