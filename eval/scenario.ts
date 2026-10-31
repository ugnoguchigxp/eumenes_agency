/**
 * H6: scripted event replayer on a virtual clock (H5). Feeds timed user turns, recalls,
 * work returns, external events, faults and silent ticks to a runtime, calls `wake` at
 * each step, and writes one H2 trace row per step (wake reasons → decision → ticket
 * origin/tts → model calls). No real time; the LLM port is whatever the caller passes.
 */
import type {
	ActionTicket,
	AgencyRuntime,
	WakeHostInput,
} from "../src/contracts/runtime.ts";
import type { ObservationInput } from "../src/contracts/model.ts";
import { virtualClock } from "./virtual-clock.ts";

export type ScriptEvent =
	| {
			readonly at: number;
			readonly kind: "user";
			readonly id: string;
			readonly text: string;
	  }
	| {
			readonly at: number;
			readonly kind: "recall";
			readonly id: string;
			readonly text: string;
			readonly refs: readonly string[];
			/** Host-side memory index: also ref open interests / held intents whose text matches. */
			readonly match?: RegExp;
	  }
	| {
			readonly at: number;
			readonly kind: "returned";
			readonly id: string;
			readonly text: string;
			readonly workStatus?: import("../src/contracts/model.ts").WorkStatus;
			/** H10 (P4-a): return the n-th (1-based; -1 = latest) `delegate` ticket issued so far; skipped when absent. */
			readonly delegateSeq?: number;
	  }
	| {
			readonly at: number;
			readonly kind: "external";
			readonly id: string;
			readonly text: string;
			readonly interestId?: string;
	  }
	| {
			readonly at: number;
			readonly kind: "fault";
			readonly id: string;
			readonly text: string;
			readonly code: string;
	  }
	/** No event: just a wake check (silence, idle). */
	| { readonly at: number; readonly kind: "tick"; readonly idleDue?: boolean }
	/** Host presence change from this time on. */
	| {
			readonly at: number;
			readonly kind: "presence";
			readonly host: Partial<WakeHostInput>;
	  };

export interface TraceRow {
	readonly at: number;
	readonly event: string;
	readonly reasons: readonly string[];
	readonly blocked: readonly string[];
	readonly action: string | null;
	readonly source: string | null;
	readonly origin: string | null;
	readonly tts: boolean | null;
	readonly updates: number;
	readonly selects: number;
	/** Ticket text (utterance or tool input), for topic scoring. */
	readonly text?: string | null;
	readonly toolName?: string;
}

const toObservation = (e: ScriptEvent): ObservationInput | null => {
	switch (e.kind) {
		case "user":
			return {
				id: e.id,
				kind: "user.report",
				actor: "user",
				occurredAt: e.at,
				text: e.text,
			};
		case "recall":
			return {
				id: e.id,
				kind: "recall.offered",
				actor: "host",
				occurredAt: e.at,
				text: e.text,
				refs: e.refs,
			};
		case "returned":
			return {
				id: e.id,
				kind: "work.returned",
				actor: "tool",
				occurredAt: e.at,
				text: e.text,
			};
		case "external":
			return {
				id: e.id,
				kind: "external.event",
				actor: "host",
				occurredAt: e.at,
				text: e.text,
				...(e.interestId ? { interestId: e.interestId } : {}),
			};
		case "fault":
			return {
				id: e.id,
				kind: "fault.observed",
				actor: "host",
				occurredAt: e.at,
				text: e.text,
				code: e.code,
			};
		default:
			return null;
	}
};

export const replayScript = async (
	rt: AgencyRuntime,
	script: readonly ScriptEvent[],
	opts: {
		readonly start?: number;
		/** Called after each ticket; the host's receipt (default: succeeded immediately). */
		readonly onTicket?: (
			ticketId: string,
			at: number,
			ticket: ActionTicket,
		) => void;
		/** P4-b: host-side work before each wake (interrupt running units, drain returns into observations). */
		readonly beforeWake?: (
			at: number,
			host: WakeHostInput,
		) => readonly ObservationInput[];
	} = {},
): Promise<TraceRow[]> => {
	if (!rt.wake) throw new Error("runtime has no wake()");
	const sorted = [...script].sort((a, b) => a.at - b.at);
	const clock = virtualClock(opts.start ?? sorted[0]?.at ?? 0);
	let host: WakeHostInput = { presence: "quiet", foregroundBusy: false };
	const rows: TraceRow[] = [];
	const delegates: string[] = [];
	for (const e of sorted) {
		clock.set(Math.max(clock.now(), e.at));
		if (e.kind === "presence") {
			host = { ...host, ...e.host };
			continue;
		}
		let o = toObservation(e);
		if (o && e.kind === "returned" && e.delegateSeq !== undefined) {
			const ref =
				e.delegateSeq < 0
					? delegates[delegates.length + e.delegateSeq]
					: delegates[e.delegateSeq - 1];
			if (!ref) {
				rows.push({
					at: clock.now(),
					event: `returned:${e.id}`,
					reasons: [],
					blocked: ["unbound:no_delegation"],
					action: null,
					source: null,
					origin: null,
					tts: null,
					updates: 0,
					selects: 0,
					text: null,
				});
				continue;
			}
			o = {
				...o,
				workRef: ref,
				workStatus: e.workStatus ?? "succeeded",
			} as ObservationInput;
		}
		if (o && e.kind === "recall" && e.match) {
			const st = rt.snapshot().state as any;
			const re = e.match;
			const found = [
				...(st.interests ?? [])
					.filter((k: any) => k.status !== "faded" && re.test(k.topic ?? ""))
					.map((k: any) => `interest:${k.id}`),
				...st.intents
					.filter(
						(i: any) => i.state === "held" && re.test(i.desiredState ?? ""),
					)
					.map((i: any) => `intent:${i.id}`),
			];
			o = { ...o, refs: [...e.refs, ...found] } as ObservationInput;
		}
		if (o) rt.observe(o);
		if (opts.beforeWake)
			for (const x of opts.beforeWake(clock.now(), host)) rt.observe(x);
		const w = await rt.wake(
			clock.now(),
			{ ...host, idleDue: e.kind === "tick" ? (e.idleDue ?? false) : false },
			new AbortController().signal,
		);
		const t = w.decision?.ticket ?? null;
		if (t?.action === "tool" && t.toolName === "delegate") delegates.push(t.id);
		if (t) {
			if (opts.onTicket) opts.onTicket(t.id, clock.now(), t);
			else
				rt.recordResult({
					ticketId: t.id,
					status: "succeeded",
					at: clock.now(),
					resultText: t.utterance ?? "",
				});
		}
		rows.push({
			at: clock.now(),
			event: e.kind === "tick" ? "tick" : `${e.kind}:${e.id}`,
			reasons: w.reasons,
			blocked: w.blocked.map((b) => `${b.reason}:${b.code}`),
			action: w.decision?.action ?? null,
			source: w.decision?.source ?? null,
			origin: t?.origin ?? null,
			tts: t ? t.tts : null,
			updates: w.calls.filter((c) => c.purpose === "update").length,
			selects: w.calls.filter((c) => c.purpose === "select").length,
			text: t ? (t.utterance ?? t.toolInput) : null,
			...(t?.toolName ? { toolName: t.toolName } : {}),
		});
	}
	return rows;
};

/** H6 gate counts over trace rows (all must hold for P3-a). */
export const scenarioChecks = (rows: readonly TraceRow[]) => ({
	steps: rows.length,
	maxCallsPerWake: Math.max(0, ...rows.map((r) => r.updates + r.selects)),
	selectsAfterReturn: rows
		.filter((r) => r.event.startsWith("returned:"))
		.reduce((n, r) => n + r.selects, 0),
	ticketsWithoutOrigin: rows.filter(
		(r) =>
			r.action !== null &&
			r.origin === null &&
			(r.action === "speak" || r.action === "tool"),
	).length,
	autonomousTts: rows.filter((r) => r.origin === "autonomous" && r.tts === true)
		.length,
});
