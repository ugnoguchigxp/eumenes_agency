/** Exported login-shell variables are shared across projects; no profile or file is read here. */
const keyNames = {
	anthropic: ["CLAUDE_API_KEY", "ANTHROPIC_API_KEY"],
	openai: ["OPEN_AI_API_KEY", "OPENAI_API_KEY"],
} as const;

export type ApiProvider = keyof typeof keyNames;

/** User-configured names take precedence over the SDK-standard aliases. */
export function apiKeyFromEnvironment(
	provider: ApiProvider,
	env: Readonly<Record<string, string | undefined>> = process.env,
): string | undefined {
	for (const name of keyNames[provider]) {
		const value = env[name]?.trim();
		if (value) return value;
	}
	return undefined;
}
