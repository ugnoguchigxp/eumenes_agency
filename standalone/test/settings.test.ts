import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { createHash } from "node:crypto";
import {
	defaultBudget,
	HOST_RULES_VERSION,
} from "../../src/contracts/index.ts";
import {
	type ExperimentSettings,
	loadSettings,
	openSpendMeter,
	resolveBudget,
	judgeRole,
	settingsDigest,
} from "../settings.ts";
import { SOCIAL_RULES_VERSION } from "../../src/application/prompts.ts";

const dirs: string[] = [];
const tempDir = () => {
	const dir = mkdtempSync(join(tmpdir(), "agency-settings-"));
	dirs.push(dir);
	return dir;
};
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true });
});

const base: ExperimentSettings = {
	llm: {
		background: { model: "m-small", effort: "low", thinkingHeadroom: 100 },
		main: { model: "m-small", effort: "medium", thinkingHeadroom: 200 },
	},
	spend: {
		limitUsd: 1,
		pricing: {
			"m-small": { input: 1, output: 5 },
			"m-big": { input: 4, output: 20 },
		},
	},
};
const usage = (over: Partial<Anthropic.Usage>) =>
	({
		input_tokens: 0,
		output_tokens: 0,
		cache_creation_input_tokens: null,
		cache_read_input_tokens: null,
		...over,
	}) as Anthropic.Usage;

describe("loadSettings", () => {
	test("the tracked config/experiment.json is valid", () => {
		const settings = loadSettings();
		expect(settings.spend.limitUsd).toBe(50);
		expect(resolveBudget(settings)).toEqual(defaultBudget);
	});

	test("rejects unknown keys at every level", () => {
		const dir = tempDir();
		const write = (value: unknown) => {
			const path = join(dir, "s.json");
			writeFileSync(path, JSON.stringify(value));
			return path;
		};
		expect(() => loadSettings(write({ ...base, extra: 1 }))).toThrow();
		expect(() =>
			loadSettings(
				write({
					...base,
					llm: { ...base.llm, main: { ...base.llm.main, temperature: 0 } },
				}),
			),
		).toThrow();
		expect(() =>
			loadSettings(write({ ...base, budget: { nope: 1 } })),
		).toThrow();
		expect(() =>
			loadSettings(write({ ...base, spend: { ...base.spend, limitUsd: 0 } })),
		).toThrow();
		expect(
			loadSettings(write({ ...base, budget: { batchSize: 2 } })).budget,
		).toEqual({ batchSize: 2 });
	});

	test("resolveBudget overlays partial overrides", () => {
		expect(resolveBudget({ ...base, budget: { batchSize: 2 } }).batchSize).toBe(
			2,
		);
		expect(resolveBudget({ ...base, budget: { batchSize: 2 } }).windowMs).toBe(
			defaultBudget.windowMs,
		);
	});
});

const sortedSpend = () => {
	const { pricing, limitUsd } = base.spend;
	return {
		limitUsd,
		pricing: Object.fromEntries(
			Object.entries(pricing).sort(([a], [b]) => (a < b ? -1 : 1)),
		),
	};
};

describe("settingsDigest", () => {
	test("is 16 hex chars, key-order independent and change sensitive", () => {
		const digest = settingsDigest(base);
		expect(digest).toMatch(/^[0-9a-f]{16}$/);
		const reordered: ExperimentSettings = {
			spend: base.spend,
			llm: { main: base.llm.main, background: base.llm.background },
		};
		expect(settingsDigest(reordered)).toBe(digest);
		expect(
			settingsDigest({ ...base, spend: { ...base.spend, limitUsd: 2 } }),
		).not.toBe(digest);
	});

	test("includes the host and social rules versions, so a rule change blocks --resume", () => {
		// key-sorted JSON of the settings plus hostRules, hashed like settingsDigest does.
		const expected = createHash("sha256")
			.update(
				'{"hostRules":' +
					JSON.stringify(HOST_RULES_VERSION) +
					',"llm":{"background":{"effort":"low","model":"m-small","thinkingHeadroom":100},' +
					'"main":{"effort":"medium","model":"m-small","thinkingHeadroom":200}},' +
					`"socialRules":${JSON.stringify(SOCIAL_RULES_VERSION)},` +
					`"spend":${JSON.stringify(sortedSpend())}}`,
			)
			.digest("hex")
			.slice(0, 16);
		expect(settingsDigest(base)).toBe(expected);
		// And it differs from the digest of the same settings without the version.
		const without = createHash("sha256")
			.update(JSON.stringify({ ...base, llm: base.llm }))
			.digest("hex")
			.slice(0, 16);
		expect(settingsDigest(base)).not.toBe(without);
	});
});

describe("judge route", () => {
	test("the tracked config has an Opus judge priced in the spend table", () => {
		const settings = loadSettings();
		const role = judgeRole(settings);
		expect(role.model).toBe("claude-opus-5-5");
		expect(role.effort).toBe("high");
		expect(settings.spend.pricing[role.model]).toEqual({
			input: 4,
			output: 20,
		});
	});
	test("is optional, and left out of the digest so earlier runs stay comparable", () => {
		expect(() => judgeRole(base)).toThrow(/llm\.judge/);
		const withJudge: ExperimentSettings = {
			...base,
			llm: {
				...base.llm,
				judge: { model: "m-big", effort: "high", thinkingHeadroom: 1 },
			},
		};
		expect(settingsDigest(withJudge)).toBe(settingsDigest(base));
	});
});

describe("openSpendMeter", () => {
	test("prices input, output and cache tokens, and persists across reopen", () => {
		const path = join(tempDir(), "nested", "spend.jsonl");
		const meter = openSpendMeter(base, path);
		expect(meter.spentUsd()).toBe(0);
		meter.record(
			"m-small",
			usage({
				input_tokens: 1_000_000,
				output_tokens: 100_000,
				cache_creation_input_tokens: 1_000_000,
				cache_read_input_tokens: 1_000_000,
			}),
		);
		// 1 + 0.5 + 1.25 + 0.1
		expect(meter.spentUsd()).toBeCloseTo(2.85, 9);
		const lines = readFileSync(path, "utf8").trim().split("\n");
		expect(lines).toHaveLength(1);
		const record = JSON.parse(lines[0] ?? "") as Record<string, unknown>;
		expect(Object.keys(record).sort()).toEqual(
			[
				"at",
				"cacheReadTokens",
				"cacheWriteTokens",
				"inputTokens",
				"model",
				"outputTokens",
				"usd",
			].sort(),
		);
		const reopened = openSpendMeter(base, path);
		expect(reopened.spentUsd()).toBeCloseTo(2.85, 9);
		reopened.record("m-small", usage({ output_tokens: 1_000_000 }));
		expect(reopened.spentUsd()).toBeCloseTo(7.85, 9);
		expect(openSpendMeter(base, path).spentUsd()).toBeCloseTo(7.85, 9);
	});

	test("enforces the limit", () => {
		const path = join(tempDir(), "spend.jsonl");
		const meter = openSpendMeter(base, path);
		meter.assertWithinLimit();
		meter.record("m-small", usage({ input_tokens: 999_999 }));
		meter.assertWithinLimit();
		meter.record("m-small", usage({ input_tokens: 1 }));
		expect(() => meter.assertWithinLimit()).toThrow("spend_limit_reached:1");
		expect(() => openSpendMeter(base, path).assertWithinLimit()).toThrow(
			"spend_limit_reached:1",
		);
	});

	test("prices an unknown served model at the highest known rate and warns", () => {
		const warn = spyOn(console, "warn").mockImplementation(() => {});
		try {
			const meter = openSpendMeter(base, join(tempDir(), "spend.jsonl"));
			meter.record(
				"mystery",
				usage({ input_tokens: 1_000_000, output_tokens: 1_000_000 }),
			);
			expect(meter.spentUsd()).toBeCloseTo(24, 9);
			expect(warn).toHaveBeenCalledTimes(1);
		} finally {
			warn.mockRestore();
		}
	});

	test("refuses a corrupt spend log", () => {
		const path = join(tempDir(), "spend.jsonl");
		writeFileSync(path, "{broken\n");
		expect(() => openSpendMeter(base, path)).toThrow();
	});
});
