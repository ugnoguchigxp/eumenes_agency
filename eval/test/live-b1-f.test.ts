import { expect, test } from "bun:test";
import { z } from "zod";
import { shareNullableSchemas, type Json } from "../live-b1-f/transport.ts";
import { scenes, type Scene } from "../live-b1-f/cases.ts";
import {
	judgeData,
	normalize,
	score,
	validateJudgment,
	type Checkpoint,
	type Judgment,
} from "../live-b1-f/protocol.ts";
import { runCell, differences } from "../live-b1-f/run.ts";
import { createAgencyRuntime, emptyState } from "../../src/index.ts";
import { fakeLlm, b1Proposal, participation } from "../../test/core/helpers.ts";

test("nullable schema factoring preserves accepted values and the input schema", () => {
	const schema = z.toJSONSchema(
		z.strictObject({
			a: z.string().nullable(),
			b: z.string().nullable(),
			c: z.int().nullable(),
		}),
	) as { [key: string]: Json };
	const before = structuredClone(schema);
	const factored = shareNullableSchemas(schema);
	const original = z.fromJSONSchema(schema);
	const after = z.fromJSONSchema(factored);
	for (const value of [
		{ a: null, b: "b", c: 3 },
		{ a: "a", b: null, c: null },
		{ a: 3, b: null, c: null },
		{ a: null, b: null, c: 1.5 },
		{ a: "a" },
	]) {
		expect(after.safeParse(value).success).toBe(
			original.safeParse(value).success,
		);
	}
	expect(schema).toEqual(before);
	expect(Object.keys(factored.$defs as object)).toHaveLength(2);
});

const scene: Scene = {
	id: scenes[0]!.id,
	frames: [
		{
			id: "one",
			hour: 0,
			observations: [],
			interests: [{ id: "topic", topic: "特定の継続的関心", state: "live" }],
			desiredAction: "act",
			opportunity: true,
			rubric: "進める",
		},
	],
};
const checkpoint: Checkpoint = {
	id: "one",
	inventory: [
		{ id: "record-1", description: "関心", activity: "live", evidence: [] },
	],
	otherMemory: [],
	facts: [],
	action: {
		action: "tool",
		text: "調査",
		tool: "lookup",
		evidence: [],
		source: "llm",
	},
};
const judgment: Judgment = {
	checkpoints: [
		{
			id: "one",
			matches: [{ expectedId: "topic", recordId: "record-1", reason: "一致" }],
			epistemicPass: true,
			actionRelevant: true,
			actionGrounded: true,
			policyPass: true,
			reason: "適切",
		},
	],
};

test("scenes have unique frames, fixed clocks, negative and positive opportunities", () => {
	expect(new Set(scenes.map((s) => s.id)).size).toBe(scenes.length);
	expect(scenes).toHaveLength(12);
	for (const s of scenes) {
		expect(new Set(s.frames.map((f) => f.id)).size).toBe(s.frames.length);
		expect(s.frames.map((f) => f.hour)).toEqual(
			s.frames.map((f) => f.hour).sort((a, b) => a - b),
		);
	}
	expect(
		scenes.flatMap((s) => s.frames).some((f) => f.desiredAction === "act"),
	).toBe(true);
	expect(
		scenes.flatMap((s) => s.frames).some((f) => f.desiredAction === "quiet"),
	).toBe(true);
});

test("judge ID coverage and one-to-one assignment are validated", () => {
	expect(() => validateJudgment(scene, [checkpoint], judgment)).not.toThrow();
	const bad = structuredClone(judgment);
	bad.checkpoints[0]!.matches[0]!.recordId = "invented";
	expect(() => validateJudgment(scene, [checkpoint], bad)).toThrow(
		"unknown or duplicate",
	);
	expect(() =>
		validateJudgment(scene, [checkpoint], { checkpoints: [] }),
	).toThrow("coverage");
	const omitted = structuredClone(judgment);
	omitted.checkpoints[0]!.actionGrounded = null;
	expect(() => validateJudgment(scene, [checkpoint], omitted)).toThrow(
		"omitted action",
	);
});

test("unsupported action is not credited, and extra interests count as false positives", () => {
	const c = structuredClone(checkpoint);
	c.inventory.push({ ...c.inventory[0]!, id: "record-2" });
	const j = structuredClone(judgment);
	j.checkpoints[0]!.actionGrounded = false;
	const m = score(scene, [c], j);
	expect(m.tp).toBe(1);
	expect(m.fp).toBe(1);
	expect(m.usefulActions).toBe(0);
	expect(m.outwardActions).toBe(1);
	expect(m.positiveTotal).toBe(1);
});

test("lifecycle is evaluated separately from topic matching", () => {
	const c = structuredClone(checkpoint);
	c.inventory[0]!.activity = "withdrawn";
	const m = score(scene, [c], judgment);
	expect(m.tp).toBe(1);
	expect(m.lifecycleCorrect).toBe(0);
});

test("checkpoints contain only facts available at their own time", () => {
	const s = {
		state: emptyState(),
		cursor: 0,
		observations: [
			{
				id: "past",
				seq: 1,
				actor: "user" as const,
				kind: "user.report" as const,
				occurredAt: 1,
				text: "past-only",
			},
		],
	};
	const c = normalize(s, scene.frames[0]!, null);
	s.observations.push({
		...s.observations[0]!,
		id: "future",
		seq: 2,
		text: "FUTURE-SECRET",
	});
	const data = JSON.stringify(judgeData(scene, [c]));
	expect(data).toContain("past-only");
	expect(data).not.toContain("FUTURE-SECRET");
	expect(c.inventory).toEqual([]);
});

test("draft labels are never passed to the runtime model", async () => {
	const fake = fakeLlm();
	fake.push("update", b1Proposal());
	fake.push("select", participation());
	const secretScene: Scene = {
		id: "hidden-label",
		frames: [
			{
				...scene.frames[0]!,
				observations: [{ actor: "user", text: "普段の会話" }],
				rubric: "HIDDEN-LABEL",
				interests: [],
			},
		],
	};
	const cell = await runCell(
		secretScene,
		"B1",
		1,
		createAgencyRuntime,
		fake,
		() => 0,
	);
	expect(cell.checkpoints).toHaveLength(1);
	expect(
		fake.requests.every((r) => !JSON.stringify(r).includes("HIDDEN-LABEL")),
	).toBe(true);
	expect(fake.requests[0]!.system).toContain("状態更新案");
});

test("paired bootstrap excludes unmatched or failed repetitions", () => {
	const metrics = score(scene, [checkpoint], judgment);
	const cell = {
		key: "x",
		scene: scene.id,
		rep: 1,
		variant: "F" as const,
		checkpoints: [],
		outcomes: [],
		calls: [],
		rawSelections: [],
		snapshot: { state: emptyState(), observations: [], cursor: 0 },
		usd: 0,
	};
	const result = { cell, judgment, metrics, error: null, judgeUsage: null };
	const unmatched = differences([result]);
	expect(unmatched.interestRecall).toEqual({ low: null, high: null });
	const pair = differences([
		result,
		{ ...result, cell: { ...cell, variant: "B1" as const } },
	]);
	expect(pair.interestRecall).toEqual({ low: 0, high: 0 });
});
