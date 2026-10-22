import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import {
	type BudgetConfig,
	defaultBudget,
	HOST_RULES_VERSION,
} from "../src/contracts/index.ts";
import { SOCIAL_RULES_VERSION } from "../src/application/prompts.ts";
import type { UsageMeter } from "./claude.ts";

const root = resolve(import.meta.dir, "..");
export const settingsPath = resolve(root, "config/experiment.json");
export const spendPath = resolve(root, "data/spend.jsonl");

const roleSchema = z.strictObject({
	model: z.string().min(1),
	effort: z.enum(["low", "medium", "high", "xhigh", "max"]),
	thinkingHeadroom: z.int().min(0),
});

/** Per-MTok USD. Cache reads/writes are priced from the input rate. */
const priceSchema = z.strictObject({
	input: z.number().nonnegative(),
	output: z.number().nonnegative(),
});

const budgetSchema = z.strictObject({
	maxCallsPerWindow: z.int().positive(),
	windowMs: z.int().positive(),
	minIntervalMs: z.int().min(0),
	batchSize: z.int().positive(),
	updateMaxOutputTokens: z.int().positive(),
	selectMaxOutputTokens: z.int().positive(),
});

export const experimentSettingsSchema = z.strictObject({
	llm: z.strictObject({
		background: roleSchema,
		main: roleSchema,
		/** P1-E content judge (eval/judge.ts); not part of the settings digest. */
		judge: roleSchema.optional(),
	}),
	spend: z.strictObject({
		limitUsd: z.number().positive(),
		pricing: z.record(z.string(), priceSchema),
	}),
	budget: budgetSchema.partial().optional(),
});
export type ExperimentSettings = z.infer<typeof experimentSettingsSchema>;

export function loadSettings(path = settingsPath): ExperimentSettings {
	return experimentSettingsSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}

/** The judge route, or an error naming the missing setting. */
export function judgeRole(settings: ExperimentSettings) {
	const role = settings.llm.judge;
	if (!role) throw new Error("config/experiment.json: llm.judge is not set");
	return role;
}

/** Budget with the settings overrides applied on top of the defaults. */
export function resolveBudget(settings: ExperimentSettings): BudgetConfig {
	const overrides = Object.fromEntries(
		Object.entries(settings.budget ?? {}).filter(([, v]) => v !== undefined),
	);
	return { ...defaultBudget, ...overrides };
}

const canonical = (value: unknown): unknown =>
	Array.isArray(value)
		? value.map(canonical)
		: value !== null && typeof value === "object"
			? Object.fromEntries(
					Object.entries(value)
						.filter(([, v]) => v !== undefined)
						.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
						.map(([k, v]) => [k, canonical(v)]),
				)
			: value;

/**
 * First 16 hex chars of sha256 over key-sorted JSON; recorded in run metadata.
 * The judge route is left out: it does not affect what a run records, and adding
 * it must not invalidate the digest of earlier runs.
 * HOST_RULES_VERSION is included: a change in host validation/settlement rules changes what a
 * run records, so `--resume` must not mix runs across rule versions. SOCIAL_RULES_VERSION
 * (lull-talk wording, used by B1h) is included for the same reason.
 */
export function settingsDigest(settings: ExperimentSettings): string {
	const { judge: _judge, ...llm } = settings.llm;
	return createHash("sha256")
		.update(
			JSON.stringify(
				canonical({
					...settings,
					llm,
					hostRules: HOST_RULES_VERSION,
					socialRules: SOCIAL_RULES_VERSION,
				}),
			),
		)
		.digest("hex")
		.slice(0, 16);
}

const spendRecordSchema = z.strictObject({
	model: z.string(),
	inputTokens: z.number(),
	outputTokens: z.number(),
	cacheReadTokens: z.number(),
	cacheWriteTokens: z.number(),
	usd: z.number(),
	at: z.number(),
});

/** Append-only JSONL spend log; the running total is kept in memory after the first read. */
export function openSpendMeter(
	settings: ExperimentSettings,
	path = spendPath,
): UsageMeter {
	mkdirSync(dirname(path), { recursive: true });
	let total = 0;
	if (existsSync(path)) {
		for (const line of readFileSync(path, "utf8").split("\n")) {
			if (line.trim() === "") continue;
			total += spendRecordSchema.parse(JSON.parse(line)).usd;
		}
	}
	const { pricing, limitUsd } = settings.spend;
	const prices = Object.values(pricing);
	return {
		spentUsd: () => total,
		assertWithinLimit() {
			if (total >= limitUsd) throw new Error(`spend_limit_reached:${limitUsd}`);
		},
		record(model: string, usage: Anthropic.Usage) {
			// An unknown served model (e.g. a fallback) is charged at the highest known rate,
			// so the spend limit stays conservative; the call was billed either way.
			const price = pricing[model] ?? {
				input: Math.max(0, ...prices.map((p) => p.input)),
				output: Math.max(0, ...prices.map((p) => p.output)),
			};
			if (!pricing[model]) console.warn(`[warn] spend_price_missing ${model}`);
			const read = usage.cache_read_input_tokens ?? 0;
			const write = usage.cache_creation_input_tokens ?? 0;
			const usd =
				(usage.input_tokens * price.input +
					write * price.input * 1.25 +
					read * price.input * 0.1 +
					usage.output_tokens * price.output) /
				1_000_000;
			const record = {
				model,
				inputTokens: usage.input_tokens,
				outputTokens: usage.output_tokens,
				cacheReadTokens: read,
				cacheWriteTokens: write,
				usd,
				at: Date.now(),
			};
			appendFileSync(path, `${JSON.stringify(record)}\n`);
			total += usd;
		},
	};
}
