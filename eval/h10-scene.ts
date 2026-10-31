/**
 * P4-a reinforcement: a small LLM-included H10 scene (plan §P4-a, self-inference §6.6).
 * Scripted returns (H10) are bound to the agent's own `delegate` tickets; update/select are
 * answered by the self-inference port. Condition names are not in the requests (salt only).
 * before = workReturns:false, after = workReturns:true (both condition I).
 *
 *   bun eval/h10-scene.ts --dir eval/results/p4a-h10 [--conds after,before]
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { createAgencyRuntime } from "../src/application/runtime.ts";
import { defaultBudget } from "../src/contracts/runtime.ts";
import { tools } from "../test/core/helpers.ts";
import { replayScript, type ScriptEvent, type TraceRow } from "./scenario.ts";
import { H10_TEXT } from "./h10.ts";
import { createSelfPort } from "./self-port/port.ts";

const H = 3_600_000;
const D = 24 * H;
const T0 = 1_700_000_000_000;

export const delegateTools = [
	...tools,
	{
		name: "delegate",
		description:
			"調査・整理を作業単位として委譲する（ホストが Pursuit に渡し、単位ごとに結果が返る）",
		requiresApproval: false,
	},
];

/** Host-side script and labels; never shown to the answerer. */
export const SCENE: ScriptEvent[] = [
	{
		at: 9 * H,
		kind: "user",
		id: "u1",
		text: "将棋の角換わり腰掛け銀、先手の定跡を時間があるときに調べて整理しておいてくれると助かる",
	},
	{ at: 12 * H, kind: "tick", idleDue: true },
	{ at: 13 * H, kind: "tick", idleDue: true },
	{
		at: 15 * H,
		kind: "returned",
		id: "r1",
		text: H10_TEXT.question,
		workStatus: "question",
		delegateSeq: 1,
	},
	{ at: 18 * H, kind: "tick", idleDue: true },
	{
		at: D + 9 * H,
		kind: "user",
		id: "u2",
		text: "先手番だけでいいよ。続けて調べて",
	},
	{ at: D + 10 * H, kind: "tick", idleDue: true },
	{
		at: D + 14 * H,
		kind: "returned",
		id: "r2",
		text: "調査が完了しました: 角換わり腰掛け銀の先手の主要定跡3系統を出典つきで整理しました",
		workStatus: "succeeded",
		delegateSeq: 2,
	},
	{ at: D + 18 * H, kind: "tick", idleDue: true },
	{
		at: D + 20 * H,
		kind: "external",
		id: "x1",
		text: "将棋ニュース: タイトル戦で角換わりが採用された",
	},
	{ at: 2 * D + 10 * H, kind: "tick", idleDue: true },
].map((e) => ({ ...e, at: T0 + e.at }) as ScriptEvent);

const isDelegate = (r: TraceRow) =>
	r.action === "tool" && r.toolName === "delegate";
const speaks = (r: TraceRow) => r.action === "speak";

export const score = (rows: readonly TraceRow[], snap: { state: any }) => {
	const idx = (ev: string) => rows.findIndex((r) => r.event === ev);
	const r1 = idx("returned:r1"),
		u2 = idx("user:u2"),
		r2 = idx("returned:r2");
	const dels = rows
		.map((r, i) => [r, i] as const)
		.filter(([r]) => isDelegate(r));
	const firstDel = dels[0]?.[1] ?? -1;
	// re-request without a new reason: a delegation after the first and before its return,
	// or after the success return (r2) at all.
	const autoRerequest = dels.filter(
		([, i]) =>
			(i > firstDel && (r1 < 0 || i < r1)) ||
			(r1 >= 0 && i > r1 && i < u2) ||
			(r2 >= 0 && i > r2),
	).length;
	const ret = (st: any) =>
		(st.intents ?? [])
			.filter((i: any) => i.lastReturn)
			.map((i: any) => i.lastReturn.status);
	const bound = rows.filter(
		(r) =>
			r.event.startsWith("returned:") &&
			!r.blocked.includes("unbound:no_delegation"),
	).length;
	const recorded = ret(snap.state);
	const auto = rows.filter((r) => r.origin === "autonomous");
	return {
		delegations: dels.length,
		returnsBound: bound,
		returnsRecordedOnIntent: recorded.length,
		lastReturnStatuses: recorded,
		autoRerequest,
		selectsOnReturn: rows
			.filter((r) => r.event.startsWith("returned:"))
			.reduce((n, r) => n + r.selects, 0),
		questionRelayed:
			r1 >= 0 && rows.slice(r1, u2).some((r) => speaks(r)) ? 1 : 0,
		resumedAfterAnswer:
			u2 >= 0 && rows.slice(u2, r2 < 0 ? undefined : r2).some(isDelegate)
				? 1
				: 0,
		successReported: r2 >= 0 && rows.slice(r2).some((r) => speaks(r)) ? 1 : 0,
		actsOnNewsAfterDone: rows
			.slice(idx("external:x1"))
			.filter((r) => isDelegate(r) || speaks(r)).length,
		autonomousTtsFalse: `${auto.filter((r) => r.tts === false).length}/${auto.length}`,
		calls: rows.reduce((n, r) => n + r.updates + r.selects, 0),
		maxCallsPerWake: Math.max(0, ...rows.map((r) => r.updates + r.selects)),
	};
};

const makeRuntime = (cond: string, llm: any) =>
	createAgencyRuntime({
		systemContext: "experimental",
		condition: "F",
		interestFormation: true,
		llm,
		tools: delegateTools,
		budget: { ...defaultBudget, minIntervalMs: 0 },
		activityLimits: { toolCalls: 3, tokens: 20_000, elapsedMs: 30 * 60_000 },
		workReturns: cond === "after",
	} as never);

if (import.meta.main) {
	const args = process.argv.slice(2);
	const dir = args[args.indexOf("--dir") + 1] ?? "eval/results/p4a-h10";
	const conds = (
		args.includes("--conds")
			? args[args.indexOf("--conds") + 1]!
			: "after,before"
	).split(",");
	const out: Record<string, unknown> = {};
	for (const c of conds) {
		const port = createSelfPort(dir);
		port.setSalt(`h10s:${c === "after" ? "k7" : "q2"}`);
		const rt = makeRuntime(c, port);
		// Per return: was result/status/reviewAt recorded on the intent right after work.returned?
		const recorded: string[] = [];
		const observe = rt.observe.bind(rt);
		(rt as { observe: typeof rt.observe }).observe = (input) => {
			const r = observe(input);
			if (input.kind === "work.returned" && input.workRef) {
				const it = (rt.snapshot().state as any).intents.find(
					(i: any) => i.lastReturn?.workRef === input.workRef,
				);
				if (it && it.reviewAt >= (input.occurredAt ?? 0) + 24 * H)
					recorded.push(
						`${input.workStatus}:${it.lastReturn.question ? "q" : "-"}`,
					);
			}
			return r;
		};
		const rows = await replayScript(rt, SCENE);
		if (port.pending() > 0) {
			console.log(`${c}: pending (${rows.length} rows)`);
			continue;
		}
		const s = { ...score(rows, rt.snapshot()), returnsRecorded: recorded };
		out[c] = { score: s, rows };
		console.log(c, JSON.stringify(s));
	}
	mkdirSync(dir, { recursive: true });
	writeFileSync(`${dir}/result.json`, JSON.stringify(out, null, 1));
}
