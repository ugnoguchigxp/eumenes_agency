/** Mock execution belongs to the example host. No real agent, tool, service or API is started. */
import { z } from "zod";
import type {
	ActionTicket,
	InputContext,
	ToolCapability,
} from "../../src/index.ts";
import { dependsOn } from "../../src/application/memory.ts";
import { VirtualEumenes } from "./adapter.ts";

const argumentsSchema = z.strictObject({
	revisionId: z.string().min(1),
	question: z.string().trim().min(1).max(2000),
});
export interface MockSubagent {
	run(input: {
		question: string;
		acceptance: string;
	}): Promise<{ summary: string; status: "succeeded" | "failed" | "question" }>;
}
export interface MockBundle {
	revisionId: string;
	title: string;
	description: string;
	requiresApproval: boolean;
	subagent: MockSubagent;
}
interface Job {
	ticket: ActionTicket;
	question: string;
	acceptance: string;
	bundle: MockBundle;
	input: InputContext;
	status: "accepted" | "running" | "returned" | "cancelled";
	deadline: number;
	returnedAt?: number;
	result?: { summary: string; status: "succeeded" | "failed" | "question" };
}
export interface MockEvent {
	stage: string;
	workRef: string;
	revisionId: string;
}

export class MockToolchain {
	private readonly jobs = new Map<string, Job>();
	private readonly disabled = new Set<string>();
	private readonly history: MockEvent[] = [];
	constructor(private readonly bundles: readonly MockBundle[]) {
		if (new Set(bundles.map((b) => b.revisionId)).size !== bundles.length)
			throw new Error("duplicate bundle revision");
	}
	get events(): readonly MockEvent[] {
		return structuredClone(this.history);
	}
	catalog() {
		return this.bundles
			.filter((b) => !b.requiresApproval && !this.disabled.has(b.revisionId))
			.map(({ revisionId, title, description }) => ({
				revisionId,
				title,
				description,
			}));
	}
	capability(): ToolCapability {
		return {
			name: "delegate",
			requiresApproval: false,
			input: { sources: [], complete: true },
			description: JSON.stringify({
				purpose: "読み取り調査をホストへ依頼する。実行先はmockのみ。",
				toolInput: {
					encoding: "JSON string",
					schema: z.toJSONSchema(argumentsSchema),
				},
				revisionSelection:
					"availableCapabilitiesのrevisionId文字列をそのまま指定する。candidateRef.revisionの数値とは別の識別子である。",
				availableCapabilities: this.catalog(),
			}),
		};
	}
	disable(revisionId: string) {
		this.disabled.add(revisionId);
	}
	handoff(host: VirtualEumenes, ticket: ActionTicket, at: number) {
		try {
			return { accepted: true as const, ...this.start(host, ticket, at) };
		} catch {
			host.recordResult({
				ticketId: ticket.id,
				status: "failed",
				at,
				resultText: "mock_delegation_refused",
			});
			return { accepted: false as const, reason: "mock_delegation_refused" };
		}
	}
	private event(stage: string, id: string, job: Job) {
		this.history.push({
			stage,
			workRef: id,
			revisionId: job.bundle.revisionId,
		});
	}
	start(host: VirtualEumenes, ticket: ActionTicket, at: number) {
		const { request, input } = host.delegation(ticket, at);
		const args = argumentsSchema.parse(JSON.parse(request.question));
		const bundle = this.bundles.find((b) => b.revisionId === args.revisionId);
		if (
			!bundle ||
			bundle.requiresApproval ||
			this.disabled.has(bundle.revisionId)
		)
			throw new Error("mock capability unavailable");
		const known = this.jobs.get(request.workRef);
		if (known) {
			if (known.status === "cancelled")
				throw new Error("mock request cancelled");
			return { workRef: request.workRef, started: false };
		}
		const job: Job = {
			ticket: structuredClone(ticket),
			question: args.question,
			acceptance: request.acceptance,
			bundle,
			input,
			status: "accepted",
			deadline: at + 30 * 60000,
		};
		this.jobs.set(request.workRef, job);
		this.event("toolchain.accepted", request.workRef, job);
		return { workRef: request.workRef, started: true };
	}
	/** Called before Memory deletion acknowledgement; remove affected mock payloads and fence late returns. */
	forget(refs: readonly string[]) {
		const forgotten = new Set(refs);
		for (const [id, job] of this.jobs)
			if (job.status !== "cancelled" && dependsOn(job.input, forgotten)) {
				job.status = "cancelled";
				job.question = "";
				job.acceptance = "";
				delete job.result;
				job.ticket = { ...job.ticket, toolInput: null, utterance: null };
				this.event("work.cancelled", id, job);
			}
	}
	async finish(host: VirtualEumenes, id: string, at: number) {
		const job = this.jobs.get(id);
		if (!job) throw new Error("unknown mock work");
		if (job.status === "cancelled")
			return { accepted: false as const, reason: "cancelled" };
		if (job.status === "returned")
			return {
				accepted: true as const,
				observationId: `mock-return:${id}`,
				duplicate: true,
			};
		if (job.status === "running") throw new Error("mock work already running");
		try {
			host.delegation(job.ticket, at);
			if (this.disabled.has(job.bundle.revisionId) || at >= job.deadline)
				throw new Error("mock work no longer valid");
			job.status = "running";
			if (!job.result) {
				this.event("bundle.started", id, job);
				this.event("subagent.started", id, job);
				job.result = await job.bundle.subagent.run({
					question: job.question,
					acceptance: job.acceptance,
				});
			}
			if (this.jobs.get(id)?.status === "cancelled") {
				delete job.result;
				return { accepted: false as const, reason: "cancelled" };
			}
			host.delegation(job.ticket, at);
			if (this.disabled.has(job.bundle.revisionId))
				throw new Error("mock capability unavailable");
			this.event("subagent.returned", id, job);
			job.returnedAt ??= at;
			const observationId = `mock-return:${id}`;
			const existing = host.memory.get(observationId);
			if (!existing)
				host.observe(
					{
						id: observationId,
						kind: "work.returned",
						actor: "tool",
						occurredAt: job.returnedAt,
						workRef: id,
						workStatus: job.result.status,
						text: job.result.summary,
					},
					job.input,
				);
			host.recordResult(
				{
					ticketId: id,
					status: job.result.status === "failed" ? "failed" : "succeeded",
					at: job.returnedAt,
					resultText: job.result.summary,
				},
				{ sources: [observationId], complete: true },
			);
			job.status = "returned";
			this.event("result.accepted", id, job);
			return { accepted: true as const, observationId, duplicate: false };
		} catch (error) {
			if (this.jobs.get(id)?.status !== "cancelled") job.status = "accepted";
			throw error;
		}
	}
}
