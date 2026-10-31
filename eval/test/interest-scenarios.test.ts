import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Structural validation of the S2 formation-scenario asset
 * (spec/autonomous-interest-design.md §10 S2). Expectations and scoring live in
 * the external harness; this test only pins the asset's shape so edits fail here
 * instead of mid-measurement.
 */
const suite = JSON.parse(
	readFileSync(join(import.meta.dir, "..", "interest", "scenarios.json"), "utf8"),
) as {
	suiteId: string;
	scenarios: {
		id: string;
		title: string;
		conditions: string[];
		seed: {
			observations: { actor: string; kind: string; text: string }[];
			ops: { op: string }[];
		} | null;
		steps: {
			atMin: number;
			observations: { actor: string; kind: string; text: string }[];
		}[];
	}[];
};

describe("interest formation scenarios", () => {
	test("suite shape is valid and ids are unique", () => {
		expect(suite.suiteId).toBe("interest-formation-ja-v1");
		expect(suite.scenarios.length).toBeGreaterThanOrEqual(6);
		const ids = suite.scenarios.map((s) => s.id);
		expect(new Set(ids).size).toBe(ids.length);
		for (const s of suite.scenarios) {
			expect(s.conditions.length).toBeGreaterThan(0);
			expect(s.steps.length).toBeGreaterThan(0);
			for (const step of s.steps) {
				expect(step.observations.length).toBeGreaterThan(0);
				for (const o of step.observations) {
					expect(["user", "agent"]).toContain(o.actor);
					expect(o.text.length).toBeGreaterThan(0);
				}
			}
			if (s.seed) {
				expect(s.seed.observations.length).toBeGreaterThan(0);
				expect(s.seed.ops.length).toBeGreaterThan(0);
			}
		}
	});
});
