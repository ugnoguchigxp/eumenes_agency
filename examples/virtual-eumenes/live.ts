/** Small paired API probe of archived evidence. Not the standalone >80 acceptance cohort. */
import { createHash } from "node:crypto";
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	defaultBudget,
	HOST_RULES_VERSION,
	INSTRUCTION_VERSION,
} from "../../src/index.ts";
import { createProviderLlm } from "../../standalone/providers.ts";
import { apiKeyFromEnvironment } from "../../standalone/api-keys.ts";
import {
	loadSettings,
	openSpendMeter,
	settingsDigest,
} from "../../standalone/settings.ts";
import { withCommandBudget } from "../../eval/budget.ts";
import { createTraceRecorder } from "../../eval/trace.ts";
import { VirtualEumenes } from "./adapter.ts";
import { MemoryBridge } from "./memory-bridge.ts";
import { synergyCases, synergyFixture } from "./fixtures.ts";

const [name] = process.argv.slice(2);
if (
	!name ||
	!/^[a-zA-Z0-9_-]+$/.test(name) ||
	!["9", "10"].includes(process.env.AGENCY_API_LIMIT_USD ?? "") ||
	resolve(process.env.AGENCY_API_LEDGER ?? "") !==
		resolve("data/api-validation/improvement-20261105/usage.jsonl")
)
	throw Error(
		"explicit run name and existing cumulative authorized ledger required",
	);
const settings = loadSettings();
const provider = settings.llm.background.provider ?? "anthropic";
if (!apiKeyFromEnvironment(provider))
	throw Error("exported API key missing; no request attempted");
const output = resolve("artifacts/memory-synergy-2026-11-06", name);
if (existsSync(output)) throw Error("run already exists");
mkdirSync(output, { recursive: true });
const meter = openSpendMeter(settings);
const ownSpent = meter.localSpentUsd;
if (!ownSpent) throw Error("per-command usage accounting required");
const recorder = createTraceRecorder(
	withCommandBudget(
		createProviderLlm(settings.llm.background, meter),
		() => ownSpent(),
		0.08,
	),
	join(output, "traces.jsonl"),
	name,
);
const llm = recorder.llm;
const sources = [
	"examples/virtual-eumenes/adapter.ts",
	"examples/virtual-eumenes/memory-bridge.ts",
	"examples/virtual-eumenes/fixtures.ts",
	"examples/virtual-eumenes/live.ts",
	"src/application/prompts.ts",
	"src/application/runtime.ts",
];
const sha256 = (file: string) =>
	createHash("sha256").update(readFileSync(file)).digest("hex");
writeFileSync(
	join(output, "manifest.json"),
	JSON.stringify(
		{
			name,
			scope:
				"Four fixed synthetic archived-evidence pairs, one repetition, no label tuning. Both conditions use identical stored notes, recent observations, provider and instructions; only the Memory archive port differs. ID selected in the fixture is an oracle: this measures use of supplied evidence, not recall discovery or standalone completeness.",
			provider,
			role: settings.llm.background,
			settingsDigest: settingsDigest(settings),
			instructionVersion: INSTRUCTION_VERSION,
			hostRulesVersion: HOST_RULES_VERSION,
			files: Object.fromEntries(sources.map((f) => [f, sha256(f)])),
			cases: synergyCases,
			order:
				"Alternates connected first and disconnected first across cases, identical order for providers",
			ownKnownCapUsd: 0.08,
		},
		null,
		2,
	) + "\n",
);
for (let index = 0; index < synergyCases.length; index++) {
	for (const connected of index % 2 === 0 ? [false, true] : [true, false]) {
		meter.assertWithinLimit();
		recorder.begin({
			caseId: `${synergyCases[index]!.id}-${connected ? "connected" : "disconnected"}`,
			condition: "B1",
			rep: 1,
		});
		const directory = mkdtempSync(join(tmpdir(), "agency-live-memory-"));
		let host: VirtualEumenes | undefined;
		try {
			const memory = new MemoryBridge(directory);
			try {
				memory.save(synergyFixture(index));
				memory.compact();
				const saved = memory.load()!;
				saved.state.notes.push({
					id: "n1",
					revision: 1,
					text: "以前確認した条件の原観測を、今の判断に当てはめて確認する。",
					evidence: ["o1"],
				});
				memory.save({
					...saved,
					provenance: {
						version: 1,
						entries: [["note:n1", { sources: ["o1"], complete: true }]],
					},
				});
			} finally {
				memory.close();
			}
			host = new VirtualEumenes(directory, llm, {
				condition: "B1",
				tools: [],
				budget: { ...defaultBudget, minIntervalMs: 0 },
				archive: connected,
			});
			const result = await host.decide({
				id: "probe",
				at: 90 * 60000,
				trigger: "idle",
				presence: "quiet",
				foregroundBusy: false,
				playerBusy: false,
			});
			const row = {
				caseId: synergyCases[index]!.id,
				connected,
				decision: result.decision,
				calls: result.calls,
				ownKnownUsd: ownSpent(),
			};
			appendFileSync(join(output, "results.jsonl"), JSON.stringify(row) + "\n");
			console.log(
				JSON.stringify({
					caseId: row.caseId,
					connected,
					action: row.decision.action,
					source: row.decision.source,
					calls: row.calls.length,
					ownKnownUsd: row.ownKnownUsd,
				}),
			);
			if (
				result.calls.some(
					(c) =>
						c.code.startsWith("llm_call:") ||
						c.code.startsWith("error:") ||
						c.code === "aborted",
				)
			)
				throw Error(
					"provider infrastructure failure; probe stops without retrying the cohort",
				);
		} finally {
			host?.close();
			rmSync(directory, { recursive: true, force: true });
		}
	}
}
