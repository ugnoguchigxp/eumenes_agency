/** P4-c: diff the in-RAM state into revision rows, rebuild state from rows, redact on forget. */
import type { AgencyState } from "../contracts/model.ts";
import type { InputProvenance, InputContext } from "../contracts/memory.ts";
import {
	DELETED,
	REDACTED,
	type ItemKind,
	type ItemRevision,
} from "../contracts/revisions.ts";

type Item = { id: string } & Record<string, unknown>;
const lists: [ItemKind, keyof AgencyState][] = [
	["intent", "intents"],
	["candidate", "candidates"],
	["attempt", "attempts"],
	["belief", "beliefs"],
	["desire", "desires"],
	["note", "notes"],
	["interest", "interests"],
];
const ROOT = "root";
const rootOf = (s: AgencyState) => ({
	revision: s.revision,
	nextId: s.nextId,
	focus: s.focus,
	lastOutboundAt: s.lastOutboundAt,
	hasInterests: s.interests !== undefined,
});

const items = (
	s: AgencyState,
	provenance?: InputProvenance,
): [ItemKind, string, unknown][] => [
	["agency", ROOT, rootOf(s)],
	...lists.flatMap(([k, f]) =>
		((s[f] as Item[] | undefined) ?? []).map(
			(x): [ItemKind, string, unknown] => [k, x.id, x],
		),
	),
	...(provenance?.entries
		.filter(([key]) => !key.startsWith("observation:"))
		.map(([key, value]): [ItemKind, string, unknown] => [
			"agency",
			`inputs:${key}`,
			value,
		]) ?? []),
];

const refsOf = (x: unknown): string[] => {
	const o = x as Record<string, unknown>;
	for (const f of ["evidence", "evidenceRefs", "sourceRefs"])
		if (Array.isArray(o?.[f])) return (o[f] as unknown[]).map(String);
	return [];
};

export class RevisionTracker {
	private readonly last = new Map<string, { json: string; rev: number }>();
	constructor(private readonly scope: string) {}
	/** Seeds from restored rows' state without emitting (no duplicate history). */
	prime(
		state: AgencyState,
		revs?: ReadonlyMap<string, number>,
		provenance?: InputProvenance,
	): void {
		for (const [k, id, v] of items(state, provenance)) {
			const key = `${k}:${id}`;
			this.last.set(key, { json: JSON.stringify(v), rev: revs?.get(key) ?? 1 });
		}
	}
	/** Prepare rows without advancing the saved baseline. Call commit only after append succeeds. */
	diff(
		state: AgencyState,
		callId: string,
		at: number,
		provenance?: InputProvenance,
	): ItemRevision[] {
		const out: ItemRevision[] = [];
		const present = new Set<string>();
		const inputs = new Map(provenance?.entries);
		for (const [k, id, v] of items(state, provenance)) {
			const key = `${k}:${id}`;
			present.add(key);
			const json = JSON.stringify(v);
			const prev = this.last.get(key);
			if (prev?.json === json) continue;
			const rev = (prev?.rev ?? 0) + 1;
			const reason = (v as { reason?: unknown }).reason;
			out.push({
				scope: this.scope,
				itemKind: k,
				itemId: id,
				revision: rev,
				stateJson: json,
				reason: typeof reason === "string" ? reason : callId,
				evidence: [
					...new Set([
						...refsOf(v),
						...(inputs.get(key)?.sources ?? []),
						...(k === "agency" && id.startsWith("inputs:")
							? (v as InputContext).sources
							: []),
					]),
				],
				callId,
				at,
			});
		}
		for (const [key, prev] of this.last) {
			if (present.has(key) || prev.json === DELETED) continue;
			const rev = prev.rev + 1;
			const cut = key.indexOf(":");
			out.push({
				scope: this.scope,
				itemKind: key.slice(0, cut) as ItemKind,
				itemId: key.slice(cut + 1),
				revision: rev,
				stateJson: DELETED,
				reason: "deleted",
				evidence: [],
				callId,
				at,
			});
		}
		return out;
	}
	commit(rows: readonly ItemRevision[]): void {
		for (const row of rows)
			this.last.set(`${row.itemKind}:${row.itemId}`, {
				json: row.stateJson,
				rev: row.revision,
			});
	}
}

/** Latest row per item → state. The table alone restores open and closed items. */
export const stateFromRevisions = (
	rows: readonly ItemRevision[],
): {
	state: AgencyState;
	revs: Map<string, number>;
	provenance?: InputProvenance;
} | null => {
	const latest = new Map<string, ItemRevision>();
	for (const r of rows) {
		const key = `${r.itemKind}:${r.itemId}`;
		const p = latest.get(key);
		if (!p || r.revision > p.revision) latest.set(key, r);
	}
	const root = latest.get(`agency:${ROOT}`);
	if (!root || root.stateJson === REDACTED) return null;
	const meta = JSON.parse(root.stateJson) as ReturnType<typeof rootOf>;
	const state: AgencyState = {
		revision: meta.revision,
		intents: [],
		candidates: [],
		attempts: [],
		beliefs: [],
		desires: [],
		notes: [],
		focus: meta.focus,
		nextId: meta.nextId,
		lastOutboundAt: meta.lastOutboundAt,
		...(meta.hasInterests ? { interests: [] } : {}),
	};
	const field = new Map(lists);
	const seen = new Set<string>();
	// first-appearance order keeps the original list order
	for (const r of rows) {
		const key = `${r.itemKind}:${r.itemId}`;
		if (r.itemKind === "agency" || seen.has(key)) continue;
		seen.add(key);
		const cur = latest.get(key)!;
		const arr = state[field.get(r.itemKind)!] as Item[] | undefined;
		if (arr && cur.stateJson !== REDACTED && cur.stateJson !== DELETED)
			arr.push(JSON.parse(cur.stateJson) as Item);
	}
	const revs = new Map([...latest].map(([k, r]) => [k, r.revision]));
	const entries = [...latest.values()]
		.filter(
			(r) =>
				r.itemKind === "agency" &&
				r.itemId.startsWith("inputs:") &&
				r.stateJson !== REDACTED &&
				r.stateJson !== DELETED,
		)
		.map((r): [string, InputContext] => [
			r.itemId.slice(7),
			JSON.parse(r.stateJson),
		]);
	return {
		state,
		revs,
		...(entries.length ? { provenance: { version: 1 as const, entries } } : {}),
	};
};

/** Forgetting: every row of an item that ever cited a forgotten id loses its body. */
export const redactRevisions = (
	rows: readonly ItemRevision[],
	forgotten: ReadonlySet<string>,
): ItemRevision[] => {
	const hit = new Set(
		rows
			.filter((r) => r.evidence.some((e) => forgotten.has(e)))
			.map((r) => `${r.itemKind}:${r.itemId}`),
	);
	if (forgotten.size) {
		// Legacy revisions have only citations, not an input manifest. Precision is unavailable.
		const tracked = new Map<string, InputContext>();
		for (const r of rows)
			if (
				r.itemKind === "agency" &&
				r.itemId.startsWith("inputs:") &&
				r.stateJson !== REDACTED &&
				r.stateJson !== DELETED
			) {
				const key = r.itemId.slice(7);
				const input = JSON.parse(r.stateJson) as InputContext;
				const old = tracked.get(key);
				tracked.set(key, {
					sources: [...(old?.sources ?? []), ...input.sources],
					complete: input.complete && (old?.complete ?? true),
				});
			}
		for (const r of rows)
			if (r.itemKind !== "agency") {
				const key = `${r.itemKind}:${r.itemId}`;
				const input = tracked.get(key);
				if (!input?.complete || input.sources.some((id) => forgotten.has(id)))
					hit.add(key);
			}
		for (const key of hit) {
			if (key.startsWith("agency:inputs:")) hit.add(key.slice(14));
			else if (!key.startsWith("agency:")) hit.add(`agency:inputs:${key}`);
		}
	}
	return rows.map((r) =>
		hit.has(`${r.itemKind}:${r.itemId}`)
			? { ...r, stateJson: REDACTED, reason: "", evidence: [] }
			: r,
	);
};

export interface InterestStep {
	readonly revision: number;
	readonly at: number;
	readonly status: string;
	readonly topic: string;
	readonly reason: string;
}
/** Interest change over time, reconstructed from the table only. */
export const interestHistory = (
	rows: readonly ItemRevision[],
): Map<string, InterestStep[]> => {
	const m = new Map<string, InterestStep[]>();
	for (const r of rows) {
		if (
			r.itemKind !== "interest" ||
			r.stateJson === REDACTED ||
			r.stateJson === DELETED
		)
			continue;
		const v = JSON.parse(r.stateJson) as {
			status: string;
			topic: string;
			reason: string;
		};
		const l = m.get(r.itemId) ?? [];
		l.push({
			revision: r.revision,
			at: r.at,
			status: v.status,
			topic: v.topic,
			reason: v.reason,
		});
		m.set(r.itemId, l);
	}
	for (const l of m.values()) l.sort((a, b) => a.revision - b.revision);
	return m;
};
