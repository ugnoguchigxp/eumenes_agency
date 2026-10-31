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
] as const;

/** Only these may appear in the tarball. */
const allowedPath = /^package\/(package\.json|dist\/.+\.(js|d\.ts))$/;
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
		description: "Eumenes agency core (local distribution, unpublished).",
		type: "module",
		sideEffects: false,
		exports: {
			".": { types: "./dist/index.d.ts", default: "./dist/index.js" },
			"./package.json": "./package.json",
		},
		files: ["dist"],
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
	])
		if (!listed.includes(need)) errors.push(`missing: ${need}`);
	if (errors.length > 0) return errors;

	const dir = mkdtempSync(join(tmpdir(), "agency-pack-"));
	try {
		await must(["tar", "-xzf", tgz, "-C", dir]);
		const pkgDir = join(dir, "package");
		const pkg = JSON.parse(
			readFileSync(join(pkgDir, "package.json"), "utf8"),
		) as {
			name?: string;
			exports?: Record<string, unknown>;
			dependencies?: Record<string, string>;
		};
		if (pkg.name !== "eumenes-agency") errors.push("package name");
		const dot = JSON.stringify(pkg.exports?.["."]);
		if (
			dot !==
			JSON.stringify({
				types: "./dist/index.d.ts",
				default: "./dist/index.js",
			})
		)
			errors.push(`exports "." is ${dot}`);
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
		const probe = await run([
			process.execPath,
			"--eval",
			"const m = await import(process.argv[1]); console.log(JSON.stringify(Object.keys(m)));",
			join(pkgDir, "dist", "index.js"),
		]);
		if (probe.code !== 0) errors.push(`import failed: ${probe.err.trim()}`);
		else {
			const names = new Set(JSON.parse(probe.out) as string[]);
			for (const name of requiredExports)
				if (!names.has(name)) errors.push(`missing export: ${name}`);
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
