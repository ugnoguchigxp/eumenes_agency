/** Virtual Eumenes: one writer, mock delivery, no real tool execution or Eumenes DB access. */
import {
	createAgencyRuntime,
	delegationRequest,
	type ActionReceipt,
	type AgencyRuntime,
	type InputContext,
	type LlmPort,
	type ObservationInput,
	type Opportunity,
	type RuntimeDeps,
} from "../../src/index.ts";
import { MemoryBridge } from "./memory-bridge.ts";

export type VirtualHostOptions = Pick<
	RuntimeDeps,
	"condition" | "budget" | "tools"
> &
	Partial<
		Pick<
			RuntimeDeps,
			| "systemContext"
			| "limits"
			| "planOnOpportunity"
			| "conversationParticipation"
			| "repairUpdates"
			| "constrainToolNames"
			| "findings"
			| "interestFormation"
			| "hostTopics"
			| "hostTodos"
			| "topics"
			| "todos"
			| "standingInterests"
		>
	> & {
		archive?: boolean;
		/** Example-owned workers must fence and discard affected payloads before Memory acknowledges forgetting. */
		beforeForget?: (refs: readonly string[]) => void;
	};

export class VirtualEumenes {
	readonly memory: MemoryBridge;
	private runtime: AgencyRuntime;
	private running = false;
	private controller: AbortController | undefined;
	private stopped = false;
	constructor(
		directory: string,
		private readonly llm: LlmPort,
		private readonly options: VirtualHostOptions = {
			condition: "B1",
			tools: [],
		},
	) {
		this.memory = new MemoryBridge(directory);
		try {
			this.runtime = this.restore();
		} catch (error) {
			this.memory.close();
			throw error;
		}
	}
	private restore() {
		const saved = this.memory.load();
		const {
			archive: _archive,
			beforeForget: _beforeForget,
			...settings
		} = this.options;
		return createAgencyRuntime({
			systemContext: this.options.systemContext ?? "experimental",
			...settings,
			llm: this.llm,
			...(saved ? { restore: saved } : {}),
			...(this.options.archive !== false ? { archive: this.memory } : {}),
			forgottenRefs: saved?.forgottenRefs ?? [],
		});
	}
	private check() {
		if (this.stopped) throw new Error("virtual host stopped");
	}
	private idle() {
		this.check();
		if (this.running) throw new Error("virtual host writer busy");
	}
	private commit() {
		try {
			this.memory.save(this.runtime.snapshot());
		} catch (error) {
			this.runtime.invalidate("persistence failure", 0);
			this.stopped = true;
			throw error;
		}
	}
	observe(input: ObservationInput, context?: InputContext) {
		this.idle();
		// The example receives direct host records, or an explicit full input manifest for derived records.
		if (input.actor !== "user" && !context)
			throw new Error("non-user input requires its full provenance");
		const observation = this.runtime.observe(input, context);
		this.commit();
		return observation;
	}
	private async infer<T>(
		operation: (runtime: AgencyRuntime, signal: AbortSignal) => Promise<T>,
	): Promise<T> {
		this.idle();
		this.running = true;
		const controller = new AbortController();
		this.controller = controller;
		const current = this.runtime;
		try {
			const result = await operation(current, controller.signal);
			if (current !== this.runtime || this.stopped)
				throw new Error("inference invalidated by host lifecycle change");
			this.commit(); // No ticket or output is published before its checkpoint commits.
			return result;
		} finally {
			this.running = false;
			if (this.controller === controller) this.controller = undefined;
		}
	}
	update(now: number) {
		return this.infer((runtime, signal) => runtime.runBackground(now, signal));
	}
	decide(opportunity: Opportunity) {
		return this.infer((runtime, signal) => runtime.decide(opportunity, signal));
	}
	/** Only a mock receipt; this example never sends speech or executes an external tool. */
	recordResult(
		receipt: ActionReceipt,
		context: InputContext = { sources: [], complete: true },
	) {
		this.idle();
		const result = this.runtime.recordResult(receipt, context);
		this.commit();
		return result;
	}
	compact(keepRecent = 30) {
		this.idle();
		const count = this.memory.compact(keepRecent);
		this.runtime.invalidate("compacted", 0);
		this.runtime = this.restore();
		return count;
	}
	forget(id: string) {
		this.check();
		this.controller?.abort();
		this.runtime.invalidate("Memory forgetting", 0);
		try {
			this.options.beforeForget?.([id]);
			const receipt = this.memory.forget(id);
			this.runtime = this.restore();
			return receipt;
		} catch (error) {
			this.stopped = true;
			throw error;
		}
	}
	snapshot() {
		this.check();
		return this.runtime.snapshot();
	}
	/** Reuse the core's request contract; the host chooses the executor and validates its catalog. */
	delegation(ticket: import("../../src/index.ts").ActionTicket, at: number) {
		this.idle();
		const saved = this.runtime.snapshot();
		const current = saved.continuity?.issued.find((t) => t.id === ticket.id);
		if (!current) throw new Error("ticket is not current");
		const request = delegationRequest(current, saved.state, at);
		const input = new Map(saved.provenance?.entries).get(
			`attempt:${ticket.id}`,
		);
		if (!request || !input?.complete)
			throw new Error("delegation inputs incomplete");
		if (input.sources.some((id) => !this.memory.get(id)))
			throw new Error("delegation source unavailable");
		return { request, input: structuredClone(input) };
	}
	close() {
		this.controller?.abort();
		this.runtime.invalidate("host closed", 0);
		this.stopped = true;
		this.memory.close();
	}
}
