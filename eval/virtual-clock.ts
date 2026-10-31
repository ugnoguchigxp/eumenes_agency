/** H5: a virtual clock for fixed tests and multi-day replays (no real time). */
const HOUR = 3_600_000;
export interface VirtualClock {
	now(): number;
	plusHours(h: number): number;
	advanceHours(h: number): void;
	advanceMs(ms: number): void;
	set(at: number): void;
}
export const virtualClock = (start: string | number): VirtualClock => {
	let t = typeof start === "number" ? start : Date.parse(start);
	if (!Number.isFinite(t)) throw new Error(`bad clock start: ${start}`);
	return {
		now: () => t,
		plusHours: (h) => t + h * HOUR,
		advanceHours: (h) => {
			t += h * HOUR;
		},
		advanceMs: (ms) => {
			if (ms < 0) throw new Error("clock cannot go back");
			t += ms;
		},
		set: (at) => {
			if (at < t) throw new Error("clock cannot go back");
			t = at;
		},
	};
};
