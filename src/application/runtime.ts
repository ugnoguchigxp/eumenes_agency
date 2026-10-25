import type {
	AgencyState,
	Candidate,
	HostTodo,
	HostTopic,
	Observation,
} from "../contracts/model.ts";
import { defaultLimits, emptyState } from "../contracts/model.ts";
import type { z } from "zod";
import {
	emotionEmoji,
	emotionName,
	type EmotionEmoji,
} from "../contracts/emotion.ts";
import {
	fromWire,
	participationEmotionSchema,
	participationSchema,
	wireUpdateSchema,
	type ParticipationProposal,
} from "../contracts/proposals.ts";
import {
	defaultBudget,
	RECENT_OBSERVATION_WINDOW,
	type ActionTicket,
	type StandingInterest,
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
	interestRef,
	memoryRef,
	contextRef,
	todoRef,
	systemPrompt,
	updatePrompt,
} from "./prompts.ts";

/** The cap on extra pending observations shown on top of the recent window. */
const PENDING_CAP = 16;
const DELIVERED_SHOWN = 5;
/** Speak tickets whose topic/interest refs wait for a receipt (oldest dropped beyond this). */
const TOPIC_TICKETS_KEPT = 64;
const NO_DUE: Due = { reviewIntentIds: [], pressure: [] };

export const createAgencyRuntime = (deps: RuntimeDeps): AgencyRuntime => {
	const { condition, llm, tools } = deps;
	// Social conversation mode applies to B1 only; otherwise every prompt stays as before.
	// Host topics (topics kept by the host's own memory) take precedence over note-based seeds.
	const hostTopics = condition === "B1" && deps.hostTopics === true;
	const hostTodos = condition === "B1" && deps.hostTodos === true;
	// Utterance emotion (B1 only): select also picks the feeling of a speak.
	const emotionMode = condition === "B1" && deps.utteranceEmotion === true;
	const selectSchema: z.ZodType<
		ParticipationProposal & { readonly emotion?: EmotionEmoji | null }
	> = emotionMode ? participationEmotionSchema : participationSchema;
	const social =
		condition === "B1" && deps.socialTopics === true && !hostTopics;
	const wireSchema = wireUpdateSchema(condition === "B0" ? "B2" : condition, {
		hostTodos,
	});
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
	// hostTodos: finished work items a normal reply conveyed, waiting for the host to take them.
	let reportedTodos: { todoId: string; observationId: string }[] = [];
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
	const deliveredObs = () =>
		ledger
			.all()
			.filter((o) => o.kind === "delivery.observed" && o.actor === "agent")
			.slice(-DELIVERED_SHOWN);
	const delivered = () => deliveredObs().map((o) => o.text);
	// Utterance emotion: the feeling each delivered utterance was said with, by its receipt observation.
	const feelingByObs = new Map<string, EmotionEmoji>();
	const minutesAgo = (now: number, at: number) =>
		Math.max(0, Math.round((now - at) / 60_000));
	/** Unrounded, so that two uses within the same minute still order by recency. */
	const exactMinutesAgo = (now: number, at: number) =>
		Math.max(0, (now - at) / 60_000);
	// Lull talk: when each topic (memory:<id>) or interest (interest:<id>) was last delivered,
	// from the refs of accepted speak tickets and their successful receipts.
	const topicTickets = new Map<string, readonly string[]>();
	const lastUsedAt = new Map<string, number>();
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

	/** The host's work items as the update sees them (hostTodos mode); errands are not reportable. */
	const updateTodos = (): readonly HostTodo[] =>
		hostTodos
			? (deps.todos?.() ?? []).filter(
					(x) =>
						x.id !== "" &&
						x.title.trim() !== "" &&
						x.kind !== "errand" &&
						(x.status !== "waiting" || (x.question ?? "").trim() !== ""),
				)
			: [];
	/**
	 * Keeps only reports of a finished item that was shown, conveyed by an agent reply that exists,
	 * was presented and arrived after the item was done.
	 */
	const settleReportedTodos = (
		reports: readonly { todoId: string; observationRef: string }[],
		shown: readonly HostTodo[],
		presented: readonly Observation[],
	) => {
		for (const r of reports) {
			const todoId = r.todoId.startsWith("todo:")
				? r.todoId.slice(5)
				: r.todoId;
			const todo = shown.find((x) => x.id === todoId);
			const o = presented.find((x) => x.id === r.observationRef);
			if (
				!todo ||
				todo.status !== "done" ||
				!o ||
				o.kind !== "exchange.adopted" ||
				o.actor !== "agent" ||
				(todo.doneAt !== undefined && o.occurredAt < todo.doneAt) ||
				reportedTodos.some(
					(x) => x.todoId === todo.id && x.observationId === o.id,
				)
			)
				continue;
			reportedTodos.push({ todoId: todo.id, observationId: o.id });
		}
	};

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
		const shownTodos = hostTodos ? updateTodos() : undefined;
		const r = await callModel(
			llm,
			budget,
			{
				purpose: "update",
				at,
				system: systemPrompt("update", condition, {
					...(social ? { social } : {}),
					...(hostTodos ? { hostTodos } : {}),
				}),
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
					...(shownTodos ? { todos: shownTodos } : {}),
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
		if (shownTodos)
			settleReportedTodos(r.value.reportedTodos ?? [], shownTodos, presented);
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
		// Standing interests are presented to B1 only: B2/F speak needs a candidate, so
		// interest talk is unsupported there (ignored: no prompt, no gate, no known refs).
		const interests: readonly StandingInterest[] =
			condition === "B1"
				? (deps.standingInterests ?? []).filter(
						(x) => x.id !== "" && x.text.trim() !== "",
					)
				: [];
		// Host topics (hostTopics mode, B1 only): seeds supplied by the host for this opportunity.
		const topics: readonly HostTopic[] = hostTopics
			? (opp.topics ?? []).filter((x) => x.id !== "" && x.text.trim() !== "")
			: [];
		const ambient: readonly HostTopic[] = hostTopics
			? (opp.ambient ?? []).filter((x) => x.id !== "" && x.text.trim() !== "")
			: [];
		// Work reports (hostTodos mode, B1 only): the host's open and done-unreported items.
		// Errands are shown only inside their reminder window (spec/errand-design.md).
		const todos: readonly HostTodo[] = hostTodos
			? (opp.todos ?? []).filter(
					(x) =>
						x.id !== "" &&
						x.title.trim() !== "" &&
						(x.status !== "waiting" || (x.question ?? "").trim() !== "") &&
						(x.kind !== "errand" ||
							(x.remindFrom !== undefined &&
								x.dueAt !== undefined &&
								x.remindFrom <= opp.at &&
								opp.at < x.dueAt)),
				)
			: [];
		const doneTodos = todos.filter(
			(x) =>
				x.status === "done" || x.status === "waiting" || x.kind === "errand",
		).length;
		// B1a (eval ablation): with no notes, still let select speak from the observations.
		const selectEmpty = condition === "B1" && deps.selectWhenEmpty === true;
		if (
			items === 0 &&
			!selectEmpty &&
			interests.length === 0 &&
			topics.length === 0 &&
			ambient.length === 0 &&
			doneTodos === 0
		)
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
				system: systemPrompt("select", condition, {
					utteranceStyle: deps.utteranceStyle,
					interests: interests.length > 0,
					...(social ? { social } : {}),
					...(hostTopics ? { hostTopics } : {}),
					...(hostTodos ? { hostTodos } : {}),
					...(hostTodos && todos.some((x) => x.status === "waiting")
						? { todoQuestions: true }
						: {}),
					...(emotionMode ? { emotion: emotionMode } : {}),
					...(hostTopics && tools.some((t) => !t.requiresApproval)
						? { selfResearch: true }
						: {}),
				}),
				prompt: selectPrompt({
					condition,
					now: opp.at,
					opportunity: opp,
					observations: presented,
					freshIds: new Set(ledger.pending().map((o) => o.id)),
					state,
					candidates: pool,
					delivered: delivered(),
					...(social || hostTopics || hostTodos
						? {
								deliveredMinutesAgo: deliveredObs().map((o) =>
									minutesAgo(opp.at, o.occurredAt),
								),
							}
						: {}),
					...(emotionMode
						? {
								deliveredEmotions: deliveredObs().map(
									(o) => feelingByObs.get(o.id) ?? null,
								),
							}
						: {}),
					...(interests.length > 0 ? { interests } : {}),
					...(topics.length > 0 ? { topics } : {}),
					...(ambient.length > 0 ? { ambient } : {}),
					...(todos.length > 0 ? { todos } : {}),
					...((social || hostTopics || hostTodos) && lastUsedAt.size > 0
						? {
								lastUsedMinutesAgo: new Map(
									[...lastUsedAt].map(([ref, at]) => [
										ref,
										exactMinutesAgo(opp.at, at),
									]),
								),
							}
						: {}),
					tools,
					limits,
					minutesSinceUserInput: minutesSinceUserInput(opp.at),
					...(social ? { social } : {}),
					...(hostTopics ? { hostTopics } : {}),
				}),
				schema: selectSchema,
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
		// B1: a note may be cited by its id; read it as the note's evidence (host-rules-4).
		// An id that is also an observation's stays the observation (host ids are free-form).
		const observationIds = new Set(ledger.all().map((o) => o.id));
		const p =
			condition === "B1"
				? {
						...r.value,
						evidenceRefs: [
							...new Set(
								r.value.evidenceRefs.flatMap((ref) =>
									observationIds.has(ref)
										? [ref]
										: (state.notes.find((n) => n.id === ref)?.evidence ?? [
												ref,
											]),
								),
							),
						],
					}
				: r.value;
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
				...interests.map((x) => interestRef(x.id)),
				...topics.map((x) => memoryRef(x.id)),
				...ambient.map((x) => contextRef(x.id)),
				...todos.map((x) => todoRef(x.id)),
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
		// A speak without a valid emotion stays unspecified (the host decides), never a silent default.
		const emotion =
			emotionMode && p.action === "speak" && p.emotion
				? emotionName(p.emotion)
				: undefined;
		let ticket: ActionTicket | null = null;
		if (p.action === "speak" || p.action === "tool") {
			const reserved = reserveOutward(state, opp.id, p.action, verdict, opp.at);
			ticket = emotion ? { ...reserved, emotion } : reserved;
			issued.set(ticket.id, ticket);
			const used = p.evidenceRefs.filter(
				(ref) =>
					ref.startsWith("memory:") ||
					ref.startsWith("context:") ||
					ref.startsWith("interest:") ||
					ref.startsWith("todo:"),
			);
			if (p.action === "speak" && used.length > 0) {
				topicTickets.set(ticket.id, used);
				if (topicTickets.size > TOPIC_TICKETS_KEPT)
					topicTickets.delete(topicTickets.keys().next().value!);
			}
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
			...(emotion ? { emotion } : {}),
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
		takeReportedTodos() {
			const out = reportedTodos;
			reportedTodos = [];
			return out;
		},
		recordResult(receipt) {
			const key = `${receipt.ticketId}:${receipt.status}`;
			const known = receipts.get(key);
			if (known) return known;
			const ticket = issued.get(receipt.ticketId);
			const { observation } = applyReceipt(state, receipt, ticket);
			const obs = ledger.record(observation);
			receipts.set(key, obs);
			if (ticket?.emotion && receipt.status === "succeeded") {
				feelingByObs.set(obs.id, emotionEmoji(ticket.emotion));
				if (feelingByObs.size > TOPIC_TICKETS_KEPT)
					feelingByObs.delete(feelingByObs.keys().next().value!);
			}
			const used = topicTickets.get(receipt.ticketId);
			if (used && receipt.status === "succeeded")
				for (const ref of used) lastUsedAt.set(ref, receipt.at);
			// An interrupted or unknown outcome can still turn into a late success.
			if (receipt.status === "succeeded" || receipt.status === "failed")
				topicTickets.delete(receipt.ticketId);
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
