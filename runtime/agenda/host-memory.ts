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
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { z } from "zod";
import type { SourceRef } from "eumenes-memory";
import {
	initialize,
	methodSchemas,
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
import type { KnownItem } from "../../src/agenda/index.ts";

export type { Complete } from "eumenes-memory-host/meaning/protocol";

/** One pass of the memory's writer over the latest exchange. */
export interface StewardInput {
	readonly said: readonly { id: string; who: string; text: string }[];
	/** Words not seen in an earlier pass: only these can be evidence. */
	readonly fresh: readonly string[];
	readonly at: number;
}
export interface StewardResult {
	changed: boolean;
	applied: string[];
	rejected: string[];
	usage: {
		latencyMs: number;
		inputTokens: number;
		outputTokens: number;
	} | null;
}
/** The memory's writer (Eumenes' steward): this mock, or the real memory's (host-memory.ts). */
export type Steward = (r: StewardInput) => Promise<StewardResult>;
const SCOPE = "personal";
// The older vendored host has a strict source schema without provenance.
const supportsSourceProvenance = Object.hasOwn(
	methodSchemas.source.shape,
	"provenance",
);

/** The store's State item as the host returns it (the fields this file reads). */
interface StateRow {
	readonly itemId: string;
	readonly scopeKey: string;
	readonly revision: number;
	readonly evidence: readonly SourceRef[];
	readonly kind: string;
	readonly subject: string;
	readonly value: { readonly text: string; readonly polarity: string };
	readonly evidenceStatus?: string;
}

export interface GoalMemoryRef {
	readonly id: string;
	readonly scopeKey: string;
	readonly revision: number;
	readonly sources: readonly SourceRef[];
	readonly fingerprint?: string;
}

export function coversGoalMemory(
	shown: readonly GoalMemoryRef[],
	current: readonly GoalMemoryRef[],
) {
	const byId = new Map(current.map((ref) => [ref.id, JSON.stringify(ref)]));
	return shown.every((ref) => byId.get(ref.id) === JSON.stringify(ref));
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

type GoalMemoryCall = (
	method: "context" | "read",
	params: unknown,
) => Promise<HostResult>;

/** Recheck a read on the shared writer, or immediately before starting the mock. */
export type GoalMemoryGuard = (db?: Database) => boolean;

interface AgendaRow {
	readonly itemId: string;
	readonly scopeKey: string;
	readonly updatedAtMs: number;
	readonly evidence: SourceRef;
	readonly kind: string;
	readonly text: string;
	readonly status: string;
	readonly sourceRole: string;
	readonly certainty: string;
	readonly time: unknown;
	readonly trigger: unknown;
}

const supportsAgenda = Object.hasOwn(methodSchemas.context.shape, "agenda");
const textOf = (item: StateRow) =>
	item.value.polarity === "negated"
		? `${item.value.text}（否定）`
		: item.value.text;

async function readSnapshot(
	call: GoalMemoryCall,
	scopeKey: string,
	limit?: number,
) {
	const agenda = limit !== undefined && supportsAgenda ? { agenda: true } : {};
	let page = await call("context", { scopeKeys: [scopeKey], limit, ...agenda });
	if (page.status !== "context") throw fail(page, "context");
	const id = page["snapshotId"] as string;
	const items: StateRow[] = [];
	const agendaItems: AgendaRow[] = [];
	for (;;) {
		items.push(...(page["items"] as StateRow[]));
		agendaItems.push(...((page["agendaItems"] ?? []) as AgendaRow[]));
		if (!page["nextCursor"]) break;
		page = await call("context", {
			cursor: page["nextCursor"],
			limit,
			...agenda,
		});
		if (page.status !== "context") throw fail(page, "context");
	}
	if (
		(page["coverage"] as { complete?: boolean } | undefined)?.complete !== true
	)
		throw new Error("context: incomplete snapshot");
	return { id, items, agendaItems };
}

function goalItem(
	row: StateRow | AgendaRow,
): (GoalMemoryRef & { text: string }) | null {
	if ("value" in row) {
		if (row.evidenceStatus !== "current" || !row.evidence.length) return null;
		return {
			id: row.itemId,
			scopeKey: row.scopeKey,
			revision: row.revision,
			sources: row.evidence,
			text: textOf(row),
		};
	}
	if (row.status !== "pending" || !row.evidence) return null;
	const text = JSON.stringify({
		kind: row.kind,
		text: row.text,
		certainty: row.certainty,
		time: row.time,
		trigger: row.trigger,
		sourceRole: row.sourceRole,
	});
	return {
		id: row.itemId,
		scopeKey: row.scopeKey,
		revision: row.updatedAtMs,
		sources: [row.evidence],
		text,
		fingerprint: createHash("sha256").update(text).digest("hex"),
	};
}

const withoutText = ({
	text: _text,
	...ref
}: GoalMemoryRef & { text: string }) => ref;

/** Reads goal evidence through the public Memory connection, including standalone Memory. */
export function createGoalMemory(
	call: GoalMemoryCall,
	serialize: <T>(operation: () => Promise<T>) => Promise<T> = (operation) =>
		operation(),
	snapshotCurrent?: (snapshotId: string, db?: Database) => boolean,
) {
	const inspect = async (id: string, itemId: string) => {
		const result = await call("read", { snapshotId: id, itemId });
		if (result.status !== "found") throw fail(result, "read goal memory");
		const row = result["item"] as StateRow | AgendaRow;
		if (!("value" in row)) {
			const sources = result["sources"] as { status: string }[] | undefined;
			if (
				!sources?.length ||
				sources.some(
					({ status }) => status !== "available" && status !== "registered",
				)
			)
				return null;
		}
		return goalItem(row);
	};
	const current = async (scopeKey: string) => {
		const { id, items, agendaItems } = await readSnapshot(call, scopeKey, 20);
		const state = items
			.filter((row) => row.scopeKey === scopeKey)
			.flatMap((row) => goalItem(row) ?? []);
		const agenda = await Promise.all(
			agendaItems
				.filter((row) => row.scopeKey === scopeKey && row.status === "pending")
				.map((row) => inspect(id, row.itemId)),
		);
		return { id, items: [...state, ...agenda.flatMap((row) => row ?? [])] };
	};
	const views = new Map<string, Awaited<ReturnType<typeof current>>>();
	return {
		goalContext: (scopeKey: string) =>
			serialize(async () => {
				let view = views.get(scopeKey);
				if (
					!view ||
					(await call("read", { snapshotId: view.id })).status !== "found"
				) {
					view = await current(scopeKey);
					views.set(scopeKey, view);
				}
				return view.items;
			}),
		withGoalMemory: <T>(
			scopeKey: string,
			shown: readonly GoalMemoryRef[],
			used: readonly string[],
			run: (valid: boolean, stillCurrent: GoalMemoryGuard) => Promise<T>,
			allowAdditional = false,
		) =>
			serialize(async () => {
				const view = await current(scopeKey);
				if (
					(!allowAdditional && view.items.length !== shown.length) ||
					!coversGoalMemory(shown, view.items.map(withoutText))
				)
					return run(false, () => false);
				for (const itemId of new Set(used)) {
					const item = await inspect(view.id, itemId);
					const prior = shown.find((ref) => ref.id === itemId);
					if (
						!item ||
						!prior ||
						!coversGoalMemory([prior], [withoutText(item)])
					)
						return run(false, () => false);
				}
				const snapshot = await call("read", { snapshotId: view.id });
				if (snapshot.status !== "found")
					throw fail(snapshot, "read goal snapshot");
				return run(true, (db) => snapshotCurrent?.(view.id, db) ?? true);
			}),
	};
}

export type GoalMemory = ReturnType<typeof createGoalMemory>;

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
	readonly scopeKeys?: readonly string[];
	/** Local time as the user would say it, so the planner can place "明日" and the like. */
	readonly clock?: (now: number) => string;
}) {
	mkdirSync(input.dir, { recursive: true });
	const profilePath = join(input.dir, "profile.json");
	const profile: Profile = existsSync(profilePath)
		? readProfile(profilePath)
		: initialize(
				input.dir,
				input.scopeKeys?.length ? [...input.scopeKeys] : undefined,
			);
	const defaultScope =
		input.scopeKeys === undefined ? SCOPE : input.scopeKeys[0];
	const owner = await startStandalone(input.dir);
	const call = (method: string, params: unknown) =>
		request(profile, method, params);

	const snapshot = (scopeKey: string) => readSnapshot(call, scopeKey);

	// Short handles for the agent (memory:<alias>); the store's ids are "state:<uuid>". Eight hex
	// digits keep a clash unlikely (about 1 in a million at 100 items) and the handle stable.
	const aliasOf = (itemId: string) =>
		`m${itemId.replace(/^.*:/u, "").replace(/-/gu, "").slice(0, 8)}`;
	// Hold memory writes through the currentness check and the host's adoption/dispatch.
	let pending: Promise<unknown> = Promise.resolve();
	const serialized = <T>(operation: () => Promise<T>) => {
		const next = pending.then(operation);
		pending = next.catch(() => {});
		return next;
	};
	const goals = createGoalMemory(call, serialized);

	let rows: StateRow[] = [];
	const refresh = async () => {
		rows = defaultScope ? (await snapshot(defaultScope)).items : [];
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

	const write = async (r: Parameters<Steward>[0], scopeKey: string) => {
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
					scopeKey,
					content: s.text,
					...(supportsSourceProvenance ? { provenance: "user_message" } : {}),
				});
				if (src.status !== "registered") throw fail(src, "source");
				const view = await snapshot(scopeKey);
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
					scopeKey,
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
		let changed = scopeKey !== defaultScope && applied.length > 0;
		if (attempted && scopeKey === defaultScope) {
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
		steward: (r: Parameters<Steward>[0], scopeKey = defaultScope ?? SCOPE) =>
			serialized(() => write(r, scopeKey)),
		...goals,
		close: async () => {
			await pending;
			await owner.close();
		},
	};
}
export type HostMemory = Awaited<ReturnType<typeof openHostMemory>>;
