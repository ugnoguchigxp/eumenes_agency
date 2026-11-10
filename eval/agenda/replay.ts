/**
 * Replay of the real CLI logs (data/chats/2026-11-10T*-agenda.jsonl) through the agent as it is
 * now. Review 2026-11-10 evening §6-1(b): the scenarios of scenarios.ts do not hold the topics
 * where the CLI went wrong (weather, showtimes, a purchase, a pet, a sudden change of topic, many
 * notes), so each log's user lines are played back at the times the user sent them, and the
 * agent's side is whatever the agent does now.
 *
 *  - The user: the log's lines and times, as they are (the scripted turns of sim.ts; no
 *    simulated user, so no `felt` events and nobody answers the agent's questions but the log).
 *  - The reply: real (the main model, its prompt and tools), as in live.ts.
 *  - Research: live.ts's `--mock-research` stand-in (the background model without the web; work
 *    for a toolchain goes to its mock), two minutes of virtual time.
 *  - The clock: the log's own (epoch milliseconds, Asia/Tokyo), so a note's age and "今日" are as
 *    they were.
 *  - The state at the log's start:
 *      notes    the files of data/agenda/notes made before the session started (ids kept);
 *      memory   the real eumenes_memory store starts empty (its writer runs on the replayed lines),
 *               and the items the CLI's store held at that moment (data/agenda/memory-host, read
 *               from a copy; items first asserted before the start and still active then) are
 *               shown to the agent beside it under their real aliases. The writer does not see
 *               them, so it may write one again, and the agent cannot update or forget one;
 *      profile  the plans-and-interests note rebuilt by applying the `profile` events of every
 *               earlier agenda log (add / update / remove) in order. Rebuilding all the logs
 *               gives data/agenda/profile.md line for line. Edits the user made by hand between
 *               sessions are not in it;
 *      not restored: the agenda-state.json (promises and quiet time carried across a restart) and
 *               the talk before the log (the CLI does not keep it either).
 *
 * Output: data/agenda/replay/<name>/<log>.<sample>.jsonl (the sim's events), beside it
 * <log>.<sample>.topic.json (the topic check) and <log>.<sample>.summary.json (cost, the state at
 * the start). Cost is recorded, never capped. Measurement only.
 *
 *   zsh -l scripts/api-entry.zsh eval/agenda/replay.ts run <name> [--samples N] [--jobs N] [log...]
 *   bun eval/agenda/replay.ts compare <name> [<name>...]
 *
 * A log is named by a part of its file name ("10-06" for the 10:06 UTC one); none: all four.
 */
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { Database } from "bun:sqlite";
import { z } from "zod";
import { runRespond, type LlmPort } from "../../src/index.ts";
import {
	createProviderLlm,
	createProviderReply,
} from "../../standalone/providers.ts";
import { loadSettings } from "../../standalone/settings.ts";
import { openUncappedMeter } from "../../standalone/always-on-host.ts";
import {
	agendaReplyMessages,
	dropRepeatedSentences,
} from "../../standalone/agenda-reply.ts";
import { memoryModel } from "../../standalone/agenda-memory.ts";
import { createClaudeClient } from "../../standalone/claude.ts";
import { createMockDocStore } from "../../examples/virtual-eumenes/agenda/docs.ts";
import { openHostMemory } from "../../examples/virtual-eumenes/agenda/host-memory.ts";
import { createProfileNote } from "../../examples/virtual-eumenes/agenda/profile.ts";
import {
	createMockWebResearch,
	llmWriter,
	mockToolchainWork,
} from "../../examples/virtual-eumenes/agenda/research.ts";
import type { KnownItem } from "../../src/agenda/index.ts";
import { clockFrom } from "./live.ts";
import { saysTwice, TAKE_BACK } from "./correction-bench.ts";
import { simulateAgenda, type AgendaSimEvent, type UserTurn } from "./sim.ts";
import { clientFor, verifierLlm } from "./verifier.ts";

const CHATS = resolve("data/chats");
const NOTES = resolve("data/agenda/notes");
const MEMORY_DB = resolve("data/agenda/memory-host/memory.db");
const OUT = resolve("data/agenda/replay");

// ---------------------------------------------------------------------------------------------
// Reading a log (pure)
// ---------------------------------------------------------------------------------------------

/** One line of a data/chats/*-agenda.jsonl (the fields this file reads). */
export interface ChatEvent {
	readonly type: string;
	readonly at: number;
	readonly text?: string;
	readonly applied?: readonly string[];
}

/** The events of a log; a line that is not JSON with a type and a time is skipped. */
export function parseChatLog(text: string): ChatEvent[] {
	const out: ChatEvent[] = [];
	for (const line of text.split("\n")) {
		if (line.trim() === "") continue;
		try {
			const e = JSON.parse(line) as Record<string, unknown>;
			if (typeof e["type"] === "string" && typeof e["at"] === "number")
				out.push(e as unknown as ChatEvent);
		} catch {
			// A broken line is not a reason to lose the rest of the log.
		}
	}
	return out;
}

/** When the session began (epoch ms): its `session` event, else the first event. */
export function sessionStartMs(events: readonly ChatEvent[]): number {
	const s = events.find((e) => e.type === "session") ?? events[0];
	if (!s) throw new Error("the log has no events");
	return s.at;
}

/** The user's lines at the times they were sent, in seconds from the session's start. */
export function userTurns(events: readonly ChatEvent[]): UserTurn[] {
	const start = sessionStartMs(events);
	return events
		.filter(
			(e) => e.type === "user" && typeof e.text === "string" && e.text !== "",
		)
		.map((e) => ({ atSec: (e.at - start) / 1000, text: e.text! }))
		.sort((a, b) => a.atSec - b.atSec);
}

/** How long the session ran, in minutes (to its `end` event, else to its last event). */
/** The last element that passes (Array.findLast is past this project's library). */
const lastWhere = <T>(
	xs: readonly T[],
	f: (x: T) => boolean,
): T | undefined => {
	for (let i = xs.length - 1; i >= 0; i--) if (f(xs[i]!)) return xs[i];
	return undefined;
};

export function sessionMinutes(events: readonly ChatEvent[]): number {
	const start = sessionStartMs(events);
	const end =
		lastWhere(events, (e) => e.type === "end")?.at ??
		Math.max(...events.map((e) => e.at));
	return Math.max(1, Math.ceil((end - start) / 60_000));
}

const SECTION_OF: Record<string, "plans" | "interests"> = {
	予定: "plans",
	関心: "interests",
};

/**
 * The plans-and-interests note after the `profile` events of these logs (every log before the
 * one replayed, oldest first), as `add 予定: …`, `update p3: …` and `remove p2: …` say. An id is
 * the line's place in the note: the plans, then the interests.
 */
export function profileLinesFromEvents(events: readonly ChatEvent[]): {
	plans: string[];
	interests: string[];
} {
	const plans: string[] = [];
	const interests: string[] = [];
	const at = (n: number): [string[], number] | null =>
		n < 0 || n >= plans.length + interests.length
			? null
			: n < plans.length
				? [plans, n]
				: [interests, n - plans.length];
	for (const e of events) {
		if (e.type !== "profile") continue;
		for (const a of e.applied ?? []) {
			const add = /^add (予定|関心): (.+)$/su.exec(a);
			if (add) {
				(SECTION_OF[add[1]!] === "plans" ? plans : interests).push(add[2]!);
				continue;
			}
			const update = /^update p(\d+): (.+)$/su.exec(a);
			if (update) {
				const hit = at(Number(update[1]) - 1);
				if (hit) hit[0][hit[1]] = update[2]!;
				continue;
			}
			const remove = /^remove p(\d+)(?::|$)/u.exec(a);
			if (remove) {
				const hit = at(Number(remove[1]) - 1);
				if (hit) hit[0].splice(hit[1], 1);
			}
		}
	}
	return { plans, interests };
}

/** The note as the CLI keeps it (src/agenda/profile.ts: two headings with bullet lines). */
export function renderProfile(lines: {
	plans: readonly string[];
	interests: readonly string[];
}): string {
	const bullets = (xs: readonly string[]) => xs.map((x) => `- ${x}`);
	return [
		"# 利用者の予定と関心",
		"",
		"会話からエージェントが書き、利用者も直せるメモです。記憶に残らない予定、考え中のこと、いま気にしていることを置きます。",
		"",
		"## 予定",
		...bullets(lines.plans),
		"",
		"## 関心",
		...bullets(lines.interests),
		"",
	].join("\n");
}

/** The note files made before `startMs` (the header's `at`): their names. */
export function notesBefore(
	files: readonly { readonly name: string; readonly raw: string }[],
	startMs: number,
): string[] {
	const out: string[] = [];
	for (const f of files) {
		const head = /^<!-- agenda-note (\{.*\}) -->\n/u.exec(f.raw);
		if (!head) continue;
		try {
			const h = JSON.parse(head[1]!) as { at?: unknown };
			if (typeof h.at === "number" && h.at < startMs) out.push(f.name);
		} catch {
			// A note with a broken header is not part of the replay.
		}
	}
	return out;
}

/** The memory's alias for a store item (host-memory.ts `aliasOf`). */
export const memoryAlias = (itemId: string) =>
	`m${itemId.replace(/^.*:/u, "").replace(/-/gu, "").slice(0, 8)}`;

/**
 * The items the CLI's memory held at `startMs`: first asserted before it and active now (an item
 * stopped later is not known; one replaced before the start is not either). Read from a copy of
 * the store, so a CLI running on it is not touched.
 */
export function memoryAt(dbPath: string, startMs: number): KnownItem[] {
	if (!existsSync(dbPath)) return [];
	const dir = mkdtempSync(join(tmpdir(), "rpm-"));
	try {
		const copy = join(dir, "memory.db");
		copyFileSync(dbPath, copy);
		for (const ext of ["-wal", "-shm"])
			if (existsSync(dbPath + ext)) copyFileSync(dbPath + ext, copy + ext);
		const db = new Database(copy, { readonly: true });
		try {
			const rows = db
				.query(
					`SELECT i.item_id AS id, i.value_text AS text, i.polarity AS polarity
					 FROM memory_state_item i
					 JOIN (SELECT item_id, MIN(at_ms) AS at FROM memory_state_event
					       WHERE action = 'assert' GROUP BY item_id) e ON e.item_id = i.item_id
					 WHERE i.status = 'active' AND e.at < ?
					 ORDER BY e.at`,
				)
				.all(startMs) as { id: string; text: string; polarity: string }[];
			return rows.map((r) => ({
				id: memoryAlias(r.id),
				text: r.polarity === "negated" ? `${r.text}（否定）` : r.text,
			}));
		} finally {
			db.close();
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

// ---------------------------------------------------------------------------------------------
// Measuring a replay (pure)
// ---------------------------------------------------------------------------------------------

type E = AgendaSimEvent;

/** A memo's id said aloud (`n87`): the id is the agent's own mark, never the user's word. */
export const SAYS_NOTE_ID = /(?<![A-Za-z0-9_])n\d{1,4}(?![A-Za-z0-9_])/u;

/** The user talked this recently when a question counts as asked in a conversation. */
export const TALKING_SEC = 300;

export interface TalkItem {
	readonly atSec: number;
	readonly kind: "ask" | "talk";
	readonly text: string;
	/** The user's latest two lines before it (oldest first), and how long before. */
	readonly lastUser: readonly { text: string; secAgo: number }[];
	/** The talk just before it (user, reply, own speech), oldest first. */
	readonly before: readonly { who: "user" | "reply" | "agent"; text: string }[];
}

export interface ReplayMetrics {
	/** The user's line → the agent's first own speech after it (before the next line). */
	readonly responseSecs: number[];
	/** Between one own speech and the next. */
	readonly gapSecs: number[];
	readonly speaks: number;
	readonly composes: number;
	/** Utterances written and thrown away (code stale or aborted). */
	readonly composeDropped: number;
	/** plan + compose + check calls (the questions' check leaves no event but a refusal). */
	readonly backgroundCalls: number;
	readonly replies: number;
	/** Replies or own speech that said a note's id. */
	readonly saidId: number;
	/** Replies that told of the same research twice. */
	readonly saidTwice: number;
	/** Replies that took back or denied (correction-bench's TAKE_BACK). */
	readonly tookBack: number;
	/** Own speech while the user was talking (spoke within TALKING_SEC). */
	readonly inTalk: TalkItem[];
}

export function replayMetrics(events: readonly E[]): ReplayMetrics {
	const users = events.filter(
		(e): e is Extract<E, { type: "user" }> => e.type === "user",
	);
	const speaks = events.filter(
		(e): e is Extract<E, { type: "speak" }> => e.type === "speak",
	);
	const composes = events.filter(
		(e): e is Extract<E, { type: "compose" }> => e.type === "compose",
	);
	const replies = events.filter(
		(e): e is Extract<E, { type: "reply" }> => e.type === "reply",
	);
	const asked = events.filter(
		(e): e is Extract<E, { type: "asked" }> => e.type === "asked",
	);

	const responseSecs: number[] = [];
	users.forEach((u, k) => {
		const until = users[k + 1]?.atSec ?? Number.POSITIVE_INFINITY;
		const first = speaks.find((s) => s.atSec > u.atSec && s.atSec < until);
		if (first) responseSecs.push(first.atSec - u.atSec);
	});
	const gapSecs = speaks.slice(1).map((s, k) => s.atSec - speaks[k]!.atSec);

	let saidTwice = 0;
	for (const r of replies) {
		const u = lastWhere(users, (x) => x.atSec <= r.atSec);
		const calls = asked
			.filter((a) => u && a.atSec >= u.atSec && a.atSec <= r.atSec)
			.map(() => "start_preparation");
		if (saysTwice(r.text, calls)) saidTwice++;
	}

	type Said = { who: "user" | "reply" | "agent"; text: string; atSec: number };
	const talk: Said[] = [];
	for (const e of events) {
		if (e.type === "user")
			talk.push({ who: "user", text: e.text, atSec: e.atSec });
		else if (e.type === "reply")
			talk.push({ who: "reply", text: e.text, atSec: e.atSec });
		else if (e.type === "speak")
			talk.push({ who: "agent", text: e.text, atSec: e.atSec });
	}
	const inTalk: TalkItem[] = [];
	for (const s of speaks) {
		const lastUser = users
			.filter((u) => u.atSec <= s.atSec)
			.slice(-2)
			.map((u) => ({ text: u.text, secAgo: Math.round(s.atSec - u.atSec) }));
		if (lastUser.length === 0 || lastUser.at(-1)!.secAgo > TALKING_SEC)
			continue;
		inTalk.push({
			atSec: s.atSec,
			kind: s.kind,
			text: s.text,
			lastUser,
			before: talk
				.filter((t) => t.atSec < s.atSec)
				.slice(-8)
				.map(({ who, text }) => ({ who, text })),
		});
	}

	return {
		responseSecs,
		gapSecs,
		speaks: speaks.length,
		composes: composes.length,
		composeDropped: composes.filter(
			(c) => c.code === "stale" || c.code === "aborted",
		).length,
		backgroundCalls: events.filter(
			(e) => e.type === "plan" || e.type === "compose" || e.type === "check",
		).length,
		replies: replies.length,
		saidId:
			replies.filter((r) => SAYS_NOTE_ID.test(r.text)).length +
			speaks.filter((s) => SAYS_NOTE_ID.test(s.text)).length,
		saidTwice,
		tookBack: replies.filter((r) => TAKE_BACK.test(r.text)).length,
		inTalk,
	};
}

export const median = (xs: readonly number[]) => {
	if (xs.length === 0) return null;
	const s = [...xs].sort((a, b) => a - b);
	const m = Math.floor(s.length / 2);
	return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

// ---------------------------------------------------------------------------------------------
// The topic check (the verifier model)
// ---------------------------------------------------------------------------------------------

const topicSchema = z.strictObject({
	judgments: z.array(
		z.strictObject({
			id: z.number().int(),
			connected: z.boolean(),
			reason: z.string(),
		}),
	),
});

const topicSystem = [
	"あなたは、会話エージェントの発言が会話の流れに合っているかを調べる検査役です。",
	"items の各項目は、エージェントが自分から言った質問または話題（utterance）です。lastUser は、その直前までの利用者の発言のうち最新の2つ（古い順。secAgo は発言の何秒前か）、before はその直前までの会話です。",
	"utterance が lastUser の2つの発言のどちらかの話題につながっていれば connected を true にします。つながるとは、その発言の内容を受けている、その発言で出た物事を掘り下げている、その発言の直接の続きとして自然に聞こえる、ことです。",
	"lastUser の2つの発言に出ていない話題（会話の少し前に出た話題、利用者が話題を替える前の話題、まったく別の話題）は false です。before の中に出てくる話題でも、lastUser から離れていれば false です。",
	"利用者が話題を替えた直後に前の話題へ戻る質問は false です。利用者の発言に出た物事に実際に触れている質問は true です。",
	"判定は発言の中身だけで行い、丁寧さや文の良し悪しは見ません。reason は日本語で一文です。",
	"items のすべての id に、ちょうど1つずつ答えます。",
].join("\n");

/** One call per replay: each own speech in a conversation, connected to the user's last two lines or not. */
export async function judgeTopics(
	llm: LlmPort,
	items: readonly TalkItem[],
): Promise<{ connected: boolean; reason: string }[]> {
	if (items.length === 0) return [];
	const r = await llm.complete(
		{
			purpose: "think",
			system: topicSystem,
			prompt: JSON.stringify({
				items: items.map((it, id) => ({
					id,
					kind: it.kind === "ask" ? "質問" : "話題",
					utterance: it.text,
					lastUser: it.lastUser,
					before: it.before,
				})),
			}),
			schema: topicSchema,
			maxOutputTokens: Math.min(8000, 400 + items.length * 150),
		},
		new AbortController().signal,
	);
	const byId = new Map(r.value.judgments.map((j) => [j.id, j]));
	return items.map((_, id) => {
		const j = byId.get(id);
		return j
			? { connected: j.connected, reason: j.reason }
			: { connected: true, reason: "（判定なし）" };
	});
}

// ---------------------------------------------------------------------------------------------
// Running
// ---------------------------------------------------------------------------------------------

/** The four logs of the review's night (or the ones named). */
function chooseLogs(wanted: readonly string[]): string[] {
	const all = readdirSync(CHATS)
		.filter((f) => /^2026-11-10T.*-agenda\.jsonl$/u.test(f))
		.sort();
	const logs =
		wanted.length === 0
			? all
			: all.filter((f) => wanted.some((w) => f.includes(w)));
	if (logs.length === 0)
		throw new Error(`no log matches ${wanted.join(" ")} in ${CHATS}`);
	return logs;
}

const logName = (file: string) =>
	basename(file).replace(/-agenda\.jsonl$/u, "");

/** The agenda logs written before `startMs` (every day), oldest first. */
function earlierProfileEvents(startMs: number): ChatEvent[] {
	return readdirSync(CHATS)
		.filter((f) => f.endsWith("-agenda.jsonl"))
		.sort()
		.flatMap((f) => parseChatLog(readFileSync(join(CHATS, f), "utf8")))
		.filter((e) => e.type === "profile" && e.at < startMs)
		.sort((a, b) => a.at - b.at);
}

/** The clock of the log: virtual time is epoch milliseconds. */
const logClock = clockFrom(new Date(0).toISOString());

const show = (e: AgendaSimEvent) => {
	const t = `${Math.round(e.atSec)}s`.padStart(7);
	switch (e.type) {
		case "user":
			return `${t} 👤 ${e.text}`;
		case "reply":
			return `${t} reply: ${e.text}`;
		case "speak":
			return `${t} 🗣 ${e.kind}: ${e.text}`;
		case "asked":
			return `${t} 🙋 返事が調べものを頼んだ: ${e.text}`;
		default:
			return null;
	}
};

async function run(
	name: string,
	logs: readonly string[],
	samples: number,
	jobsAtOnce: number,
) {
	const settings = loadSettings(
		resolve(process.env.AGENCY_SETTINGS ?? "config/always-on.json"),
	);
	const outDir = join(OUT, name);
	mkdirSync(outDir, { recursive: true });
	const total = openUncappedMeter(settings, resolve("data/agenda/usage.jsonl"));
	const totalBefore = total.spentUsd();
	const queue = logs.flatMap((file) =>
		Array.from({ length: samples }, (_, k) => ({ file, sample: k + 1 })),
	);
	const failed: string[] = [];

	const one = async ({ file, sample }: (typeof queue)[number]) => {
		const label = `${logName(file).slice(11, 16)}#${sample}`;
		const say = (line: string) =>
			console.log(line.replace(/^/gmu, `[${label}] `));
		const started = performance.now();
		const meter = openUncappedMeter(
			settings,
			resolve("data/agenda/usage.jsonl"),
		);
		const spentBefore = meter.spentUsd();
		const client = clientFor(settings.llm.background);
		const llm = createProviderLlm(settings.llm.background, meter, client);
		const chat = createProviderReply(
			settings.llm.main,
			meter,
			clientFor(settings.llm.main),
		);
		const verifier = verifierLlm(settings, meter);

		const chatEvents = parseChatLog(readFileSync(join(CHATS, file), "utf8"));
		const startMs = sessionStartMs(chatEvents);
		const turns = userTurns(chatEvents);
		const minutes = sessionMinutes(chatEvents);

		const work = mkdtempSync(join(tmpdir(), "rp-"));
		const memory = await openHostMemory({
			dir: join(work, "memory"),
			complete: memoryModel({
				role: settings.llm.background,
				meter,
				claudeClient: createClaudeClient({ maxRetries: 8, timeout: 120_000 }),
			}),
			clock: logClock,
		});
		try {
			// The notes the CLI had when the session started, ids kept (the store reads a folder).
			const notesDir = join(work, "notes");
			mkdirSync(notesDir);
			const noteFiles = readdirSync(NOTES)
				.filter((f) => f.endsWith(".md"))
				.map((f) => ({ name: f, raw: readFileSync(join(NOTES, f), "utf8") }));
			for (const f of notesBefore(noteFiles, startMs))
				copyFileSync(join(NOTES, f), join(notesDir, f));
			const docs = createMockDocStore({ dir: notesDir });

			// The memory the CLI held, beside the store the writer fills.
			const seeded = memoryAt(MEMORY_DB, startMs);
			const known = (): KnownItem[] => [...seeded, ...memory.known()];

			// The plans-and-interests note as the earlier logs left it.
			const profilePath = join(work, "profile.md");
			const earlier = profileLinesFromEvents(earlierProfileEvents(startMs));
			writeFileSync(profilePath, renderProfile(earlier));
			const note = createProfileNote({
				llm,
				known,
				clock: logClock,
				path: profilePath,
			});

			const research = createMockWebResearch({
				writer: (request, delegatedTo) =>
					delegatedTo
						? mockToolchainWork(request, delegatedTo)
						: llmWriter(llm)(request),
				docs,
				// Research in the CLI came back in 13.5 s (median of 44, 2026-11-10; it was 120 s here).
				delayMs: 15_000,
			});
			const events: AgendaSimEvent[] = [];
			say(
				`=== ${logName(file)} ${minutes}分、利用者の発言 ${turns.length}、メモ ${docs.list().length}、記憶 ${seeded.length}`,
			);
			await simulateAgenda({
				deps: { llm, clock: logClock, profile: note.get },
				minutes,
				turns,
				startMs,
				memory: { known },
				steward: memory.steward,
				profile: note.writer,
				docs,
				research,
				reply: async (agent, at, tools) => {
					const r = await runRespond({
						messages: agendaReplyMessages({
							agent,
							known: known(),
							notes: docs.list(),
							profile: note.get(),
							clock: logClock(at),
							now: at,
						}),
						chat,
						tools,
						emotion: true,
						signal: new AbortController().signal,
						onDelta: () => undefined,
					});
					return {
						text: dropRepeatedSentences(r.text),
						calls: r.calls,
						emotion: r.emotion ?? null,
					};
				},
				onEvent: (e) => {
					events.push(e);
					const line = show(e);
					if (line) say(line);
				},
			});

			const metrics = replayMetrics(events);
			const judged = await judgeTopics(verifier.llm, metrics.inTalk).catch(
				(e: unknown) => {
					say(
						`話題の判定に失敗: ${e instanceof Error ? e.message : String(e)}`,
					);
					return null;
				},
			);
			const base = join(outDir, `${logName(file)}.${sample}`);
			writeFileSync(
				`${base}.jsonl`,
				events.map((e) => JSON.stringify(e)).join("\n") + "\n",
			);
			writeFileSync(
				`${base}.topic.json`,
				JSON.stringify(
					metrics.inTalk.map((it, k) => ({
						atSec: it.atSec,
						kind: it.kind,
						text: it.text,
						lastUser: it.lastUser.map((u) => u.text),
						connected: judged?.[k]?.connected ?? null,
						reason: judged?.[k]?.reason ?? null,
					})),
					null,
					"\t",
				),
			);
			const usd = meter.spentUsd() - spentBefore;
			writeFileSync(
				`${base}.summary.json`,
				JSON.stringify(
					{
						log: logName(file),
						sample,
						minutes,
						usd,
						verifier: verifier.model,
						model: settings.llm.background.model,
						start: {
							notes: docs.list().length,
							memory: seeded.length,
							profileLines: earlier.plans.length + earlier.interests.length,
						},
						end: { notes: docs.list().length, memory: memory.known().length },
						wallSec: Math.round((performance.now() - started) / 1000),
					},
					null,
					"\t",
				),
			);
			say(
				`  $${usd.toFixed(4)}  自発 ${metrics.speaks}  返事 ${metrics.replies}  会話中の自発 ${metrics.inTalk.length}（つながらない ${judged ? judged.filter((j) => !j.connected).length : "?"}）`,
			);
		} finally {
			await memory.close();
			rmSync(work, { recursive: true, force: true });
		}
	};

	const started = performance.now();
	await Promise.all(
		Array.from({ length: Math.min(jobsAtOnce, queue.length) }, async () => {
			for (let j = queue.shift(); j; j = queue.shift())
				await one(j).catch((e: unknown) => {
					failed.push(`${logName(j.file)}#${j.sample}`);
					console.error(
						`[${logName(j.file)}#${j.sample}] 失敗: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`,
					);
				});
		}),
	);
	if (failed.length) console.log(`\n失敗: ${failed.join(" ")}`);
	console.log(
		`\n実時間 ${Math.round((performance.now() - started) / 1000)}秒、費用 $${(total.spentUsd() - totalBefore).toFixed(4)}。比較: bun eval/agenda/replay.ts compare ${name}`,
	);
}

// ---------------------------------------------------------------------------------------------
// Comparing
// ---------------------------------------------------------------------------------------------

interface Loaded {
	readonly log: string;
	readonly metrics: ReplayMetrics;
	readonly topic: { connected: boolean | null }[];
	readonly usd: number;
}

function load(name: string): Loaded[] {
	const dir = join(OUT, name);
	if (!existsSync(dir)) throw new Error(`no replay run: ${dir}`);
	return readdirSync(dir)
		.filter((f) => /\.\d+\.jsonl$/u.test(f))
		.sort()
		.map((f) => {
			const base = join(dir, f.replace(/\.jsonl$/u, ""));
			const events = readFileSync(join(dir, f), "utf8")
				.split("\n")
				.filter((l) => l.trim() !== "")
				.map((l) => JSON.parse(l) as AgendaSimEvent);
			const read = <T>(ext: string, fallback: T): T =>
				existsSync(`${base}${ext}`)
					? (JSON.parse(readFileSync(`${base}${ext}`, "utf8")) as T)
					: fallback;
			return {
				log: f.replace(/\.\d+\.jsonl$/u, ""),
				metrics: replayMetrics(events),
				topic: read<{ connected: boolean | null }[]>(".topic.json", []),
				usd: read<{ usd?: number }>(".summary.json", {}).usd ?? 0,
			};
		});
}

const pct = (n: number, d: number) =>
	d === 0 ? "-" : `${n}/${d} (${((100 * n) / d).toFixed(0)}%)`;
const num = (x: number | null, digits = 1) =>
	x === null ? "-" : x.toFixed(digits);
/** `2026-11-10T10-06-17-218Z` as `10:06Z`. */
const short = (log: string) => `${log.slice(11, 13)}:${log.slice(14, 16)}Z`;

function row(name: string, label: string, runs: readonly Loaded[]) {
	const m = (f: (x: ReplayMetrics) => number) =>
		runs.reduce((n, r) => n + f(r.metrics), 0);
	const speaks = m((x) => x.speaks);
	const judged = runs
		.flatMap((r) => r.topic)
		.filter((t) => t.connected !== null);
	const off = judged.filter((t) => t.connected === false).length;
	const inTalk = m((x) => x.inTalk.length);
	return `| ${name} | ${label} | ${runs.length} | ${num(median(runs.flatMap((r) => r.metrics.responseSecs)))} | ${num(median(runs.flatMap((r) => r.metrics.gapSecs)))} | ${speaks} | ${pct(
		m((x) => x.composeDropped),
		m((x) => x.composes),
	)} | ${speaks ? num(m((x) => x.backgroundCalls) / speaks) : "-"} | ${m((x) => x.saidId)} | ${m((x) => x.saidTwice)} | ${m((x) => x.tookBack)} / ${m((x) => x.replies)} | ${inTalk} | ${judged.length === inTalk ? pct(off, judged.length) : `${pct(off, judged.length)}（判定 ${judged.length}/${inTalk}）`} | $${runs.reduce((n, r) => n + r.usd, 0).toFixed(3)} |`;
}

function compare(names: readonly string[]) {
	console.log(
		"| 版 | ログ | 回 | 発言→最初の自発（秒、中央値） | 自発の間隔（秒、中央値） | 自発 | 捨てた話す文 | 背景の呼び出し/自発（計画・話す文・調べものチェック） | id を口に出した | 2回言った | 取り消し・打ち消し/返事 | 会話中の自発 | 直近2発言につながらない | 費用 |",
	);
	console.log(`| --- | --- | ---: |${" ---: |".repeat(11)}`);
	for (const name of names) {
		const all = load(name);
		const logs = [...new Set(all.map((r) => r.log))];
		for (const log of logs)
			console.log(
				row(
					name,
					short(log),
					all.filter((r) => r.log === log),
				),
			);
		console.log(row(name, "合計", all));
	}
	console.log(
		"\n（背景の呼び出しは、質問の確認の呼び出しを含まない。つながらないかは、会話中（利用者が5分以内に話した）の自発を判定役が1回の呼び出しで判定。回は標本の数で、中央値は標本をまとめて取る）",
	);
}

if (import.meta.main) {
	const argv = process.argv.slice(2);
	const [cmd, ...rest] = argv;
	const valued = new Set(["--samples", "--jobs"]);
	const flag = (n: string, fallback: number) => {
		const i = rest.indexOf(n);
		const v = i >= 0 ? Number(rest[i + 1]) : fallback;
		if (!Number.isInteger(v) || v < 1)
			throw new Error(`${n} needs a whole number of at least 1`);
		return v;
	};
	const positional = rest.filter(
		(a, k) => !a.startsWith("--") && !valued.has(rest[k - 1] ?? ""),
	);
	if (cmd === "run") {
		const [name, ...wanted] = positional;
		if (!name)
			throw new Error(
				"usage: replay.ts run <name> [--samples N] [--jobs N] [log...]",
			);
		await run(
			name,
			chooseLogs(wanted),
			flag("--samples", 1),
			flag("--jobs", 8),
		);
	} else if (cmd === "compare" && positional.length) compare(positional);
	else
		throw new Error(
			"usage: replay.ts run <name> [--samples N] [--jobs N] [log...] | compare <name> [<name>...]",
		);
}
