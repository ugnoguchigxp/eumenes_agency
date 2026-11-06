/** Live API only. Usage: bun eval/live-b1-f/run.ts --b1-root <checkout> --out <dir> [--reps 3] [--budget-usd 5] [--resume] */
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { parseArgs } from "node:util";
import { z } from "zod";
import {
	createAgencyRuntime,
	defaultBudget,
	defaultLimits,
	type AgencyRuntime,
	type AgencySnapshot,
	type CallOutcome,
	type Decision,
	type LlmPort,
	type LlmRequest,
	type LlmResult,
	LlmCallError,
} from "../../src/index.ts";
import {
	createClaudeClient,
	type UsageMeter,
} from "../../standalone/claude.ts";
import {
	loadSettings,
	judgeRole,
	openSpendMeter,
} from "../../standalone/settings.ts";
import { createProviderLlm } from "../../standalone/providers.ts";
import { withCommandBudget } from "../budget.ts";
import { scenes, type Scene } from "./cases.ts";
import { factoringFetch } from "./transport.ts";
import {
	judgePolicy,
	judgeData,
	judgmentSchema,
	normalize,
	policy,
	protocolVersion,
	rates,
	score,
	sumMetrics,
	type Checkpoint,
	type Judgment,
	type Metrics,
} from "./protocol.ts";

export const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const T0 = 1_700_000_000_000;
export const experimentBudget = {
	...defaultBudget,
	maxCallsPerWindow: 12,
	windowMs: 3_600_000,
	minIntervalMs: 0,
	batchSize: 16,
	updateMaxOutputTokens: 2400,
	selectMaxOutputTokens: 1000,
};
export const experimentLimits = {
	...defaultLimits,
	notes: 16,
	outboundIntervalMs: 0,
};
export const experimentTools = [
	{
		name: "lookup",
		description:
			"未解決の技術的な問いを読み取り専用の資料で調べる。問いと知りたい条件を入力する。",
		requiresApproval: false,
	},
	{
		name: "delete_files",
		description: "ファイルを削除する。承認が必要。",
		requiresApproval: true,
	},
];
type Variant = "B1" | "F";
type Factory = (
	deps: Parameters<typeof createAgencyRuntime>[0] & { typedNotes?: boolean },
) => AgencyRuntime;
export interface CallRecord {
	purpose: string;
	model: string | null;
	inputTokens: number;
	outputTokens: number;
	latencyMs: number;
	error?: string;
}
export interface Cell {
	key: string;
	scene: string;
	rep: number;
	variant: Variant;
	checkpoints: Checkpoint[];
	outcomes: CallOutcome[];
	calls: CallRecord[];
	rawSelections: unknown[];
	snapshot: AgencySnapshot;
	usd: number;
}

export async function runCell(
	scene: Scene,
	variant: Variant,
	rep: number,
	factory: Factory,
	llm: LlmPort,
	spent: () => number,
	trace?: (row: unknown) => void,
): Promise<Cell> {
	const calls: CallRecord[] = [];
	const rawSelections: unknown[] = [];
	const startUsd = spent();
	let phase = "init";
	const traced: LlmPort = {
		async complete<T>(
			request: LlmRequest<T>,
			signal: AbortSignal,
		): Promise<LlmResult<T>> {
			if (calls.length >= 16) throw new Error("cell_call_cap");
			const row: CallRecord = {
				purpose: request.purpose,
				model: null,
				inputTokens: 0,
				outputTokens: 0,
				latencyMs: 0,
			};
			calls.push(row);
			try {
				const answer = await llm.complete(request, signal);
				Object.assign(row, {
					model: answer.model,
					inputTokens: answer.inputTokens,
					outputTokens: answer.outputTokens,
					latencyMs: answer.latencyMs,
				});
				if (request.purpose === "select")
					rawSelections.push({ phase, value: answer.value });
				trace?.({
					phase,
					purpose: request.purpose,
					system: request.system,
					prompt: request.prompt,
					value: answer.value,
					model: answer.model,
					inputTokens: answer.inputTokens,
					outputTokens: answer.outputTokens,
					latencyMs: answer.latencyMs,
				});
				return answer;
			} catch (error) {
				row.error = error instanceof Error ? error.name : "unknown";
				trace?.({ phase, purpose: request.purpose, error: row.error });
				throw error;
			}
		},
	};
	const rt = factory({
		condition: variant,
		llm: traced,
		tools: experimentTools,
		systemContext: {
			update: ({ outputContract }) =>
				policy("update", outputContract.description),
			select: ({ outputContract }) =>
				policy("select", outputContract.description),
		},
		budget: experimentBudget,
		limits: experimentLimits,
		...(variant === "B1" ? { typedNotes: true } : { interestFormation: true }),
	});
	const checkpoints: Checkpoint[] = [];
	const outcomes: CallOutcome[] = [];
	let obsId = 0;
	for (const frame of scene.frames) {
		phase = frame.id;
		const at = T0 + frame.hour * 3_600_000;
		for (const o of frame.observations)
			rt.observe({
				id: `observation-${++obsId}`,
				actor: o.actor,
				kind: o.actor === "tool" ? "action.observed" : "exchange.adopted",
				occurredAt: at,
				text: o.text,
			});
		const signal = new AbortController().signal;
		outcomes.push(...(await rt.runBackground(at, signal)));
		if (
			outcomes.some(
				(o) =>
					o.code.startsWith("llm_call:") ||
					o.code.startsWith("llm:") ||
					o.code.startsWith("error:"),
			)
		)
			break;
		let decision: Decision | null = null;
		if (frame.opportunity) {
			const r = await rt.decide(
				{
					id: `opportunity-${frame.id}`,
					at,
					trigger: "idle",
					presence: "quiet",
					foregroundBusy: false,
					playerBusy: false,
				},
				signal,
			);
			decision = r.decision;
			outcomes.push(...r.calls);
		}
		checkpoints.push(
			normalize(
				rt.snapshot(),
				frame,
				decision
					? {
							action: decision.action,
							text: decision.utterance,
							tool: decision.toolName,
							evidence: decision.evidenceRefs,
							source: decision.source,
						}
					: null,
			),
		);
		const raw = rawSelections.at(-1) as
			| {
					phase: string;
					value: {
						action: string;
						utterance?: string | null;
						toolName?: string | null;
						toolInput?: string | null;
					};
			  }
			| undefined;
		if (raw?.phase === phase)
			checkpoints.at(-1)!.attemptedAction = {
				action: raw.value.action,
				text: raw.value.utterance ?? raw.value.toolInput ?? null,
				tool: raw.value.toolName ?? null,
			};
		if (decision?.ticket) {
			const tool = decision.ticket.action === "tool";
			rt.recordResult({
				ticketId: decision.ticket.id,
				at: at + 1,
				status: tool
					? frame.toolResult
						? (frame.toolStatus ?? "succeeded")
						: "failed"
					: "succeeded",
				resultText: tool
					? (frame.toolResult ?? "評価用資料がなく、何も確認できなかった。")
					: (decision.ticket.utterance ?? ""),
			});
		}
		if (outcomes.some((o) => o.code.startsWith("llm_call:spend_limit"))) break;
	}
	return {
		key: `${scene.id}:${rep}:${variant}`,
		scene: scene.id,
		rep,
		variant,
		checkpoints,
		outcomes,
		calls,
		rawSelections,
		snapshot: rt.snapshot(),
		usd: spent() - startUsd,
	};
}

interface Result {
	cell: Cell;
	judgment: Judgment | null;
	metrics: Metrics | null;
	error: string | null;
	judgeUsage: CallRecord | null;
}
const readLines = <T>(path: string): T[] =>
	existsSync(path)
		? readFileSync(path, "utf8")
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line) as T)
		: [];
const commitOf = (root: string) => {
	const p = Bun.spawnSync(["git", "-C", root, "rev-parse", "HEAD"]);
	if (p.exitCode !== 0) throw new Error("cannot identify source commit");
	return p.stdout.toString().trim();
};
const percentile = (a: number[], p: number) =>
	a[Math.min(a.length - 1, Math.floor(p * a.length))] ?? null;
/** Paired cluster bootstrap: scenes are sampled as units, retaining their repeated measurements. */
export function differences(results: Result[]) {
	const paired = results.filter(
		(r) =>
			r.metrics &&
			results.some(
				(other) =>
					other.metrics &&
					other.cell.scene === r.cell.scene &&
					other.cell.rep === r.cell.rep &&
					other.cell.variant !== r.cell.variant,
			),
	);
	const keys = [
		"interestPrecision",
		"interestRecall",
		"lifecycle",
		"usefulActionRecall",
		"actionPrecision",
		"quietSpecificity",
		"epistemicAccuracy",
		"policyAccuracy",
	] as const;
	const complete = scenes.filter(
		(s) =>
			paired.some(
				(r) => r.cell.scene === s.id && r.cell.variant === "B1" && r.metrics,
			) &&
			paired.some(
				(r) => r.cell.scene === s.id && r.cell.variant === "F" && r.metrics,
			),
	);
	let seed = 20261101;
	const random = () => {
		seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
		return seed / 4294967296;
	};
	const samples = Object.fromEntries(keys.map((k) => [k, [] as number[]]));
	for (let n = 0; n < 2000 && complete.length > 0; n++) {
		const chosen = Array.from(
			{ length: complete.length },
			() => complete[Math.floor(random() * complete.length)]!.id,
		);
		const by = (v: Variant) =>
			rates(
				sumMetrics(
					chosen.flatMap((id) =>
						paired
							.filter(
								(r) => r.cell.scene === id && r.cell.variant === v && r.metrics,
							)
							.map((r) => r.metrics!),
					),
				),
			);
		const b = by("B1"),
			f = by("F");
		for (const k of keys)
			if (b[k] !== null && f[k] !== null) samples[k]!.push(f[k]! - b[k]!);
	}
	return Object.fromEntries(
		keys.map((k) => {
			const a = samples[k]!.sort((x, y) => x - y);
			return [k, { low: percentile(a, 0.025), high: percentile(a, 0.975) }];
		}),
	);
}
export function summarize(results: Result[]) {
	return Object.fromEntries(
		(["B1", "F"] as const).map((variant) => {
			const rows = results.filter((r) => r.cell.variant === variant);
			const good = rows.filter((r) => r.metrics);
			const m = good.length ? sumMetrics(good.map((r) => r.metrics!)) : null;
			return [
				variant,
				{
					cells: rows.length,
					judged: good.length,
					errors: rows
						.filter((r) => r.error)
						.map((r) => ({ key: r.cell.key, error: r.error })),
					raw: m,
					rates: m ? rates(m) : null,
					calls: rows.reduce((n, r) => n + r.cell.calls.length, 0),
					inputTokens: rows.reduce(
						(n, r) => n + r.cell.calls.reduce((s, c) => s + c.inputTokens, 0),
						0,
					),
					outputTokens: rows.reduce(
						(n, r) => n + r.cell.calls.reduce((s, c) => s + c.outputTokens, 0),
						0,
					),
					agentUsd: rows.reduce((n, r) => n + r.cell.usd, 0),
					rejectedUpdates: rows.reduce(
						(n, r) =>
							n +
							r.cell.outcomes.filter(
								(c) => c.purpose === "update" && c.code.startsWith("rejected"),
							).length,
						0,
					),
					rejectedSelects: rows.reduce(
						(n, r) =>
							n +
							r.cell.outcomes.filter(
								(c) => c.purpose === "select" && c.code.startsWith("rejected"),
							).length,
						0,
					),
					providerFailures: rows.reduce(
						(n, r) => n + r.cell.calls.filter((c) => c.error).length,
						0,
					),
				},
			];
		}),
	);
}

async function main() {
	const { values } = parseArgs({
		args: process.argv.slice(2),
		options: {
			"b1-root": { type: "string" },
			out: { type: "string" },
			reps: { type: "string", default: "3" },
			"budget-usd": { type: "string", default: "5" },
			resume: { type: "boolean", default: false },
		},
	});
	if (!values.out || !values["b1-root"])
		throw new Error("--out and --b1-root required");
	if (process.env.SELF_PORT_DIR)
		throw new Error("live comparison refuses SELF_PORT_DIR");
	const reps = Number(values.reps),
		limit = Number(values["budget-usd"]);
	if (
		!Number.isInteger(reps) ||
		reps < 1 ||
		!Number.isFinite(limit) ||
		limit <= 0 ||
		limit > 5
	)
		throw new Error("invalid repetitions or budget (approved maximum $5)");
	const root = resolve(import.meta.dir, "../..");
	const b1Root = resolve(values["b1-root"]);
	const imported = await import(
		pathToFileURL(join(b1Root, "src/index.ts")).href
	);
	const b1Factory = imported.createAgencyRuntime as Factory;
	if (typeof b1Factory !== "function") throw new Error("B1 runtime missing");
	const out = resolve(values.out);
	mkdirSync(out, { recursive: true });
	const settings = loadSettings();
	const protocolHash = hash(
		readFileSync(join(import.meta.dir, "protocol.ts"), "utf8") +
			readFileSync(join(import.meta.dir, "cases.ts"), "utf8") +
			readFileSync(join(import.meta.dir, "transport.ts"), "utf8") +
			readFileSync(import.meta.filename, "utf8"),
	);
	const config = {
		protocolVersion,
		protocolHash,
		b1Commit: commitOf(b1Root),
		fCommit: commitOf(root),
		background: settings.llm.background,
		judge: judgeRole(settings),
		pricing: settings.spend.pricing,
		budget: experimentBudget,
		limits: experimentLimits,
		tools: experimentTools,
		reps,
		approvedUsd: limit,
		order: "alternate-first-condition per scene and repetition",
		caseCount: scenes.length,
	};
	const manifest = join(out, "manifest.json");
	if (existsSync(manifest)) {
		if (!values.resume) throw new Error("output exists; use --resume");
		if (
			JSON.stringify(JSON.parse(readFileSync(manifest, "utf8"))) !==
			JSON.stringify(config)
		)
			throw new Error("resume protocol/config/source mismatch");
	} else writeFileSync(manifest, JSON.stringify(config, null, 2));
	const meter = openSpendMeter(settings, join(out, "spend.jsonl"));
	const globalMeter = openSpendMeter(settings);
	const commandMeter: UsageMeter = process.env.AGENCY_API_LEDGER
		? meter
		: {
				assertWithinLimit() {
					if (meter.spentUsd() >= limit)
						throw new Error("command budget reached");
					globalMeter.assertWithinLimit();
				},
				recordProvider(usage) {
					if (!meter.recordProvider || !globalMeter.recordProvider)
						throw new Error("provider accounting unavailable");
					meter.recordProvider(usage);
					globalMeter.recordProvider(usage);
				},
				record(model, usage) {
					meter.record(model, usage);
					globalMeter.record(model, usage);
				},
				spentUsd: () => meter.spentUsd(),
			};
	const client = createClaudeClient({
		maxRetries: 0,
		timeout: 60_000,
		fetch: factoringFetch,
	});
	const priced = Object.values(settings.spend.pricing);
	if (
		!settings.spend.pricing[settings.llm.background.model] ||
		!settings.spend.pricing[judgeRole(settings).model]
	)
		throw new Error("both model prices must be configured");
	const inputPrice = Math.max(...priced.map((p) => p.input));
	const outputPrice = Math.max(...priced.map((p) => p.output));
	const bounded = (role: typeof settings.llm.background): LlmPort => {
		const base = createProviderLlm(
			role,
			commandMeter,
			role.provider === "openai" ? undefined : client,
		);
		return {
			complete<T>(request: LlmRequest<T>, signal: AbortSignal) {
				const schema = JSON.stringify(
					z.toJSONSchema(request.schema as z.ZodType, {
						unrepresentable: "any",
					}),
				);
				// UTF-8 bytes bound ordinary tokenizer input conservatively. Reserve the most
				// expensive configured route, cache-write premium, output cap and framing room.
				const bytes =
					new TextEncoder().encode(request.system + request.prompt + schema)
						.length + 4096;
				const reserve =
					(bytes * inputPrice * 1.25 +
						Math.min(16000, request.maxOutputTokens + role.thinkingHeadroom) *
							outputPrice) /
					1_000_000;
				if (meter.spentUsd() + reserve > limit)
					return Promise.reject(new LlmCallError("spend_limit", false));
				return base.complete(request, signal);
			},
		};
	};
	const llm = withCommandBudget(
		bounded(settings.llm.background),
		commandMeter.spentUsd,
		limit - meter.spentUsd(),
	);
	const judge = bounded(judgeRole(settings));
	const cellsPath = join(out, "cells.jsonl");
	const cachedCells = new Map(
		readLines<Cell>(cellsPath).map((c) => [c.key, c]),
	);
	const resultPath = join(out, "runs.jsonl");
	const results = readLines<Result>(resultPath);
	const done = new Set(results.map((r) => r.cell.key));
	let consecutiveFailures = 0;
	const variantFailures: Record<Variant, number> = { B1: 0, F: 0 };
	let stop: string | null = null;
	const save = () =>
		writeFileSync(
			join(out, "summary.json"),
			JSON.stringify(
				{
					config,
					spentUsd: meter.spentUsd(),
					stoppedBy: stop,
					results: summarize(results),
					pairedSceneBootstrap95: differences(results),
				},
				null,
				2,
			),
		);
	for (let rep = 1; rep <= reps && stop === null; rep++) {
		for (const [index, scene] of scenes.entries()) {
			const order: Variant[] =
				(rep + index) % 2 === 0 ? ["B1", "F"] : ["F", "B1"];
			for (const variant of order) {
				const key = `${scene.id}:${rep}:${variant}`;
				if (done.has(key)) continue;
				if (meter.spentUsd() >= limit) {
					stop = "budget";
					break;
				}
				console.log(
					JSON.stringify({ event: "start", key, spentUsd: meter.spentUsd() }),
				);
				let cell = cachedCells.get(key);
				if (!cell) {
					cell = await runCell(
						scene,
						variant,
						rep,
						variant === "B1" ? b1Factory : createAgencyRuntime,
						llm,
						commandMeter.spentUsd,
						(row) =>
							appendFileSync(
								join(out, "traces.jsonl"),
								JSON.stringify({ key, ...(row as object) }) + "\n",
							),
					);
					appendFileSync(cellsPath, JSON.stringify(cell) + "\n");
					cachedCells.set(key, cell);
				}
				let judgment: Judgment | null = null,
					metrics: Metrics | null = null,
					error: string | null = null,
					judgeUsage: CallRecord | null = null;
				if (cell.calls.some((c) => c.error))
					error = "agent_provider_or_output_failure";
				if (cell.checkpoints.length !== scene.frames.length)
					error = "incomplete_cell";
				if (!error) {
					try {
						const judged: Judgment["checkpoints"] = [];
						const usage: CallRecord = {
							purpose: "judge",
							model: null,
							inputTokens: 0,
							outputTokens: 0,
							latencyMs: 0,
						};
						// A separate request per checkpoint prevents access to later observations.
						for (const checkpoint of cell.checkpoints) {
							const one = {
								...scene,
								frames: scene.frames.filter((f) => f.id === checkpoint.id),
							};
							const answer = await judge.complete(
								{
									purpose: "respond",
									system: judgePolicy,
									prompt: JSON.stringify(judgeData(one, [checkpoint])),
									schema: judgmentSchema,
									maxOutputTokens: 1400,
								},
								new AbortController().signal,
							);
							score(one, [checkpoint], answer.value); // Validate complete ID coverage before accepting.
							judged.push(...answer.value.checkpoints);
							usage.model = answer.model;
							usage.inputTokens += answer.inputTokens;
							usage.outputTokens += answer.outputTokens;
							usage.latencyMs += answer.latencyMs;
						}
						judgment = { checkpoints: judged };
						metrics = score(scene, cell.checkpoints, judgment);
						judgeUsage = usage;
					} catch (e) {
						error = `judge_${e instanceof LlmCallError ? e.reasonCode : e instanceof Error ? e.message : "unknown"}`;
						if (e instanceof LlmCallError && e.reasonCode === "spend_limit")
							stop = "budget_reservation";
					}
				}
				const result: Result = { cell, judgment, metrics, error, judgeUsage };
				appendFileSync(resultPath, JSON.stringify(result) + "\n");
				results.push(result);
				done.add(key);
				consecutiveFailures = error ? consecutiveFailures + 1 : 0;
				variantFailures[variant] = error ? variantFailures[variant] + 1 : 0;
				if (consecutiveFailures >= 3) stop = "three_consecutive_failed_cells";
				if (variantFailures[variant] >= 3)
					stop = `three_consecutive_failed_${variant}_cells`;
				save();
				console.log(
					JSON.stringify({
						event: "done",
						key,
						error,
						agentCalls: cell.calls.length,
						spentUsd: meter.spentUsd(),
					}),
				);
				if (stop !== null) break;
			}
			if (stop !== null) break;
		}
	}
	save();
	console.log(
		JSON.stringify({
			event: "finished",
			stop,
			cells: results.length,
			spentUsd: meter.spentUsd(),
		}),
	);
	if (stop) process.exitCode = 2;
}
if (import.meta.main) await main();
