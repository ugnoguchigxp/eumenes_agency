/** The model returned nothing usable (refusal, cut off, malformed, schema mismatch). */
export class LlmOutputError extends Error {
	constructor(
		readonly reasonCode: string,
		readonly model: string,
		/** Billed tokens of the failed call (thinking can use up max_tokens). */
		readonly usage: { inputTokens: number; outputTokens: number } | null = null,
	) {
		super(`llm_output:${reasonCode}`);
		this.name = "LlmOutputError";
	}
}

/**
 * The call did not produce a response: API status (e.g. `api_400:invalid_request_error`,
 * `api_429:rate_limit_error`), `connection`, or `spend_limit`. No message bodies or keys.
 */
export class LlmCallError extends Error {
	constructor(
		readonly reasonCode: string,
		/** 429, 5xx and connection failures; the core may retry once within budget. */
		readonly retryable: boolean,
	) {
		super(`llm_call:${reasonCode}`);
		this.name = "LlmCallError";
	}
}

/** An eventId was resent with different content. */
export class ObservationConflictError extends Error {
	constructor(readonly eventId: string) {
		super(`observation_conflict:${eventId}`);
		this.name = "ObservationConflictError";
	}
}
