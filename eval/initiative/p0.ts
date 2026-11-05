/**
 * P0 fixed baseline: the Agency distribution Eumenes installs, on the host's own composition, with fixed
 * synthetic responses at the inference boundary. No model, provider, network, speech or product store.
 *
 *   bun eval/initiative/p0.ts record    --out <dir>                 fixed baseline (writes manifest first)
 *   bun eval/initiative/p0.ts replay    --from <dir> --out <dir> [--tamper <kind>]
 *   bun eval/initiative/p0.ts faults    --out <dir>                 injected exception / failure / stop
 *   bun eval/initiative/p0.ts aggregate --run <dir>                 regenerate the aggregate from raw JSONL
 */
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
	canonical,
	compositionIdentity,
	digest,
	environmentIdentity,
	gitIdentity,
	loadAdjacentSource,
	loadDistribution,
	loadHostComposition,
	sha256,
	treeDigest,
} from "./baseline.ts";
import {
	createFixtureInference,
	TRANSPORT_IDENTITIES,
	type CassetteEntry,
	type FixtureInference,
	type FixtureResponse,
} from "./cassette.ts";
import {
	baselineCases,
	faultCases,
	SYNTHETIC_CONVERSATION,
	type P0Case,
	type P0Step,
	type StepExpectation,
} from "./p0-cases.ts";
import {
	aggregate,
	checkPair,
	compareRecords,
	parseJsonl,
	trialId,
	trialRecordSchema,
	validateRecords,
	type PairDeclaration,
	type TrialRecord,
} from "./record.ts";
import { createResearchFixture } from "./research.ts";
import { runTrials } from "./trials.ts";
import { virtualClock } from "../virtual-clock.ts";

/** Synthetic host settings: no product settings are read. */
export const fixtureSettings = {
	agency: {
		emotion: false,
		interests: [
			"小型望遠鏡の光学設計。携帯型の新しい方式には調べたい点が残っている。",
		],
	},
	persona: { agentName: "ユリ", userName: "", persona: "butler" },
} as const;
const approvalTool = {
	name: "publish_note",
	requiresApproval: true,
	description: "合成: 公開メモを投稿する（利用者の明示承認が必要）",
};

export const tampers = [
	"system",
	"options",
	"prefix",
	"drop-entry",
	"extra-entry",
	"response",
	"corrupt-response",
	"identity",
	"prefix-content",
	"session",
] as const;
/** Tampers aimed at the conversation-prefix case by default; the others at the first planned trial. */
export const prefixTampers: readonly Tamper[] = ["prefix-content", "session"];
export type Tamper = (typeof tampers)[number];

export interface RunConfig {
	readonly host: string;
	readonly agencyRepo: string;
	readonly out: string;
	readonly runId: string;
	readonly variant: string;
	readonly mode: "record" | "replay";
	readonly cases: readonly P0Case[];
	readonly reps: number;
	readonly replay?: {
		readonly from: string;
		readonly entries: readonly CassetteEntry[];
		readonly manifest: Record<string, unknown>;
	};
	readonly tamper?: { readonly kind: Tamper; readonly trialId: string };
	readonly injectStopAfter?: string;
	readonly maxAttempts: number;
	/** The Agency under test: the installed distribution (default, the baseline) or the adjacent src lane. */
	readonly agency?: "distribution" | "adjacent-src";
	readonly argv: readonly string[];
	readonly preregistration?: string;
}

export const plannedTrials = (cases: readonly P0Case[], reps: number) => {
	const ids: string[] = [];
	for (let rep = 1; rep <= reps; rep++)
		for (const c of cases)
			for (const s of c.steps) ids.push(trialId(c.id, rep, s.id));
	return ids;
};

/** Everything a fixed comparison must hold equal, written before the first trial. */
const loadDistributionManifest = async (host: string) =>
	JSON.parse(
		readFileSync(resolve(host, "vendor/agency/manifest.json"), "utf8"),
	) as Record<string, unknown>;

export async function buildManifest(
	cfg: RunConfig,
	dist: { module: Record<string, any>; codeDir: string; identity: object },
	tools: unknown,
) {
	const adjacent = cfg.agency === "adjacent-src";
	const wake = join(
		dist.codeDir,
		adjacent ? "domains/agency/wake.ts" : "domains/agency/wake.js",
	);
	const activity = join(
		dist.codeDir,
		adjacent
			? "application/activity-budget.ts"
			: "application/activity-budget.js",
	);
	const scripts = cfg.cases.map((c) => ({
		id: c.id,
		steps: c.steps.map((s) => ({ id: s.id, script: s.script })),
	}));
	const inputs = cfg.cases.map((c) => ({
		id: c.id,
		split: c.split,
		label: c.label,
		history: c.history ? digest(c.history()) : null,
		steps: c.steps.map(({ script: _s, expect: _e, ...rest }) => rest),
	}));
	return {
		schema: "agency-p0-manifest.v2",
		runId: cfg.runId,
		createdAt: new Date().toISOString(),
		command: ["bun", "eval/initiative/p0.ts", ...cfg.argv],
		lane: "fixture",
		mode: cfg.mode,
		variant: cfg.variant,
		replayOf: cfg.replay
			? {
					runId: cfg.replay.manifest.runId,
					cassetteDigest: digest(cfg.replay.entries),
				}
			: null,
		tamper: cfg.tamper ?? null,
		identity: {
			host: gitIdentity(cfg.host),
			agency: gitIdentity(cfg.agencyRepo),
			distribution: dist.identity,
			environment: environmentIdentity(),
		},
		fixed: {
			composition: compositionIdentity(cfg.host),
			settings: { digest: digest(fixtureSettings), value: fixtureSettings },
			capabilityCatalog: { digest: digest(tools), value: tools, approvalTool },
			budget: {
				defaultBudget: dist.module.defaultBudget,
				hostOverride: {
					updateMaxOutputTokens: 2400,
					selectMaxOutputTokens: 1000,
				},
				source: "api/application/agency/runtime.ts",
			},
			limits: {
				digest: digest(dist.module.defaultLimits),
				value: dist.module.defaultLimits,
			},
			wakeConfig: {
				value:
					dist.module.defaultWakeConfig ?? "not exported: file digest only",
				file: relative(dist.codeDir, wake),
				digest: sha256(readFileSync(wake)),
			},
			activityLimits: {
				value:
					dist.module.defaultActivityLimits ?? "not exported: file digest only",
				file: relative(dist.codeDir, activity),
				digest: sha256(readFileSync(activity)),
			},
			cases: {
				digest: digest(inputs),
				ids: cfg.cases.map((c) => c.id),
				splits: [...new Set(cfg.cases.map((c) => c.split))],
			},
			labels: digest(
				cfg.cases.map((c) => [c.id, c.label, c.steps.map((s) => s.expect)]),
			),
			responses: { digest: digest(scripts), kind: "fixed synthetic scripts" },
			clock: {
				kind: "virtual",
				steps: digest(cfg.cases.map((c) => c.steps.map((s) => s.at))),
			},
			seed: {
				value: null,
				note: "no randomness in inputs; transport ids carry a per-process boot id",
			},
			reps: cfg.reps,
			order: "rep-major, cases in listed order, steps in order",
			conversationPrefix: {
				default:
					"none: task() returns null for cases without conversationPrefix",
				synthetic: {
					cases: cfg.cases
						.filter((c) => c.conversationPrefix === "synthetic")
						.map((c) => c.id),
					data: digest(SYNTHETIC_CONVERSATION),
					dataBuilder:
						"synthetic ConversationPrefix and ## State (product backgroundPrefixInTransaction / stateLinesInTransaction not used: they read the conversation store)",
					assembly:
						"product taskMessages + backgroundMessage (api/domains/dialogue/service/conversation-input.ts)",
					finalPath:
						"product createAgencyLlmPort (drops prefix system messages, onConversation session, agentSession)",
				},
			},
			model: {
				requested: null,
				note: "no model; fixture inference serves scripted responses",
			},
			transportIdentities: TRANSPORT_IDENTITIES,
			stop: {
				maxAttempts: cfg.maxAttempts,
				attemptCap:
					"served attempts over the run; checked at the inference boundary before each physical attempt and before each case",
				providerCalls: 0,
				outwardEffects: 0,
				versionChange: true,
			},
			retries:
				"no re-draw; core transient retries are recorded as separate attempts",
			preregistration:
				cfg.preregistration && existsSync(cfg.preregistration)
					? {
							path: cfg.preregistration,
							digest: sha256(readFileSync(cfg.preregistration)),
						}
					: null,
		},
		plan: { trials: plannedTrials(cfg.cases, cfg.reps) },
		semantics: {
			fixtureResponses:
				"scripted: not a model judgement; not semantically scorable",
			holdout:
				"not_run: Q01–Q08 unseen set (16) needs an evaluator designated by the user",
			live: "not_permitted in P0",
		},
	};
}

type Effects = TrialRecord["effects"];
const zeroEffects = (): Effects => ({
	ticketsIssued: 0,
	reservations: 0,
	fixtureDelegationsStarted: 0,
	fixtureWorkRows: 0,
	speech: 0,
	notifications: 0,
	productWrites: 0,
	actionReceipts: 0,
	observeEffects: 0,
	outboundNetwork: 0,
	controlReceiptsAccepted: 0,
	controlReceiptsRejected: 0,
});

function blankRecord(
	cfg: RunConfig,
	manifestDigest: string,
	c: P0Case,
	rep: number,
	step: P0Step,
	outcome: "runner_error" | "incomplete",
	basis: string,
): TrialRecord {
	return {
		schema: "agency-p0-trial.v2",
		runId: cfg.runId,
		trialId: trialId(c.id, rep, step.id),
		caseId: c.id,
		rep,
		step: step.id,
		split: c.split,
		lane: "fixture",
		variant: cfg.variant,
		digests: {
			manifest: manifestDigest,
			input: stepInputDigest(c, step),
			requests: [],
			responses: [],
			finalSnapshot: null,
		},
		proposal: {
			action: null,
			candidateRef: null,
			evidenceRefs: [],
			reason: null,
			valueNow: null,
			lossIfWait: null,
			nullReason: basis,
		},
		core: {
			eligibleAction: null,
			decisionAction: null,
			source: null,
			rejectCodes: [],
			blockCodes: [],
			wakeReasons: [],
			ticketId: null,
			candidateId: null,
		},
		hostAdmission: {
			status: "not_checked",
			gate: null,
			at: null,
			basis: null,
			code: null,
		},
		suppression: { status: "not_applicable", reason: null, source: "none" },
		effects: zeroEffects(),
		measurement: {
			calls: [],
			logicalCalls: 0,
			attempts: 0,
			refusedAttempts: 0,
			refusals: [],
			providerCalls: 0,
			attemptUsage: [],
			zeroFilledUsage: 0,
			clock: [],
			wallMs: 0,
			cost: { amount: 0, basis: "not run" },
			missing: ["not_run"],
		},
		result: {
			outcome,
			basis,
			recordComplete: true,
			scorable: false,
			expectedRejection: null,
			mismatches: [],
		},
		label: c.label
			? { ...c.label, allowedActions: [...c.label.allowedActions] }
			: null,
	};
}

const stepInputDigest = (c: P0Case, step: P0Step) => {
	const { script: _s, expect: _e, ...input } = step;
	return digest({
		case: c.id,
		split: c.split,
		history: c.history ? digest(c.history()) : null,
		step: input,
		settings: fixtureSettings,
		extraTools: c.extraTools ?? null,
		conversationPrefix: c.conversationPrefix
			? digest(SYNTHETIC_CONVERSATION)
			: null,
	});
};

/** Unmet pre-declared conditions of one step; an empty list is a pass. */
export function unmet(
	e: StepExpectation,
	o: {
		ticket: string | null;
		source: string | null;
		rejectCodes: readonly string[];
		admission: string;
		admissionCode: string | null;
		calls: { purpose: string; code: string }[];
		attempts: number;
		accepted: number;
		rejected: number;
		notes: readonly string[];
		reasons?: readonly string[];
	},
) {
	const out: string[] = [];
	for (const r of e.reasons ?? [])
		if (!(o.reasons ?? []).includes(r)) out.push(`wakeReason:${r}`);
	if (o.ticket !== e.ticket) out.push(`ticket:${o.ticket ?? "none"}`);
	if (e.sources && !e.sources.includes(o.source ?? "none"))
		out.push(`source:${o.source ?? "none"}`);
	for (const code of e.rejectCodes ?? [])
		if (!o.rejectCodes.includes(code)) out.push(`rejectCode:${code}`);
	if (e.hostAdmission && o.admission !== e.hostAdmission)
		out.push(`hostAdmission:${o.admission}`);
	if (e.hostCode && o.admissionCode !== e.hostCode)
		out.push(`hostCode:${o.admissionCode ?? "none"}`);
	const made = (p: string) =>
		o.calls.filter((c) => c.purpose === p && !c.code.startsWith("skipped"))
			.length;
	if (e.maxCalls?.update !== undefined && made("update") > e.maxCalls.update)
		out.push(`updateCalls:${made("update")}`);
	if (e.maxCalls?.select !== undefined && made("select") > e.maxCalls.select)
		out.push(`selectCalls:${made("select")}`);
	if (e.attempts !== undefined && o.attempts !== e.attempts)
		out.push(`attempts:${o.attempts}`);
	if (e.acceptedReceipts !== undefined && o.accepted !== e.acceptedReceipts)
		out.push(`acceptedReceipts:${o.accepted}`);
	if (e.minRejectedReceipts !== undefined && o.rejected < e.minRejectedReceipts)
		out.push(`rejectedReceipts:${o.rejected}`);
	if (o.notes.includes("expected_conflict_not_raised"))
		out.push("observationConflict:not_raised");
	if (o.notes.includes("restart_snapshot_changed"))
		out.push("restart:snapshot_changed");
	return out;
}

const parseSelect = (entries: readonly CassetteEntry[]) => {
	const served = entries
		.filter((e) => e.purpose === "select" && e.response.kind === "value")
		.at(-1);
	if (!served || served.response.kind !== "value") return null;
	try {
		return JSON.parse(served.response.text) as Record<string, unknown>;
	} catch {
		return { unparseable: true };
	}
};

export async function runP0(cfg: RunConfig) {
	mkdirSync(cfg.out, { recursive: true });
	const files = {
		manifest: join(cfg.out, "manifest.json"),
		trials: join(cfg.out, "trials.jsonl"),
		cassette: join(cfg.out, "cassette.jsonl"),
		requests: join(cfg.out, "requests.jsonl"),
		aggregate: join(cfg.out, "aggregate.json"),
		log: join(cfg.out, "run-log.json"),
	};
	for (const f of [files.trials, files.cassette, files.requests])
		if (existsSync(f))
			throw new Error(`refusing to append to an existing run: ${f}`);

	const dist =
		cfg.agency === "adjacent-src"
			? await loadAdjacentSource(
					cfg.agencyRepo,
					String((await loadDistributionManifest(cfg.host)).gitSha),
				)
			: await loadDistribution(cfg.host);
	const comp = await loadHostComposition(cfg.host, dist.module);
	dist.identity.checks.hostImportIsLoadedModule = comp.hostImportIsLoadedModule;
	if (Object.values(dist.identity.checks).some((ok) => !ok))
		throw new Error(
			`agency identity checks failed: ${JSON.stringify(dist.identity.checks)}`,
		);
	// Product assembly of a background call's conversation input, reused on synthetic data only.
	const conversationInput = await import(
		resolve(cfg.host, "api/domains/dialogue/service/conversation-input.ts")
	);
	const opp = baselineCases[0]?.steps[0]?.at ?? 0;
	const research = await createResearchFixture(cfg.host, opp);
	const tools = research.tools;
	const dataDir = resolve(cfg.host, "data");
	const dataBefore = existsSync(dataDir);
	const manifest = await buildManifest(cfg, dist, tools);
	writeFileSync(files.manifest, JSON.stringify(manifest, null, "\t") + "\n");
	const manifestDigest = digest(manifest);
	const planned = manifest.plan.trials;

	const realFetch = globalThis.fetch;
	let outbound = 0;
	globalThis.fetch = (async () => {
		outbound++;
		throw new Error("p0_outbound_network_blocked");
	}) as unknown as typeof fetch;

	const boot = crypto.randomUUID().slice(0, 8);
	let scopeCounter = 0;
	let clock = virtualClock(opp);
	const inference: FixtureInference = createFixtureInference(
		() => clock.now(),
		{
			maxAttempts: cfg.maxAttempts,
		},
	);
	const entriesByTrial = new Map<string, CassetteEntry[]>();
	for (const e of cfg.replay?.entries ?? []) {
		const list = entriesByTrial.get(e.trialId) ?? [];
		list.push(e);
		entriesByTrial.set(e.trialId, list);
	}
	if (cfg.tamper) {
		const list = [...(entriesByTrial.get(cfg.tamper.trialId) ?? [])];
		if (cfg.tamper.kind === "drop-entry") list.pop();
		if (cfg.tamper.kind === "extra-entry" && list.length)
			list.push({ ...list.at(-1)!, seq: list.length });
		if (
			cfg.tamper.kind === "response" ||
			cfg.tamper.kind === "corrupt-response"
		) {
			const i = list.map((e) => e.purpose).lastIndexOf("select");
			const changed = (response: FixtureResponse) => ({
				...list[i]!,
				response,
				// "response": a deliberate, checksummed change; "corrupt-response": the text changed, digest stale.
				responseDigest:
					cfg.tamper?.kind === "response"
						? digest(response)
						: list[i]!.responseDigest,
			});
			if (i >= 0)
				list[i] = changed({
					kind: "value",
					text: JSON.stringify({
						action: "wait",
						candidateRef: null,
						utterance: null,
						toolName: null,
						toolInput: null,
						evidenceRefs: [],
						valueNow: "改変",
						userBurden: "改変",
						lossIfWait: "改変",
						conflicts: null,
						reason: "故意に改変した応答",
					}),
				});
		}
		if (cfg.tamper.kind === "identity" && list.length > 1)
			list[1] = {
				...list[1]!,
				identity: {
					...list[1]!.identity,
					decisionId: list[0]!.identity.decisionId,
				},
			};
		entriesByTrial.set(cfg.tamper.trialId, list);
	}

	let outwardTotal = 0;
	let stopAfterHit = false;
	const allMismatches: unknown[] = [];
	const started = performance.now();
	const distDigestAtStart = dist.identity.distDigest;
	const compositionAtStart = manifest.fixed.composition.filesDigest;

	const write = (r: TrialRecord) => {
		const parsed = trialRecordSchema.parse(r);
		appendFileSync(files.trials, JSON.stringify(parsed) + "\n");
	};

	const compose = (c: P0Case, trial: string, restore?: unknown) => {
		const conversationId = `p0-${c.id}-${trial.split("/")[1]}`;
		const scope = `${boot}-${++scopeCounter}`;
		let n = 0;
		const tamperHere =
			cfg.tamper &&
			trial.startsWith(cfg.tamper.trialId.split("/").slice(0, 2).join("/"));
		const tamperKind = tamperHere ? cfg.tamper?.kind : undefined;
		const prefixed = c.conversationPrefix === "synthetic";
		const syntheticTask = (_id: string, task: string) => {
			const prefix = structuredClone(SYNTHETIC_CONVERSATION.prefix) as any;
			if (tamperKind === "prefix-content")
				prefix.messages[3].content += "（改変）";
			return {
				messages: conversationInput
					.taskMessages(prefix, [SYNTHETIC_CONVERSATION.state], task)
					.map(conversationInput.backgroundMessage),
			};
		};
		const inferencePort =
			tamperKind === "session"
				? {
						...inference.port,
						executeControl: (
							requestId: string,
							messages: { role: string; content: string }[],
							signal: AbortSignal,
							control: unknown,
							session: Record<string, any> | undefined,
						) =>
							inference.port.executeControl(
								requestId,
								messages,
								signal,
								control,
								session?.agentSession
									? {
											...session,
											agentSession: {
												...session.agentSession,
												agentId: `${session.agentSession.agentId}-other`,
											},
										}
									: session,
							),
					}
				: inference.port;
		const port = comp.createAgencyLlmPort({
			store: { write: async (fn: (db: unknown) => unknown) => fn({}) },
			inference: inferencePort,
			next: (request: { purpose: string }) => ({
				decisionId: `${conversationId}.${scope}.${request.purpose}.${++n}`,
				generation: 1,
				conversationId,
			}),
			task: prefixed
				? syntheticTask
				: tamperHere && cfg.tamper?.kind === "prefix"
					? (_id: string, task: string) => ({
							messages: [
								{
									role: "user",
									content: `## Reference\n合成の別prefix\n## Task\n${task}`,
								},
							],
						})
					: () => null,
			attemptUsage: inference.attemptUsage,
			nowMs: () => clock.now(),
		});
		const llm =
			tamperHere &&
			(cfg.tamper?.kind === "system" || cfg.tamper?.kind === "options")
				? {
						complete: (
							request: { system: string; maxOutputTokens: number },
							signal: AbortSignal,
						) =>
							port.complete(
								cfg.tamper?.kind === "system"
									? { ...request, system: request.system + "\n" }
									: {
											...request,
											maxOutputTokens: request.maxOutputTokens - 1,
										},
								signal,
							),
					}
				: port;
		return comp.createHostRuntime({
			agency: fixtureSettings.agency,
			now: () => clock.now(),
			persona: fixtureSettings.persona,
			llm,
			topics: () => [],
			todos: () => [],
			tools: c.extraTools === "approval" ? [...tools, approvalTool] : tools,
			...(restore ? { restore } : {}),
		});
	};

	async function runCase(c: P0Case, rep: number) {
		const records: TrialRecord[] = [];
		const first = c.steps[0]!;
		clock = virtualClock(first.at);
		let runtime = compose(c, trialId(c.id, rep, first.id), c.history?.());
		const tickets: Record<string, string> = {};
		let failedAt: string | null = null;
		let stoppedBy: string | null = null;
		for (const step of c.steps) {
			const id = trialId(c.id, rep, step.id);
			if (stoppedBy || failedAt) {
				records.push(
					blankRecord(
						cfg,
						manifestDigest,
						c,
						rep,
						step,
						"incomplete",
						stoppedBy ?? `earlier_step_failed:${failedAt}`,
					),
				);
				continue;
			}
			try {
				const r = await runStep(
					c,
					rep,
					step,
					id,
					runtime,
					tickets,
					(next) => (runtime = next),
				);
				records.push(r);
				if (r.result.outcome === "incomplete") stoppedBy = r.result.basis;
				else if (r.result.outcome === "runner_error") failedAt = step.id;
			} catch (error) {
				records.push(
					blankRecord(
						cfg,
						manifestDigest,
						c,
						rep,
						step,
						"runner_error",
						error instanceof Error ? error.message : String(error),
					),
				);
				failedAt = step.id;
			}
		}
		return {
			outcome: records.every((r) => r.result.outcome === "passed")
				? "passed"
				: "failed",
			records,
		};
	}

	async function runStep(
		c: P0Case,
		rep: number,
		step: P0Step,
		id: string,
		current: any,
		tickets: Record<string, string>,
		replace: (rt: any) => void,
	): Promise<TrialRecord> {
		const t0 = performance.now();
		const fetchBefore = outbound;
		const countsBefore = research.counts();
		clock.set(Math.max(clock.now(), step.at));
		if (step.runnerThrows) throw new Error("injected_runner_exception");
		const notes: string[] = [];
		let runtime = current;
		if (step.restartBefore) {
			const snap = runtime.snapshot();
			runtime = compose(c, id, structuredClone(snap));
			replace(runtime);
			if (digest(runtime.snapshot()) !== digest(snap))
				notes.push("restart_snapshot_changed");
			else notes.push("restart_snapshot_equal");
		}
		for (const o of step.observe ?? []) {
			try {
				runtime.observe(o.input);
				if (o.expectConflict) notes.push("expected_conflict_not_raised");
			} catch (error) {
				if (
					o.expectConflict &&
					error instanceof dist.module.ObservationConflictError
				)
					notes.push("observation_conflict_rejected");
				else throw error;
			}
		}
		if (step.returnOf) {
			const workRef = tickets[step.returnOf.step];
			if (!workRef) throw new Error(`no ticket from ${step.returnOf.step}`);
			runtime.observe({ ...step.returnOf.input, workRef });
		}
		const attemptsBefore = runtime.snapshot().state.attempts.length;
		const controller = new AbortController();
		inference.begin(
			id,
			cfg.mode === "replay"
				? { mode: "replay", entries: entriesByTrial.get(id) ?? [] }
				: { mode: "record", script: step.script },
			controller,
		);
		let decision: any = null;
		let calls: any[] = [];
		let reasons: string[] = [];
		let blocked: string[] = [];
		let aborted = false;
		let runnerError: string | null = null;
		let log;
		try {
			if (step.run === "decide") {
				const r = await runtime.decide(
					{
						id: `o-${step.id}`,
						at: step.at,
						trigger: step.trigger ?? "idle",
						presence: "quiet",
						foregroundBusy: false,
						playerBusy: false,
						speechAllowed: step.speechAllowed ?? true,
						topics: [],
						todos: [],
					},
					controller.signal,
				);
				decision = r.decision;
				calls = r.calls;
			} else {
				const w = await runtime.wake(step.at, step.host, controller.signal);
				decision = w.decision;
				calls = w.calls;
				reasons = [...w.reasons];
				blocked = w.blocked.map(
					(b: { reason: string; code: string }) => `${b.reason}:${b.code}`,
				);
			}
			if (step.runnerThrowsAfter)
				throw new Error("injected_runner_exception_after_calls");
		} catch (error) {
			if (controller.signal.aborted) {
				aborted = true;
				notes.push("decision_aborted");
			} else
				// Kept on this step's record with the attempts already served; nothing is dropped from measurement.
				runnerError = error instanceof Error ? error.message : String(error);
		} finally {
			log = inference.end();
			for (const e of log.entries)
				appendFileSync(files.cassette, JSON.stringify(e) + "\n");
			for (const q of log.requests)
				appendFileSync(files.requests, JSON.stringify(q) + "\n");
		}
		const ticket = decision?.ticket ?? null;
		if (ticket) tickets[step.id] = ticket.id;
		let admission: TrialRecord["hostAdmission"] = {
			status: "not_checked",
			gate: null,
			at: null,
			basis: null,
			code: null,
		};
		if (ticket?.action === "tool" && step.admission) {
			const gate =
				"dialogue.agency-state.saveInTransaction+startInTransaction (disposable SQLite, inert worker)";
			try {
				research.admit(ticket, runtime, `p0-${c.id}-r${rep}`, {
					failSave: step.admission === "fail_save",
				});
				admission = {
					status: "allowed",
					gate,
					at: clock.now(),
					basis: "fixture_only",
					code: null,
				};
			} catch (error) {
				admission = {
					status: "rejected",
					gate,
					at: clock.now(),
					basis: "fixture_only",
					code: error instanceof Error ? error.message : String(error),
				};
			}
		}
		const countsAfter = research.counts();
		const after = runtime.snapshot();
		const sel = parseSelect(log.entries);
		const action =
			sel &&
			!("unparseable" in sel) &&
			typeof sel.action === "string" &&
			["speak", "tool", "wait", "discard"].includes(sel.action)
				? (sel.action as "speak" | "tool" | "wait" | "discard")
				: null;
		const candidateRef =
			sel && sel.candidateRef && typeof sel.candidateRef === "object"
				? (sel.candidateRef as { id: string; revision: number })
				: null;
		const servedNull = log.usage.filter(
			(u) => u.served === "value" && u.usage == null,
		).length;
		const capRefused = log.refused.some((r) => r.reason === "attempt_cap");
		const effects: Effects = {
			...zeroEffects(),
			ticketsIssued: ticket ? 1 : 0,
			reservations: Math.max(0, after.state.attempts.length - attemptsBefore),
			fixtureDelegationsStarted:
				countsAfter.workerStarts - countsBefore.workerStarts,
			fixtureWorkRows: countsAfter.workRows - countsBefore.workRows,
			outboundNetwork: outbound - fetchBefore,
			controlReceiptsAccepted: log.receipts.accepted,
			controlReceiptsRejected: log.receipts.rejected,
		};
		const mismatches = log.mismatches.map((m) =>
			[
				m.kind,
				...(m.parts?.length ? [m.parts.join("+")] : []),
				...(m.detail ? [m.detail] : []),
			].join(":"),
		);
		allMismatches.push(...log.mismatches);
		const observed = {
			ticket: ticket?.action ?? null,
			source: decision?.source ?? (aborted ? "aborted" : null),
			rejectCodes: decision?.rejectCodes ?? [],
			admission: admission.status,
			admissionCode: admission.code,
			calls,
			attempts: log.served,
			accepted: log.receipts.accepted,
			rejected: log.receipts.rejected,
			notes,
			reasons,
		};
		const missing = unmet(step.expect, observed);
		let outcome: TrialRecord["result"]["outcome"];
		let basis: string;
		if (capRefused) {
			// Stopped by the attempt cap: never a success, whatever the partial step returned.
			outcome = "incomplete";
			basis = "stopped:cost_exceeded:attempt_cap";
		} else if (runnerError) {
			outcome = "runner_error";
			basis = runnerError;
		} else if (mismatches.length) {
			outcome = "runner_error";
			basis =
				(cfg.mode === "replay" ? "replay_mismatch:" : "fixture_script:") +
				mismatches.join(",");
		} else if (!missing.length) {
			outcome = "passed";
			basis = step.expect.expectedRejection
				? "expected_rejection_observed"
				: "expectation_met";
		} else if (
			decision?.source === "error" ||
			calls.some((x) => String(x.code).startsWith("llm"))
		) {
			outcome = "model_error";
			basis = missing.join(",");
		} else if (
			decision?.source === "rejected" ||
			admission.status === "rejected"
		) {
			outcome = "decision_rejected";
			basis = missing.join(",");
		} else {
			outcome = "behavior_mismatch";
			basis = missing.join(",");
		}
		outwardTotal +=
			effects.speech +
			effects.notifications +
			effects.productWrites +
			effects.actionReceipts +
			effects.observeEffects +
			effects.outboundNetwork;
		return {
			schema: "agency-p0-trial.v2",
			runId: cfg.runId,
			trialId: id,
			caseId: c.id,
			rep,
			step: step.id,
			split: c.split,
			lane: "fixture",
			variant: cfg.variant,
			digests: {
				manifest: manifestDigest,
				input: stepInputDigest(c, step),
				requests: log.entries.map((e) => e.digests.request),
				responses: log.entries.map((e) => e.responseDigest),
				finalSnapshot: digest(after),
			},
			proposal: {
				action,
				candidateRef,
				evidenceRefs: Array.isArray(sel?.evidenceRefs)
					? (sel.evidenceRefs as string[])
					: [],
				reason: typeof sel?.reason === "string" ? sel.reason : null,
				valueNow: typeof sel?.valueNow === "string" ? sel.valueNow : null,
				lossIfWait: typeof sel?.lossIfWait === "string" ? sel.lossIfWait : null,
				nullReason: action
					? null
					: sel
						? "select_output_invalid"
						: `select_not_served:${observed.source ?? "none"}`,
			},
			core: {
				eligibleAction: ticket?.action ?? null,
				decisionAction: decision?.action ?? null,
				source: observed.source,
				rejectCodes: [...observed.rejectCodes],
				blockCodes: blocked,
				wakeReasons: reasons.map(String),
				ticketId: ticket?.id ?? null,
				candidateId: decision?.candidateId ?? null,
			},
			hostAdmission: admission,
			suppression: { status: "not_applicable", reason: null, source: "none" },
			effects,
			measurement: {
				calls: calls.map((x) => ({
					purpose: x.purpose,
					code: x.code,
					rejectCodes: [...x.rejectCodes],
					reportedInputTokens: x.inputTokens,
					reportedOutputTokens: x.outputTokens,
				})),
				logicalCalls: calls.filter((x) => !String(x.code).startsWith("skipped"))
					.length,
				attempts: log.served,
				refusedAttempts: log.refused.length,
				refusals: log.refused.map((r) => ({ ...r })),
				providerCalls: outbound - fetchBefore,
				attemptUsage: log.usage,
				zeroFilledUsage: servedNull,
				clock: [step.at, ...log.clock],
				wallMs: performance.now() - t0,
				cost: {
					amount: 0,
					basis:
						"no provider call: fixture inference; outbound fetch guard count recorded",
				},
				missing: [
					...(log.usage.some((u) => u.usage === null)
						? ["attempt_usage_unknown"]
						: []),
					...(log.refused.length ? ["refused_before_serve"] : []),
					"latency_virtual_clock",
				],
			},
			result: {
				outcome,
				basis,
				recordComplete: true,
				scorable: false,
				expectedRejection: step.expect.expectedRejection,
				mismatches,
			},
			label: c.label
				? { ...c.label, allowedActions: [...c.label.allowedActions] }
				: null,
		};
	}

	const stop = () => {
		if (outwardTotal > 0) return "safety_violation:outward_effect";
		if (outbound > 0) return "cost_exceeded:provider_call";
		const t = inference.totals();
		if (t.capHit) return "cost_exceeded:attempt_cap";
		if (t.served >= cfg.maxAttempts) return "cost_exceeded:attempt_cap_reached";
		if (stopAfterHit) return "version_changed:injected";
		const now = treeDigest(dist.codeDir).digest;
		if (now !== distDigestAtStart) return "version_changed:distribution";
		if (compositionIdentity(cfg.host).filesDigest !== compositionAtStart)
			return "version_changed:composition";
		return null;
	};
	let totals;
	try {
		totals = await runTrials(
			cfg.cases,
			cfg.reps,
			async (c, rep) => {
				const r = await runCase(c, rep);
				if (cfg.injectStopAfter === c.id) stopAfterHit = true;
				return r;
			},
			(result) => {
				const c = cfg.cases.find((x) => x.id === result.case)!;
				if ("records" in result)
					for (const r of result.records as TrialRecord[]) write(r);
				else
					for (const s of c.steps)
						write(
							blankRecord(
								cfg,
								manifestDigest,
								c,
								result.rep,
								s,
								result.outcome === "incomplete" ? "incomplete" : "runner_error",
								"reason" in result
									? String(result.reason)
									: "error" in result
										? String(result.error)
										: "unknown",
							),
						);
			},
			{ stop },
		);
	} finally {
		globalThis.fetch = realFetch;
		research.close();
	}

	// The aggregate is computed from the raw file just written, never from memory.
	const raw = parseJsonl(
		readFileSync(files.trials, "utf8"),
		trialRecordSchema,
		files.trials,
	);
	const agg = aggregate(planned, raw.records);
	writeFileSync(
		files.aggregate,
		JSON.stringify(
			{ ...agg, parseErrors: raw.errors, manifestDigest },
			null,
			"\t",
		) + "\n",
	);
	const runLog = {
		runId: cfg.runId,
		manifestDigest,
		totals,
		wallMs: performance.now() - started,
		guards: {
			outboundFetchAttempts: outbound,
			productDataDirBefore: dataBefore,
			productDataDirAfter: existsSync(dataDir),
			fixtureStore: ":memory:",
			worker: "inert (counts starts only)",
		},
		inference: inference.totals(),
		identityMap: inference.identities.table(),
		mismatches: allMismatches,
	};
	writeFileSync(files.log, JSON.stringify(runLog, null, "\t") + "\n");
	return { files, manifest, manifestDigest, agg, runLog };
}

/** Comparison declarations fixed before any comparison is run (P0-A01). */
const required = [
	"identity.host.sha",
	"identity.agency.sha",
	"identity.distribution.entryRealpath",
	"identity.distribution.artifactSha256",
	"identity.distribution.distDigest",
	"identity.distribution.instructionVersion",
	"identity.environment.bun",
	"fixed.composition.filesDigest",
	"fixed.composition.systemContextAssets.digest",
	"fixed.settings.digest",
	"fixed.capabilityCatalog.digest",
	"fixed.limits.digest",
	"fixed.cases.digest",
	"fixed.labels",
	"fixed.responses.digest",
	"fixed.clock.steps",
	"plan.trials",
];
export const replayDeclaration: PairDeclaration = {
	intervention: ["mode", "variant", "replayOf", "tamper"],
	fixed: ["fixed", "identity", "plan", "lane", "semantics"],
	meta: ["runId", "createdAt", "command", "schema"],
	required,
};
/** For the later P1 comparison: only the candidate's source/distribution and the observe designation may differ. */
export const p1Declaration: PairDeclaration = {
	intervention: [
		"identity.distribution",
		"identity.agency",
		"variant",
		"observe",
	],
	fixed: [
		"fixed",
		"identity.host",
		"identity.environment",
		"plan",
		"lane",
		"semantics",
		"mode",
		"replayOf",
		"tamper",
	],
	meta: ["runId", "createdAt", "command", "schema"],
	required,
};

/** Adjacent src replayed on the baseline cassette: its code identity and the .ts/.js representation of the wake/activity files are the declared intervention. */
export const adjacentDeclaration: PairDeclaration = {
	intervention: [
		"identity.distribution",
		"identity.agency",
		"variant",
		"mode",
		"replayOf",
		"tamper",
		"fixed.wakeConfig",
		"fixed.activityLimits",
	],
	fixed: [
		"fixed",
		"identity.host",
		"identity.environment",
		"plan",
		"lane",
		"semantics",
	],
	meta: ["runId", "createdAt", "command", "schema"],
	required,
};

const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const readCassette = (dir: string) =>
	readFileSync(join(dir, "cassette.jsonl"), "utf8")
		.split("\n")
		.filter((l) => l.trim())
		.map((l) => JSON.parse(l) as CassetteEntry);
export const readTrials = (path: string) =>
	parseJsonl(readFileSync(path, "utf8"), trialRecordSchema, path);

/** Secret-shaped content in generated files (P0-A08); reports counts and variable names only, never values. */
export function scanForSecrets(paths: readonly string[]) {
	const secretEnv = Object.entries(process.env).filter(
		([k, v]) =>
			/KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH/i.test(k) &&
			typeof v === "string" &&
			v.length >= 12,
	);
	const patterns = [
		/sk-[A-Za-z0-9_-]{8,}/,
		/-----BEGIN [A-Z ]*PRIVATE KEY-----/,
		/\bBearer\s+[A-Za-z0-9._-]{12,}/,
		/"envRef"\s*:\s*"/,
	];
	const hits: { file: string; kind: string }[] = [];
	for (const p of paths) {
		if (!existsSync(p)) continue;
		const text = readFileSync(p, "utf8");
		for (const [k, v] of secretEnv)
			if (text.includes(v as string)) hits.push({ file: p, kind: `env:${k}` });
		for (const re of patterns)
			if (re.test(text))
				hits.push({ file: p, kind: `pattern:${re.source.slice(0, 24)}` });
	}
	return {
		scannedFiles: paths.filter(existsSync).length,
		secretEnvChecked: secretEnv.length,
		hits,
	};
}

if (import.meta.main) {
	const [command, ...args] = Bun.argv.slice(2);
	const { values } = parseArgs({
		args,
		options: {
			out: { type: "string" },
			from: { type: "string" },
			run: { type: "string" },
			tamper: { type: "string" },
			"tamper-trial": { type: "string" },
			host: { type: "string" },
			reps: { type: "string", default: "1" },
			"max-attempts": { type: "string", default: "200" },
			agency: { type: "string", default: "distribution" },
			preregistration: { type: "string" },
		},
	});
	const host = resolve(
		values.host ?? resolve(import.meta.dir, "../../../eumenes"),
	);
	const agencyRepo = resolve(import.meta.dir, "../..");
	const preregistration = resolve(
		values.preregistration ??
			resolve(
				host,
				"spec/verification/agency-shadow-p0-p1/preregistration-r2.md",
			),
	);
	const reps = Number(values.reps);
	const maxAttempts = Number(values["max-attempts"]);
	if (!Number.isSafeInteger(reps) || reps < 1 || reps > 3)
		throw new Error("reps: 1–3");
	if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 0)
		throw new Error("--max-attempts: a non-negative integer");
	const agency =
		values.agency === "adjacent-src" ? "adjacent-src" : "distribution";
	if (values.agency !== agency)
		throw new Error("--agency: distribution | adjacent-src");
	const base = {
		host,
		agencyRepo,
		reps,
		maxAttempts,
		agency,
		argv: [command ?? "", ...args],
		preregistration,
	} as const;
	const need = (v: string | undefined, name: string) => {
		if (!v) throw new Error(`--${name} is required`);
		return resolve(v);
	};
	const print = (line: unknown) => console.log(JSON.stringify(line));
	if (command === "record" || command === "faults") {
		const out = need(values.out, "out");
		const r = await runP0({
			...base,
			out,
			runId: `${command}-${crypto.randomUUID()}`,
			variant:
				command === "faults"
					? "fault-injection"
					: maxAttempts === 200
						? "baseline-dist"
						: `baseline-dist-cap-${maxAttempts}`,
			mode: "record",
			cases: command === "record" ? baselineCases : faultCases,
			...(command === "faults"
				? { injectStopAfter: "F04-invalid-select" }
				: {}),
		});
		if (command === "faults") {
			// Simulated record loss on a derived copy: the raw file is never edited.
			const lines = readFileSync(r.files.trials, "utf8")
				.split("\n")
				.filter((l) => l.trim());
			const derived = [
				...lines.slice(1),
				lines[1]!,
				lines[1]!.replace(/"trialId":"[^"]+"/, '"trialId":"F99-unknown/r1/s1"'),
			];
			const path = join(out, "trials.simulated-loss.jsonl");
			writeFileSync(path, derived.join("\n") + "\n");
			const parsed = readTrials(path);
			const check = {
				source:
					"trials.simulated-loss.jsonl (derived: first line removed, one duplicated, one unknown id)",
				validation: validateRecords(r.manifest.plan.trials, parsed.records),
				aggregate: aggregate(r.manifest.plan.trials, parsed.records),
			};
			writeFileSync(
				join(out, "record-loss-check.json"),
				JSON.stringify(check, null, "\t") + "\n",
			);
		}
		writeFileSync(
			join(out, "protection.json"),
			JSON.stringify(scanForSecrets(Object.values(r.files)), null, "\t") + "\n",
		);
		print({
			run: r.manifest.runId,
			out,
			planned: r.agg.denominator,
			outcomes: r.agg.outcomes,
			outward: r.agg.outwardEffects,
			attempts: r.agg.calls.attempts,
			refusedBeforeServe: r.agg.calls.refusedBeforeServe,
			providerCalls: r.agg.calls.providerCalls,
			mismatches: r.agg.mismatches.length,
		});
	} else if (command === "replay") {
		const from = need(values.from, "from");
		const out = need(values.out, "out");
		const source = readJson(join(from, "manifest.json"));
		const tamper = values.tamper as Tamper | undefined;
		if (tamper && !tampers.includes(tamper))
			throw new Error(`--tamper: ${tampers.join(", ")}`);
		const r = await runP0({
			...base,
			out,
			runId: `replay-${crypto.randomUUID()}`,
			variant:
				agency === "adjacent-src"
					? "replay-adjacent-src"
					: tamper
						? `replay-tamper-${tamper}`
						: "replay-baseline-dist",
			mode: "replay",
			cases: baselineCases,
			replay: { from, entries: readCassette(from), manifest: source },
			...(tamper
				? {
						tamper: {
							kind: tamper,
							trialId:
								values["tamper-trial"] ??
								(prefixTampers.includes(tamper)
									? "M15-conversation-prefix/r1/s1"
									: source.plan.trials[0]),
						},
					}
				: {}),
		});
		const before = readTrials(join(from, "trials.jsonl")).records;
		const after = readTrials(r.files.trials).records;
		const diffs = compareRecords(before, after);
		const result = {
			from: source.runId,
			replay: r.manifest.runId,
			tamper: r.manifest.tamper,
			pair: checkPair(
				source,
				r.manifest,
				agency === "adjacent-src" ? adjacentDeclaration : replayDeclaration,
			),
			pairDeclaration:
				agency === "adjacent-src" ? "adjacentDeclaration" : "replayDeclaration",
			mismatches: r.runLog.mismatches,
			behaviourDiffs: diffs,
			trialsWithDiffs: [...new Set(diffs.map((d) => d.trialId))],
			identityBindings: r.runLog.identityMap.length,
			identityKinds: [...new Set(r.runLog.identityMap.map((b) => b.kind))],
			equal: diffs.length === 0 && r.runLog.mismatches.length === 0,
		};
		writeFileSync(
			join(out, "replay-compare.json"),
			JSON.stringify(result, null, "\t") + "\n",
		);
		writeFileSync(
			join(out, "protection.json"),
			JSON.stringify(scanForSecrets(Object.values(r.files)), null, "\t") + "\n",
		);
		print({
			run: r.manifest.runId,
			tamper: tamper ?? null,
			equal: result.equal,
			mismatchKinds: [
				...new Set(
					(r.runLog.mismatches as { kind: string }[]).map((m) => m.kind),
				),
			],
			trialsWithDiffs: result.trialsWithDiffs.length,
			pairComparable: result.pair.comparable,
		});
	} else if (command === "aggregate") {
		const run = need(values.run, "run");
		const manifest = readJson(join(run, "manifest.json"));
		const parsed = readTrials(join(run, "trials.jsonl"));
		const regenerated = {
			...aggregate(manifest.plan.trials, parsed.records),
			parseErrors: parsed.errors,
			manifestDigest: digest(manifest),
		};
		const stored = readJson(join(run, "aggregate.json"));
		const same = canonical(regenerated) === canonical(stored);
		print({
			run: manifest.runId,
			regeneratedEqualsStored: same,
			denominator: regenerated.denominator,
			outcomes: regenerated.outcomes,
		});
		if (!same) process.exitCode = 1;
	} else {
		console.error(
			"usage: bun eval/initiative/p0.ts record|faults --out <dir> | replay --from <dir> --out <dir> [--tamper kind] | aggregate --run <dir>",
		);
		process.exitCode = 2;
	}
}
