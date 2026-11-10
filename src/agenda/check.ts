/**
 * Before a research starts: is its theme new, partly covered (narrowed) or covered by a note
 * already? No result should come back twice (the user's request, 2026-11-08).
 */
import { callModel } from "../application/model-call.ts";
import {
	checkSchema,
	RESEARCH_RETRY_MS,
	type AgendaItem,
	type CallRecord,
	type CheckOutcome,
} from "./contracts.ts";
import { checkData } from "./prompt.ts";
import {
	makeItem,
	notes,
	record,
	unlimited,
	type AgendaState,
} from "./state.ts";

export async function check(
	st: AgendaState,
	item: AgendaItem,
	now: number,
	signal: AbortSignal,
): Promise<CheckOutcome> {
	const notesNow = notes(st);
	const researchedBefore = st.items
		.filter(
			// A research that failed brought nothing back: asking it again is not a repeat.
			(i) =>
				i.kind === "research" &&
				i.id !== item.id &&
				i.status !== "open" &&
				i.status !== "failed",
		)
		.map((i) => i.checkedRequest ?? i.text);
	const out = (
		verdict: CheckOutcome["verdict"],
		coveredBy: string | null,
		request: string | null,
		reason: string,
		call: CallRecord,
	): CheckOutcome => ({
		itemId: item.id,
		verdict,
		coveredBy,
		request,
		reason,
		call,
	});
	// What the user asked for is not second-guessed; with nothing to compare, there is no call.
	if (
		item.requested ||
		(notesNow.length === 0 && researchedBefore.length === 0)
	) {
		item.checkedRequest = null;
		return out(
			"new",
			null,
			null,
			item.requested ? "requested" : "nothing_to_compare",
			record("check", now, null, false, "applied"),
		);
	}
	const call = await callModel(
		st.deps.llm,
		unlimited,
		{
			purpose: "think",
			at: now,
			system: st.instructions.check,
			prompt: checkData({
				now,
				request: item.text,
				notes: notesNow,
				researchedBefore,
			}),
			schema: checkSchema,
			maxOutputTokens: 400,
		},
		signal,
	);
	if (!call.ok) {
		// An unchecked research is not started blind; it is tried again later.
		item.deferUntil = now + RESEARCH_RETRY_MS;
		return out(
			"failed",
			null,
			null,
			call.outcome.code,
			record(
				"check",
				now,
				null,
				false,
				call.outcome.code === "aborted" ? "aborted" : "failed",
			),
		);
	}
	const v = call.value;
	const coveredBy =
		v.coveredBy && notesNow.some((x) => `note:${x.id}` === v.coveredBy)
			? v.coveredBy
			: null;
	// What the reply said it would look into and a note already covers: the promise is kept
	// with that note instead of the same research again.
	if (v.verdict === "covered" && item.promised && coveredBy === null) {
		item.checkedRequest = null;
		return out(
			"new",
			null,
			null,
			`promised: ${v.reason}`,
			record("check", now, call.usage, true, "applied"),
		);
	}
	// Covered by an earlier request (no note to name, as the instructions allow) or by a note
	// that is not there: it is dropped all the same. A promise never gets here without a note.
	if (v.verdict === "covered") {
		item.status = "dropped";
		item.endedAt = now;
		const noteId = coveredBy?.slice("note:".length) ?? null;
		if (
			coveredBy !== null &&
			item.promised &&
			!st.items.some(
				(i) =>
					i.kind === "talk" && i.noteId === noteId && i.status !== "dropped",
			)
		)
			st.items.push(
				makeItem(st, {
					kind: "talk",
					text: "調べておくと言った件は、前に調べたメモにもうまとまっている",
					refs: [coveredBy, ...item.refs],
					value: 5,
					reason: "返事で調べておくと言ったことは、既存のメモで答えられる",
					promised: true,
					noteId,
					createdAt: now,
				}),
			);
		return out(
			"covered",
			coveredBy,
			null,
			v.reason,
			record("check", now, call.usage, true, "applied"),
		);
	}
	const narrowed = v.verdict === "partial" ? (v.request?.trim() ?? "") : "";
	item.checkedRequest = narrowed === "" ? null : narrowed;
	return out(
		narrowed === "" ? "new" : "partial",
		null,
		narrowed === "" ? null : narrowed,
		v.reason,
		record("check", now, call.usage, true, "applied"),
	);
}
