/**
 * P4-c: item revision history. The host's AgencyDb owns the single SQLite table
 * `agency_item_revisions(scope, item_kind, item_id, revision, state_json, reason, evidence_json, call_id, at)`.
 * Agency only emits rows; there is no second canon. References use IDs, but stateJson and reason
 * can contain derived text. Forgetting must redact every affected version, not just the latest row.
 */
import type { AgencyState } from "./model.ts";

export const itemKinds = [
	"agency",
	"intent",
	"candidate",
	"attempt",
	"belief",
	"desire",
	"note",
	"interest",
] as const;
export type ItemKind = (typeof itemKinds)[number];

export interface ItemRevision {
	readonly scope: string;
	readonly itemKind: ItemKind;
	readonly itemId: string;
	/** Per-item sequence in the table (1, 2, ...). */
	readonly revision: number;
	readonly stateJson: string;
	readonly reason: string;
	readonly evidence: readonly string[];
	/** What advanced the state: update / select / receipt / observe / wake / invalidate. */
	readonly callId: string;
	readonly at: number;
}

/** Host-provided sink. `append` must write one batch in one transaction. */
export interface RevisionSink {
	readonly scope: string;
	append(rows: readonly ItemRevision[]): void;
}

export const REDACTED = '{"redacted":true}';
/** Tombstone: the item left the state (e.g. note.delete); restore must not resurrect it. */
export const DELETED = '{"deleted":true}';
export type RestoredState = AgencyState;
