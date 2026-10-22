/**
 * Show or change the agency settings of a running Eumenes (dev helper; Eumenes has no UI for them yet).
 *   bun scripts/eumenes-agency.ts                     show
 *   bun scripts/eumenes-agency.ts --on [--idle 20] [--max-unanswered 1]
 *        [--resource <uuid>|--larm] [--interest "…" ...|--no-interest]
 *   bun scripts/eumenes-agency.ts --off
 * Env: EUMENES_URL (default http://127.0.0.1:8787), EUMENES_API_TOKEN, or the token file
 * EUMENES_TOKEN_FILE (default ../eumenes/data/keys/api.token). The token is never printed.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const base = process.env.EUMENES_URL ?? "http://127.0.0.1:8787";
const tokenFile =
	process.env.EUMENES_TOKEN_FILE ??
	join(import.meta.dir, "../../eumenes/data/keys/api.token");
const token = (
	process.env.EUMENES_API_TOKEN ?? readFileSync(tokenFile, "utf8")
).trim();

type Resource = { id: string; purpose?: string; model?: string; name?: string };
type Settings = {
	revision: number;
	agency?: Agency;
	resources?: Resource[];
	[key: string]: unknown;
};

const call = async (path: string, init?: RequestInit): Promise<Settings> => {
	const r = await fetch(`${base}${path}`, {
		...init,
		headers: {
			Authorization: `Bearer ${token}`,
			"Content-Type": "application/json",
		},
	});
	const body = await r.json().catch(() => null);
	if (!r.ok) throw new Error(`${path} ${r.status} ${JSON.stringify(body)}`);
	return body as Settings;
};

type Agency = {
	enabled: boolean;
	resourceId: string | null;
	idleSec: number;
	maxUnanswered: number;
	interests: string[];
};

const argv = process.argv.slice(2);
const settings = await call("/api/settings");
const current: Agency | undefined = settings.agency;
if (!current) {
	console.error(
		"この Eumenes は agency 設定を持っていません（agency 統合前のコードで動いています。再起動が必要です）。",
	);
	process.exit(1);
}
const show = (a: Agency) => {
	const llms = (settings.resources ?? []).filter((r) => r.purpose === "llm");
	const res = llms.find((r) => r.id === a.resourceId);
	console.log(
		`agency: ${a.enabled ? "ON" : "OFF"} / route ${a.resourceId === null ? "LARM（ローカル）" : `cloud ${res?.model ?? res?.name ?? a.resourceId}`} / idle ${a.idleSec}s / maxUnanswered ${a.maxUnanswered} / interests ${a.interests.length ? a.interests.join(" | ") : "なし"}`,
	);
	if (llms.length)
		console.log(
			`会話モデルとして登録済みの資源: ${llms.map((r) => `${r.id} (${r.model ?? r.name ?? "?"})`).join(", ")}`,
		);
};
if (argv.length === 0) {
	show(current);
	process.exit(0);
}

const next: Agency = { ...current, interests: [...current.interests] };
let interestsGiven = false;
for (let i = 0; i < argv.length; i++) {
	const a = argv[i];
	const value = () => {
		const v = argv[++i];
		if (v === undefined) throw new Error(`${a} needs a value`);
		return v;
	};
	if (a === "--on") next.enabled = true;
	else if (a === "--off") next.enabled = false;
	else if (a === "--larm") next.resourceId = null;
	else if (a === "--resource") next.resourceId = value();
	else if (a === "--idle") next.idleSec = Number(value());
	else if (a === "--max-unanswered") next.maxUnanswered = Number(value());
	else if (a === "--no-interest") next.interests = [];
	else if (a === "--interest") {
		if (!interestsGiven) next.interests = [];
		interestsGiven = true;
		next.interests.push(value());
	} else throw new Error(`unknown argument: ${a}`);
}

const { revision, ...rest } = settings;
const applied = await call("/api/settings/apply", {
	method: "POST",
	body: JSON.stringify({
		requestId: crypto.randomUUID(),
		expectedRevision: revision,
		settings: { ...rest, revision, agency: next },
		// No key mutations: stored credentials stay as they are.
		keys: [],
	}),
});
if (applied.agency) show(applied.agency);
