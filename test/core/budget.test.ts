import { describe, expect, test } from "bun:test";
import { createBudget } from "../../src/application/budget.ts";
import { defaultBudget } from "../../src/contracts/runtime.ts";

const cfg = {
	...defaultBudget,
	maxCallsPerWindow: 2,
	windowMs: 1000,
	minIntervalMs: 100,
};

describe("budget", () => {
	test("rolling window", () => {
		const b = createBudget(cfg);
		b.record(0);
		b.record(200);
		expect(b.check(300, false)).toBe("skipped:budget");
		expect(b.remaining(300)).toBe(0);
		// the first call leaves the window
		expect(b.check(1001, false)).toBe("ok");
		expect(b.remaining(1001)).toBe(1);
		expect(b.check(1201, false)).toBe("ok");
		expect(b.remaining(1201)).toBe(2);
	});

	test("minimum interval applies only when spaced", () => {
		const b = createBudget(cfg);
		b.record(0);
		expect(b.check(50, true)).toBe("skipped:interval");
		expect(b.check(50, false)).toBe("ok");
		expect(b.check(100, true)).toBe("ok");
	});
});
