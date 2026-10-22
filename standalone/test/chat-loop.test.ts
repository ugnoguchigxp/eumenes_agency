import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { maxIdleSec, ttsUtteranceStyle } from "../../src/index.ts";
import {
	createChatLog,
	createConversation,
	decisionEvent,
	decisionLine,
	defaultLogPath,
	parseCliArgs,
	printAbove,
	resolveCondition,
	ttsReplyStyle,
} from "../chat-loop.ts";
import {
	defaultInterestText,
	maxInterestChars,
	personaPrompt,
	toStandingInterests,
} from "../persona.ts";

describe("parseCliArgs / resolveCondition", () => {
	test("defaults: B1a, idle 10s, one unanswered, default log, social on", () => {
		expect(parseCliArgs([])).toEqual({
			condition: "B1a",
			off: false,
			idleSec: 10,
			maxUnanswered: 1,
			log: { kind: "default" },
			tts: true,
			social: true,
			quietWhy: false,
			interests: [defaultInterestText],
		});
	});

	test("flags", () => {
		const args = parseCliArgs([
			"--condition",
			"B2",
			"--off",
			"--idle-sec",
			"0",
			"--max-unanswered",
			"3",
			"--log",
			"x.jsonl",
		]);
		expect(args).toMatchObject({
			condition: "B2",
			off: true,
			idleSec: 0,
			maxUnanswered: 3,
			log: { kind: "path", path: "x.jsonl" },
		});
		expect(parseCliArgs(["--no-log"]).log).toEqual({ kind: "none" });
	});

	test("--social / --no-social (default on, last one wins); --quiet-why", () => {
		expect(parseCliArgs([]).social).toBe(true);
		expect(parseCliArgs(["--social"]).social).toBe(true);
		expect(parseCliArgs(["--no-social"]).social).toBe(false);
		expect(parseCliArgs(["--no-social", "--social"]).social).toBe(true);
		expect(parseCliArgs(["--social", "--no-social"]).social).toBe(false);
		expect(parseCliArgs([]).quietWhy).toBe(false);
		expect(parseCliArgs(["--quiet-why"]).quietWhy).toBe(true);
	});

	test("--tts / --no-tts (default on, last one wins)", () => {
		expect(parseCliArgs([]).tts).toBe(true);
		expect(parseCliArgs(["--tts"]).tts).toBe(true);
		expect(parseCliArgs(["--no-tts"]).tts).toBe(false);
		expect(parseCliArgs(["--no-tts", "--tts"]).tts).toBe(true);
		expect(parseCliArgs(["--tts", "--no-tts"]).tts).toBe(false);
	});

	test("--interest (repeatable) / --no-interest; default is the My Melody interest", () => {
		expect(parseCliArgs([]).interests).toEqual([defaultInterestText]);
		expect(defaultInterestText).toContain("マイメロディ");
		expect(
			parseCliArgs(["--interest", "猫が好き", "--interest", " 紅茶 "])
				.interests,
		).toEqual(["猫が好き", "紅茶"]);
		expect(parseCliArgs(["--no-interest"]).interests).toEqual([]);
		expect(() => parseCliArgs(["--interest"])).toThrow();
		expect(() => parseCliArgs(["--interest", "--off"])).toThrow();
		expect(() => parseCliArgs(["--interest", " "])).toThrow();
		expect(() =>
			parseCliArgs(["--interest", "あ".repeat(maxInterestChars + 1)]),
		).toThrow();
		expect(() => parseCliArgs(["--interest", "猫", "--no-interest"])).toThrow();
	});

	test("rejects bad input", () => {
		expect(() => parseCliArgs(["--condition", "Z"])).toThrow();
		expect(() => parseCliArgs(["--idle-sec"])).toThrow();
		expect(() => parseCliArgs(["--idle-sec", "-1"])).toThrow();
		expect(() =>
			parseCliArgs(["--idle-sec", String(maxIdleSec + 1)]),
		).toThrow();
		expect(parseCliArgs(["--idle-sec", String(maxIdleSec)]).idleSec).toBe(
			maxIdleSec,
		);
		expect(() => parseCliArgs(["--max-unanswered", "1.5"])).toThrow();
		expect(() => parseCliArgs(["--log"])).toThrow();
		expect(() => parseCliArgs(["--bogus"])).toThrow();
	});

	test("B1a is B1 with selectWhenEmpty; others pass through", () => {
		expect(resolveCondition("B1a")).toEqual({
			condition: "B1",
			selectWhenEmpty: true,
		});
		expect(resolveCondition("B1")).toEqual({
			condition: "B1",
			selectWhenEmpty: false,
		});
		expect(resolveCondition("F")).toEqual({
			condition: "F",
			selectWhenEmpty: false,
		});
	});
});

describe("createConversation", () => {
	test("merges a proactive line into the preceding assistant turn", () => {
		const c = createConversation();
		c.addUser("こんにちは");
		c.addAssistant("どうも");
		c.addAssistant("そういえば");
		expect(c.messages()).toEqual([
			{ role: "user", text: "こんにちは" },
			{ role: "assistant", text: "どうも\nそういえば" },
		]);
		c.addUser("はい");
		expect(c.messages().map((t) => t.role)).toEqual([
			"user",
			"assistant",
			"user",
		]);
	});

	test("a proactive opener never becomes a leading assistant message", () => {
		const c = createConversation();
		c.addAssistant("先に話します");
		expect(c.messages()).toEqual([]);
		expect(c.systemAddendum()).toContain("先に話します");
		c.addUser("はい");
		c.addAssistant("了解");
		expect(c.messages()[0]?.role).toBe("user");
		expect(c.messages().map((t) => t.role)).toEqual(["user", "assistant"]);
	});

	test("no addendum without an opener; rollback removes only a trailing user turn", () => {
		const c = createConversation();
		expect(c.systemAddendum()).toBe("");
		c.addUser("a");
		c.rollbackUser();
		expect(c.messages()).toEqual([]);
		c.addUser("a");
		c.addAssistant("b");
		c.rollbackUser();
		expect(c.messages()).toHaveLength(2);
	});

	test("messages() is a snapshot", () => {
		const c = createConversation();
		c.addUser("a");
		const snap = c.messages();
		c.addAssistant("b");
		expect(snap).toHaveLength(1);
	});
});

describe("chat log", () => {
	test("default path uses a filesystem-safe ISO stamp and the condition", () => {
		expect(
			defaultLogPath("B1a", new Date("2026-10-22T01:02:03.000Z"), "data/chats"),
		).toBe("data/chats/2026-10-22T01-02-03.000Z-B1a.jsonl");
	});

	test("appends JSONL, creating the directory once", () => {
		const dir = mkdtempSync(join(tmpdir(), "chat-log-"));
		const path = join(dir, "sub", "c.jsonl");
		const log = createChatLog(path, () => 1000);
		log.write({ type: "user", text: "a" });
		log.write({ type: "proactive", trigger: "idle", text: "b" });
		const rows = readFileSync(path, "utf8")
			.trim()
			.split("\n")
			.map((l) => JSON.parse(l));
		expect(rows).toEqual([
			{ at: 1000, iso: "1970-01-01T00:00:01.000Z", type: "user", text: "a" },
			{
				at: 1000,
				iso: "1970-01-01T00:00:01.000Z",
				type: "proactive",
				trigger: "idle",
				text: "b",
			},
		]);
	});

	test("null path writes nothing; failure is reported once", () => {
		const errors: string[] = [];
		createChatLog(null, () => 0).write({ type: "x" });
		const log = createChatLog(
			"/nope/x.jsonl",
			() => 0,
			(m) => errors.push(m),
			() => {
				throw new Error("disk");
			},
			() => undefined,
		);
		log.write({ type: "a" });
		log.write({ type: "b" });
		expect(errors).toEqual(["disk"]);
	});
});

describe("decision visibility", () => {
	const decision = {
		opportunityId: "o3",
		action: "wait" as const,
		source: "llm" as const,
		candidateId: null,
		utterance: null,
		toolName: null,
		toolInput: null,
		evidenceRefs: ["o1", "interest:i1"],
		reason: "雑談中で\n話題がまだ合わない。",
		ticket: null,
		rejectCodes: ["unknown_ref"],
	};

	test("event carries action, source, reason, rejectCodes and evidenceRefs", () => {
		expect(decisionEvent("idle", true, decision)).toEqual({
			type: "decision",
			trigger: "idle",
			auto: true,
			opportunityId: "o3",
			action: "wait",
			source: "llm",
			reason: "雑談中で\n話題がまだ合わない。",
			rejectCodes: ["unknown_ref"],
			evidenceRefs: ["o1", "interest:i1"],
		});
	});

	test("every decision (turn_end / idle, auto / manual) is written to the JSONL", () => {
		const dir = mkdtempSync(join(tmpdir(), "chat-decision-"));
		const path = join(dir, "d.jsonl");
		const log = createChatLog(path, () => 5);
		for (const [trigger, auto] of [
			["turn_end", true],
			["idle", true],
			["idle", false],
		] as const)
			log.write(decisionEvent(trigger, auto, decision));
		const rows = readFileSync(path, "utf8")
			.trim()
			.split("\n")
			.map((l) => JSON.parse(l));
		expect(rows.map((r) => [r.type, r.trigger, r.auto, r.action])).toEqual([
			["decision", "turn_end", true, "wait"],
			["decision", "idle", true, "wait"],
			["decision", "idle", false, "wait"],
		]);
		expect(rows[0].rejectCodes).toEqual(["unknown_ref"]);
		expect(rows[0].evidenceRefs).toEqual(["o1", "interest:i1"]);
	});

	test("the printed line is one line: action(source): reason", () => {
		const line = decisionLine({ ...decision, rejectCodes: [] });
		expect(line).toBe("[判断] wait(llm): 雑談中で 話題がまだ合わない。");
		expect(line).not.toContain("\n");
		expect(decisionLine(decision)).toContain("[reject: unknown_ref]");
	});
});

describe("printAbove", () => {
	const make = (rows: number, isTTY = true) => {
		const writes: string[] = [];
		const calls: string[] = [];
		const rl = {
			prevRows: 7,
			getCursorPos: () => ({ rows, cols: 3 }),
			prompt: (preserve?: boolean) => {
				calls.push(`prompt:${preserve}:prevRows=${rl.prevRows}`);
			},
		};
		const stdout = {
			isTTY,
			write: (d: string) => {
				writes.push(d);
				return true;
			},
		};
		return { rl, stdout, writes, calls };
	};

	test("clears the whole wrapped input from the real cursor row, prints, then redraws", () => {
		const { rl, stdout, writes, calls } = make(2);
		printAbove(rl, stdout as never, "hello");
		expect(writes.join("")).toBe("\x1b[2A\x1b[1G\x1b[0Jhello\n");
		// readline's stale row count must be reset before it redraws
		expect(calls).toEqual(["prompt:true:prevRows=0"]);
	});

	test("a single-row input does not move up", () => {
		const { rl, stdout, writes } = make(0);
		printAbove(rl, stdout as never, "x");
		expect(writes.join("")).toBe("\x1b[1G\x1b[0Jx\n");
	});

	test("a non-TTY output is written plainly", () => {
		const { rl, stdout, writes, calls } = make(3, false);
		printAbove(rl, stdout as never, "x");
		expect(writes).toEqual(["x\n"]);
		expect(calls).toHaveLength(1);
	});
});

describe("tts styles", () => {
	test("spoken-style rules are present", () => {
		for (const style of [ttsReplyStyle, ttsUtteranceStyle]) {
			expect(style).toContain("話し言葉");
			expect(style).toContain("Markdown");
			expect(style).toContain("URL");
		}
		expect(ttsUtteranceStyle).toContain("1〜2文");
	});
});

describe("persona", () => {
	test("interest ids are stable and the prompt is empty without interests", () => {
		expect(toStandingInterests(["a", "b"])).toEqual([
			{ id: "i1", text: "a" },
			{ id: "i2", text: "b" },
		]);
		expect(personaPrompt([])).toBe("");
		const prompt = personaPrompt([defaultInterestText]);
		expect(prompt).toContain(defaultInterestText);
		expect(prompt).toContain("聞かれたら");
		expect(prompt).toContain("寄せたり");
	});
});
