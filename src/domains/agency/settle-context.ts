import type {
	AgencyState,
	Condition,
	Limits,
	Observation,
	ToolCapability,
} from "../../contracts/model.ts";
import { allocId, type IdPrefix } from "./ids.ts";

/** Working state of one settle: everything here is discarded when it rejects. */
export interface SettleCtx {
	readonly condition: Condition;
	readonly next: AgencyState;
	/** Observations presented to the model in this call. */
	readonly obs: ReadonlyMap<string, Observation>;
	/**
	 * Highest seq of the batch being processed. Items created now get this as createdSeq/stateSeq,
	 * so "newer than the item" means seq > floorSeq. Observations after the batch (later ones shown
	 * only as context) do count as newer; observations in or before the batch never do.
	 */
	readonly floorSeq: number;
	/** Lowest seq of the batch (floorSeq + 1 when the update has no batch). */
	readonly batchStartSeq: number;
	readonly tools: readonly ToolCapability[];
	readonly limits: Limits;
	readonly now: number;
	readonly codes: string[];
	readonly touched: Set<string>;
	/** localId -> assigned id. */
	readonly local: Map<string, string>;
	/** localIds whose op was rejected; dependants skip silently. */
	readonly failed: Set<string>;
	/** Candidates closed by a goal-terminal cascade in this proposal -> revision the model saw. */
	readonly cascaded: Map<string, number>;
}

export const reject = (ctx: SettleCtx, code: string) => {
	if (!ctx.codes.includes(code)) ctx.codes.push(code);
};

/** Every ref must be an observation presented in this call. */
export const evidenceOk = (
	ctx: SettleCtx,
	refs: readonly string[],
): boolean => {
	let ok = true;
	for (const r of refs)
		if (!ctx.obs.has(r)) {
			reject(ctx, "unknown_ref");
			ok = false;
		}
	return ok;
};

/**
 * Evidence that is not the agent's own doing: not an agent actor, not a delivery
 * record, and not a host receipt caused by one of the agent's own candidates or
 * attempts. Tool results (actor tool) always count.
 */
export const isIndependent = (ctx: SettleCtx, o: Observation): boolean => {
	if (o.actor === "agent" || o.kind === "delivery.observed") return false;
	// A tool's own result is the world's response, even to the agent's own attempt.
	if (o.actor === "tool" && o.kind === "action.observed") return true;
	const c = o.causationId;
	if (c === undefined) return true;
	return !(
		ctx.next.candidates.some((x) => x.id === c) ||
		ctx.next.attempts.some((x) => x.id === c)
	);
};

/** At least one cited observation that arrived after `floor`. */
export const hasNewerThan = (
	ctx: SettleCtx,
	refs: readonly string[],
	floor: number,
): boolean => refs.some((r) => (ctx.obs.get(r)?.seq ?? 0) > floor);

export const assignLocal = (
	ctx: SettleCtx,
	localId: string,
	prefix: IdPrefix,
) => {
	ctx.local.set(localId, allocId(ctx.next, prefix));
};

/**
 * Resolves a ref to an item id: a localId of this proposal or an existing id of
 * the expected collection. Unresolved refs reject; refs to a failed op skip.
 */
export const resolveRef = (
	ctx: SettleCtx,
	ref: string,
	prefix: IdPrefix,
	exists: (id: string) => boolean,
): string | null => {
	if (ctx.failed.has(ref)) return null;
	const id = ctx.local.get(ref);
	if (id !== undefined) {
		if (id.startsWith(prefix)) return id;
		reject(ctx, "unresolved_ref");
		return null;
	}
	if (exists(ref)) return ref;
	reject(ctx, "unresolved_ref");
	return null;
};

export const hoursToMs = (hours: number) => hours * 3_600_000;
