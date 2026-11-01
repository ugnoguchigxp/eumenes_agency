import { expect, test } from "bun:test";
import {
	ActivityBudget,
	defaultActivityLimits,
} from "../../src/application/activity-budget.ts";
import { createBudget } from "../../src/application/budget.ts";
import { createAgencyRuntime } from "../../src/application/runtime.ts";
import { defaultBudget } from "../../src/contracts/runtime.ts";
import { fakeLlm } from "./helpers.ts";

const deps = () => ({
	condition: "F" as const,
	systemContext: "experimental" as const,
	llm: fakeLlm(),
	tools: [],
});

test.each([
	{ maxCallsPerWindow: defaultBudget.maxCallsPerWindow + 1 },
	{ windowMs: defaultBudget.windowMs - 1 },
	{ minIntervalMs: defaultBudget.minIntervalMs - 1 },
])("shared call meter cannot relax the configured budget: %j", (overrides) => {
	expect(() =>
		createAgencyRuntime({
			...deps(),
			callBudgetMeter: createBudget({ ...defaultBudget, ...overrides }),
		}),
	).toThrow("callBudgetMeter");
});

test.each([
	{ toolCalls: defaultActivityLimits.toolCalls + 1 },
	{ tokens: defaultActivityLimits.tokens + 1 },
	{ elapsedMs: defaultActivityLimits.elapsedMs + 1 },
	{ toolCalls: NaN },
])(
	"shared activity meter cannot relax the configured budget: %j",
	(overrides) => {
		expect(() =>
			createAgencyRuntime({
				...deps(),
				activityBudgetMeter: new ActivityBudget({
					...defaultActivityLimits,
					...overrides,
				}),
			}),
		).toThrow("activityBudgetMeter");
	},
);

test("shared meters respect explicit limits rather than only defaults", () => {
	expect(() =>
		createAgencyRuntime({
			...deps(),
			budget: { ...defaultBudget, maxCallsPerWindow: 1 },
			callBudgetMeter: createBudget(defaultBudget),
		}),
	).toThrow("callBudgetMeter");
	expect(() =>
		createAgencyRuntime({
			...deps(),
			activityLimits: { ...defaultActivityLimits, tokens: 100 },
			activityBudgetMeter: new ActivityBudget(),
		}),
	).toThrow("activityBudgetMeter");
});

test("equal or stricter shared limits remain usable and cannot drift with input mutation", () => {
	const input = { ...defaultActivityLimits, tokens: 10 };
	const activity = new ActivityBudget(input);
	input.tokens = 100_000;
	const calls = createBudget({ ...defaultBudget, maxCallsPerWindow: 1 });
	expect(() =>
		createAgencyRuntime({
			...deps(),
			callBudgetMeter: calls,
			activityBudgetMeter: activity,
		}),
	).not.toThrow();
	calls.record(0);
	expect(calls.check(1, false)).toBe("skipped:budget");
	activity.start("i1", 0);
	expect(activity.spend("i1", 0, { tokens: 11 })).toBe("tokens");
});
