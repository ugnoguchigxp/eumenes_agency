/**
 * P0 baseline adapter: measures the Agency distribution that Eumenes installs (node_modules/eumenes-agency),
 * not the adjacent src/. The runtime is composed by the host's own `createHostRuntime` and `createAgencyLlmPort`,
 * so flags, SystemContext, schema transport and output limits are the product's. Only the inference boundary
 * (`captureBackgroundControlInTransaction` / `executeControl`) is a fixture: no model, network or product store.
 */
import { createHash } from "node:crypto";
import {
	existsSync,
	lstatSync,
	readdirSync,
	readlinkSync,
	readFileSync,
	realpathSync,
	statSync,
} from "node:fs";
import { arch, platform, release } from "node:os";
import { dirname, join, relative, resolve } from "node:path";

export const sha256 = (data: string | Uint8Array): string =>
	createHash("sha256").update(data).digest("hex");

const sortKeys = (value: unknown): unknown => {
	if (Array.isArray(value)) return value.map(sortKeys);
	if (value && typeof value === "object")
		return Object.fromEntries(
			Object.keys(value as Record<string, unknown>)
				.sort()
				.filter((k) => (value as Record<string, unknown>)[k] !== undefined)
				.map((k) => [k, sortKeys((value as Record<string, unknown>)[k])]),
		);
	return value;
};
/** Key-order independent JSON; undefined members are dropped as JSON.stringify does. */
export const canonical = (value: unknown): string =>
	JSON.stringify(sortKeys(value)) ?? "undefined";
export const digest = (value: unknown): string =>
	sha256(typeof value === "string" ? value : canonical(value));

/** Digest of every file under a directory (relative path and content), independent of mtime. */
export function treeDigest(
	root: string,
	skip: (rel: string) => boolean = () => false,
) {
	const files: string[] = [];
	const walk = (dir: string) => {
		for (const name of readdirSync(dir).sort()) {
			const full = join(dir, name);
			const rel = relative(root, full);
			if (skip(rel)) continue;
			if (statSync(full).isDirectory()) walk(full);
			else files.push(rel);
		}
	};
	walk(root);
	return {
		files: files.length,
		digest: sha256(
			files
				.map((rel) => `${rel}\0${sha256(readFileSync(join(root, rel)))}`)
				.join("\n"),
		),
	};
}

const git = (repo: string, args: string[]): string => {
	const out = Bun.spawnSync(["git", ...args], { cwd: repo });
	if (out.exitCode !== 0)
		throw new Error(`git ${args.join(" ")} failed in ${repo}`);
	return out.stdout.toString();
};

/** An untracked symlink (e.g. a provided dependency link) is identified by its target, never followed. */
const untrackedDigest = (path: string) =>
	lstatSync(path).isSymbolicLink()
		? `link:${readlinkSync(path)}`
		: sha256(readFileSync(path));

/** Full SHA, dirty state and a digest of the uncommitted difference (tracked diff + untracked contents). */
export function gitIdentity(repo: string) {
	const status = git(repo, [
		"status",
		"--porcelain=v1",
		"--untracked-files=all",
	])
		.split("\n")
		.filter((l) => l.trim() && l.slice(3) !== "node_modules");
	const untracked = status
		.filter((l) => l.startsWith("??"))
		.map((l) => l.slice(3))
		.sort();
	const diff = git(repo, ["diff", "HEAD", "--binary"]);
	return {
		sha: git(repo, ["rev-parse", "HEAD"]).trim(),
		dirty: status.length > 0,
		changed: status.map((l) => l.trim()).sort(),
		diffDigest: sha256(
			diff +
				untracked
					.map((p) => `\0${p}\0${untrackedDigest(join(repo, p))}`)
					.join(""),
		),
	};
}

/** Regular files of a gzipped tar (ustar, with pax `path` overrides), by path. */
export function parseTarGz(bytes: Uint8Array): Map<string, Uint8Array> {
	const tar = Bun.gunzipSync(bytes as Uint8Array<ArrayBuffer>);
	const files = new Map<string, Uint8Array>();
	const text = (from: number, length: number) => {
		const raw = tar.subarray(from, from + length);
		const end = raw.indexOf(0);
		return new TextDecoder().decode(end < 0 ? raw : raw.subarray(0, end));
	};
	let offset = 0;
	let paxPath: string | null = null;
	while (offset + 512 <= tar.length) {
		if (tar.subarray(offset, offset + 512).every((b) => b === 0)) break;
		const name = text(offset, 100);
		const size = Number.parseInt(text(offset + 124, 12).trim() || "0", 8);
		const type = String.fromCharCode(tar[offset + 156] ?? 0);
		const prefix = text(offset + 345, 155);
		const body = tar.subarray(offset + 512, offset + 512 + size);
		if (type === "x") {
			const match = /\d+ path=([^\n]*)\n/.exec(new TextDecoder().decode(body));
			paxPath = match?.[1] ?? null;
		} else {
			if (type === "0" || type === "\0")
				files.set(
					paxPath ?? (prefix ? `${prefix}/${name}` : name),
					body.slice(),
				);
			paxPath = null;
		}
		offset += 512 + Math.ceil(size / 512) * 512;
	}
	return files;
}

/**
 * The installed dist must be the artifact's `package/dist/` file for file: a matching tgz checksum and equal
 * version constants do not prove that the files the host loads are the artifact's.
 */
export function compareArtifactToInstalled(
	artifact: Uint8Array,
	installedDist: string,
	prefix = "package/dist/",
) {
	const packed = new Map(
		[...parseTarGz(artifact)]
			.filter(([path]) => path.startsWith(prefix))
			.map(([path, body]) => [path.slice(prefix.length), sha256(body)]),
	);
	const installed = new Map<string, string>();
	const walk = (dir: string) => {
		for (const name of readdirSync(dir).sort()) {
			const full = join(dir, name);
			if (statSync(full).isDirectory()) walk(full);
			else
				installed.set(
					relative(installedDist, full),
					sha256(readFileSync(full)),
				);
		}
	};
	if (existsSync(installedDist)) walk(installedDist);
	const missing = [...packed.keys()].filter((p) => !installed.has(p)).sort();
	const extra = [...installed.keys()].filter((p) => !packed.has(p)).sort();
	const changed = [...packed]
		.filter(([p, d]) => installed.has(p) && installed.get(p) !== d)
		.map(([p]) => p)
		.sort();
	return {
		artifactFiles: packed.size,
		installedFiles: installed.size,
		missing,
		extra,
		changed,
		equal:
			packed.size > 0 && !missing.length && !extra.length && !changed.length,
	};
}

export interface DistributionIdentity {
	readonly kind: "distribution";
	readonly specifier: "eumenes-agency";
	readonly resolvedFrom: string;
	readonly entry: string;
	readonly entryRealpath: string;
	readonly packageDir: string;
	readonly version: string;
	readonly bunTag: string;
	readonly distDigest: string;
	readonly distFiles: number;
	readonly artifact: string;
	readonly artifactSha256: string;
	readonly vendorManifest: Record<string, unknown>;
	readonly vendorManifestDigest: string;
	readonly hostDependency: string;
	readonly lockfileReference: boolean;
	readonly instructionVersion: string;
	readonly hostRulesVersion: string;
	readonly artifactContents: ReturnType<typeof compareArtifactToInstalled>;
	readonly checks: Record<string, boolean>;
}

/** Resolves `eumenes-agency` exactly as the host's own module does, verifies it against the vendored artifact. */
export async function loadDistribution(host: string) {
	const from = resolve(host, "api/application/agency/runtime.ts");
	const entry = Bun.resolveSync("eumenes-agency", dirname(from));
	const entryRealpath = realpathSync(entry);
	const packageDir = dirname(dirname(entryRealpath));
	const pkg = JSON.parse(
		readFileSync(join(packageDir, "package.json"), "utf8"),
	);
	const vendorManifestText = readFileSync(
		resolve(host, "vendor/agency/manifest.json"),
		"utf8",
	);
	const vendor = JSON.parse(vendorManifestText) as Record<string, unknown> & {
		artifact: string;
		sha256: string;
		version: string;
		INSTRUCTION_VERSION: string;
		HOST_RULES_VERSION: string;
	};
	const artifactBytes = readFileSync(
		resolve(host, "vendor/agency", vendor.artifact),
	);
	const artifactSha256 = sha256(artifactBytes);
	const artifactContents = compareArtifactToInstalled(
		artifactBytes,
		join(packageDir, "dist"),
	);
	const hostDependency = JSON.parse(
		readFileSync(resolve(host, "package.json"), "utf8"),
	).dependencies["eumenes-agency"] as string;
	const lock = readFileSync(resolve(host, "bun.lock"), "utf8");
	const tree = treeDigest(join(packageDir, "dist"));
	const module = await import(entryRealpath);
	const identity: DistributionIdentity = {
		kind: "distribution",
		specifier: "eumenes-agency",
		resolvedFrom: from,
		entry,
		entryRealpath,
		packageDir,
		version: pkg.version,
		bunTag: existsSync(join(packageDir, ".bun-tag"))
			? readFileSync(join(packageDir, ".bun-tag"), "utf8").trim()
			: "",
		distDigest: tree.digest,
		distFiles: tree.files,
		artifact: vendor.artifact,
		artifactSha256,
		vendorManifest: vendor,
		vendorManifestDigest: sha256(vendorManifestText),
		hostDependency,
		lockfileReference: lock.includes(`vendor/agency/${vendor.artifact}`),
		instructionVersion: module.INSTRUCTION_VERSION,
		hostRulesVersion: module.HOST_RULES_VERSION,
		artifactContents,
		checks: {
			installedDistMatchesArtifact: artifactContents.equal,
			entryInsideDist: entryRealpath.startsWith(join(packageDir, "dist") + "/"),
			artifactChecksumMatchesManifest: artifactSha256 === vendor.sha256,
			hostDependsOnArtifact:
				hostDependency === `file:vendor/agency/${vendor.artifact}`,
			lockfileReferencesArtifact: lock.includes(
				`vendor/agency/${vendor.artifact}`,
			),
			installedVersionMatches: pkg.version === vendor.version,
			instructionVersionMatches:
				module.INSTRUCTION_VERSION === vendor.INSTRUCTION_VERSION,
			hostRulesVersionMatches:
				module.HOST_RULES_VERSION === vendor.HOST_RULES_VERSION,
		},
	};
	return { module, identity, codeDir: join(packageDir, "dist") };
}

/**
 * Comparison lane only: the adjacent Agency src/ in place of the host's `eumenes-agency` import. A Bun load
 * plugin, registered before any host module loads, serves the installed entry as a re-export of src/index.ts
 * in this process; node_modules, the product runtime and the distribution files are not changed.
 */
export async function loadAdjacentSource(
	agencyRepo: string,
	distributionSha: string,
) {
	const entry = resolve(agencyRepo, "src/index.ts");
	let swapped = 0;
	Bun.plugin({
		name: "p0-adjacent-agency-src",
		setup(build) {
			build.onLoad({ filter: /eumenes-agency\/dist\/index\.js$/ }, () => {
				swapped++;
				return {
					contents: `export * from ${JSON.stringify(entry)};`,
					loader: "js",
				};
			});
		},
	});
	const module = await import(entry);
	const tree = treeDigest(resolve(agencyRepo, "src"));
	const changed = git(agencyRepo, [
		"diff",
		"--name-only",
		distributionSha,
		"HEAD",
		"--",
		"src",
	])
		.split("\n")
		.filter(Boolean);
	return {
		module,
		codeDir: resolve(agencyRepo, "src"),
		identity: {
			kind: "adjacent-src",
			specifier: "eumenes-agency",
			entry,
			entryRealpath: realpathSync(entry),
			version: JSON.parse(
				readFileSync(resolve(agencyRepo, "package.json"), "utf8"),
			).version,
			distDigest: tree.digest,
			distFiles: tree.files,
			artifactSha256: "none: unpacked source (not a distribution)",
			instructionVersion: module.INSTRUCTION_VERSION,
			hostRulesVersion: module.HOST_RULES_VERSION,
			srcChangedSinceDistribution: { from: distributionSha, files: changed },
			checks: { loadPluginRegistered: true } as Record<string, boolean>,
		},
		swapped: () => swapped,
	};
}

/** Files whose content fixes the product composition (flags, SystemContext, schema transport, limits). */
export const compositionFiles = [
	"api/application/agency/runtime.ts",
	"api/application/agency/llm-port.ts",
	"api/application/agency/system-context.ts",
	"api/application/agency/schema.ts",
	"api/application/agency/research.ts",
	"api/infrastructure/json-schema.ts",
	"api/infrastructure/llm-json.ts",
	"api/infrastructure/system-context.ts",
	// Assembly of the synthetic conversation prefix (M15): taskMessages, backgroundMessage, joinSections.
	"api/domains/dialogue/service/conversation-input.ts",
	"api/domains/dialogue/service/input-text.ts",
] as const;

export function compositionIdentity(host: string) {
	const files = Object.fromEntries(
		compositionFiles.map((f) => [f, sha256(readFileSync(resolve(host, f)))]),
	);
	const contexts = resolve(host, "api/domains/dialogue/contexts/agency");
	return {
		files,
		filesDigest: digest(files),
		systemContextAssets: treeDigest(contexts),
	};
}

export const environmentIdentity = () => ({
	bun: Bun.version,
	bunRevision: Bun.revision,
	platform: platform(),
	osRelease: release(),
	arch: arch(),
});

/** The host composition, loaded from the host checkout; its `eumenes-agency` import is the distribution. */
export async function loadHostComposition(
	host: string,
	loaded: { SystemContextConfigurationError: new (...a: never[]) => Error },
) {
	const { createHostRuntime } = await import(
		resolve(host, "api/application/agency/runtime.ts")
	);
	const {
		createAgencyLlmPort,
		BACKGROUND_OUTPUT_LIMIT,
		BACKGROUND_DEADLINE_MS,
	} = await import(resolve(host, "api/application/agency/llm-port.ts"));
	// The host port rejects an empty system with the core's error class: equal classes prove that the host's
	// `eumenes-agency` import is the very module instance identified above (not another copy).
	const probe = createAgencyLlmPort({
		store: { write: async () => undefined },
		inference: {},
		next: () => ({ decisionId: "p0.probe", generation: 1 }),
	});
	const error = await probe
		.complete(
			{
				purpose: "update",
				system: "",
				prompt: "",
				schema: null,
				maxOutputTokens: 1,
			},
			new AbortController().signal,
		)
		.catch((e: unknown) => e);
	return {
		hostImportIsLoadedModule:
			error instanceof loaded.SystemContextConfigurationError,
		createHostRuntime,
		createAgencyLlmPort,
		BACKGROUND_OUTPUT_LIMIT: BACKGROUND_OUTPUT_LIMIT as number,
		BACKGROUND_DEADLINE_MS: BACKGROUND_DEADLINE_MS as number,
	};
}
