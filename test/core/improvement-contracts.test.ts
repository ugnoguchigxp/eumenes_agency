import { expect, test } from "bun:test";
import {
	createAgencyRuntime,
	defaultBudget,
	defaultLimits,
} from "../../src/index.ts";
import { ActivityBudget } from "../../src/application/activity-budget.ts";
import {
	fakeLlm,
	proposal,
	b1Proposal,
	participation,
	obsInput,
	opportunity,
	intentAddOp,
	candidateAddOp,
	tools,
} from "./helpers.ts";

const signal = () => new AbortController().signal;

test.each(["invalidate", "off-on"])(
	"queued wake is fenced by %s, fresh wake still runs",
	async (mode) => {
		const fake = fakeLlm();
		let release!: () => void;
		let started!: () => void;
		const gate = new Promise<void>((r) => {
			release = r;
		});
		const ready = new Promise<void>((r) => {
			started = r;
		});
		let first = true;
		const rt = createAgencyRuntime({
			condition: "B1",
			systemContext: "experimental",
			tools: [],
			selectWhenEmpty: true,
			budget: { ...defaultBudget, minIntervalMs: 0 },
			llm: {
				async complete(req, sig) {
					if (first) {
						first = false;
						started();
						await gate;
					}
					return fake.complete(req, sig);
				},
			},
		});
		rt.observe(obsInput("o1", "user.report", "user", 0, "相談"));
		fake.push("update", b1Proposal(), b1Proposal());
		fake.push("select", participation());
		const running = rt.runBackground(1, signal());
		await ready;
		const queued = rt.wake!(
			2,
			{ presence: "quiet", foregroundBusy: false, idleDue: true },
			signal(),
		);
		if (mode === "off-on") {
			rt.setEnabled(false);
			rt.setEnabled(true);
		} else rt.invalidate("speech.started", 3);
		release();
		await running;
		const old = await queued;
		expect(old.calls).toEqual([]);
		expect(old.decision?.ticket ?? null).toBeNull();
		expect(fake.count()).toBe(1);
		const fresh = await rt.wake!(
			4,
			{ presence: "quiet", foregroundBusy: false, idleDue: true },
			signal(),
		);
		expect(fresh.calls.length).toBeGreaterThan(0);
	},
);

test("queued wake captures its host inputs", async () => {
	let release!: () => void;
	let started!: () => void;
	const gate = new Promise<void>((r) => {
		release = r;
	});
	const ready = new Promise<void>((r) => {
		started = r;
	});
	const f = fakeLlm();
	f.push("update", b1Proposal());
	const rt = createAgencyRuntime({
		condition: "B1",
		systemContext: "experimental",
		tools: [],
		llm: {
			async complete(req, sig) {
				started();
				await gate;
				return f.complete(req, sig);
			},
		},
	});
	rt.observe(obsInput("o1", "user.report", "user", 0, "入力"));
	const running = rt.runBackground(0, signal());
	await ready;
	const host = {
		presence: "speaking" as "speaking" | "quiet",
		foregroundBusy: true,
		idleDue: true,
	};
	const queued = rt.wake!(1, host, signal());
	host.presence = "quiet";
	host.foregroundBusy = false;
	release();
	await running;
	expect((await queued).calls).toEqual([]);
	expect(f.count()).toBe(1);
});

test.each(["toolCalls", "tokens", "elapsedMs"] as const)(
	"zero %s blocks the first tool",
	(key) => {
		const b = new ActivityBudget({
			toolCalls: 3,
			tokens: 100,
			elapsedMs: 1000,
			[key]: 0,
		});
		expect(b.canIssueTool("new", 0)).toBe(false);
		const restored = new ActivityBudget(b.limits, b.snapshot());
		expect(restored.canIssueTool("new", 0)).toBe(false);
	},
);

test.each([NaN, Infinity, -1, 0.5])(
	"invalid activity limits are rejected: %s",
	(toolCalls) => {
		expect(
			() => new ActivityBudget({ toolCalls, tokens: 100, elapsedMs: 1000 }),
		).toThrow();
	},
);

test("returned observation metadata cannot modify the append-only ledger", () => {
	const rt = createAgencyRuntime({
		condition: "B0",
		systemContext: "experimental",
		tools: [],
		llm: fakeLlm(),
	});
	const input = {
		...obsInput("o1", "recall.offered", "host", 0, "資料"),
		refs: ["interest:k1"],
		speechHandoff: { proposedText: "本文", findingWorkRefs: ["w1"] },
	};
	const o = rt.observe(input);
	expect(() => (o.refs as string[]).push("injected")).toThrow();
	expect(() => {
		(o.speechHandoff as { proposedText: string }).proposedText = "changed";
	}).toThrow();
	expect(() =>
		(o.speechHandoff!.findingWorkRefs as string[]).push("w2"),
	).toThrow();
	expect(rt.observe(input)).toBe(o);
	expect(rt.snapshot().observations[0]?.refs).toEqual(["interest:k1"]);
});

test("select usage is charged to its identified activity and survives restore", async () => {
	const f = fakeLlm();
	const rt = createAgencyRuntime({
		condition: "B2",
		systemContext: "experimental",
		llm: f,
		tools,
		budget: { ...defaultBudget, minIntervalMs: 0 },
		limits: { ...defaultLimits, outboundIntervalMs: 0 },
		activityLimits: { toolCalls: 3, tokens: 121, elapsedMs: 100000 },
	});
	rt.observe(obsInput("o1", "user.report", "user", 0, "比較"));
	f.push(
		"update",
		proposal([
			intentAddOp("g"),
			candidateAddOp("a", "g", {
				kind: "tool",
				toolName: "run_compare",
				toolInput: "A",
			}),
			candidateAddOp("b", "g", {
				kind: "tool",
				toolName: "run_compare",
				toolInput: "B",
			}),
		]),
	);
	await rt.runBackground(0, signal());
	f.push(
		"select",
		participation({
			action: "tool",
			candidateRef: { id: "c2", revision: 1 },
			evidenceRefs: ["o1"],
		}),
	);
	const first = await rt.decide(opportunity("p1", 1), signal());
	expect(first.decision.ticket).not.toBeNull();
	expect(rt.snapshot().continuity?.activities[0]?.[1].tokens).toBe(120);
	rt.recordResult({
		ticketId: first.decision.ticket!.id,
		at: 2,
		status: "succeeded",
		resultText: "ok",
	});
	f.push("update", proposal());
	f.push(
		"select",
		participation({
			action: "tool",
			candidateRef: { id: "c3", revision: 1 },
			evidenceRefs: ["o1"],
		}),
	);
	const second = await rt.decide(opportunity("p2", 3), signal());
	expect(second.decision.source).toBe("host_budget");
	expect(second.decision.ticket).toBeNull();
	expect(rt.snapshot().continuity?.activities[0]?.[1].tokens).toBe(240);
	const restored = createAgencyRuntime({
		condition: "B2",
		systemContext: "experimental",
		llm: fakeLlm(),
		tools,
		restore: rt.snapshot(),
	});
	expect(restored.snapshot().continuity?.activities[0]?.[1].tokens).toBe(240);
});
