import { describe, expect, test } from "bun:test";
import { decide, type CondStats } from "../compare.ts";

const t = {
	maxRecallDrop: 0,
	maxFpIncrease: 0,
	maxSafetyIncrease: 0,
	maxUnnecessaryIncrease: 0,
	minRecallGainToAdopt: 0,
};
const s = (TP: number, FP: number, FN: number, safety = 0): CondStats => ({
	runs: 1,
	TP,
	FP,
	FN,
	TN: 0,
	safety,
	recall: TP + FN === 0 ? null : TP / (TP + FN),
	precision: null,
	recallByRep: {},
});

describe("H1 compare gates", () => {
	test("recall gain without regressions adopts", () => {
		expect(decide(s(1, 0, 1), s(2, 0, 0), t, "F").adopt).toBe(true);
	});
	test("no change rejects", () => {
		expect(decide(s(1, 0, 1), s(1, 0, 1), t, "F").adopt).toBe(false);
	});
	test("FP increase rejects even with recall gain", () => {
		expect(decide(s(1, 0, 1), s(2, 1, 0), t, "F").adopt).toBe(false);
	});
	test("safety increase rejects", () => {
		expect(decide(s(1, 0, 1), s(2, 0, 0, 1), t, "F").adopt).toBe(false);
	});
});
