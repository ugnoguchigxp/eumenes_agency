/**
 * The always-on agent (spec/always-on-agency-design-2026-11-07.md). The host feeds observations,
 * drives ticks with the heartbeat, executes and delivers tickets; each tick is one model call
 * that thinks and may choose one action. Code checks references, provenance, pacing, tool
 * permission and staleness; never the meaning.
 */
import type { Observation } from "../contracts/model.ts";
import type { LlmPort } from "../contracts/ports.ts";
import type { WithInput, InputContext } from "../contracts/memory.ts";
import { defaultBudget } from "../contracts/runtime.ts";
import type { Budget } from "../application/budget.ts";
import { callModel } from "../application/model-call.ts";
import {
	DEFAULT_MUTE_MIN,
	PREPARING_TTL_MS,
	defaultSpeechIntervalSec,
	emptyAlwaysOnState,
	OBSERVATIONS_KEPT,
	speechIntervals,
	THOUGHTS_KEPT,
	thinkSchema,
	type AlwaysOnInterest,
	type AlwaysOnObservationInput,
	type AlwaysOnReceipt,
	type AlwaysOnSnapshot,
	type AlwaysOnState,
	type AlwaysOnTicket,
	type AlwaysOnTool,
	type AlwaysOnWorkReturn,
	type KnowledgeGap,
	type PaceOp,
	type Preparing,
	type SpeechIntervalSec,
	type StockItem,
	type ThinkOutput,
	type Thought,
	type TickHost,
	type TickOutcome,
	type UserFact,
} from "./contracts.ts";
import { prepareGate, speechGate } from "./pacing.ts";
import { alwaysOnSystem, thinkData } from "./prompt.ts";
import { applyUserOps } from "./user-model.ts";
import { addFinding, applyStockOps, dropOrphans, pruneStock } from "./stock.ts";
import { forgetDerived } from "./forgetting.ts";

/** No budget gate (spec §3.9): the heartbeat alone sets the frequency. */
const unlimited: Budget = {
	config: defaultBudget,
	remaining: () => Number.MAX_SAFE_INTEGER,
	check: () => "ok",
	record: () => undefined,
};

export interface AlwaysOnDeps {
	readonly llm: LlmPort;
	/** Host-owned instructions for the think call; default: the built-in ones. */
	readonly system?: () => WithInput<string>;
	/** The persona's own interests (e.g. a favourite character), cited as `interest:<id>`. */
	readonly interests?: readonly AlwaysOnInterest[];
	/**
	 * What the host's memory already knows about the user, read at each tick (e.g. Eumenes' State
	 * items). Shown read-only, cited as `memory:<id>`; forgetting that ref drops what came from it.
	 */
	readonly known?: () => readonly AlwaysOnInterest[];
	/** Tools the host can run for preparation. Only read/create without approval are usable. */
	readonly tools?: readonly AlwaysOnTool[];
	readonly speechIntervalSec?: SpeechIntervalSec;
	/** Local time as the user would say it (the core has no clock or time zone). */
	readonly clock?: (now: number) => string;
	readonly maxOutputTokens?: number;
	readonly restore?: AlwaysOnSnapshot;
}

export interface AlwaysOnView {
	readonly thoughts: readonly Thought[];
	readonly facts: readonly UserFact[];
	readonly gaps: readonly KnowledgeGap[];
	readonly stock: readonly StockItem[];
	readonly preparing: readonly Preparing[];
	readonly pacing: AlwaysOnState["pacing"];
	readonly observations: number;
}

export interface AlwaysOnAgent {
	observe(input: AlwaysOnObservationInput, context?: InputContext): Observation;
	/** One heartbeat tick: at most one model call. `host` is read again before acting. */
	tick(
		now: number,
		host: () => TickHost,
		signal: AbortSignal,
	): Promise<TickOutcome>;
	/** The host's delivery result for a ticket. Delivered speech becomes an observation. */
	recordResult(
		receipt: AlwaysOnReceipt,
		deliveredTicket?: AlwaysOnTicket,
	): Observation | null;
	/** A preparation came back: its result becomes an observation and a finding. */
	workReturned(result: AlwaysOnWorkReturn): Observation | null;
	/**
	 * The user asked for a preparation during the normal reply (the reply's tool). It rests on the
	 * user's latest words; the same tool rules apply. The host runs the ticket as usual.
	 */
	requestPrepare(request: {
		readonly toolName: string;
		readonly toolInput: string;
		readonly at: number;
		readonly observationId?: string;
		readonly input?: InputContext;
	}): { readonly ticket: AlwaysOnTicket } | { readonly rejected: string };
	/** New user input or a host change: a tick in flight may still think but not act. */
	invalidate(): void;
	/** User/host controls (not model decisions). */
	mute(until: number | null): void;
	setStopped(stopped: boolean): void;
	/** Drops the observations and everything derived from them. */
	forget(refs: readonly string[]): void;
	view(): AlwaysOnView;
	snapshot(): AlwaysOnSnapshot;
}

/** After the agent spoke, the user gets this long to answer before it asks anything more. */
const QUESTION_GAP_MS = 60_000;

/** Text compared for literal repeats: whitespace and punctuation do not make a sentence new. */
const normalize = (text: string) =>
	text.replace(/[\s、。，．,.!?！？…・「」『』（）()〜~ー-]/gu, "");

const autonomous = (t: AlwaysOnTool) =>
	!t.requiresApproval && (t.effect === "read" || t.effect === "create");

export function createAlwaysOnAgent(deps: AlwaysOnDeps): AlwaysOnAgent {
	const intervalSec = deps.speechIntervalSec ?? defaultSpeechIntervalSec;
	if (!speechIntervals.includes(intervalSec))
		throw new RangeError("invalid speech interval");
	const intervalMs = intervalSec * 1000;
	const restore = deps.restore;
	if (restore && restore.version !== 1)
		throw new RangeError("unsupported always-on snapshot");
	// Snapshots from earlier stages restore with the newer parts empty.
	let state: AlwaysOnState = restore
		? {
				...emptyAlwaysOnState(),
				...structuredClone(restore.state),
				pacing: {
					...emptyAlwaysOnState().pacing,
					...structuredClone(restore.state.pacing),
				},
			}
		: emptyAlwaysOnState();
	let observations: Observation[] = restore
		? structuredClone([...restore.observations])
		: [];
	const observationInputs = new Map(restore?.observationInputs ?? []);
	if (deps.known) {
		state.facts = state.facts.filter((f) => f.basis === "hypothesis");
		dropOrphans(state);
	}
	const forgotten = new Set(restore?.forgotten ?? []);
	let seq = restore?.seq ?? 0;
	let epoch = 0;
	const issued = new Map<string, AlwaysOnTicket>();
	const interests = (deps.interests ?? []).filter(
		(x) => x.id !== "" && x.text.trim() !== "",
	);
	const tools = structuredClone([...(deps.tools ?? [])]);
	const nextId = (prefix: string) => `${prefix}${state.nextId++}`;

	const append = (o: Observation) => {
		observations.push(o);
		if (observations.length > OBSERVATIONS_KEPT)
			observations = observations.slice(-OBSERVATIONS_KEPT);
		const retained = new Set(observations.map((x) => x.id));
		for (const id of observationInputs.keys())
			if (!retained.has(id)) observationInputs.delete(id);
	};

	const interestRefs = new Set(interests.map((x) => `interest:${x.id}`));
	const knownRefs = (shown: readonly string[], extra: readonly string[]) =>
		new Set([
			...shown,
			...extra,
			...interestRefs,
			...state.facts.map((f) => `fact:${f.id}`),
			...state.gaps.map((g) => `gap:${g.id}`),
			...state.stock.map((s) => `stock:${s.id}`),
		]);

	/** The user's wish about pacing, read by the model from new user words. */
	const applyPace = (
		pace: PaceOp,
		at: number,
		fromNewUser: (refs: readonly string[]) => boolean,
	): { applied: string[]; rejected: string[] } => {
		if (pace.op === "none") return { applied: [], rejected: [] };
		if (!fromNewUser(pace.evidenceRefs))
			return { applied: [], rejected: [`${pace.op}:needs_user_evidence`] };
		const until = at + (pace.minutes ?? DEFAULT_MUTE_MIN) * 60_000;
		if (pace.op === "unmute") {
			state.pacing.muteUntil = null;
			state.pacing.prepareMuteUntil = null;
		} else {
			if (pace.op !== "mute_prepare") state.pacing.muteUntil = until;
			if (pace.op !== "mute_speech") state.pacing.prepareMuteUntil = until;
		}
		return {
			applied: [
				pace.op === "unmute"
					? "unmute"
					: `${pace.op} ${pace.minutes ?? DEFAULT_MUTE_MIN}`,
			],
			rejected: [],
		};
	};

	const settle = (
		out: ThinkOutput,
		at: number,
		tickId: string,
		shown: readonly string[],
		inputs: readonly string[],
		memoryRefs: readonly string[],
		host: TickHost,
		stale: boolean,
	): {
		thought: Thought;
		ticket: AlwaysOnTicket | null;
		applied: string[];
		rejected: string[];
	} => {
		// What was learned from the shown observations is kept even when the action is stale.
		const shownObs = new Map(
			observations.filter((o) => shown.includes(o.id)).map((o) => [o.id, o]),
		);
		const seenSeq = state.seenSeq;
		const fromNewUser = (refs: readonly string[]) =>
			refs.some((r) => {
				const o = shownObs.get(r);
				return o?.actor === "user" && o.seq > seenSeq;
			});
		const user = applyUserOps(state, out.userOps, {
			hostOwnsFacts: deps.known !== undefined,
			at,
			shown: shownObs,
			extraRefs: new Set([...interestRefs, ...memoryRefs]),
			seenSeq,
			inputs,
			nextId,
		});
		const known = knownRefs(shown, memoryRefs);
		const stock = applyStockOps(state, out.stockOps, {
			at,
			known: (r) => known.has(r),
			nextId,
			inputs,
		});
		const pace = applyPace(out.pace, at, fromNewUser);
		// A retracted fact takes what was prepared for it along.
		const orphans = dropOrphans(state);
		const applied = [
			...user.applied,
			...stock.applied,
			...orphans,
			...pace.applied,
		];
		const rejected = [...user.rejected, ...stock.rejected, ...pace.rejected];
		const thought: Thought = {
			id: nextId("th"),
			at,
			text: out.thought,
			drive: out.drive,
			inputs: [...inputs],
		};
		state.thoughts.push(thought);
		if (state.thoughts.length > THOUGHTS_KEPT)
			state.thoughts = state.thoughts.slice(-THOUGHTS_KEPT);
		state.seenSeq = Math.max(
			state.seenSeq,
			...[...shownObs.values()].map((o) => o.seq),
		);
		const a = out.action;
		if (a.kind === "wait") return { thought, ticket: null, applied, rejected };
		const before = rejected.length;
		const refuse = (code: string) => rejected.push(code);
		const refs = [...new Set(a.evidenceRefs)];
		const knownNow = knownRefs(shown, memoryRefs);
		// A thought may outlive new input; an action may not.
		if (stale) refuse("stale");
		if (refs.some((r) => !knownNow.has(r))) refuse("unknown_ref");
		if (a.kind === "prepare") {
			const tool = tools.find((t) => t.name === a.toolName);
			const input = a.toolInput?.trim() ?? "";
			if (!tool) refuse("unknown_tool");
			else if (!autonomous(tool)) refuse("tool_not_autonomous");
			if (input === "") refuse("empty_input");
			// Preparation is for someone or something: it names what it is for.
			if (refs.length === 0) refuse("needs_reason");
			if (
				state.preparing.some(
					(p) => p.toolName === a.toolName && p.toolInput === input,
				)
			)
				refuse("duplicate_prepare");
			const gate = prepareGate(state.pacing, at);
			if (gate !== null) refuse(`prepare_${gate}`);
			if (rejected.length > before)
				return { thought, ticket: null, applied, rejected };
			const ticket: AlwaysOnTicket = {
				id: nextId("t"),
				tickId,
				action: "prepare",
				utterance: null,
				toolName: tool!.name,
				toolInput: input,
				drive: out.drive,
				evidenceRefs: refs,
				inputs: [...inputs],
				at,
			};
			issued.set(ticket.id, ticket);
			state.preparing.push({
				ticketId: ticket.id,
				toolName: tool!.name,
				toolInput: input,
				refs,
				inputs: [...inputs],
				at,
			});
			return { thought, ticket, applied, rejected };
		}
		const utterance = (a.utterance ?? "").trim();
		if (utterance === "") refuse("empty_utterance");
		// The same sentence again is never new: refused before it reaches the user (S8).
		const same = normalize(utterance);
		if (
			same !== "" &&
			observations.some(
				(o) =>
					o.actor === "agent" &&
					o.kind === "delivery.observed" &&
					normalize(o.text) === same,
			)
		)
			refuse("repeat");
		// One question at a time: an unanswered question is not followed by another, and a
		// question is not piled onto what the agent just said before the user could answer.
		const lastUserAt = Math.max(
			-1,
			...observations
				.filter((o) => o.actor === "user")
				.map((o) => o.occurredAt),
		);
		const lastAgentAt = state.pacing.lastAgentAt;
		if (
			a.kind === "ask" &&
			((state.pacing.lastOwnWasAsk && state.pacing.unanswered > 0) ||
				(lastAgentAt !== null &&
					at - lastAgentAt < QUESTION_GAP_MS &&
					lastUserAt <= lastAgentAt))
		)
			refuse("question_pending");
		const gate = speechGate(state.pacing, intervalMs, at, host.busy);
		if (!gate.allowed) refuse(`speech_${gate.block}`);
		if (rejected.length > before)
			return { thought, ticket: null, applied, rejected };
		const ticket: AlwaysOnTicket = {
			id: nextId("t"),
			tickId,
			action: a.kind,
			utterance,
			toolName: null,
			toolInput: null,
			drive: out.drive,
			evidenceRefs: refs,
			inputs: [...inputs],
			at,
		};
		issued.set(ticket.id, ticket);
		return { thought, ticket, applied, rejected };
	};

	/** The next end of a quiet period still ahead. */
	const wakeAt = (now: number): number | null => {
		const ends = [state.pacing.muteUntil, state.pacing.prepareMuteUntil].filter(
			(t): t is number => t !== null && t > now,
		);
		// Just past the end, so the tick already sees the quiet period as over.
		return ends.length ? Math.min(...ends) + 1000 : null;
	};

	const agent: AlwaysOnAgent = {
		observe(input, context) {
			const id = input.id ?? nextId("o");
			if (forgotten.has(id))
				throw new RangeError(`observation ${id} was forgotten`);
			const existing = observations.find((o) => o.id === id);
			if (existing) return existing;
			const refs = [
				...new Set([...(input.refs ?? []), ...(context?.sources ?? [])]),
			];
			if (refs.some((r) => forgotten.has(r)))
				throw new RangeError("forgotten observation input");
			const o: Observation = {
				...structuredClone(input),
				...(refs.length ? { refs } : {}),
				id,
				seq: ++seq,
			};
			observationInputs.set(
				id,
				structuredClone(context ?? { sources: [id, ...refs], complete: true }),
			);
			append(o);
			if (o.actor === "user") state.pacing.unanswered = 0;
			if (o.actor === "agent")
				state.pacing.lastAgentAt = Math.max(
					state.pacing.lastAgentAt ?? 0,
					o.occurredAt,
				);
			// A host can replay a verified delivery after restore without replaying the proposal.
			if (
				o.actor === "agent" &&
				o.kind === "delivery.observed" &&
				o.deliveryStatus === "succeeded"
			) {
				state.pacing.lastOwnAt = o.occurredAt;
				state.pacing.unanswered++;
				for (const g of state.gaps)
					if (o.refs?.includes(`gap:${g.id}`)) g.askedAt = o.occurredAt;
				for (const s of state.stock)
					if (o.refs?.includes(`stock:${s.id}`)) s.usedAt = o.occurredAt;
			}
			if (o.actor === "user" || o.actor === "tool") epoch++;
			return o;
		},

		async tick(now, host, signal) {
			const tickId = nextId("k");
			const base = {
				tickId,
				at: now,
				thought: null,
				chosen: null,
				applied: [],
				ticket: null,
				rejected: [],
				next: "normal" as const,
				wakeAt: null,
				call: null,
			};
			if (state.pacing.stopped) return { ...base, skipped: "stopped" };
			const before = host();
			if (before.busy) return { ...base, skipped: "busy" };
			pruneStock(state, now);
			const known = (deps.known?.() ?? []).filter(
				(x) => x.id !== "" && x.text.trim() !== "",
			);
			const memoryRefs = known.map((x) => `memory:${x.id}`);
			// Host inputs (instructions, interests, tools, memory) are dependencies like observations.
			const system = deps.system
				? deps.system()
				: {
						value: alwaysOnSystem(
							deps.known
								? {
										knowing:
											"利用者についての事実はuser.fromMemoryが正本です。自分ではstated/observedのfactsを記録しません。userOpsは仮説（hypothesis）と、知りたいこと（gap）の作業メモだけに使います。仮説は事実として扱わず、本人の訂正と拒否に従います。",
									}
								: {},
						),
						input: { sources: [], complete: true },
					};
			const hostInputs = [
				system.input,
				...interests.map((x) => x.input),
				...known.map((x) => x.input),
				...tools.map((t) => t.input),
			].filter((x) => x !== undefined);
			const hostSources = [
				...new Set([...hostInputs.flatMap((x) => x.sources), ...memoryRefs]),
			];
			if (hostSources.some((r) => forgotten.has(r)))
				return { ...base, skipped: "forgotten_input" };
			if (forgotten.size > 0 && hostInputs.some((x) => !x.complete))
				return { ...base, skipped: "incomplete_input" };
			// Tickets the host never answered are not kept forever.
			for (const [id, t] of issued)
				if (t.at + PREPARING_TTL_MS <= now) issued.delete(id);
			const startEpoch = epoch;
			const {
				prompt,
				shown,
				input: visibleInput,
			} = thinkData({
				observationInputs,
				now,
				clock: deps.clock ? deps.clock(now) : null,
				state,
				observations,
				interests,
				known,
				tools: tools.filter(autonomous),
				speech: speechGate(state.pacing, intervalMs, now, before.busy),
				prepare: prepareGate(state.pacing, now),
			});
			const inputs = [...new Set([...visibleInput.sources, ...hostSources])];
			if (inputs.some((r) => forgotten.has(r)))
				return { ...base, skipped: "forgotten_input" };
			if (forgotten.size > 0 && !visibleInput.complete)
				return { ...base, skipped: "incomplete_input" };
			const call = await callModel(
				deps.llm,
				unlimited,
				{
					purpose: "think",
					at: now,
					input: {
						sources: inputs,
						complete:
							visibleInput.complete && hostInputs.every((x) => x.complete),
					},
					system: system.value,
					prompt,
					schema: thinkSchema,
					maxOutputTokens: deps.maxOutputTokens ?? 1200,
				},
				signal,
			);
			if (!call.ok)
				return {
					...base,
					skipped: call.outcome.code === "aborted" ? "aborted" : "failed",
					call: call.outcome,
				};
			const outcome = {
				purpose: "think" as const,
				at: now,
				code: "applied",
				model: call.usage.model,
				inputTokens: call.usage.inputTokens,
				outputTokens: call.usage.outputTokens,
				latencyMs: call.usage.latencyMs,
				rejectCodes: [],
			};
			// Forgotten while the call was out: nothing from it is kept.
			if (signal.aborted || inputs.some((id) => forgotten.has(id)))
				return { ...base, skipped: "aborted", call: outcome };
			const settled = settle(
				call.value,
				now,
				tickId,
				shown,
				inputs,
				memoryRefs,
				host(),
				epoch !== startEpoch || signal.aborted,
			);
			return {
				tickId,
				at: now,
				skipped: null,
				thought: settled.thought,
				chosen: call.value.action.kind,
				ticket: settled.ticket,
				applied: settled.applied,
				rejected: settled.rejected,
				next: call.value.next,
				wakeAt: wakeAt(now),
				call: { ...outcome, rejectCodes: settled.rejected },
			};
		},

		recordResult(receipt, deliveredTicket) {
			// After restore the host may reconcile a persisted ticket with a real, identified delivery.
			const recovered =
				receipt.status === "succeeded" &&
				receipt.observationId &&
				deliveredTicket?.action !== "prepare" &&
				deliveredTicket?.id === receipt.ticketId
					? deliveredTicket
					: undefined;
			const ticket = issued.get(receipt.ticketId) ?? recovered;
			if (!ticket) return null;
			issued.delete(receipt.ticketId);
			if (
				[...ticket.inputs, ...ticket.evidenceRefs].some((r) =>
					forgotten.has(r),
				) ||
				ticket.at + PREPARING_TTL_MS <= receipt.at
			)
				return null;
			if (ticket.action === "prepare") {
				// Accepted or unknown: it stays preparing until its result returns or it expires.
				if (receipt.status !== "failed") return null;
				state.preparing = state.preparing.filter(
					(p) => p.ticketId !== ticket.id,
				);
				return agent.observe({
					kind: "action.observed",
					actor: "host",
					occurredAt: receipt.at,
					text: `準備を始められなかった（${ticket.toolName}）`,
					causationId: ticket.id,
					refs: [...ticket.evidenceRefs, ...ticket.inputs],
				});
			}
			if (receipt.status !== "succeeded") return null;
			const o = agent.observe({
				...(receipt.observationId ? { id: receipt.observationId } : {}),
				kind: "delivery.observed",
				actor: "agent",
				occurredAt: receipt.at,
				text: receipt.text ?? ticket.utterance ?? "",
				causationId: ticket.id,
				deliveryStatus: "succeeded",
				// What it said rests on what it cited and was shown: forgetting follows it here.
				refs: [...ticket.evidenceRefs, ...ticket.inputs],
			});
			state.pacing.lastOwnWasAsk = ticket.action === "ask";
			return o;
		},

		requestPrepare(request) {
			if (state.pacing.stopped) return { rejected: "stopped" };
			const tool = tools.find((t) => t.name === request.toolName);
			if (!tool) return { rejected: "unknown_tool" };
			if (!autonomous(tool)) return { rejected: "tool_not_autonomous" };
			const input = request.toolInput.trim();
			if (input === "") return { rejected: "empty_input" };
			const asked = [...observations].reverse().find((o) => o.actor === "user");
			if (!asked) return { rejected: "needs_user_request" };
			if (request.observationId && request.observationId !== asked.id)
				return { rejected: "stale_user_request" };
			const requestedInput = [
				observationInputs.get(asked.id) ?? {
					sources: [asked.id],
					complete: true,
				},
				tool.input ?? { sources: [], complete: true },
				request.input ?? { sources: [], complete: true },
			];
			const sources = [
				...new Set([asked.id, ...requestedInput.flatMap((x) => x.sources)]),
			];
			if (
				sources.some((r) => forgotten.has(r)) ||
				(forgotten.size > 0 && requestedInput.some((x) => !x.complete))
			)
				return { rejected: "forgotten_input" };
			if (
				state.preparing.some(
					(p) => p.toolName === tool.name && p.toolInput === input,
				)
			)
				return { rejected: "duplicate_prepare" };
			const ticket: AlwaysOnTicket = {
				id: nextId("t"),
				tickId: "reply",
				action: "prepare",
				utterance: null,
				toolName: tool.name,
				toolInput: input,
				drive: "care",
				evidenceRefs: [asked.id],
				inputs: sources,
				at: request.at,
			};
			issued.set(ticket.id, ticket);
			state.preparing.push({
				ticketId: ticket.id,
				toolName: tool.name,
				toolInput: input,
				refs: [asked.id],
				inputs: sources,
				at: request.at,
				requested: true,
			});
			return { ticket };
		},

		workReturned(result) {
			const job = state.preparing.find((p) => p.ticketId === result.ticketId);
			if (!job) return null;
			issued.delete(job.ticketId);
			state.preparing = state.preparing.filter((p) => p !== job);
			if (
				job.at + PREPARING_TTL_MS <= result.at ||
				[...job.refs, ...job.inputs].some((r) => forgotten.has(r))
			)
				return null;
			const o = agent.observe({
				kind: "work.returned",
				actor: "tool",
				occurredAt: result.at,
				text: result.summary,
				causationId: job.ticketId,
				workRef: job.ticketId,
				workStatus: result.status,
				refs: [...job.refs, ...(job.inputs ?? [])],
			});
			if (result.status !== "failed")
				addFinding(state, job, o.id, result.summary, result.at, nextId);
			return o;
		},

		invalidate() {
			epoch++;
		},

		mute(until) {
			if (until !== null && !Number.isFinite(until))
				throw new RangeError("mute needs a finite time or null");
			state.pacing.muteUntil = until;
		},

		setStopped(stopped) {
			state.pacing.stopped = stopped;
			epoch++;
		},

		forget(refs) {
			for (const r of refs) forgotten.add(r);
			const next = forgetDerived(state, observations, refs);
			observations = next.observations;
			for (const r of next.gone) forgotten.add(r);
			for (const [id, ticket] of issued)
				if (
					[...ticket.inputs, ...ticket.evidenceRefs].some((r) =>
						forgotten.has(r),
					)
				)
					issued.delete(id);
			for (const id of observationInputs.keys())
				if (forgotten.has(id)) observationInputs.delete(id);
			epoch++;
		},

		view: () => ({
			thoughts: structuredClone(state.thoughts),
			facts: structuredClone(state.facts),
			gaps: structuredClone(state.gaps),
			stock: structuredClone(state.stock),
			preparing: structuredClone(state.preparing),
			pacing: structuredClone(state.pacing),
			observations: observations.length,
		}),

		snapshot: () => ({
			version: 1,
			state: structuredClone(state),
			observations: structuredClone(observations),
			forgotten: [...forgotten],
			seq,
			observationInputs: structuredClone([...observationInputs]),
		}),
	};
	return agent;
}
