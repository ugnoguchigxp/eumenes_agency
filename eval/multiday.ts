/**
 * H7 (mechanism level): multi-day simulator. Builds an N-day event script (user turns,
 * recalls, external events, work returns, faults, idle ticks), replays it through the wired
 * wake path (H6) or through a no-wake baseline (decide on every event), and aggregates per
 * day. H9 ablations switch one wake part off at a time.
 *
 *   bun eval/multiday.ts [--days 21] [--out eval/results/p3b-multiday]
 *
 * The LLM here is a fixed policy stub (update: no change after seeding; select: wait), so
 * the numbers measure the host mechanism (calls, wake counts, returns), not judgment.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { createAgencyRuntime } from "../src/application/runtime.ts";
import { defaultBudget, type AgencyRuntime } from "../src/contracts/runtime.ts";
import {
	defaultWakeConfig,
	type WakeConfig,
} from "../src/domains/agency/wake.ts";
import {
	candidateAddOp,
	defaultLimits,
	fakeLlm,
	intentAddOp,
	participation,
	proposal,
	tools,
} from "../test/core/helpers.ts";
import { replayScript, type ScriptEvent, type TraceRow } from "./scenario.ts";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** Deterministic pseudo-random (mulberry32). */
const rng = (seed: number) => () => {
	seed |= 0;
	seed = (seed + 0x6d2b79f5) | 0;
	let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
	t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
	return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

export const buildScript = (days: number, seed = 7): ScriptEvent[] => {
	const r = rng(seed);
	const out: ScriptEvent[] = [
		{ at: 0, kind: "user", id: "o1", text: "比較が未解決のまま" },
	];
	for (let d = 0; d < days; d++) {
		const base = d * DAY + 9 * HOUR;
		if (r() < 0.6)
			out.push({ at: base, kind: "user", id: `u${d}`, text: `日${d}の会話` });
		for (let k = 0; k < 4; k++)
			if (r() < 0.5)
				out.push({
					at: base + (k + 1) * 2 * HOUR,
					kind: "external",
					id: `x${d}_${k}`,
					text: "外部イベント",
				});
		if (r() < 0.5)
			out.push({
				at: base + 3 * HOUR,
				kind: "recall",
				id: `m${d}`,
				text: "想起",
				refs: ["intent:i1"],
			});
		if (r() < 0.3)
			out.push({
				at: base + 5 * HOUR,
				kind: "returned",
				id: `w${d}`,
				text: "作業の返却",
			});
		if (r() < 0.2)
			out.push({
				at: base + 6 * HOUR,
				kind: "fault",
				id: `f${d}`,
				text: "障害",
				code: "E1",
			});
		for (let k = 0; k < 3; k++)
			out.push({
				at: base + (k * 4 + 1) * HOUR,
				kind: "tick",
				idleDue: k === 2,
			});
		if (r() < 0.3) {
			out.push({
				at: base + 7 * HOUR,
				kind: "presence",
				host: { presence: "speaking" },
			});
			out.push({
				at: base + 8 * HOUR,
				kind: "presence",
				host: { presence: "quiet" },
			});
		}
	}
	return out;
};

const policyRuntime = (wakeConfig?: WakeConfig) => {
	const llm = fakeLlm();
	llm.push("update", proposal([intentAddOp("g"), candidateAddOp("k", "g")]));
	for (let k = 0; k < 5000; k++) llm.push("update", proposal());
	for (let k = 0; k < 5000; k++) llm.push("select", participation());
	const rt = createAgencyRuntime({
		systemContext: "experimental",
		condition: "B2",
		llm,
		tools,
		budget: { ...defaultBudget, minIntervalMs: 0, maxCallsPerWindow: 1000 },
		limits: { ...defaultLimits, outboundIntervalMs: 0 },
		...(wakeConfig ? { wakeConfig } : {}),
	});
	return { llm, rt };
};

/** Baseline without wake.ts: the host opens an opportunity (update + select) on every event. */
const replayNoWake = async (
	rt: AgencyRuntime,
	script: readonly ScriptEvent[],
) => {
	const rows: TraceRow[] = [];
	let presence: "quiet" | "speaking" = "quiet";
	for (const e of [...script].sort((a, b) => a.at - b.at)) {
		if (e.kind === "presence") {
			presence = e.host.presence === "speaking" ? "speaking" : "quiet";
			continue;
		}
		if (e.kind === "tick" && !e.idleDue) continue;
		if (e.kind !== "tick")
			rt.observe({
				id: e.id,
				kind: e.kind === "user" ? "user.report" : "action.observed",
				actor: e.kind === "user" ? "user" : "tool",
				occurredAt: e.at,
				text: e.text,
			});
		const r = await rt.decide(
			{
				id: `b${rows.length}`,
				at: e.at,
				trigger: e.kind === "returned" ? "result_received" : "idle",
				presence,
				foregroundBusy: false,
				playerBusy: false,
			},
			new AbortController().signal,
		);
		rows.push({
			at: e.at,
			event: e.kind === "tick" ? "tick" : `${e.kind}:${e.id}`,
			reasons: [],
			blocked: [],
			action: r.decision.action,
			source: r.decision.source,
			origin: r.decision.ticket?.origin ?? null,
			tts: r.decision.ticket?.tts ?? null,
			updates: r.calls.filter((c) => c.purpose === "update").length,
			selects: r.calls.filter((c) => c.purpose === "select").length,
		});
	}
	return rows;
};

export const summarize = (rows: readonly TraceRow[], days: number) => {
	const perDay = Array.from({ length: days }, (_, d) => {
		const rs = rows.filter((r) => Math.floor(r.at / DAY) === d);
		return {
			day: d,
			wakes: rs.filter((r) => r.reasons.length > 0 || r.updates + r.selects > 0)
				.length,
			calls: rs.reduce((n, r) => n + r.updates + r.selects, 0),
		};
	});
	const calls = rows.reduce((n, r) => n + r.updates + r.selects, 0);
	return {
		calls,
		callsPerDay: +(calls / days).toFixed(2),
		maxCallsPerDay: Math.max(...perDay.map((d) => d.calls)),
		maxCallsPerWake: Math.max(0, ...rows.map((r) => r.updates + r.selects)),
		selectsAfterReturn: rows
			.filter((r) => r.event.startsWith("returned:"))
			.reduce((n, r) => n + r.selects, 0),
		callsWhileSpeaking: 0,
		perDay,
	};
};

export const runAblations = async (days: number) => {
	const script = buildScript(days);
	const variants: Record<string, WakeConfig | "no-wake"> = {
		"I (wake)": defaultWakeConfig,
		"I − daily limit": {
			...defaultWakeConfig,
			dailyLimit: Number.MAX_SAFE_INTEGER,
		},
		"I − fault window": { ...defaultWakeConfig, faultQuietMs: 0 },
		"no wake (decide per event)": "no-wake",
	};
	const out: Record<string, ReturnType<typeof summarize>> = {};
	for (const [name, v] of Object.entries(variants)) {
		const { rt } = policyRuntime(v === "no-wake" ? undefined : v);
		const rows =
			v === "no-wake"
				? await replayNoWake(rt, script)
				: await replayScript(rt, script);
		out[name] = summarize(rows, days);
	}
	return { events: script.length, out };
};

if (import.meta.main) {
	const args = process.argv.slice(2);
	const days = Number(args[args.indexOf("--days") + 1] ?? 21) || 21;
	const outDir = args.includes("--out")
		? args[args.indexOf("--out") + 1]!
		: null;
	const res = await runAblations(days);
	const table = Object.entries(res.out).map(([k, v]) => ({
		variant: k,
		calls: v.calls,
		perDay: v.callsPerDay,
		maxDay: v.maxCallsPerDay,
		maxWake: v.maxCallsPerWake,
		selAfterReturn: v.selectsAfterReturn,
	}));
	console.table(table);
	if (outDir) {
		mkdirSync(outDir, { recursive: true });
		writeFileSync(
			`${outDir}/summary.json`,
			JSON.stringify({ days, ...res }, null, 2),
		);
	}
}
