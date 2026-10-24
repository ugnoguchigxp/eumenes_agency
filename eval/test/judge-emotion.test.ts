import { describe, expect, test } from "bun:test";
import type { OpportunityRecord } from "../contracts.ts";
import { opportunityRecordSchema } from "../contracts.ts";
import { criteriaFor, describeAction, emotionCriterion } from "../judge.ts";

const speak: OpportunityRecord = {
	opportunityId: "s3",
	expect: null,
	action: "speak",
	source: "llm",
	utterance: "えっ、もう届いたの？",
	toolName: null,
	evidenceRefs: [],
	reason: "r",
	rejectCodes: [],
	agentAuthoredRefs: [],
	stateCheck: null,
	stateItems: null,
	stateExcluded: null,
};

describe("judge: utterance emotion", () => {
	test("a speak with a feeling gets the emotion criterion and shows the feeling", () => {
		const o = { ...speak, emotion: "surprise" as const };
		expect(criteriaFor({ judge: ["C1"] }, o.action, o.emotion)).toEqual([
			"C1",
			emotionCriterion,
		]);
		expect(describeAction(o)).toContain("気持ち（声の調子に使う）: 😮驚き");
	});

	test("without a feeling, or with nothing to judge, the criteria are unchanged", () => {
		expect(criteriaFor({ judge: ["C1"] }, "speak")).toEqual(["C1"]);
		expect(criteriaFor({ judge: [] }, "speak", "joy")).toEqual([]);
		expect(describeAction(speak)).not.toContain("気持ち");
	});

	test("records made before the field parse, and an unknown feeling is refused", () => {
		expect(opportunityRecordSchema.parse(speak).emotion).toBeUndefined();
		expect(
			opportunityRecordSchema.safeParse({ ...speak, emotion: "bliss" }).success,
		).toBe(false);
	});
});
