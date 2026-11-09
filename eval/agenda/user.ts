/**
 * A user who reacts, for the agenda checks: when the agent speaks on its own, the background model
 * plays the user of the scenario (who they are, how they feel) and decides whether to answer,
 * after how long, and what they made of being spoken to: a word of feeling (it feeds the judge)
 * and a plain yes or no to "was that off?" (the count of discomfort). Measurement only; the agent
 * never sees it.
 */
import { z } from "zod";
import type { LlmPort } from "../../src/index.ts";

export interface UserPersona {
	/** Who the user is and how they talk, consistent with the scenario's scripted lines. */
	readonly profile: string;
	/** Spans (seconds from the start) when the user does not answer: asleep, at work. */
	readonly away?: readonly (readonly [number, number])[];
}

export interface UserReaction {
	readonly text: string | null;
	readonly delaySec: number;
	/** What the user made of being spoken to (natural, abrupt, too much, helpful...). */
	readonly feeling: string;
	/** Was being spoken to off (pushy, out of place, beside the point, said again...)? */
	readonly uneasy?: boolean;
}

export type SimulatedUser = (ctx: {
	readonly atSec: number;
	readonly clock: string | null;
	readonly utterance: string;
	readonly history: readonly { readonly who: string; readonly text: string }[];
}) => Promise<UserReaction | null>;

const schema = z.strictObject({
	reply: z.string().nullable(),
	delaySec: z.number().int().min(3).max(180),
	feeling: z.string(),
	uneasy: z.boolean(),
});

const system = (profile: string) =>
	[
		"あなたは、会話エージェントの評価のための利用者役です。次の人物として、ふつうの人が感じるとおりに反応します。",
		`【人物】${profile}`,
		"エージェントが話しかけてきました（自分からの話しかけか、返事の最後の質問）。返事をするかどうか、するなら何と言うかを決めます。",
		"- 返事は話し言葉で短く（1〜2文）。人物の設定と、これまでの会話に合わせます。",
		"- 興味がない・忙しい・話しかけが多すぎると感じたら、返事をしない（reply を null）か、短い相づちにします。答えたくない質問ははぐらかしてかまいません。",
		"- あなたは、パーソナルエージェントに自分のことを知ってもらうのも、調べてくれたことを雑談で聞くのも好きな人です。多少うるさいくらいの話しかけは気にしません。ただし、人物の設定（忙しい、疲れている、苦手なもの、断ったこと）は守り、その場に合わない話しかけには正直に反応します。エージェントに合わせすぎません。",
		"- delaySec は返事までの秒数です（すぐなら5〜15、考えるなら30〜90）。",
		"- feeling には、話しかけられてどう感じたかを一言で書きます（自然・うれしい・役に立った・唐突・しつこい・うるさい・的外れ・同じことの繰り返し、など）。",
		"- uneasy には、この話しかけに違和感があったかを true か false で答えます。true は、嫌だった・困った・変だと感じたときです（しつこい、唐突で戸惑った、的外れ、同じことの繰り返し、断ったのにまた言われた、忙しいのに押された、事実と違う）。false は、自然・うれしい・役に立ったと感じたときと、少し唐突でも気にならない程度のときです。迷ったら、同じような話しかけがまた来ても構わないなら false、来てほしくないなら true にします。",
		"出力は指定された JSON だけです。",
	].join("\n");

export function llmUser(llm: LlmPort, persona: UserPersona): SimulatedUser {
	return async (ctx) => {
		if (persona.away?.some(([from, to]) => ctx.atSec >= from && ctx.atSec < to))
			return null;
		const r = await llm.complete(
			{
				purpose: "think",
				system: system(persona.profile),
				prompt: JSON.stringify({
					now: ctx.clock,
					conversation: ctx.history.slice(-12),
					agentJustSaid: ctx.utterance,
				}),
				schema,
				maxOutputTokens: 300,
			},
			new AbortController().signal,
		);
		return {
			text: r.value.reply?.trim() || null,
			delaySec: r.value.delaySec,
			feeling: r.value.feeling,
			uneasy: r.value.uneasy,
		};
	};
}
