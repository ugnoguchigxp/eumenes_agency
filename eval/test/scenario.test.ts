/** H6: scripted multi-day replay over the wired wake path (no real LLM). */
import { expect, test } from "bun:test";
import { createAgencyRuntime } from "../../src/application/runtime.ts";
import { defaultBudget } from "../../src/contracts/runtime.ts";
import {
	HOUR,
	candidateAddOp,
	defaultLimits,
	fakeLlm,
	intentAddOp,
	participation,
	proposal,
	tools,
} from "../../test/core/helpers.ts";
import { replayScript, scenarioChecks, type ScriptEvent } from "../scenario.ts";

const DAY = 24 * HOUR;

test("3-day script: bounded calls, no select after returns, quiet gates, tts:false", async () => {
	const llm = fakeLlm();
	const rt = createAgencyRuntime({
		systemContext: "experimental",
		condition: "B2",
		llm,
		tools,
		budget: { ...defaultBudget, minIntervalMs: 0 },
		limits: { ...defaultLimits, outboundIntervalMs: 0 },
	});
	llm.push("update", proposal([intentAddOp("g"), candidateAddOp("k", "g")]));
	for (let k = 0; k < 20; k++) llm.push("update", proposal());
	llm.push(
		"select",
		participation({
			action: "speak",
			candidateRef: { id: "c2", revision: 1 },
			evidenceRefs: ["o1"],
		}),
	);
	for (let k = 0; k < 20; k++) llm.push("select", participation());
	const script: ScriptEvent[] = [
		{ at: 0, kind: "user", id: "o1", text: "比較が未解決のまま" },
		{ at: 3 * HOUR, kind: "tick" },
		{ at: 4 * HOUR, kind: "returned", id: "w1", text: "比較結果が返った" },
		{ at: 5 * HOUR, kind: "presence", host: { presence: "speaking" } },
		{ at: 5 * HOUR + 1, kind: "external", id: "x1", text: "関連ニュース" },
		{ at: 6 * HOUR, kind: "presence", host: { presence: "quiet" } },
		{ at: DAY, kind: "fault", id: "f1", text: "E1", code: "E1" },
		{ at: DAY + HOUR, kind: "fault", id: "f2", text: "E1", code: "E1" },
		{ at: DAY + 2 * HOUR, kind: "external", id: "x2", text: "別のニュース" },
		{ at: 2 * DAY, kind: "returned", id: "w2", text: "二つ目の結果" },
		{ at: 2 * DAY + HOUR, kind: "tick", idleDue: true },
		{ at: 3 * DAY, kind: "tick" },
	];
	const rows = await replayScript(rt, script);
	const c = scenarioChecks(rows);
	expect(c.maxCallsPerWake).toBeLessThanOrEqual(2);
	expect(c.selectsAfterReturn).toBe(0);
	expect(c.ticketsWithoutOrigin).toBe(0);
	expect(c.autonomousTts).toBe(0);
	const spoke = rows.filter((r) => r.action === "speak");
	expect(spoke.length).toBe(1);
	expect(spoke[0]).toMatchObject({ origin: "autonomous", tts: false });
	// speaking: the external event wakes nothing
	expect(rows.find((r) => r.event === "external:x1")?.reasons).toEqual([]);
	// the same fault code within the quiet window wakes once
	expect(rows.find((r) => r.event === "fault:f2")?.reasons).toEqual([]);
	expect(rows.find((r) => r.event === "fault:f1")?.reasons).toContain("fault");
	// x1 (blocked while speaking) is not lost: it wakes at the next quiet check
	expect(rows.find((r) => r.event === "fault:f1")?.reasons).toContain(
		"external_event",
	);
	expect(rows.find((r) => r.event === "external:x2")?.reasons).toEqual([
		"external_event",
	]);
});
