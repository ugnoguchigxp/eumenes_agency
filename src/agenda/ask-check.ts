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
} from "./contracts.ts";
import { profileOf } from "./profile.ts";
import { askCheckData } from "./prompt.ts";
import { clock, known, record, unlimited, type AgendaState } from "./state.ts";

export async function checkAsks(
	st: AgendaState,
	items: readonly AgendaItem[],
	now: number,
	signal: AbortSignal,
): Promise<{ repeats: AskRepeat[]; call: CallRecord | null }> {
	const asks = items.filter((i) => i.kind === "ask" && i.status === "open");
	if (asks.length === 0) return { repeats: [], call: null };
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
				clock: clock(st, now),
				said: st.said,
				known: known(st),
				profile: profileOf(st),
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
			repeats: [],
			call: record(
				"ask_check",
				now,
				null,
				false,
				call.outcome.code === "aborted" ? "aborted" : "failed",
			),
		};
	const repeats: AskRepeat[] = [];
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
