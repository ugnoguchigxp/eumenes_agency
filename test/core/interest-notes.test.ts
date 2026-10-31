import { describe, expect, test } from "bun:test";
import type { z } from "zod";
import { systemPrompt, updatePrompt } from "../../src/application/prompts.ts";
import { createAgencyRuntime } from "../../src/application/runtime.ts";
import { decisionTts } from "../../src/application/todos.ts";
import type {
	AgencyState,
	HostTodo,
	Limits,
	Note,
	Observation,
} from "../../src/contracts/model.ts";
import type { noteAdd, noteUpdate } from "../../src/contracts/proposals.ts";
import { defaultBudget } from "../../src/contracts/runtime.ts";
import {
	createDueFlags,
	findDue,
	isDue,
	issuedKeys,
	markIssued,
} from "../../src/domains/agency/due.ts";
import { settleUpdate } from "../../src/domains/agency/settle.ts";
import {
	HOUR,
	MIN,
	b1Proposal,
	defaultLimits,
	emptyState,
	fakeLlm,
	obs,
	obsInput,
	opportunity,
	participation,
	toWire,
	tools,
} from "./helpers.ts";

type Of<T extends z.ZodType> = z.infer<T>;

const o1 = obs(1, "user.report", "user");
const o3 = obs(3, "user.report", "user");
const o4 = obs(4, "exchange.adopted", "agent");

const noteAddOp = (
	localId: string,
	o: Partial<Of<typeof noteAdd>> = {},
): Of<typeof noteAdd> => ({
	op: "note.add",
	localId,
	text: "メモ",
	evidenceRefs: ["o1"],
	kind: null,
	status: null,
	origin: null,
	derivedFromRefs: [],
	interestRef: null,
	reviewAfterHours: null,
	...o,
});
const noteUpdateOp = (
	id: string,
	expectedRevision: number,
	o: Partial<Of<typeof noteUpdate>> = {},
): Of<typeof noteUpdate> => ({
	op: "note.update",
	id,
	expectedRevision,
	text: "更新",
	evidenceRefs: [],
	status: null,
	reviewAfterHours: null,
	derivedFromRefs: [],
	interestRef: null,
	...o,
});

const run = (
	state: AgencyState,
	p: ReturnType<typeof b1Proposal>,
	opts: { presented?: Observation[]; now?: number; limits?: Limits } = {},
) =>
	settleUpdate({
		condition: "B1",
		state,
		proposal: p,
		presented: opts.presented ?? [o1],
		tools,
		limits: opts.limits ?? defaultLimits,
		now: opts.now ?? 1000,
	});
const codesOf = (r: ReturnType<typeof run>) =>
	r.kind === "rejected" ? r.codes : [];
const applied = (r: ReturnType<typeof run>): AgencyState => {
	if (r.kind !== "applied") throw new Error(`not applied: ${r.kind}`);
	return r.state;
};

const interestAdd = (localId: string, o: Partial<Of<typeof noteAdd>> = {}) =>
	noteAddOp(localId, {
		text: "関心",
		kind: "interest",
		origin: "experienced",
		reviewAfterHours: 24,
		...o,
	});
const questionAdd = (localId: string, o: Partial<Of<typeof noteAdd>> = {}) =>
	noteAddOp(localId, {
		text: "問い",
		kind: "question",
		reviewAfterHours: 24,
		...o,
	});

describe("typed notes: add", () => {
	test("a plain note is unchanged: no typed fields reach the state", () => {
		const s = applied(run(emptyState(), b1Proposal([noteAddOp("n")])));
		const n = s.notes[0]!;
		expect(n.kind).toBeUndefined();
		expect(n.status).toBeUndefined();
		expect(n.origin).toBeUndefined();
		expect(n.derivedFrom).toBeUndefined();
		expect(n.reviewAt).toBeUndefined();
		expect(n.createdSeq).toBe(1);
		expect(n.updatedSeq).toBe(1);
	});

	test("a plain note carrying typed fields is rejected", () => {
		const r = run(
			emptyState(),
			b1Proposal([noteAddOp("n", { status: "active" })]),
		);
		expect(r.kind).toBe("rejected");
		expect(codesOf(r)).toContain("note_kind_required");
	});

	test("an interest carries kind, status, origin, derivedFrom and reviewAt", () => {
		const s = applied(
			run(
				emptyState(),
				b1Proposal([
					interestAdd("x", {
						reviewAfterHours: 48,
						derivedFromRefs: ["m"],
					}),
					noteAddOp("m", { text: "親メモ" }),
				]),
			),
		);
		const interest = s.notes.find((n) => n.kind === "interest")!;
		const parent = s.notes.find((n) => n.kind === undefined)!;
		expect(interest.status).toBe("active");
		expect(interest.origin).toBe("experienced");
		expect(interest.derivedFrom).toEqual([parent.id]);
		expect(interest.reviewAt).toBe(1000 + 48 * HOUR);
		expect(interest.createdSeq).toBe(1);
	});

	test("an interest without origin is rejected and nothing is stored", () => {
		const r = run(
			emptyState(),
			b1Proposal([interestAdd("x", { origin: null })]),
		);
		expect(r.kind).toBe("rejected");
		expect(codesOf(r)).toContain("missing_origin");
	});

	test("an interest without reviewAfterHours is rejected", () => {
		const r = run(
			emptyState(),
			b1Proposal([interestAdd("x", { reviewAfterHours: null })]),
		);
		expect(r.kind).toBe("rejected");
		expect(codesOf(r)).toContain("missing_review");
	});

	test("creating a typed note beyond the host review limit is rejected", () => {
		const r = run(
			emptyState(),
			b1Proposal([interestAdd("x", { reviewAfterHours: 48 })]),
			{ limits: { ...defaultLimits, reviewAfterMaxHours: 24 } },
		);
		expect(r.kind).toBe("rejected");
		expect(codesOf(r)).toContain("limit_exceeded");
	});

	test("an interest cannot be created retired or resolved", () => {
		const r = run(
			emptyState(),
			b1Proposal([interestAdd("x", { status: "resolved" })]),
		);
		expect(r.kind).toBe("rejected");
		expect(codesOf(r)).toContain("illegal_transition");
	});

	test("derivedFrom to an unknown ref is rejected; to an existing note succeeds", () => {
		const bad = run(
			emptyState(),
			b1Proposal([interestAdd("x", { derivedFromRefs: ["n99"] })]),
		);
		expect(bad.kind).toBe("rejected");
		expect(codesOf(bad)).toContain("unresolved_ref");

		const s1 = applied(run(emptyState(), b1Proposal([noteAddOp("m")])));
		const parentId = s1.notes[0]!.id;
		const s2 = applied(
			run(s1, b1Proposal([interestAdd("x", { derivedFromRefs: [parentId] })])),
		);
		expect(s2.notes.find((n) => n.kind === "interest")?.derivedFrom).toEqual([
			parentId,
		]);
	});

	test("a question links to its interest via interestRef", () => {
		// Existing interest note.
		const s1 = applied(run(emptyState(), b1Proposal([interestAdd("i")])));
		const interestId = s1.notes[0]!.id;
		const s2 = applied(
			run(s1, b1Proposal([questionAdd("q", { interestRef: interestId })])),
		);
		expect(s2.notes.find((n) => n.kind === "question")?.interestRef).toBe(
			interestId,
		);

		// Interest and question created in the same proposal (localId ref).
		const s3 = applied(
			run(
				emptyState(),
				b1Proposal([
					interestAdd("i1"),
					questionAdd("q1", { interestRef: "i1" }),
				]),
			),
		);
		const i3 = s3.notes.find((n) => n.kind === "interest")!;
		const q3 = s3.notes.find((n) => n.kind === "question")!;
		expect(q3.interestRef).toBe(i3.id);

		// Unknown target and non-interest targets are rejected.
		const unknown = run(
			emptyState(),
			b1Proposal([questionAdd("q", { interestRef: "n99" })]),
		);
		expect(unknown.kind).toBe("rejected");
		expect(codesOf(unknown)).toContain("unresolved_ref");
		const s4 = applied(run(emptyState(), b1Proposal([noteAddOp("m")])));
		const plainId = s4.notes[0]!.id;
		const notInterest = run(
			s4,
			b1Proposal([questionAdd("q", { interestRef: plainId })]),
		);
		expect(notInterest.kind).toBe("rejected");
		expect(codesOf(notInterest)).toContain("unresolved_ref");
	});

	test("interestRef is for questions only, and can be set by an update", () => {
		const bad = run(
			emptyState(),
			b1Proposal([interestAdd("i", { interestRef: "n1" })]),
		);
		expect(bad.kind).toBe("rejected");
		expect(codesOf(bad)).toContain("op_not_allowed");

		const s1 = applied(run(emptyState(), b1Proposal([interestAdd("i")])));
		const interestId = s1.notes[0]!.id;
		const s2 = applied(run(s1, b1Proposal([questionAdd("q")])));
		const q = s2.notes.find((n) => n.kind === "question")!;
		expect(q.interestRef).toBeUndefined();
		const s3 = applied(
			run(
				s2,
				b1Proposal([
					noteUpdateOp(q.id, q.revision, { interestRef: interestId }),
				]),
			),
		);
		expect(s3.notes.find((n) => n.kind === "question")?.interestRef).toBe(
			interestId,
		);
	});

	test("the update prompt shows typed note fields to the model", () => {
		const s = applied(
			run(
				emptyState(),
				b1Proposal([
					interestAdd("i", { text: "フィルムカメラへの関心" }),
					questionAdd("q", { text: "現像所の所要時間は？", interestRef: "i" }),
					noteAddOp("m", { text: "通常メモ" }),
				]),
			),
		);
		const prompt = updatePrompt({
			condition: "B1",
			now: 1000,
			observations: [o1],
			freshIds: new Set(["o1"]),
			state: s,
			due: { reviewIntentIds: [], reviewNoteIds: [], pressure: [] },
			delivered: [],
			tools,
			limits: defaultLimits,
			minutesSinceUserInput: 1,
		} as never);
		expect(prompt).toContain("種別=interest");
		expect(prompt).toContain("状態=active");
		expect(prompt).toContain("起源=experienced");
		expect(prompt).toContain("種別=open_question");
		expect(prompt).toContain("状態=open");
		const interest = s.notes.find((n) => n.kind === "interest")!;
		expect(prompt).toContain(`関心: ${interest.id}`);
		// A plain memo renders exactly as before (no typed suffix).
		expect(prompt).toContain("通常メモ");
		expect(prompt).not.toContain("通常メモ / 種別");
	});

	test("a question defaults to open and takes no origin", () => {
		const s = applied(run(emptyState(), b1Proposal([questionAdd("q")])));
		const q = s.notes[0]!;
		expect(q.kind).toBe("question");
		expect(q.status).toBe("open");
		expect(q.origin).toBeUndefined();
		expect(q.reviewAt).toBe(1000 + 24 * HOUR);

		const bad = run(
			emptyState(),
			b1Proposal([questionAdd("q", { origin: "inferred" })]),
		);
		expect(bad.kind).toBe("rejected");
		expect(codesOf(bad)).toContain("op_not_allowed");
	});
});

describe("typed notes: update transitions", () => {
	test("resolving a question requires new independent evidence", () => {
		const s = applied(run(emptyState(), b1Proposal([questionAdd("q")])));
		const q = s.notes[0]!;

		// Only the creation evidence: not newer than the question.
		const old = run(
			s,
			b1Proposal([
				noteUpdateOp(q.id, 1, { status: "resolved", evidenceRefs: ["o1"] }),
			]),
		);
		expect(old.kind).toBe("rejected");
		expect(codesOf(old)).toContain("completion_without_external_evidence");

		// Newer, but the agent's own utterance: not independent.
		const own = run(
			s,
			b1Proposal([
				noteUpdateOp(q.id, 1, { status: "resolved", evidenceRefs: ["o4"] }),
			]),
			{ presented: [o1, o4] },
		);
		expect(own.kind).toBe("rejected");
		expect(codesOf(own)).toContain("completion_without_external_evidence");

		// Newer and from the user: resolves.
		const done = applied(
			run(
				s,
				b1Proposal([
					noteUpdateOp(q.id, 1, { status: "resolved", evidenceRefs: ["o3"] }),
				]),
				{ presented: [o1, o3] },
			),
		);
		expect(done.notes[0]?.status).toBe("resolved");

		// Resolved is terminal.
		const reopen = run(
			done,
			b1Proposal([noteUpdateOp(q.id, 2, { status: "open" })]),
		);
		expect(reopen.kind).toBe("rejected");
		expect(codesOf(reopen)).toContain("illegal_transition");
	});

	test("reactivating an interest requires new evidence; review can extend", () => {
		const s = applied(run(emptyState(), b1Proposal([interestAdd("x")])));
		const it = s.notes[0]!;

		const dormant = applied(
			run(
				s,
				b1Proposal([
					noteUpdateOp(it.id, 1, { status: "dormant", evidenceRefs: ["o1"] }),
				]),
			),
		);
		expect(dormant.notes[0]?.status).toBe("dormant");

		const stale = run(
			dormant,
			b1Proposal([
				noteUpdateOp(it.id, 2, { status: "active", evidenceRefs: ["o1"] }),
			]),
		);
		expect(stale.kind).toBe("rejected");
		expect(codesOf(stale)).toContain("completion_without_external_evidence");

		const back = applied(
			run(
				dormant,
				b1Proposal([
					noteUpdateOp(it.id, 2, {
						status: "active",
						evidenceRefs: ["o3"],
						reviewAfterHours: 72,
					}),
				]),
				{ presented: [o1, o3], now: 2000 },
			),
		);
		expect(back.notes[0]?.status).toBe("active");
		expect(back.notes[0]?.reviewAt).toBe(2000 + 72 * HOUR);
	});

	test("review extension beyond the host limit is rejected", () => {
		const s = applied(run(emptyState(), b1Proposal([interestAdd("x")])));
		const it = s.notes[0]!;
		const r = run(
			s,
			b1Proposal([noteUpdateOp(it.id, 1, { reviewAfterHours: 48 })]),
			{ limits: { ...defaultLimits, reviewAfterMaxHours: 24 } },
		);
		expect(r.kind).toBe("rejected");
		expect(codesOf(r)).toContain("limit_exceeded");
	});

	test("a note cannot derive from itself via an update", () => {
		const s = applied(run(emptyState(), b1Proposal([interestAdd("x")])));
		const it = s.notes[0]!;
		const r = run(
			s,
			b1Proposal([noteUpdateOp(it.id, 1, { derivedFromRefs: [it.id] })]),
		);
		expect(r.kind).toBe("rejected");
		expect(codesOf(r)).toContain("unresolved_ref");
	});

	test("derivation cannot form a cycle via an update", () => {
		const s = applied(
			run(
				emptyState(),
				b1Proposal([
					interestAdd("a"),
					interestAdd("b", { derivedFromRefs: ["a"] }),
				]),
			),
		);
		const a = s.notes.find((n) => n.text === "関心")!;
		const b = s.notes.find((n) => n.derivedFrom?.includes(a.id))!;
		const r = run(
			s,
			b1Proposal([noteUpdateOp(a.id, 1, { derivedFromRefs: [b.id] })]),
		);
		expect(r.kind).toBe("rejected");
		expect(codesOf(r)).toContain("unresolved_ref");
	});

	test("a plain note update carrying typed fields is rejected", () => {
		const s = applied(run(emptyState(), b1Proposal([noteAddOp("n")])));
		const r = run(
			s,
			b1Proposal([noteUpdateOp(s.notes[0]!.id, 1, { status: "dormant" })]),
		);
		expect(r.kind).toBe("rejected");
		expect(codesOf(r)).toContain("note_kind_required");
	});

	test("a typed note update appends derivedFrom without duplicates", () => {
		const s1 = applied(
			run(
				emptyState(),
				b1Proposal([
					noteAddOp("a", { text: "A" }),
					noteAddOp("b", { text: "B" }),
				]),
			),
		);
		const [a, b] = s1.notes;
		const s2 = applied(
			run(s1, b1Proposal([interestAdd("x", { derivedFromRefs: [a!.id] })])),
		);
		const it = s2.notes.find((n) => n.kind === "interest")!;
		const s3 = applied(
			run(
				s2,
				b1Proposal([
					noteUpdateOp(it.id, 1, { derivedFromRefs: [a!.id, b!.id] }),
				]),
			),
		);
		expect(s3.notes.find((n) => n.kind === "interest")?.derivedFrom).toEqual([
			a!.id,
			b!.id,
		]);
	});
});

describe("findDue: typed notes", () => {
	const note = (o: Partial<Note>): Note => ({
		id: "n1",
		revision: 1,
		text: "関心",
		evidence: ["o1"],
		kind: "interest",
		status: "active",
		origin: "experienced",
		derivedFrom: [],
		reviewAt: 5000,
		createdSeq: 1,
		updatedSeq: 1,
		...o,
	});
	const state = (notes: Note[]): AgencyState => ({ ...emptyState(), notes });

	test("fires once per (note, reviewAt) and again after the review moves", () => {
		const flags = createDueFlags();
		const s = state([note({})]);
		expect(findDue(s, defaultLimits, 4999, flags).reviewNoteIds).toEqual([]);
		const due = findDue(s, defaultLimits, 5000, flags);
		expect(due.reviewNoteIds).toEqual(["n1"]);
		expect(isDue(due)).toBe(true);
		markIssued(issuedKeys(s, due), flags);
		expect(findDue(s, defaultLimits, 5000, flags).reviewNoteIds).toEqual([]);

		const later = state([note({ reviewAt: 9000 })]);
		expect(findDue(later, defaultLimits, 8999, flags).reviewNoteIds).toEqual(
			[],
		);
		expect(findDue(later, defaultLimits, 9000, flags).reviewNoteIds).toEqual([
			"n1",
		]);
	});

	test("only live typed notes are due", () => {
		const flags = createDueFlags();
		const plain: Note = {
			id: "n3",
			revision: 1,
			text: "メモ",
			evidence: ["o1"],
			reviewAt: 1,
		};
		const s = state([
			note({ id: "n1", status: "retired" }),
			note({ id: "n2", kind: "question", status: "resolved" }),
			plain,
			note({ id: "n4", kind: "question", status: "open" }),
			note({ id: "n5", status: "dormant" }),
		]);
		expect(findDue(s, defaultLimits, 5000, flags).reviewNoteIds).toEqual([
			"n4",
			"n5",
		]);
	});
});

describe("tts: silent self reports (§5.5)", () => {
	test("decisionTts is a mechanical function of mode and origins", () => {
		const todos: HostTodo[] = [
			{
				id: "w1",
				origin: "self",
				title: "自分の調べもの",
				status: "done",
				requestedAt: 0,
			},
			{
				id: "w2",
				origin: "user",
				title: "頼まれた仕事",
				status: "done",
				requestedAt: 0,
			},
		];
		expect(decisionTts(undefined, "speak", ["todo:w1"], todos)).toBeUndefined();
		expect(decisionTts(false, "speak", ["todo:w1"], todos)).toBe(true);
		expect(decisionTts(true, "speak", ["todo:w1"], todos)).toBe(false);
		expect(decisionTts(true, "speak", ["todo:w2"], todos)).toBe(true);
		// A user-origin citation wins over a self-origin one.
		expect(decisionTts(true, "speak", ["todo:w1", "todo:w2"], todos)).toBe(
			true,
		);
		expect(decisionTts(true, "speak", ["o1"], todos)).toBe(true);
		expect(decisionTts(true, "tool", ["todo:w1"], todos)).toBe(true);
		// No todo list to look origins up in: not a self-originated report.
		expect(decisionTts(true, "speak", ["todo:w1"], [])).toBe(true);
		// A cited todo that is in neither list cannot prove a self origin either
		// (upstream validation rejects unknown refs; this pins the fail-open edge).
		expect(decisionTts(true, "speak", ["todo:w9"], todos)).toBe(true);
	});

	const sig = () => new AbortController().signal;
	const doneTodo = (origin: "self" | "user"): HostTodo => ({
		id: "w1",
		origin,
		title: "調べもの",
		status: "done",
		outcome: "succeeded",
		result: "結果",
		requestedAt: 0,
		doneAt: 9 * MIN,
	});
	const runTts = async (o: { silent?: boolean; todo: HostTodo }) => {
		const llm = fakeLlm();
		const rt = createAgencyRuntime({
			systemContext: "experimental",
			condition: "B1",
			llm,
			tools: [],
			budget: { ...defaultBudget, minIntervalMs: 0 },
			limits: { ...defaultLimits, outboundIntervalMs: 0 },
			hostTodos: true,
			...(o.silent === undefined ? {} : { silentSelfReports: o.silent }),
		});
		rt.observe(obsInput("o1", "user.report", "user", 0, "調べておいて"));
		llm.push("update", { ...toWire(b1Proposal([])), reportedTodos: [] });
		llm.push(
			"select",
			participation({
				action: "speak",
				utterance: "調べものが終わったよ",
				evidenceRefs: ["todo:w1"],
			}),
		);
		const d = await rt.decide(
			opportunity("op0", 10 * MIN, {
				trigger: "result_received",
				todos: [o.todo],
			}),
			sig(),
		);
		return d.decision;
	};

	test("mode ON: a self-originated report is silent on decision and ticket", async () => {
		const d = await runTts({ silent: true, todo: doneTodo("self") });
		expect(d.action).toBe("speak");
		expect(d.tts).toBe(false);
		expect(d.ticket?.tts).toBe(false);
	});

	test("mode ON: a user-originated report is spoken", async () => {
		const d = await runTts({ silent: true, todo: doneTodo("user") });
		expect(d.tts).toBe(true);
		expect(d.ticket?.tts).toBe(true);
	});

	test("mode OFF: everything is spoken, even self-originated reports", async () => {
		const d = await runTts({ silent: false, todo: doneTodo("self") });
		expect(d.tts).toBe(true);
		expect(d.ticket?.tts).toBe(true);
	});

	test("mode unset: no tts is stamped", async () => {
		const d = await runTts({ todo: doneTodo("self") });
		expect(d.tts).toBeUndefined();
		expect(d.ticket?.tts).toBeUndefined();
	});
});

const T0 = 1_700_000_000_000;

describe("typed-notes prompt integration (S3)", () => {
	test("the update system gains the typed-note rules only with the flag", () => {
		expect(systemPrompt("update", "B1")).not.toContain("型付きメモ");
		expect(systemPrompt("update", "B1", { typedNotes: true })).toContain(
			"型付きメモ",
		);
		expect(systemPrompt("update", "B2", { typedNotes: true })).not.toContain(
			"型付きメモ",
		);
	});

	test("updatePrompt renders due typed notes in the host notices", () => {
		const interest: Note = {
			id: "n1",
			revision: 1,
			text: "登山への関心",
			evidence: ["o1"],
			kind: "interest",
			status: "active",
			origin: "experienced",
			derivedFrom: [],
			reviewAt: T0,
			createdSeq: 1,
			updatedSeq: 1,
		};
		const prompt = updatePrompt({
			condition: "B1",
			now: T0 + HOUR,
			observations: [],
			freshIds: new Set<string>(),
			state: { ...emptyState(), notes: [interest] },
			due: { reviewIntentIds: [], reviewNoteIds: ["n1"], pressure: [] },
			delivered: [],
			tools: [],
			limits: defaultLimits,
			minutesSinceUserInput: null,
		});
		expect(prompt).toContain("見直し時点を過ぎた関心・問い n1");
	});
});

describe("review wake chain (S3)", () => {
	test("polls call the model only when something is due", async () => {
		const llm = fakeLlm();
		const rt = createAgencyRuntime({
			condition: "B1",
			systemContext: "experimental",
			typedNotes: true,
			llm,
			tools: [],
		});
		const signal = new AbortController().signal;
		rt.observe(
			obsInput(
				"o1",
				"exchange.adopted",
				"user",
				T0,
				"登山にハマって、月2回は低山に登っている",
			),
		);
		llm.push("update", {
			...toWire(
				b1Proposal([
					noteAddOp("new1", {
						text: "登山への関心",
						kind: "interest",
						status: "active",
						origin: "experienced",
						reviewAfterHours: 1,
					}),
				]),
			),
		});
		await rt.runBackground(T0, signal);
		expect(llm.count("update")).toBe(1);
		// Nothing pending and the review is not due yet: a poll makes no model call.
		await rt.runBackground(T0 + 30 * MIN, signal);
		expect(llm.count("update")).toBe(1);
		// The review comes due: exactly one update call, and its prompt names the note.
		llm.push("update", {
			...toWire(b1Proposal([noteUpdateOp("n1", 1, { reviewAfterHours: 1 })])),
		});
		await rt.runBackground(T0 + 2 * HOUR, signal);
		expect(llm.count("update")).toBe(2);
		const wake = llm.requests.filter((r) => r.purpose === "update")[1];
		expect(wake?.prompt).toContain("見直し時点を過ぎた関心・問い n1");
		// An immediate second poll does not fire again.
		await rt.runBackground(T0 + 2 * HOUR + MIN, signal);
		expect(llm.count("update")).toBe(2);
		const interest = rt.snapshot().state.notes[0];
		expect(interest?.status).toBe("active");
		expect(interest?.reviewAt).toBe(T0 + 3 * HOUR);
	});
});
