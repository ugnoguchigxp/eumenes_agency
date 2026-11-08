/**
 * A stand-in for Eumenes' Markdown documents (Docling as the store, shared editing in Artifact):
 * the researcher's notes. In memory, or one Markdown file per note under `dir` so a CLI session
 * finds them again. The user may edit a note; readers always get the latest text.
 */
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { NoteRef } from "../../../src/agenda/index.ts";

export interface NoteDoc extends NoteRef {
	readonly markdown: string;
}

const toRef = (d: NoteDoc): NoteRef => ({
	id: d.id,
	title: d.title,
	summary: d.summary,
	at: d.at,
	refs: [...d.refs],
});

/** Note ids are `n<number>`: a file name made from one never leaves the notes folder. */
const NOTE_ID = /^n\d+$/u;

const parseHead = (json: string): NoteRef | null => {
	try {
		const h = JSON.parse(json) as Record<string, unknown>;
		if (
			typeof h["id"] !== "string" ||
			!NOTE_ID.test(h["id"]) ||
			typeof h["title"] !== "string" ||
			typeof h["summary"] !== "string" ||
			typeof h["at"] !== "number" ||
			!Array.isArray(h["refs"]) ||
			!h["refs"].every((r) => typeof r === "string")
		)
			return null;
		return {
			id: h["id"],
			title: h["title"],
			summary: h["summary"],
			at: h["at"],
			refs: h["refs"] as string[],
		};
	} catch {
		return null;
	}
};

const HEAD = /^<!-- agenda-note (\{.*\}) -->\n/u;

export function createMockDocStore(opts: { readonly dir?: string } = {}) {
	const docs = new Map<string, NoteDoc>();
	let seq = 0;
	const file = (id: string) => {
		if (!NOTE_ID.test(id)) throw new RangeError(`invalid note id: ${id}`);
		return join(opts.dir!, `${id}.md`);
	};
	const write = (d: NoteDoc) => {
		if (!opts.dir) return;
		mkdirSync(opts.dir, { recursive: true });
		const { markdown, ...head } = d;
		writeFileSync(
			file(d.id),
			`<!-- agenda-note ${JSON.stringify(head)} -->\n${markdown}`,
		);
	};
	if (opts.dir && existsSync(opts.dir))
		for (const f of readdirSync(opts.dir).filter((x) => x.endsWith(".md"))) {
			const raw = readFileSync(join(opts.dir, f), "utf8");
			const m = HEAD.exec(raw);
			if (!m) continue;
			// A note the user broke by hand is skipped, never a reason not to start.
			const head = parseHead(m[1]!);
			if (!head || `${head.id}.md` !== f) continue;
			docs.set(head.id, { ...head, markdown: raw.slice(m[0].length) });
			seq = Math.max(seq, Number(head.id.slice(1)));
		}
	return {
		save(d: {
			title: string;
			summary: string;
			markdown: string;
			refs: readonly string[];
			at: number;
		}): NoteRef {
			const doc: NoteDoc = { id: `n${++seq}`, ...d, refs: [...d.refs] };
			docs.set(doc.id, doc);
			write(doc);
			return toRef(doc);
		},
		list: (): NoteRef[] =>
			[...docs.values()].map(toRef).sort((a, b) => a.at - b.at),
		read: (id: string): NoteDoc | null => docs.get(id) ?? null,
		/** The user edited the note: the body changes, and so may the title or summary. */
		edit(
			id: string,
			change: { markdown?: string; title?: string; summary?: string },
		): boolean {
			const d = docs.get(id);
			if (!d) return false;
			const next: NoteDoc = {
				...d,
				...(change.markdown !== undefined ? { markdown: change.markdown } : {}),
				...(change.title !== undefined ? { title: change.title } : {}),
				...(change.summary !== undefined ? { summary: change.summary } : {}),
			};
			docs.set(id, next);
			write(next);
			return true;
		},
		/** Removes the notes resting on any of these refs; returns their refs (`note:<id>`). */
		forget(refs: readonly string[]): string[] {
			const gone = [...docs.values()].filter((d) =>
				d.refs.some((r) => refs.includes(r)),
			);
			for (const d of gone) {
				docs.delete(d.id);
				if (opts.dir && existsSync(file(d.id))) rmSync(file(d.id));
			}
			return gone.map((d) => `note:${d.id}`);
		},
	};
}
export type MockDocStore = ReturnType<typeof createMockDocStore>;
