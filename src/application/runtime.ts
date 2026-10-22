import type {
	AgencyState,
	Candidate,
	Observation,
} from "../contracts/model.ts";
import { defaultLimits, emptyState } from "../contracts/model.ts";
import {
	fromWire,
	participationSchema,
	wireUpdateSchema,
} from "../contracts/proposals.ts";
import {
	defaultBudget,
	RECENT_OBSERVATION_WINDOW,
	type ActionTicket,
	type AgencyRuntime,
	type CallOutcome,
	type Decision,
	type RuntimeDeps,
} from "../contracts/runtime.ts";
import {
	createDueFlags,
	findDue,
	isDue,
	issuedKeys,
	markIssued,
	type Due,
} from "../domains/agency/due.ts";
import {
	blockPending,
	interruptLive,
	presentableCandidates,
	refreshCandidates,
} from "../domains/agency/lifecycle.ts";
import {
	deferCandidate,
	dismissCandidate,
	hostDecision,
	reserveOutward,
	validateParticipation,
} from "../domains/agency/participation.ts";
import { applyReceipt } from "../domains/agency/results.ts";
import { settleUpdate } from "../domains/agency/settle.ts";
import { createLedger } from "../domains/experience/ledger.ts";
import { createBudget } from "./budget.ts";
import {
	callModel,
	isApplied,
	makeOutcome,
	skippedOutcome,
} from "./model-call.ts";
import { buildProjection } from "./projection.ts";
import {
	selectEvidenceIds,
	selectPrompt,
	systemPrompt,
	updatePrompt,
} from "./prompts.ts";

/** The cap on extra pending observations shown on top of the recent window. */
const PENDING_CAP = 16;
const DELIVERED_SHOWN = 5;
const NO_DUE: Due = { reviewIntentIds: [], pressure: [] };

export const createAgencyRuntime = (deps: RuntimeDeps): AgencyRuntime => {
	const { condition, llm, tools } = deps;
	const wireSchema = wireUpdateSchema(condition === "B0" ? "B2" : condition);
	const limits = deps.limits ?? defaultLimits;
	const cfg = deps.budget ?? defaultBudget;
	const ledger = createLedger();
	const budget = createBudget(cfg);
	const flags = createDueFlags();
	const issued = new Map<string, ActionTicket>();
	const receipts = new Map<string, Observation>();
	let state: AgencyState = emptyState();
	let enabled = true;
	// Updates that keep failing stop retrying until a new observation arrives.
	let failures = 0;
	let quarantined = false;
	// Background calls run one at a time.
	let tail: Promise<unknown> = Promise.resolve();
	const serial = <T>(fn: () => Promise<T>): Promise<T> => {
		const run = tail.then(() => fn());
		tail = run.catch(() => undefined);
		return run;
	};

	const active = () => enabled && condition !== "B0";
	const actionable = (upto: number): readonly Observation[] =>
		quarantined ? [] : ledger.pending(upto);
	const dueNow = (now: number): Due =>
		condition === "B1" || quarantined
			? NO_DUE
			: findDue(state, limits, now, flags);
	// invalidate() bumps this; a select that straddles it is never reserved.
	let epoch = 0;

	const present = (
		batch: readonly Observation[],
		pending: readonly Observation[],
	): Observation[] => {
		const m = new Map<number, Observation>();
		for (const o of ledger.all().slice(-RECENT_OBSERVATION_WINDOW))
			m.set(o.seq, o);
		for (const o of pending.slice(-PENDING_CAP)) m.set(o.seq, o);
		for (const o of batch) m.set(o.seq, o);
		return [...m.values()].sort((a, b) => a.seq - b.seq);
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

	const noteFailure = () => {
		failures += 1;
		if (failures >= 2) quarantined = true;
	};
	// Transient provider errors say nothing about the batch, so they never count toward
	// quarantine. The update still fails for that opportunity (decide returns without selecting)
	// and is retried at the next one, bounded by the call budget. CallOutcome carries no
	// `retryable` flag, so transient is decided from the code, mirroring LlmCallError's
	// retryable mapping in standalone/claude.ts: `connection` (incl. timeouts), `api_429:*`,
	// `api_5xx:*`. Non-retryable llm_call codes (auth, 400, spend_limit) will not fix themselves,
	// so they count, like llm:* output errors, schema or settle rejections and unexpected errors.
	const transientCall = /^llm_call:(connection$|api_(429|5\d\d):)/;
	const countsTowardQuarantine = (code: string) =>
		code !== "aborted" && !transientCall.test(code);

	/** All outcomes of the update; the last one is the final result. */
	const runUpdate = async (
		at: number,
		signal: AbortSignal,
		batch: readonly Observation[],
		due: Due,
	): Promise<CallOutcome[]> => {
		if (condition === "B0") throw new Error("B0 never calls the model");
		const presented = present(batch, []);
		const keys = issuedKeys(state, due);
		const r = await callModel(
			llm,
			budget,
			{
				purpose: "update",
				at,
				system: systemPrompt("update", condition),
				prompt: updatePrompt({
					condition,
					now: at,
					observations: presented,
					freshIds: new Set(batch.map((o) => o.id)),
					state,
					due,
					delivered: delivered(),
					tools,
					limits,
					minutesSinceUserInput: minutesSinceUserInput(at),
				}),
				schema: wireSchema,
				maxOutputTokens: cfg.updateMaxOutputTokens,
			},
			signal,
		);
		if (!r.ok) {
			if (countsTowardQuarantine(r.outcome.code)) noteFailure();
			return [...r.prior, r.outcome];
		}
		const typed = fromWire(r.value, condition);
		if (!typed.ok) {
			noteFailure();
			return [
				...r.prior,
				makeOutcome("update", at, "rejected:schema", r.usage, ["schema"]),
			];
		}
		const result = settleUpdate({
			condition,
			state,
			proposal: typed.proposal,
			presented,
			batch,
			cursor: ledger.cursor(),
			tools,
			limits,
			now: at,
		});
		if (result.kind === "rejected") {
			noteFailure();
			return [
				...r.prior,
				makeOutcome(
					"update",
					at,
					`rejected:${result.codes[0] ?? "unknown"}`,
					r.usage,
					result.codes,
				),
			];
		}
		state = result.state;
		ledger.markProcessed(batch.map((o) => o.seq));
		markIssued(keys, flags);
		failures = 0;
		return [...r.prior, makeOutcome("update", at, result.kind, r.usage)];
	};

	const decideInner = async (
		opp: Parameters<AgencyRuntime["decide"]>[0],
		signal: AbortSignal,
	): Promise<{ decision: Decision; calls: CallOutcome[] }> => {
		const calls: CallOutcome[] = [];
		const done = (decision: Decision) => ({ decision, calls });
		if (!active())
			return done(hostDecision(opp.id, "host_disabled", "agency disabled"));
		if (opp.presence !== "quiet" || opp.foregroundBusy || opp.playerBusy) {
			blockPending(state);
			return done(hostDecision(opp.id, "host_blocked", "not a quiet moment"));
		}
		refreshCandidates(state, opp.at);
		const startEpoch = epoch;

		// Observations received before the opportunity are interpreted first.
		const upto = ledger.lastSeq();
		let budgetBlocked = false;
		let failed: CallOutcome | null = null;
		for (;;) {
			const batch = actionable(upto).slice(0, cfg.batchSize);
			const due = dueNow(opp.at);
			if (batch.length === 0 && !isDue(due)) break;
			if (budget.check(opp.at, false) !== "ok") {
				calls.push(skippedOutcome("update", opp.at, "skipped:budget"));
				budgetBlocked = true;
				break;
			}
			const os = await runUpdate(opp.at, signal, batch, due);
			calls.push(...os);
			const last = os[os.length - 1];
			if (last && !isApplied(last)) {
				failed = last;
				break;
			}
		}
		if (failed)
			return done(
				hostDecision(
					opp.id,
					failed.code.startsWith("rejected") ? "rejected" : "error",
					`update_failed:${failed.code}`,
					failed.rejectCodes,
				),
			);

		// Quarantined updates leave observations unprocessed. Never select or reserve on a state
		// that has not seen them (it could re-propose what the user just declined).
		const unprocessed = ledger.pending(upto).length;
		if (quarantined && unprocessed > 0)
			return done(
				hostDecision(
					opp.id,
					"host_stale",
					`state is stale: ${unprocessed} unprocessed observations (update quarantined)`,
				),
			);

		const pool: readonly Candidate[] =
			condition === "B1" ? [] : presentableCandidates(state);
		const items = condition === "B1" ? state.notes.length : pool.length;
		// B1a (eval ablation): with no notes, still let select speak from the observations.
		const selectEmpty = condition === "B1" && deps.selectWhenEmpty === true;
		if (items === 0 && !selectEmpty)
			return done(
				hostDecision(opp.id, "host_no_candidates", "nothing to offer"),
			);
		if (budgetBlocked || budget.check(opp.at, false) !== "ok") {
			calls.push(skippedOutcome("select", opp.at, "skipped:budget"));
			return done(hostDecision(opp.id, "host_budget", "no budget for select"));
		}

		const presented = present([], ledger.pending());
		// Evidence ids the select prompt shows on state items are citable too.
		const shownEvidence = selectEvidenceIds(condition, state);
		const r = await callModel(
			llm,
			budget,
			{
				purpose: "select",
				at: opp.at,
				system: systemPrompt("select", condition),
				prompt: selectPrompt({
					condition,
					now: opp.at,
					opportunity: opp,
					observations: presented,
					freshIds: new Set(ledger.pending().map((o) => o.id)),
					state,
					candidates: pool,
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
			// New input / speech start arrived while the model was thinking.
			calls.push(
				makeOutcome("select", opp.at, "rejected:stale_epoch", r.usage, [
					"stale_epoch",
				]),
			);
			return done(hostDecision(opp.id, "rejected", p.reason, ["stale_epoch"]));
		}
		const verdict = validateParticipation({
			condition,
			state,
			proposal: p,
			presentedObservations: new Set([
				...presented.map((o) => o.id),
				...shownEvidence,
			]),
			presentedCandidates: new Map(pool.map((c) => [c.id, c.revision])),
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
			return done({
				...hostDecision(opp.id, "rejected", p.reason, verdict.codes),
				candidateId: p.candidateRef?.id ?? null,
			});
		}
		calls.push(makeOutcome("select", opp.at, "applied", r.usage));
		let ticket: ActionTicket | null = null;
		if (p.action === "speak" || p.action === "tool") {
			ticket = reserveOutward(state, opp.id, p.action, verdict, opp.at);
			issued.set(ticket.id, ticket);
		} else if (p.action === "wait" && verdict.candidate)
			deferCandidate(state, verdict.candidate);
		else if (p.action === "discard" && verdict.candidate)
			dismissCandidate(state, verdict.candidate);
		return done({
			opportunityId: opp.id,
			action: p.action,
			source: "llm",
			candidateId: verdict.candidate?.id ?? null,
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
		condition,
		observe(input) {
			const before = ledger.lastSeq();
			const o = ledger.record(input);
			if (ledger.lastSeq() > before) {
				failures = 0;
				quarantined = false;
			}
			return o;
		},
		runBackground: (now, signal) =>
			serial(async () => {
				const out: CallOutcome[] = [];
				if (!active()) return out;
				const upto = ledger.lastSeq();
				for (;;) {
					const batch = actionable(upto).slice(0, cfg.batchSize);
					const due = dueNow(now);
					if (batch.length === 0 && !isDue(due)) break;
					const verdict = budget.check(now, true);
					if (verdict !== "ok") {
						out.push(skippedOutcome("update", now, verdict));
						break;
					}
					const os = await runUpdate(now, signal, batch, due);
					out.push(...os);
					const last = os[os.length - 1];
					if (!last || !isApplied(last)) break;
				}
				return out;
			}),
		decide: (opportunity, signal) =>
			serial(() => decideInner(opportunity, signal)),
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
			failures = 0;
			quarantined = false;
			return obs;
		},
		invalidate(_reason, _now) {
			epoch += 1;
			interruptLive(state);
			issued.clear();
		},
		setEnabled(value) {
			enabled = value;
		},
		projection: (maxItems) => buildProjection(condition, state, maxItems),
		snapshot: () => ({
			state: structuredClone(state),
			observations: ledger.all(),
			cursor: ledger.cursor(),
		}),
	};
};
