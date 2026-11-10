/**
 * The ruler's speech numbers (review 2026-11-10): how much and how soon the agent speaks on its
 * own, from the events of one session.
 */
import { expect, test } from "bun:test";
import { speechMetrics } from "../../eval/agenda/metrics.ts";
import type { AgendaSimEvent } from "../../eval/agenda/sim.ts";

const usage = { latencyMs: 1, inputTokens: 1, outputTokens: 1 };

test("speech: rate, gaps, the longest silence, time to the first own words, notes and plans used", () => {
	const speak = (atSec: number, itemId: string, noteId: string | null = null) =>
		({
			type: "speak",
			atSec,
			kind: "talk",
			itemId,
			noteId,
			text: itemId,
		}) as const;
	const events: AgendaSimEvent[] = [
		{ type: "user", atSec: 0, id: "u1", text: "x" },
		{ type: "reply", atSec: 0, id: "r1", text: "y" },
		{
			type: "plan",
			atSec: 0,
			added: [
				{ id: "a1", kind: "ask", text: "q", value: 3 },
				{ id: "a2", kind: "talk", text: "t", value: 3 },
				{ id: "a3", kind: "research", text: "r", value: 3 },
			],
			dropped: [],
			rejected: [],
			reasons: [],
			changed: true,
			code: "applied",
			usage,
		},
		{
			type: "researched",
			atSec: 5,
			status: "succeeded",
			noteId: "n1",
			title: "t",
			summary: "s",
		},
		{
			type: "researched",
			atSec: 6,
			status: "succeeded",
			noteId: "n2",
			title: "t",
			summary: "s",
		},
		speak(10, "a2", "n1"),
		{
			type: "compose",
			atSec: 15,
			itemId: "a1",
			declined: null,
			code: "stale",
			usage,
		},
		{
			type: "compose",
			atSec: 20,
			itemId: "a1",
			declined: null,
			code: "applied",
			usage,
		},
		speak(20, "x1"),
		{ type: "user", atSec: 40, id: "u2", text: "x" },
		{
			type: "repeat",
			atSec: 41,
			itemId: "a9",
			text: "q",
			verdict: "asked",
			reason: "-",
		},
		speak(50, "x2"),
	];
	const m = speechMetrics(events, 1);
	expect(m).toMatchObject({
		own: 3,
		perMin: 3,
		gaps: [10, 30],
		gapP50: 20,
		// 20 s → 50 s with no words of the agent's.
		longestSilenceSec: 30,
		userLines: 2,
		firstOwnSec: [10, 10],
		notesMade: 2,
		notesUsed: 1,
		planned: 2,
		plannedSaid: 1,
		composes: 2,
		stale: 1,
		repeatsDropped: 1,
	});
	// A session with no words of the agent's is silent from start to end.
	expect(speechMetrics([], 10).longestSilenceSec).toBe(600);
});

test("speech: the quiet set is out of the rate and the silences, and counted on its own", () => {
	const events: AgendaSimEvent[] = [
		{ type: "user", atSec: 0, id: "u1", text: "30分は話しかけないで" },
		{ type: "quiet", atSec: 0, scope: "speech", minutes: 30 },
		{ type: "reply", atSec: 0, id: "r1", text: "わかりました" },
		{
			type: "speak",
			atSec: 1800,
			kind: "talk",
			itemId: "a1",
			noteId: null,
			text: "t",
		},
		// A pause of everything, ended early with 0 minutes.
		{ type: "quiet", atSec: 2000, scope: "all", minutes: 60 },
		{ type: "quiet", atSec: 2100, scope: "all", minutes: 0 },
		{ type: "reply_ask", atSec: 2200, itemId: "a2" },
		{
			type: "plan",
			atSec: 0,
			added: [{ id: "a2", kind: "ask", text: "q", value: 3 }],
			dropped: [],
			rejected: [],
			reasons: [],
			changed: true,
			code: "applied",
			usage: { latencyMs: 1, inputTokens: 1, outputTokens: 1 },
		},
		// After the session's end (a reply that ran over): not counted.
		{
			type: "speak",
			atSec: 2500,
			kind: "talk",
			itemId: "a3",
			noteId: null,
			text: "t",
		},
	];
	const m = speechMetrics(events, 40);
	// 30 min for speech + 100 s of the pause.
	expect(m.quietMin).toBeCloseTo(31 + 40 / 60, 5);
	expect(m.openMin).toBeCloseTo(40 - 31 - 40 / 60, 5);
	expect(m.own).toBe(1);
	expect(m.spokeInQuiet).toBe(0);
	expect(m.perMin).toBeCloseTo(1 / m.openMin, 5);
	// 1800 → 2400 s with the 100 s pause aside.
	expect(m.longestSilenceSec).toBe(500);
	// The question offered to a reply and asked there counts as said.
	expect(m.plannedSaid).toBe(1);
});

test("speech: a quiet for speech ends when the user talks again", () => {
	const m = speechMetrics(
		[
			{ type: "quiet", atSec: 0, scope: "speech", minutes: 60 },
			{ type: "user", atSec: 120, id: "u1", text: "ねえ" },
		],
		10,
	);
	expect(m.quietMin).toBe(2);
});
