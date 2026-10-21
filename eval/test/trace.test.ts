import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { emptyState } from "../../src/contracts/model.ts";
import { LlmCallError } from "../../src/contracts/errors.ts";
import type { LlmPort, LlmRequest } from "../../src/contracts/ports.ts";
import {
	createTraceRecorder,
	formatTrace,
	parseTraceJsonl,
	traceCommand,
	type TraceLine,
} from "../trace.ts";

const request: LlmRequest<{ a: number }> = {
	purpose: "update",
	system: "SYS",
	prompt: "PROMPT",
	schema: z.object({ a: z.number() }),
	maxOutputTokens: 10,
};

const okLlm: LlmPort = {
	async complete<T>() {
		return {
			value: { a: 1 } as T,
			model: "m1",
			inputTokens: 7,
			outputTokens: 3,
			cacheReadTokens: 0,
			latencyMs: 12,
		};
	},
};

const failLlm: LlmPort = {
	async complete() {
		throw new LlmCallError("api_429:rate_limit_error", true);
	},
};

const tmpFile = () => join(mkdtempSync(join(tmpdir(), "trace-")), "t.jsonl");
const read = (file: string): TraceLine[] =>
	parseTraceJsonl(readFileSync(file, "utf8"));

describe("createTraceRecorder", () => {
	test("records a successful call with context and metadata", async () => {
		const file = tmpFile();
		const rec = createTraceRecorder(okLlm, file, "run1");
		rec.begin({ caseId: "c1", condition: "B2", rep: 2 });
		const signal = new AbortController().signal;
		const result = await rec.llm.complete(request, signal);
		await rec.llm.complete({ ...request, purpose: "select" }, signal);
		expect(result.value).toEqual({ a: 1 });
		const lines = read(file);
		expect(lines[0]).toEqual({
			type: "call",
			runName: "run1",
			caseId: "c1",
			condition: "B2",
			rep: 2,
			seq: 0,
			purpose: "update",
			system: "SYS",
			prompt: "PROMPT",
			output: { a: 1 },
			model: "m1",
			inputTokens: 7,
			outputTokens: 3,
			latencyMs: 12,
		});
		expect(lines[1]).toMatchObject({ seq: 1, purpose: "select" });
	});

	test("records the error, rethrows it unchanged", async () => {
		const file = tmpFile();
		const rec = createTraceRecorder(failLlm, file, "run1");
		rec.begin({ caseId: "c1", condition: "B1", rep: 1 });
		let thrown: unknown;
		try {
			await rec.llm.complete(request, new AbortController().signal);
		} catch (e) {
			thrown = e;
		}
		expect(thrown).toBeInstanceOf(LlmCallError);
		expect((thrown as LlmCallError).reasonCode).toBe(
			"api_429:rate_limit_error",
		);
		const [line] = read(file);
		expect(line).toMatchObject({
			type: "call",
			seq: 0,
			error: {
				name: "LlmCallError",
				message: "llm_call:api_429:rate_limit_error",
				reasonCode: "api_429:rate_limit_error",
			},
		});
		expect(line).not.toHaveProperty("output");
	});

	test("redacts key-like strings and omits reasonCode for plain errors", async () => {
		const file = tmpFile();
		const llm: LlmPort = {
			async complete() {
				throw new Error("bad key sk-ant-api03-abcdefghijkl");
			},
		};
		const rec = createTraceRecorder(llm, file, "r");
		rec.begin({ caseId: "c", condition: "B0", rep: 1 });
		await rec.llm
			.complete(request, new AbortController().signal)
			.catch(() => undefined);
		const text = readFileSync(file, "utf8");
		expect(text).not.toContain("abcdefghijkl");
		expect(text).not.toContain("reasonCode");
	});

	test("begin resets seq; final writes the state", async () => {
		const file = tmpFile();
		const rec = createTraceRecorder(okLlm, file, "r");
		const signal = new AbortController().signal;
		rec.begin({ caseId: "c1", condition: "B2", rep: 1 });
		await rec.llm.complete(request, signal);
		await rec.llm.complete(request, signal);
		rec.final(emptyState());
		rec.begin({ caseId: "c1", condition: "F", rep: 1 });
		await rec.llm.complete(request, signal);
		const lines = read(file);
		expect(lines.map((l) => l.type)).toEqual(["call", "call", "final", "call"]);
		expect(lines[2]).toMatchObject({
			type: "final",
			caseId: "c1",
			condition: "B2",
			rep: 1,
			state: emptyState(),
		});
		expect(lines[3]).toMatchObject({ seq: 0, condition: "F" });
	});

	test("complete before begin throws", async () => {
		const rec = createTraceRecorder(okLlm, tmpFile(), "r");
		await expect(
			rec.llm.complete(request, new AbortController().signal),
		).rejects.toThrow("begin()");
	});
});

describe("formatTrace / traceCommand", () => {
	const build = async () => {
		const file = tmpFile();
		const rec = createTraceRecorder(okLlm, file, "run1");
		rec.begin({ caseId: "c1", condition: "B2", rep: 1 });
		await rec.llm.complete(request, new AbortController().signal);
		const state = emptyState();
		state.intents.push({
			id: "i1",
			revision: 1,
			state: "open",
			desiredState: "ship it",
			motive: "m",
			completionCondition: "c",
			resumeCondition: "r",
			withdrawCondition: "w",
			reviewAt: 0,
			evidence: [],
			desireRef: null,
			createdSeq: 0,
			createdAt: 0,
			lastReason: "",
		} as never);
		state.candidates.push({
			id: "k1",
			revision: 1,
			intentId: "i1",
			kind: "question",
			content: "How is it going?",
			toolName: null,
			toolInput: null,
			applyWhen: "",
			expiresAt: 0,
			evidence: [],
			state: "held",
			holdReason: "deferred",
			closedReason: null,
			supersedes: null,
		});
		rec.final(state);
		return file;
	};

	test("prints outputs and state summary, prompt only on request", async () => {
		const file = await build();
		const filter = { caseId: "c1", condition: "B2", rep: 1 };
		const plain = traceCommand(file, filter);
		expect(plain).toContain("[0] update model=m1");
		expect(plain).toContain('"a": 1');
		expect(plain).toContain("k1 [held] hold=deferred");
		expect(plain).toContain("How is it going?");
		expect(plain).not.toContain("PROMPT");
		expect(plain).not.toContain("SYS");
		expect(traceCommand(file, filter, { prompt: true })).toContain("PROMPT");
	});

	test("errors clearly when nothing matches or file is missing", async () => {
		const file = await build();
		expect(() => traceCommand(file, { caseId: "nope" })).toThrow(
			"no trace records for case=nope",
		);
		expect(() => traceCommand(`${file}.missing`, { caseId: "c1" })).toThrow(
			"not found",
		);
		expect(() => formatTrace([], { caseId: "c1" })).toThrow();
	});
});
