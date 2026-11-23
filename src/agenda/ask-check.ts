/**
 * Before a question is asked: is it, in meaning, one the agent asked already (on its own or in a
 * reply), or one the user has answered or talked about already? Wording does not matter (user,
 * 2026-11-09: "意味として同じ事を聞くのはNG…言い回しがちがっても"). A repeat is dropped and the
 * next item comes at the agent's pace; a failed check lets the questions through.
 */
import { callModel } from "../application/model-call.ts";
import {
	askCheckSchema,
	type AgendaItem,
	type AskRepeat,
	type CallRecord,
	type QuestionRecord,
} from "./contracts.ts";
import { askCheckData } from "./prompt.ts";
import {
	record,
	records,
	stampOf,
	unlimited,
	type AgendaState,
} from "./state.ts";
import { normalize } from "./text.ts";

/**
 * The ledger's entry the question is about, where its attribute stands in the question's words.
 * Code only for what is plain: a paraphrase is for the model, which reads the ledger (a shared
 * pair of characters is no sign of one attribute: 好きな色 and 好きな食べ物 share two of three).
 */
export const ledgerEntry = (
	text: string,
	questions: readonly QuestionRecord[],
): QuestionRecord | null => {
	const said = normalize(text);
	return (
		questions.find((q) => {
			const attribute = normalize(q.attribute);
			return attribute.length >= 2 && said.includes(attribute);
		}) ?? null
	);
};

export async function checkAsks(
	st: AgendaState,
	items: readonly AgendaItem[],
	now: number,
	signal: AbortSignal,
): Promise<{ repeats: AskRepeat[]; call: CallRecord | null }> {
	const open = items.filter((i) => i.kind === "ask" && i.status === "open");
	if (open.length === 0) return { repeats: [], call: null };
	// What the ledger holds is not asked: known (answered), asked and waiting, declined or put off.
	const { questions } = records(st, {
		purpose: "ask_check",
		asks: open.map((i) => i.text),
	});
	const repeats: AskRepeat[] = [];
	const asks: AgendaItem[] = [];
	for (const item of open) {
		const entry = ledgerEntry(item.text, questions);
		if (!entry) {
			asks.push(item);
			continue;
		}
		const verdict = entry.state === "answered" ? "answered" : "asked";
		const reason = `台帳: ${entry.attribute}（${entry.state}）`;
		item.status = "dropped";
		item.endedAt = now;
		item.lastDecline = { reason: `${verdict}: ${reason}`, at: now };
		repeats.push({ itemId: item.id, text: item.text, verdict, reason });
	}
	if (asks.length === 0) return { repeats, call: null };
	const askedBefore = st.items
		.filter(
			(i) =>
				i.kind === "ask" &&
				!asks.includes(i) &&
				(i.status === "done" || i.status === "doing"),
		)
		.slice(-20)
		.map((i) => i.text);
	const call = await callModel(
		st.deps.llm,
		unlimited,
		{
			purpose: "think",
			at: now,
			system: st.instructions.askCheck,
			prompt: askCheckData({
				now,
				stamp: stampOf(st),
				said: st.said,
				questions,
				askedBefore,
				candidates: asks.map((i) => ({ id: i.id, text: i.text })),
			}),
			schema: askCheckSchema,
			maxOutputTokens: 600,
		},
		signal,
	);
	if (!call.ok)
		return {
			repeats,
			call: record(
				"ask_check",
				now,
				null,
				false,
				call.outcome.code === "aborted" ? "aborted" : "failed",
			),
		};
	for (const v of call.value.verdicts) {
		if (v.verdict === "new") continue;
		const item = asks.find((i) => i.id === v.id && i.status === "open");
		if (!item) continue;
		const reason = v.reason.trim();
		item.status = "dropped";
		item.endedAt = now;
		item.lastDecline = { reason: `${v.verdict}: ${reason}`, at: now };
		repeats.push({
			itemId: item.id,
			text: item.text,
			verdict: v.verdict,
			reason,
		});
	}
	return {
		repeats,
		call: record("ask_check", now, call.usage, repeats.length > 0, "applied"),
	};
}
