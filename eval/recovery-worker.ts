/** Destructive crashes affect only the disposable DB supplied by recovery.test.ts. */
import { Database } from "bun:sqlite";
import { createAgencyRuntime, type AgencySnapshot } from "../src/index.ts";
import {
	fakeLlm,
	intentAddOp,
	obsInput,
	proposal,
} from "../test/core/helpers.ts";
const [path, phase] = process.argv.slice(2);
if (!path || !phase) throw new Error("fixture path and phase required");
const db = new Database(path);
db.exec(
	"PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS checkpoint(id INTEGER PRIMARY KEY, body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS outbox(id TEXT PRIMARY KEY,status TEXT NOT NULL); CREATE TABLE IF NOT EXISTS effects(id TEXT PRIMARY KEY);",
);
const crash = () => {
	process.kill(process.pid, "SIGKILL");
};
if (phase === "before-commit" || phase === "after-commit") {
	const llm = fakeLlm();
	const rt = createAgencyRuntime({
		condition: "B2",
		systemContext: "experimental",
		llm,
		tools: [],
	});
	rt.observe(
		obsInput("private-input", "user.report", "user", 0, "fixture body"),
	);
	llm.push(
		"update",
		proposal([intentAddOp("g", { evidenceRefs: ["private-input"] })]),
	);
	await rt.runBackground(1, new AbortController().signal);
	if (rt.snapshot().state.intents.length !== 1)
		throw new Error("fixture update was rejected");
	db.transaction(() => {
		db.run("INSERT INTO checkpoint VALUES (1,?)", [
			JSON.stringify(rt.snapshot()),
		]);
		db.run("INSERT INTO outbox VALUES ('operation-1','reserved')");
		if (phase === "before-commit") crash();
	})();
	crash();
} else if (phase === "effect-before-ack") {
	db.run("INSERT OR IGNORE INTO effects VALUES ('operation-1')");
	crash();
} else if (phase === "recover") {
	const checkpoint = db
		.query("SELECT body FROM checkpoint WHERE id=1")
		.get() as { body: string } | null;
	if (!checkpoint) throw new Error("missing checkpoint");
	const rt = createAgencyRuntime({
		condition: "B2",
		systemContext: "experimental",
		llm: fakeLlm(),
		tools: [],
		restore: JSON.parse(checkpoint.body) as AgencySnapshot,
	});
	// Host idempotency key makes a previously committed external result safe to reconcile.
	db.transaction(() => {
		db.run("INSERT OR IGNORE INTO effects VALUES ('operation-1')");
		db.run("UPDATE outbox SET status='succeeded' WHERE id='operation-1'");
	})();
	console.log(
		JSON.stringify({
			intents: rt.snapshot().state.intents.length,
			effects: (
				db.query("SELECT COUNT(*) n FROM effects").get() as { n: number }
			).n,
		}),
	);
} else throw new Error("unknown fixture phase");
db.close();
