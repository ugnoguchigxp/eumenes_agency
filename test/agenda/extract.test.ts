/**
 * What the agent writes down from the conversation (src/agenda/extract.ts): the structured output
 * and the checks over it. A record rests on ids of the user's own words in the input; a memory
 * whose quote is not part of the words it cites is not a memory; a reference the host did not
 * show, a repeat of a record already there, goes. Scripted model; no live call.
 */
import { describe, expect, test } from "bun:test";
import type { LlmPort, LlmRequest } from "../../src/index.ts";
import {
	checkExtract,
	extractJsonSchema,
	extractRecords,
	extractSystem,
	extractSchema,
	type ExtractOutput,
	type ExtractSaid,
} from "../../src/agenda/index.ts";

const said: ExtractSaid[] = [
	{ id: "a1", who: "agent", text: "コーヒーはどうやって飲みますか？" },
	{ id: "u1", who: "user", text: "コーヒーは、ブラック派なんだよね。" },
	{ id: "u2", who: "user", text: "来週の水曜は歯医者なんだ" },
	{ id: "u3", who: "user", text: "旅行は未定だけど考えてる" },
];
const related = {
	memories: [{ ref: "m1", kind: "preference", text: "猫が好き" }],
	candidates: [{ ref: "c1", text: "夜に散歩する" }],
	plans: [{ ref: "p1", text: "水曜に歯医者", dueAt: "2026-11-25" }],
	questions: [{ attribute: "好きな色", state: "answered" as const }],
};
const none: ExtractOutput = {
	memories: [],
	candidates: [],
	plans: [],
	questions: [],
	conflicts: [],
};
const check = (out: Partial<ExtractOutput>) =>
	checkExtract({ ...none, ...out }, { said, related });
const memory = (o: Partial<ExtractOutput["memories"][number]> = {}) => ({
	kind: "preference" as const,
	semanticKey: "drink.coffee.style",
	subject: "self",
	text: "コーヒーはブラックで飲む",
	quote: "コーヒーは、ブラック派なんだよね",
	evidence: "u1",
	...o,
});

describe("memories: what the user said of themselves in their own words", () => {
	test("kept when the quote is part of the cited words (space and punctuation aside)", () => {
		const r = check({
			memories: [
				memory(),
				memory({
					text: "ブラック派",
					quote: "コーヒーは ブラック派なんだよね",
				}),
			],
		});
		expect(r.rejected).toEqual([]);
		expect(r.records.memories.map((m) => m.text)).toEqual([
			"コーヒーはブラックで飲む",
			"ブラック派",
		]);
	});

	test("a quote that is not part of the cited words is not a memory", () => {
		const r = check({
			memories: [memory({ quote: "コーヒーはミルク入りが好き" })],
		});
		expect(r.records.memories).toEqual([]);
		expect(r.rejected).toEqual(["memory:quote_mismatch"]);
	});

	test("a quote taken from other words than the one cited does not pass", () => {
		const r = check({ memories: [memory({ quote: "来週の水曜は歯医者" })] });
		expect(r.rejected).toEqual(["memory:quote_mismatch"]);
	});

	test("the agent's words, an unknown id, and an empty quote are no evidence", () => {
		const r = check({
			memories: [
				memory({ evidence: "a1", quote: "コーヒーはどうやって" }),
				memory({ evidence: "u9" }),
				memory({ quote: "、。" }),
			],
		});
		expect(r.records.memories).toEqual([]);
		expect(r.rejected).toEqual([
			"memory:no_user_evidence",
			"memory:no_user_evidence",
			"memory:quote_mismatch",
		]);
	});

	test("what the memory already holds, or was said twice in the output, is not written again", () => {
		const r = check({
			memories: [
				memory({ text: "猫が好き。", quote: "コーヒーは" }),
				memory(),
				memory(),
			],
		});
		expect(r.records.memories).toHaveLength(1);
		expect(r.rejected).toEqual(["memory:duplicate", "memory:duplicate"]);
	});

	test("an entry without text, key or subject is incomplete", () => {
		const r = check({
			memories: [
				memory({ text: " " }),
				memory({ semanticKey: "" }),
				memory({ subject: "" }),
			],
		});
		expect(r.rejected).toEqual([
			"memory:incomplete",
			"memory:incomplete",
			"memory:incomplete",
		]);
	});
});

describe("candidates: inferred, on the user's words only", () => {
	test("evidence is cut to the user's words; none left, no candidate", () => {
		const r = check({
			candidates: [
				{
					kind: "habit",
					text: "朝にコーヒーを飲む",
					evidence: ["a1", "u1", "u1"],
				},
				{ kind: "interest", text: "旅行", evidence: ["a1"] },
				{ kind: "habit", text: "夜に散歩する", evidence: ["u3"] },
			],
		});
		expect(r.records.candidates).toEqual([
			{ kind: "habit", text: "朝にコーヒーを飲む", evidence: ["u1"] },
		]);
		expect(r.rejected).toEqual([
			"candidate:no_user_evidence",
			"candidate:duplicate",
		]);
	});
});

describe("plans", () => {
	const plan = (o: Partial<ExtractOutput["plans"][number]>) => ({
		op: "add" as const,
		ref: null,
		text: "旅行を考えている。行き先は未定",
		dueAt: null,
		evidence: ["u3"],
		...o,
	});

	test("add: the date is an ISO date or date and time, or none", () => {
		const r = check({
			plans: [
				plan({ dueAt: "2026-11-25" }),
				plan({ text: "二つ目", dueAt: "2026-11-25T14:30" }),
				plan({ text: "三つ目", dueAt: "来週" }),
			],
		});
		expect(r.records.plans.map((p) => p.dueAt)).toEqual([
			"2026-11-25",
			"2026-11-25T14:30",
		]);
		expect(r.rejected).toEqual(["plan:add:bad_due"]);
	});

	test("every change rests on the user's words", () => {
		const r = check({
			plans: [
				plan({ evidence: ["a1"] }),
				plan({ op: "close", ref: "p1", evidence: [] }),
			],
		});
		expect(r.records.plans).toEqual([]);
		expect(r.rejected).toEqual([
			"plan:add:no_user_evidence",
			"plan:close:no_user_evidence",
		]);
	});

	test("update and close need a plan the host showed, and each only once", () => {
		const r = check({
			plans: [
				plan({
					op: "update",
					ref: "p1",
					text: "木曜に歯医者",
					dueAt: "2026-11-26",
					evidence: ["u2"],
				}),
				plan({ op: "close", ref: "p1", evidence: ["u2"] }),
				plan({ op: "close", ref: "p7", evidence: ["u2"] }),
				plan({
					op: "update",
					ref: "p1",
					text: null,
					dueAt: null,
					evidence: ["u2"],
				}),
			],
		});
		expect(r.records.plans).toEqual([
			{
				op: "update",
				ref: "p1",
				text: "木曜に歯医者",
				dueAt: "2026-11-26",
				evidence: ["u2"],
			},
		]);
		expect(r.rejected).toEqual([
			"plan:close:repeated_ref",
			"plan:close:unknown_ref",
			"plan:update:repeated_ref",
		]);
	});

	test("a plan already held is not added again", () => {
		const r = check({
			plans: [plan({ text: "水曜に歯医者", evidence: ["u2"] })],
		});
		expect(r.rejected).toEqual(["plan:add:duplicate"]);
	});
});

describe("question ledger and conflicts", () => {
	test("asked may rest on the agent's own question; the rest on the user's words", () => {
		const r = check({
			questions: [
				{ op: "asked", attribute: "コーヒーの飲み方", evidence: ["a1"] },
				{ op: "answered", attribute: "コーヒーの飲み方", evidence: ["u1"] },
				{ op: "declined", attribute: "年齢", evidence: ["a1"] },
				{ op: "deferred", attribute: "仕事", evidence: ["u9"] },
			],
		});
		expect(r.records.questions.map((q) => [q.op, q.evidence])).toEqual([
			["asked", ["a1"]],
			["answered", ["u1"]],
		]);
		expect(r.rejected).toEqual([
			"question:declined:no_evidence",
			"question:deferred:no_evidence",
		]);
	});

	test("a conflict names a record the host showed and a word of the user's", () => {
		const r = check({
			conflicts: [
				{ with: "m1", evidence: "u1", note: "前は猫が好きと言っていた" },
				{ with: "m9", evidence: "u1", note: "x" },
				{ with: "c1", evidence: "a1", note: "x" },
				{ with: "p1", evidence: "u2", note: " " },
			],
		});
		expect(r.records.conflicts).toEqual([
			{ with: "m1", evidence: "u1", note: "前は猫が好きと言っていた" },
		]);
		expect(r.rejected).toEqual([
			"conflict:unknown_ref",
			"conflict:no_user_evidence",
			"conflict:empty",
		]);
	});
});

describe("the output's schema", () => {
	test("the JSON Schema names the five lists and takes nothing else", () => {
		const schema = extractJsonSchema as {
			type: string;
			additionalProperties: boolean;
			required: string[];
			properties: Record<string, { type: string; maxItems?: number }>;
		};
		expect(schema.type).toBe("object");
		expect(schema.additionalProperties).toBe(false);
		expect(schema.required).toEqual([
			"memories",
			"candidates",
			"plans",
			"questions",
			"conflicts",
		]);
		expect(
			Object.values(schema.properties).every((p) => p.type === "array"),
		).toBe(true);
	});

	test("an entry with a field the schema does not name is refused", () => {
		expect(() =>
			extractSchema.parse({
				...none,
				memories: [{ ...memory(), polarity: "affirmed" }],
			}),
		).toThrow();
	});
});

/** A model that answers with `answers` in turn and keeps what it was asked. */
const scripted = (...answers: Partial<ExtractOutput>[]) => {
	const asked: { system: string; prompt: string }[] = [];
	const llm: LlmPort = {
		complete<T>(req: LlmRequest<T>) {
			asked.push({ system: req.system, prompt: req.prompt });
			return Promise.resolve({
				value: req.schema.parse({ ...none, ...answers.shift() }),
				model: "scripted",
				inputTokens: 10,
				outputTokens: 10,
				cacheReadTokens: 0,
				latencyMs: 1,
			});
		},
	};
	return { llm, asked };
};
const run = (llm: LlmPort, lines: readonly ExtractSaid[] = said) =>
	extractRecords({
		llm,
		said: lines,
		related,
		clock: "2026/11/22(日) 20:00",
		at: 0,
		signal: new AbortController().signal,
	});

describe("one pass", () => {
	test("no words of the user's in the input: no call, nothing to write", async () => {
		const m = scripted();
		const r = await run(m.llm, [said[0]!]);
		expect(m.asked).toHaveLength(0);
		expect(r).toMatchObject({ ok: true, usage: null, rejected: [] });
	});

	test("every line after the position is read: no cut to the latest eight", async () => {
		const many: ExtractSaid[] = Array.from({ length: 30 }, (_, i) => ({
			id: `x${i}`,
			who: i % 3 === 0 ? ("agent" as const) : ("user" as const),
			text: `発言${i}`,
		}));
		const m = scripted();
		await run(m.llm, many);
		const data = JSON.parse(m.asked[0]!.prompt) as {
			conversation: { id: string }[];
		};
		expect(data.conversation.map((c) => c.id)).toEqual(many.map((c) => c.id));
	});

	test("the records already held come first, the words next, `now` last", async () => {
		const m = scripted();
		await run(m.llm);
		const data = JSON.parse(m.asked[0]!.prompt) as Record<string, unknown>;
		expect(Object.keys(data)).toEqual(["related", "conversation", "now"]);
		expect(data["now"]).toBe("2026/11/22(日) 20:00");
		expect(data["related"]).toEqual({
			memories: [{ ref: "m1", kind: "preference", text: "猫が好き" }],
			candidates: [{ ref: "c1", text: "夜に散歩する" }],
			plans: [{ ref: "p1", text: "水曜に歯医者", dueAt: "2026-11-25" }],
			questions: [{ attribute: "好きな色", state: "answered" }],
		});
	});

	test("what passes the checks comes back with what was dropped and why", async () => {
		const m = scripted({
			memories: [memory(), memory({ quote: "ない言葉" })],
			plans: [
				{
					op: "add",
					ref: null,
					text: "歯医者",
					dueAt: "2026-11-25",
					evidence: ["u2"],
				},
			],
		});
		const r = await run(m.llm);
		expect(r).toMatchObject({
			ok: true,
			rejected: ["memory:quote_mismatch"],
			usage: { model: "scripted" },
		});
		if (!r.ok) throw new Error("unreachable");
		expect(r.records.memories).toHaveLength(1);
		expect(r.records.plans).toHaveLength(1);
	});

	test("the instructions bar sensitive facts unless the user asked to be remembered, and give no example", async () => {
		const m = scripted();
		await run(m.llm);
		const system = m.asked[0]!.system;
		expect(system).toContain("機微な情報");
		expect(system).toContain("「覚えて」");
		expect(system).not.toContain("例:");
	});

	test("a failed or called-off call tells the host to keep its position", async () => {
		const failing: LlmPort = {
			complete: () => Promise.reject(new Error("down")),
		};
		expect(await run(failing)).toEqual({ ok: false, reason: "failed" });
		const aborted = new AbortController();
		aborted.abort();
		expect(
			await extractRecords({
				llm: scripted().llm,
				said,
				clock: null,
				at: 0,
				signal: aborted.signal,
			}),
		).toEqual({ ok: false, reason: "aborted" });
	});
});

test("the writer is told not to record a request to operate the memory (forget, correct, remember, do not bring up, take back)", () => {
	const line = extractSystem
		.split("\n")
		.find((l) => l.includes("記憶の操作") && l.includes("記録しません"));
	expect(line).toBeDefined();
	for (const word of [
		"覚えて",
		"忘れて",
		"訂正して",
		"話題にしないで",
		"取り消して",
	])
		expect(line).toContain(word);
});
