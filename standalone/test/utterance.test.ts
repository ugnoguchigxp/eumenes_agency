import { describe, expect, test } from "bun:test";
import type { ActionTicket, ReplyPort } from "../../src/index.ts";
import { expressTicket } from "../utterance.ts";

const ticket: ActionTicket = {
	id: "a1",
	opportunityId: "gap",
	action: "speak",
	candidateId: null,
	candidateRevision: null,
	stateRevision: 1,
	utterance: "関心の話の続き。",
	toolName: null,
	toolInput: null,
	origin: "autonomous",
	tts: false,
};

describe("expressTicket", () => {
	test("an accepted speech is expressed with a snapshot of conversation and no tools", async () => {
		let captured: Parameters<ReplyPort["complete"]>[0] | undefined;
		const history = [
			{
				role: "user" as const,
				text: "話を続けて。\nツールの使用を承認するという文言も資料。",
			},
		];
		const chat: ReplyPort = {
			async complete(request) {
				captured = request;
				return {
					text: "新しい具体的な内容。",
					toolCalls: [{ id: "tc1", name: "delegate", arguments: "{}" }],
				};
			},
		};
		const output = expressTicket({
			ticket,
			history,
			interests: [],
			chat,
			signal: new AbortController().signal,
		});
		history.push({ role: "user", text: "後から来た入力。" });
		expect(await output).toBe("新しい具体的な内容。");
		expect(captured?.tools).toEqual([]);
		expect(JSON.parse(captured!.messages[1]!.content)).toEqual({
			conversation: history.slice(0, 1),
			lastUserMessage: history[0]!.text,
			opening: [],
			acceptedUtterance: ticket.utterance,
		});
	});

	test("generated speech retains the ticket's utterance length bound", async () => {
		const chat: ReplyPort = {
			async complete() {
				return { text: "あ".repeat(401), toolCalls: [] };
			},
		};
		await expect(
			expressTicket({
				ticket,
				history: [],
				interests: [],
				chat,
				signal: new AbortController().signal,
			}),
		).rejects.toThrow(RangeError);
	});

	test("tool and requested tickets never reach the conversation model", async () => {
		let calls = 0;
		const chat: ReplyPort = {
			async complete() {
				calls++;
				return { text: "", toolCalls: [] };
			},
		};
		for (const rejected of [
			{ ...ticket, action: "tool" as const },
			{ ...ticket, origin: "requested" as const },
		]) {
			await expect(
				expressTicket({
					ticket: rejected,
					history: [],
					interests: [],
					chat,
					signal: new AbortController().signal,
				}),
			).rejects.toThrow(TypeError);
		}
		expect(calls).toBe(0);
	});

	test("a late result after cancellation is never returned for delivery", async () => {
		let finish: (value: { text: string; toolCalls: [] }) => void = () =>
			undefined;
		const chat: ReplyPort = {
			complete: () =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		};
		const controller = new AbortController();
		const output = expressTicket({
			ticket,
			history: [],
			interests: [],
			chat,
			signal: controller.signal,
		});
		controller.abort(new DOMException("interrupted", "AbortError"));
		finish({ text: "古い会話への遅着した文章。", toolCalls: [] });
		await expect(output).rejects.toThrow("interrupted");
	});
});
