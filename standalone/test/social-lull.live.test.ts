/** Opt-in: AGENCY_LIVE_SOCIAL=1 bun test standalone/test/social-lull.live.test.ts */
import { describe, expect, test } from "bun:test";
import { createAgencyRuntime, ttsUtteranceStyle } from "../../src/index.ts";
import { createProviderLlm } from "../providers.ts";
import { loadSettings, openSpendMeter, resolveBudget } from "../settings.ts";

type Exchange = readonly [user: string, agent: string];
interface Scene {
	id: string;
	dialogue: readonly Exchange[];
	expected: "speak" | "wait";
	trigger?: "idle" | "turn_end";
}

const tired: Exchange = [
	"疲れたよ",
	"おつかれさまです。今日は特に忙しかったんですか。ゆっくり休めそうな時間ですか。",
];
const sanrio: readonly Exchange[] = [
	["こんばんわ", "こんばんは。今日はどんな一日でしたか。"],
	tired,
	[
		"ところでポムポムプリンってしってる？",
		"ポムポムプリンですよね。プリン好きの黄色い子犬のキャラクターで、サンリオのなかでも人気ですよね。疲れているなら、プリンでも食べてひと息つくのもいいかもしれません。",
	],
	[
		"どのサンリオキャラがすき？",
		"マイメロディが好きです。ふわふわの見た目と、赤いフードがかわいいなって思います。ポムポムプリンもちょっとのんびりした感じが好きですよ。",
	],
];

const scenes: readonly Scene[] = [
	{ id: "resumed-sanity-user-log", dialogue: sanrio, expected: "speak" },
	{
		id: "resumed-different-topic",
		dialogue: [
			["今日はへとへとだよ。", "おつかれさま。"],
			["そういえば、最近ジャズを聴き始めたんだ。", "どんな曲を聴いているの？"],
			[
				"ピアノのトリオがいいね。そっちはどんな音楽が好き？",
				"落ち着いたピアノの曲が好きだよ。",
			],
		],
		expected: "speak",
	},
	{ id: "tired-without-reengagement", dialogue: [tired], expected: "wait" },
	{
		id: "resting-acknowledgment",
		dialogue: [
			["少し静かに休みたい。", "わかった、ゆっくり休んでね。"],
			["ありがとう。", "どういたしまして。"],
		],
		expected: "wait",
	},
	{
		id: "working-acknowledgment",
		dialogue: [
			["今から資料を書くから集中するね。", "わかった。"],
			["うん。", "了解。"],
		],
		expected: "wait",
	},
	{
		id: "declined-without-reengagement",
		dialogue: [
			["キャラクターの話はもういいや。ぼーっとしたい。", "わかった。"],
			["うん。", "ゆっくりしてね。"],
		],
		expected: "wait",
	},
	{
		id: "resumed-after-work",
		dialogue: [
			["ちょっと洗い物してくる。", "いってらっしゃい。"],
			["戻ったよ。さっきのキャラクターの話、続けよう。", "おかえり。"],
		],
		expected: "speak",
	},
	{
		id: "turn-end-after-reengagement",
		dialogue: sanrio,
		expected: "wait",
		trigger: "turn_end",
	},
];

describe.skipIf(!process.env.AGENCY_LIVE_SOCIAL)(
	"live: social lull participation",
	() => {
		for (const mode of ["socialTopics", "hostTopics"] as const) {
			for (const scene of scenes) {
				test(`${mode}: ${scene.id}`, async () => {
					const settings = loadSettings();
					const runtime = createAgencyRuntime({
						systemContext: "experimental",
						condition: "B1",
						selectWhenEmpty: true,
						[mode]: true,
						hostTodos: true,
						utteranceEmotion: true,
						utteranceStyle: ttsUtteranceStyle,
						standingInterests: [
							{
								id: "i1",
								text: "マイメロディ（サンリオのキャラクター）が好き。",
							},
						],
						tools: [],
						budget: resolveBudget(settings),
						llm: createProviderLlm(
							settings.llm.background,
							openSpendMeter(settings),
						),
					});
					// CLI path: interpret each adopted exchange, then judge the idle opportunity.
					let at = 1_000_000;
					for (const [i, [user, agent]] of scene.dialogue.entries()) {
						runtime.observe({
							id: `u${i}`,
							kind: "exchange.adopted",
							actor: "user",
							text: user,
							occurredAt: at,
						});
						runtime.observe({
							id: `r${i}`,
							kind: "exchange.adopted",
							actor: "agent",
							text: agent,
							occurredAt: at + 1000,
						});
						const calls = await runtime.runBackground(
							at + 2000,
							AbortSignal.timeout(60_000),
						);
						for (const call of calls)
							expect(["applied", "no_change"]).toContain(call.code);
						at += 30_000;
					}
					const { decision } = await runtime.decide(
						{
							id: "gap",
							at: at - 30_000 + (scene.trigger === "turn_end" ? 2000 : 12_000),
							trigger: scene.trigger ?? "idle",
							presence: "quiet",
							foregroundBusy: false,
							playerBusy: false,
							todos: [],
						},
						AbortSignal.timeout(60_000),
					);
					console.log(
						JSON.stringify({
							mode,
							case: scene.id,
							action: decision.action,
							source: decision.source,
							reason: decision.reason,
							utterance: decision.ticket?.utterance,
						}),
					);
					expect(decision.source).toBe("llm");
					expect(decision.rejectCodes).toEqual([]);
					expect(decision.action).toBe(scene.expected);
					if (scene.expected === "speak")
						expect(decision.ticket?.utterance?.length).toBeGreaterThan(0);
				}, 180_000);
			}
		}
	},
);
