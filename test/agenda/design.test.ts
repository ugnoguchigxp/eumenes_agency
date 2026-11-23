import { expect, test } from "bun:test";
import {
	createDesignGenerator,
	validateDesign,
	type DesignInput,
} from "../../runtime/agenda/index.ts";

const input: DesignInput = {
	purpose: "既存の入口で集計結果を確認する",
	workspace: "/shared",
	analysis: "集計の入口を調べた",
	brief: { task: "集計の確認", prompt: "固定データで結果を確認する" },
	memory: [{ id: "m1", text: "既定のフィルターを使う" }],
	notes: [
		{
			id: "n1",
			title: "集計",
			summary: "入口",
			markdown: "集計の入口の記録",
			at: 1,
			refs: [],
		},
	],
};
const ready = {
	status: "ready" as const,
	title: "集計",
	summary: "確認方法",
	markdown: "集計の確認手順",
	sources: ["note:n1", "memory:m1"],
	missing: null,
};

test("the published generator uses injected inference without a stored goal", async () => {
	const generate = createDesignGenerator(async (request) => {
		expect(JSON.parse(request.data)).toEqual(input);
		expect(request.schema.safeParse(ready).success).toBe(true);
		return ready;
	});
	expect(await generate(input, new AbortController().signal)).toEqual(ready);
});

test("the published validation only accepts available evidence and complete status shapes", () => {
	for (const ref of ["note:absent", "memory:absent", "world:n1"])
		expect(() => validateDesign(input, { ...ready, sources: [ref] })).toThrow(
			"design_source_not_available",
		);
	for (const update of [
		{ markdown: null },
		{ missing: "不足" },
		{ status: "blocked", missing: "不足" },
		{ status: "blocked", markdown: null },
	])
		expect(() => validateDesign(input, { ...ready, ...update })).toThrow(
			"design_status_invalid",
		);
	expect(() =>
		validateDesign(input, { ...ready, markdown: "a".repeat(4001) }),
	).toThrow();
	expect(
		validateDesign(input, {
			...ready,
			status: "blocked",
			markdown: null,
			missing: "不足",
		}).missing,
	).toBe("不足");
});
