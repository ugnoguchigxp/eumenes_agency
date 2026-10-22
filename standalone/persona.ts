/** Persona of the CLI agent: standing interests (host-configured, not user requests). */
import type { StandingInterest } from "../src/contracts/index.ts";

/** Default persona interest when --interest is not given. Facts kept minimal on purpose. */
export const defaultInterestText =
	"マイメロディ（サンリオのキャラクター）が好き。";

/** Upper bound for one --interest text. */
export const maxInterestChars = 200;

/** Interests get stable ids i1, i2, ... (cited as `interest:i1`). */
export const toStandingInterests = (
	texts: readonly string[],
): readonly StandingInterest[] =>
	texts.map((text, index) => ({ id: `i${index + 1}`, text }));

/**
 * Character trait for the main reply prompt: lets the agent answer naturally when asked
 * what it likes, without steering every reply toward it. Empty when there are none.
 */
export const personaPrompt = (texts: readonly string[]): string =>
	texts.length === 0
		? ""
		: [
				"あなたには好きなものがあり、それはあなたの人柄の一部です。",
				...texts.map((t) => `- ${t}`),
				"好きなものを聞かれたら、自分のこととして自然に答えてください。ただし、毎回の返事をその話題に寄せたり、無理に持ち出したりはしないでください。",
			].join("\n");
