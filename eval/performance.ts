/** Local load probes, no models, no credentials, no user conversation data. */
import {
	createAgencyRuntime,
	defaultBudget,
	type LlmPort,
} from "../src/index.ts";
const quantiles = (xs: number[]) => {
	const s = [...xs].sort((a, b) => a - b);
	return {
		n: s.length,
		medianMs: s[Math.ceil(s.length * 0.5) - 1],
		p95Ms: s[Math.ceil(s.length * 0.95) - 1],
		maxMs: s.at(-1),
	};
};
const inert: LlmPort = {
	async complete() {
		throw new Error("unexpected model call");
	},
};
const rows = [];
for (const n of [100, 1000, 10000]) {
	const rt = createAgencyRuntime({
		condition: "B0",
		systemContext: "experimental",
		llm: inert,
		tools: [],
	});
	const start = performance.now();
	for (let i = 0; i < n; i++)
		rt.observe({
			id: `o${i}`,
			kind: "exchange.adopted",
			actor: "user",
			occurredAt: i,
			text: "合成の負荷入力。".repeat(30),
		});
	const appendMs = performance.now() - start;
	const snapshot: number[] = [],
		restore: number[] = [];
	let bytes = 0;
	for (let i = 0; i < 100; i++) {
		const a = performance.now();
		const s = rt.snapshot();
		snapshot.push(performance.now() - a);
		bytes = new TextEncoder().encode(JSON.stringify(s)).byteLength;
		const b = performance.now();
		createAgencyRuntime({
			condition: "B0",
			systemContext: "experimental",
			llm: inert,
			tools: [],
			restore: s,
		});
		restore.push(performance.now() - b);
	}
	let capacityRefused = false;
	if (n === 10000) {
		try {
			rt.observe({
				id: "overflow",
				kind: "exchange.adopted",
				actor: "user",
				occurredAt: n,
				text: "overflow",
			});
		} catch {
			capacityRefused = rt.snapshot().observations.length === n;
		}
	}
	rows.push({
		observations: n,
		appendMs,
		snapshotBytes: bytes,
		snapshot: quantiles(snapshot),
		restore: quantiles(restore),
		capacityRefused,
	});
}
const cancel: number[] = [];
for (let i = 0; i < 100; i++) {
	let entered!: () => void;
	const ready = new Promise<void>((r) => {
		entered = r;
	});
	// Intentionally uncooperative transport: the shared call mechanism must release the logical lane.
	const llm: LlmPort = {
		complete() {
			entered();
			return new Promise(() => {});
		},
	};
	const rt = createAgencyRuntime({
		condition: "B1",
		systemContext: "experimental",
		llm,
		tools: [],
		budget: { ...defaultBudget, minIntervalMs: 0 },
	});
	rt.observe({
		id: "o",
		kind: "user.report",
		actor: "user",
		occurredAt: 0,
		text: "fixture",
	});
	const ac = new AbortController();
	const call = rt.runBackground(0, ac.signal);
	await ready;
	const start = performance.now();
	ac.abort();
	await call;
	cancel.push(performance.now() - start);
}
console.log(
	JSON.stringify(
		{
			version: 1,
			kind: "synthetic-local",
			bun: Bun.version,
			platform: process.platform,
			arch: process.arch,
			rows,
			cancellation: quantiles(cancel),
			rssBytes: process.memoryUsage().rss,
			limitations: [
				"No foreground API streaming or background contention comparison.",
				"RSS is process-wide peak-at-end, not a per-operation allocation budget.",
				"10000 is the declared count limit; 100000 is intentionally rejected.",
			],
		},
		null,
		2,
	),
);
