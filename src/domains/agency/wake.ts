/**
 * Wake reasons (plan §5.3). Pure, no LLM: given the state, the clock and host events,
 * returns why the agent may wake and how many model calls that wake may use
 * (at most update 1 + select 1; a returned work item gets update only).
 * Each event fires once; the caller commits the returned keys after the calls succeed,
 * like `DueFlags` in due.ts.
 */
import type { AgencyState } from "../../contracts/model.ts";
import { isOpenIntent } from "../../contracts/model.ts";

export const wakeReasons = [
	"review_due",
	"recall",
	"work_returned",
	"external_event",
	"fault",
	"idle",
] as const;
export type WakeReason = (typeof wakeReasons)[number];

export type WakeEvent =
	| {
			readonly kind: "recall.offered";
			readonly id: string;
			/** `interest:<id>` / `intent:<id>` refs the recalled memory touches. */
			readonly refs: readonly string[];
	  }
	| { readonly kind: "work.returned"; readonly id: string }
	| {
			readonly kind: "external.event";
			readonly id: string;
			readonly interestId?: string;
	  }
	| {
			readonly kind: "fault.observed";
			readonly id: string;
			readonly code: string;
	  };

export type WakeBlock =
	| "host_disabled"
	| "speaking"
	| "foreground_busy"
	| "budget_exhausted"
	| "delegation_running"
	| "daily_limit"
	| "cooldown"
	| "not_open"
	| "fired_once";

export interface WakeConfig {
	/** Same interest is not woken again within this many hours of its last activity. */
	readonly activityCooldownHours: number;
	/** Autonomous wakes (recall / external_event) per local day. */
	readonly dailyLimit: number;
	/** Same fault code wakes at most once in this window. */
	readonly faultQuietMs: number;
	/** Day key for the daily limit (host's local day; default JST, UTC+9). */
	readonly dayOf: (now: number) => string;
}

export const defaultWakeConfig: WakeConfig = {
	activityCooldownHours: 12,
	dailyLimit: 3,
	faultQuietMs: 6 * 3_600_000,
	dayOf: (now) => String(Math.floor((now + 9 * 3_600_000) / 86_400_000)),
};

export interface WakeHost {
	readonly enabled: boolean;
	readonly presence: "quiet" | "speaking" | "unknown";
	readonly foregroundBusy: boolean;
	readonly budgetOk: boolean;
	readonly delegationRunning: boolean;
	/** Existing idle planner says a lull opportunity is due. */
	readonly idleDue: boolean;
}

/** What already fired. Mutated only by `commitWake`. */
export interface WakeFlags {
	readonly review: Set<string>;
	readonly recall: Set<string>;
	readonly events: Set<string>;
	readonly faultUntil: Map<string, number>;
	readonly perDay: Map<string, number>;
}
export const createWakeFlags = (): WakeFlags => ({
	review: new Set(),
	recall: new Set(),
	events: new Set(),
	faultUntil: new Map(),
	perDay: new Map(),
});

export interface WakeResult {
	readonly reasons: readonly WakeReason[];
	readonly blocked: readonly {
		readonly reason: WakeReason | "all";
		readonly code: WakeBlock;
	}[];
	/** Model calls this wake may use. */
	readonly calls: { readonly update: 0 | 1; readonly select: 0 | 1 };
	/** Keys to commit once the calls succeeded. */
	readonly keys: {
		readonly review: readonly string[];
		readonly recall: readonly string[];
		readonly events: readonly string[];
		readonly faults: readonly string[];
		readonly autonomous: number;
	};
}

const HOUR = 3_600_000;
const none: WakeResult["keys"] = {
	review: [],
	recall: [],
	events: [],
	faults: [],
	autonomous: 0,
};

const cooling = (
	state: AgencyState,
	interestId: string,
	now: number,
	cfg: WakeConfig,
) => {
	const i = state.interests?.find((x) => x.id === interestId);
	return (
		i !== undefined &&
		i.lastEngagedAt !== null &&
		now - i.lastEngagedAt < cfg.activityCooldownHours * HOUR
	);
};

const openRef = (state: AgencyState, ref: string) => {
	if (ref.startsWith("interest:")) {
		const i = state.interests?.find((x) => x.id === ref.slice(9));
		return i !== undefined && i.status !== "faded";
	}
	if (ref.startsWith("intent:")) {
		const i = state.intents.find((x) => x.id === ref.slice(7));
		return i !== undefined && i.state === "held";
	}
	return false;
};

export const wake = (
	state: AgencyState,
	now: number,
	host: WakeHost,
	events: readonly WakeEvent[],
	flags: WakeFlags,
	cfg: WakeConfig = defaultWakeConfig,
): WakeResult => {
	const gate: WakeBlock | null = !host.enabled
		? "host_disabled"
		: host.presence === "speaking"
			? "speaking"
			: host.foregroundBusy
				? "foreground_busy"
				: !host.budgetOk
					? "budget_exhausted"
					: null;
	if (gate)
		return {
			reasons: [],
			blocked: [{ reason: "all", code: gate }],
			calls: { update: 0, select: 0 },
			keys: none,
		};

	const reasons = new Set<WakeReason>();
	const blocked: { reason: WakeReason; code: WakeBlock }[] = [];
	const review: string[] = [];
	const recall: string[] = [];
	const evs: string[] = [];
	const faults: string[] = [];
	const day = cfg.dayOf(now);
	let autonomous = 0;
	const dayLeft = () =>
		cfg.dailyLimit - (flags.perDay.get(day) ?? 0) - autonomous > 0;

	for (const i of state.intents) {
		if (!isOpenIntent(i) || i.reviewAt > now) continue;
		const k = `${i.id}@${i.reviewAt}`;
		if (flags.review.has(k)) continue;
		review.push(k);
		reasons.add("review_due");
	}

	for (const e of events) {
		if (flags.events.has(e.id)) {
			continue;
		}
		if (e.kind === "work.returned") {
			evs.push(e.id);
			reasons.add("work_returned");
			continue;
		}
		if (e.kind === "fault.observed") {
			evs.push(e.id);
			if (
				(flags.faultUntil.get(e.code) ?? -Infinity) > now ||
				faults.includes(e.code)
			) {
				blocked.push({ reason: "fault", code: "fired_once" });
				continue;
			}
			faults.push(e.code);
			reasons.add("fault");
			continue;
		}
		const reason: WakeReason =
			e.kind === "recall.offered" ? "recall" : "external_event";
		if (host.delegationRunning) {
			blocked.push({ reason, code: "delegation_running" });
			continue;
		}
		// Cooldown / daily-limit blocks defer the event (not consumed), so whether it fires
		// later never depends on another reason happening to commit this wake.
		if (e.kind === "recall.offered") {
			if (flags.recall.has(e.id)) {
				evs.push(e.id);
				blocked.push({ reason, code: "fired_once" });
				continue;
			}
			const open = e.refs.filter((r) => openRef(state, r));
			if (open.length === 0) {
				evs.push(e.id);
				blocked.push({ reason, code: "not_open" });
				continue;
			}
			const warm = open.filter(
				(r) =>
					!(r.startsWith("interest:") && cooling(state, r.slice(9), now, cfg)),
			);
			if (warm.length === 0) {
				blocked.push({ reason, code: "cooldown" });
				continue;
			}
			if (!dayLeft()) {
				blocked.push({ reason, code: "daily_limit" });
				continue;
			}
			evs.push(e.id);
			recall.push(e.id);
			autonomous += 1;
			reasons.add("recall");
			continue;
		}
		if (e.interestId && cooling(state, e.interestId, now, cfg)) {
			blocked.push({ reason, code: "cooldown" });
			continue;
		}
		if (!dayLeft()) {
			blocked.push({ reason, code: "daily_limit" });
			continue;
		}
		evs.push(e.id);
		autonomous += 1;
		reasons.add("external_event");
	}

	if (host.idleDue) {
		if (host.delegationRunning)
			blocked.push({ reason: "idle", code: "delegation_running" });
		else reasons.add("idle");
	}

	const list = wakeReasons.filter((r) => reasons.has(r));
	// A work return defers selection to the next opportunity, even when other
	// reasons (e.g. review_due) coincide: the return is reported first.
	const selecting =
		!reasons.has("work_returned") &&
		list.some((r) => r !== "work_returned" && r !== "fault");
	return {
		reasons: list,
		blocked,
		calls: { update: list.length > 0 ? 1 : 0, select: selecting ? 1 : 0 },
		keys: { review, recall, events: evs, faults, autonomous },
	};
};

/** Call after the wake's model calls succeeded; a failed wake stays due. */
export const commitWake = (
	r: WakeResult,
	flags: WakeFlags,
	now: number,
	cfg: WakeConfig = defaultWakeConfig,
) => {
	for (const k of r.keys.review) flags.review.add(k);
	for (const k of r.keys.recall) flags.recall.add(k);
	for (const k of r.keys.events) flags.events.add(k);
	for (const c of r.keys.faults)
		flags.faultUntil.set(c, now + cfg.faultQuietMs);
	if (r.keys.autonomous > 0) {
		const day = cfg.dayOf(now);
		flags.perDay.set(day, (flags.perDay.get(day) ?? 0) + r.keys.autonomous);
	}
};
