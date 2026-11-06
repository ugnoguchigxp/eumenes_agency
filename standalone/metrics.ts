/** Local metadata only. Labels come from the person using the CLI, never from heuristics. */
export const feedbackKinds = ["useful", "intrusive", "missed"] as const;
export type FeedbackKind = (typeof feedbackKinds)[number];
export function parseFeedback(
	line: string,
): { rating: FeedbackKind; note: string } | null {
	const [command, rating, ...note] = line.trim().split(/\s+/);
	if (
		command !== "/feedback" ||
		!feedbackKinds.includes(rating as FeedbackKind)
	)
		return null;
	return { rating: rating as FeedbackKind, note: note.join(" ") };
}

const percentile = (xs: number[], q: number) => {
	if (!xs.length) return null;
	const sorted = [...xs].sort((a, b) => a - b);
	return sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)]!;
};
export function summarizeUsage(sessions: readonly (readonly unknown[])[]) {
	let users = 0,
		replies = 0,
		proactive = 0,
		malformed = 0;
	const latency: number[] = [];
	const dates = new Set<string>();
	const labels = { useful: 0, intrusive: 0, missed: 0 };
	const targets = new Set<string>();
	for (let s = 0; s < sessions.length; s++) {
		const events = sessions[s]!;
		const interventions = new Set<string>();
		const latestLabels = new Map<string, FeedbackKind>();
		for (const raw of events) {
			if (!raw || typeof raw !== "object" || !("type" in raw)) {
				malformed++;
				continue;
			}
			const e = raw as Record<string, unknown>;
			if (typeof e.at === "number" && Number.isFinite(e.at))
				dates.add(new Date(e.at).toISOString().slice(0, 10));
			if (e.type === "user") users++;
			if (e.type === "reply") {
				replies++;
				if (
					typeof e.latencyMs === "number" &&
					Number.isFinite(e.latencyMs) &&
					e.latencyMs >= 0
				)
					latency.push(e.latencyMs);
			}
			if (e.type === "proactive") {
				proactive++;
				if (typeof e.ticketId === "string") interventions.add(e.ticketId);
			}
			if (
				e.type === "feedback" &&
				feedbackKinds.includes(e.rating as FeedbackKind)
			) {
				const rating = e.rating as FeedbackKind;
				if (rating === "missed") labels.missed++;
				else if (typeof e.target === "string" && interventions.has(e.target))
					latestLabels.set(e.target, rating);
				else malformed++;
			}
		}
		for (const [target, rating] of latestLabels) {
			labels[rating]++;
			targets.add(`${s}:${target}`);
		}
	}
	return {
		version: 1,
		sessions: sessions.length,
		activeDays: dates.size,
		firstDay: [...dates].sort()[0] ?? null,
		lastDay: [...dates].sort().at(-1) ?? null,
		userTurns: users,
		replies,
		proactive,
		labels,
		labeledInterventions: targets.size,
		unlabeledInterventions: proactive - targets.size,
		replyLatency: {
			n: latency.length,
			medianMs: percentile(latency, 0.5),
			p95Ms: percentile(latency, 0.95),
		},
		malformed,
		limitations: [
			"Local sessions do not identify independent users.",
			"Unlabeled interventions have unknown usefulness.",
			"Missed opportunities are self-reports; no opportunity recall denominator.",
			"Reply latency is completion time, not time to first token.",
		],
	};
}
