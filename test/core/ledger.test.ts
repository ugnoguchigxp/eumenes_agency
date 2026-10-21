import { describe, expect, test } from "bun:test";
import { ObservationConflictError } from "../../src/contracts/errors.ts";
import { createLedger } from "../../src/domains/experience/ledger.ts";
import { obsInput } from "./helpers.ts";

describe("ledger", () => {
	test("assigns seq in receipt order, not time order", () => {
		const l = createLedger();
		const a = l.record(obsInput("a", "user.report", "user", 500, "late"));
		const b = l.record(obsInput("b", "user.report", "user", 100, "early"));
		expect([a.seq, b.seq]).toEqual([1, 2]);
		expect(l.all().map((o) => o.id)).toEqual(["a", "b"]);
	});

	test("same id and same content is idempotent", () => {
		const l = createLedger();
		const a = l.record(obsInput("a", "user.report", "user", 1, "x", "c1"));
		const again = l.record(obsInput("a", "user.report", "user", 1, "x", "c1"));
		expect(again).toBe(a);
		expect(l.lastSeq()).toBe(1);
	});

	test("same id with different content conflicts", () => {
		const l = createLedger();
		l.record(obsInput("a", "user.report", "user", 1, "x"));
		expect(() =>
			l.record(obsInput("a", "user.report", "user", 1, "y")),
		).toThrow(ObservationConflictError);
		expect(() => l.record(obsInput("a", "correction", "user", 1, "x"))).toThrow(
			ObservationConflictError,
		);
		expect(l.lastSeq()).toBe(1);
	});

	test("cursor advances only over the contiguous processed range", () => {
		const l = createLedger();
		for (const id of ["a", "b", "c", "d"])
			l.record(obsInput(id, "user.report", "user", 1, id));
		expect(l.cursor()).toBe(0);
		expect(l.pending().map((o) => o.id)).toEqual(["a", "b", "c", "d"]);
		l.markProcessed([1, 2]);
		expect(l.cursor()).toBe(2);
		l.markProcessed([4]);
		expect(l.cursor()).toBe(2);
		expect(l.pending().map((o) => o.id)).toEqual(["c"]);
		l.markProcessed([3]);
		expect(l.cursor()).toBe(4);
		expect(l.pending()).toEqual([]);
	});

	test("pending can be bounded by seq", () => {
		const l = createLedger();
		for (const id of ["a", "b", "c"])
			l.record(obsInput(id, "user.report", "user", 1, id));
		expect(l.pending(2).map((o) => o.id)).toEqual(["a", "b"]);
	});
});
