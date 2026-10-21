import type { z } from "zod";

export type LlmPurpose = "update" | "select" | "respond";

export interface LlmRequest<T> {
	readonly purpose: LlmPurpose;
	readonly system: string;
	readonly prompt: string;
	readonly schema: z.ZodType<T>;
	readonly maxOutputTokens: number;
}

export interface LlmResult<T> {
	readonly value: T;
	readonly model: string;
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly cacheReadTokens: number;
	readonly latencyMs: number;
}

/** One stateless structured call. Each call is a fresh context. */
export interface LlmPort {
	complete<T>(
		request: LlmRequest<T>,
		signal: AbortSignal,
	): Promise<LlmResult<T>>;
}

/** Free-text reply for the main conversation (CLI only). */
export interface ChatPort {
	reply(
		system: string,
		turns: readonly { role: "user" | "assistant"; text: string }[],
		signal: AbortSignal,
	): Promise<{ text: string; model: string }>;
}
