/** Live, background update/select only. All observations are fixtures. No action ticket is executed. */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { createTraceRecorder } from "../trace.ts";
import { createResearchFixture } from "./research.ts";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import {
	createAgencyRuntime,
	defaultBudget,
	LlmCallError,
	LlmOutputError,
	type LlmPort,
	type LlmRequest,
	type SelectSystemContextInput,
	type UpdateSystemContextInput,
} from "../../src/index.ts";
import { runTrials } from "./trials.ts";
import { scenes, opportunityAt, type Scene } from "./cases.ts";
import { createProviderLlm } from "../../standalone/providers.ts";
import {
	loadSettings,
	openSpendMeter,
	settingsDigest,
} from "../../standalone/settings.ts";

const { values } = parseArgs({
	options: {
		model: { type: "string", default: "gpt-6-luna" },
		transport: { type: "string", default: "codex-cli" },
		case: { type: "string", multiple: true },
		trace: { type: "string" },
		reps: { type: "string", default: "1" },
		eumenes: {
			type: "string",
			default: resolve(import.meta.dir, "../../../eumenes"),
		},
	},
});
const model = values.model;
if (values.transport !== "api" && values.transport !== "codex-cli")
	throw new Error("--transport api|codex-cli");
if (
	values.transport === "api" &&
	(!process.env.AGENCY_API_LEDGER || !process.env.AGENCY_API_LIMIT_USD)
)
	throw new Error(
		"API initiative requires an explicit shared ledger and limit",
	);
const reps = Number(values.reps);
const selected = scenes.filter(
	(s) => values.case === undefined || values.case.includes(s.id),
);
if (
	!model.trim() ||
	!Number.isSafeInteger(reps) ||
	reps < 1 ||
	reps > 10 ||
	!selected.length ||
	values.case?.some((id) => !selected.some((s) => s.id === id))
)
	throw new Error(
		"Specify a model, 1–10 repetitions and a known case: " +
			scenes.map((s) => s.id).join(", "),
	);

// Use the host's actual instructions, schema transport and isolated Codex login. The runtime under test is local src/.
const host = resolve(values.eumenes);
const { createCloudAgents } = await import(
	resolve(host, "api/domains/inference/adapters/cloud-agents.ts")
);
const { agencyBackgroundSystem } = await import(
	resolve(host, "api/application/agency/system-context.ts")
);
const { shareNullableSchemas } = await import(
	resolve(host, "api/application/agency/schema.ts")
);
const agent = createCloudAgents(process.env);
const research = await createResearchFixture(host, opportunityAt);
const persona = { agentName: "ユリ", userName: "", persona: "butler" };
const system = (
	purpose: "update" | "select",
	input: UpdateSystemContextInput | SelectSystemContextInput,
): string => agencyBackgroundSystem(purpose, input, persona, false);

const codexLlm: LlmPort = {
	async complete<T>(request: LlmRequest<T>, signal: AbortSignal) {
		const start = performance.now();
		const result = await agent.run({
			kind: "codex-sdk",
			model,
			credential: null,
			baseUrl: "",
			reasoningEffort: "low",
			messages: [
				{ role: "system", content: request.system },
				{ role: "user", content: request.prompt },
			],
			outputSchema: shareNullableSchemas(z.toJSONSchema(request.schema)),
			signal,
		});
		if (result.usageModel !== model)
			throw new LlmCallError("model_not_confirmed", false);
		if (result.inputTokens == null || result.outputTokens == null)
			throw new LlmCallError("missing_usage", false);
		const usage = {
			inputTokens: result.inputTokens,
			outputTokens: result.outputTokens,
		};
		let parsed: unknown;
		try {
			parsed = JSON.parse(result.text);
		} catch {
			throw new LlmOutputError("parse", model, usage);
		}
		const value = request.schema.safeParse(parsed);
		if (!value.success) throw new LlmOutputError("schema", model, usage);
		return {
			value: value.data,
			model,
			...usage,
			cacheReadTokens: result.cacheReadTokens ?? 0,
			latencyMs: performance.now() - start,
		};
	},
};

const settings = values.transport === "api" ? loadSettings() : null;
const llm = settings
	? createProviderLlm(
			{ ...settings.llm.background, model },
			openSpendMeter(settings),
		)
	: codexLlm;
console.error(
	JSON.stringify({
		transport: values.transport,
		model,
		settingsDigest: settings ? settingsDigest(settings) : null,
		hostIntegration: true,
		executed: false,
	}),
);

const tracePath =
	values.trace ??
	resolve(mkdtempSync(resolve(tmpdir(), "agency-initiative-")), "traces.jsonl");
console.error("Synthetic call traces:", tracePath);
const trace = createTraceRecorder(llm, tracePath, "initiative");
async function evaluate(s: Scene, rep: number) {
	trace.begin({ caseId: s.id, condition: "F", rep });
	const runtime = createAgencyRuntime({
		llm: trace.llm,
		tools: research.tools,
		condition: "F",
		planOnOpportunity: true,
		repairUpdates: true,
		constrainToolNames: true,
		findings: true,
		interestFormation: true,
		hostTopics: true,
		hostTodos: true,
		standingInterests: [
			{
				id: "persona-1",
				text: "小型望遠鏡の光学設計。携帯型の新しい方式には調べたい点が残っている。",
			},
		],
		systemContext: {
			update: (i) => system("update", i),
			select: (i) => system("select", i),
		},
		budget: {
			...defaultBudget,
			updateMaxOutputTokens: 2400,
			selectMaxOutputTokens: 1000,
		},
		...(s.history ? { restore: s.history() } : {}),
	});
	s.dialogue.forEach(([actor, text], i) =>
		runtime.observe({
			id: "m" + i,
			kind: "exchange.adopted",
			actor,
			text,
			occurredAt: opportunityAt - 60000 + i * 1000,
		}),
	);
	if (s.event)
		runtime.observe({
			id: "proof-sheet",
			actor: "host",
			kind: "external.event",
			occurredAt: opportunityAt - 10000,
			text: s.event,
		});
	const { decision, calls } = await runtime.decide(
		{
			id: "gap",
			at: opportunityAt,
			trigger: "idle",
			presence: "quiet",
			foregroundBusy: false,
			playerBusy: false,
			speechAllowed: true,
		},
		AbortSignal.timeout(180_000),
	);
	trace.final(runtime.snapshot().state);
	let admission: "accepted" | "rejected" | null = null;
	let admissionError: string | null = null;
	if (decision.ticket?.action === "tool") {
		try {
			research.admit(decision.ticket, runtime, s.id + "-" + rep);
			admission = "accepted";
		} catch (error) {
			admission = "rejected";
			admissionError = error instanceof Error ? error.message : String(error);
		}
	}
	const valid =
		decision.source === "llm" || decision.source === "host_no_candidates";
	const match = s.expected.some((action) => decision.action === action);
	const outcome =
		decision.source === "error"
			? "model_error"
			: !valid
				? "decision_rejected"
				: admission === "rejected"
					? "dispatch_rejected"
					: !match
						? "behavior_mismatch"
						: "passed";
	return {
		model,
		expected: s.expected,
		outcome,
		decision,
		calls,
		admission,
		admissionError,
		executed: false,
	};
}
try {
	const totals = await runTrials(selected, reps, evaluate, (result) =>
		console.log(JSON.stringify(result)),
	);
	console.error(JSON.stringify({ ...totals, tracePath }));
	if (totals.failed) process.exitCode = 1;
} finally {
	research.close();
}
