/** Fault fixture: pause the real standalone adapter inside or after its transaction. */
import { Database } from "bun:sqlite";
import { CheckpointStore } from "../standalone/checkpoint-store.ts";

const [path, operation, phase] = process.argv.slice(2);
if (!path || !["compact", "forget", "save"].includes(operation ?? ""))
	throw new Error("fixture args");
const store = new CheckpointStore(path);
if (phase === "before") {
	const original = Database.prototype.query;
	Database.prototype.query = function (this: Database, sql: string) {
		const statement = original.call(this, sql);
		if (!sql.startsWith("INSERT OR REPLACE INTO checkpoint")) return statement;
		return new Proxy(statement, {
			get(target, key) {
				if (key !== "run") return Reflect.get(target, key);
				return (...args: unknown[]) => {
					process.stdout.write("inside-transaction\n");
					// Parent SIGKILLs this worker. No runtime or database production hook is added.
					Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
					return Reflect.apply(target.run, target, args);
				};
			},
		});
	} as typeof original;
}
const generation = store.load()!.generation;
if (operation === "compact") store.compact(generation, 30);
else if (operation === "forget") store.forget(["o1"], generation);
else {
	const checkpoint = store.load()!.checkpoint;
	try {
		store.save(checkpoint, 1);
		console.log("saved");
	} catch {
		console.log("stale");
	}
}
if (phase === "after") {
	process.stdout.write("committed\n");
	await new Promise(() => setInterval(() => {}, 1000));
}
store.close();
