import { expect, test } from "bun:test";
import { apiKeyFromEnvironment } from "../api-keys.ts";
import { createClaudeClient } from "../claude.ts";

test.each([
	["anthropic", "CLAUDE_API_KEY", "ANTHROPIC_API_KEY"],
	["openai", "OPEN_AI_API_KEY", "OPENAI_API_KEY"],
] as const)(
	"%s accepts shared shell variables and SDK aliases",
	(provider, custom, standard) => {
		expect(
			apiKeyFromEnvironment(provider, { [custom]: "shared-fixture" }),
		).toBe("shared-fixture");
		expect(
			apiKeyFromEnvironment(provider, { [standard]: "standard-fixture" }),
		).toBe("standard-fixture");
		expect(
			apiKeyFromEnvironment(provider, {
				[custom]: " shared-fixture ",
				[standard]: "standard-fixture",
			}),
		).toBe("shared-fixture");
		expect(
			apiKeyFromEnvironment(provider, {
				[custom]: "  ",
				[standard]: "fallback-fixture",
			}),
		).toBe("fallback-fixture");
		expect(apiKeyFromEnvironment(provider, {})).toBeUndefined();
	},
);

test("the shared Claude client applies the key without losing transport options", () => {
	const client = createClaudeClient(
		{ maxRetries: 0, timeout: 1234 },
		{ CLAUDE_API_KEY: "shared-fixture" },
	);
	expect(client.apiKey).toBe("shared-fixture");
	expect(client.maxRetries).toBe(0);
	expect(client.timeout).toBe(1234);
});

test("an explicit SDK key overrides shared environment keys", () => {
	const client = createClaudeClient(
		{ apiKey: "explicit-fixture" },
		{ CLAUDE_API_KEY: "shared-fixture", ANTHROPIC_API_KEY: "standard-fixture" },
	);
	expect(client.apiKey).toBe("explicit-fixture");
});
