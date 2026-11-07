import { describe, expect, test } from "bun:test";
import { funnel } from "../../eval/always-on/funnel.ts";
import { REPEAT_SIMILARITY, similarity } from "../../eval/always-on/metrics.ts";

describe("always-on measurement", () => {
	test("repetition: paraphrases score above the threshold, other topics far below", () => {
		expect(
			similarity(
				"土曜の夜って、なんだか落ち着いた時間ですよね。",
				"土曜の夜って、なんだか一日の終わりがほっとしますよね。",
			),
		).toBeGreaterThanOrEqual(REPEAT_SIMILARITY);
		expect(
			similarity(
				"パクチーの話、香りが苦手な人は多いですよね。",
				"モンハンは装備を組むところから楽しむ人なんですね。",
			),
		).toBeLessThan(0.1);
	});

	test("CLI logs: an own utterance answered within two minutes, and feedback by kind", () => {
		const line = (o: Record<string, unknown>) => JSON.stringify(o);
		const log = [
			line({ at: 0, type: "session" }),
			line({ at: 1_000, type: "tick", action: "speak" }),
			line({ at: 1_000, type: "speak", text: "ねえ" }),
			line({ at: 60_000, type: "user", text: "なに？" }),
			line({ at: 70_000, type: "tick", action: "speak" }),
			line({ at: 70_000, type: "speak", text: "あのね" }),
			line({ at: 400_000, type: "user", text: "ごめん、いなかった" }),
			line({ at: 401_000, type: "feedback", kind: "useful" }),
		].join("\n");
		const f = funnel([log]);
		expect(f.ownUtterances).toBe(2);
		expect(f.answered).toBe(1);
		expect(f.feedback).toEqual({ useful: 1 });
	});
});
