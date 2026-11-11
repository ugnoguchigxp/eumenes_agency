/**
 * Packs the host-neutral core (src/) as a versioned tarball for vendoring into a host
 * (Eumenes): dist (JS + .d.ts) only, built from src with .ts imports rewritten to .js.
 *
 *   bun scripts/pack.ts                  build, write artifacts/pack/<tgz> + manifest.json, verify
 *   bun scripts/pack.ts --check [tgz]    verify an existing tarball (default: the one in manifest.json)
 *   bun scripts/pack.ts --out <dir>      write elsewhere (default artifacts/pack)
 */
import { createHash } from "node:crypto";
import {
	existsSync,
	readdirSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { HOST_RULES_VERSION, INSTRUCTION_VERSION } from "../src/index.ts";

const root = resolve(import.meta.dir, "..");
const defaultOut = join(root, "artifacts", "pack");

/** Names a host needs from the package; the check imports dist/index.js and requires them. */
export const requiredExports = [
	"createAgencyRuntime",
	"projectAgencyState",
	"createIdlePlanner",
	"createIdleScheduler",
	"defaultIdleSec",
	"defaultMaxUnanswered",
	"maxIdleSec",
	"maxTimerMs",
	"spokenReplyStyle",
	"runRespond",
	"respondSystem",
	"respondSystemParts",
	"respondReferenceData",
	"agencyOutputContract",
	"replyOutputContract",
	"replyResultSchema",
	"ReplyOutputError",
	"budgetConfigSchema",
	"limitsSchema",
	"SystemContextConfigurationError",
	"createMockToolPort",
	"ttsUtteranceStyle",
	"INSTRUCTION_VERSION",
	"HOST_RULES_VERSION",
	// always-on (spec/always-on-agency-design-2026-11-07.md, docs/always-on-eumenes-handoff-2026-11-07.md)
	"createAlwaysOnAgent",
	"createHeartbeat",
	"createHeartbeatScheduler",
	"defaultHeartbeat",
	"alwaysOnSystem",
	"alwaysOnSystemParts",
	"alwaysOnOutputContract",
	"thinkSchema",
	"speechIntervals",
	"ALWAYS_ON_VERSION",
] as const;

/** Names a host needs from `eumenes-agency/agenda` (the agenda agent, spec 2026-11-08). */
export const requiredAgendaExports = [
	"createAgendaAgent",
	"agendaSnapshotSchema",
	"AGENDA_SNAPSHOT_VERSION",
	"AGENDA_VERSION",
	"speechIntervals",
	"defaultSpeechIntervalSec",
	"defaultPersona",
	"emptyProfile",
	"updateProfile",
	"profileLines",
	"PROFILE_TITLE",
	"declinesOffer",
	"endsWithQuestion",
	"asksQuestion",
	// The host loop and the reply: what the CLI runs, for Eumenes to run the same (steer is the host's).
	"createAgendaHost",
	"createAgendaReplyTools",
	"agendaReplyMessages",
	"agendaReplySystem",
	"dropRepeatedSentences",
	"notesMentioned",
	"START_PREPARATION",
	"READ_NOTE",
	"SHOW_NOTE",
	"SET_QUIET",
	"FIND_TOOLCHAIN",
	"DELEGATE",
	"ADDED_WORDS_MARK",
	"addedWordsLine",
] as const;

/** The package's entry points: the core and the agenda agent. */
const entryPoints = {
	".": { types: "./dist/index.d.ts", default: "./dist/index.js" },
	"./agenda": {
		types: "./dist/agenda/index.d.ts",
		default: "./dist/agenda/index.js",
	},
} as const;

/** Only these may appear in the tarball. */
const allowedPath = /^package\/(package\.json|LICENSE|dist\/.+\.(js|d\.ts))$/;
const forbiddenPath =
	/(^|\/)(standalone|eval|data|test|tests|config|scripts|spec|labels|src|node_modules)(\/|$)|(^|\/)\.env|\.test\.|\.map$/;

type Result = { code: number; out: string; err: string };

async function run(
	cmd: string[],
	opts: { cwd?: string; env?: Record<string, string> } = {},
): Promise<Result> {
	const child = Bun.spawn(cmd, {
		cwd: opts.cwd ?? root,
		env: { ...process.env, ...opts.env },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [out, err, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	return { code, out, err };
}

async function must(cmd: string[], cwd?: string): Promise<string> {
	const r = await run(cmd, cwd === undefined ? {} : { cwd });
	if (r.code !== 0)
		throw new Error(`${cmd.join(" ")} failed (${r.code}): ${r.err || r.out}`);
	return r.out;
}

const sha256 = (path: string) =>
	createHash("sha256").update(readFileSync(path)).digest("hex");

interface RootPackage {
	readonly name: string;
	readonly version: string;
	readonly license: string;
	readonly dependencies?: Record<string, string>;
}
const rootPackage = (): RootPackage =>
	JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as RootPackage;

/** tsc keeps `.ts` specifiers in declaration files; point them at `.js` like the emitted code. */
function rewriteDeclarationSpecifiers(dir: string): void {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) rewriteDeclarationSpecifiers(path);
		else if (entry.name.endsWith(".d.ts")) {
			const text = readFileSync(path, "utf8");
			const out = text.replace(/(["'])(\.{1,2}\/[^"']*)\.ts\1/g, "$1$2.js$1");
			if (out !== text) writeFileSync(path, out);
		}
	}
}

/** package.json inside the tarball: dist entry points and the runtime dependencies src needs (zod). */
export function tarballPackageJson(pkg: RootPackage) {
	const zod = pkg.dependencies?.zod;
	if (zod === undefined) throw new Error("package.json has no zod dependency");
	return {
		name: "eumenes-agency",
		version: pkg.version,
		license: pkg.license,
		description: "Eumenes agency core (local distribution, unpublished).",
		type: "module",
		sideEffects: false,
		exports: {
			...entryPoints,
			"./package.json": "./package.json",
		},
		files: ["dist", "LICENSE"],
		dependencies: { zod },
	};
}

/** Verifies a tarball: contents, shape, and that the built entry imports and exposes the API. */
export async function checkTarball(tgz: string): Promise<string[]> {
	const errors: string[] = [];
	const listed = (await must(["tar", "-tzf", tgz]))
		.split("\n")
		.filter((p) => p !== "" && !p.endsWith("/"));
	for (const path of listed) {
		if (forbiddenPath.test(path)) errors.push(`forbidden path: ${path}`);
		else if (!allowedPath.test(path)) errors.push(`unexpected path: ${path}`);
	}
	for (const need of [
		"package/package.json",
		"package/dist/index.js",
		"package/dist/index.d.ts",
		"package/dist/agenda/index.js",
		"package/dist/agenda/index.d.ts",
	])
		if (!listed.includes(need)) errors.push(`missing: ${need}`);
	if (errors.length > 0) return errors;

	const dir = mkdtempSync(join(tmpdir(), "agency-pack-"));
	try {
		await must(["tar", "-xzf", tgz, "-C", dir]);
		const pkgDir = join(dir, "package");
		if (
			!existsSync(join(pkgDir, "LICENSE")) ||
			readFileSync(join(pkgDir, "LICENSE"), "utf8") !==
				readFileSync(join(root, "LICENSE"), "utf8")
		)
			errors.push("LICENSE missing or different from source");
		const pkg = JSON.parse(
			readFileSync(join(pkgDir, "package.json"), "utf8"),
		) as {
			name?: string;
			exports?: Record<string, unknown>;
			dependencies?: Record<string, string>;
		};
		if (pkg.name !== "eumenes-agency") errors.push("package name");
		for (const [entry, want] of Object.entries(entryPoints)) {
			const got = JSON.stringify(pkg.exports?.[entry]);
			if (got !== JSON.stringify(want))
				errors.push(`exports "${entry}" is ${got}`);
		}
		if (Object.keys(pkg.dependencies ?? {}).join() !== "zod")
			errors.push("dependencies must be exactly zod");
		const dts = readFileSync(join(pkgDir, "dist", "index.d.ts"), "utf8");
		if (!dts.includes("./application/idle.js"))
			errors.push("index.d.ts does not re-export the idle module");
		for (const path of listed.filter((p) => /\.(js|d\.ts)$/.test(p))) {
			const text = readFileSync(join(dir, path), "utf8");
			if (/["']\.{1,2}\/[^"']*\.ts["']/.test(text))
				errors.push(`${path} still imports a .ts file`);
		}
		// Resolve zod from the repo's install, as a host's node_modules would.
		mkdirSync(join(pkgDir, "node_modules"));
		symlinkSync(
			join(root, "node_modules", "zod"),
			join(pkgDir, "node_modules", "zod"),
		);
		// A host installs the package under its name and imports it by name (the exports map, not
		// paths into dist): the core and the agenda subpath.
		const host = join(dir, "host");
		mkdirSync(join(host, "node_modules"), { recursive: true });
		symlinkSync(pkgDir, join(host, "node_modules", "eumenes-agency"), "dir");
		writeFileSync(
			join(host, "probe.mjs"),
			`const core = await import("eumenes-agency");
const agenda = await import("eumenes-agency/agenda");
console.log(JSON.stringify({ core: Object.keys(core), agenda: Object.keys(agenda) }));
`,
		);
		const probe = await run([process.execPath, join(host, "probe.mjs")], {
			cwd: host,
		});
		if (probe.code !== 0) errors.push(`import failed: ${probe.err.trim()}`);
		else {
			const got = JSON.parse(probe.out) as {
				core: string[];
				agenda: string[];
			};
			const core = new Set(got.core);
			for (const name of requiredExports)
				if (!core.has(name)) errors.push(`missing export: ${name}`);
			const agenda = new Set(got.agenda);
			for (const name of requiredAgendaExports)
				if (!agenda.has(name))
					errors.push(`missing export: eumenes-agency/agenda ${name}`);
		}
		// Compile a host against only the emitted declarations, including the breaking changes.
		const consumer = join(pkgDir, "consumer.ts");
		writeFileSync(
			consumer,
			`
import {
  createAgencyRuntime, runRespond, agencyOutputContract, respondSystem,
  type RuntimeDeps, type RespondInput, type BackgroundSystemContext,
} from "./dist/index.js";
declare const deps: Omit<RuntimeDeps, "systemContext">;
declare const reply: Omit<RespondInput, "messages">;
const systemContext: BackgroundSystemContext = {
  update: ({ data, outputContract }) => data.condition + outputContract.description,
  select: ({ data }) => "host: " + data.opportunity.trigger,
};
createAgencyRuntime({ ...deps, systemContext });
createAgencyRuntime({ ...deps, systemContext: "experimental" });
agencyOutputContract("update", { condition: "B1", hostTodos: true }).schema;
runRespond({ ...reply, messages: [{ role: "system", content: "host instructions" }] });
// @ts-expect-error explicit SystemContext selection is required
createAgencyRuntime(deps);
// @ts-expect-error reference data no longer belongs in the system helper
respondSystem({ opening: ["recorded utterance"] });
`,
		);
		const types = await run(
			[
				join(root, "node_modules", ".bin", "tsc"),
				"--noEmit",
				"--strict",
				"--skipLibCheck",
				"--target",
				"ES2022",
				"--module",
				"ESNext",
				"--moduleResolution",
				"Bundler",
				consumer,
			],
			{ cwd: pkgDir },
		);
		if (types.code !== 0)
			errors.push(`consumer types failed: ${types.out || types.err}`);
		// The agenda agent, typed through the package name: create, save, restore.
		const agendaConsumer = join(host, "agenda-consumer.ts");
		writeFileSync(
			agendaConsumer,
			`
import type { LlmPort } from "eumenes-agency";
import {
  createAgendaAgent, agendaSnapshotSchema,
  type AgendaAgent, type AgendaDeps, type AgendaSnapshot,
} from "eumenes-agency/agenda";
declare const llm: LlmPort;
const agent: AgendaAgent = createAgendaAgent({ llm, startedAt: 0 });
const saved: AgendaSnapshot = agendaSnapshotSchema.parse(JSON.parse(JSON.stringify(agent.snapshot(0))));
const deps: AgendaDeps = { llm, startedAt: 1, restore: saved };
createAgendaAgent(deps).requestResearch({ text: "q", at: 1 });
// @ts-expect-error a snapshot is the agent's, not any object
createAgendaAgent({ llm, startedAt: 1, restore: { items: [] } });

// The host loop with the reply, as a host wires them; the host's steer fills addedWords.
import { runRespond, type ReplyPort } from "eumenes-agency";
import {
  createAgendaHost, agendaReplyMessages,
  type AgendaHostEvent, type AgendaAddedWords,
} from "eumenes-agency/agenda";
declare const chat: ReplyPort;
declare const setTimer: (fn: () => void, ms: number) => unknown;
declare const clearTimer: (handle: unknown) => void;
declare const addedWords: AgendaAddedWords;
const live = createAgendaAgent({ llm, startedAt: 0 });
const host = createAgendaHost({
  agent: live,
  notes: { read: () => null, list: () => [] },
  research: { start: (t) => t.text !== "" },
  addedWords,
  reply: async (a, tools, addWords) => {
    const r = await runRespond({
      messages: agendaReplyMessages({ agent: a, known: [], notes: [], clock: null, now: 0 }),
      chat: addWords(chat), tools, emotion: true,
      signal: new AbortController().signal, onDelta: () => undefined,
    });
    return { text: r.text, calls: r.calls, emotion: r.emotion ?? null };
  },
  now: () => 0, setTimer, clearTimer,
  emit: (e: AgendaHostEvent) => void e,
});
void host.say("こんにちは").then(() => host.flush());
host.researchReturned({ ticketId: "t1", status: "failed", note: null });
`,
		);
		const agendaTypes = await run(
			[
				join(root, "node_modules", ".bin", "tsc"),
				"--noEmit",
				"--strict",
				"--skipLibCheck",
				"--target",
				"ES2022",
				"--module",
				"ESNext",
				"--moduleResolution",
				"Bundler",
				agendaConsumer,
			],
			{ cwd: host },
		);
		if (agendaTypes.code !== 0)
			errors.push(
				`agenda consumer types failed: ${agendaTypes.out || agendaTypes.err}`,
			);
		// The built JavaScript at work: the host loop with a host's added-words seam (a minimal
		// stand-in for its steer). Words the user sends while the reply reads a note go into the
		// reply's next model call, and get no reply of their own.
		writeFileSync(
			join(host, "added-words-probe.mjs"),
			`import { runRespond } from "eumenes-agency";
import {
  createAgendaAgent, createAgendaHost, addedWordsLine, READ_NOTE,
} from "eumenes-agency/agenda";
const llm = { async complete(req) {
  const v = req.system.includes("この呼び出しは「計画」") ? { add: [], drop: [], focus: "" }
    : { utterance: null, emotion: null, decline: "なし", questions: 0, choice: false };
  return { value: req.schema.parse(v), model: "probe", inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, latencyMs: 1 };
} };
const agent = createAgendaAgent({ llm, startedAt: 0 });
const seen = [];
const replies = [];
const pending = [];
const host = createAgendaHost({
  agent,
  notes: { read: (id) => ({ id, title: "店", markdown: "辛味噌の店" }), list: () => [] },
  research: { start: () => true },
  addedWords: (() => {
    let sent = [];
    return {
      begin: () => {
        const taken = [];
        return {
          wrap: (inner) => ({ complete: (request, onDelta, signal) => {
            for (const id of sent) taken.push(id);
            const words = sent.map((id) => ({ role: "user",
              content: addedWordsLine(agent.view().said.find((s) => s.id === id)?.text ?? "") }));
            sent = [];
            return inner.complete({ ...request, messages: [...request.messages, ...words] }, onDelta, signal);
          } }),
          end: () => taken,
        };
      },
      send: (id) => { sent.push(id); return true; },
    };
  })(),
  reply: async (a, tools, addWords) => {
    const chat = { async complete(request) {
      seen.push(request.messages);
      if (seen.length > 1) return { text: "塩ですね。", toolCalls: [] };
      pending.push(host.say("あと、塩で"));
      return { text: "", toolCalls: [{ id: "c1", name: READ_NOTE, arguments: '{"id":"n1"}' }] };
    } };
    const r = await runRespond({
      messages: [{ role: "system", content: "返事" }, { role: "user", content: "ラーメン" }],
      chat: addWords(chat), tools, emotion: false,
      signal: new AbortController().signal, onDelta: () => undefined,
    });
    return { text: r.text, calls: r.calls };
  },
  now: Date.now,
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (h) => clearTimeout(h),
  emit: (e) => { if (e.type === "reply") replies.push(e.text); },
});
await host.say("ラーメン");
await Promise.all(pending);
await host.flush();
host.close();
const ok = seen.length === 2 && seen[1].some((m) => m.content === addedWordsLine("あと、塩で"))
  && replies.length === 1 && replies[0] === "塩ですね。";
console.log(JSON.stringify({ ok, calls: seen.length, replies }));
process.exit(ok ? 0 : 1);
`,
		);
		const wordsProbe = await run(
			[process.execPath, join(host, "added-words-probe.mjs")],
			{ cwd: host },
		);
		if (wordsProbe.code !== 0)
			errors.push(
				`agenda host with added words failed: ${wordsProbe.out.trim() || wordsProbe.err.trim()}`,
			);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
	return errors;
}

export interface PackResult {
	readonly tgz: string;
	readonly manifestPath: string;
	readonly manifest: Record<string, unknown>;
}

/** Builds dist from src and writes the tarball, its .sha256 and manifest.json into `outDir`. */
export async function pack(outDir = defaultOut): Promise<PackResult> {
	const pkg = rootPackage();
	const sha = (await must(["git", "rev-parse", "HEAD"])).trim();
	const dirty =
		(await must(["git", "status", "--porcelain", "--", "src"])).trim() !== "";
	const sha12 = sha.slice(0, 12);

	mkdirSync(outDir, { recursive: true });
	const stage = mkdtempSync(join(outDir, ".stage-"));
	try {
		const pkgDir = join(stage, "package");
		mkdirSync(pkgDir);
		writeFileSync(join(pkgDir, "LICENSE"), readFileSync(join(root, "LICENSE")));
		await must([
			join(root, "node_modules", ".bin", "tsc"),
			"-p",
			join(root, "tsconfig.build.json"),
			"--outDir",
			join(pkgDir, "dist"),
		]);
		rewriteDeclarationSpecifiers(join(pkgDir, "dist"));
		writeFileSync(
			join(pkgDir, "package.json"),
			`${JSON.stringify(tarballPackageJson(pkg), null, "\t")}\n`,
		);
		const name = `eumenes-agency-${pkg.version}-${sha12}.tgz`;
		const tgz = join(outDir, name);
		const r = await run(["tar", "-czf", tgz, "-C", stage, "package"], {
			env: { COPYFILE_DISABLE: "1" },
		});
		if (r.code !== 0) throw new Error(`tar failed: ${r.err}`);
		const digest = sha256(tgz);
		writeFileSync(`${tgz}.sha256`, `${digest}  ${name}\n`);
		const manifest = {
			package: "eumenes-agency",
			version: pkg.version,
			artifact: name,
			sha256: digest,
			size: readFileSync(tgz).byteLength,
			INSTRUCTION_VERSION,
			HOST_RULES_VERSION,
			gitSha: sha,
			dirty,
			builtAt: new Date().toISOString(),
		};
		const manifestPath = join(outDir, "manifest.json");
		writeFileSync(manifestPath, `${JSON.stringify(manifest, null, "\t")}\n`);
		return { tgz, manifestPath, manifest };
	} finally {
		rmSync(stage, { recursive: true, force: true });
	}
}

if (import.meta.main) {
	const argv = process.argv.slice(2);
	const outAt = argv.indexOf("--out");
	const outDir = outAt >= 0 ? resolve(argv[outAt + 1] ?? "") : defaultOut;
	const checkAt = argv.indexOf("--check");
	let tgz: string;
	if (checkAt >= 0) {
		const given = argv[checkAt + 1];
		if (given !== undefined && !given.startsWith("--")) tgz = resolve(given);
		else {
			const manifestPath = join(outDir, "manifest.json");
			if (!existsSync(manifestPath))
				throw new Error("no manifest.json; pack first");
			const m = JSON.parse(readFileSync(manifestPath, "utf8")) as {
				artifact: string;
				sha256: string;
			};
			tgz = join(outDir, m.artifact);
			if (sha256(tgz) !== m.sha256)
				throw new Error("sha256 differs from manifest");
		}
	} else {
		const built = await pack(outDir);
		tgz = built.tgz;
		console.log(JSON.stringify(built.manifest, null, 2));
	}
	const errors = await checkTarball(tgz);
	if (errors.length > 0) {
		console.error(errors.join("\n"));
		process.exit(1);
	}
	console.log(`OK: ${tgz}`);
}
