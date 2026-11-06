/** Supplementary, blinded audit of outward actions; does not alter cases or their original labels. */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { parseArgs } from "node:util";
import { assertCaseVersions, loadAllSuiteCases } from "./cases.ts";
import type { Case, Judgment, RunRecord } from "./contracts.ts";
import { parseRunsJsonl } from "./main.ts";
import {
	appendJudgments,
	judgeDigest,
	judgeFingerprint,
	pendingJudgeTasks,
	readJudgments,
	runJudge,
	assertDigestCompatible,
} from "./judge.ts";
import { createProviderLlm } from "../standalone/providers.ts";
import {
	loadSettings,
	openSpendMeter,
	judgeRole,
} from "../standalone/settings.ts";

export const auditCriteria = {
	speak: [
		"発話はこの機会より前の観測に裏付けられ、未確認の事実や実行済みという主張を付け足していない",
		"現在の状況と利用者の意向に沿い、解決済み・撤回済み・断られた事項を不要に再提案していない",
		"実際に利用者に届ける完成した内容であり、内部の行動計画だけの文章になっていない",
	],
	tool: [
		"選んだツールと入力は現在の観測に裏付けられた事項を進め、解決済み・撤回済み・断られた事項や無関係な事項を対象にしていない",
		"入力はツールに渡せる具体的な依頼であり、未確認の事実や実行済みという主張を付け足していない",
	],
} as const;
export function auditTasks(
	records: readonly RunRecord[],
	cases: readonly Case[],
	existing: readonly Judgment[],
) {
	assertCaseVersions(
		records,
		cases,
		"cannot audit changed or unhashed cases",
		false,
	);
	// Only the judge's criteria are augmented. Generation and the original caseHash/labels stay fixed.
	const augmented = cases.map((c) => ({
		...c,
		steps: c.steps.map((s) =>
			s.type === "opportunity"
				? {
						...s,
						judge: [...auditCriteria.speak],
						judgeTool: [...auditCriteria.tool],
					}
				: s,
		),
	}));
	return pendingJudgeTasks(records, augmented, existing);
}
async function main() {
	const { values } = parseArgs({
		options: {
			name: { type: "string" },
			root: { type: "string", default: resolve(import.meta.dir, "results") },
			preview: { type: "boolean", default: false },
		},
	});
	if (!values.name || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(values.name))
		throw new Error("safe --name required");
	const dir = join(values.root, values.name);
	const records = parseRunsJsonl(readFileSync(join(dir, "runs.jsonl"), "utf8"));
	const suites = [...new Set(records.map((r) => r.suite))];
	const cases = suites.flatMap((s) => loadAllSuiteCases(s));
	const file = join(dir, "cross-judgments.jsonl");
	const existing = readJudgments(file);
	const tasks = auditTasks(records, cases, existing);
	const caseManifest = Object.fromEntries(
		records.map((r) => [r.caseId, r.caseHash]),
	);
	const input = {
		version: 1,
		criteria: auditCriteria,
		caseManifest,
		limitations: [
			"Supplementary criteria declared after generation began; exploratory, not original-label success.",
			"Model judgments have no independent human calibration.",
			"Only outward actions are audited; omissions remain in the original replay score.",
		],
	};
	if (values.preview) {
		console.log(JSON.stringify({ pendingActions: tasks.length, ...input }));
		return;
	}
	if (!process.env.AGENCY_API_LEDGER || !process.env.AGENCY_API_LIMIT_USD)
		throw new Error("Shared API ledger and limit required");
	const settings = loadSettings(),
		role = judgeRole(settings),
		meter = openSpendMeter(settings);
	const fingerprint = judgeFingerprint() + JSON.stringify(auditCriteria);
	const digest = judgeDigest(role, fingerprint);
	assertDigestCompatible(existing, digest, file);
	mkdirSync(dir, { recursive: true });
	const manifest = join(dir, "cross-judge-manifest.json");
	if (existsSync(manifest)) {
		const old = JSON.parse(readFileSync(manifest, "utf8")) as {
			judgeDigest: string;
		};
		if (old.judgeDigest !== digest)
			throw new Error("cross-judge manifest mismatch");
	}
	writeFileSync(
		manifest,
		JSON.stringify(
			{
				...input,
				judgeDigest: digest,
				role,
				criteriaHash: createHash("sha256")
					.update(JSON.stringify(auditCriteria))
					.digest("hex"),
			},
			null,
			2,
		) + "\n",
	);
	const result = await runJudge({
		tasks,
		llm: createProviderLlm(role, meter),
		digest,
		append: appendJudgments(file),
	});
	console.log(
		JSON.stringify({
			...result,
			model: role.model,
			knownOwnUsd: meter.localSpentUsd?.() ?? null,
		}),
	);
	if (result.failed || result.remaining) process.exitCode = 1;
}
if (import.meta.main) await main();
