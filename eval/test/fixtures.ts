/** Shared test helpers: an inline sample Case and a scripted stub AgencyRuntime. */
import type { Case } from "../contracts.ts";
import { caseSchema } from "../contracts.ts";
import {
	emptyState,
	type Observation,
	type ObservationInput,
} from "../../src/contracts/model.ts";
import type {
	ActionReceipt,
	AgencyRuntime,
	CallOutcome,
	Decision,
} from "../../src/contracts/runtime.ts";

export const sampleCase: Case = caseSchema.parse({
	id: "resume-01",
	group: "resume",
	split: "dev",
	title: "sample",
	description: "inline sample",
	labelStatus: "draft",
	tools: [
		{
			name: "search_notes",
			description: "search",
			results: [
				{ status: "succeeded", text: "found A" },
				{ status: "failed", text: "boom" },
			],
		},
	],
	steps: [
		{
			type: "observation",
			id: "s1",
			t: 0,
			kind: "user.report",
			actor: "user",
			text: "a",
		},
		{
			type: "observation",
			id: "s2",
			t: 0,
			kind: "user.report",
			actor: "user",
			text: "b",
		},
		{
			type: "observation",
			id: "s3",
			t: 5,
			kind: "exchange.adopted",
			actor: "agent",
			text: "c",
		},
		{
			type: "opportunity",
			id: "s4",
			t: 5,
			trigger: "turn_end",
			presence: "quiet",
			foregroundBusy: false,
			playerBusy: false,
			expect: {
				needed: true,
				accept: ["speak", "tool"],
				evidenceAny: ["s1"],
				failureIfOutward: "unnecessary",
				note: "n",
			},
		},
		{
			type: "opportunity",
			id: "s5",
			t: 10,
			trigger: "idle",
			presence: "quiet",
			foregroundBusy: false,
			playerBusy: false,
			expect: null,
		},
	],
});

export const outcome = (
	code: string,
	purpose: "update" | "select" = "update",
): CallOutcome => ({
	purpose,
	at: 0,
	code,
	model: "m",
	inputTokens: 10,
	outputTokens: 5,
	latencyMs: 100,
	rejectCodes: [],
});

export const decision = (
	over: Partial<Decision> & { opportunityId: string },
): Decision => ({
	action: "wait",
	source: "llm",
	candidateId: null,
	utterance: null,
	toolName: null,
	toolInput: null,
	evidenceRefs: [],
	reason: "r",
	ticket: null,
	rejectCodes: [],
	...over,
});

export const ticketFor = (
	opportunityId: string,
	action: "speak" | "tool",
	over: { utterance?: string | null; toolName?: string | null } = {},
) => ({
	id: `t-${opportunityId}`,
	opportunityId,
	action,
	candidateId: null,
	candidateRevision: null,
	stateRevision: 1,
	utterance: over.utterance ?? null,
	toolName: over.toolName ?? null,
	toolInput: null,
});

export interface StubScript {
	decisions: Record<string, Decision>;
	background?: CallOutcome[];
	throwOn?: "decide" | "observe" | "background";
}

export class StubRuntime implements AgencyRuntime {
	readonly condition = "B1" as const;
	readonly log: string[] = [];
	readonly receipts: ActionReceipt[] = [];
	readonly observations: Observation[] = [];
	constructor(private readonly script: StubScript) {}
	observe(input: ObservationInput): Observation {
		this.log.push(`observe:${input.id}`);
		if (this.script.throwOn === "observe") throw new Error("observe boom");
		const o = { ...input, seq: this.observations.length + 1 };
		this.observations.push(o);
		return o;
	}
	async runBackground(now: number): Promise<CallOutcome[]> {
		this.log.push(`background@${now}`);
		if (this.script.throwOn === "background") throw new Error("bg boom");
		return this.script.background ?? [];
	}
	async decide(op: { id: string; at: number }) {
		this.log.push(`decide:${op.id}@${op.at}`);
		if (this.script.throwOn === "decide") throw new Error("decide boom");
		const d =
			this.script.decisions[op.id] ?? decision({ opportunityId: op.id });
		return { decision: d, calls: [outcome("applied", "select")] };
	}
	recordResult(receipt: ActionReceipt): Observation {
		this.log.push(`receipt:${receipt.ticketId}`);
		this.receipts.push(receipt);
		const o: Observation = {
			id: `r-${receipt.ticketId}`,
			seq: this.observations.length + 1,
			kind: "action.observed",
			actor: "agent",
			occurredAt: receipt.at,
			text: receipt.resultText,
		};
		this.observations.push(o);
		return o;
	}
	invalidate(): void {}
	setEnabled(): void {}
	projection() {
		return { stateRevision: 0, items: [], hidden: 0 };
	}
	snapshot() {
		return {
			state: emptyState(),
			observations: this.observations,
			cursor: this.observations.length,
		};
	}
}
