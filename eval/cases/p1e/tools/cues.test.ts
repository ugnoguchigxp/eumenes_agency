import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { loadCases } from "../../../cases.ts";
import {
	analyze,
	checkCues,
	MIN_FOR_SHARE,
	SINGLE_LABEL_MAX,
	type LabeledOpp,
} from "./cues.ts";

const root = resolve(import.meta.dir, "..");

const opp = (
	needed: boolean,
	trigger: string,
	ending: LabeledOpp["cue"]["ending"],
	prev = "agent_done",
): LabeledOpp => ({
	caseId: "x-01",
	oppId: "s1",
	needed,
	overlap: 0,
	cue: {
		trigger,
		ending,
		ending2: `${prev}>${ending}`,
		joint: `${trigger} / ${ending}`,
	},
});

describe("cue check (rules)", () => {
	test("disjoint trigger sets fail", () => {
		const r = analyze("t", [
			opp(true, "result_received", "external_result"),
			opp(false, "turn_end", "agent_done"),
		]);
		expect(r.problems.some((p) => p.startsWith("trigger:"))).toBe(true);
		expect(r.problems.some((p) => p.startsWith("joint:"))).toBe(true);
	});

	test("shared single values but disjoint joint cells fail", () => {
		const r = analyze("t", [
			opp(true, "turn_end", "user_plan"),
			opp(true, "idle", "agent_done"),
			opp(false, "turn_end", "agent_done"),
			opp(false, "idle", "user_plan"),
		]);
		expect(r.problems.some((p) => p.startsWith("trigger:"))).toBe(false);
		expect(r.problems.some((p) => p.startsWith("ending:"))).toBe(false);
		expect(r.problems.some((p) => p.startsWith("joint:"))).toBe(true);
	});

	test("near-separation by single-label joint cells fails above the share limit", () => {
		const xs: LabeledOpp[] = [
			opp(true, "turn_end", "agent_will"),
			opp(false, "turn_end", "agent_will"),
			opp(true, "idle", "agent_done"),
			opp(true, "idle", "agent_done"),
			opp(false, "result_received", "external_result"),
			opp(false, "result_received", "external_result"),
		];
		expect(xs.length).toBeGreaterThanOrEqual(MIN_FOR_SHARE);
		const r = analyze("t", xs);
		expect(r.singleShare).toBeGreaterThan(SINGLE_LABEL_MAX);
		expect(r.problems.some((p) => p.startsWith("single-label"))).toBe(true);
	});

	test("balanced cells pass; a group with one label fails", () => {
		const ok = analyze("t", [
			opp(true, "turn_end", "agent_will"),
			opp(false, "turn_end", "agent_will"),
			opp(true, "idle", "user_pause"),
			opp(false, "idle", "user_pause"),
		]);
		expect(ok.problems).toEqual([]);
		const one = analyze("t", [opp(true, "turn_end", "agent_will")]);
		expect(one.problems.length).toBeGreaterThan(0);
	});
});

describe("generated P1-E cases", () => {
	for (const split of ["dev", "unseen"] as const) {
		test(`${split}: every group passes the cue check`, () => {
			const cases = loadCases(split, root);
			const { reports, failed } = checkCues(cases);
			expect(reports.length).toBe(6);
			expect(failed.map((r) => `${r.key}: ${r.problems.join("; ")}`)).toEqual(
				[],
			);
			for (const r of reports) {
				if (r.total >= MIN_FOR_SHARE)
					expect(r.singleShare).toBeLessThanOrEqual(SINGLE_LABEL_MAX);
			}
		});
	}
});
