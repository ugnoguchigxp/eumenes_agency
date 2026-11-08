/**
 * eumenes_memory for real, for the agenda agent. The Memory host package that Eumenes installs
 * (vendor/host-manifest.json) owns a store in a directory of its own, served in this process. The
 * steward registers each new user utterance as a source; the memory's own planner (the host's
 * instructions and schema, with the model given as `complete`) decides what to remember, correct
 * or forget, and the host checks every quote against the source before it applies the plan. The
 * agent reads the active items (`known`).
 *
 * The glue mirrors the host CLI's natural-language plan (natural.js), which the package does not
 * export: the selection and the wording stay with the memory's prompts, never with this file.
 * The host's recall answers a question from the memory; it does not pick related items, so the
 * agent does not use it.
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
	initialize,
	readProfile,
	request,
	startStandalone,
	type HostResult,
	type Profile,
} from "eumenes-memory-host";
import { modelItems } from "eumenes-memory-host/meaning/model-input";
import {
	parsePlan,
	planningSchema,
} from "eumenes-memory-host/meaning/planning";
import type { Action, Complete } from "eumenes-memory-host/meaning/protocol";
import type { KnownItem } from "../../../src/agenda/index.ts";
import type { Steward } from "./memory.ts";

export type { Complete } from "eumenes-memory-host/meaning/protocol";

const SCOPE = "personal";

/** The store's State item as the host returns it (the fields this file reads). */
interface StateRow {
	readonly itemId: string;
	readonly kind: string;
	readonly subject: string;
	readonly value: { readonly text: string; readonly polarity: string };
	readonly evidenceStatus?: string;
}

/** What the host CLI tells the planner about evidence (natural.js, eumenes-memory-host 0.1.0). */
const evidenceInstructions =
	"Return proposal plus evidence for executable remember actions only. Evidence occurrence is the zero-based occurrence of that exact action quote in source, counting overlapping matches. Choose the supporting occurrence explicitly. No source means no remember. Use [] evidence for same/conflicts/forget. Do not auto-apply.";

const decisionOutput = z.strictObject({
	proposal: z.unknown(),
	evidence: z
		.array(
			z.strictObject({
				actionIndex: z.number().int().min(0).max(7),
				occurrence: z.number().int().nonnegative(),
			}),
		)
		.max(8),
});

const fail = (r: HostResult, what: string) =>
	new Error(`${what}: ${r.status}${r.code ? ` ${r.code}` : ""}`);

/** The last sentence of an utterance (its question, usually), at most 120 characters. */
const lastSentence = (text: string) => {
	const parts = text
		.split(/(?<=[。！？!?])/u)
		.map((x) => x.trim())
		.filter((x) => x !== "");
	return (parts.at(-1) ?? text).slice(-120);
};

/** Opens (or creates) the store in `dir` and serves it on a socket inside it until `close`. */
export async function openHostMemory(input: {
	readonly dir: string;
	readonly complete: Complete;
	/** Local time as the user would say it, so the planner can place "明日" and the like. */
	readonly clock?: (now: number) => string;
}) {
	mkdirSync(input.dir, { recursive: true });
	const profilePath = join(input.dir, "profile.json");
	const profile: Profile = existsSync(profilePath)
		? readProfile(profilePath)
		: initialize(input.dir);
	const owner = await startStandalone(input.dir);
	const call = (method: string, params: unknown) =>
		request(profile, method, params);

	/** The whole authorized snapshot, page by page (the planner needs all of it). */
	const snapshot = async () => {
		let page = await call("context", { scopeKeys: [SCOPE] });
		if (page.status !== "context") throw fail(page, "context");
		const items = [...(page["items"] as StateRow[])];
		const id = page["snapshotId"] as string;
		while (page["nextCursor"]) {
			page = await call("context", { cursor: page["nextCursor"] });
			if (page.status !== "context") throw fail(page, "context");
			items.push(...(page["items"] as StateRow[]));
		}
		if (
			(page["coverage"] as { complete?: boolean } | undefined)?.complete !==
			true
		)
			throw new Error("context: incomplete snapshot");
		return { id, items };
	};

	// Short handles for the agent (memory:<alias>); the store's ids are "state:<uuid>". Eight hex
	// digits keep a clash unlikely (about 1 in a million at 100 items) and the handle stable.
	const aliasOf = (itemId: string) =>
		`m${itemId.replace(/^.*:/u, "").replace(/-/gu, "").slice(0, 8)}`;
	const textOf = (i: StateRow) =>
		i.value.polarity === "negated" ? `${i.value.text}（否定）` : i.value.text;
	let rows: StateRow[] = [];
	const refresh = async () => {
		rows = (await snapshot()).items;
	};
	try {
		await refresh();
	} catch (e) {
		await owner.close();
		throw e;
	}

	const describe = (a: Action) =>
		a.type === "forget"
			? `forget ${aliasOf(a.itemId)}`
			: a.replacesItemId
				? `update ${aliasOf(a.replacesItemId)}: ${a.value.text}`
				: `remember: ${a.value.text}`;

	const steward: Steward = async (r) => {
		const started = performance.now();
		let inputTokens = 0;
		let outputTokens = 0;
		let called = false;
		let attempted = false;
		const applied: string[] = [];
		const rejected: string[] = [];
		const fresh = r.said.filter(
			(s) => s.who === "user" && r.fresh.includes(s.id),
		);
		for (const s of fresh) {
			try {
				const src = await call("source", {
					submissionId: `${s.id}-${randomUUID()}`,
					scopeKey: SCOPE,
					content: s.text,
				});
				if (src.status !== "registered") throw fail(src, "source");
				const view = await snapshot();
				const items = modelItems(view.items as never, [], { provenance: true });
				// What the user answered: the agent's words right before (its own speech too), cut to
				// the last sentence so a note it quoted does not reach the planner.
				const before = r.said[r.said.indexOf(s) - 1];
				const message = [
					input.clock ? `今: ${input.clock(r.at)}` : null,
					before && before.who !== "user"
						? `エージェントの直前の発言（資料）: ${lastSentence(before.text)}`
						: null,
					`利用者の発言: ${s.text}`,
				]
					.filter((x) => x !== null)
					.join("\n");
				const schema = {
					type: "object",
					additionalProperties: false,
					required: ["proposal", "evidence"],
					properties: {
						proposal: planningSchema(
							items.map((x) => x.itemId),
							{ quoteMode: "range" },
						),
						evidence: {
							type: "array",
							maxItems: 8,
							items: {
								type: "object",
								additionalProperties: false,
								required: ["actionIndex", "occurrence"],
								properties: {
									actionIndex: { type: "integer", minimum: 0, maximum: 7 },
									occurrence: { type: "integer", minimum: 0 },
								},
							},
						},
					},
				};
				called = true;
				const res = await input.complete(
					JSON.stringify({
						task: "decide",
						message,
						items,
						source: s.text,
						outputInstructions: evidenceInstructions,
					}),
					schema,
					"decide",
				);
				inputTokens += res.usage?.input_tokens ?? 0;
				outputTokens += res.usage?.output_tokens ?? 0;
				const out = decisionOutput.parse(JSON.parse(res.raw));
				const parsed = parsePlan(JSON.stringify(out.proposal), items, "");
				const writes = parsed.changes.filter((c) =>
					c.actions.some((a) => a.type === "remember" || a.type === "forget"),
				);
				if (writes.length === 0) {
					if (parsed.clarification)
						rejected.push(`clarify: ${parsed.clarification}`);
					continue;
				}
				// The host checks each quote against the source by byte range.
				const evidence = out.evidence.map((e) => {
					const action = parsed.changes.find(
						(c) => c.actionIndex === e.actionIndex,
					)?.actions[0];
					if (action?.type !== "remember" || action.quote === "")
						throw new Error("evidence without a remember action");
					let at = -1;
					for (let i = 0; i <= e.occurrence; i++) {
						at = s.text.indexOf(action.quote, at + 1);
						if (at < 0) throw new Error("quote not in the user's words");
					}
					return {
						actionIndex: e.actionIndex,
						sourceHandle: src["sourceHandle"] as string,
						startByte: Buffer.byteLength(s.text.slice(0, at)),
						endByte: Buffer.byteLength(
							s.text.slice(0, at + action.quote.length),
						),
					};
				});
				const plan = await call("plan", {
					snapshotId: view.id,
					scopeKey: SCOPE,
					proposal: out.proposal,
					evidence,
				});
				if (typeof plan["planId"] !== "string") throw fail(plan, "plan");
				// The CLI leaves apply to its user; here the agent's writer applies what the host's
				// checks let through, as Eumenes' steward does.
				attempted = true;
				const done = await call("apply", {
					planId: plan["planId"],
					operationId: randomUUID(),
					epoch: plan["epoch"],
				});
				// The host applies group by group: report each group by what happened to it, so a
				// partial or clarifying result still shows what was written.
				const groups = Array.isArray(done["groups"])
					? (done["groups"] as string[])
					: [];
				parsed.groups.forEach((indexes, g) => {
					const lines = indexes.flatMap((i) =>
						(
							parsed.changes.find((c) => c.actionIndex === i)?.actions ?? []
						).map(describe),
					);
					if (lines.length === 0) return;
					if (groups[g] === "applied") applied.push(...lines);
					else rejected.push(`${groups[g] ?? "not_run"}: ${lines.join(" / ")}`);
				});
				if (done.status !== "completed")
					rejected.push(fail(done, "apply").message);
				if (parsed.clarification)
					rejected.push(`clarify: ${parsed.clarification}`);
			} catch (e) {
				rejected.push(e instanceof Error ? e.message : String(e));
			}
		}
		// After any apply (even one that failed on the way), read the store again: what it holds
		// is what the agent sees, whatever the reply said.
		let changed = false;
		if (attempted) {
			const before = JSON.stringify(rows);
			try {
				await refresh();
			} catch (e) {
				rejected.push(e instanceof Error ? e.message : String(e));
			}
			changed = JSON.stringify(rows) !== before;
		}
		return {
			changed,
			applied,
			rejected,
			usage: called
				? {
						latencyMs: performance.now() - started,
						inputTokens,
						outputTokens,
					}
				: null,
		};
	};

	return {
		/** The active items, as of the last write (what the agent reads; eumenes_memory's State). */
		known: (): KnownItem[] =>
			rows.map((i) => ({ id: aliasOf(i.itemId), text: textOf(i) })),
		all: () =>
			rows.map((i) => ({
				id: aliasOf(i.itemId),
				text: textOf(i),
				kind: i.kind,
				active: true,
			})),
		steward,
		close: () => owner.close(),
	};
}
export type HostMemory = Awaited<ReturnType<typeof openHostMemory>>;
