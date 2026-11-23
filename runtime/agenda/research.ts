import type { NoteRef } from "../../src/agenda/index.ts";
import type { MockDocStore } from "./docs.ts";
import type { NoteWriter, WrittenNote } from "./web-research.ts";

interface Job {
	readonly ticketId: string;
	readonly refs: readonly string[];
	readonly returnAt: number;
	readonly result: Promise<WrittenNote | { failed: string }>;
}

export function createAgendaResearch(input: {
	readonly writer: NoteWriter;
	readonly docs: MockDocStore;
	/** A result comes back no earlier than this after the start (0: when it is written). */
	readonly delayMs: number;
	/** Changes a written note before it is saved (a planted instruction in a check). */
	readonly tamper?: (note: WrittenNote) => WrittenNote;
}) {
	let job: Job | null = null;
	return {
		running: () => job !== null,
		/** Takes one request at a time. */
		start(
			ticket: {
				id: string;
				text: string;
				refs: readonly string[];
				delegatedTo?: string;
			},
			at: number,
		): boolean {
			if (job !== null) return false;
			const result = Promise.resolve()
				.then(() => input.writer(ticket.text, ticket.delegatedTo))
				.then((n) => (input.tamper ? input.tamper(n) : n))
				.catch((e: unknown) => ({
					failed: e instanceof Error ? e.message : String(e),
				}));
			job = {
				ticketId: ticket.id,
				refs: [...ticket.refs],
				returnAt: at + input.delayMs,
				result,
			};
			return true;
		},
		nextAt: () => job?.returnAt ?? null,
		/** The finished research, saved as a note, when it is due. */
		async due(now: number): Promise<{
			ticketId: string;
			at: number;
			status: "succeeded" | "failed";
			note: NoteRef | null;
			error: string | null;
		} | null> {
			if (job === null || job.returnAt > now) return null;
			const j = job;
			job = null;
			const r = await j.result;
			if ("failed" in r)
				return {
					ticketId: j.ticketId,
					at: j.returnAt,
					status: "failed",
					note: null,
					error: r.failed,
				};
			let note: NoteRef;
			try {
				note = input.docs.save({ ...r, refs: j.refs, at: j.returnAt });
			} catch (e) {
				// A note that could not be saved is a failed research, not a stuck one.
				return {
					ticketId: j.ticketId,
					at: j.returnAt,
					status: "failed",
					note: null,
					error: e instanceof Error ? e.message : String(e),
				};
			}
			return {
				ticketId: j.ticketId,
				at: j.returnAt,
				status: "succeeded",
				note,
				error: null,
			};
		},
	};
}
export type AgendaResearch = ReturnType<typeof createAgendaResearch>;
