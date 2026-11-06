import { readFileSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { summarizeUsage } from "../standalone/metrics.ts";

const dir = resolve(process.argv[2] ?? "data/chats");
const sessions = readdirSync(dir)
	.filter((p) => p.endsWith(".jsonl"))
	.sort()
	.map((p) =>
		readFileSync(join(dir, p), "utf8")
			.split("\n")
			.filter(Boolean)
			.map((line) => {
				try {
					return JSON.parse(line) as unknown;
				} catch {
					return null;
				}
			}),
	);
// No conversation text, feedback notes, file paths, or credentials leave this report.
console.log(JSON.stringify(summarizeUsage(sessions), null, 2));
