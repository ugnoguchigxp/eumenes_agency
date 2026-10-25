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
