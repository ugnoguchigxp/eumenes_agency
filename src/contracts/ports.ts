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

// ------------------------------------------------------------------ normal reply

/** One tool call the model asked for, as the host runs it (arguments: a JSON string). */
export interface ReplyToolCall {
	readonly id: string;
	readonly name: string;
	readonly arguments: string;
}

/** A message of the reply conversation (OpenAI chat shape). */
export interface ReplyMessage {
	readonly role: "system" | "user" | "assistant" | "tool";
	readonly content: string;
	/** assistant: the tool calls made in this turn. */
	readonly tool_calls?: readonly {
		readonly id: string;
		readonly type: "function";
		readonly function: { readonly name: string; readonly arguments: string };
	}[];
	/** tool: the id of the call this message answers. */
	readonly tool_call_id?: string;
}

/** A tool the host offers to the reply; `parameters` is a JSON Schema object. */
export interface ToolDefinition {
	readonly name: string;
	readonly description: string;
	readonly parameters: Record<string, unknown>;
}

/**
 * One streaming chat call of the normal reply. The host chooses the provider; the package
 * never does. `onDelta` receives the text as it is produced (it may be called zero times
 * when the port does not stream: the returned `text` is then used).
 */
export interface ReplyPort {
	complete(
		request: {
			readonly messages: readonly ReplyMessage[];
			readonly tools: readonly ToolDefinition[];
		},
		onDelta: (text: string) => void,
		signal: AbortSignal,
	): Promise<{ text: string; toolCalls: ReplyToolCall[] }>;
}

/** The host's tools for the reply: definitions plus execution. */
export interface ToolPort {
	readonly tools: readonly ToolDefinition[];
	/** `end: true` ends the reply after this call (no further chat call). */
	call(
		call: ReplyToolCall,
		signal: AbortSignal,
	): Promise<{ content: string; end?: boolean }>;
}
