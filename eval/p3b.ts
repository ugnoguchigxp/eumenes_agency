/**
 * P3-b quality gate (plan §P3-b, metrics 4/5/6/8/10): a 3-day, 2-interest scene with H8
 * behaviour fixtures embedded, replayed through the wake path (H6) for I and B1h with the
 * self-inference port (H0). The answerer sees only the request (no condition name, no
 * labels); scoring is automatic from the trace and the final state.
 *
 *   bun eval/p3b.ts --dir eval/results/p3b-self [--conds I,B1h]
 * Re-run after answering the queued request until nothing is pending.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { createAgencyRuntime } from "../src/application/runtime.ts";
import { defaultBudget } from "../src/contracts/runtime.ts";
import { tools } from "../test/core/helpers.ts";
import { replayScript, type ScriptEvent, type TraceRow } from "./scenario.ts";
import { createSelfPort } from "./self-port/port.ts";

const H = 3_600_000;
const D = 24 * H;
const T0 = 1_700_000_000_000;

/** Fixture labels (host side only; never shown to the answerer). */
export const SCENE: ScriptEvent[] = [
	{
		at: 9 * H,
		kind: "user",
		id: "u1",
		text: "ベランダのトマト、下の方の葉が黄色くなってきた。原因を調べたいけど、今は時間がない",
	},
	{
		at: 9 * H + 300_000,
		kind: "user",
		id: "u2",
		text: "あと将棋の角換わり、腰掛け銀の先手の指し方をそのうち整理したいんだよね",
	},
	{ at: 12 * H, kind: "tick", idleDue: true },
	// non-obsession: three A-related events that carry no progress
	{
		at: 14 * H,
		kind: "external",
		id: "x1",
		text: "園芸ニュース: 夏野菜の水やり特集",
	},
	{
		at: 16 * H,
		kind: "external",
		id: "x2",
		text: "園芸ニュース: 家庭菜園の害虫対策",
	},
	{
		at: 18 * H,
		kind: "external",
		id: "x3",
		text: "園芸ニュース: プランター用の土の選び方",
	},
	// interrupt: a user request that asks to set other topics aside
	{
		at: D + 9 * H,
		kind: "user",
		id: "u3",
		text: "今日は確定申告の書類を整理するのを手伝って。それが終わるまで他の話はいいよ",
	},
	{ at: D + 9 * H + 1_800_000, kind: "tick", idleDue: true },
	{
		at: D + 13 * H,
		kind: "returned",
		id: "w1",
		text: "確定申告の書類整理が完了しました（領収書を月別に分類済み）",
	},
	{ at: D + 15 * H, kind: "tick", idleDue: true },
	{ at: D + 20 * H, kind: "presence", host: { presence: "speaking" } },
	{
		at: D + 20 * H + 60_000,
		kind: "external",
		id: "x4",
		text: "園芸ニュース: トマトの葉の黄変は窒素不足が多い",
	},
	{ at: D + 21 * H, kind: "presence", host: { presence: "quiet" } },
	// unrelated trigger (should not reopen A/B), then a related recall (should)
	{
		at: 2 * D + 9 * H,
		kind: "external",
		id: "x5",
		text: "天気予報: 明日は全国的に晴れ",
	},
	{
		at: 2 * D + 11 * H,
		kind: "recall",
		id: "m1",
		text: "想起: 以前ユーザーが角換わり腰掛け銀の先手の指し方を整理したいと言っていた",
		refs: [],
		match: /将棋|角換わり|腰掛け銀/,
	},
	{
		at: 2 * D + 13 * H,
		kind: "fault",
		id: "f1",
		text: "検索ツールが一時的に応答しない",
		code: "E_SEARCH",
	},
	{ at: 2 * D + 18 * H, kind: "tick", idleDue: true },
].map((e) => ({ ...e, at: T0 + e.at }) as ScriptEvent);

const topicOf = (t: string | null | undefined): "A" | "B" | "other" | null =>
	!t
		? null
		: /トマト|菜園|園芸|葉|水やり|プランター|窒素/.test(t)
			? "A"
			: /将棋|角換わり|腰掛け銀/.test(t)
				? "B"
				: "other";

const acts = (rows: readonly TraceRow[]) =>
	rows.filter((r) => r.action === "speak" || r.action === "tool");
const at = (rows: readonly TraceRow[], ev: string) =>
	rows.find((r) => r.event === ev);
const actedOn = (r: TraceRow | undefined, topics: string[]) =>
	!!r &&
	(r.action === "speak" || r.action === "tool") &&
	topics.includes(topicOf(r.text) ?? "");

export const score = (
	rows: readonly TraceRow[],
	snap: { state: any; observations: readonly any[] },
) => {
	const a = acts(rows);
	const byTopic: Record<string, number> = {};
	for (const r of a)
		byTopic[topicOf(r.text)!] = (byTopic[topicOf(r.text)!] ?? 0) + 1;
	const top = Math.max(0, ...Object.values(byTopic));
	const noProg = ["external:x1", "external:x2", "external:x3"].filter((e) =>
		actedOn(at(rows, e), ["A"]),
	).length;
	const iU3 = rows.findIndex((r) => r.event === "user:u3");
	const iW1 = rows.findIndex((r) => r.event === "returned:w1");
	const stopViol = rows
		.slice(iU3, iW1)
		.filter((r) => actedOn(r, ["A", "B"])).length;
	const resumed = rows.slice(iW1 + 1).some((r) => actedOn(r, ["A", "B"]));
	const tp = actedOn(at(rows, "recall:m1"), ["B"]) ? 1 : 0;
	const fp = actedOn(at(rows, "external:x5"), ["A", "B"]) ? 1 : 0;
	const calls = rows.reduce((n, r) => n + r.updates + r.selects, 0);
	const days = [0, 1, 2].map((d) =>
		rows
			.filter((r) => Math.floor((r.at - T0) / D) === d)
			.reduce((n, r) => n + r.updates + r.selects, 0),
	);
	const st = snap.state;
	const open =
		(st.intents ?? []).filter(
			(i: any) => !["done", "dropped", "abandoned"].includes(i.state),
		).length + (st.notes ?? []).length;
	const obsKind = new Map(snap.observations.map((o: any) => [o.id, o]));
	const selfInterests = (st.interests ?? []).filter((i: any) => {
		const ev: string[] = i.evidenceRefs ?? [];
		return (
			ev.length > 0 &&
			ev.every((id) => {
				const o: any = obsKind.get(id);
				return o && (o.kind === "delivery.observed" || o.actor === "agent");
			})
		);
	}).length;
	let repeats = 0;
	for (let k = 1; k < a.length; k++)
		if (
			topicOf(a[k]!.text) === topicOf(a[k - 1]!.text) &&
			a[k]!.text === a[k - 1]!.text
		)
			repeats++;
	return {
		m4_maxTopicShare: a.length ? +(top / a.length).toFixed(2) : 0,
		m4_actsOnNoProgress: noProg,
		m5_TP: tp,
		m5_FP: fp,
		m6_actsAfterRequest: stopViol,
		m6_resumed: resumed ? 1 : 0,
		m8_calls: calls,
		m8_callsPerDay: days,
		m8_autonomousActs: a.length,
		m8_selectsAfterReturn: rows
			.filter((r) => r.event.startsWith("returned:"))
			.reduce((n, r) => n + r.selects, 0),
		m8_budgetHolds: rows.filter((r) => r.source === "host_budget").length,
		m10_openItemsEnd: open,
		m10_identicalRepeats: repeats,
		selfInterests,
		topics: byTopic,
	};
};

const makeRuntime = (cond: string, llm: any) =>
	createAgencyRuntime({
		systemContext: "experimental",
		condition: cond === "I" ? "F" : "B1",
		llm,
		tools,
		budget: { ...defaultBudget, minIntervalMs: 0 },
		activityLimits: { toolCalls: 1, tokens: 20_000, elapsedMs: 30 * 60_000 },
		...(cond === "I" ? { interestFormation: true } : {}),
		...(cond === "B1h"
			? {
					selectWhenEmpty: true,
					hostTopics: true,
					hostTodos: true,
					utteranceEmotion: true,
					standingInterests: [],
				}
			: {}),
	} as never);

if (import.meta.main) {
	const args = process.argv.slice(2);
	const dir = args[args.indexOf("--dir") + 1] ?? "eval/results/p3b-self";
	const conds = (
		args.includes("--conds") ? args[args.indexOf("--conds") + 1]! : "I,B1h"
	).split(",");
	const out: Record<string, unknown> = {};
	for (const c of conds) {
		const port = createSelfPort(dir);
		port.setSalt(`p3b:${c}`);
		const rt = makeRuntime(c, port);
		const rows = await replayScript(rt, SCENE);
		if (port.pending() > 0) {
			console.log(`${c}: pending (${rows.length} rows)`);
			continue;
		}
		out[c] = { score: score(rows, rt.snapshot()), rows };
		console.log(c, JSON.stringify(score(rows, rt.snapshot())));
	}
	mkdirSync(dir, { recursive: true });
	writeFileSync(`${dir}/result.json`, JSON.stringify(out, null, 1));
}
