/**
 * The user model (spec §3.3): what the agent knows about the user and wants to know. The model
 * proposes changes; code checks only references and provenance: adding, rewriting or retracting
 * a stated/observed fact and closing a question all need user words this tick reads for the first
 * time. Guesses need no evidence but stay marked as guesses.
 */
import type { Observation } from "../contracts/model.ts";
import {
	ANSWERED_KEPT,
	DECLINED_KEPT,
	FACTS_LIMIT,
	OPEN_GAPS_LIMIT,
	type AlwaysOnState,
	type UserOp,
} from "./contracts.ts";

const bare = (id: string, prefix: string) =>
	id.startsWith(`${prefix}:`) ? id.slice(prefix.length + 1) : id;

export interface UserOpContext {
	readonly at: number;
	/** Observations shown to this tick, by id. */
	readonly shown: ReadonlyMap<string, Observation>;
	/** Other refs the tick may cite (e.g. `interest:i1`). */
	readonly extraRefs: ReadonlySet<string>;
	/** Observations with a higher seq are new to this tick (no earlier tick has read them). */
	readonly seenSeq: number;
	readonly nextId: (prefix: string) => string;
}

/** Applies each op independently; a refused op leaves state unchanged and adds a code. */
export function applyUserOps(
	state: AlwaysOnState,
	ops: readonly UserOp[],
	ctx: UserOpContext,
): { applied: string[]; rejected: string[] } {
	const applied: string[] = [];
	const rejected: string[] = [];
	const known = (r: string) =>
		ctx.shown.has(r) ||
		ctx.extraRefs.has(r) ||
		(r.startsWith("fact:") && state.facts.some((f) => `fact:${f.id}` === r)) ||
		(r.startsWith("gap:") && state.gaps.some((g) => `gap:${g.id}` === r));
	const fromUser = (refs: readonly string[]) =>
		refs.some((r) => ctx.shown.get(r)?.actor === "user");
	// Changes to what the user said rest on words this tick reads first: re-reading is not learning.
	const fromNewUser = (refs: readonly string[]) =>
		refs.some((r) => {
			const o = ctx.shown.get(r);
			return o?.actor === "user" && o.seq > ctx.seenSeq;
		});
	/** The user's own words, new to this tick; null when they suffice. */
	const userWords = (refs: readonly string[]) =>
		!fromUser(refs)
			? "needs_user_evidence"
			: !fromNewUser(refs)
				? "already_read"
				: null;
	const inputs = [...ctx.shown.keys()];
	for (const op of ops) {
		const refuse = (code: string) => rejected.push(`${op.op}:${code}`);
		const refs = [...new Set(op.evidenceRefs)];
		if (refs.some((r) => !known(r))) {
			refuse("unknown_ref");
			continue;
		}
		const text = op.text?.trim() ?? "";
		if (op.op === "fact.add") {
			if (op.aspect === null || op.basis === null || text === "") {
				refuse("missing_field");
				continue;
			}
			const missing = op.basis === "hypothesis" ? null : userWords(refs);
			if (missing !== null) {
				refuse(missing);
				continue;
			}
			if (state.facts.length >= FACTS_LIMIT) {
				refuse("facts_full");
				continue;
			}
			const id = ctx.nextId("f");
			state.facts.push({
				id,
				aspect: op.aspect,
				text,
				basis: op.basis,
				evidence: refs,
				reason: op.reason?.trim() || null,
				inputs,
				at: ctx.at,
				updatedAt: ctx.at,
			});
			applied.push(`fact.add ${id}`);
		} else if (op.op === "fact.update" || op.op === "fact.retract") {
			const id = op.id === null ? "" : bare(op.id, "fact");
			const fact = state.facts.find((f) => f.id === id);
			if (!fact) {
				refuse("unknown_fact");
				continue;
			}
			const basis = op.op === "fact.update" ? (op.basis ?? fact.basis) : null;
			// What the user said is changed only by the user: no rewrite by downgrading it to a guess.
			const needsUser =
				fact.basis !== "hypothesis" ||
				(basis !== null && basis !== "hypothesis");
			const missing = needsUser ? userWords(refs) : null;
			if (missing !== null) {
				refuse(missing);
				continue;
			}
			if (op.op === "fact.retract") {
				state.facts = state.facts.filter((f) => f.id !== id);
				applied.push(`fact.retract ${id}`);
				continue;
			}
			fact.aspect = op.aspect ?? fact.aspect;
			fact.text = text || fact.text;
			fact.basis = basis ?? fact.basis;
			fact.reason = op.reason?.trim() || fact.reason;
			fact.evidence = [...new Set([...fact.evidence, ...refs])];
			fact.inputs = [...new Set([...(fact.inputs ?? []), ...inputs])];
			fact.updatedAt = ctx.at;
			applied.push(`fact.update ${id}`);
		} else if (op.op === "gap.add") {
			if (text === "") {
				refuse("missing_field");
				continue;
			}
			if (
				state.gaps.filter((g) => g.status === "open").length >= OPEN_GAPS_LIMIT
			) {
				refuse("gaps_full");
				continue;
			}
			const id = ctx.nextId("g");
			state.gaps.push({
				id,
				question: text,
				why: op.reason?.trim() || null,
				status: "open",
				askedAt: null,
				evidence: refs,
				inputs,
				at: ctx.at,
			});
			applied.push(`gap.add ${id}`);
		} else {
			const id = op.id === null ? "" : bare(op.id, "gap");
			const gap = state.gaps.find((g) => g.id === id && g.status === "open");
			if (!gap || op.status === null) {
				refuse(gap ? "missing_field" : "unknown_gap");
				continue;
			}
			const missing = userWords(refs);
			if (missing !== null) {
				refuse(missing);
				continue;
			}
			gap.status = op.status;
			gap.evidence = [...new Set([...gap.evidence, ...refs])];
			gap.inputs = [...new Set([...(gap.inputs ?? []), ...inputs])];
			applied.push(`gap.close ${id}`);
		}
	}
	// Open questions stay; declined ones say what not to ask again; answered ones are in facts.
	const keep = (status: string, n: number) =>
		new Set(
			state.gaps
				.filter((g) => g.status === status)
				.slice(-n)
				.map((g) => g.id),
		);
	const declined = keep("declined", DECLINED_KEPT);
	const answered = keep("answered", ANSWERED_KEPT);
	state.gaps = state.gaps.filter(
		(g) => g.status === "open" || declined.has(g.id) || answered.has(g.id),
	);
	return { applied, rejected };
}
