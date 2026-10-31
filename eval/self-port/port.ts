/**
 * Self-inference port (plan §6.6.2). Evaluation only; never imported from src/.
 * An LlmPort that answers from files instead of a model API (no API key is used):
 *   - key = sha256(purpose, system, prompt, salt). salt = rep, so each rep is answered
 *     independently. Condition names never appear in the request file.
 *   - <dir>/answers/<key>.json exists → parsed with the request's own zod schema.
 *   - otherwise <dir>/queue/<key>.req.json is written and the call fails with
 *     SelfPortPending; the runner drops that run (no record) and it is retried with --resume
 *     after the answers are written.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type {
	LlmPort,
	LlmRequest,
	LlmResult,
} from "../../src/contracts/ports.ts";

export class SelfPortPending extends Error {
	constructor(readonly key: string) {
		super(`self-port: answer pending for ${key}`);
	}
}

export interface SelfPort extends LlmPort {
	setSalt(salt: string): void;
	/** Requests queued since the last reset. */
	pending(): number;
	reset(): void;
}

export const selfKey = (
	purpose: string,
	system: string,
	prompt: string,
	salt: string,
): string =>
	createHash("sha256")
		.update(`${purpose}\0${system}\0${prompt}\0${salt}`)
		.digest("hex")
		.slice(0, 20);

export function createSelfPort(dir: string): SelfPort {
	mkdirSync(join(dir, "queue"), { recursive: true });
	mkdirSync(join(dir, "answers"), { recursive: true });
	let salt = "";
	let queued = 0;
	return {
		setSalt(s) {
			salt = s;
		},
		pending: () => queued,
		reset() {
			queued = 0;
		},
		async complete<T>(
			request: LlmRequest<T>,
			_signal: AbortSignal,
		): Promise<LlmResult<T>> {
			const key = selfKey(
				request.purpose,
				request.system,
				request.prompt,
				salt,
			);
			const ans = join(dir, "answers", `${key}.json`);
			if (existsSync(ans)) {
				const raw = JSON.parse(readFileSync(ans, "utf8"));
				return {
					value: request.schema.parse(raw),
					model: "self",
					inputTokens: 0,
					outputTokens: 0,
					cacheReadTokens: 0,
					latencyMs: 0,
				};
			}
			const req = join(dir, "queue", `${key}.req.json`);
			// Only the first unanswered call of a run is a real request; later calls in the
			// same run see a state that already lacks that answer.
			if (queued === 0 && !existsSync(req))
				writeFileSync(
					req,
					JSON.stringify(
						{
							key,
							purpose: request.purpose,
							system: request.system,
							prompt: request.prompt,
							schema: z.toJSONSchema(request.schema as z.ZodType, {
								unrepresentable: "any",
							}),
						},
						null,
						1,
					),
				);
			queued++;
			throw new SelfPortPending(key);
		},
	};
}
