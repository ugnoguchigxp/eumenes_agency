/** Live experimental F-improved vs Fusion. Raw generations remain local. */
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { resolve, join } from "node:path";
import { parseArgs } from "node:util";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import {
	LlmCallError,
	type LlmPort,
	type LlmRequest,
	type AgencySnapshot,
} from "../../src/index.ts";
import { createClaudeLlm, type UsageMeter } from "../../standalone/claude.ts";
import {
	loadSettings,
	judgeRole,
	openSpendMeter,
} from "../../standalone/settings.ts";
import { withCommandBudget } from "../budget.ts";
import {
	runCell as nativeCell,
	hash,
	experimentBudget,
	experimentLimits,
	experimentTools,
	type Cell as NativeCell,
	type CallRecord,
} from "../live-b1-f/run.ts";
import { factoringFetch } from "../live-b1-f/transport.ts";
import { scenes, type Scene } from "./cases.ts";
import { sampleFactory, type Variant } from "./samples.ts";
import {
	judgePolicy,
	judgeData,
	normalize,
	judgmentSchema,
	protocolVersion,
	rates,
	score,
	sumMetrics,
	type Judgment,
	type Metrics,
} from "./protocol.ts";

export interface Cell extends Omit<NativeCell, "variant" | "checkpoints"> {
	variant: Variant;
	checkpoints: import("./protocol.ts").Checkpoint[];
}
interface Result {
	cell: Cell;
	judgment: Judgment | null;
	metrics: Metrics | null;
	error: string | null;
	judgeUsage: CallRecord | null;
}
export async function runCell(
	scene: Scene,
	variant: Variant,
	rep: number,
	factory: ReturnType<typeof sampleFactory>,
	llm: LlmPort,
	spent: () => number,
	trace?: (row: unknown) => void,
): Promise<Cell> {
	// Capture the same immutable per-frame snapshots used by the frozen executor.
	// Rebuild only the judge view, never from a later snapshot or a second state store.
	const snapshots: AgencySnapshot[] = [];
	const instrumented: typeof factory = (deps) => {
		const rt = factory(deps);
		return {
			...rt,
			snapshot() {
				const snapshot = rt.snapshot();
				snapshots.push(snapshot);
				return snapshot;
			},
		};
	};
	const cell = await nativeCell(
		scene,
		"F",
		rep,
		instrumented,
		llm,
		spent,
		trace,
	);
	const checkpoints = cell.checkpoints.map((c, index) => ({
		...normalize(snapshots[index]!, scene.frames[index]!, c.action),
		...(c.attemptedAction !== undefined
			? { attemptedAction: c.attemptedAction }
			: {}),
	}));
	for (const [index, c] of checkpoints.entries()) {
		if (c.action?.action === "tool") {
			const raw = cell.rawSelections.find(
				(s) => (s as { phase: string }).phase === c.id,
			) as { value: { candidateRef?: { id: string } | null } } | undefined;
			const candidate = snapshots[index]!.state.candidates.find(
				(t) => t.id === raw?.value.candidateRef?.id,
			);
			Object.assign(c.action, { toolInput: candidate?.toolInput ?? null });
		} else if (c.action) Object.assign(c.action, { toolInput: null });
	}
	return {
		...cell,
		checkpoints,
		key: `${scene.id}:${rep}:${variant}`,
		variant,
	};
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
				(r) =>
					r.cell.scene === s.id && r.cell.variant === "F-improved" && r.metrics,
			) &&
			paired.some(
				(r) =>
					r.cell.scene === s.id && r.cell.variant === "Fusion" && r.metrics,
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
		const b = by("F-improved"),
			f = by("Fusion");
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
		(["F-improved", "Fusion"] as const).map((variant) => {
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
			out: { type: "string" },
			reps: { type: "string", default: "3" },
			"budget-usd": { type: "string", default: "5" },
			resume: { type: "boolean", default: false },
		},
	});
	if (!values.out) throw new Error("--out required");
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
	const out = resolve(values.out);
	mkdirSync(out, { recursive: true });
	const settings = loadSettings();
	const sourceFiles = [
		"eval/f-fusion/protocol.ts",
		"eval/f-fusion/cases.ts",
		"eval/f-fusion/samples.ts",
		"eval/f-fusion/run.ts",
		"eval/live-b1-f/run.ts",
		"eval/live-b1-f/protocol.ts",
		"eval/live-b1-f/cases.ts",
		"eval/live-b1-f/transport.ts",
	];
	const protocolHash = hash(
		sourceFiles.map((p) => readFileSync(join(root, p), "utf8")).join(""),
	);
	const config = {
		protocolVersion,
		protocolHash,
		sourceCommit: commitOf(root),
		sourceFiles,
		variants: ["F-improved", "Fusion"],
		developmentScenes: 12,
		newScenes: 4,
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
	const commandMeter: UsageMeter = {
		assertWithinLimit() {
			if (meter.spentUsd() >= limit) throw new Error("command budget reached");
			globalMeter.assertWithinLimit();
		},
		record(model, usage) {
			meter.record(model, usage);
			globalMeter.record(model, usage);
		},
		spentUsd: () => meter.spentUsd(),
	};
	const client = new Anthropic({
		maxRetries: 0,
		timeout: 60_000,
		fetch: async (input, init) => {
			const response = await factoringFetch(input, init);
			const body: unknown = await response
				.clone()
				.json()
				.catch(() => null);
			const reply = body as {
				model?: string;
				usage?: unknown;
				stop_reason?: string;
				content?: { type: string; text?: string }[];
				error?: { type?: string; message?: string };
			} | null;
			appendFileSync(
				join(out, "provider-traces.jsonl"),
				JSON.stringify({
					status: response.status,
					request:
						typeof init?.body === "string" ? JSON.parse(init.body) : null,
					model: reply?.model ?? null,
					usage: reply?.usage ?? null,
					stop: reply?.stop_reason ?? null,
					text:
						reply?.content
							?.filter((b) => b.type === "text")
							.map((b) => b.text)
							.join("") ?? null,
					error: reply?.error ?? null,
				}) + "\n",
			);
			return response;
		},
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
		const base = createClaudeLlm(role, commandMeter, client);
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
	const variantFailures: Record<Variant, number> = {
		"F-improved": 0,
		Fusion: 0,
	};
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
				(rep + index) % 2 === 0
					? ["F-improved", "Fusion"]
					: ["Fusion", "F-improved"];
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
						sampleFactory(variant),
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
							appendFileSync(
								join(out, "judge-traces.jsonl"),
								JSON.stringify({
									key,
									checkpoint: checkpoint.id,
									input: judgeData(one, [checkpoint]),
									answer,
								}) + "\n",
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
