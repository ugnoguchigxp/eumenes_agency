/** Fake host: replays one Case through an AgencyRuntime and records a RunRecord. */
import { caseHash } from "./cases.ts";
import {
	runtimeConditionOf,
	type Case,
	type CaseTodo,
	type EvalCondition,
	type OpportunityRecord,
	type RunRecord,
} from "./contracts.ts";
import {
	computeStateCheck,
	openItems,
	type SelectProbe,
} from "./state-check.ts";
import type {
	AgencyState,
	HostTodo,
	ToolCapability,
} from "../src/contracts/model.ts";
import { isOpenCandidate, isOpenIntent } from "../src/contracts/model.ts";
import type {
	ActionReceipt,
	AgencyRuntime,
	CallOutcome,
} from "../src/contracts/runtime.ts";

export const MS_PER_MINUTE = 60_000;

export interface ReplayOptions {
	readonly runName: string;
	readonly settingsDigest: string;
	readonly instructionVersion: string;
	/** Cumulative USD spent so far (usd per run is the delta). */
	readonly spent: () => number;
	/** Per-call abort timeout. Default 10 minutes. */
	readonly timeoutMs?: number;
	/** Pending observations that trigger a background run (budget.batchSize). Default 4. */
	readonly batchSize?: number;
	/** Called once with the runtime's final state (for trace recording). */
	readonly onFinal?: (state: AgencyState) => void;
	/**
	 * Captures the state at select time for the P1-E state check. Without it (or when no
	 * select call is made) the state after decide() is used, which only differs when
	 * the decision itself reserves, defers or dismisses an item.
	 */
	readonly probe?: SelectProbe;
}

/** Infra failure of a model call (API/connection/abort): not a judgment of the agent. */
export const isInfraCallCode = (code: string): boolean =>
	code.startsWith("llm_call:") ||
	code.startsWith("error:") ||
	code === "aborted";

export const isSpendLimit = (text: string): boolean =>
	text.toLowerCase().includes("spend_limit");

/**
 * A run is incomplete when an exception stopped it, the spend limit was hit,
 * or every model call of a non-B0 run failed for infra reasons (`llm_call:*`,
 * `error:*`, aborted). Agent output failures (`llm:*` schema/parse/refusal/max_tokens,
 * `rejected:*`) never make a run incomplete: they are the agent's own failures and stay
 * in the counts (also the consecutive-incomplete halt in `run` therefore only fires on
 * consecutive infra failures).
 */
export function computeIncomplete(
	condition: EvalCondition,
	calls: readonly { readonly code: string }[],
	error: string | null,
): boolean {
	if (error !== null) return true;
	if (calls.some((c) => isSpendLimit(c.code))) return true;
	return (
		condition !== "B0" &&
		calls.length > 0 &&
		calls.every((c) => isInfraCallCode(c.code))
	);
}

/**
 * Tracks whether the background update path hit an infra failure in a run
 * (`llm_call:*`, `error:*`, aborted). State checks after that point measure the
 * outage, not the agent, so the rest of the run is excluded from state scoring.
 *
 * Agent output failures (`llm:*` schema/parse/refusal/max_tokens and `rejected:*`,
 * also when they repeat and the runtime quarantines updates) do NOT taint the run:
 * they are the agent's own failures and stay in the denominators (a quarantined
 * runtime waits as host_stale, which scores like any other wait).
 */
export function createUpdateWatch() {
	let tainted = false;
	return {
		note(calls: readonly { purpose: string; code: string }[]): void {
			for (const c of calls) {
				if (c.purpose === "update" && isInfraCallCode(c.code)) tainted = true;
			}
		},
		get tainted(): boolean {
			return tainted;
		},
	};
}

export type MakeRuntime = (tools: readonly ToolCapability[]) => AgencyRuntime;

const callRecord = (c: CallOutcome): RunRecord["calls"][number] => ({
	purpose: c.purpose,
	at: c.at,
	code: c.code,
	model: c.model,
	inputTokens: c.inputTokens,
	outputTokens: c.outputTokens,
	latencyMs: c.latencyMs,
	rejectCodes: [...c.rejectCodes],
});

const errorMessage = (error: unknown): string =>
	error instanceof Error ? `${error.name}: ${error.message}` : String(error);

/** A case's work item as the host would pass it (minutes from case start → ms). */
const hostTodoOf = (x: CaseTodo): HostTodo => ({
	id: x.id,
	title: x.title,
	status: x.status,
	requestedAt: x.requestedAt * MS_PER_MINUTE,
	...(x.outcome === undefined ? {} : { outcome: x.outcome }),
	...(x.result === undefined ? {} : { result: x.result }),
	...(x.nextActions === undefined ? {} : { nextActions: x.nextActions }),
	...(x.doneAt === undefined ? {} : { doneAt: x.doneAt * MS_PER_MINUTE }),
	...(x.kind === undefined ? {} : { kind: x.kind }),
	...(x.origin === undefined ? {} : { origin: x.origin }),
	...(x.dueAt === undefined ? {} : { dueAt: x.dueAt * MS_PER_MINUTE }),
	...(x.dueLabel === undefined ? {} : { dueLabel: x.dueLabel }),
	...(x.remindFrom === undefined
		? {}
		: { remindFrom: x.remindFrom * MS_PER_MINUTE }),
});

export async function replayCase(
	c: Case,
	condition: EvalCondition,
	rep: number,
	makeRuntime: MakeRuntime,
	opts: ReplayOptions,
): Promise<RunRecord> {
	const opportunities: OpportunityRecord[] = [];
	const calls: RunRecord["calls"] = [];
	const safety: string[] = [];
	let error: string | null = null;
	let finalState: RunRecord["finalState"] = {
		openIntents: 0,
		openCandidates: 0,
		notes: 0,
		beliefs: 0,
		desires: 0,
	};
	const before = opts.spent();
	const signal = () => AbortSignal.timeout(opts.timeoutMs ?? 600_000);
	const scriptIndex = new Map<string, number>();
	const batchSize = opts.batchSize ?? 4;
	let pending = 0;
	let runtime: AgencyRuntime | null = null;
	const watch = createUpdateWatch();

	try {
		runtime = makeRuntime(
			c.tools.map((t) => ({
				name: t.name,
				description: t.description,
				requiresApproval: t.requiresApproval,
			})),
		);
		const rt = runtime;
		opts.probe?.attach(rt);
		for (let i = 0; i < c.steps.length; i++) {
			const step = c.steps[i];
			if (!step) continue;
			const now = step.t * MS_PER_MINUTE;
			if (step.type === "observation") {
				rt.observe({
					id: step.id,
					kind: step.kind,
					actor: step.actor,
					occurredAt: now,
					text: step.text,
				});
				pending++;
				const endOfTurn =
					step.actor === "agent" && step.kind === "exchange.adopted";
				if (endOfTurn || pending >= batchSize) {
					pending = 0;
					const made = (await rt.runBackground(now, signal())).map(callRecord);
					watch.note(made);
					calls.push(...made);
				}
				continue;
			}
			opts.probe?.reset();
			const { decision, calls: decideCalls } = await rt.decide(
				{
					id: step.id,
					at: now,
					trigger: step.trigger,
					presence: step.presence,
					foregroundBusy: step.foregroundBusy,
					playerBusy: step.playerBusy,
					// Social cases: host-memory topics (used by B1h only; ignored otherwise).
					...(step.topics ? { topics: step.topics } : {}),
					...(step.ambient ? { ambient: step.ambient } : {}),
					// Social cases: host work items (used by B1h only; ignored otherwise).
					...(step.todos
						? {
								todos: step.todos.map(hostTodoOf),
							}
						: {}),
				},
				signal(),
			);
			pending = 0;
			calls.push(...decideCalls.map(callRecord));
			watch.note(decideCalls);
			const after = rt.snapshot();
			const agentIds = new Set(
				after.observations.filter((o) => o.actor === "agent").map((o) => o.id),
			);
			// Condition D and B0 keep no state: nothing to check.
			const stateCondition = runtimeConditionOf(condition);
			const keepsState = stateCondition !== null && stateCondition !== "B0";
			const want = step.stateExpect;
			const blocked =
				step.presence !== "quiet" ||
				step.foregroundBusy ||
				step.playerBusy ||
				decision.source === "host_blocked";
			const stateExcluded: OpportunityRecord["stateExcluded"] =
				!keepsState || want === null
					? null
					: blocked
						? "blocked"
						: want.mustHold.length === 0 && want.mustNotHold.length === 0
							? "empty"
							: watch.tainted
								? "infra"
								: null;
			const checked =
				keepsState && want !== null && stateExcluded === null
					? (opts.probe?.captured() ?? after.state)
					: null;
			const stateCheck =
				checked && stateCondition !== null && keepsState
					? computeStateCheck(stateCondition, checked, want)
					: null;
			const stateItems =
				checked &&
				stateCondition !== null &&
				keepsState &&
				want &&
				want.mustNotHold.length > 0
					? openItems(stateCondition, checked)
					: null;
			opportunities.push({
				opportunityId: step.id,
				expect: step.expect,
				action: decision.action,
				source: decision.source,
				utterance: decision.utterance,
				toolName: decision.toolName,
				toolInput: decision.toolInput,
				evidenceRefs: [...decision.evidenceRefs],
				reason: decision.reason,
				...(decision.emotion ? { emotion: decision.emotion } : {}),
				...(step.feelOk ? { feelOk: step.feelOk } : {}),
				// "call:<code>" marks infra failures of this opportunity's own model calls.
				rejectCodes: [
					...decision.rejectCodes,
					...decideCalls
						.filter((x) => isInfraCallCode(x.code))
						.map((x) => `call:${x.code}`),
				],
				agentAuthoredRefs: decision.evidenceRefs.filter((r) => agentIds.has(r)),
				stateCheck,
				stateItems,
				stateExcluded,
			});
			const ticket = decision.ticket;
			if (!ticket) continue;
			const hostBlocked =
				step.presence !== "quiet" || step.foregroundBusy || step.playerBusy;
			if (hostBlocked) safety.push(`blocked_ticket:${step.id}`);
			let receipt: ActionReceipt;
			if (hostBlocked) {
				receipt = {
					ticketId: ticket.id,
					status: "failed",
					at: now,
					resultText: "blocked by host",
				};
			} else if (ticket.action === "speak") {
				receipt = {
					ticketId: ticket.id,
					status: "succeeded",
					at: now,
					resultText: ticket.utterance ?? "",
				};
			} else {
				const name = ticket.toolName ?? "(none)";
				const tool = c.tools.find((t) => t.name === name);
				if (tool?.requiresApproval) {
					// The core must refuse approval tools; a ticket here is a core bug.
					safety.push(`unauthorized_tool:${name}`);
					receipt = {
						ticketId: ticket.id,
						status: "failed",
						at: now,
						resultText: `tool requires approval: ${name}`,
					};
				} else if (!tool) {
					safety.push(`unauthorized_tool:${name}`);
					receipt = {
						ticketId: ticket.id,
						status: "failed",
						at: now,
						resultText: `tool not available: ${name}`,
					};
				} else {
					const idx = scriptIndex.get(name) ?? 0;
					scriptIndex.set(name, idx + 1);
					const scripted = tool.results[idx];
					receipt = scripted
						? {
								ticketId: ticket.id,
								status: scripted.status,
								at: now,
								resultText: scripted.text,
							}
						: {
								ticketId: ticket.id,
								status: "failed",
								at: now,
								resultText: `tool script exhausted: ${name}`,
							};
				}
			}
			rt.recordResult(receipt);
		}
	} catch (e) {
		error = errorMessage(e);
	}

	if (runtime) {
		try {
			const { state } = runtime.snapshot();
			finalState = {
				openIntents: state.intents.filter(isOpenIntent).length,
				openCandidates: state.candidates.filter(isOpenCandidate).length,
				notes: state.notes.length,
				beliefs: state.beliefs.length,
				desires: state.desires.length,
			};
			opts.onFinal?.(state);
		} catch (e) {
			error ??= errorMessage(e);
		}
	}

	return {
		runName: opts.runName,
		caseId: c.id,
		suite: c.suite,
		group: c.group,
		condition,
		rep,
		labelStatus: c.labelStatus,
		caseHash: caseHash(c),
		settingsDigest: opts.settingsDigest,
		instructionVersion: opts.instructionVersion,
		opportunities,
		calls,
		usd: opts.spent() - before,
		finalState,
		safety,
		incomplete: computeIncomplete(condition, calls, error),
		error,
	};
}
