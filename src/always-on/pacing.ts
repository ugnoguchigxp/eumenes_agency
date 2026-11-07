/**
 * May the agent speak on its own right now? Code enforces only when it must not (spec §3.7):
 * the host is busy, the user muted or stopped it, the shortest gap has not passed, or unanswered
 * speech has backed off past the hold. Thinking and preparing are never gated here.
 */
import { SPEECH_HOLD_MS, type Pacing } from "./contracts.ts";

export type SpeechBlock = "busy" | "stopped" | "muted" | "interval" | "held";

export interface SpeechGate {
	readonly allowed: boolean;
	readonly block: SpeechBlock | null;
	/** Seconds until speech may be allowed again; null when it waits for the user or the host. */
	readonly inSec: number | null;
}

/** Gap required before the next own utterance: doubles with each unanswered one. */
export const requiredGapMs = (intervalMs: number, unanswered: number) =>
	intervalMs * 2 ** Math.max(0, unanswered);

export function speechGate(
	pacing: Pacing,
	intervalMs: number,
	now: number,
	busy: boolean,
): SpeechGate {
	if (pacing.stopped) return { allowed: false, block: "stopped", inSec: null };
	if (busy) return { allowed: false, block: "busy", inSec: null };
	if (pacing.muteUntil !== null && now < pacing.muteUntil)
		return {
			allowed: false,
			block: "muted",
			inSec: Math.ceil((pacing.muteUntil - now) / 1000),
		};
	const gap = requiredGapMs(intervalMs, pacing.unanswered);
	// Held until the user speaks again: the backoff would exceed the hold (no talking to an empty room).
	if (pacing.unanswered > 0 && gap > Math.max(SPEECH_HOLD_MS, intervalMs))
		return { allowed: false, block: "held", inSec: null };
	const since = pacing.lastAgentAt === null ? null : now - pacing.lastAgentAt;
	const minGap = pacing.unanswered > 0 ? gap : intervalMs;
	if (since !== null && since < minGap)
		return {
			allowed: false,
			block: "interval",
			inSec: Math.ceil((minGap - since) / 1000),
		};
	return { allowed: true, block: null, inSec: null };
}

/** Preparation is silent: only the user's stop or mute holds it. */
export function prepareGate(
	pacing: Pacing,
	now: number,
): "stopped" | "muted" | null {
	if (pacing.stopped) return "stopped";
	if (pacing.prepareMuteUntil !== null && now < pacing.prepareMuteUntil)
		return "muted";
	return null;
}
