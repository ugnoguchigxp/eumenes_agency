/**
 * The agenda calls' data keeps a head that holds still from one call to the next (the model's
 * input cache reads up to the first difference), the question check reads only what it needs, and
 * nothing is written ahead during the user's turn. Measures what the model is given, with a
 * scripted model (no live call).
 */
import { describe, expect, test } from "bun:test";
import type { LlmPort, LlmRequest } from "../../src/index.ts";
import {
	createAgendaAgent,
	type AgendaDeps,
	type NoteRef,
	type PlanOutput,
} from "../../src/agenda/index.ts";
import { askCheckLines, composeData } from "../../src/agenda/prompt.ts";
import { makeItem, createState } from "../../src/agenda/state.ts";

type Kind = "plan" | "check" | "ask_check" | "compose";
type Data = Record<string, unknown>;

const kindOf = (system: string): Kind =>
	system.includes("この呼び出しは「計画」")
		? "plan"
		: system.includes("重複チェック")
			? "check"
			: system.includes("質問の聞き直しチェック")
				? "ask_check"
				: "compose";

const scripted = (s: {
	plan?: (n: number) => PlanOutput;
	onAskCheck?: () => void;
}) => {
	const calls: { kind: Kind; prompt: string; data: Data }[] = [];
	const llm: LlmPort = {
		complete<T>(req: LlmRequest<T>) {
			const kind = kindOf(req.system);
			const data = JSON.parse(req.prompt) as Data;
			calls.push({ kind, prompt: req.prompt, data });
			const n = calls.filter((c) => c.kind === kind).length;
			if (kind === "ask_check") s.onAskCheck?.();
			const value =
				kind === "plan"
					? (s.plan?.(n) ?? { add: [], drop: [], focus: "" })
					: kind === "ask_check"
						? {
								verdicts: (data["candidates"] as { id: string }[]).map((c) => ({
									id: c.id,
									verdict: "new",
									reason: "test",
								})),
							}
						: kind === "check"
							? { verdict: "new", coveredBy: null, request: null, reason: "x" }
							: {
									utterance: `一言${n}`,
									decline: null,
									emotion: "🙂",
									questions: 0,
									choice: false,
								};
			return Promise.resolve({
				value: req.schema.parse(value),
				model: "scripted",
				inputTokens: 10,
				outputTokens: 10,
				cacheReadTokens: 0,
				latencyMs: 1,
			});
		},
	};
	return {
		llm,
		calls,
		of: (k: Kind) => calls.filter((c) => c.kind === k),
	};
};

const add = (
	kind: "ask" | "research" | "talk",
	text: string,
	refs: string[] = [],
) => ({
	kind,
	text,
	refs,
	value: 3,
	reason: "test",
	topic: "",
});
const plan = (...items: ReturnType<typeof add>[]): PlanOutput => ({
	add: items,
	drop: [],
	focus: "",
});
const idle = () => ({ busy: false });
const sig = () => new AbortController().signal;
const make = (deps: Partial<AgendaDeps> & Pick<AgendaDeps, "llm">) =>
	createAgendaAgent({ startedAt: 0, ...deps });

const MIN = 60_000;
/** A host clock: the minute the instant falls in, as the host would word it. */
const clock = (at: number) => `T${Math.floor(at / MIN)}`;
const note = (at: number): NoteRef => ({
	id: "n1",
	title: "メモ",
	summary: "要約",
	at,
	refs: [],
});
const known = [{ id: "m1", text: "猫を飼っている" }];

describe("prompt order for the input cache", () => {
	test("plan: no `now` at the head; the user's side and the words first, `now` last", async () => {
		const m = scripted({});
		const agent = make({
			llm: m.llm,
			clock,
			known: () => known,
			notes: () => [note(1 * MIN)],
		});
		agent.observe({ id: "u1", who: "user", text: "こんにちは", at: 2 * MIN });
		await agent.step(5 * MIN, idle, sig());
		const keys = Object.keys(m.of("plan")[0]!.data);
		expect(keys[0]).toBe("user");
		expect(keys[1]).toBe("conversation");
		expect(keys.at(-1)).toBe("now");
		expect(keys.indexOf("conversation")).toBeLessThan(keys.indexOf("agenda"));
		expect(keys.indexOf("conversation")).toBeLessThan(keys.indexOf("notes"));
		expect(keys.indexOf("agenda")).toBeLessThan(keys.indexOf("notes"));
		expect(keys.indexOf("researching")).toBeLessThan(keys.indexOf("notes"));
		expect(m.of("plan")[0]!.data["now"]).toBe("T5");
	});

	test("plan: each line carries its own time, the same in every call; no secAgo or hoursAgo", async () => {
		const m = scripted({});
		let notes: NoteRef[] = [note(1 * MIN)];
		const agent = make({ llm: m.llm, clock, notes: () => notes });
		agent.observe({ id: "u1", who: "user", text: "一つ目", at: 2 * MIN });
		await agent.step(5 * MIN, idle, sig());
		agent.observe({ id: "u2", who: "user", text: "二つ目", at: 20 * MIN });
		notes = [note(1 * MIN)];
		await agent.step(40 * MIN, idle, sig());
		const [a, b] = m.of("plan");
		const first = (d: Data) =>
			(d["conversation"] as { id: string; at: string }[])[0]!;
		expect(first(a!.data)).toEqual(first(b!.data));
		expect(first(a!.data).at).toBe("T2");
		expect(a!.prompt).not.toContain("secAgo");
		expect(a!.prompt).not.toContain("hoursAgo");
		const noteOf = (d: Data) =>
			(d["notes"] as { id: string; at: string }[])[0]!;
		expect(noteOf(a!.data)).toEqual(noteOf(b!.data));
		expect(noteOf(a!.data).at).toBe("T1");
		// Everything before the first moving key is the same text in both calls.
		const head = (p: string) => p.slice(0, p.indexOf(',"agenda"'));
		const lines = (p: string) => head(p).slice(0, head(p).indexOf('"一つ目"'));
		expect(lines(a!.prompt)).toBe(lines(b!.prompt));
		expect(lines(a!.prompt).length).toBeGreaterThan(20);
	});

	test("without a host clock the time is UTC to the minute, still one wording per instant", async () => {
		const m = scripted({});
		const agent = make({ llm: m.llm });
		agent.observe({ id: "u1", who: "user", text: "こんにちは", at: 0 });
		await agent.step(MIN, idle, sig());
		const d = m.of("plan")[0]!.data;
		expect((d["conversation"] as { at: string }[])[0]!.at).toBe(
			"1970-01-01T00:00Z",
		);
		expect(d["now"]).toBe("1970-01-01T00:01Z");
	});

	test("research check: notes and earlier requests first, the request and `now` last", async () => {
		const m = scripted({
			plan: (n) =>
				n === 1 ? plan(add("research", "新しい調べもの", ["u1"])) : plan(),
		});
		const agent = make({ llm: m.llm, clock, notes: () => [note(1 * MIN)] });
		agent.observe({ id: "u1", who: "user", text: "調べたい", at: 2 * MIN });
		await agent.step(5 * MIN, idle, sig());
		const c = m.of("check")[0]!;
		const keys = Object.keys(c.data);
		expect(keys.at(-1)).toBe("now");
		expect(keys.at(-2)).toBe("request");
		expect(keys[0]).toBe("notes");
		expect(c.prompt).not.toContain("hoursAgo");
		expect((c.data["notes"] as { at: string }[])[0]!.at).toBe("T1");
	});

	test("compose: the user's side and the words first, `now` last, times as stamps", () => {
		const st = createState({ llm: scripted({}).llm, startedAt: 0 }, 10_000, {
			plan: "",
			check: "",
			compose: "",
			askCheck: "",
		});
		const item = makeItem(st, {
			kind: "talk",
			text: "話題",
			refs: [],
			value: 3,
			reason: "r",
			createdAt: 0,
		});
		const out = JSON.parse(
			composeData({
				now: 10 * MIN,
				stamp: clock,
				item,
				note: null,
				said: [{ id: "u1", who: "user", text: "やあ", at: 3 * MIN, refs: [] }],
				known,
				quietEndedSecAgo: null,
			}),
		) as Data;
		const keys = Object.keys(out);
		expect(keys.slice(0, 2)).toEqual(["user", "said"]);
		expect(keys.at(-1)).toBe("now");
		expect((out["said"] as { at: string }[])[0]!.at).toBe("T3");
		expect(JSON.stringify(out)).not.toContain("secAgo");
	});
});

describe("question check input", () => {
	test("no ask in the plan: the check is not called", async () => {
		const m = scripted({
			plan: (n) =>
				n === 1
					? plan(add("talk", "雑談の種"), add("research", "調べ", ["u1"]))
					: plan(),
		});
		const agent = make({ llm: m.llm });
		agent.observe({ id: "u1", who: "user", text: "こんにちは", at: 0 });
		await agent.step(0, idle, sig());
		expect(m.of("plan").length).toBeGreaterThan(0);
		expect(m.of("ask_check").length).toBe(0);
	});

	test("with a new ask: the agent's recent questions and the words after each, the earlier questions and the candidates; no memory, no 30 lines", async () => {
		const m = scripted({
			plan: (n) => (n === 1 ? plan(add("ask", "好きな色は？")) : plan()),
		});
		const agent = make({ llm: m.llm, known: () => known });
		let at = 0;
		for (let i = 0; i < 20; i++) {
			agent.observe({ id: `u${i}`, who: "user", text: `雑談${i}`, at: at++ });
		}
		agent.observe({
			id: "r1",
			who: "reply",
			text: "犬は好きですか？",
			at: at++,
		});
		agent.observe({ id: "u20", who: "user", text: "猫派です", at: at++ });
		agent.observe({
			id: "r2",
			who: "reply",
			text: "そうなんですね。",
			at: at++,
		});
		await agent.step(at, idle, sig());
		const c = m.of("ask_check")[0]!;
		expect(c.data["conversation"]).toEqual([
			{ who: "agent", text: "犬は好きですか？" },
			{ who: "user", text: "猫派です" },
		]);
		// No ledger yet: the key is left out.
		expect(Object.keys(c.data)).toEqual([
			"conversation",
			"askedBefore",
			"candidates",
			"now",
		]);
		expect(c.data["candidates"]).toEqual([
			{ id: expect.any(String), text: "好きな色は？" },
		]);
		expect(c.prompt).not.toContain("猫を飼っている");
		expect(c.prompt).not.toContain("雑談3");
	});

	test("question lines: only the recent questions, with the user's words that follow them", () => {
		const said = (id: string, who: "user" | "reply" | "own", text: string) => ({
			id,
			who,
			text,
			at: 0,
			refs: [],
		});
		const lines = askCheckLines([
			said("1", "own", "元気ですか？"),
			said("2", "user", "はい"),
			said("3", "user", "とても"),
			said("4", "reply", "良かったです。"),
		]);
		expect(lines).toEqual([
			{ who: "agent", text: "元気ですか？" },
			{ who: "user", text: "はい" },
			{ who: "user", text: "とても" },
		]);
	});
});

describe("write ahead and the user's turn", () => {
	test("the user's turn begins while the question is checked: nothing is written, the next step writes at once", async () => {
		let busy = false;
		const m = scripted({
			plan: (n) =>
				n === 1
					? plan(
							add("ask", "一つ目の質問は？", ["u0"]),
							add("ask", "二つ目の質問は？"),
						)
					: plan(),
			// The second question's own check, right before it is written: the user starts typing.
			onAskCheck: () => {
				if (m.of("ask_check").length === 2) busy = true;
			},
		});
		const agent = make({ llm: m.llm });
		const host = () => ({ busy });
		agent.observe({ id: "u0", who: "user", text: "こんにちは", at: 0 });
		const out = await agent.step(0, host, sig());
		const spoken = out.tickets.find((t) => t.kind === "speak");
		expect(spoken).toBeDefined();
		agent.recordDelivery({ ticketId: spoken!.id, at: 0, status: "succeeded" });
		agent.observe({ id: "u1", who: "user", text: "はい", at: 1_000 });
		const composes = () => m.of("compose").length;
		const before = composes();
		// Past the talk (the other question is not drawn from elsewhere in a talk): its own check
		// runs inside the step; the user's turn begins there.
		const later = 10 * MIN;
		await agent.step(later, host, sig());
		expect(busy).toBe(true);
		expect(composes()).toBe(before);
		// The turn ends: the next step writes it, at once (no waiting).
		busy = false;
		const next = await agent.step(later, host, sig());
		expect(composes()).toBe(before + 1);
		expect(next.tickets.some((t) => t.kind === "speak")).toBe(true);
	});

	test("during the user's turn from the start of the step nothing is written", async () => {
		const m = scripted({
			plan: (n) => (n === 1 ? plan(add("ask", "質問は？")) : plan()),
		});
		const agent = make({ llm: m.llm });
		const out = await agent.step(0, () => ({ busy: true }), sig());
		expect(m.of("compose").length).toBe(0);
		expect(out.tickets.filter((t) => t.kind === "speak")).toEqual([]);
		const next = await agent.step(0, idle, sig());
		expect(next.tickets.some((t) => t.kind === "speak")).toBe(true);
	});
});

describe("UTC stamp without a host clock", () => {
	test("calendar arithmetic matches the Date of the host runtime", async () => {
		const m = scripted({});
		const agent = make({ llm: m.llm });
		const ats = [
			0,
			951_782_400_000 + 23 * 3_600_000 + 59 * MIN,
			1_709_164_800_000 - MIN,
			1_795_340_580_000,
		];
		ats.forEach((at, i) =>
			agent.observe({ id: `u${i}`, who: "user", text: `行${i}`, at }),
		);
		await agent.step(1_795_400_000_000, idle, sig());
		const stamps = (
			m.of("plan")[0]!.data["conversation"] as { at: string }[]
		).map((c) => c.at);
		expect(stamps).toEqual(
			ats.map((at) => `${new Date(at).toISOString().slice(0, 16)}Z`),
		);
	});
});
