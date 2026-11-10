/**
 * The agenda's snapshot (`AgendaAgent.snapshot`) in a stand-in for Eumenes' own store: one JSON
 * file, read at start and written whenever it changed. A file that does not parse is set aside
 * (`<path>.bad`), not trusted, and the agent starts fresh.
 */
import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import {
	agendaSnapshotSchema,
	type AgendaSnapshot,
} from "../../../src/agenda/index.ts";

export interface SnapshotFile {
	/** What the last run saved (null: nothing, or a file set aside: `problem` says why). */
	readonly loaded: AgendaSnapshot | null;
	readonly problem: string | null;
	/** Writes it unless it is what the file holds already (the time aside). */
	save(s: AgendaSnapshot): void;
}

const sameAs = (s: AgendaSnapshot) => JSON.stringify({ ...s, at: 0 });

export function openSnapshotFile(path: string): SnapshotFile {
	let loaded: AgendaSnapshot | null = null;
	let problem: string | null = null;
	if (existsSync(path)) {
		try {
			loaded = agendaSnapshotSchema.parse(
				JSON.parse(readFileSync(path, "utf8")),
			);
		} catch (e) {
			problem = e instanceof Error ? e.message : String(e);
			renameSync(path, `${path}.bad`);
		}
	}
	let last = loaded ? sameAs(loaded) : null;
	return {
		loaded,
		problem,
		save(s) {
			const key = sameAs(s);
			if (key === last) return;
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(`${path}.tmp`, `${JSON.stringify(s, null, "\t")}\n`);
			renameSync(`${path}.tmp`, path);
			last = key;
		},
	};
}
