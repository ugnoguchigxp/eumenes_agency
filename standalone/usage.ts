import type Anthropic from "@anthropic-ai/sdk";
import type { ResponseUsage } from "openai/resources/responses/responses";
import {
	appendFileSync,
	closeSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { LlmCallError } from "../src/index.ts";
import { createHash } from "node:crypto";

export type Provider = "anthropic" | "openai";
/** Disabled is valid only for an Anthropic request with no cache_control anywhere. */
export type CacheWritePolicy = "possible" | "disabled";
export interface ProviderUsage {
	provider: Provider;
	model: string;
	requestId: string;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	/** Absent on historical rows whose OpenAI cache writes were not recorded. */
	cacheWriteAccounting?: "reported" | "upper_bound";
	reasoningTokens: number | null;
}

export function anthropicUsage(
	model: string,
	usage: Anthropic.Usage,
	requestId = "",
): ProviderUsage {
	const read = usage.cache_read_input_tokens ?? 0;
	const write = usage.cache_creation_input_tokens ?? 0;
	return {
		provider: "anthropic",
		model,
		requestId,
		inputTokens: usage.input_tokens + read + write,
		outputTokens: usage.output_tokens,
		cacheReadTokens: read,
		cacheWriteTokens: write,
		reasoningTokens: null,
	};
}

export function openaiUsage(
	model: string,
	usage: ResponseUsage,
	requestId: string,
): ProviderUsage {
	return {
		provider: "openai",
		model,
		requestId,
		inputTokens: usage.input_tokens,
		outputTokens: usage.output_tokens,
		cacheReadTokens: usage.input_tokens_details.cached_tokens,
		cacheWriteTokens:
			usage.input_tokens_details.cache_write_tokens ??
			Math.max(
				0,
				usage.input_tokens - usage.input_tokens_details.cached_tokens,
			),
		cacheWriteAccounting:
			usage.input_tokens_details.cache_write_tokens === undefined
				? "upper_bound"
				: "reported",
		reasoningTokens: usage.output_tokens_details.reasoning_tokens,
	};
}

/** Standard global text pricing, verified 2026-11-05. Unknown models never cost zero. */
export function usageUsd(u: ProviderUsage): number {
	for (const n of [
		u.inputTokens,
		u.outputTokens,
		u.cacheReadTokens,
		u.cacheWriteTokens,
	])
		if (!Number.isSafeInteger(n) || n < 0)
			throw new RangeError("invalid provider usage");
	if (u.cacheReadTokens + u.cacheWriteTokens > u.inputTokens)
		throw new RangeError("cache tokens exceed input");
	if (
		u.reasoningTokens !== null &&
		(!Number.isSafeInteger(u.reasoningTokens) ||
			u.reasoningTokens < 0 ||
			u.reasoningTokens > u.outputTokens)
	)
		throw new RangeError("invalid reasoning usage");
	const long = u.inputTokens > (u.provider === "anthropic" ? 100_000 : 272_000);
	const rates =
		u.provider === "anthropic" && u.model === "claude-haiku-5-5"
			? { input: long ? 0.5 : 0.1, output: long ? 2.5 : 0.5, write: 2 }
			: u.provider === "openai" && u.model === "gpt-6-luna"
				? { input: long ? 0.2 : 0.1, output: long ? 0.75 : 0.5, write: 2.5 }
				: null;
	if (!rates) throw new LlmCallError("spend_price_missing", false);
	return (
		((u.inputTokens - u.cacheReadTokens - u.cacheWriteTokens) * rates.input +
			u.cacheReadTokens * rates.input * 0.1 +
			u.cacheWriteTokens * rates.input * rates.write +
			u.outputTokens * rates.output) /
		1_000_000
	);
}

/** Reserve the full provider context/output envelope before HTTP, not a guessed prompt count. */
export function maximumCallUsd(
	provider: Provider,
	model: string,
	maxOutputTokens: number,
	cacheWrites: CacheWritePolicy = "possible",
): number {
	if (
		!["possible", "disabled"].includes(cacheWrites) ||
		(cacheWrites === "disabled" && provider !== "anthropic")
	)
		throw new RangeError("invalid cache-write reservation policy");
	if (
		!Number.isSafeInteger(maxOutputTokens) ||
		maxOutputTokens < 1 ||
		maxOutputTokens > 128_000
	)
		throw new RangeError("invalid output budget");
	if (provider === "anthropic" && model === "claude-haiku-5-5")
		return (
			((1_000_000 * 0.5 * (cacheWrites === "disabled" ? 1 : 2) +
				maxOutputTokens * 2.5) /
				1_000_000) *
			1.2
		);
	if (provider === "openai" && model === "gpt-6-luna")
		return ((1_050_000 * 0.2 * 2.5 + maxOutputTokens * 0.75) / 1_000_000) * 1.2;
	throw new LlmCallError("spend_price_missing", false);
}

type Row =
	| {
			kind: "reserve";
			id: string;
			usd: number;
			provider: Provider;
			model: string;
			cacheWrites?: CacheWritePolicy;
			at: number;
	  }
	| {
			kind: "usage";
			id: string;
			usd: number;
			usage: ProviderUsage;
			at: number;
	  };

export interface ApiMeter {
	assertWithinLimit(): void;
	spentUsd(): number;
	localSpentUsd(): number;
	record(model: string, usage: Anthropic.Usage): void;
	recordProvider(usage: ProviderUsage, reservation?: string): void;
	reserve(
		provider: Provider,
		model: string,
		maxOutputTokens: number,
		cacheWrites?: CacheWritePolicy,
	): string;
	/** Administrative, explicit authorization only. Ordinary limit mismatches still fail closed. */
	raiseLimit(
		nextUsd: number,
		authorization: { maximumUsd: number; reason: string },
	): void;
	summary(): {
		limitUsd: number;
		knownUsd: number;
		reservedUsd: number;
		calls: number;
		uncertain: number;
		legacyCacheWriteUpperUsd: number;
		legacyCacheWriteCalls: number;
	};
}

/** Append-only, process-safe session accounting. Uncertain/cancelled calls keep their reservation. */
export function openApiMeter(path: string, limitUsd: number): ApiMeter {
	if (!Number.isFinite(limitUsd) || limitUsd <= 0)
		throw new RangeError("invalid API dollar limit");
	mkdirSync(dirname(path), { recursive: true });
	const lock = path + ".lock";
	let localUsd = 0;
	const locked = <T>(fn: () => T): T => {
		const until = performance.now() + 250;
		for (;;) {
			try {
				mkdirSync(lock);
				break;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
				if (performance.now() >= until)
					throw new LlmCallError("spend_ledger_busy", false);
				// Different processes can finish their short ledger transaction while this one waits.
				Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
			}
		}
		try {
			return fn();
		} finally {
			rmSync(lock, { recursive: true });
		}
	};
	const policy = path + ".policy.json";
	const durableAppend = (row: Row) => {
		appendFileSync(path, JSON.stringify(row) + "\n", { mode: 0o600 });
		const fd = openSync(path, "r+");
		try {
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
	};
	locked(() => {
		if (existsSync(policy)) {
			const p: unknown = JSON.parse(readFileSync(policy, "utf8"));
			if (
				JSON.stringify(p) !==
				JSON.stringify({
					version: 1,
					limitUsd,
					pricing: "standard-global-2026-11-05",
				})
			)
				throw new Error("API session policy mismatch");
		} else
			writeFileSync(
				policy,
				JSON.stringify({
					version: 1,
					limitUsd,
					pricing: "standard-global-2026-11-05",
				}),
				{ mode: 0o600 },
			);
	});
	const rows = (): Row[] =>
		existsSync(path)
			? readFileSync(path, "utf8")
					.split("\n")
					.filter(Boolean)
					.map((l) => JSON.parse(l) as Row)
			: [];
	const state = () => {
		const pending = new Map<string, Extract<Row, { kind: "reserve" }>>();
		const seen = new Set<string>();
		let knownUsd = 0;
		let calls = 0;
		let legacyCacheWriteUpperUsd = 0;
		let legacyCacheWriteCalls = 0;
		for (const row of rows()) {
			if (
				!Number.isFinite(row.usd) ||
				row.usd < 0 ||
				typeof row.id !== "string" ||
				!row.id ||
				!Number.isFinite(row.at)
			)
				throw new Error("corrupt API ledger");
			if (row.kind === "reserve" && !seen.has(row.id)) {
				if (
					(row.cacheWrites !== undefined &&
						!["possible", "disabled"].includes(row.cacheWrites)) ||
					(row.cacheWrites === "disabled" && row.provider !== "anthropic")
				)
					throw new Error("corrupt API ledger cache policy");
				if (
					!(
						(row.provider === "anthropic" &&
							row.model === "claude-haiku-5-5") ||
						(row.provider === "openai" && row.model === "gpt-6-luna")
					)
				)
					throw new Error("corrupt API ledger model");
				seen.add(row.id);
				pending.set(row.id, row);
				calls++;
			} else if (row.kind === "usage" && pending.has(row.id)) {
				const reservation = pending.get(row.id)!;
				if (
					row.usage.provider !== reservation.provider ||
					row.usage.model !== reservation.model ||
					row.usd !== usageUsd(row.usage) ||
					row.usd > reservation.usd
				)
					throw new Error("corrupt API ledger settlement");
				knownUsd += row.usd;
				if (
					row.usage.provider === "openai" &&
					row.usage.cacheWriteAccounting === undefined
				) {
					// Bound unreported historical writes at the maximum 12h rate (2.5x).
					// Their ordinary 1x input rate is already in knownUsd.
					const u = row.usage;
					const inputRate = u.inputTokens > 272_000 ? 0.2 : 0.1;
					legacyCacheWriteUpperUsd +=
						((u.inputTokens - u.cacheReadTokens - u.cacheWriteTokens) *
							inputRate *
							1.5) /
						1_000_000;
					legacyCacheWriteCalls++;
				}
				pending.delete(row.id);
			} else throw new Error("corrupt API ledger sequence");
		}
		return {
			limitUsd,
			knownUsd,
			reservedUsd:
				[...pending.values()].reduce((a, b) => a + b.usd, 0) +
				legacyCacheWriteUpperUsd,
			calls,
			uncertain: pending.size,
			legacyCacheWriteUpperUsd,
			legacyCacheWriteCalls,
			pending,
		};
	};
	return {
		raiseLimit(nextUsd, authorization) {
			locked(() => {
				if (
					!Number.isFinite(nextUsd) ||
					!Number.isFinite(authorization.maximumUsd) ||
					nextUsd <= limitUsd ||
					nextUsd > authorization.maximumUsd ||
					!authorization.reason.trim()
				)
					throw Error("invalid explicit budget grant");
				const current = JSON.parse(readFileSync(policy, "utf8"));
				if (
					JSON.stringify(current) !==
					JSON.stringify({
						version: 1,
						limitUsd,
						pricing: "standard-global-2026-11-05",
					})
				)
					throw Error(
						"API session policy changed; reopen before authorization",
					);
				const s = state();
				if (s.knownUsd + s.reservedUsd > nextUsd)
					throw Error("authorized budget does not cover existing exposure");
				const next = {
					version: 1,
					limitUsd: nextUsd,
					pricing: "standard-global-2026-11-05",
				};
				const audit = {
					fromUsd: limitUsd,
					toUsd: nextUsd,
					authorization,
					ledgerSha256: createHash("sha256")
						.update(existsSync(path) ? readFileSync(path) : "")
						.digest("hex"),
					previousPolicy: current,
					at: Date.now(),
				};
				const history = policy.replace(/\.json$/, "-history.jsonl");
				appendFileSync(history, JSON.stringify(audit) + "\n", { mode: 0o600 });
				const auditFd = openSync(history, "r+");
				try {
					fsyncSync(auditFd);
				} finally {
					closeSync(auditFd);
				}
				const temporary = policy + ".next-" + crypto.randomUUID();
				try {
					writeFileSync(temporary, JSON.stringify(next), { mode: 0o600 });
					const fd = openSync(temporary, "r+");
					try {
						fsyncSync(fd);
					} finally {
						closeSync(fd);
					}
					renameSync(temporary, policy);
					const directory = openSync(dirname(policy), "r");
					try {
						fsyncSync(directory);
					} finally {
						closeSync(directory);
					}
					limitUsd = nextUsd;
				} finally {
					rmSync(temporary, { force: true });
				}
			});
		},
		summary() {
			return locked(() => {
				const { pending: _pending, ...summary } = state();
				return summary;
			});
		},
		spentUsd: () => locked(() => state().knownUsd),
		localSpentUsd: () => localUsd,
		assertWithinLimit() {
			locked(() => {
				const s = state();
				if (s.knownUsd + s.reservedUsd >= limitUsd)
					throw new LlmCallError("spend_limit", false);
			});
		},
		reserve(provider, model, maxOutputTokens, cacheWrites) {
			return locked(() => {
				const usd = maximumCallUsd(
					provider,
					model,
					maxOutputTokens,
					cacheWrites,
				);
				const s = state();
				if (s.knownUsd + s.reservedUsd + usd > limitUsd)
					throw new LlmCallError("spend_limit", false);
				const id = crypto.randomUUID();
				durableAppend({
					kind: "reserve",
					id,
					usd,
					provider,
					model,
					...(cacheWrites ? { cacheWrites } : {}),
					at: Date.now(),
				});
				return id;
			});
		},
		record() {
			throw new Error(
				"API session requires a reservation and normalized usage",
			);
		},
		recordProvider(usage, reservation) {
			locked(() => {
				if (!reservation) throw new Error("missing API reservation");
				const s = state();
				const reserved = s.pending.get(reservation);
				if (reserved === undefined)
					throw new Error("unknown or already settled API reservation");
				if (
					usage.provider !== reserved.provider ||
					usage.model !== reserved.model
				)
					throw new Error("API reservation model mismatch");
				const usd = usageUsd(usage);
				if (usd > reserved.usd)
					throw new Error("provider charge exceeds reserved envelope");
				durableAppend({
					kind: "usage",
					id: reservation,
					usd,
					usage,
					at: Date.now(),
				});
				localUsd += usd;
			});
		},
	};
}
