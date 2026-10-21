/**
 * Per-call model tracing for eval runs: eval/results/<name>/traces.jsonl.
 *
 * Two line types: `call` (one per LlmPort.complete, success or error) and `final`
 * (the runtime's state after a replay). Only request/response data is written;
 * never settings, env values or API keys.
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import type { AgencyState, Condition } from "../src/contracts/model.ts";
import type {
	LlmPort,
	LlmPurpose,
	LlmRequest,
	LlmResult,
} from "../src/contracts/ports.ts";

export interface TraceContext {
	readonly caseId: string;
	readonly condition: Condition;
	readonly rep: number;
}

export interface TraceError {
	readonly name: string;
	readonly message: string;
	readonly reasonCode?: string;
}

interface TraceBase extends TraceContext {
	readonly runName: string;
}

export interface CallTrace extends TraceBase {
	readonly type: "call";
	readonly seq: number;
	readonly purpose: LlmPurpose;
	readonly system: string;
	readonly prompt: string;
	readonly output?: unknown;
	readonly model?: string;
	readonly inputTokens?: number;
	readonly outputTokens?: number;
	readonly latencyMs?: number;
	readonly error?: TraceError;
}

export interface FinalTrace extends TraceBase {
	readonly type: "final";
	readonly state: AgencyState;
}

export type TraceLine = CallTrace | FinalTrace;

export interface TraceRecorder {
	/** The port to hand to the runtime. */
	readonly llm: LlmPort;
	/** Starts a replay: sets caseId/condition/rep and resets seq to 0. */
	begin(context: TraceContext): void;
	/** Records the runtime's final state for the current replay. */
	final(state: AgencyState): void;
}

/** Last-resort scrub so an API key echoed inside an error message is never persisted. */
const redact = (text: string): string =>
	text.replace(/sk-[A-Za-z0-9_-]{8,}/g, "[redacted]");

export function describeError(error: unknown): TraceError {
	if (!(error instanceof Error)) {
		return { name: "NonError", message: redact(String(error)) };
	}
	const reasonCode = (error as { reasonCode?: unknown }).reasonCode;
	return {
		name: error.name,
		message: redact(error.message),
		...(typeof reasonCode === "string" ? { reasonCode } : {}),
	};
}

export function createTraceRecorder(
	llm: LlmPort,
	file: string,
	runName: string,
): TraceRecorder {
	let context: TraceContext | null = null;
	let seq = 0;
	const write = (line: TraceLine): void => {
		appendFileSync(file, `${JSON.stringify(line)}\n`);
	};
	const current = (): TraceContext => {
		if (!context) throw new Error("trace: begin() was not called");
		return context;
	};
	return {
		llm: {
			async complete<T>(
				request: LlmRequest<T>,
				signal: AbortSignal,
			): Promise<LlmResult<T>> {
				const ctx = current();
				const base = {
					type: "call" as const,
					runName,
					caseId: ctx.caseId,
					condition: ctx.condition,
					rep: ctx.rep,
					seq: seq++,
					purpose: request.purpose,
					system: request.system,
					prompt: request.prompt,
				};
				try {
					const result = await llm.complete(request, signal);
					write({
						...base,
						output: result.value,
						model: result.model,
						inputTokens: result.inputTokens,
						outputTokens: result.outputTokens,
						latencyMs: result.latencyMs,
					});
					return result;
				} catch (error) {
					write({ ...base, error: describeError(error) });
					throw error;
				}
			},
		},
		begin(next) {
			context = next;
			seq = 0;
		},
		final(state) {
			const ctx = current();
			write({
				type: "final",
				runName,
				caseId: ctx.caseId,
				condition: ctx.condition,
				rep: ctx.rep,
				state,
			});
		},
	};
}

export function parseTraceJsonl(
	text: string,
	source = "traces.jsonl",
): TraceLine[] {
	const lines: TraceLine[] = [];
	text.split("\n").forEach((line, i) => {
		if (line.trim() === "") return;
		let raw: unknown;
		try {
			raw = JSON.parse(line);
		} catch (error) {
			throw new Error(
				`${source}:${i + 1}: invalid JSON (${(error as Error).message})`,
			);
		}
		const type = (raw as { type?: unknown } | null)?.type;
		if (type !== "call" && type !== "final") {
			throw new Error(`${source}:${i + 1}: unknown record type`);
		}
		lines.push(raw as TraceLine);
	});
	return lines;
}

export interface TraceFilter {
	readonly caseId: string;
	readonly condition?: string | undefined;
	readonly rep?: number | undefined;
}

const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();

const indent = (text: string, by: string): string =>
	text
		.split("\n")
		.map((l) => `${by}${l}`)
		.join("\n");

function formatState(state: AgencyState): string[] {
	const out: string[] = [
		`  revision=${state.revision} notes=${state.notes.length} beliefs=${state.beliefs.length} desires=${state.desires.length}`,
		`  intents (${state.intents.length}):`,
	];
	for (const i of state.intents) {
		out.push(`    ${i.id} [${i.state}] ${oneLine(i.desiredState)}`);
	}
	out.push(`  candidates (${state.candidates.length}):`);
	for (const c of state.candidates) {
		const why = c.holdReason
			? ` hold=${c.holdReason}`
			: c.closedReason
				? ` closed=${c.closedReason}`
				: "";
		out.push(
			`    ${c.id} [${c.state}]${why} ${c.kind} intent=${c.intentId} ${oneLine(c.content)}`,
		);
	}
	return out;
}

/** Readable trace of the runs matching the filter. Throws when nothing matches. */
export function formatTrace(
	lines: readonly TraceLine[],
	filter: TraceFilter,
	options: { prompt?: boolean } = {},
): string {
	const matching = lines.filter(
		(l) =>
			l.caseId === filter.caseId &&
			(filter.condition === undefined || l.condition === filter.condition) &&
			(filter.rep === undefined || l.rep === filter.rep),
	);
	if (matching.length === 0) {
		throw new Error(
			`no trace records for case=${filter.caseId}${filter.condition ? ` condition=${filter.condition}` : ""}${filter.rep !== undefined ? ` rep=${filter.rep}` : ""}`,
		);
	}
	const out: string[] = [];
	const seen = new Set<string>();
	for (const l of matching) {
		const key = `${l.condition}\u0000${l.rep}`;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(`=== ${l.runName} ${l.caseId} ${l.condition} rep${l.rep} ===`);
		const same = matching.filter(
			(x) => x.condition === l.condition && x.rep === l.rep,
		);
		for (const x of same) {
			if (x.type === "call") {
				const meta =
					x.error === undefined
						? ` model=${x.model} in=${x.inputTokens} out=${x.outputTokens} ${x.latencyMs}ms`
						: "";
				out.push(`[${x.seq}] ${x.purpose}${meta}`);
				if (options.prompt) {
					out.push("  prompt:", indent(x.prompt, "    "));
				}
				if (x.error) {
					out.push(
						`  ERROR ${x.error.name}${x.error.reasonCode ? ` (${x.error.reasonCode})` : ""}: ${x.error.message}`,
					);
				} else {
					out.push(
						"  output:",
						indent(JSON.stringify(x.output, null, 2) ?? "undefined", "    "),
					);
				}
			} else {
				out.push("final state:", ...formatState(x.state));
			}
		}
		out.push("");
	}
	return out.join("\n").trimEnd();
}

export function traceCommand(
	file: string,
	filter: TraceFilter,
	options: { prompt?: boolean } = {},
): string {
	if (!existsSync(file)) {
		throw new Error(
			`not found: ${file} (traces exist only for runs made with trace recording)`,
		);
	}
	return formatTrace(
		parseTraceJsonl(readFileSync(file, "utf8"), file),
		filter,
		options,
	);
}
