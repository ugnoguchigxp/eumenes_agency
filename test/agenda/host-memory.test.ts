/**
 * The real eumenes_memory (the vendored Memory host) behind the agenda agent, with a scripted model:
 * the host checks quotes and applies plans; nothing here calls an API.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	openHostMemory,
	type Complete,
	type HostMemory,
} from "../../examples/virtual-eumenes/agenda/host-memory.ts";

type Prompt = { message: string; source: string; items: { itemId: string }[] };

const dirs: string[] = [];
const opened: HostMemory[] = [];
afterEach(async () => {
	for (const m of opened.splice(0)) await m.close();
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const remember = (
	quote: string,
	text: string,
	replacesItemId: string | null = null,
) => ({
	type: "remember",
	subject: "self",
	replacesItemId,
	kind: "personal_fact",
	semanticKey: "trip.kyoto",
	quote,
	value: { text, polarity: "affirmed" },
});
const decided = (
	actions: unknown[],
	relations: unknown[],
	evidence: unknown[],
) => ({
	proposal: {
		decision: { clarification: null, actions },
		relations,
		groups: actions.map((_, i) => [i]),
	},
	evidence,
});

/** A model that answers each call from the prompt it gets, and keeps the prompts. */
const scripted = (answers: ((p: Prompt) => unknown)[]) => {
	const prompts: Prompt[] = [];
	const complete: Complete = async (prompt) => {
		const p = JSON.parse(prompt) as Prompt;
		prompts.push(p);
		const answer = answers.shift();
		if (!answer) throw new Error("no scripted answer left");
		return { raw: JSON.stringify(answer(p)), threadId: null, usage: null };
	};
	return { complete, prompts };
};

const open = async (complete: Complete, dir?: string) => {
	const d = dir ?? mkdtempSync(join(tmpdir(), "agm-"));
	if (!dir) dirs.push(d);
	const memory = await openHostMemory({
		dir: d,
		complete,
		clock: () => "2026/11/8(日) 19:00",
	});
	opened.push(memory);
	return { dir: d, memory };
};

test("the memory's planner records what the user said, and a correction replaces it", async () => {
	const model = scripted([
		() =>
			decided(
				[remember("来週の土曜は京都に行きます", "11/14(土)に京都へ行く")],
				[{ actionIndex: 0, relation: "new", relatedItemIds: [] }],
				[{ actionIndex: 0, occurrence: 0 }],
			),
		(p) => {
			const id = p.items[0]!.itemId;
			return decided(
				[remember("京都は再来週だった", "11/21(土)に京都へ行く", id)],
				[{ actionIndex: 0, relation: "supersedes", relatedItemIds: [id] }],
				[{ actionIndex: 0, occurrence: 0 }],
			);
		},
	]);
	const { memory } = await open(model.complete);
	const said = [
		{ id: "a1", who: "agent", text: "週末の予定はありますか？" },
		{ id: "u1", who: "user", text: "来週の土曜は京都に行きます" },
	];
	const r = await memory.steward({ said, fresh: ["u1"], at: 0 });
	expect(r.applied).toEqual(["remember: 11/14(土)に京都へ行く"]);
	expect(memory.known().map((k) => k.text)).toEqual(["11/14(土)に京都へ行く"]);
	const id = memory.known()[0]!.id;
	expect(id).toMatch(/^m[0-9a-f]{8}$/u);
	// The planner hears the time and the agent's question as material; only the user's words are source.
	expect(model.prompts[0]!.message).toContain("今: 2026/11/8(日) 19:00");
	expect(model.prompts[0]!.message).toContain("週末の予定はありますか？");
	expect(model.prompts[0]!.source).toBe("来週の土曜は京都に行きます");

	said.push({ id: "u2", who: "user", text: "あ、京都は再来週だった" });
	const r2 = await memory.steward({ said, fresh: ["u2"], at: 0 });
	expect(r2.applied).toEqual([`update ${id}: 11/21(土)に京都へ行く`]);
	expect(memory.known().map((k) => k.text)).toEqual(["11/21(土)に京都へ行く"]);
});

test("the store outlives the process: the next start reads what was recorded", async () => {
	const model = scripted([
		() =>
			decided(
				[remember("陶芸が趣味です", "陶芸が趣味")],
				[{ actionIndex: 0, relation: "new", relatedItemIds: [] }],
				[{ actionIndex: 0, occurrence: 0 }],
			),
	]);
	const first = await open(model.complete);
	await first.memory.steward({
		said: [{ id: "u1", who: "user", text: "陶芸が趣味です" }],
		fresh: ["u1"],
		at: 0,
	});
	await opened.pop()!.close();
	const next = await open(scripted([]).complete, first.dir);
	expect(next.memory.known().map((k) => k.text)).toEqual(["陶芸が趣味"]);
});

test("a quote that is not in the user's words is refused, and nothing is stored", async () => {
	const model = scripted([
		() =>
			decided(
				[remember("京都が大好きです", "京都が大好き")],
				[{ actionIndex: 0, relation: "new", relatedItemIds: [] }],
				[{ actionIndex: 0, occurrence: 0 }],
			),
	]);
	const { memory } = await open(model.complete);
	const r = await memory.steward({
		said: [{ id: "u1", who: "user", text: "来週の土曜は京都に行きます" }],
		fresh: ["u1"],
		at: 0,
	});
	expect(r.applied).toEqual([]);
	expect(r.rejected).toEqual(["quote not in the user's words"]);
	expect(memory.known()).toEqual([]);
});

test("the agent's own words are never a source", async () => {
	const model = scripted([]);
	const { memory } = await open(model.complete);
	const r = await memory.steward({
		said: [{ id: "a1", who: "agent", text: "京都がお好きなんですね" }],
		fresh: ["a1"],
		at: 0,
	});
	expect(model.prompts).toEqual([]);
	expect(r).toEqual({ changed: false, applied: [], rejected: [], usage: null });
});

test("a plan the host applies only in part still shows what was written, and what waits", async () => {
	const like = (quote: string, text: string) => ({
		...remember(quote, text),
		kind: "preference",
		semanticKey: "food.favorite",
	});
	const model = scripted([
		() =>
			decided(
				[like("寿司が好きです", "寿司が好き")],
				[{ actionIndex: 0, relation: "new", relatedItemIds: [] }],
				[{ actionIndex: 0, occurrence: 0 }],
			),
		(p) => ({
			proposal: {
				decision: {
					clarification: "寿司の好みは変わりましたか？",
					actions: [
						remember("ラーメンもよく食べます", "ラーメンをよく食べる"),
						like("寿司は苦手かも", "寿司が苦手"),
					],
				},
				relations: [
					{ actionIndex: 0, relation: "new", relatedItemIds: [] },
					{
						actionIndex: 1,
						relation: "conflicts",
						relatedItemIds: [p.items[0]!.itemId],
					},
				],
				groups: [[0], [1]],
			},
			evidence: [{ actionIndex: 0, occurrence: 0 }],
		}),
	]);
	const { memory } = await open(model.complete);
	await memory.steward({
		said: [{ id: "u1", who: "user", text: "寿司が好きです" }],
		fresh: ["u1"],
		at: 0,
	});
	const r = await memory.steward({
		said: [
			{ id: "u2", who: "user", text: "ラーメンもよく食べます。寿司は苦手かも" },
		],
		fresh: ["u2"],
		at: 0,
	});
	expect(r.applied).toEqual(["remember: ラーメンをよく食べる"]);
	expect(r.changed).toBe(true);
	expect(r.rejected.some((x) => x.startsWith("clarify: "))).toBe(true);
	expect(
		memory
			.known()
			.map((k) => k.text)
			.sort(),
	).toEqual(["ラーメンをよく食べる", "寿司が好き"].sort());
});
