/**
 * The host's records (plans with a date, the question ledger) in a stand-in for Eumenes' tables:
 * in memory, or one JSON file. Its writer runs `extractRecords` over the lines after its position
 * and keeps what passes the checks; `records` hands the agent what it holds. What the user said of
 * themselves belongs to the memory library in Eumenes; here it is not stored.
 */
import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import type { LlmPort } from "../../../src/index.ts";
import {
	extractRecords,
	type AgendaRecords,
	type AgendaRecordsWriter,
	type ExtractedRecords,
	type PlanRecord,
	type QuestionRecord,
} from "../../../src/agenda/index.ts";

interface Stored {
	n: number;
	plans: PlanRecord[];
	questions: QuestionRecord[];
}

const empty = (): Stored => ({ n: 0, plans: [], questions: [] });

export function createRecordStore(opts: {
	readonly llm: LlmPort;
	/** Local time as the user would say it, so "来月" becomes a date. */
	readonly clock?: (now: number) => string;
	/** A JSON file (absent: in memory only). */
	readonly path?: string;
}) {
	let state: Stored =
		opts.path && existsSync(opts.path)
			? (JSON.parse(readFileSync(opts.path, "utf8")) as Stored)
			: empty();
	const save = () => {
		if (!opts.path) return;
		mkdirSync(dirname(opts.path), { recursive: true });
		writeFileSync(`${opts.path}.tmp`, JSON.stringify(state, null, "\t"));
		renameSync(`${opts.path}.tmp`, opts.path);
	};
	const apply = (r: ExtractedRecords): string[] => {
		const applied: string[] = [];
		for (const p of r.plans) {
			if (p.op === "add") {
				state.plans.push({
					ref: `p${++state.n}`,
					text: p.text ?? "",
					dueAt: p.dueAt,
				});
				applied.push(`plan add: ${p.text}${p.dueAt ? `（${p.dueAt}）` : ""}`);
				continue;
			}
			const at = state.plans.findIndex((x) => x.ref === p.ref);
			const had = state.plans[at];
			if (!had) continue;
			if (p.op === "close") {
				state.plans.splice(at, 1);
				applied.push(`plan close ${had.ref}: ${had.text}`);
			} else {
				const next = {
					ref: had.ref,
					text: p.text ?? had.text,
					dueAt: p.dueAt ?? had.dueAt,
				};
				state.plans[at] = next;
				applied.push(`plan update ${had.ref}: ${next.text}`);
			}
		}
		for (const q of r.questions) {
			state.questions = [
				...state.questions.filter((x) => x.attribute !== q.attribute),
				{ attribute: q.attribute, state: q.op },
			];
			applied.push(`question ${q.op}: ${q.attribute}`);
		}
		return applied;
	};
	const writer: AgendaRecordsWriter = async (r) => {
		const out = await extractRecords({
			llm: opts.llm,
			said: r.said,
			related: {
				plans: state.plans,
				questions: state.questions.map((q) => ({
					attribute: q.attribute,
					state: q.state,
				})),
			},
			clock: opts.clock ? opts.clock(r.at) : null,
			at: r.at,
			signal: new AbortController().signal,
		});
		// A failed pass leaves the host's position where it was: it reads the same lines again.
		if (!out.ok) throw new Error(`records_${out.reason}`);
		const applied = apply(out.records);
		if (applied.length) save();
		return { applied, rejected: out.rejected };
	};
	return {
		records: (): AgendaRecords => ({
			plans: state.plans,
			questions: state.questions,
		}),
		get: (): Readonly<Stored> => state,
		reset: () => {
			state = empty();
			save();
		},
		writer,
	};
}
export type RecordStore = ReturnType<typeof createRecordStore>;
