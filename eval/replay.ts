/** Fake host: replays one Case through an AgencyRuntime and records a RunRecord. */
import type { Case, OpportunityRecord, RunRecord } from "./contracts.ts";
import type { Condition, ToolCapability } from "../src/contracts/model.ts";
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
}

const isCallFailure = (code: string): boolean =>
	code.startsWith("llm_call:") ||
	code.startsWith("error:") ||
	code.startsWith("llm:");

export const isSpendLimit = (text: string): boolean =>
	text.toLowerCase().includes("spend_limit");

/**
 * A run is incomplete when an exception stopped it, the spend limit was hit,
 * or every model call of a non-B0 run failed.
 */
export function computeIncomplete(
	condition: Condition,
	calls: readonly { readonly code: string }[],
	error: string | null,
): boolean {
	if (error !== null) return true;
	if (calls.some((c) => isSpendLimit(c.code))) return true;
	return (
		condition !== "B0" &&
		calls.length > 0 &&
		calls.every((c) => isCallFailure(c.code))
	);
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

export async function replayCase(
	c: Case,
	condition: Condition,
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

	try {
		runtime = makeRuntime(
			c.tools.map((t) => ({
				name: t.name,
				description: t.description,
				requiresApproval: t.requiresApproval,
			})),
		);
		const rt = runtime;
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
					calls.push(
						...(await rt.runBackground(now, signal())).map(callRecord),
					);
				}
				continue;
			}
			const { decision, calls: decideCalls } = await rt.decide(
				{
					id: step.id,
					at: now,
					trigger: step.trigger,
					presence: step.presence,
					foregroundBusy: step.foregroundBusy,
					playerBusy: step.playerBusy,
				},
				signal(),
			);
			pending = 0;
			calls.push(...decideCalls.map(callRecord));
			const agentIds = new Set(
				rt
					.snapshot()
					.observations.filter((o) => o.actor === "agent")
					.map((o) => o.id),
			);
			opportunities.push({
				opportunityId: step.id,
				expect: step.expect,
				action: decision.action,
				source: decision.source,
				utterance: decision.utterance,
				toolName: decision.toolName,
				evidenceRefs: [...decision.evidenceRefs],
				reason: decision.reason,
				// "call:<code>" marks infra failures of this opportunity's own model calls.
				rejectCodes: [
					...decision.rejectCodes,
					...decideCalls
						.filter(
							(x) =>
								x.code.startsWith("llm_call:") || x.code.startsWith("error:"),
						)
						.map((x) => `call:${x.code}`),
				],
				agentAuthoredRefs: decision.evidenceRefs.filter((r) => agentIds.has(r)),
			});
			const ticket = decision.ticket;
			if (!ticket) continue;
			const blocked =
				step.presence !== "quiet" || step.foregroundBusy || step.playerBusy;
			if (blocked) safety.push(`blocked_ticket:${step.id}`);
			let receipt: ActionReceipt;
			if (blocked) {
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
		} catch (e) {
			error ??= errorMessage(e);
		}
	}

	return {
		runName: opts.runName,
		caseId: c.id,
		group: c.group,
		condition,
		rep,
		labelStatus: c.labelStatus,
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
