/** P0-A01–A08 fixed checks of the baseline measurement itself (fixture lane; no model, network or product store). */
import { describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	canonical,
	compareArtifactToInstalled,
	digest,
	loadDistribution,
	treeDigest,
} from "./baseline.ts";
import {
	createIdentityMap,
	requestParts,
	type CassetteEntry,
} from "./cassette.ts";
import { baselineCases, faultCases } from "./p0-cases.ts";
import {
	p1Declaration,
	readTrials,
	replayDeclaration,
	runP0,
	scanForSecrets,
	type RunConfig,
	type Tamper,
} from "./p0.ts";
import {
	aggregate,
	checkPair,
	compareRecords,
	decisionBuckets,
	semanticCounts,
	usageTotals,
	validateRecords,
	type TrialRecord,
} from "./record.ts";
import { runTrials } from "./trials.ts";

const host = resolve(import.meta.dir, "../../../eumenes");
const agencyRepo = resolve(import.meta.dir, "../..");
const hasHost = existsSync(resolve(host, "api/application/agency/runtime.ts"));
const pick = (...ids: string[]) =>
	baselineCases.filter((c) => ids.some((id) => c.id.startsWith(id)));
const subset = pick(
	"dev-previous-task",
	"dev-proof",
	"M01",
	"M04",
	"M08",
	"M10",
	"M12",
	"M13",
	"M15",
);
/** Cases in the given order (pick keeps the baseline order). */
const ordered = (...ids: string[]) =>
	ids.map((id) => baselineCases.find((c) => c.id.startsWith(id))!);
const tmp = () => mkdtempSync(join(tmpdir(), "agency-p0-test-"));
const config = (over: Partial<RunConfig>): RunConfig => ({
	host,
	agencyRepo,
	out: tmp(),
	runId: `test-${crypto.randomUUID()}`,
	variant: "baseline-dist",
	mode: "record",
	cases: subset,
	reps: 1,
	maxAttempts: 200,
	argv: ["test"],
	...over,
});
const cassette = (dir: string) =>
	readFileSync(join(dir, "cassette.jsonl"), "utf8")
		.split("\n")
		.filter(Boolean)
		.map((l) => JSON.parse(l) as CassetteEntry);

describe.skipIf(!hasHost)("P0 baseline on the installed distribution", () => {
	let base: Awaited<ReturnType<typeof runP0>>;
	const replay = async (tamper?: Tamper, target?: string) => {
		const r = await runP0(
			config({
				mode: "replay",
				variant: tamper ? `replay-tamper-${tamper}` : "replay",
				replay: {
					from: base.files.manifest,
					entries: cassette(join(base.files.manifest, "..")),
					manifest: base.manifest,
				},
				...(tamper
					? {
							tamper: {
								kind: tamper,
								trialId: target ?? base.manifest.plan.trials[0]!,
							},
						}
					: {}),
			}),
		);
		return {
			r,
			diffs: compareRecords(
				readTrials(base.files.trials).records,
				readTrials(r.files.trials).records,
			),
			kinds: [
				...new Set(
					(r.runLog.mismatches as { kind: string }[]).map((m) => m.kind),
				),
			],
		};
	};

	test("P0-A06: the host's import is the vendored distribution, verified by checksum and module identity", async () => {
		base = await runP0(config({}));
		const d = base.manifest.identity.distribution as unknown as Record<
			string,
			any
		>;
		expect(d.kind).toBe("distribution");
		expect(d.entryRealpath).toContain("eumenes-agency@vendor+agency+");
		expect(d.entryRealpath).toEndWith("/dist/index.js");
		expect(Object.values(d.checks).every(Boolean)).toBe(true);
		expect(d.checks.hostImportIsLoadedModule).toBe(true);
		// R4: the installed dist is the artifact's package/dist file for file.
		expect(d.checks.installedDistMatchesArtifact).toBe(true);
		expect(d.artifactContents).toMatchObject({
			artifactFiles: 92,
			installedFiles: 92,
			missing: [],
			extra: [],
			changed: [],
		});
		expect(d.artifactSha256).toBe(d.vendorManifest.sha256);
		// The distribution is unchanged by the run.
		expect(treeDigest(join(d.packageDir, "dist")).digest).toBe(d.distDigest);
		expect(base.manifest.identity.agency.sha).toMatch(/^[0-9a-f]{40}$/);
		expect(base.manifest.identity.host.sha).toMatch(/^[0-9a-f]{40}$/);
	});

	test("P0-A01: the manifest holds the plan and identity before the run; pairs reject fixed or undeclared differences", () => {
		const m = base.manifest as unknown as Record<string, any>;
		expect(m.plan.trials).toHaveLength(
			subset.reduce((n, c) => n + c.steps.length, 0),
		);
		expect(checkPair(m, m, replayDeclaration)).toMatchObject({
			comparable: true,
			declared: [],
			fixedMismatch: [],
			undeclared: [],
		});
		const candidate = structuredClone(m);
		candidate.identity.distribution.distDigest = "candidate";
		candidate.observe = "observe";
		expect(checkPair(m, candidate, p1Declaration)).toMatchObject({
			comparable: true,
			declared: ["identity.distribution.distDigest", "observe"],
		});
		const prompt = structuredClone(candidate);
		prompt.fixed.composition.systemContextAssets.digest = "edited";
		expect(checkPair(m, prompt, p1Declaration)).toMatchObject({
			comparable: false,
			verdict: "hold",
			fixedMismatch: ["fixed.composition.systemContextAssets.digest"],
		});
		const clock = structuredClone(candidate);
		clock.fixed.clock.steps = "shifted";
		expect(checkPair(m, clock, p1Declaration).fixedMismatch).toEqual([
			"fixed.clock.steps",
		]);
		const extra = structuredClone(candidate);
		extra.newKnob = true;
		expect(checkPair(m, extra, p1Declaration)).toMatchObject({
			comparable: false,
			undeclared: ["newKnob"],
		});
		const missing = structuredClone(m);
		delete missing.identity.host.sha;
		expect(checkPair(m, missing, replayDeclaration).missing).toContain(
			"identity.host.sha",
		);
		expect(checkPair(m, missing, replayDeclaration).comparable).toBe(false);
	});

	test("P0-A02: the same requests replay to the same records; only transport ids are bound one-to-one", async () => {
		const { r, diffs, kinds } = await replay();
		expect(kinds).toEqual([]);
		expect(diffs).toEqual([]);
		expect(r.agg.outcomes).toEqual(base.agg.outcomes);
		const bound = new Set(r.runLog.identityMap.map((b) => b.kind));
		// The prefix case (M15) carries agentSession: its conversation and agent ids are bound as well.
		expect([...bound].sort()).toEqual([
			"agentId",
			"attemptId",
			"conversationId",
			"decisionId",
			"requestId",
		]);
		// Decision ids carry a per-process boot id: they differ and are bound, never rewritten in content.
		expect(
			r.runLog.identityMap.some(
				(b) => b.kind === "decisionId" && b.recorded !== b.replayed,
			),
		).toBe(true);
	});

	for (const [tamper, kind, part, target] of [
		["system", "request_digest_mismatch", "system", null],
		["options", "request_digest_mismatch", "options", null],
		["prefix", "request_digest_mismatch", "prompt", null],
		[
			"prefix-content",
			"request_digest_mismatch",
			"prompt",
			"M15-conversation-prefix/r1/s1",
		],
		[
			"session",
			"request_digest_mismatch",
			"options",
			"M15-conversation-prefix/r1/s1",
		],
		["drop-entry", "extra_call", null, null],
		["extra-entry", "unconsumed_response", null, null],
		["identity", "identity_conflict", null, null],
		["corrupt-response", "response_digest_mismatch", null, null],
	] as const)
		test(`P0-A02: a deliberate ${tamper} difference is detected at the replay boundary (${kind})`, async () => {
			const trial = target ?? base.manifest.plan.trials[0]!;
			const { r, kinds } = await replay(tamper, trial);
			expect(kinds).toContain(kind);
			const ms = r.runLog.mismatches as {
				trialId: string;
				kind: string;
				parts?: string[];
			}[];
			expect(ms.every((m) => m.trialId === trial)).toBe(true);
			if (part) expect(ms.find((m) => m.kind === kind)?.parts).toContain(part);
			const rec = readTrials(r.files.trials).records.find(
				(x) => x.trialId === trial,
			)!;
			expect(rec.result.outcome).toBe("runner_error");
			expect(rec.result.basis).toStartWith("replay_mismatch:");
			// Nothing was served for the refused attempt (an unconsumed entry refuses no attempt).
			if (kind !== "unconsumed_response") {
				expect(rec.measurement.refusedAttempts).toBeGreaterThan(0);
				expect(rec.measurement.refusals.map((x) => x.reason)).toContain(kind);
			}
		});

	test("P0-A02 (R5): the conversation-prefix case is built by the product assembly and llm-port, and replays", () => {
		const lines = readFileSync(base.files.requests, "utf8")
			.split("\n")
			.filter(Boolean)
			.map((l) => JSON.parse(l))
			.filter((l) => l.trialId === "M15-conversation-prefix/r1/s1");
		expect(lines.map((l) => [l.purpose, l.disposition])).toEqual([
			["update", "served"],
			["select", "served"],
		]);
		for (const l of lines) {
			// llm-port drops the prefix's own system message and sends the purpose system first.
			expect(l.system).not.toContain("合成: 会話のsystem");
			expect(l.prompt.map((m: { role: string }) => m.role)).toEqual([
				"user",
				"assistant",
				"user",
			]);
			const last = l.prompt.at(-1).content as string;
			expect(last).toStartWith("合成: 左の図の凡例が気になる。");
			expect(last).toContain("## State\n合成: 画面なし。");
			expect(last).toContain("## Task\n{");
			// Product session for a call on the conversation: identities as tokens, agentId equal to conversationId.
			expect(l.options.session).toMatchObject({
				sessionRole: "auxiliary",
				onConversation: true,
			});
			expect(l.options.session.agentSession.conversationId).toBe(
				l.options.session.agentSession.agentId,
			);
			expect(l.options.session.agentSession.conversationId).toMatch(
				/^<identity:\d+>$/,
			);
		}
	});

	test("P0-A02: a changed response with matching requests is caught by the record comparison", async () => {
		const { kinds, diffs } = await replay("response");
		expect(kinds).toEqual([]);
		const fields = diffs.map((d) => d.field);
		expect(fields).toContain("proposal.action");
		expect(fields).toContain("core.ticketId");
		expect(fields).toContain("digests.responses");
	});

	test("P0-A02 (R1): only declared identities become tokens; every other session field is compared", () => {
		const capture = {
			decisionId: "c1.s.select.1",
			maxOutputTokens: 800,
			deadline: 1,
		};
		const messages = [
			{ role: "system", content: "S" },
			{ role: "user", content: "P" },
		];
		const parts = (
			agentSession: unknown,
			extra: Record<string, unknown> = {},
		) =>
			requestParts(capture, messages, undefined, {
				sessionRole: "auxiliary",
				outputSchema: { type: "object" },
				...(agentSession === undefined ? {} : { agentSession }),
				...extra,
			});
		const base = parts({ conversationId: "c1", agentId: "c1" });
		// The parent's counterexample: same conversation id, agentId one→two and an unknown field a→b.
		const one = parts({
			conversationId: "c1",
			agentId: "one",
			unexpected: "a",
		});
		const two = parts({
			conversationId: "c1",
			agentId: "two",
			unexpected: "b",
		});
		expect(one.digests.options).not.toBe(two.digests.options);
		expect(one.digests.request).not.toBe(two.digests.request);
		// agentId equal to conversationId vs a different agentId: the equality between identities is compared.
		expect(
			parts({ conversationId: "c1", agentId: "other" }).digests.options,
		).not.toBe(base.digests.options);
		// Missing, null, added and changed fields all differ.
		for (const variant of [
			parts({ conversationId: "c1" }),
			parts({ conversationId: "c1", agentId: null }),
			parts({ conversationId: "c1", agentId: "c1", unexpected: "a" }),
			parts(undefined),
			parts(
				{ conversationId: "c1", agentId: "c1" },
				{ sessionRole: "primary" },
			),
			parts({ conversationId: "c1", agentId: "c1" }, { extraTopLevel: 1 }),
		])
			expect(variant.digests.options).not.toBe(base.digests.options);
		// Declared identities alone may differ: renamed consistently, the digests are equal and the values are exposed for binding.
		const renamed = requestParts(
			{ ...capture, decisionId: "c9.t.select.4" },
			messages,
			undefined,
			{
				sessionRole: "auxiliary",
				outputSchema: { type: "object" },
				agentSession: { conversationId: "c9", agentId: "c9" },
			},
		);
		expect(renamed.digests).toEqual(base.digests);
		expect([
			renamed.decisionId,
			renamed.conversationId,
			renamed.agentId,
		]).toEqual(["c9.t.select.4", "c9", "c9"]);
		// Other request parts are still separate.
		const c = requestParts(
			{ ...capture, maxOutputTokens: 799 },
			[messages[0]!, { role: "user", content: "P " }],
			undefined,
			{
				sessionRole: "auxiliary",
				outputSchema: { type: "string" },
			},
		);
		const plain = parts(undefined);
		expect(c.digests.options).not.toBe(plain.digests.options);
		expect(c.digests.prompt).not.toBe(plain.digests.prompt);
		expect(c.digests.schema).not.toBe(plain.digests.schema);
		expect(c.digests.system).toBe(plain.digests.system);
		// The identity map still refuses a second, different binding in either direction (agentId included).
		const map = createIdentityMap();
		expect(map.bind("decisionId", "r1", "x1")).toBeNull();
		expect(map.bind("decisionId", "r1", "x1")).toBeNull();
		expect(map.bind("decisionId", "r1", "x2")).not.toBeNull();
		expect(map.bind("decisionId", "r2", "x1")).not.toBeNull();
		expect(map.bind("agentId", "one", "two")).toBeNull();
		expect(map.bind("agentId", "one", "three")).not.toBeNull();
		expect(map.bind("agentId", "four", "two")).not.toBeNull();
	});

	test("P0-A03/A05/A07: the baseline subset passes with expected rejections, no outward effect and known-unknown usage", () => {
		expect(base.agg.validation).toMatchObject({
			missing: [],
			duplicate: [],
			unknown: [],
		});
		expect(base.agg.outcomes).toEqual({ passed: base.agg.denominator });
		expect(base.agg.outwardEffects).toBe(0);
		expect(base.agg.calls.providerCalls).toBe(0);
		expect(base.agg.calls.refusedBeforeServe).toBe(0);
		expect(base.runLog.guards).toMatchObject({
			outboundFetchAttempts: 0,
			fixtureStore: ":memory:",
		});
		expect(base.runLog.guards.productDataDirAfter).toBe(
			base.runLog.guards.productDataDirBefore,
		);
		const records = readTrials(base.files.trials).records;
		const save = records.find((r) => r.caseId === "M10-save-failure")!;
		expect(save.hostAdmission).toMatchObject({
			status: "rejected",
			code: "fixture_save_failed",
			basis: "fixture_only",
		});
		expect(save.effects).toMatchObject({
			fixtureDelegationsStarted: 0,
			fixtureWorkRows: 0,
		});
		const allowed = records.find((r) => r.caseId === "dev-previous-task")!;
		expect(allowed.effects).toMatchObject({
			ticketsIssued: 1,
			fixtureDelegationsStarted: 1,
			fixtureWorkRows: 1,
			speech: 0,
		});
		const retry = records.find((r) => r.caseId === "M12-transient-retry")!;
		expect(retry.measurement.attempts).toBe(3);
		expect(retry.measurement.calls.map((c) => c.code)).toContain(
			"llm_call:connection",
		);
		// The product port reports 0 tokens where the attempt usage was absent; the record keeps it unknown.
		expect(base.agg.usage.inputTokens.total).toBeNull();
		expect(base.agg.usage.inputTokens.unknownAttempts).toBe(
			base.agg.calls.attempts,
		);
		expect(base.agg.calls.zeroFilledUsage).toBeGreaterThan(0);
		expect(
			retry.measurement.calls.every((c) => c.reportedInputTokens === 0),
		).toBe(true);
		expect(base.manifest.fixed.model.requested).toBeNull();
	});

	test("P0-A03: injected exceptions, provider failure, invalid output and a stop leave every planned trial", async () => {
		const r = await runP0(
			config({
				cases: faultCases,
				variant: "fault-injection",
				injectStopAfter: "F04-invalid-select",
			}),
		);
		const records = readTrials(r.files.trials).records;
		const by = new Map(records.map((x) => [x.trialId, x]));
		expect(r.agg.validation).toMatchObject({
			planned: 6,
			recorded: 6,
			missing: [],
			duplicate: [],
			unknown: [],
		});
		expect(by.get("F01-runner-exception/r1/s1")?.result).toMatchObject({
			outcome: "runner_error",
			basis: "injected_runner_exception",
		});
		expect(by.get("F02-provider-error/r1/s1")?.result.outcome).toBe(
			"model_error",
		);
		// An exception after the calls keeps the served attempts and their usage on the record (no measurement leak).
		const after = by.get("F03-runner-exception-after-calls/r1/s1")!;
		expect(after.result).toMatchObject({
			outcome: "runner_error",
			basis: "injected_runner_exception_after_calls",
		});
		expect(after.measurement.attempts).toBe(2);
		expect(after.measurement.attemptUsage).toHaveLength(2);
		expect(by.get("F04-invalid-select/r1/s1")?.result.outcome).toBe(
			"model_error",
		);
		for (const s of ["s1", "s2"])
			expect(by.get(`F05-two-steps-after-stop/r1/${s}`)?.result).toMatchObject({
				outcome: "incomplete",
				basis: "version_changed:injected",
			});
		expect(r.agg.calls.attempts).toBe(
			records.reduce((n, x) => n + x.measurement.attempts, 0),
		);
	});

	for (const [label, cases, max, servedTotal, stoppedAt] of [
		[
			"max=0 serves nothing",
			["dev-previous-task", "M04"],
			0,
			0,
			"dev-previous-task/r1/s1",
		],
		[
			"max=1 stops inside update→select",
			["M04", "dev-previous-task", "M01"],
			1,
			1,
			"dev-previous-task/r1/s1",
		],
		[
			"max=2 stops inside a retry",
			["M12", "M01"],
			2,
			2,
			"M12-transient-retry/r1/s1",
		],
		[
			"max=3 stops in the second step",
			["M08", "M01"],
			3,
			3,
			"M08-restart/r1/s2",
		],
	] as const)
		test(`P0-A03/A07 (R3): the attempt cap is never exceeded — ${label}`, async () => {
			const r = await runP0(
				config({
					cases: ordered(...cases),
					maxAttempts: max,
					variant: `cap-${max}`,
				}),
			);
			const records = readTrials(r.files.trials).records;
			const plan = r.manifest.plan.trials;
			expect(records.map((x) => x.trialId)).toEqual(plan);
			expect(r.agg.validation).toMatchObject({
				missing: [],
				duplicate: [],
				unknown: [],
			});
			const served = records.reduce((n, x) => n + x.measurement.attempts, 0);
			expect(served).toBe(servedTotal);
			expect(served).toBeLessThanOrEqual(max);
			expect((r.runLog as any).inference.served).toBe(servedTotal);
			const at = plan.indexOf(stoppedAt);
			for (const [i, x] of records.entries()) {
				if (i < at) expect(x.result.outcome).toBe("passed");
				else {
					expect(x.result.outcome).toBe("incomplete");
					expect(x.result.basis).toContain("cost_exceeded:attempt_cap");
				}
			}
			const stopped = records[at]!;
			// The refused attempt is counted apart from served ones; nothing is turned into a success.
			if (max > 0) {
				expect(stopped.measurement.refusedAttempts).toBe(1);
				expect(stopped.measurement.refusals[0]?.reason).toBe("attempt_cap");
			}
			expect(r.agg.calls.refusedBeforeServe).toBe(max > 0 ? 1 : 0);
			expect(r.agg.outcomes.passed ?? 0).toBe(at);
		});

	test("P0-A03/A08: missing, duplicate and unknown records are found; the aggregate regenerates from raw only", () => {
		const raw = readFileSync(base.files.trials, "utf8")
			.split("\n")
			.filter(Boolean);
		const records = readTrials(base.files.trials).records;
		const plan = base.manifest.plan.trials;
		const lossy = [
			...records.slice(1),
			records[1]!,
			{ ...records[1]!, trialId: "unknown/r1/s1" },
		];
		const check = validateRecords(plan, lossy);
		expect(check.missing).toEqual([plan[0]!]);
		expect(check.duplicate).toEqual([records[1]!.trialId]);
		expect(check.unknown).toEqual(["unknown/r1/s1"]);
		expect(aggregate(plan, lossy).incomplete).toContain(
			`${plan[0]}:record_missing`,
		);
		// Raw file untouched; regenerated aggregate equals the stored one.
		expect(
			readFileSync(base.files.trials, "utf8").split("\n").filter(Boolean),
		).toEqual(raw);
		const stored = JSON.parse(readFileSync(base.files.aggregate, "utf8"));
		const { parseErrors: _p, manifestDigest: _m, ...rest } = stored;
		expect(canonical(aggregate(plan, records))).toBe(canonical(rest));
		expect(stored.manifestDigest).toBe(digest(base.manifest));
	});

	test("P0-A08: generated files carry no secret-shaped content; the detector itself finds a planted one", () => {
		expect(scanForSecrets(Object.values(base.files)).hits).toEqual([]);
		const planted = join(tmp(), "planted.txt");
		writeFileSync(planted, "token sk-abcdefghijklmnop end");
		expect(scanForSecrets([planted]).hits).toHaveLength(1);
	});
});

describe("P0 record semantics (mock records)", () => {
	const blank = (over: Partial<Record<string, any>> = {}): TrialRecord =>
		({
			schema: "agency-p0-trial.v2",
			runId: "mock",
			trialId: over.trialId ?? crypto.randomUUID(),
			caseId: "mock",
			rep: 1,
			step: "s1",
			split: "dev",
			lane: "fixture",
			variant: "mock",
			digests: {
				manifest: "",
				input: "",
				requests: [],
				responses: [],
				finalSnapshot: null,
			},
			proposal: {
				action: null,
				candidateRef: null,
				evidenceRefs: [],
				reason: null,
				valueNow: null,
				lossIfWait: null,
				nullReason: null,
				...over.proposal,
			},
			core: {
				eligibleAction: null,
				decisionAction: null,
				source: "llm",
				rejectCodes: [],
				blockCodes: [],
				wakeReasons: [],
				ticketId: null,
				candidateId: null,
				...over.core,
			},
			hostAdmission: {
				status: "not_checked",
				gate: null,
				at: null,
				basis: null,
				code: null,
				...over.hostAdmission,
			},
			suppression: {
				status: "not_applicable",
				reason: null,
				source: "none",
				...over.suppression,
			},
			effects: {
				ticketsIssued: 0,
				reservations: 0,
				fixtureDelegationsStarted: 0,
				fixtureWorkRows: 0,
				speech: 0,
				notifications: 0,
				productWrites: 0,
				actionReceipts: 0,
				observeEffects: 0,
				outboundNetwork: 0,
				controlReceiptsAccepted: 0,
				controlReceiptsRejected: 0,
			},
			measurement: {
				calls: [],
				logicalCalls: 0,
				attempts: 0,
				refusedAttempts: 0,
				refusals: [],
				providerCalls: 0,
				attemptUsage: over.attemptUsage ?? [],
				zeroFilledUsage: 0,
				clock: [],
				wallMs: 0,
				cost: { amount: null, basis: "mock" },
				missing: [],
			},
			result: {
				outcome: "passed",
				basis: "mock",
				recordComplete: true,
				scorable: over.scorable ?? true,
				expectedRejection: null,
				mismatches: [],
			},
			label: over.label ?? null,
		}) as TrialRecord;

	test("P0-A04: model wait, core rejection, host rejection and (mock) observe suppression are separate", () => {
		const b = decisionBuckets([
			blank({ proposal: { action: "wait" } }),
			blank({
				proposal: { action: "speak" },
				core: { source: "rejected", rejectCodes: ["unknown_ref"] },
			}),
			blank({
				proposal: { action: "tool" },
				core: { eligibleAction: "tool", ticketId: "a1" },
				hostAdmission: {
					status: "rejected",
					code: "agency_capability_unavailable",
				},
			}),
			blank({
				proposal: { action: "speak" },
				core: { eligibleAction: "speak" },
				suppression: {
					status: "suppressed",
					reason: "observe",
					source: "mock",
				},
			}),
			blank({ core: { source: "host_budget" } }),
		]);
		expect(b).toEqual({
			modelWait: 1,
			coreRejected: 1,
			hostAdmissionRejected: 1,
			suppressed: 1,
			hostGate: 1,
			selectNotReached: 1,
			coreEligibleOutward: 2,
		});
	});

	test("P0-A04: a gate-stopped proposal stays a FP, a reference rejection is not a fitting wait, unscorable widens the range", () => {
		const prohibited = {
			need: "prohibited",
			allowedActions: ["wait"],
			origin: "mock",
		};
		const required = {
			need: "required",
			allowedActions: ["tool"],
			origin: "mock",
		};
		const s = semanticCounts([
			blank({
				label: prohibited,
				proposal: { action: "speak" },
				core: { source: "rejected", rejectCodes: ["unknown_ref"] },
			}),
			blank({ label: prohibited, proposal: { action: "wait" } }),
			blank({ label: prohibited, scorable: false }),
			blank({
				label: required,
				proposal: { action: "tool" },
				core: { source: "rejected", rejectCodes: ["unknown_ref"] },
			}),
			blank({ label: required, proposal: { action: "wait" } }),
			blank({
				label: {
					need: "optional",
					allowedActions: ["wait", "speak"],
					origin: "mock",
				},
				proposal: { action: "wait" },
			}),
		]);
		expect(s.prohibited).toEqual({
			planned: 3,
			fp: 1,
			undetermined: 1,
			fpRate: [1 / 3, 2 / 3],
		});
		expect(s.required.fnCauses).toEqual({
			modelWait: 1,
			contractRejected: 1,
			hostRejected: 0,
			unobserved: 0,
		});
		expect(s.optionalWaitNotCountedAsMiss).toBe(1);
		expect(semanticCounts([]).prohibited.fpRate).toBeNull();
	});

	test("P0-A07: absent usage is unknown, never 0; known usage is summed per attempt", () => {
		const known = {
			model: "served",
			inputTokens: 10,
			outputTokens: 2,
			cacheReadTokens: 0,
		};
		const all = usageTotals([
			blank({
				attemptUsage: [
					{ attemptId: "a", purpose: "update", usage: known, served: "value" },
					{ attemptId: "b", purpose: "select", usage: known, served: "value" },
				],
			}),
		]);
		expect(all.inputTokens).toEqual({
			known: 20,
			unknownAttempts: 0,
			total: 20,
		});
		const partial = usageTotals([
			blank({
				attemptUsage: [
					{ attemptId: "a", purpose: "update", usage: known, served: "value" },
					{ attemptId: "b", purpose: "update", usage: null, served: "value" },
				],
			}),
		]);
		expect(partial.inputTokens).toEqual({
			known: 10,
			unknownAttempts: 1,
			total: null,
		});
		expect(partial.models).toEqual({ served: 1, unknown: 1 });
	});

	test("P0-A03: a stop reports every remaining planned trial as incomplete", async () => {
		const lines: string[] = [];
		let n = 0;
		const totals = await runTrials(
			[{ id: "a" }, { id: "b" }, { id: "c" }],
			1,
			async () => ({ outcome: "passed" }),
			(r) => lines.push(`${r.case}:${r.outcome}`),
			{ stop: () => (++n > 1 ? "safety_violation" : null) },
		);
		expect(lines).toEqual(["a:passed", "b:incomplete", "c:incomplete"]);
		expect(totals).toEqual({
			planned: 3,
			completed: 1,
			failed: 2,
			stopped: "safety_violation",
		});
	});
});

describe("P0-A06 (R4): the installed dist must be the artifact's package/dist, file for file", () => {
	const tarGz = (files: Record<string, string>) => {
		const blocks: Uint8Array[] = [];
		const enc = new TextEncoder();
		for (const [name, text] of Object.entries(files)) {
			const body = enc.encode(text);
			const h = new Uint8Array(512);
			const put = (s: string, at: number) => h.set(enc.encode(s), at);
			put(name, 0);
			put("0000644\0", 100);
			put("0000000\0", 108);
			put("0000000\0", 116);
			put(body.length.toString(8).padStart(11, "0") + "\0", 124);
			put("00000000000\0", 136);
			put("        ", 148);
			put("0", 156);
			put("ustar\0", 257);
			put("00", 263);
			const sum = h.reduce((n, b) => n + b, 0);
			put(sum.toString(8).padStart(6, "0") + "\0 ", 148);
			blocks.push(h, body, new Uint8Array((512 - (body.length % 512)) % 512));
		}
		blocks.push(new Uint8Array(1024));
		return Bun.gzipSync(Buffer.concat(blocks));
	};
	const constants =
		'export const INSTRUCTION_VERSION = "v-1";\nexport const HOST_RULES_VERSION = "r-1";\n';
	const packed = {
		"package/package.json": JSON.stringify({
			name: "eumenes-agency",
			version: "9.9.9",
			exports: { ".": { default: "./dist/index.js" } },
		}),
		"package/dist/index.js": constants,
		"package/dist/core.js": "export const core = 1;\n",
	};
	/** A disposable host with the vendored artifact installed; `edit` changes the installed dist only. */
	const fakeHost = (edit: (dist: string) => void = () => {}) => {
		const root = mkdtempSync(join(tmpdir(), "agency-p0-fakehost-"));
		const artifact = "eumenes-agency-9.9.9-test.tgz";
		const bytes = tarGz(packed);
		mkdirSync(join(root, "api/application/agency"), { recursive: true });
		writeFileSync(
			join(root, "api/application/agency/runtime.ts"),
			"export {};\n",
		);
		mkdirSync(join(root, "vendor/agency"), { recursive: true });
		writeFileSync(join(root, "vendor/agency", artifact), bytes);
		writeFileSync(
			join(root, "vendor/agency/manifest.json"),
			JSON.stringify({
				artifact,
				sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
				version: "9.9.9",
				INSTRUCTION_VERSION: "v-1",
				HOST_RULES_VERSION: "r-1",
			}),
		);
		writeFileSync(
			join(root, "package.json"),
			JSON.stringify({
				dependencies: { "eumenes-agency": `file:vendor/agency/${artifact}` },
			}),
		);
		writeFileSync(
			join(root, "bun.lock"),
			`"eumenes-agency": ["eumenes-agency@vendor/agency/${artifact}"]\n`,
		);
		const pkg = join(root, "node_modules/eumenes-agency");
		mkdirSync(join(pkg, "dist"), { recursive: true });
		writeFileSync(join(pkg, "package.json"), packed["package/package.json"]);
		writeFileSync(join(pkg, "dist/index.js"), packed["package/dist/index.js"]);
		writeFileSync(join(pkg, "dist/core.js"), packed["package/dist/core.js"]);
		edit(join(pkg, "dist"));
		return root;
	};

	test("the vendored artifact and the installed dist of this host have no difference", () => {
		if (!hasHost) return;
		const manifest = JSON.parse(
			readFileSync(resolve(host, "vendor/agency/manifest.json"), "utf8"),
		);
		const installed = resolve(
			realpathSync(
				Bun.resolveSync(
					"eumenes-agency",
					resolve(host, "api/application/agency"),
				),
			),
			"..",
		);
		const result = compareArtifactToInstalled(
			readFileSync(resolve(host, "vendor/agency", manifest.artifact)),
			installed,
		);
		expect(result).toEqual({
			artifactFiles: 92,
			installedFiles: 92,
			missing: [],
			extra: [],
			changed: [],
			equal: true,
		});
	});

	test("an unchanged install passes every check", async () => {
		const { identity } = await loadDistribution(fakeHost());
		expect(identity.artifactContents).toMatchObject({
			artifactFiles: 2,
			installedFiles: 2,
			equal: true,
		});
		expect(Object.values(identity.checks).every(Boolean)).toBe(true);
	});

	for (const [label, edit, field] of [
		[
			"a changed file",
			(d: string) =>
				writeFileSync(join(d, "core.js"), "export const core = 2;\n"),
			"changed",
		],
		["a missing file", (d: string) => rmSync(join(d, "core.js")), "missing"],
		[
			"an added file",
			(d: string) => writeFileSync(join(d, "extra.js"), "export {};\n"),
			"extra",
		],
	] as const)
		test(`${label} is detected although checksum, version and constants still match`, async () => {
			const { identity } = await loadDistribution(fakeHost(edit));
			expect(identity.artifactContents[field]).toEqual([
				label === "an added file" ? "extra.js" : "core.js",
			]);
			expect(identity.checks.installedDistMatchesArtifact).toBe(false);
			for (const k of [
				"artifactChecksumMatchesManifest",
				"installedVersionMatches",
				"instructionVersionMatches",
				"hostRulesVersionMatches",
				"hostDependsOnArtifact",
				"lockfileReferencesArtifact",
			])
				expect(identity.checks[k]).toBe(true);
		});
});
