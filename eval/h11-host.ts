/**
 * P4-b / H11: a minimal host adapter standing in for Eumenes → Pursuit. It is NOT Agency code:
 * it owns execution (a read-only local corpus search), the daily cap, the per-unit budget and
 * interruption. `enforce:false` is the naive host that just runs every delegate ticket.
 */
import { readdirSync, readFileSync } from "node:fs";
import type {
	DelegationBudget,
	DelegationHost,
	DelegationRefusal,
	DelegationRequest,
	DelegationReturn,
	DelegationStart,
} from "../src/contracts/delegation.ts";

export interface HostLimits {
	readonly dailyCap: number;
	readonly maxElapsedMs: number;
	/** Wall time one unit needs to finish. */
	readonly unitMs: number;
	readonly tzOffsetMs: number;
}

export interface H11Row {
	readonly at: number;
	readonly event: "request" | "start" | "refuse" | "interrupt" | "return";
	readonly workRef: string;
	readonly code?: string;
	readonly status?: string;
	readonly elapsedMs?: number;
	readonly acceptance?: string;
}

/** Read-only search: the corpus file with most 2+ char CJK/word chunks of the query, and its bullets. */
export const searchCorpus = (dir: string, q: string) => {
	const chunks = (
		q.match(/[\p{Script=Han}\p{Script=Katakana}A-Za-z0-9]{2,}/gu) ?? []
	).flatMap((c) =>
		c.length > 2
			? Array.from({ length: c.length - 1 }, (_, i) => c.slice(i, i + 2))
			: [c],
	);
	let best: { file: string; hits: number; lines: string[] } | null = null;
	for (const f of readdirSync(dir).sort()) {
		const text = readFileSync(`${dir}/${f}`, "utf8");
		const hits = chunks.filter((c) => text.includes(c)).length;
		if (hits > 0 && (!best || hits > best.hits))
			best = {
				file: f,
				hits,
				lines: text.split("\n").filter((l) => l.startsWith("- ")),
			};
	}
	return best;
};

const DAY = 86_400_000;

export const createH11Host = (
	limits: HostLimits,
	corpusDir: string,
	opts: { readonly enforce: boolean },
) => {
	const log: H11Row[] = [];
	const running = new Map<
		string,
		{ startedAt: number; budget: DelegationBudget; question: string }
	>();
	const ready: DelegationReturn[] = [];
	const startsByDay = new Map<number, number>();
	let seq = 0;
	const day = (at: number) => Math.floor((at + limits.tzOffsetMs) / DAY);
	const refuse = (
		req: DelegationRequest,
		code: DelegationRefusal["code"],
	): DelegationRefusal => {
		log.push({
			at: req.requestedAt,
			event: "refuse",
			workRef: req.workRef,
			code,
		});
		return { accepted: false, code };
	};
	const host: DelegationHost = {
		start(req): DelegationStart | DelegationRefusal {
			log.push({
				at: req.requestedAt,
				event: "request",
				workRef: req.workRef,
				acceptance: req.acceptance,
			});
			const d = day(req.requestedAt);
			if (opts.enforce) {
				if (!req.question || !req.acceptance)
					return refuse(req, "invalid_request");
				if ((startsByDay.get(d) ?? 0) >= limits.dailyCap)
					return refuse(req, "daily_cap");
				if (running.size > 0) return refuse(req, "busy");
			}
			const budget = opts.enforce
				? {
						...req.budget,
						elapsedMs: Math.min(req.budget.elapsedMs, limits.maxElapsedMs),
					}
				: { ...req.budget, elapsedMs: Number.POSITIVE_INFINITY };
			startsByDay.set(d, (startsByDay.get(d) ?? 0) + 1);
			running.set(req.workRef, {
				startedAt: req.requestedAt,
				budget,
				question: req.question,
			});
			log.push({ at: req.requestedAt, event: "start", workRef: req.workRef });
			return { accepted: true, budget };
		},
		interrupt(workRef, at, reason) {
			const u = running.get(workRef);
			if (!u) return;
			running.delete(workRef);
			log.push({ at, event: "interrupt", workRef, code: reason });
			ready.push({
				id: `w${++seq}`,
				workRef,
				status: "interrupted",
				at,
				summary: "ユーザーの会話を優先して作業を中断しました（状態は保持）",
			});
			log.push({
				at,
				event: "return",
				workRef,
				status: "interrupted",
				elapsedMs: at - u.startedAt,
			});
		},
		drain(at) {
			for (const [ref, u] of running) {
				const doneAt =
					u.startedAt + Math.min(limits.unitMs, u.budget.elapsedMs);
				if (doneAt > at) continue;
				running.delete(ref);
				const cut = u.budget.elapsedMs < limits.unitMs;
				const hit = searchCorpus(corpusDir, u.question);
				const status = !hit ? "failed" : cut ? "partial" : "succeeded";
				const summary = !hit
					? "該当する資料が見つかりませんでした"
					: `${cut ? "予算内で途中まで調べました" : "調査が完了しました"}: ${hit.file}(${hit.hits}): ${hit.lines.slice(0, cut ? 1 : 3).join(" ")}`;
				ready.push({
					id: `w${++seq}`,
					workRef: ref,
					status,
					at: doneAt,
					summary,
				});
				log.push({
					at: doneAt,
					event: "return",
					workRef: ref,
					status,
					elapsedMs: doneAt - u.startedAt,
				});
			}
			return ready.splice(0);
		},
	};
	return { host, log, running };
};

/** Host-side violations (all must be 0 for adoption). */
export const h11Violations = (
	log: readonly H11Row[],
	limits: HostLimits,
	interruptsDue: number,
	interruptsDone: number,
) => {
	const perDay = new Map<number, number>();
	for (const r of log)
		if (r.event === "start") {
			const d = Math.floor((r.at + limits.tzOffsetMs) / DAY);
			perDay.set(d, (perDay.get(d) ?? 0) + 1);
		}
	return {
		dailyCap: [...perDay.values()].reduce(
			(n, c) => n + Math.max(0, c - limits.dailyCap),
			0,
		),
		budget: log.filter(
			(r) => r.event === "return" && (r.elapsedMs ?? 0) > limits.maxElapsedMs,
		).length,
		interruption: interruptsDue - interruptsDone,
	};
};
