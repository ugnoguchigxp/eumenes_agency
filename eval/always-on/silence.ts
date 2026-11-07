/**
 * Stage 0 of spec/always-on-agency-design-2026-11-07.md: how much can the agent do on its own
 * while the user is silent? No API: a virtual clock drives the existing idle planner with two
 * extreme model policies (always speak / always wait), and the real runtime is asked once at a
 * cold start to show whether a model call is made at all.
 *
 *   bun eval/always-on/silence.ts [minutes]
 */
import {
	createAgencyRuntime,
	createIdlePlanner,
	type IdleConfig,
	type LlmPort,
	type RuntimeDeps,
	type ThinkOutput,
} from "../../src/index.ts";
import { simulate } from "./sim.ts";

export interface SilenceRow {
	readonly host: string;
	readonly policy: "speak" | "wait";
	/** Background opportunities the host offered (one model decision each at most). */
	readonly cycles: number;
	readonly utterances: number;
	/** Seconds from the start until the last automatic cycle. */
	readonly lastCycleSec: number | null;
	/** Why automatic cycles stopped, or null when they were still running at the end. */
	readonly stoppedBy: string | null;
}

/** Replays one silent stretch on the existing idle planner. */
export function simulateIdle(
	host: string,
	config: IdleConfig,
	policy: "speak" | "wait",
	minutes: number,
): SilenceRow {
	const start = 0;
	const end = minutes * 60_000;
	const planner = createIdlePlanner(config, start);
	planner.userTurn(start);
	let now = start;
	let cycles = 0;
	let utterances = 0;
	let last: number | null = null;
	for (;;) {
		const delay = planner.delayMs(now);
		if (delay === null || now + delay > end) break;
		now += delay;
		cycles++;
		last = now;
		if (policy === "speak") {
			utterances++;
			planner.proactiveSpoke(now);
		} else planner.idleSilent(now);
	}
	return {
		host,
		policy,
		cycles,
		utterances,
		lastCycleSec: last === null ? null : last / 1000,
		stoppedBy: planner.blockedBy(),
	};
}

/** The legacy hosts measured here: the standalone CLI defaults and Eumenes' settings. */
export const legacyHosts: readonly {
	readonly host: string;
	readonly config: IdleConfig;
}[] = [
	// standalone/chat-loop.ts: defaultIdleSec 10, defaultCliMaxUnanswered 3, two retries.
	{ host: "standalone CLI (B1a)", config: { idleSec: 10, maxUnanswered: 3 } },
	// Eumenes api/domains/settings: idleSec 20, maxUnanswered 1.
	{ host: "Eumenes (F)", config: { idleSec: 20, maxUnanswered: 1 } },
];

/** A model with nothing to add: every update is "no change", every select is "wait". */
const countingLlm = () => {
	const calls: string[] = [];
	const empty = {
		summary: "変化なし",
		missingInfo: null,
		focusRefs: [],
		ops: [],
		reconciliations: [],
		reportedTodos: [],
		interestOps: [],
	};
	const wait = {
		action: "wait",
		candidateRef: null,
		utterance: null,
		toolName: null,
		toolInput: null,
		evidenceRefs: [],
		conversationEvidenceRefs: [],
		valueNow: "-",
		userBurden: "-",
		lossIfWait: "-",
		conflicts: "-",
		reason: "probe",
		emotion: null,
	};
	// The schemas are strict and differ by condition: drop optional keys until one parses.
	const optional = [
		"reportedTodos",
		"interestOps",
		"conversationEvidenceRefs",
		"emotion",
	];
	const fit = (schema: { safeParse(v: unknown): { success: boolean } }) => {
		const base = schemaInput === "update" ? empty : wait;
		for (let mask = 0; mask < 1 << optional.length; mask++) {
			const v: Record<string, unknown> = { ...base };
			optional.forEach((k, i) => {
				if (mask & (1 << i)) delete v[k];
			});
			if (schema.safeParse(v).success) return v;
		}
		throw new Error("silence probe: no fitting empty output");
	};
	let schemaInput: string = "update";
	const llm: LlmPort = {
		complete(request) {
			calls.push(request.purpose);
			schemaInput = request.purpose;
			const value = request.schema.parse(fit(request.schema));
			return Promise.resolve({
				value,
				model: "probe",
				inputTokens: 0,
				outputTokens: 0,
				cacheReadTokens: 0,
				latencyMs: 0,
			});
		},
	};
	return { llm, calls: () => calls.join("+") || "なし" };
};

const stubContext = () => ({
	value: "silence probe",
	input: { sources: [], complete: true },
});

/** Asks the real runtime for one idle decision with no memory and no conversation yet. */
export async function coldStartProbe(): Promise<
	readonly { host: string; source: string; modelCalls: string }[]
> {
	const variants: readonly {
		host: string;
		deps: Omit<RuntimeDeps, "llm">;
	}[] = [
		{
			host: "standalone CLI (B1a)",
			deps: {
				condition: "B1",
				selectWhenEmpty: true,
				systemContext: "experimental",
				tools: [],
			},
		},
		{
			host: "Eumenes (F)",
			deps: {
				condition: "F",
				conversationParticipation: true,
				planOnOpportunity: true,
				interestFormation: true,
				hostTopics: true,
				hostTodos: true,
				findings: true,
				systemContext: { update: stubContext, select: stubContext },
				tools: [],
			},
		},
	];
	const rows = [];
	for (const v of variants) {
		const probe = countingLlm();
		const runtime = createAgencyRuntime({
			...v.deps,
			llm: probe.llm,
			now: () => 0,
		});
		const { decision } = await runtime.decide(
			{
				id: "o1",
				at: 0,
				trigger: "idle",
				presence: "quiet",
				foregroundBusy: false,
				playerBusy: false,
			},
			new AbortController().signal,
		);
		rows.push({
			host: v.host,
			source: decision.source,
			modelCalls: probe.calls(),
		});
	}
	return rows;
}

/** The always-on agent under the same extreme policies (scripted model, no API). */
export async function simulateAlwaysOn(
	policy: "speak" | "wait",
	minutes: number,
	speechIntervalSec: 10 | 60 | 600 = 10,
): Promise<SilenceRow> {
	let n = 0;
	const out = (): ThinkOutput =>
		policy === "speak"
			? {
					thought: "話しかけてみる",
					drive: "presence",
					userOps: [],
					stockOps: [],
					pace: { op: "none", minutes: null, evidenceRefs: [] },
					action: {
						kind: "speak",
						utterance: `一言${++n}`,
						toolName: null,
						toolInput: null,
						evidenceRefs: [],
						reason: "-",
					},
					next: "normal",
				}
			: {
					thought: "様子を見る",
					drive: "rest",
					userOps: [],
					stockOps: [],
					pace: { op: "none", minutes: null, evidenceRefs: [] },
					action: {
						kind: "wait",
						utterance: null,
						toolName: null,
						toolInput: null,
						evidenceRefs: [],
						reason: "-",
					},
					next: "normal",
				};
	const llm: LlmPort = {
		complete: (req) =>
			Promise.resolve({
				value: req.schema.parse(out()),
				model: "scripted",
				inputTokens: 0,
				outputTokens: 0,
				cacheReadTokens: 0,
				latencyMs: 0,
			}),
	};
	const r = await simulate({ deps: { llm, speechIntervalSec }, minutes });
	const pacing = r.agent.view().pacing;
	return {
		host: `always-on（最短${speechIntervalSec}秒）`,
		policy,
		cycles: r.ticks,
		utterances: r.utterances,
		lastCycleSec: r.lastTickSec,
		stoppedBy:
			policy === "speak" && pacing.unanswered > 0
				? `（思考は継続、発話は返事のない${pacing.unanswered}回で保留）`
				: null,
	};
}

if (import.meta.main) {
	const minutes = Number(process.argv[2] ?? "10");
	const rows = legacyHosts.flatMap((h) =>
		(["speak", "wait"] as const).map((p) =>
			simulateIdle(h.host, h.config, p, minutes),
		),
	);
	for (const p of ["speak", "wait"] as const)
		rows.push(await simulateAlwaysOn(p, minutes));
	console.log(`# ${minutes}分の沈黙で起きること（API 0件）\n`);
	console.log(
		"| ホスト | モデルの方針 | 自動の機会 | 発話 | 最後の機会(秒) | 止まった理由 |",
	);
	console.log("| --- | --- | ---: | ---: | ---: | --- |");
	for (const r of rows)
		console.log(
			`| ${r.host} | ${r.policy === "speak" ? "毎回話す" : "毎回待つ"} | ${r.cycles} | ${r.utterances} | ${r.lastCycleSec ?? "-"} | ${r.stoppedBy ?? "（継続中）"} |`,
		);
	console.log("\n# 記憶ゼロ・会話ゼロでのidle判断（実runtime）\n");
	console.log("| ホスト | 判断の出所 | モデル呼び出し |");
	console.log("| --- | --- | ---: |");
	for (const r of await coldStartProbe())
		console.log(`| ${r.host} | ${r.source} | ${r.modelCalls} |`);
}
