/**
 * H12 (P4-c): write revisions → restart → restore → reconstruct interest change → forget.
 * LLM-free (scripted proposals). Host stand-in: eval/h12-db.ts (bun:sqlite).
 * before = today's host practice (open-items snapshot only); after = agency_item_revisions.
 */
import {
	createAgencyRuntime,
	interestHistory,
	stateFromRevisions,
	type AgencyState,
	type RevisionSink,
} from "../src/index.ts";
import {
	HOUR,
	candidateAddOp,
	fakeLlm,
	intentAddOp,
	intentUpdateOp,
	obsInput,
	opportunity,
	participation,
	proposal,
} from "../test/core/helpers.ts";
import { createRevisionDb } from "./h12-db.ts";

const sig = () => new AbortController().signal;
const SCOPE = "u:yuji";
const iAdd = (evidenceRefs: string[]) => ({
	op: "interest.add",
	id: null,
	localId: "n1",
	expectedRevision: null,
	status: null,
	topic: "将棋の角換わり",
	origin: "user_relation",
	reason: "ユーザーが勉強したいと言った",
	derivedFrom: null,
	evidenceRefs,
});
const iUpd = (
	id: string,
	rev: number,
	status: string,
	reason: string,
	ev: string,
) => ({
	op: "interest.update",
	id,
	localId: null,
	expectedRevision: rev,
	status,
	topic: null,
	origin: null,
	reason,
	derivedFrom: null,
	evidenceRefs: [ev],
});

const make = (
	sink: RevisionSink | undefined,
	restore?: { state: AgencyState; revs?: Map<string, number> },
) => {
	const llm = fakeLlm();
	const rt = createAgencyRuntime({
		systemContext: "experimental",
		condition: "F",
		interestFormation: true,
		llm,
		tools: [],
		...(sink ? { revisions: sink } : {}),
		...(restore ? { restore } : {}),
	});
	return { llm, rt };
};

/** What the host keeps today: open items only. */
export const openSnapshot = (s: AgencyState): AgencyState => ({
	...structuredClone(s),
	intents: s.intents.filter(
		(i) => i.state !== "completed" && i.state !== "abandoned",
	),
	candidates: s.candidates.filter(
		(c) => c.state === "pending" || c.state === "held",
	),
	attempts: [],
	interests: (s.interests ?? []).filter((i) => i.status !== "faded"),
});

const itemsOf = (s: AgencyState) =>
	new Map(
		(
			[
				"intents",
				"candidates",
				"attempts",
				"beliefs",
				"desires",
				"notes",
				"interests",
			] as const
		).flatMap((f) =>
			((s[f] as { id: string }[] | undefined) ?? []).map(
				(x) => [`${f}:${x.id}`, JSON.stringify(x)] as const,
			),
		),
	);
const matchRate = (truth: AgencyState, got: AgencyState) => {
	const a = itemsOf(truth);
	const b = itemsOf(got);
	let ok = 0;
	for (const [k, v] of a) if (b.get(k) === v) ok++;
	return { ok, total: a.size };
};

export const runH12 = async () => {
	const db = createRevisionDb();
	const sink = db.sink(SCOPE);
	const m = make(sink);
	m.rt.observe(
		obsInput("u1", "user.report", "user", 0, "将棋の角換わりを勉強したい"),
	);
	m.llm.push(
		"update",
		proposal(
			[
				intentAddOp("g", {
					evidenceRefs: ["u1"],
					desiredState: "定跡の要点を共有する",
				}),
				candidateAddOp("s", "g", {
					evidenceRefs: ["u1"],
					content: "角換わりの要点をまとめましょうか",
				}),
			],
			{ interestOps: [iAdd(["u1"])] },
		),
	);
	await m.rt.runBackground(1, sig());
	m.llm.push(
		"select",
		participation({
			action: "speak",
			evidenceRefs: ["u1"],
			candidateRef: { id: "c2", revision: 1 },
			utterance: "角換わりの要点をまとめましょうか",
		}),
	);
	const d = await m.rt.decide(opportunity("op1", HOUR), sig());
	const t = d.decision.ticket;
	if (!t) throw new Error(`no ticket: ${JSON.stringify(d.decision)}`);
	if (t)
		m.rt.recordResult({
			ticketId: t.id,
			status: "succeeded",
			at: HOUR + 1,
			resultText: "話した",
		});
	const k = () => m.rt.snapshot().state.interests![0]!;
	const it = () => m.rt.snapshot().state.intents[0]!;
	m.rt.observe(
		obsInput(
			"u2",
			"user.report",
			"user",
			2 * HOUR,
			"腰掛け銀のところをもっと知りたい",
		),
	);
	m.llm.push(
		"update",
		proposal(
			[
				intentUpdateOp(it().id, it().revision, {
					transition: "completed",
					reason: "要点を共有した",
					evidenceRefs: ["u2"],
				}),
			],
			{
				interestOps: [
					iUpd(
						k().id,
						k().revision,
						"active",
						"続けて深掘りを求められた",
						"u2",
					),
				],
			},
		),
	);
	await m.rt.runBackground(2 * HOUR, sig());
	m.rt.observe(
		obsInput(
			"u3",
			"user.report",
			"user",
			30 * HOUR,
			"しばらく将棋はお休みする",
		),
	);
	m.llm.push(
		"update",
		proposal([], {
			interestOps: [
				iUpd(k().id, k().revision, "dormant", "休むと言われた", "u3"),
			],
		}),
	);
	await m.rt.runBackground(30 * HOUR, sig());
	const truth = m.rt.snapshot().state;
	const userTexts = m.rt
		.snapshot()
		.observations.filter((o) => o.actor === "user")
		.map((o) => o.text ?? "");
	const convTextInRows = db
		.rows(SCOPE)
		.filter((r) => userTexts.some((t) => t && r.stateJson.includes(t))).length;
	const rowsBeforeRestart = db.count();

	// restart
	const before = openSnapshot(truth);
	const restored = stateFromRevisions(db.rows(SCOPE))!;
	const mBefore = matchRate(truth, before);
	const mAfter = matchRate(truth, restored.state);
	const rootEqual =
		JSON.stringify({
			...truth,
			intents: 0,
			candidates: 0,
			attempts: 0,
			beliefs: 0,
			desires: 0,
			notes: 0,
			interests: 0,
		}) ===
		JSON.stringify({
			...restored.state,
			intents: 0,
			candidates: 0,
			attempts: 0,
			beliefs: 0,
			desires: 0,
			notes: 0,
			interests: 0,
		});
	const r2 = make(sink, restored);
	const dupRowsOnRestore = db.count() - rowsBeforeRestart;
	r2.rt.observe(
		obsInput("u4", "user.report", "user", 80 * HOUR, "また将棋を再開した"),
	);
	r2.llm.push(
		"update",
		proposal([], {
			interestOps: [
				iUpd(k().id, k().revision, "active", "再開すると言われた", "u4"),
			],
		}),
	);
	let continueError: string | null = null;
	try {
		await r2.rt.runBackground(80 * HOUR, sig());
	} catch (e) {
		continueError = String(e);
	}
	const hist = interestHistory(db.rows(SCOPE)).get(k().id) ?? [];
	const afterSteps = hist.map((h) => h.status);
	const beforeSteps = (before.interests ?? [])
		.filter((i) => i.id === k().id)
		.map((i) => i.status);
	const expected = ["emerging", "active", "dormant", "active"];

	// forget u1
	const redactedItems = db.forget(SCOPE, ["u1"]);
	const rows = db.rows(SCOPE);
	const leaked = rows.filter(
		(r) => r.evidence.includes("u1") || r.stateJson.includes('"u1"'),
	).length;
	const afterForget = stateFromRevisions(rows)!;
	const leakedRestored = [...itemsOf(afterForget.state).values()].filter((v) =>
		v.includes('"u1"'),
	).length;
	const beforeLeak = [...itemsOf(before).values()].filter((v) =>
		v.includes('"u1"'),
	).length;
	db.close();
	return {
		before: {
			stateMatch: `${mBefore.ok}/${mBefore.total}`,
			interestHistory: beforeSteps,
			historyReconstructed:
				JSON.stringify(beforeSteps) === JSON.stringify(expected),
			// the snapshot has no history to forget; a live item that cites u1 is the host Memory path
			snapshotItemsCitingForgotten: beforeLeak,
		},
		after: {
			rows: rowsBeforeRestart,
			convTextInRows,
			stateMatch: `${mAfter.ok}/${mAfter.total}`,
			rootEqual,
			dupRowsOnRestore,
			continueAfterRestore: continueError === null,
			continueError,
			interestHistory: afterSteps,
			historyReconstructed:
				JSON.stringify(afterSteps) === JSON.stringify(expected),
			redactedItems,
			forgottenBodyLeft: leaked + leakedRestored,
		},
	};
};

if (import.meta.main) {
	const r = await runH12();
	console.log(JSON.stringify(r, null, 1));
	await Bun.write(
		"eval/results/p4c-h12/result.json",
		JSON.stringify(r, null, 1),
	);
}
