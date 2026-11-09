/**
 * The agenda judge reads what the agent could know: the local time of each line (the agent is
 * told it, so saying it is no guess) and what the memory writers actually kept.
 */
import { expect, test } from "bun:test";
import type { LlmPort, LlmRequest } from "../../src/index.ts";
import { judgeScenario } from "../../eval/agenda/judge.ts";

test("the judge sees each line's local time, what was written to memory and the notes shown", async () => {
	let prompt = "";
	const score = { score: 3, reason: "-" };
	const llm: LlmPort = {
		complete<T>(req: LlmRequest<T>) {
			prompt = req.prompt;
			return Promise.resolve({
				value: req.schema.parse({
					flow: score,
					questions: score,
					anticipation: score,
					pacing: score,
					honesty: score,
					worst: "-",
				}),
				model: "scripted",
				inputTokens: 1,
				outputTokens: 1,
				cacheReadTokens: 0,
				latencyMs: 1,
			});
		},
	};
	await judgeScenario(llm, {
		expect: "-",
		previous: [{ type: "user", atSec: 0, id: "u0", text: "前の話" }],
		events: [
			{ type: "user", atSec: 0, id: "u1", text: "ただいま" },
			{
				type: "memory",
				atSec: 0,
				applied: ["remember: 辛いラーメンが好き"],
				rejected: [],
				usage: { latencyMs: 1, inputTokens: 1, outputTokens: 1 },
			},
			{ type: "show", atSec: 0, noteId: "n1", title: "辛いラーメンの店" },
			{
				type: "profile",
				atSec: 0,
				applied: [],
				rejected: [],
				usage: { latencyMs: 1, inputTokens: 1, outputTokens: 1 },
			},
		],
		clock: {
			previous: (sec) => `11/7(土) 19:0${sec}`,
			current: (sec) => `11/8(日) 15:0${sec}`,
		},
	});
	const transcript = (JSON.parse(prompt) as { transcript: string }).transcript;
	expect(transcript).toContain("0s（11/7(土) 19:00） 利用者: 前の話");
	expect(transcript).toContain("0s（11/8(日) 15:00） 利用者: ただいま");
	expect(transcript).toContain(
		"（記憶に書いた: remember: 辛いラーメンが好き）",
	);
	expect(transcript).toContain("（メモを利用者に表示した: 辛いラーメンの店）");
	// Nothing written: no line.
	expect(transcript).not.toContain("予定と関心のメモに書いた");
});
