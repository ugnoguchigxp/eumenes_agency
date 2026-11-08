/**
 * The CLI's host loop on a fake clock: reply → think → prepare → result → share, typing pauses,
 * and what the logs count. No API, no real timers.
 */
import { describe, expect, test } from "bun:test";
import { createAlwaysOnAgent } from "../../src/index.ts";
import {
	createAlwaysOnSession,
	tickAction,
	type SessionEvent,
} from "../../standalone/always-on-session.ts";
import { funnel } from "../../eval/always-on/funnel.ts";
import { createMockPreparer } from "../../examples/virtual-eumenes/always-on-mock.ts";
import { prepare, say, scriptedThink, wait } from "./helpers.ts";

/** The id of the user's first observation shown to the tick (ids carry a session stamp). */
const userRef = (d: Record<string, unknown>) =>
	(d["observations"] as { id: string; who: string }[]).find(
		(o) => o.who === "user",
	)!.id;

/** A fake clock whose timers run in time order; promises settle between them. */
const fakeClock = () => {
	let now = 0;
	let seq = 0;
	const timers = new Map<number, { at: number; fn: () => void }>();
	const settle = async () => {
		for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
	};
	return {
		now: () => now,
		setTimer: (fn: () => void, ms: number) => {
			const id = ++seq;
			timers.set(id, { at: now + ms, fn });
			return id;
		},
		clearTimer: (h: unknown) => {
			timers.delete(h as number);
		},
		/** Runs every timer due within `ms`, in order, letting async work finish. */
		async advance(ms: number) {
			const end = now + ms;
			await settle();
			for (;;) {
				const next = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
				if (!next || next[1].at > end) break;
				timers.delete(next[0]);
				now = Math.max(now, next[1].at);
				next[1].fn();
				await settle();
			}
			now = end;
		},
	};
};

describe("always-on CLI session", () => {
	test("reply, then a silent preparation, then its result shared at the next tick", async () => {
		const clock = fakeClock();
		const events: SessionEvent[] = [];
		const llm = scriptedThink((d, n) => {
			if (n === 1) return prepare("research", "辛いラーメン店", [userRef(d)]);
			const stock = d["stock"] as { id: string }[];
			return stock.length
				? say("気になって調べておいたよ", [stock[0]!.id])
				: wait();
		});
		const preparer = createMockPreparer({
			subagent: {
				run: async () => ({ status: "succeeded", summary: "A店が評判" }),
			},
			delayMs: 60_000,
		});
		const agent = createAlwaysOnAgent({ llm, tools: preparer.tools });
		const session = createAlwaysOnSession({
			agent,
			preparer,
			reply: async () => "いいですね！",
			emit: (e) => events.push(e),
			...clock,
		});
		session.start();
		await session.say("辛いラーメンにハマってる");
		await clock.advance(10_000);
		expect(events.map((e) => e.type)).toEqual([
			"user",
			"reply",
			"tick",
			"prepare",
		]);
		// The result comes back after 60 s; the next tick is 10 s later and shares it.
		await clock.advance(60_000);
		expect(events.at(-1)).toMatchObject({
			type: "prepared",
			text: "A店が評判",
		});
		await clock.advance(10_000);
		expect(events.at(-1)).toMatchObject({
			type: "speak",
			action: "speak",
			text: "気になって調べておいたよ",
		});
		expect(agent.view().stock[0]!.usedAt).not.toBeNull();
		session.close();
	});

	test("typing pauses thinking; it resumes after the typing stops", async () => {
		const clock = fakeClock();
		const llm = scriptedThink(() => wait());
		const agent = createAlwaysOnAgent({ llm });
		const session = createAlwaysOnSession({
			agent,
			preparer: createMockPreparer({
				subagent: { run: async () => ({ status: "succeeded", summary: "" }) },
				delayMs: 1,
			}),
			reply: async () => "x",
			emit: () => undefined,
			typingIdleMs: 4_000,
			...clock,
		});
		session.start();
		await clock.advance(5_000);
		session.typed();
		await clock.advance(3_000);
		session.typed();
		await clock.advance(3_000);
		// Still typing at 11 s: the 10 s tick did not run.
		expect(llm.requests.length).toBe(0);
		await clock.advance(20_000);
		expect(llm.requests.length).toBe(1);
		session.close();
	});

	test("logs count a preparation as a preparation, not as speech", async () => {
		const clock = fakeClock();
		const events: SessionEvent[] = [];
		const agent = createAlwaysOnAgent({
			llm: scriptedThink((d) => prepare("research", "q", [userRef(d)])),
			tools: createMockPreparer({
				subagent: { run: async () => ({ status: "succeeded", summary: "r" }) },
				delayMs: 60_000,
			}).tools,
		});
		const preparer = createMockPreparer({
			subagent: { run: async () => ({ status: "succeeded", summary: "r" }) },
			delayMs: 60_000,
		});
		const session = createAlwaysOnSession({
			agent,
			preparer,
			reply: async () => "ok",
			emit: (e) => events.push(e),
			...clock,
		});
		session.start();
		await session.say("こんにちは");
		await clock.advance(10_000);
		const tick = events.find((e) => e.type === "tick");
		expect(tick && tickAction(tick.outcome)).toBe("prepare");
		const log = [
			JSON.stringify({ at: 0, type: "session" }),
			JSON.stringify({ at: 1, type: "tick", action: "prepare" }),
		].join("\n");
		expect(funnel([log])).toMatchObject({ ownUtterances: 0, prepares: 1 });
		session.close();
	});

	test("a mute holds speech, a stop holds everything, resume brings both back", async () => {
		const clock = fakeClock();
		const events: SessionEvent[] = [];
		const llm = scriptedThink((_d, n) => say(`一言${n}`));
		const agent = createAlwaysOnAgent({ llm });
		const session = createAlwaysOnSession({
			agent,
			preparer: createMockPreparer({
				subagent: { run: async () => ({ status: "succeeded", summary: "" }) },
				delayMs: 1,
			}),
			reply: async () => "x",
			emit: (e) => events.push(e),
			...clock,
		});
		session.mute(30);
		session.start();
		await clock.advance(60_000);
		expect(events.filter((e) => e.type === "speak")).toEqual([]);
		session.stop();
		const calls = llm.requests.length;
		await clock.advance(3_600_000);
		expect(llm.requests.length).toBe(calls);
		session.resume();
		await clock.advance(20_000);
		expect(events.filter((e) => e.type === "speak").length).toBe(1);
		session.close();
	});
});
