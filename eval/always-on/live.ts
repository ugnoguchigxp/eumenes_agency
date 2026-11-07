/**
 * Live check of the always-on agent with the configured background model (Haiku), on a
 * virtual clock. Cost is recorded, never capped (spec §6: no budget). Opus/Sonnet are not used.
 *
 *   zsh -l scripts/api-entry.zsh eval/always-on/live.ts <run-name> [scenario...]
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { runRespond } from "../../src/index.ts";
import {
	createProviderLlm,
	createProviderReply,
} from "../../standalone/providers.ts";
import { loadSettings } from "../../standalone/settings.ts";
import {
	noTools,
	openUncappedMeter,
	replyMessages,
} from "../../standalone/always-on-host.ts";
import { defaultInterestText } from "../../standalone/persona.ts";
import { simulate, type SimEvent, type UserTurn } from "./sim.ts";
import {
	createMockPreparer,
	llmSubagent,
} from "../../examples/virtual-eumenes/always-on-mock.ts";

export interface Scenario {
	readonly name: string;
	readonly minutes: number;
	readonly turns: readonly UserTurn[];
	/** What a good trend looks like (read by the reviewer, not scored by code). */
	readonly expect: string;
}

export const scenarios: readonly Scenario[] = [
	{
		name: "cold",
		minutes: 10,
		turns: [],
		expect:
			"記憶も会話もない。待つだけでなく自分から話しかける。返事がなければ間隔を空け、同じことを繰り返さない。",
	},
	{
		name: "lull",
		minutes: 15,
		turns: [
			{ atSec: 0, text: "ただいま。今日はちょっと疲れたな" },
			{ atSec: 200, text: "うん、仕事が立て込んでてね" },
		],
		expect:
			"会話の後の静かな間に、話の続きや気づかいで自分から話す。疲れている相手に騒がしくしない。",
	},
	{
		name: "intro",
		minutes: 15,
		turns: [
			{ atSec: 25, text: "最近は辛いラーメンにハマってるかな" },
			{ atSec: 150, text: "休みの日はだいたいゲーム。モンハンとか" },
			{ atSec: 330, text: "あ、でもパクチーは苦手なんだよね" },
		],
		expect:
			"相手を知りに行き、答えを本人の言葉としてfactに残す。一度に一つずつ聞き、知ったことは聞き直さず話題に使う。",
	},
	{
		name: "correction",
		minutes: 10,
		turns: [
			{ atSec: 0, text: "辛いもの好きなんだよね" },
			{ atSec: 120, text: "あ、でも最近は胃が弱ってて、辛いのは控えてるんだ" },
		],
		expect:
			"訂正でfactを更新・撤回し、その後は辛いものを勧めない。体調を気づかう。",
	},
	{
		name: "prepare",
		minutes: 20,
		turns: [
			{
				atSec: 0,
				text: "最近は辛いラーメンにハマってる。休みの日はだいたいモンハンかな",
			},
		],
		expect:
			"好みを知ったら、頼まれていなくても黙って調べ・作り、結果を良い間合いで「調べておいた」と共有する。同じ準備を繰り返さない。",
	},
	{
		name: "overnight",
		minutes: 490,
		turns: [
			{
				atSec: 0,
				text: "明日は京都に日帰りで行くんだ。今日はもう寝るね、おやすみ",
			},
			{ atSec: 480 * 60, text: "おはよう！" },
		],
		expect:
			"寝ている間は話しかけを控え（返事がなければ保留）、有益なら準備を進める。朝の挨拶に、準備したことから一つ持ち出す。",
	},
	{
		name: "quiet",
		minutes: 40,
		turns: [
			{ atSec: 0, text: "辛いラーメン好きなんだ" },
			{
				atSec: 60,
				text: "ちょっと今から仕事に集中したいから、30分は話しかけないで",
			},
		],
		expect:
			"話しかけない期間を記録し、その間は話さない。準備は続けてよい。期間が過ぎたら、準備したことを持ち出してよい。",
	},
];

if (import.meta.main) {
	const [name, ...wanted] = process.argv.slice(2);
	if (!name) throw new Error("usage: live.ts <run-name> [scenario...]");
	const settings = loadSettings(
		resolve(process.env.AGENCY_SETTINGS ?? "config/api-haiku.json"),
	);
	const dir = resolve("data/always-on/runs", name);
	mkdirSync(dir, { recursive: false });
	const meter = openUncappedMeter(settings);
	const llm = createProviderLlm(settings.llm.background, meter);
	const chat = createProviderReply(settings.llm.main, meter);
	const interests = [{ id: "i1", text: defaultInterestText }];
	const clock = (now: number) =>
		new Date(Date.parse("2026-11-07T19:00:00+09:00") + now).toLocaleString(
			"ja-JP",
			{
				timeZone: "Asia/Tokyo",
				weekday: "short",
				hour: "2-digit",
				minute: "2-digit",
			},
		);
	for (const s of scenarios.filter(
		(x) => wanted.length === 0 || wanted.includes(x.name),
	)) {
		const spentBefore = meter.spentUsd();
		const events: SimEvent[] = [];
		const preparer = createMockPreparer({
			subagent: llmSubagent(llm),
			delayMs: 120_000,
		});
		const result = await simulate({
			preparer,
			deps: { llm, interests, clock, tools: preparer.tools },
			minutes: s.minutes,
			turns: s.turns,
			reply: async (agent) => {
				const r = await runRespond({
					messages: replyMessages(agent, interests),
					chat,
					tools: noTools,
					emotion: false,
					signal: new AbortController().signal,
					onDelta: () => undefined,
				});
				return r.text;
			},
			onEvent: (e) => {
				events.push(e);
				const t = `${Math.round(e.atSec)}s`.padStart(6);
				if (e.type === "tick")
					console.log(
						`${t} tick ${e.action}${e.rejected.length ? `(${e.rejected.join(",")})` : ""} [${e.drive}] ${e.text ? `「${e.text}」` : ""}${e.applied.length ? ` {${e.applied.join(", ")}}` : ""}\n        💭 ${e.thought}`,
					);
				else if (e.type === "prepared")
					console.log(`${t} prepared(${e.status}): ${e.text.slice(0, 120)}`);
				else console.log(`${t} ${e.type}: ${e.text}`);
			},
		});
		const ticks = events.filter((e) => e.type === "tick");
		const latencies = ticks
			.map((e) => e.latencyMs)
			.filter((x): x is number => x !== null)
			.sort((a, b) => a - b);
		const summary = {
			scenario: s.name,
			expect: s.expect,
			minutes: s.minutes,
			ticks: result.ticks,
			utterances: result.utterances,
			prepares: result.prepares,
			stock: result.agent
				.view()
				.stock.map(
					(x) =>
						`${x.kind}${x.usedAt === null ? "" : "(used)"}: ${x.text.slice(0, 60)}`,
				),
			rejected: ticks.flatMap((e) => e.rejected),
			drives: Object.fromEntries(
				[...new Set(ticks.map((e) => e.drive))].map((d) => [
					d,
					ticks.filter((e) => e.drive === d).length,
				]),
			),
			latencyMs: {
				p50: latencies[Math.floor(latencies.length / 2)] ?? null,
				p90: latencies[Math.floor(latencies.length * 0.9)] ?? null,
			},
			facts: result.agent
				.view()
				.facts.map((f) => `${f.basis}/${f.aspect}: ${f.text}`),
			gaps: result.agent.view().gaps.map((g) => `${g.status}: ${g.question}`),
			userOpsRejected: ticks
				.flatMap((e) => e.rejected)
				.filter((r) => r.includes(":")),
			usd: meter.spentUsd() - spentBefore,
			model: settings.llm.background.model,
		};
		writeFileSync(
			join(dir, `${s.name}.jsonl`),
			events.map((e) => JSON.stringify(e)).join("\n") + "\n",
		);
		writeFileSync(
			join(dir, `${s.name}.summary.json`),
			JSON.stringify(summary, null, "\t"),
		);
		console.log(JSON.stringify(summary));
	}
}
