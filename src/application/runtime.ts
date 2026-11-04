import {
	findingIntents,
	isFindingReturn,
	selectionFindingRefs,
} from "./findings.ts";
import { settleInterests } from "../domains/agency/settle-interests.ts";
import type { InterestOp } from "../contracts/interest.ts";
import type { WireInterestOp } from "../contracts/proposals.ts";
import type {
	AgencyState,
	Candidate,
	HostTodo,
	HostTopic,
	Observation,
} from "../contracts/model.ts";
import {
	defaultLimits,
	deliveryStatuses,
	emptyState,
	isOpenIntent,
	limitsSchema,
} from "../contracts/model.ts";
import {
	emotionEmoji,
	emotionName,
	type EmotionEmoji,
} from "../contracts/emotion.ts";
import { fromWire } from "../contracts/proposals.ts";
import {
	defaultBudget,
	budgetConfigSchema,
	RECENT_OBSERVATION_WINDOW,
	type ActionTicket,
	ticketTts,
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
import { allocId } from "../domains/agency/ids.ts";
import { repairGuardFilter, settleUpdate } from "../domains/agency/settle.ts";
import { createLedger } from "../domains/experience/ledger.ts";
import { createBudget } from "./budget.ts";
import { ActivityBudget, defaultActivityLimits } from "./activity-budget.ts";
import {
	commitWake,
	createWakeFlags,
	defaultWakeConfig,
	wake as wakeCheck,
	type WakeEvent,
	type WakeResult,
} from "../domains/agency/wake.ts";
import { holdCandidate } from "../domains/agency/lifecycle.ts";
import {
	callModel,
	isApplied,
	makeOutcome,
	skippedOutcome,
} from "./model-call.ts";
import { buildProjection } from "./projection.ts";
import { agencyOutputContract } from "./output-contract.ts";
import { updateModelData, selectModelData } from "./model-data.ts";
import { RevisionTracker } from "./revisions.ts";
import { validateRestore } from "./snapshot.ts";
import type { ItemRevision } from "../contracts/revisions.ts";
import {
	captureSystemContext,
	resolveSystemContext,
} from "./system-context.ts";
import {
	selectEvidenceIds,
	selectPrompt,
	interestRef,
	memoryRef,
	contextRef,
	todoRef,
	systemPrompt,
	updatePrompt,
	type UpdatePromptInput,
	type SelectPromptInput,
} from "./prompts.ts";

/** The cap on extra pending observations shown on top of the recent window. */
const PENDING_CAP = 16;
export const DELEGATE_TOOL = "delegate";
/** P4-a: review a returned work unit's intent no earlier than this after the return. */
const RETURN_REVIEW_MS = 24 * 3_600_000;
/**
 * A delegated work unit with no return (e.g. its receipt stayed outcome_unknown) stops counting
 * as running after this, so one lost return cannot block wakes and re-delegation forever.
 */
export const WORK_STALE_MS = 48 * 3_600_000;
const DELIVERED_SHOWN = 5;
const WORK_SUMMARY_CHARS = 400;
/** Speak tickets whose topic/interest refs wait for a receipt (oldest dropped beyond this). */
const TOPIC_TICKETS_KEPT = 64;
const NO_DUE: Due = { reviewIntentIds: [], pressure: [] };

/** Interest cap for condition I (plan §3.1: Limits.interests, e.g. 24). */
const INTEREST_LIMIT = 24;

/** Maps a wire interest op to a typed op; malformed ops are dropped (null). */
const interestOpFromWire = (w: WireInterestOp): InterestOp | null => {
	if (w.op === "interest.add") {
		if (!w.localId || !w.topic || !w.origin || !w.reason) return null;
		return {
			op: "interest.add",
			localId: w.localId,
			topic: w.topic,
			origin: w.origin,
			reason: w.reason,
			evidenceRefs: w.evidenceRefs,
			derivedFrom: w.derivedFrom,
		};
	}
	if (!w.id || w.expectedRevision === null || !w.reason) return null;
	return {
		op: "interest.update",
		id: w.id,
		expectedRevision: w.expectedRevision,
		status: w.status,
		topic: w.topic,
		reason: w.reason,
		evidenceRefs: w.evidenceRefs,
	};
};

export const createAgencyRuntime = (deps: RuntimeDeps): AgencyRuntime => {
	const { condition, llm, tools } = deps;
	const systemContext = captureSystemContext(deps.systemContext);
	// Experimental social rules apply to B1 only; host-owned instructions are never extended.
	// Host topics (topics kept by the host's own memory) take precedence over note-based seeds.
	const hostData = condition === "B1" || condition === "F";
	const hostTopics = hostData && deps.hostTopics === true;
	const hostTodos = hostData && deps.hostTodos === true;
	const emotionMode = hostData && deps.utteranceEmotion === true;
	const social =
		condition === "B1" && deps.socialTopics === true && !hostTopics;
	// Condition I (Agency Next P2-b): F plus interest formation.
	const interestFormation =
		condition === "F" && deps.interestFormation === true;
	const contractOptions = {
		condition: condition === "B0" ? ("B2" as const) : condition,
		hostTodos,
		findings: deps.findings === true,
		interestFormation,
		utteranceEmotion: emotionMode,
		...(deps.constrainToolNames
			? { toolNames: tools.map((tool) => tool.name) }
			: {}),
	};
	const updateContract = agencyOutputContract("update", contractOptions);
	const selectContract = agencyOutputContract("select", contractOptions);
	const limits = limitsSchema.parse(deps.limits ?? defaultLimits);
	const cfg = budgetConfigSchema.parse(deps.budget ?? defaultBudget);
	const ledger = createLedger();
	if (deps.callBudgetMeter) {
		const shared = budgetConfigSchema.parse(deps.callBudgetMeter.config);
		if (
			shared.windowMs !== cfg.windowMs ||
			shared.maxCallsPerWindow > cfg.maxCallsPerWindow ||
			shared.minIntervalMs < cfg.minIntervalMs
		)
			throw new RangeError(
				"callBudgetMeter must use the configured window and equal or stricter call limits",
			);
	}
	const budget =
		deps.callBudgetMeter ?? createBudget(cfg, deps.restore?.continuity?.calls);
	const flags = createDueFlags();
	const wakeFlags = createWakeFlags();
	const wakeCfg = deps.wakeConfig ?? defaultWakeConfig;
	if (deps.activityBudgetMeter) {
		const configured = deps.activityLimits ?? defaultActivityLimits;
		for (const key of ["toolCalls", "tokens", "elapsedMs"] as const) {
			const shared = deps.activityBudgetMeter.limits[key];
			if (
				!Number.isFinite(shared) ||
				shared < 0 ||
				!(shared <= configured[key])
			)
				throw new RangeError(
					"activityBudgetMeter must use equal or stricter activity limits",
				);
		}
	}
	const activity =
		deps.activityBudgetMeter ??
		new ActivityBudget(
			deps.activityLimits,
			deps.restore?.continuity?.activities,
		);
	const tracksWork = deps.workReturns ?? true;
	let wakeCount = 0;
	const issued = new Map<string, ActionTicket>();
	const receipts = new Map<string, Observation>();
	if (deps.restore !== undefined) validateRestore(deps.restore, condition);
	if (deps.restore?.observations !== undefined) {
		// Older snapshots kept the status in the receipt key but not on the observation.
		const legacyStatuses = new Map<string, Observation["deliveryStatus"]>();
		for (const [key, observation] of deps.restore.continuity?.receipts ?? []) {
			if (
				observation.kind === "delivery.observed" &&
				!observation.deliveryStatus
			)
				legacyStatuses.set(
					observation.id,
					deliveryStatuses.find((status) => key.endsWith(":" + status)),
				);
		}
		for (const o of deps.restore.observations) {
			const { seq: _seq, ...input } = o;
			const status = o.deliveryStatus ?? legacyStatuses.get(o.id);
			ledger.record(status ? { ...input, deliveryStatus: status } : input);
		}
		ledger.markProcessed(
			deps.restore.observations.slice(0, deps.restore.cursor).map((o) => o.seq),
		);
	}
	if (deps.restore?.scheduling) {
		const s = deps.restore.scheduling;
		for (const key of s.review) flags.review.add(key);
		for (const key of s.pressure) flags.pressure.add(key);
		for (const key of s.wake.review) wakeFlags.review.add(key);
		for (const key of s.wake.recall) wakeFlags.recall.add(key);
		for (const key of s.wake.events) wakeFlags.events.add(key);
		for (const [key, until] of s.wake.faultUntil)
			wakeFlags.faultUntil.set(key, until);
		for (const [key, count] of s.wake.perDay) wakeFlags.perDay.set(key, count);
		wakeCount = s.wakeCount;
	}
	let state: AgencyState = deps.restore
		? structuredClone(deps.restore.state)
		: interestFormation
			? { ...emptyState(), interests: [] }
			: emptyState();
	const revTracker = deps.revisions
		? new RevisionTracker(deps.revisions.scope)
		: null;
	if (revTracker && deps.restore) revTracker.prime(state, deps.restore.revs);
	// Retain a failed batch verbatim so its provenance and revision numbers survive retry.
	let pendingRevisions: readonly ItemRevision[] = [];
	const flushRevisions = (callId: string, at: number) => {
		if (!revTracker || !deps.revisions) return;
		const appendPending = () => {
			if (pendingRevisions.length === 0) return;
			deps.revisions!.append(pendingRevisions);
			revTracker.commit(pendingRevisions);
			pendingRevisions = [];
		};
		appendPending();
		pendingRevisions = revTracker.diff(state, callId, at);
		appendPending();
	};
	let enabled = true;
	// Updates that keep failing stop retrying until a new observation arrives.
	let failures = deps.restore?.continuity?.failures ?? 0;
	let diagnostics: readonly string[] =
		deps.restore?.continuity?.diagnostics ?? [];
	let quarantined = deps.restore?.continuity?.quarantined ?? false;
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
		includeFindings = false,
	): Observation[] => {
		const m = new Map<number, Observation>();
		// Recall a bounded excerpt; recent observations and the current batch below retain their full text.
		if (includeFindings) {
			for (const finding of findingIntents(state)) {
				for (const ref of finding.evidence) {
					const o = ledger.get(ref);
					if (!isFindingReturn(o, finding.lastReturn.workRef)) continue;
					const text =
						o.text.length > WORK_SUMMARY_CHARS
							? o.text.slice(0, WORK_SUMMARY_CHARS) + "…"
							: o.text;
					m.set(o.seq, { ...o, text });
					break;
				}
			}
		}
		if (deps.planOnOpportunity) {
			const refs = [
				...(state.interests ?? [])
					.filter((i) => i.status !== "faded")
					.flatMap((i) => i.evidence),
				...state.intents.filter(isOpenIntent).flatMap((i) => i.evidence),
			].slice(-PENDING_CAP);
			for (const ref of refs) {
				const o = ledger.get(ref);
				if (o) m.set(o.seq, o);
			}
		}
		// Preserve the identity of recent voice offers even when other observations push them out of the window.
		for (const o of deliveredObs()) if (o.speechHandoff) m.set(o.seq, o);
		for (const o of ledger.all().slice(-RECENT_OBSERVATION_WINDOW))
			m.set(o.seq, o);
		for (const o of pending.slice(-PENDING_CAP)) m.set(o.seq, o);
		for (const o of batch) m.set(o.seq, o);
		return [...m.values()].sort((a, b) => a.seq - b.seq);
	};
	const deliveredObs = () =>
		ledger
			.all()
			.filter(
				(o) =>
					o.kind === "delivery.observed" &&
					o.actor === "agent" &&
					(o.deliveryStatus === "succeeded" ||
						(o.deliveryStatus === undefined &&
							(!o.causationId || o.speechHandoff !== undefined))),
			)
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
	if (deps.restore?.continuity) {
		const c = deps.restore.continuity;
		for (const t of c.issued) issued.set(t.id, structuredClone(t));
		for (const [key, o] of c.receipts)
			receipts.set(key, ledger.get(o.id) ?? structuredClone(o));
		for (const [id, refs] of c.topics) topicTickets.set(id, [...refs]);
		for (const [id, at] of c.lastUsed) lastUsedAt.set(id, at);
		for (const [id, feeling] of c.feelings) feelingByObs.set(id, feeling);
	}
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
	const runUpdateOnce = async (
		at: number,
		signal: AbortSignal,
		batch: readonly Observation[],
		due: Due,
		opportunity?: import("../contracts/model.ts").Opportunity,
	): Promise<CallOutcome[]> => {
		if (condition === "B0") throw new Error("B0 never calls the model");
		const startEpoch = epoch;
		const findings =
			opportunity !== undefined && deps.findings === true && condition !== "B1";
		const presented = present(batch, [], findings);
		const keys = issuedKeys(state, due);
		const shownTodos = hostTodos ? updateTodos() : undefined;
		const input: UpdatePromptInput = {
			condition,
			now: at,
			...(opportunity ? { opportunity } : {}),
			findings,
			...(diagnostics.length ? { validationCodes: diagnostics } : {}),
			observations: presented,
			freshIds: new Set(batch.map((o) => o.id)),
			state,
			due,
			delivered: delivered(),
			tools,
			limits,
			minutesSinceUserInput: minutesSinceUserInput(at),
			...(shownTodos ? { todos: shownTodos } : {}),
			...(condition === "F" && hostTopics
				? {
						topics: deps.topics?.() ?? [],
						interests: deps.standingInterests ?? [],
					}
				: {}),
		};
		const data = updateModelData(input);
		const prompt =
			systemContext === "experimental"
				? updatePrompt(input)
				: JSON.stringify(data);
		const system =
			systemContext === "experimental"
				? systemPrompt("update", condition, {
						...(social ? { social } : {}),
						...(hostTodos ? { hostTodos } : {}),
						...(interestFormation ? { interestFormation } : {}),
					})
				: resolveSystemContext(
						systemContext.update,
						{
							data,
							outputContract: agencyOutputContract("update", contractOptions),
						},
						"update",
					);
		const r = await callModel(
			llm,
			budget,
			{
				purpose: "update",
				at,
				system,
				prompt,
				schema: updateContract.schema,
				maxOutputTokens: cfg.updateMaxOutputTokens,
			},
			signal,
		);
		if (!r.ok) {
			if (epoch === startEpoch && countsTowardQuarantine(r.outcome.code))
				noteFailure();
			return [...r.prior, r.outcome];
		}
		if (epoch !== startEpoch || !active())
			return [
				...r.prior,
				makeOutcome("update", at, "rejected:stale_epoch", r.usage, [
					"stale_epoch",
				]),
			];
		const typed = fromWire(r.value, condition, (codes) => {
			diagnostics = codes;
		});
		if (!typed.ok) {
			noteFailure();
			return [
				...r.prior,
				makeOutcome(
					"update",
					at,
					"rejected:schema",
					r.usage,
					deps.repairUpdates ? ["schema", ...diagnostics] : ["schema"],
				),
			];
		}
		// P5-b: dropped repair proposals are reported on the outcome (repair:<code>).
		const faults = new Map(
			ledger
				.all()
				.flatMap((o) =>
					o.kind === "fault.observed" && o.code
						? [[o.id, o.code] as const]
						: [],
				),
		);
		const repairDrops =
			deps.repairGuard === false
				? []
				: repairGuardFilter(
						state,
						new Map(presented.map((o) => [o.id, o])),
						typed.proposal.ops,
						faults,
					).dropped.map((c) => `repair:${c}`);
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
			...(deps.repairGuard === false ? { repairGuard: false } : { faults }),
		});
		if (result.kind === "rejected") {
			diagnostics = result.codes;
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
		let interestRejects: string[] = [];
		if (interestFormation) {
			const wire = r.value.interestOps ?? [];
			const ops = wire.flatMap((w) => {
				const op = interestOpFromWire(w);
				return op ? [op] : [];
			});
			const settled = settleInterests({
				interests: state.interests ?? [],
				ops,
				obs: new Map(presented.map((o) => [o.id, o])),
				history: new Map(ledger.all().map((o) => [o.id, o])),
				limit: INTEREST_LIMIT,
				seq: ledger.cursor(),
				newId: () => `k${state.nextId++}`,
			});
			state = { ...state, interests: settled.interests };
			interestRejects = [
				...Array.from(
					{ length: wire.length - ops.length },
					() => "interest:malformed",
				),
				...settled.rejects.map((x) => `interest:${x.code}`),
			];
		}
		if (shownTodos)
			settleReportedTodos(r.value.reportedTodos ?? [], shownTodos, presented);
		ledger.markProcessed(batch.map((o) => o.seq));
		markIssued(keys, flags);
		failures = 0;
		quarantined = false;
		diagnostics = [];
		return [
			...r.prior,
			makeOutcome("update", at, result.kind, r.usage, [
				...repairDrops,
				...interestRejects,
			]),
		];
	};

	const runUpdate = async (
		...args: Parameters<typeof runUpdateOnce>
	): Promise<CallOutcome[]> => {
		const generation = epoch;
		const first = await runUpdateOnce(...args);
		if (
			epoch !== generation ||
			!deps.repairUpdates ||
			!first.at(-1)?.code.startsWith("rejected:") ||
			args[1].aborted ||
			budget.check(args[0], false) !== "ok"
		)
			return first;
		return [...first, ...(await runUpdateOnce(...args))];
	};

	// Deadline from the persisted intent.workSince (survives restore). Legacy snapshots without
	// it start counting now, and the stamp is persisted with the next revision.
	const expireStaleWork = (now: number) => {
		for (const i of state.intents) {
			if (!i.workRef) continue;
			if (typeof i.workSince !== "number") i.workSince = now;
			if (now - i.workSince < WORK_STALE_MS) continue;
			i.workRef = null;
			i.workSince = null;
			activity.end(i.id);
			if (i.state === "adopted") {
				i.state = "held";
				i.lastReason = "return:timeout";
			}
			i.revision += 1;
			state.revision += 1;
		}
	};

	const decideInner = async (
		opp: Parameters<AgencyRuntime["decide"]>[0],
		signal: AbortSignal,
		maxUpdates = Number.POSITIVE_INFINITY,
	): Promise<{ decision: Decision; calls: CallOutcome[] }> => {
		const calls: CallOutcome[] = [];
		const done = (decision: Decision) => ({ decision, calls });
		expireStaleWork(opp.at);
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
		let updates = 0;
		for (;;) {
			const batch = actionable(upto).slice(0, cfg.batchSize);
			const due = dueNow(opp.at);
			if (
				batch.length === 0 &&
				!isDue(due) &&
				!(deps.planOnOpportunity && updates === 0 && !quarantined)
			)
				break;
			if (updates >= maxUpdates) break;
			updates += 1;
			if (budget.check(opp.at, false) !== "ok") {
				calls.push(skippedOutcome("update", opp.at, "skipped:budget"));
				budgetBlocked = true;
				break;
			}
			const os = await runUpdate(
				opp.at,
				signal,
				batch,
				due,
				deps.planOnOpportunity ? opp : undefined,
			);
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

		// A bounded wake, exhausted call budget or quarantine can leave an older candidate stale.
		const unprocessed = ledger.pending(upto).length;
		if (unprocessed > 0)
			return done(
				hostDecision(
					opp.id,
					budgetBlocked ? "host_budget" : "host_stale",
					`state is stale: ${unprocessed} unprocessed observations`,
				),
			);

		const pool: readonly Candidate[] =
			condition === "B1" ? [] : presentableCandidates(state);
		const items = condition === "B1" ? state.notes.length : pool.length;
		// F still requires a candidate; host material supplies context, never a fallback action.
		const interests: readonly StandingInterest[] =
			condition === "B1" || (condition === "F" && hostTopics)
				? (deps.standingInterests ?? []).filter(
						(x) => x.id !== "" && x.text.trim() !== "",
					)
				: [];
		const formedInterests =
			condition === "F"
				? (state.interests ?? []).filter((i) => i.status !== "faded")
				: [];
		// Host topics: seeds supplied by the host for this opportunity.
		const topics: readonly HostTopic[] = hostTopics
			? (opp.topics ?? []).filter((x) => x.id !== "" && x.text.trim() !== "")
			: [];
		const ambient: readonly HostTopic[] = hostTopics
			? (opp.ambient ?? []).filter((x) => x.id !== "" && x.text.trim() !== "")
			: [];
		// Work reports: the host's open and done-unreported items.
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
		const findings =
			deps.findings && condition !== "B1" ? findingIntents(state) : [];
		// B1a (eval ablation): with no notes, still let select speak from the observations.
		const selectEmpty =
			condition === "B1" &&
			(deps.selectWhenEmpty === true ||
				interests.length > 0 ||
				topics.length > 0 ||
				ambient.length > 0 ||
				doneTodos > 0);
		if (items === 0 && !selectEmpty && findings.length === 0)
			return done(
				hostDecision(opp.id, "host_no_candidates", "nothing to offer"),
			);
		if (budgetBlocked || budget.check(opp.at, false) !== "ok") {
			calls.push(skippedOutcome("select", opp.at, "skipped:budget"));
			return done(hostDecision(opp.id, "host_budget", "no budget for select"));
		}

		const presented = present([], ledger.pending());
		// Evidence ids the select prompt shows on state items are citable too.
		const shownEvidence = selectEvidenceIds(
			condition,
			state,
			deps.findings === true,
			pool,
		);
		const findingRefs = selectionFindingRefs(
			findings,
			shownEvidence,
			ledger.get,
		);
		const input: SelectPromptInput = {
			condition,
			now: opp.at,
			opportunity: opp,
			observations: presented,
			freshIds: new Set(ledger.pending().map((o) => o.id)),
			state,
			candidates: pool,
			findingRefs: findingRefs.shown,
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
			...(deps.findings ? { findings: true } : {}),
		};
		const data = selectModelData(input);
		const prompt =
			systemContext === "experimental"
				? selectPrompt(input)
				: JSON.stringify(data);
		const system =
			systemContext === "experimental"
				? systemPrompt("select", condition, {
						// Spoken style only when the resulting (autonomous) ticket may be spoken.
						utteranceStyle: ticketTts("autonomous", deps.reportTts)
							? deps.utteranceStyle
							: undefined,
						interests: interests.length > 0,
						...(social ? { social } : {}),
						...(hostTopics ? { hostTopics } : {}),
						...(interestFormation ? { interestFormation } : {}),
						...(hostTodos ? { hostTodos } : {}),
						...(hostTodos && todos.some((x) => x.status === "waiting")
							? { todoQuestions: true }
							: {}),
						...(emotionMode ? { emotion: emotionMode } : {}),
						...(hostTopics && tools.some((t) => !t.requiresApproval)
							? { selfResearch: true }
							: {}),
					})
				: resolveSystemContext(
						systemContext.select,
						{
							data,
							outputContract: agencyOutputContract("select", contractOptions),
						},
						"select",
					);
		const r = await callModel(
			llm,
			budget,
			{
				purpose: "select",
				at: opp.at,
				system,
				prompt,
				schema: selectContract.schema,
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
				...findingRefs.accepted,
				...interests.map((x) => interestRef(x.id)),
				...formedInterests.map((x) => interestRef(x.id)),
				...topics.map((x) => memoryRef(x.id)),
				...ambient.map((x) => contextRef(x.id)),
				...todos.map((x) => todoRef(x.id)),
			]),
			presentedCandidates: new Map(pool.map((c) => [c.id, c.revision])),
			tools,
			limits,
			at: opp.at,
			findingRefs: findingRefs.accepted,
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
		// Activity budget (P3-a): an autonomous tool use beyond the intent's budget is not issued;
		// the intent is held with reason "budget" until its next review.
		const budgetIntent =
			p.action === "tool" && verdict.candidate
				? state.intents.find((i) => i.id === verdict.candidate!.intentId)
				: undefined;
		// P4-a: one delegated work unit per intent; no new request until it returns.
		if (budgetIntent?.workRef && verdict.toolName === DELEGATE_TOOL) {
			if (verdict.candidate)
				holdCandidate(verdict.candidate, "awaiting_outcome");
			state.revision += 1;
			return done({
				...hostDecision(opp.id, "host_delegation", "work unit in flight", [
					"delegation_running",
				]),
				candidateId: verdict.candidate?.id ?? null,
			});
		}
		if (budgetIntent && !activity.canIssueTool(budgetIntent.id, opp.at)) {
			budgetIntent.state = "held";
			budgetIntent.lastReason = "budget";
			if (verdict.candidate) holdCandidate(verdict.candidate, "deferred");
			state.revision += 1;
			return done({
				...hostDecision(opp.id, "host_budget", "activity budget exhausted", [
					"activity_budget",
				]),
				candidateId: verdict.candidate?.id ?? null,
			});
		}
		if (p.action === "speak" && opp.speechAllowed === false)
			return done(
				hostDecision(opp.id, "host_blocked", "speech frequency limit"),
			);
		if (p.action === "speak" || p.action === "tool") {
			// Decide-path tickets are the agent's own initiative (user requests are answered
			// by respond, not by tickets), so origin is "autonomous"; tts comes from host config.
			const reserved = reserveOutward(
				state,
				opp.id,
				p.action,
				verdict,
				opp.at,
				"autonomous",
				ticketTts("autonomous", deps.reportTts),
			);
			const findingWorkRefs =
				p.action === "speak" ? findingRefs.citedWorkRefs(p.evidenceRefs) : [];
			ticket = {
				...reserved,
				...(emotion ? { emotion } : {}),
				...(findingWorkRefs.length ? { findingWorkRefs } : {}),
			};
			issued.set(ticket.id, ticket);
			if (budgetIntent) {
				activity.spend(budgetIntent.id, opp.at, { toolCalls: 1 });
				// A delegation (Eumenes `delegate`) is a work unit that returns later as work.returned.
				if (tracksWork && verdict.toolName === DELEGATE_TOOL) {
					budgetIntent.workRef = ticket.id;
					budgetIntent.workSince = opp.at;
				}
			}
			// Cooldown starts at the agent's own activity on an interest.
			for (const ref of p.evidenceRefs)
				if (ref.startsWith("interest:")) {
					const it = state.interests?.find((x) => x.id === ref.slice(9));
					if (it) it.lastEngagedAt = opp.at;
				}
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

	/**
	 * P4-a return ingestion (host rule, no LLM): the matching intent's work slot is freed, the result
	 * and any follow-up question are recorded, and a review point is set. Non-success holds the intent;
	 * whether to resume is the next update's judgment. Nothing is re-requested here.
	 */
	const ingestReturn = (o: Observation) => {
		const it = state.intents.find((i) => i.workRef === o.workRef);
		if (!it) return;
		const status = o.workStatus ?? "succeeded";
		it.workRef = null;
		it.workSince = null;
		// The returned unit ends its activity: a resumed unit (after a new wake reason) gets its own
		// activity budget instead of inheriting the elapsed time of the previous one.
		activity.end(it.id);
		it.lastReturn = {
			at: o.occurredAt,
			workRef: o.workRef!,
			status,
			summary: o.text.slice(0, WORK_SUMMARY_CHARS),
			question:
				status === "question" ? o.text.slice(0, WORK_SUMMARY_CHARS) : null,
		};
		if (!isOpenIntent(it)) return;
		if (status !== "succeeded" && it.state === "adopted") {
			it.state = "held";
			it.lastReason = `return:${status}`;
		}
		it.reviewAt = Math.max(it.reviewAt, o.occurredAt + RETURN_REVIEW_MS);
		it.evidence = [...new Set([...it.evidence, o.id])];
		it.revision += 1;
		state.revision += 1;
	};

	/** A bounded update acknowledges only observations it actually processed. */
	const commitProcessedWake = (r: WakeResult, now: number) => {
		const pending = new Set(ledger.pending().map((o) => o.id));
		const events = r.keys.events.filter((id) => !pending.has(id));
		const processed = new Set(events);
		const recalls = new Set(r.keys.recall);
		const faultCodes = new Set(
			events.flatMap((id) => {
				const o = ledger.get(id);
				return o?.kind === "fault.observed" && o.code ? [o.code] : [];
			}),
		);
		commitWake(
			{
				...r,
				keys: {
					...r.keys,
					events,
					recall: r.keys.recall.filter((id) => processed.has(id)),
					faults: r.keys.faults.filter((code) => faultCodes.has(code)),
					autonomous: events.filter((id) => {
						const o = ledger.get(id);
						return recalls.has(id) || o?.kind === "external.event";
					}).length,
				},
			},
			wakeFlags,
			now,
			wakeCfg,
		);
	};

	const api: AgencyRuntime = {
		condition,
		observe(input) {
			const before = ledger.lastSeq();
			const o = ledger.record(input);
			if (
				ledger.lastSeq() > before &&
				tracksWork &&
				o.kind === "work.returned" &&
				o.workRef
			)
				ingestReturn(o);
			if (ledger.lastSeq() > before) {
				failures = 0;
				quarantined = false;
			}
			return o;
		},
		runBackground(now, signal) {
			const requestedEpoch = epoch;
			return serial(async () => {
				const out: CallOutcome[] = [];
				if (!active()) return out;
				if (epoch !== requestedEpoch)
					return [
						makeOutcome("update", now, "rejected:stale_epoch", null, [
							"stale_epoch",
						]),
					];
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
			});
		},
		decide(opportunity, signal) {
			const requestedEpoch = epoch;
			const captured = structuredClone(opportunity);
			return serial(() =>
				epoch === requestedEpoch
					? decideInner(captured, signal)
					: Promise.resolve({
							decision: hostDecision(captured.id, "rejected", "stale_epoch", [
								"stale_epoch",
							]),
							calls: [],
						}),
			);
		},
		wake(now, host, signal) {
			return serial(async () => {
				expireStaleWork(now);
				const events: WakeEvent[] = ledger.all().flatMap((o): WakeEvent[] =>
					o.kind === "recall.offered"
						? [{ kind: o.kind, id: o.id, refs: o.refs ?? [] }]
						: o.kind === "work.returned"
							? [{ kind: o.kind, id: o.id }]
							: o.kind === "external.event"
								? [
										{
											kind: o.kind,
											id: o.id,
											...(o.interestId ? { interestId: o.interestId } : {}),
										},
									]
								: o.kind === "fault.observed"
									? [{ kind: o.kind, id: o.id, code: o.code ?? "unknown" }]
									: [],
				);
				const r = wakeCheck(
					state,
					now,
					{
						enabled: active(),
						presence: host.presence,
						foregroundBusy: host.foregroundBusy,
						budgetOk: budget.check(now, true) === "ok",
						delegationRunning:
							(host.delegationRunning ?? false) ||
							state.intents.some((i) => !!i.workRef),
						idleDue: host.idleDue ?? false,
					},
					events,
					wakeFlags,
					wakeCfg,
				);
				// Activities whose intent closed are over.
				for (const i of state.intents)
					if (i.state === "completed" || i.state === "abandoned")
						activity.end(i.id);
				const out = { reasons: r.reasons, blocked: r.blocked };
				if (r.reasons.length === 0)
					return { ...out, decision: null, calls: [] };
				if (r.calls.select === 0) {
					// Return / fault: record it with one update and stop. No select.
					const batch = actionable(ledger.lastSeq()).slice(0, cfg.batchSize);
					const calls =
						batch.length > 0 || isDue(dueNow(now))
							? await runUpdate(now, signal, batch, dueNow(now))
							: [];
					const last = calls[calls.length - 1];
					if (!last || isApplied(last)) commitProcessedWake(r, now);
					return { ...out, decision: null, calls };
				}
				wakeCount += 1;
				const trigger = r.reasons.includes("review_due")
					? "review_due"
					: r.reasons.includes("recall")
						? "recall"
						: "idle";
				const res = await decideInner(
					{
						id: `wake${wakeCount}`,
						at: now,
						trigger,
						presence: host.presence,
						foregroundBusy: host.foregroundBusy,
						playerBusy: false,
						...(host.speechAllowed === undefined
							? {}
							: { speechAllowed: host.speechAllowed }),
					},
					signal,
					1,
				);
				if (res.decision.source !== "host_stale" && res.calls.every(isApplied))
					commitProcessedWake(r, now);
				return { ...out, ...res };
			});
		},
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
			const { observation } = applyReceipt(state, receipt, ticket, () => {
				let id: string;
				do {
					id = allocId(state, "h");
				} while (ledger.get(id));
				return id;
			});
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
			// A delegation that failed to start (e.g. host refusal) frees the work slot and ends the
			// activity: nothing will return, so its elapsed budget must not block a later retry (P4-b).
			if (receipt.status === "failed")
				for (const i of state.intents)
					if (i.workRef === receipt.ticketId) {
						i.workRef = null;
						i.workSince = null;
						activity.end(i.id);
					}
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
			if (enabled === value) return;
			enabled = value;
			if (!value) {
				epoch += 1;
				interruptLive(state);
				issued.clear();
			}
		},
		projection: (maxItems) =>
			buildProjection(
				active() ? condition : "B0",
				state,
				maxItems,
				ledger.all(),
			),
		snapshot: () => ({
			state: structuredClone(state),
			observations: structuredClone(ledger.all()),
			cursor: ledger.cursor(),
			condition,
			continuity: structuredClone({
				calls: budget.snapshot?.() ?? [],
				activities: activity.snapshot(),
				issued: [...issued.values()],
				receipts: [...receipts],
				topics: [...topicTickets],
				lastUsed: [...lastUsedAt],
				feelings: [...feelingByObs],
				failures,
				quarantined,
				diagnostics,
			}),
			scheduling: {
				review: [...flags.review],
				pressure: [...flags.pressure],
				wake: {
					review: [...wakeFlags.review],
					recall: [...wakeFlags.recall],
					events: [...wakeFlags.events],
					faultUntil: [...wakeFlags.faultUntil],
					perDay: [...wakeFlags.perDay],
				},
				wakeCount,
			},
		}),
	};
	if (!revTracker) return api;
	// P4-c: every state-changing entry point appends the items it changed.
	const sync = <T>(v: T, callId: string, at: number): T => {
		flushRevisions(callId, at);
		return v;
	};
	const later = async <T>(v: Promise<T>, callId: string, at: number) =>
		sync(await v, callId, at);
	return {
		...api,
		observe: (o) => sync(api.observe(o), "observe", o.occurredAt),
		runBackground: (now, signal) =>
			later(api.runBackground(now, signal), "update", now),
		decide: (opp, signal) => later(api.decide(opp, signal), "select", opp.at),
		wake: (now, host, signal) =>
			later(api.wake!(now, host, signal), "wake", now),
		recordResult: (r) => sync(api.recordResult(r), "receipt", r.at),
		invalidate: (reason, now) =>
			sync(api.invalidate(reason, now), "invalidate", now),
	};
};
