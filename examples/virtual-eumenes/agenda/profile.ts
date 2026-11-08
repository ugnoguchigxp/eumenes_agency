/**
 * The user's plans-and-interests note (src/agenda/profile.ts) in a stand-in for Eumenes' Markdown
 * documents: in memory, or one Markdown file the user can open and edit; every read takes the
 * file as it is now. Its writer has the steward's shape, so a host runs it after each exchange
 * as it runs the memory's.
 */
import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import type { LlmPort } from "../../../src/index.ts";
import { updateProfile, type KnownItem } from "../../../src/agenda/index.ts";
import type { Steward } from "./memory.ts";

export function createProfileNote(opts: {
	readonly llm: LlmPort;
	/** The memory's items: the note leaves out what the memory holds. */
	readonly known: () => readonly KnownItem[];
	/** Local time as the user would say it, so "来月" becomes a month. */
	readonly clock?: (now: number) => string;
	/** A Markdown file (absent: in memory only). */
	readonly path?: string;
}) {
	let text = "";
	const get = (): string =>
		opts.path && existsSync(opts.path) ? readFileSync(opts.path, "utf8") : text;
	const save = (markdown: string) => {
		text = markdown;
		if (!opts.path) return;
		mkdirSync(dirname(opts.path), { recursive: true });
		writeFileSync(`${opts.path}.tmp`, markdown);
		renameSync(`${opts.path}.tmp`, opts.path);
	};
	const writer: Steward = async (r) => {
		const u = await updateProfile({
			llm: opts.llm,
			markdown: get(),
			said: r.said,
			fresh: r.fresh,
			known: opts.known(),
			clock: opts.clock ? opts.clock(r.at) : null,
			at: r.at,
			signal: new AbortController().signal,
		});
		if (u.changed) save(u.markdown);
		return {
			changed: u.changed,
			applied: u.applied,
			rejected: u.rejected,
			usage: u.usage
				? {
						latencyMs: u.usage.latencyMs,
						inputTokens: u.usage.inputTokens,
						outputTokens: u.usage.outputTokens,
					}
				: null,
		};
	};
	return { get, writer };
}
export type ProfileNote = ReturnType<typeof createProfileNote>;
