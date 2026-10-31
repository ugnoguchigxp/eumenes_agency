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

describe("P4-c revisions", () => {
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
		expect(t.diff(s, "x", 1).map((r) => r.itemKind)).toEqual(["agency"]);
		expect(t.diff(s, "x", 2)).toEqual([]);
		s.focus = ["a"];
		expect(t.diff(s, "x", 3).map((r) => r.revision)).toEqual([2]);
	});
	test("a deleted item gets a tombstone row and is not resurrected on restore", () => {
		const t = new RevisionTracker("s");
		const s = emptyState();
		s.notes.push({ id: "n1", evidenceRefs: [] } as never);
		const rows = [...t.diff(s, "x", 1)];
		s.notes.splice(0, 1);
		s.revision += 1;
		const del = t.diff(s, "x", 2);
		expect(del.find((r) => r.itemId === "n1")?.revision).toBe(2);
		rows.push(...del);
		expect(stateFromRevisions(rows)!.state.notes).toEqual([]);
		expect(t.diff(s, "x", 3)).toEqual([]);
	});
	test("redact clears every row of an item that cited a forgotten id; restore drops it", () => {
		const t = new RevisionTracker("s");
		const s = emptyState();
		s.notes.push({ id: "n1", evidenceRefs: ["o9"] } as never);
		const rows = t.diff(s, "x", 1);
		const red = redactRevisions(rows, new Set(["o9"]));
		expect(red.find((r) => r.itemId === "n1")!.stateJson).toBe(REDACTED);
		expect(stateFromRevisions(red)!.state.notes).toEqual([]);
	});
});
