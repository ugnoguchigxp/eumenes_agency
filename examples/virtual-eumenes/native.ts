/** Native model decisions through the existing virtual host; mock bundles only. */
import { createHash } from "node:crypto";
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import OpenAI from "openai";
import { createClaudeClient } from "../../standalone/claude.ts";
import { factoringFetch } from "../../standalone/schema.ts";
import { API_ADAPTER_VERSION } from "../../standalone/versions.ts";
import { actors, observationKinds, type LlmPort } from "../../src/index.ts";
import { apiKeyFromEnvironment } from "../../standalone/api-keys.ts";
import { createProviderLlm } from "../../standalone/providers.ts";
import {
	loadSettings,
	openSpendMeter,
	settingsDigest,
	judgeRole,
} from "../../standalone/settings.ts";
import { withCommandBudget } from "../../eval/budget.ts";
import { createTraceRecorder, describeError } from "../../eval/trace.ts";
import { judgeOutputSchema, judgeSystemPrompt } from "../../eval/judge.ts";
import { createVirtualScene } from "./scene.ts";
import { VIRTUAL_HOST_POLICY_VERSION } from "./host-context.ts";

const caseSchema = z.strictObject({
	id: z.string(),
	split: z.enum(["development", "validation"]),
	family: z.string(),
	needed: z.boolean(),
	expected: z.enum(["speak", "tool", "wait"]),
	observations: z.array(
		z.strictObject({
			actor: z.enum(actors),
			kind: z.enum(observationKinds),
			text: z.string(),
		}),
	),
	criteria: z.string(),
	mockSummary: z.string().nullable(),
	afterReturn: z.string().nullable(),
	returnCriteria: z.string().nullable(),
});
export const nativeCases = z
	.array(caseSchema)
	.parse(
		JSON.parse(readFileSync(join(import.meta.dir, "native-cases.json"), "utf8"))
			.cases,
	);
type NativeCase = z.infer<typeof caseSchema>;
const MIN = 60000;

export async function playNativeCase(c: NativeCase, llm: LlmPort) {
	const scene = createVirtualScene(llm, [
		{
			revisionId: "mock-reference@1",
			title: "記録と手元資料の確認",
			description:
				"以前の会話の記録、利用者が提示した手元の資料を読み、具体的な対象と問いに沿って確認する読み取り調査。mockのみ。外部の検索や実行はしない。",
			requiresApproval: false,
			subagent: {
				async run() {
					return {
						status: "succeeded",
						summary:
							c.mockSummary ?? "このmock資料には追加の情報はありません。",
					};
				},
			},
		},
	]);
	try {
		for (const [i, o] of c.observations.entries())
			scene.host.observe(
				{ ...o, id: `o${i + 1}`, occurredAt: i * 1000 },
				{ sources: [], complete: true },
			);
		const initial = await scene.host.decide(scene.opportunity("initial", MIN));
		const ticket = initial.decision.ticket;
		let handoff = null;
		let returned = null;
		let response = null;
		if (ticket?.action === "tool") {
			handoff = scene.chain.handoff(scene.host, ticket, MIN + 1);
			if (handoff.accepted) {
				returned = await scene.chain.finish(
					scene.host,
					handoff.workRef,
					2 * MIN,
				);
				if (returned.accepted && c.afterReturn) {
					scene.host.observe({
						id: "return-question",
						kind: "exchange.adopted",
						actor: "user",
						occurredAt: 2 * MIN + 1,
						text: c.afterReturn,
					});
					response = await scene.host.decide(
						scene.opportunity("response", 3 * MIN),
					);
					if (response.decision.ticket?.action === "speak")
						scene.host.recordResult({
							ticketId: response.decision.ticket.id,
							at: 3 * MIN + 1,
							status: "succeeded",
							resultText: response.decision.utterance ?? "",
						});
				}
			}
		} else if (ticket?.action === "speak")
			scene.host.recordResult({
				ticketId: ticket.id,
				at: MIN + 1,
				status: "succeeded",
				resultText: initial.decision.utterance ?? "",
			});
		return {
			initial,
			handoff,
			returned,
			response,
			events: scene.chain.events,
			snapshot: scene.host.snapshot(),
		};
	} finally {
		scene.close();
	}
}

const sha = (bytes: string | Buffer) =>
	createHash("sha256").update(bytes).digest("hex");
function sourceFiles() {
	const result: Record<string, string> = {};
	for (const dir of ["src", "standalone", "eval", "examples/virtual-eumenes"]) {
		for (const name of new Bun.Glob("**/*").scanSync({
			cwd: dir,
			onlyFiles: true,
		})) {
			if (
				!/\.(ts|json|toml)$/.test(name) ||
				name.includes("results/") ||
				name.includes("cases/") ||
				name.includes("vendor/")
			)
				continue;
			const path = `${dir}/${name}`;
			result[path] = sha(readFileSync(path));
		}
	}
	return result;
}

async function main() {
	const [mode, name, split, judgeTag] = process.argv.slice(2);
	if (
		!["generate", "judge"].includes(mode ?? "") ||
		!name ||
		!/^[a-zA-Z0-9_-]+$/.test(name) ||
		!["development", "validation"].includes(split ?? "") ||
		(judgeTag !== undefined &&
			(mode !== "judge" || !/^[a-zA-Z0-9_-]+$/.test(judgeTag))) ||
		!["9", "10"].includes(process.env.AGENCY_API_LIMIT_USD ?? "") ||
		resolve(process.env.AGENCY_API_LEDGER ?? "") !==
			resolve("data/api-validation/improvement-20261105/usage.jsonl")
	)
		throw Error(
			"generate|judge, new run name, split and existing cumulative authorized ledger required",
		);
	const settings = loadSettings();
	if (!existsSync("data/api-validation/improvement-20261105/usage.jsonl"))
		throw Error(
			"existing cumulative ledger is missing; refusing to create a fresh budget",
		);
	const role = mode === "judge" ? judgeRole(settings) : settings.llm.background;
	const provider = role.provider ?? "anthropic";
	if (!apiKeyFromEnvironment(provider))
		throw Error("exported key missing: no request attempted");
	const meter = openSpendMeter(settings);
	const localSpent = meter.localSpentUsd;
	if (!localSpent) throw Error("per-command accounting required");
	const sdkTimeoutMs = Number(process.env.AGENCY_NATIVE_TIMEOUT_MS ?? 60000);
	if (![60000, 180000].includes(sdkTimeoutMs))
		throw Error("invalid SDK timeout profile");
	const client =
		sdkTimeoutMs === 60000
			? undefined
			: provider === "openai"
				? new OpenAI({
						apiKey: apiKeyFromEnvironment("openai"),
						maxRetries: 0,
						timeout: sdkTimeoutMs,
					})
				: createClaudeClient({
						maxRetries: 0,
						timeout: sdkTimeoutMs,
						fetch: factoringFetch,
					});
	const output = resolve("artifacts/native-conversation-2026-11-06", name);
	const cases = nativeCases.filter((c) => c.split === split);
	const recorder = createTraceRecorder(
		withCommandBudget(createProviderLlm(role, meter, client), localSpent, 0.22),
		join(
			output,
			mode === "generate"
				? "traces.jsonl"
				: `judge-traces${judgeTag ? "-" + judgeTag : ""}.jsonl`,
		),
		name,
	);
	if (mode === "generate") {
		if (existsSync(output)) throw Error("run already exists");
		mkdirSync(output, { recursive: true });
		const files = sourceFiles();
		writeFileSync(
			join(output, "manifest.json"),
			JSON.stringify(
				{
					scope:
						"Native decisions; fixed Eumenes F instructions, real Memory, mock toolchain/bundle/subagent only. Synthetic labels, one repetition. Foreground reply quality and production integration are excluded.",
					provider,
					apiAdapterVersion: API_ADAPTER_VERSION,
					sdkTimeoutMs,
					cumulativePolicyUsd: Number(process.env.AGENCY_API_LIMIT_USD),
					runtimeProfile: {
						condition: "F",
						conversationParticipation: true,
						planOnOpportunity: true,
						repairUpdates: true,
						constrainToolNames: true,
						findings: true,
						interestFormation: true,
						hostTopics: true,
						hostTodos: true,
						updateMaxOutputTokens: 2400,
						selectMaxOutputTokens: 1000,
						minIntervalMs: 0,
					},
					hostPolicyVersion: VIRTUAL_HOST_POLICY_VERSION,
					role: settings.llm.background,
					settingsDigest: settingsDigest(settings),
					files,
					caseHash: files["examples/virtual-eumenes/native-cases.json"],
					cases: cases.map((c) => c.id),
					ownKnownCapUsd: 0.22,
				},
				null,
				2,
			) + "\n",
		);
		for (const [i, c] of cases.entries()) {
			meter.assertWithinLimit();
			recorder.begin({ caseId: c.id, condition: "F", rep: 1 });
			try {
				const result = await playNativeCase(c, recorder.llm);
				recorder.final(result.snapshot.state);
				appendFileSync(
					join(output, "runs.jsonl"),
					JSON.stringify({ caseId: c.id, ...result }) + "\n",
				);
				const infra = [
					...result.initial.calls,
					...(result.response?.calls ?? []),
				].some((x) => x.code.startsWith("llm_call:"));
				console.log(
					JSON.stringify({
						index: i + 1,
						total: cases.length,
						caseId: c.id,
						action: result.initial.decision.action,
						source: result.initial.decision.source,
						returnAction: result.response?.decision.action,
						infra,
						ownKnownUsd: localSpent(),
					}),
				);
				if (infra) {
					process.exitCode = 1;
					break;
				}
			} catch (error) {
				appendFileSync(
					join(output, "runs.jsonl"),
					JSON.stringify({ caseId: c.id, error: describeError(error) }) + "\n",
				);
				throw error;
			}
		}
	} else {
		const suffix = judgeTag ? "-" + judgeTag : "";
		const manifest = JSON.parse(
			readFileSync(join(output, "manifest.json"), "utf8"),
		);
		if (manifest.provider === provider)
			throw Error("judge must be the other provider");
		if (
			manifest.caseHash !==
			sha(readFileSync(join(import.meta.dir, "native-cases.json")))
		)
			throw Error("cases changed");
		if (existsSync(join(output, `judgments${suffix}.jsonl`)))
			throw Error("judge run already exists");
		writeFileSync(
			join(output, `judge-manifest${suffix}.json`),
			JSON.stringify(
				{
					provider,
					role,
					roleSource: "llm.judge via shared judgeRole(settings)",
					system: judgeSystemPrompt,
					criteria: [
						"場面ごとの基準を満たす",
						"根拠にない事実・成功・好みを足さず、撤回や解決を尊重する",
						"自然な完成した一言または具体的な実行可能な依頼である",
					],
					generationIdentityHidden: true,
				},
				null,
				2,
			) + "\n",
		);
		const lines = readFileSync(join(output, "runs.jsonl"), "utf8")
			.trim()
			.split("\n")
			.map((x) => JSON.parse(x));
		for (const row of lines) {
			const c = cases.find((c) => c.id === row.caseId);
			if (!c || row.error) throw Error("unknown or failed generation case");
			for (const [phase, step, criteria] of [
				["initial", row.initial, c.criteria],
				["response", row.response, c.returnCriteria],
			] as const) {
				if (!step || !["speak", "tool"].includes(step.decision.action))
					continue;
				recorder.begin({ caseId: `${c.id}-${phase}`, condition: "F", rep: 1 });
				const observations = row.snapshot.observations.filter(
					(o: { occurredAt: number }) =>
						o.occurredAt < (phase === "initial" ? MIN : 3 * MIN),
				);
				const judged = await recorder.llm.complete(
					{
						purpose: "select",
						system: judgeSystemPrompt,
						prompt: JSON.stringify({
							facts: observations.map(
								(o: { id: string; actor: string; text: string }) => ({
									id: o.id,
									actor: o.actor,
									text: o.text,
								}),
							),
							action: {
								action: step.decision.action,
								utterance: step.decision.utterance,
								toolName: step.decision.toolName,
								toolInput: step.decision.toolInput,
							},
							criteria: [
								criteria,
								"根拠にない事実・成功・好みを足さず、撤回や解決を尊重する",
								"自然な完成した短い発話または具体的な実行可能な依頼である",
							],
						}),
						schema: judgeOutputSchema,
						maxOutputTokens: 1500,
					},
					new AbortController().signal,
				);
				const verdicts = judged.value.verdicts;
				if (
					verdicts.length !== 3 ||
					new Set(verdicts.map((v) => v.criterion)).size !== 3 ||
					verdicts.some((v) => v.criterion < 1 || v.criterion > 3)
				)
					throw Error("incomplete judge criteria");
				appendFileSync(
					join(output, `judgments${suffix}.jsonl`),
					JSON.stringify({ caseId: c.id, phase, ...judged.value }) + "\n",
				);
				console.log(
					JSON.stringify({
						caseId: c.id,
						phase,
						verdicts: verdicts.map((v) => v.verdict),
						ownKnownUsd: localSpent(),
					}),
				);
			}
		}
	}
}
if (import.meta.main) await main();
