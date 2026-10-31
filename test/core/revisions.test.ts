/** P4-c: agency_item_revisions — save, restart, restore, history, forget (H12, LLM-free). */
import { describe, expect, test } from "bun:test";
import { runH12 } from "../../eval/h12-scene.ts";
import {
	REDACTED,
	RevisionTracker,
	emptyState,
	redactRevisions,
	stateFromRevisions,
} from "../../src/index.ts";

const record = (
	tracker: RevisionTracker,
	state: ReturnType<typeof emptyState>,
	at: number,
) => {
	const rows = tracker.diff(state, "x", at);
	tracker.commit(rows);
	return rows;
};

describe("P4-c revisions", () => {
	test("preparing rows does not advance the durable baseline", () => {
		const tracker = new RevisionTracker("s");
		const state = emptyState();
		const rows = tracker.diff(state, "update", 1);
		expect(tracker.diff(state, "update", 1)).toEqual(rows);
		tracker.commit(rows);
		expect(tracker.diff(state, "update", 1)).toEqual([]);
	});
	test("H12 gates: restore 100%, interest change reconstructed, no duplicate rows, forgotten bodies gone", async () => {
		const r = await runH12();
		expect(r.after.stateMatch).toBe("4/4");
		expect(r.after.rootEqual).toBe(true);
		expect(r.after.dupRowsOnRestore).toBe(0);
		expect(r.after.convTextInRows).toBe(0);
		expect(r.after.continueAfterRestore).toBe(true);
		expect(r.after.historyReconstructed).toBe(true);
		expect(r.after.forgottenBodyLeft).toBe(0);
		expect(r.before.historyReconstructed).toBe(false);
	});
	test("tracker emits only changed items with per-item revisions", () => {
		const t = new RevisionTracker("s");
		const s = emptyState();
		expect(record(t, s, 1).map((r) => r.itemKind)).toEqual(["agency"]);
		expect(record(t, s, 2)).toEqual([]);
		s.focus = ["a"];
		expect(record(t, s, 3).map((r) => r.revision)).toEqual([2]);
	});
	test("a deleted item gets a tombstone row and is not resurrected on restore", () => {
		const t = new RevisionTracker("s");
		const s = emptyState();
		s.notes.push({ id: "n1", evidenceRefs: [] } as never);
		const rows = [...record(t, s, 1)];
		s.notes.splice(0, 1);
		s.revision += 1;
		const del = record(t, s, 2);
		expect(del.find((r) => r.itemId === "n1")?.revision).toBe(2);
		rows.push(...del);
		expect(stateFromRevisions(rows)!.state.notes).toEqual([]);
		expect(record(t, s, 3)).toEqual([]);
	});
	test("redact clears every row of an item that cited a forgotten id; restore drops it", () => {
		const t = new RevisionTracker("s");
		const s = emptyState();
		s.notes.push({ id: "n1", evidenceRefs: ["o9"] } as never);
		const rows = record(t, s, 1);
		const red = redactRevisions(rows, new Set(["o9"]));
		expect(red.find((r) => r.itemId === "n1")!.stateJson).toBe(REDACTED);
		expect(stateFromRevisions(red)!.state.notes).toEqual([]);
	});
});
