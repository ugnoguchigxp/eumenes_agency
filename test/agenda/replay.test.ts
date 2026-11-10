/**
 * Reading a real CLI log for the replay (eval/agenda/replay.ts): the user's lines and times, the
 * session's start and length, the plans-and-interests note rebuilt from earlier logs, the notes
 * that existed at the start, and the measures taken from a replay's events.
 */
import { describe, expect, test } from "bun:test";
import {
	memoryAlias,
	median,
	notesBefore,
	parseChatLog,
	profileLinesFromEvents,
	renderProfile,
	replayMetrics,
	sessionMinutes,
	sessionStartMs,
	userTurns,
	SAYS_NOTE_ID,
} from "../../eval/agenda/replay.ts";
import { profileLines } from "../../src/agenda/index.ts";
import type { AgendaSimEvent } from "../../eval/agenda/sim.ts";

const T0 = 1_794_305_177_360;
const line = (o: Record<string, unknown>) => JSON.stringify(o);
const log = [
	line({ at: T0, iso: "x", type: "session", mode: "agenda", interval: 10 }),
	line({ at: T0 + 6_032, type: "user", text: "こんばんわ" }),
	"this is not json",
	line({ at: T0 + 7_714, type: "reply", text: "こんばんは。" }),
	line({ at: T0 + 20_000, type: "user", text: "猫を飼ってるんですよ" }),
	line({ at: T0 + 21_000, type: "user", text: "" }),
	line({ at: T0 + 125_500, type: "user", text: "エリっていいます" }),
	line({ at: T0 + 150_000, type: "end", spentUsd: 0.1 }),
].join("\n");

describe("reading a log", () => {
	const events = parseChatLog(log);

	test("a broken line is skipped, the rest is kept", () => {
		expect(events.map((e) => e.type)).toEqual([
			"session",
			"user",
			"reply",
			"user",
			"user",
			"user",
			"end",
		]);
	});

	test("the start is the session event's time", () => {
		expect(sessionStartMs(events)).toBe(T0);
		// Without a session event, the first event.
		expect(sessionStartMs(events.slice(1))).toBe(T0 + 6_032);
		expect(() => sessionStartMs([])).toThrow();
	});

	test("the user's lines come with their seconds from the start, empty ones dropped", () => {
		expect(userTurns(events)).toEqual([
			{ atSec: 6.032, text: "こんばんわ" },
			{ atSec: 20, text: "猫を飼ってるんですよ" },
			{ atSec: 125.5, text: "エリっていいます" },
		]);
	});

	test("the length runs to the end event, in whole minutes", () => {
		expect(sessionMinutes(events)).toBe(3);
		// No end event: to the last event.
		expect(sessionMinutes(events.filter((e) => e.type !== "end"))).toBe(3);
	});
});

describe("the plans-and-interests note rebuilt from earlier logs", () => {
	const profile = (at: number, ...applied: string[]) =>
		parseChatLog(line({ at, type: "profile", applied }))[0]!;

	test("add, update and remove follow the ids the note gives (plans first, then interests)", () => {
		const lines = profileLinesFromEvents([
			profile(1, "add 予定: 映画に行く"),
			profile(2, "add 関心: ギター", "add 関心: 料理"),
			profile(3, "update p1: 映画に土曜に行く"),
			profile(4, "remove p2: ギター"),
			profile(5, "add 予定: 旅行", "update p3: 料理の腕を上げたい"),
		]);
		expect(lines).toEqual({
			plans: ["映画に土曜に行く", "旅行"],
			interests: ["料理の腕を上げたい"],
		});
	});

	test("an id that is not in the note changes nothing", () => {
		expect(
			profileLinesFromEvents([
				profile(1, "add 予定: 映画", "update p9: x", "remove p9"),
			]),
		).toEqual({ plans: ["映画"], interests: [] });
	});

	test("the rendered note reads back as the same lines in the agent's parser", () => {
		const note = renderProfile({
			plans: ["映画に行く"],
			interests: ["ギター", "料理"],
		});
		expect(profileLines(note).map((l) => [l.id, l.section, l.text])).toEqual([
			["p1", "plans", "映画に行く"],
			["p2", "interests", "ギター"],
			["p3", "interests", "料理"],
		]);
	});
});

describe("what existed at the start", () => {
	const note = (id: string, at: number) =>
		`<!-- agenda-note ${JSON.stringify({ id, title: "t", summary: "s", refs: [], at })} -->\nbody`;

	test("only notes made before the start, a broken header skipped", () => {
		expect(
			notesBefore(
				[
					{ name: "n1.md", raw: note("n1", T0 - 1) },
					{ name: "n2.md", raw: note("n2", T0) },
					{ name: "n3.md", raw: note("n3", T0 + 5) },
					{ name: "n4.md", raw: "<!-- agenda-note {broken} -->\nbody" },
					{ name: "n5.md", raw: "no header" },
				],
				T0,
			),
		).toEqual(["n1.md"]);
	});

	test("a memory item's alias is the store's (m + eight hex digits)", () => {
		expect(
			memoryAlias(
				"state:559edcf53c0272b1c2e08537b0b806c3c36bb28bb5bb78906197bfcceb2f7b41",
			),
		).toBe("m559edcf5");
	});
});

describe("the measures of a replay", () => {
	const ev = (e: unknown) => e as AgendaSimEvent;
	const usage = { latencyMs: 1, inputTokens: 1, outputTokens: 1 };
	const events: AgendaSimEvent[] = [
		ev({ type: "user", atSec: 10, id: "u1", text: "猫を飼ってるんですよ" }),
		ev({ type: "plan", atSec: 12, code: "applied", usage }),
		ev({
			type: "reply",
			atSec: 14,
			id: "r1",
			text: "いいですね。メモn87にあります。",
		}),
		ev({ type: "compose", atSec: 20, code: "stale", declined: null, usage }),
		ev({ type: "compose", atSec: 28, code: "applied", declined: null, usage }),
		ev({ type: "speak", atSec: 28, kind: "ask", text: "名前は何ですか？" }),
		ev({ type: "check", atSec: 30, verdict: "new", usage }),
		ev({ type: "compose", atSec: 40, code: "aborted", declined: null, usage }),
		ev({ type: "compose", atSec: 50, code: "applied", declined: null, usage }),
		ev({ type: "speak", atSec: 50, kind: "talk", text: "暖房はどうですか？" }),
		ev({ type: "user", atSec: 400, id: "u2", text: "エリです" }),
		ev({ type: "asked", atSec: 400, text: "猫の飼い方", queued: false }),
		ev({
			type: "reply",
			atSec: 403,
			id: "r2",
			text: "調べておきますね。猫の飼い方を調べることにしました。",
		}),
		ev({
			type: "reply",
			atSec: 410,
			id: "r3",
			text: "いえ、それは決めつけでした。",
		}),
		ev({ type: "speak", atSec: 800, kind: "talk", text: "今日は寒いですね。" }),
	];
	const m = replayMetrics(events);

	test("the time from a user line to the first own speech, and between own speeches", () => {
		// u1 (10) → 28; u2 (400) has no own speech before the end of its turn but 800.
		expect(m.responseSecs).toEqual([18, 400]);
		expect(m.gapSecs).toEqual([22, 750]);
		expect(m.speaks).toBe(3);
	});

	test("utterances thrown away, and the background calls", () => {
		expect(m.composes).toBe(4);
		expect(m.composeDropped).toBe(2);
		expect(m.backgroundCalls).toBe(1 + 4 + 1);
	});

	test("violations: a note's id aloud, research told twice, a take-back", () => {
		expect(m.saidId).toBe(1);
		expect(m.saidTwice).toBe(1);
		expect(m.tookBack).toBe(1);
		expect(m.replies).toBe(3);
	});

	test("own speech within five minutes of the user's talk is the topic check's, with the last two lines", () => {
		expect(m.inTalk.map((t) => t.text)).toEqual([
			"名前は何ですか？",
			"暖房はどうですか？",
		]);
		expect(m.inTalk[0]!.lastUser).toEqual([
			{ text: "猫を飼ってるんですよ", secAgo: 18 },
		]);
		expect(m.inTalk[0]!.before.at(-1)).toEqual({
			who: "reply",
			text: "いいですね。メモn87にあります。",
		});
	});

	test("note ids in the text: n and digits on their own, not inside a word", () => {
		expect(SAYS_NOTE_ID.test("メモ（n87）があり")).toBe(true);
		expect(SAYS_NOTE_ID.test("n1です")).toBe(true);
		expect(SAYS_NOTE_ID.test("iPhone13 and men")).toBe(false);
		expect(SAYS_NOTE_ID.test("n")).toBe(false);
	});

	test("median", () => {
		expect(median([])).toBeNull();
		expect(median([3, 1, 2])).toBe(2);
		expect(median([1, 2, 3, 4])).toBe(2.5);
	});
});
