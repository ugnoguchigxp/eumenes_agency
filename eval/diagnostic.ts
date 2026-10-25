/**
 * Condition D (P1-E §3, diagnostic): no stored state and no background update.
 * At each opportunity one select call sees the case's `present` steps plus the last
 * RECENT_OBSERVATION_WINDOW observations before it, the same window B1/B2 get, so D
 * differs from the ablation B1a only by `present` instead of stored notes (and by
 * having no update step). It reuses the B1 select instructions, prompt
 * builder and participation validation, and the same ticket/receipt path, so its
 * actions score exactly like the other conditions.
 *
 * Only the `present` ids cross into the runtime: `expect`, `stateExpect` and `judge`
 * never reach the model input.
 */
import type { Case } from "./contracts.ts";
import { createBudget } from "../src/application/budget.ts";
import {
	callModel,
	makeOutcome,
	skippedOutcome,
} from "../src/application/model-call.ts";
import { selectPrompt, systemPrompt } from "../src/application/prompts.ts";
import type {
	AgencyState,
	Observation,
	ToolCapability,
} from "../src/contracts/model.ts";
import { defaultLimits, emptyState } from "../src/contracts/model.ts";
import type { LlmPort } from "../src/contracts/ports.ts";
import { participationSchema } from "../src/contracts/proposals.ts";
import {
	RECENT_OBSERVATION_WINDOW,
	defaultBudget,
	type ActionTicket,
	type AgencyRuntime,
	type BudgetConfig,
	type CallOutcome,
	type Decision,
} from "../src/contracts/runtime.ts";
import {
	hostDecision,
	reserveOutward,
	validateParticipation,
} from "../src/domains/agency/participation.ts";
import { applyReceipt } from "../src/domains/agency/results.ts";
import { createLedger } from "../src/domains/experience/ledger.ts";

const DELIVERED_SHOWN = 5;

/** opportunity id -> observation steps to show directly (observation steps only). */
export function presentMap(c: Case): Map<string, string[]> {
	const observationIds = new Set<string>();
	const out = new Map<string, string[]>();
	for (const s of c.steps) {
		if (s.type === "observation") observationIds.add(s.id);
		else
			out.set(
				s.id,
				s.present.filter((id) => observationIds.has(id)),
			);
	}
	return out;
}

/** The `present` observations plus the last `recent` ones, deduplicated, chronological. */
export function selectDiagnosticObservations(
	all: readonly Observation[],
	presentIds: readonly string[],
	recent: number = RECENT_OBSERVATION_WINDOW,
): Observation[] {
	const wanted = new Set(presentIds);
	const picked = new Map<number, Observation>();
	for (const o of all) if (wanted.has(o.id)) picked.set(o.seq, o);
	for (const o of all.slice(Math.max(0, all.length - recent)))
		picked.set(o.seq, o);
	return [...picked.values()].sort((a, b) => a.seq - b.seq);
}

export interface DiagnosticDeps {
	readonly llm: LlmPort;
	readonly tools: readonly ToolCapability[];
	/** From presentMap(case). */
	readonly present: ReadonlyMap<string, readonly string[]>;
	readonly budget?: BudgetConfig;
}

/**
 * An AgencyRuntime for condition D. Its `condition` is "B1" because select runs
 * through the B1 instructions and validation; replay records it as "D".
 */
export function createDiagnosticRuntime(deps: DiagnosticDeps): AgencyRuntime {
	const { llm, tools } = deps;
	const limits = defaultLimits;
	const cfg = deps.budget ?? defaultBudget;
	const ledger = createLedger();
	const budget = createBudget(cfg);
	const issued = new Map<string, ActionTicket>();
	const receipts = new Map<string, Observation>();
	// Holds attempts and lastOutboundAt only; no notes, intents or candidates.
	const state: AgencyState = emptyState();
	let enabled = true;
	let epoch = 0;
	let tail: Promise<unknown> = Promise.resolve();
	const serial = <T>(fn: () => Promise<T>): Promise<T> => {
		const run = tail.then(() => fn());
		tail = run.catch(() => undefined);
		return run;
	};

	const delivered = () =>
		ledger
			.all()
			.filter((o) => o.kind === "delivery.observed" && o.actor === "agent")
			.slice(-DELIVERED_SHOWN)
			.map((o) => o.text);
	const minutesSinceUserInput = (now: number): number | null => {
		const last = ledger
			.all()
			.filter((o) => o.actor === "user")
			.reduce<number | null>(
				(m, o) => (m === null ? o.occurredAt : Math.max(m, o.occurredAt)),
				null,
			);
		return last === null
			? null
			: Math.max(0, Math.round((now - last) / 60_000));
	};

	const decideInner = async (
		opp: Parameters<AgencyRuntime["decide"]>[0],
		signal: AbortSignal,
	): Promise<{ decision: Decision; calls: CallOutcome[] }> => {
		const calls: CallOutcome[] = [];
		const done = (decision: Decision) => ({ decision, calls });
		if (!enabled)
			return done(hostDecision(opp.id, "host_disabled", "agency disabled"));
		if (opp.presence !== "quiet" || opp.foregroundBusy || opp.playerBusy)
			return done(hostDecision(opp.id, "host_blocked", "not a quiet moment"));
		if (budget.check(opp.at, false) !== "ok") {
			calls.push(skippedOutcome("select", opp.at, "skipped:budget"));
			return done(hostDecision(opp.id, "host_budget", "no budget for select"));
		}
		const startEpoch = epoch;
		const presented = selectDiagnosticObservations(
			ledger.all(),
			deps.present.get(opp.id) ?? [],
		);
		const r = await callModel(
			llm,
			budget,
			{
				purpose: "select",
				at: opp.at,
				system: systemPrompt("select", "B1"),
				prompt: selectPrompt({
					condition: "B1",
					now: opp.at,
					opportunity: opp,
					observations: presented,
					freshIds: new Set(),
					state,
					candidates: [],
					delivered: delivered(),
					tools,
					limits,
					minutesSinceUserInput: minutesSinceUserInput(opp.at),
				}),
				schema: participationSchema,
				maxOutputTokens: cfg.selectMaxOutputTokens,
			},
			signal,
		);
		calls.push(...r.prior);
		if (!r.ok) {
			calls.push(r.outcome);
			return done(
				hostDecision(opp.id, "error", `select_failed:${r.outcome.code}`),
			);
		}
		const p = r.value;
		if (epoch !== startEpoch) {
			calls.push(
				makeOutcome("select", opp.at, "rejected:stale_epoch", r.usage, [
					"stale_epoch",
				]),
			);
			return done(hostDecision(opp.id, "rejected", p.reason, ["stale_epoch"]));
		}
		const verdict = validateParticipation({
			condition: "B1",
			state,
			proposal: p,
			presentedObservations: new Set(presented.map((o) => o.id)),
			presentedCandidates: new Map(),
			tools,
			limits,
			at: opp.at,
		});
		if (!verdict.ok) {
			calls.push(
				makeOutcome(
					"select",
					opp.at,
					`rejected:${verdict.codes[0] ?? "unknown"}`,
					r.usage,
					verdict.codes,
				),
			);
			return done(hostDecision(opp.id, "rejected", p.reason, verdict.codes));
		}
		calls.push(makeOutcome("select", opp.at, "applied", r.usage));
		let ticket: ActionTicket | null = null;
		if (p.action === "speak" || p.action === "tool") {
			ticket = reserveOutward(state, opp.id, p.action, verdict, opp.at);
			issued.set(ticket.id, ticket);
		}
		return done({
			opportunityId: opp.id,
			action: p.action,
			source: "llm",
			candidateId: null,
			utterance: verdict.utterance,
			toolName: verdict.toolName,
			toolInput: verdict.toolInput,
			evidenceRefs: p.evidenceRefs,
			reason: p.reason,
			ticket,
			rejectCodes: [],
		});
	};

	return {
		condition: "B1",
		observe: (input) => ledger.record(input),
		// D has no background update: nothing to process between opportunities.
		runBackground: async () => [],
		decide: (opportunity, signal) =>
			serial(() => decideInner(opportunity, signal)),
		takeReportedTodos: () => [],
		recordResult(receipt) {
			const key = `${receipt.ticketId}:${receipt.status}`;
			const known = receipts.get(key);
			if (known) return known;
			const { observation } = applyReceipt(
				state,
				receipt,
				issued.get(receipt.ticketId),
			);
			const obs = ledger.record(observation);
			receipts.set(key, obs);
			if (receipt.status !== "outcome_unknown") issued.delete(receipt.ticketId);
			return obs;
		},
		invalidate() {
			epoch += 1;
			issued.clear();
		},
		setEnabled(value) {
			enabled = value;
		},
		projection: () => ({ stateRevision: state.revision, items: [], hidden: 0 }),
		snapshot: () => ({
			state: structuredClone(state),
			observations: ledger.all(),
			cursor: ledger.cursor(),
		}),
	};
}
