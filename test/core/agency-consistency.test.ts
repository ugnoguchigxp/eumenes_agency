import { describe, expect, test } from "bun:test";
import {
	createAgencyRuntime,
	runRespond,
	type ReplyPort,
	defaultBudget,
	defaultLimits,
	type RuntimeDeps,
	type LlmPort,
	type LlmRequest,
} from "../../src/index.ts";
import {
	fakeLlm,
	obsInput,
	opportunity,
	proposal,
	b1Proposal,
	toWire,
	participation,
} from "./helpers.ts";

const sig = () => new AbortController().signal;
const user = (id = "o1") =>
	obsInput(id, "user.report", "user", 0, "host observation");
const make = (over: Partial<RuntimeDeps> = {}) => {
	const llm = fakeLlm();
	const rt = createAgencyRuntime({
		condition: "B1",
		systemContext: { update: "host update", select: "host select" },
		llm,
		tools: [],
		selectWhenEmpty: true,
		budget: { ...defaultBudget, minIntervalMs: 0 },
		...over,
	});
	return { rt, llm };
};
const deferred = <T>() => {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((r) => {
		resolve = r;
	});
	return { promise, resolve };
};
const result = <T>(value: T) => ({
	value,
	model: "fixture",
	inputTokens: 1,
	outputTokens: 1,
	cacheReadTokens: 0,
	latencyMs: 1,
});

// These tests reproduce violations of existing runtime contracts; no model or network is used.
describe("whole Agency consistency", () => {
	test("invalidation fences background updates and preserves pending observations", async () => {
		const { rt, llm } = make();
		rt.observe(user());
		llm.push("update", () => {
			rt.invalidate("instructions.changed", 1);
			return b1Proposal([
				{ op: "note.add", localId: "n", text: "stale", evidenceRefs: ["o1"] },
			]);
		});
		const calls = await rt.runBackground(1000, sig());
		expect(calls[0]?.code).toBe("rejected:stale_epoch");
		expect(rt.snapshot().state.notes).toEqual([]);
		expect(rt.snapshot().cursor).toBe(0);
	});
	test("OFF during select prevents reservation even without an AbortController supplied by the host", async () => {
		const { rt, llm } = make();
		rt.observe(user());
		llm.push("update", b1Proposal([]));
		llm.push("select", () => {
			rt.setEnabled(false);
			return participation({
				action: "speak",
				utterance: "stale",
				evidenceRefs: ["o1"],
			});
		});
		const r = await rt.decide(opportunity("p", 1000), sig());
		expect(r.decision.ticket).toBeNull();
		expect(rt.snapshot().state.attempts).toEqual([]);
	});
	test("OFF hides projection and cannot let an old select revive across OFF/ON", async () => {
		const { rt, llm } = make();
		rt.observe(user());
		llm.push(
			"update",
			b1Proposal([
				{ op: "note.add", localId: "n", text: "note", evidenceRefs: ["o1"] },
			]),
		);
		await rt.runBackground(1000, sig());
		rt.setEnabled(false);
		expect(rt.projection(5).items).toEqual([]);
		rt.setEnabled(true);
		llm.push("select", () => {
			rt.setEnabled(false);
			rt.setEnabled(true);
			return participation({
				action: "speak",
				utterance: "stale",
				evidenceRefs: ["o1"],
			});
		});
		expect(
			(await rt.decide(opportunity("p", 2000), sig())).decision.ticket,
		).toBeNull();
	});
	test("a canceled uncooperative background port cannot block the next update", async () => {
		const started = deferred<void>();
		const late = deferred<ReturnType<typeof result>>();
		let count = 0;
		const llm: LlmPort = {
			async complete<T>() {
				count++;
				if (count === 1) {
					started.resolve();
					return late.promise as Promise<ReturnType<typeof result<T>>>;
				}
				return result(toWire(b1Proposal([]))) as ReturnType<typeof result<T>>;
			},
		};
		const { rt } = make({ llm });
		rt.observe(user());
		const controller = new AbortController();
		const first = rt.runBackground(1000, controller.signal);
		await started.promise;
		controller.abort();
		const winner = await Promise.race([
			first.then(() => "finished"),
			new Promise<string>((r) => setTimeout(() => r("blocked"), 30)),
		]);
		// Resolve the dangling fixture even on the old implementation so the test cannot leave work running.
		if (winner === "blocked") late.resolve(result(toWire(b1Proposal([]))));
		await first;
		expect(winner).toBe("finished");
		const second = await rt.runBackground(2000, sig());
		expect(second[0]?.code).toBe("no_change");
		late.resolve(
			result(
				toWire(
					b1Proposal([
						{
							op: "note.add",
							localId: "n",
							text: "late",
							evidenceRefs: ["o1"],
						},
					]),
				),
			),
		);
		await Promise.resolve();
		expect(rt.snapshot().state.notes).toEqual([]);
	});
	test("raw port results are revalidated before select can reserve an action", async () => {
		const llm: LlmPort = {
			async complete<T>() {
				return result(
					participation({
						action: "speak",
						utterance: "x".repeat(401),
						evidenceRefs: ["memory:t"],
					}),
				) as ReturnType<typeof result<T>>;
			},
		};
		const { rt } = make({ llm, hostTopics: true });
		const r = await rt.decide(
			{ ...opportunity("p", 1000), topics: [{ id: "t", text: "topic" }] },
			sig(),
		);
		expect(r.decision.ticket).toBeNull();
		expect(r.calls[0]?.code).toBe("llm:schema");
	});
	test("returned observations do not allow a caller to alter the ledger or its future prompts", async () => {
		const { rt, llm } = make();
		const observed = rt.observe(user());
		try {
			Object.assign(observed, { text: "mutated", actor: "tool" });
		} catch {
			/* immutable results are also valid */
		}
		const snap = rt.snapshot();
		try {
			Object.assign(snap.observations[0]!, { text: "snapshot mutation" });
		} catch {}
		expect(rt.snapshot().observations[0]).toMatchObject({
			text: "host observation",
			actor: "user",
		});
		llm.push("update", b1Proposal([]));
		await rt.runBackground(1000, sig());
		expect(JSON.parse(llm.requests[0]!.prompt).observations[0].text).toBe(
			"host observation",
		);
	});
	test("projection evidence arrays are detached from stored beliefs", async () => {
		const { rt, llm } = make({ condition: "F", limits: { ...defaultLimits } });
		rt.observe(user());
		llm.push(
			"update",
			proposal([
				{
					op: "belief.add",
					localId: "b",
					content: "fact",
					confidence: "medium",
					evidenceRefs: ["o1"],
				},
			]),
		);
		await rt.runBackground(1000, sig());
		rt.observe(user("o2"));
		llm.push("update", proposal([], { focusRefs: ["b1"] }));
		await rt.runBackground(2000, sig());
		const projection = rt.projection(5);
		const item = projection.items.find((i) => i.id === "b1")!;
		(item.evidence as string[]).push("forged");
		expect(rt.snapshot().state.beliefs[0]?.evidence).toEqual(["o1"]);
	});
	test("an opportunity queued before invalidation cannot start later under the new epoch", async () => {
		const started = deferred<void>();
		const release = deferred<void>();
		const base = fakeLlm();
		const port: LlmPort = {
			async complete<T>(request: LlmRequest<T>, signal: AbortSignal) {
				started.resolve();
				await release.promise;
				return base.complete(request, signal);
			},
		};
		const { rt } = make({ llm: port });
		base.push("select", participation(), participation());
		const first = rt.decide(opportunity("first", 1000), sig());
		await started.promise;
		const queued = rt.decide(opportunity("queued", 1000), sig());
		rt.invalidate("input.changed", 1100);
		release.resolve();
		await first;
		const second = await queued;
		expect(second.decision.source).toBe("rejected");
		expect(second.decision.rejectCodes).toContain("stale_epoch");
		expect(base.count()).toBe(1);
	});
	test("host observation IDs cannot collide with generated receipt IDs", async () => {
		const { rt, llm } = make();
		rt.observe(user("h2"));
		llm.push("update", b1Proposal([]));
		llm.push(
			"select",
			participation({
				action: "speak",
				utterance: "speech",
				evidenceRefs: ["h2"],
			}),
		);
		const { decision } = await rt.decide(opportunity("p", 1000), sig());
		const receipt = rt.recordResult({
			ticketId: decision.ticket!.id,
			status: "succeeded",
			at: 2000,
			resultText: "speech",
		});
		expect(receipt.id).not.toBe("h2");
		expect(rt.snapshot().observations).toHaveLength(2);
		expect(rt.snapshot().state.attempts[0]?.status).toBe("succeeded");
	});
	test("invalid budgets fail closed at the runtime boundary", () => {
		for (const budget of [
			{ ...defaultBudget, batchSize: 0 },
			{ ...defaultBudget, maxCallsPerWindow: NaN },
			{ ...defaultBudget, minIntervalMs: -1 },
			{ ...defaultBudget, windowMs: Infinity },
		])
			expect(() => make({ budget })).toThrow();
	});
	test("invalid execution limits fail closed instead of bypassing outbound intervals", () => {
		for (const limits of [
			{ ...defaultLimits, outboundIntervalMs: NaN },
			{ ...defaultLimits, notes: -1 },
			{ ...defaultLimits, reviewAfterMaxHours: Infinity },
			{ ...defaultLimits, capacityPressureRatio: 2 },
		])
			expect(() => make({ limits })).toThrow();
	});
	test("duplicate or malformed reply tool calls cannot execute effects", async () => {
		for (const value of [
			{
				text: "",
				toolCalls: [
					{ id: "same", name: "host", arguments: "{}" },
					{ id: "same", name: "host", arguments: "{}" },
				],
			},
			{ text: "", toolCalls: [{ id: "", name: "host", arguments: "{}" }] },
		]) {
			let executions = 0;
			const chat = { complete: async () => value } as ReplyPort;
			const work = runRespond({
				messages: [{ role: "system", content: "host" }],
				chat,
				tools: {
					tools: [],
					call: async () => {
						executions++;
						return { content: "result", end: true };
					},
				},
				emotion: false,
				signal: sig(),
				onDelta: () => {},
			});
			await expect(work).rejects.toThrow();
			expect(executions).toBe(0);
		}
	});
	test("queued background work is fenced while fresh work still processes the pending ledger", async () => {
		const started = deferred<void>();
		const release = deferred<void>();
		const fixture = fakeLlm();
		const port: LlmPort = {
			async complete<T>(request: LlmRequest<T>, signal: AbortSignal) {
				started.resolve();
				await release.promise;
				return fixture.complete(request, signal);
			},
		};
		const { rt } = make({ llm: port });
		fixture.push("select", participation());
		const first = rt.decide(opportunity("p", 1000), sig());
		await started.promise;
		rt.observe(user());
		const queued = rt.runBackground(1000, sig());
		rt.invalidate("input.changed", 1100);
		release.resolve();
		await first;
		expect((await queued)[0]?.code).toBe("rejected:stale_epoch");
		expect(rt.snapshot().cursor).toBe(0);
		expect(fixture.count()).toBe(1);
		fixture.push("update", b1Proposal([]));
		expect((await rt.runBackground(2000, sig()))[0]?.code).toBe("no_change");
		expect(rt.snapshot().cursor).toBe(1);
	});
	test("opportunity input and runtime bounds are captured independently of the caller", async () => {
		const limits = { ...defaultLimits };
		const budget = { ...defaultBudget, minIntervalMs: 0 };
		const { rt, llm } = make({ limits, budget, hostTopics: true });
		const opp = {
			...opportunity("p", 1000),
			topics: [{ id: "t", text: "original" }],
		};
		llm.push("select", participation());
		const work = rt.decide(opp, sig());
		opp.topics[0]!.text = "caller mutation";
		limits.notes = 999;
		budget.batchSize = 0;
		await work;
		const data = JSON.parse(llm.requests[0]!.prompt);
		expect(data.topics[0].text).toBe("original");
		expect(data.limits.notes).toBe(defaultLimits.notes);
		rt.observe(user());
		llm.push("update", b1Proposal([]));
		expect((await rt.runBackground(2000, sig()))[0]?.code).toBe("no_change");
	});
});
