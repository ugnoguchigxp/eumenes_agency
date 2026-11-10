/**
 * The model that measures the agenda agent: the judge, the simulated user and the replay's judge.
 * Another vendor's model than the one under test (user, 2026-11-10: "検証に使うAPI…openai api
 * lunaを使いましょう"), so the agent is not graded and answered by its own kind. The role is
 * `llm.judge` in the settings; the agent itself keeps `background` and `main`.
 */
import OpenAI from "openai";
import type { LlmPort } from "../../src/index.ts";
import { apiKeyFromEnvironment } from "../../standalone/api-keys.ts";
import { createClaudeClient } from "../../standalone/claude.ts";
import { createProviderLlm } from "../../standalone/providers.ts";
import {
	judgeRole,
	type ExperimentSettings,
} from "../../standalone/settings.ts";
import type { UsageMeter } from "../../standalone/claude.ts";

export function verifierLlm(
	settings: ExperimentSettings,
	meter: UsageMeter,
): { llm: LlmPort; model: string } {
	const role = judgeRole(settings);
	// Many scenarios at once meet the rate limit: wait and try again rather than fail one.
	const client =
		role.provider === "openai"
			? new OpenAI({
					apiKey: apiKeyFromEnvironment("openai"),
					maxRetries: 8,
					timeout: 120_000,
				})
			: undefined;
	return { llm: createProviderLlm(role, meter, client), model: role.model };
}

/**
 * A client for the role's provider, waiting and trying again at the rate limit (many scenarios
 * run at once). The agent runs on the settings' `background` and `main`: Claude Haiku in the CLI,
 * OpenAI's model in `config/agenda-luna.json` (the Claude API's limit was reached 2026-11-11).
 */
export const clientFor = (role: { readonly provider?: string | undefined }) =>
	role.provider === "openai"
		? new OpenAI({
				apiKey: apiKeyFromEnvironment("openai"),
				maxRetries: 8,
				timeout: 120_000,
			})
		: createClaudeClient({ maxRetries: 8, timeout: 120_000 });
