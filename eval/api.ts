/** Explicit API preflight/smoke. Every billable call shares a durable session budget. */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { parseArgs } from "node:util";
import { createHash } from "node:crypto";
import { z } from "zod";
import { zodTextFormat } from "openai/helpers/zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { apiKeyFromEnvironment } from "../standalone/api-keys.ts";
import {
	createProviderLlm,
	createProviderReply,
} from "../standalone/providers.ts";
import { loadSettings, settingsDigest } from "../standalone/settings.ts";
import {
	maximumCallUsd,
	openApiMeter,
	type Provider,
} from "../standalone/usage.ts";
import {
	createAgencyRuntime,
	defaultBudget,
	LlmCallError,
	LlmOutputError,
	runRespond,
	agencyOutputContract,
} from "../src/index.ts";
import { judgeOutputSchema } from "./judge.ts";
import { stateJudgeOutputSchema } from "./state-judge.ts";

export async function main(args = process.argv.slice(2)) {
	const { values, positionals } = parseArgs({
		args,
		allowPositionals: true,
		options: {
			provider: { type: "string" },
			settings: { type: "string" },
			name: { type: "string" },
			"budget-usd": { type: "string" },
			ledger: { type: "string" },
		},
	});
	const command = positionals[0] ?? "preflight";
	if (!["preflight", "smoke"].includes(command))
		throw new Error("Use preflight or smoke");
	if (values.provider !== "anthropic" && values.provider !== "openai")
		throw new Error("Specify --provider anthropic|openai");
	const provider: Provider = values.provider;
	const settings = loadSettings(values.settings);
	const role = {
		...settings.llm.background,
		provider,
		model: provider === "anthropic" ? "claude-haiku-5-5" : "gpt-6-luna",
	};
	// API probe is intentionally restricted to the two models whose pricing envelope is known.
	for (const condition of ["B1", "B2", "F"] as const) {
		const options = { condition, interestFormation: condition === "F" };
		for (const schema of [
			agencyOutputContract("update", options).schema,
			agencyOutputContract("select", options).schema,
		]) {
			if (provider === "openai") zodTextFormat(schema, "agency_result");
			else zodOutputFormat(schema);
		}
	}
	const ready = {
		provider,
		model: role.model,
		keyConfigured: !!apiKeyFromEnvironment(provider),
		settingsDigest: settingsDigest(settings),
		maximumCallUsd: maximumCallUsd(provider, role.model, 16000),
		apiCalls: 0,
		priceVersion: "standard-global-2026-11-05",
	};
	if (command === "preflight") {
		console.log(JSON.stringify(ready));
		return 0;
	}
	const limit = Number(values["budget-usd"]);
	if (
		!Number.isFinite(limit) ||
		limit <= 0 ||
		!values.name ||
		!/^[a-zA-Z0-9_-]+$/.test(values.name)
	)
		throw new Error(
			"smoke requires --name <run> and an explicit positive --budget-usd",
		);
	if (!ready.keyConfigured)
		throw new Error(`Missing exported API key for ${provider}`);
	const out = resolve("data/api-validation", values.name);
	mkdirSync(out, { recursive: true });
	const meter = openApiMeter(
		resolve(values.ledger ?? join(out, "usage.jsonl")),
		limit,
	);
	const llm = createProviderLlm(role, meter);
	const results: Record<string, unknown>[] = [];
	const manifest = {
		...ready,
		role,
		limitUsd: limit,
		command: "smoke",
		startedAt: new Date().toISOString(),
		contractHash: createHash("sha256")
			.update(
				readFileSync(resolve(import.meta.dir, "../src/contracts/proposals.ts")),
			)
			.digest("hex"),
	};
	const manifestFile = join(out, `smoke-${provider}.json`);
	if (await Bun.file(manifestFile).exists())
		throw new Error("smoke result already exists; use a new run name");
	writeFileSync(
		manifestFile,
		JSON.stringify({ manifest, results, status: "running" }, null, 2),
	);
	try {
		for (const condition of ["B1", "B2", "F"] as const) {
			const rt = createAgencyRuntime({
				condition,
				systemContext: "experimental",
				llm,
				tools: [],
				selectWhenEmpty: true,
				budget: {
					...defaultBudget,
					minIntervalMs: 0,
					updateMaxOutputTokens: 2400,
				},
			});
			rt.observe({
				id: "u1",
				kind: "user.report",
				actor: "user",
				occurredAt: 0,
				text: "部屋の遮音を検討しているが、今は作業中。後で測定条件を一緒に整理したい。勝手に外部へ依頼はしないで。",
			});
			const r = await rt.decide(
				{
					id: "p1",
					at: 1000,
					trigger: "idle",
					presence: "quiet",
					foregroundBusy: false,
					playerBusy: false,
				},
				new AbortController().signal,
			);
			results.push({
				kind: "runtime",
				condition,
				decision: r.decision,
				calls: r.calls,
			});
			const failed = r.calls.find(
				(c) => c.code !== "applied" && c.code !== "no_change",
			);
			if (failed)
				throw new LlmOutputError(failed.code, failed.model ?? role.model);
		}
		for (const [kind, schema] of [
			["content-judge", judgeOutputSchema],
			["state-judge", stateJudgeOutputSchema],
		] as const) {
			const r = await llm.complete(
				{
					purpose: "respond",
					system:
						"与えられた資料だけを検証する。存在しない評価対象は作らず、空の結果を指定schemaで返す。",
					prompt: "評価対象は0件。",
					schema: schema as z.ZodType<unknown>,
					maxOutputTokens: 1200,
				},
				new AbortController().signal,
			);
			results.push({ kind, output: r.value, model: r.model });
		}
		const reply = await runRespond({
			chat: createProviderReply(role, meter),
			emotion: false,
			signal: new AbortController().signal,
			onDelta() {},
			messages: [
				{
					role: "system",
					content:
						"試験用の資料照会。lookupツールを一度使い、返った値だけを一文で答える。架空の結果を作らない。",
				},
				{ role: "user", content: "測定資料の値を照会して教えて。" },
			],
			tools: {
				tools: [
					{
						name: "lookup",
						description: "試験用の測定値を読む",
						parameters: {
							type: "object",
							properties: {},
							additionalProperties: false,
						},
					},
				],
				async call(c) {
					if (c.name !== "lookup") throw new Error("unexpected fixture tool");
					z.strictObject({}).parse(JSON.parse(c.arguments));
					return { content: "試験用測定値: 42 dB" };
				},
			},
		});
		if (reply.calls.length !== 1 || !reply.text.trim())
			throw new Error("reply fixture did not complete one tool round trip");
		results.push({ kind: "reply-tool-round-trip", reply });
		writeFileSync(
			manifestFile,
			JSON.stringify(
				{ manifest, results, status: "complete", usage: meter.summary() },
				null,
				2,
			),
		);
		console.log(
			JSON.stringify({
				file: manifestFile,
				status: "complete",
				usage: meter.summary(),
			}),
		);
		return 0;
	} catch (e) {
		const code =
			e instanceof LlmCallError || e instanceof LlmOutputError
				? e.reasonCode
				: e instanceof Error
					? e.name
					: "unknown";
		writeFileSync(
			manifestFile,
			JSON.stringify(
				{ manifest, results, status: "failed", code, usage: meter.summary() },
				null,
				2,
			),
		);
		console.error(
			JSON.stringify({
				file: manifestFile,
				status: "failed",
				code,
				usage: meter.summary(),
			}),
		);
		return 1;
	}
}
if (import.meta.main) process.exitCode = await main();
