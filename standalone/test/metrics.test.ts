import { expect, test } from "bun:test";
import { parseFeedback, summarizeUsage } from "../metrics.ts";
test("explicit feedback can be revised without inflating intervention counts", () => {
	const s = summarizeUsage([
		[
			{ type: "session", at: 0 },
			{ type: "proactive", ticketId: "t", text: "private" },
			{ type: "feedback", target: "t", rating: "useful" },
			{ type: "feedback", target: "t", rating: "intrusive" },
			{ type: "feedback", target: "unknown", rating: "useful" },
			{ type: "reply", latencyMs: 20 },
			{ type: "reply", latencyMs: 40 },
			null,
		],
	]);
	expect(s.labeledInterventions).toBe(1);
	expect(s.labels).toEqual({ useful: 0, intrusive: 1, missed: 0 });
	expect(s.replyLatency).toEqual({ n: 2, medianMs: 20, p95Ms: 40 });
	expect(s.malformed).toBe(2);
	expect(JSON.stringify(s)).not.toContain("private");
	expect(parseFeedback("/feedback useful 助かった")).toEqual({
		rating: "useful",
		note: "助かった",
	});
	expect(parseFeedback("助かった")).toBeNull();
});
