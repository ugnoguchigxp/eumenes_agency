/** Reproducible local performance gate; scripted models, no API or CI. */
const { createAgencyRuntime, defaultBudget, emptyState, prepareCompaction } =
	await import("../src/index.ts");
const { fakeLlm, proposal, participation, opportunity, obsInput } =
	await import("../test/core/helpers.ts");
const thresholds = {
	updateSelectP95Ms: 50,
	compactP95Ms: 50,
	metadataBytes: 1024 * 1024,
};
const llm = fakeLlm();
const state = emptyState();
for (let i = 0; i < 32; i++)
	state.notes.push({
		id: "n" + i,
		revision: 1,
		text: "合成の未解決事項" + i,
		evidence: ["o1"],
	});
const observations = Array.from({ length: 1000 }, (_, i) => ({
	...obsInput(
		"o" + (i + 1),
		"user.report",
		"user",
		i,
		"合成の会話原文。".repeat(30),
	),
	seq: i + 1,
}));
const restore: import("../src/index.ts").AgencySnapshot = {
	condition: "B1",
	state,
	observations,
	cursor: 1000,
	provenance: {
		version: 1,
		entries: state.notes.map((n) => [
			"note:" + n.id,
			{ sources: ["o1"], complete: true },
		]),
	},
};
const rt = createAgencyRuntime({
	condition: "B1",
	systemContext: "experimental",
	llm,
	tools: [],
	restore,
	budget: { ...defaultBudget, maxCallsPerWindow: 1000, minIntervalMs: 0 },
});
const times: number[] = [],
	compact: number[] = [];
const ac = new AbortController();
for (let i = 0; i < 100; i++) {
	const prev = rt.snapshot();
	const note = prev.state.notes[i % 32]!;
	rt.observe(
		obsInput("new" + i, "user.report", "user", 1000 + i, "別の合成材料" + i),
	);
	llm.push(
		"update",
		proposal([
			{
				op: "note.update",
				id: note.id,
				expectedRevision: note.revision,
				text: "更新された合成事項" + i,
				evidenceRefs: ["new" + i],
			},
		]),
	);
	llm.push("select", participation({ action: "wait" }));
	const start = performance.now();
	const outcomes = await rt.runBackground(1000 + i, ac.signal);
	await rt.decide(opportunity("p" + i, 1000 + i), ac.signal);
	times.push(performance.now() - start);
	if (
		outcomes.some(
			(r) => r.code.startsWith("rejected") || r.code.startsWith("error"),
		)
	)
		throw Error(JSON.stringify(outcomes));
	const c = performance.now();
	prepareCompaction(rt.snapshot(), 64);
	compact.push(performance.now() - c);
}
const q = (x: number[]) => {
	const s = [...x].sort((a, b) => a - b);
	return { n: s.length, medianMs: s[49], p95Ms: s[94], maxMs: s[99] };
};
const result = {
	thresholds,
	updateSelect: q(times),
	compaction: q(compact),
	metadataBytes: new TextEncoder().encode(
		JSON.stringify(rt.snapshot().provenance),
	).byteLength,
	limit:
		"Local 32-note/1000-observation B1 fixture, scripted LLM; network/TTFT and production contention excluded",
};
if (
	result.updateSelect.p95Ms! > 50 ||
	result.compaction.p95Ms! > 50 ||
	result.metadataBytes > thresholds.metadataBytes
)
	process.exitCode = 1;
console.log(JSON.stringify(result));

export {};
