/**
 * P0-A02: fixed synthetic responses served at the host inference boundary, below the product llm-port.
 * Record mode serves a case's scripted responses and keeps the exact final request (system, conversation
 * messages, native schema, capture/session options). Replay mode serves a recorded response only when the
 * next request's digests are equal and the stored response still matches its digest; it never answers a
 * different request by order alone and never passes a corrupted response on.
 *
 * Only the declared transport identities are substituted: the capture's decision id, the request and attempt
 * ids the fixture issues, and the session's `agentSession.conversationId` / `agentSession.agentId`. In the
 * compared options each such string is replaced by a token chosen by value within the request, so the
 * equality between identities (the product sends agentId = conversationId) is still compared; every other
 * field — unknown ones, nulls and absent keys included — is compared as is. Across requests the identities
 * are bound one-to-one per kind.
 *
 * Every physical attempt passes the attempt cap before anything is served: the cap is never exceeded, and an
 * attempt refused at the boundary (cap, replay mismatch, exhausted script) is counted apart from a served one.
 */
import { digest } from "./baseline.ts";

export interface AttemptUsage {
	readonly model: string | null;
	readonly inputTokens: number | null;
	readonly outputTokens: number | null;
	readonly cacheReadTokens: number | null;
}

/** What the fixture does for one physical attempt. `abortCaller`: an uncooperative model that ignores the signal. */
export type FixtureResponse =
	| {
			readonly kind: "value";
			readonly text: string;
			readonly usage?: AttemptUsage | null;
			readonly abortCaller?: boolean;
	  }
	| { readonly kind: "error"; readonly code: string };

export type Purpose = "update" | "select";
export interface Script {
	readonly update?: readonly FixtureResponse[];
	readonly select?: readonly FixtureResponse[];
}

export const REQUEST_PARTS = [
	"purpose",
	"system",
	"prompt",
	"schema",
	"options",
] as const;
export type RequestPart = (typeof REQUEST_PARTS)[number];
export type RequestDigests = Record<RequestPart | "request", string>;

/** Declared non-semantic transport identities; the only values replay may substitute. */
export const TRANSPORT_IDENTITIES = [
	"decisionId",
	"requestId",
	"attemptId",
	"conversationId",
	"agentId",
] as const;
export type IdentityKind = (typeof TRANSPORT_IDENTITIES)[number];
export type TransportIdentity = Record<IdentityKind, string | null>;

export interface CassetteEntry {
	readonly schema: "agency-p0-cassette.v2";
	readonly trialId: string;
	readonly seq: number;
	readonly purpose: string;
	readonly identity: TransportIdentity;
	readonly digests: RequestDigests;
	readonly response: FixtureResponse;
	readonly responseDigest: string;
}

/** Raw synthetic request kept for diagnosis (synthetic fixtures only; never product data). */
export interface RequestLine {
	readonly schema: "agency-p0-request.v2";
	readonly trialId: string;
	readonly seq: number;
	readonly purpose: string;
	readonly disposition: "served" | `refused:${RefusalReason}`;
	readonly system: string | null;
	readonly prompt: unknown;
	readonly schemaJson: unknown;
	readonly options: unknown;
}

export type MismatchKind =
	| "request_digest_mismatch"
	| "response_digest_mismatch"
	| "extra_call"
	| "unconsumed_response"
	| "identity_conflict"
	| "script_exhausted"
	| "script_unconsumed";
export interface Mismatch {
	readonly kind: MismatchKind;
	readonly trialId: string;
	readonly seq: number;
	readonly parts?: readonly string[];
	readonly detail?: string;
}
export type RefusalReason =
	| "attempt_cap"
	| "request_digest_mismatch"
	| "response_digest_mismatch"
	| "extra_call"
	| "identity_conflict"
	| "script_exhausted";

type Message = { role: string; content: string };

/** Splits one final inference request into the compared parts; only declared identities become tokens. */
export function requestParts(
	capture: Record<string, unknown>,
	messages: readonly Message[],
	control: unknown,
	session: Record<string, unknown> | undefined,
) {
	const tokens = new Map<string, string>();
	const token = (value: unknown) => {
		if (typeof value !== "string") return value;
		if (!tokens.has(value)) tokens.set(value, `<identity:${tokens.size}>`);
		return tokens.get(value);
	};
	const replaceKeys = (
		object: Record<string, unknown>,
		keys: readonly string[],
	) => {
		const out: Record<string, unknown> = { ...object };
		for (const k of keys) if (k in out) out[k] = token(out[k]);
		return out;
	};
	const decisionId = capture.decisionId;
	const { outputSchema, ...sessionRest } = session ?? {};
	const agentSession = sessionRest.agentSession;
	const sessionCompared =
		agentSession &&
		typeof agentSession === "object" &&
		!Array.isArray(agentSession)
			? {
					...sessionRest,
					agentSession: replaceKeys(agentSession as Record<string, unknown>, [
						"conversationId",
						"agentId",
					]),
				}
			: sessionRest;
	const purpose =
		String(decisionId ?? "")
			.split(".")
			.at(-2) ?? "";
	const first = messages[0];
	const system = first?.role === "system" ? first.content : null;
	const prompt = messages.slice(system === null ? 0 : 1);
	const options = {
		capture: replaceKeys(capture, ["decisionId"]),
		session: session === undefined ? null : sessionCompared,
		control: control ?? null,
	};
	const parts = {
		purpose,
		system,
		prompt,
		schema: outputSchema ?? null,
		options,
	};
	const digests = {
		purpose: digest(purpose),
		system: digest(system ?? ""),
		prompt: digest(prompt),
		schema: digest(parts.schema),
		options: digest(options),
	};
	const identityOf = (value: unknown) =>
		typeof value === "string" ? value : null;
	const a = (agentSession ?? {}) as {
		conversationId?: unknown;
		agentId?: unknown;
	};
	return {
		parts,
		digests: { ...digests, request: digest(digests) } as RequestDigests,
		decisionId: identityOf(decisionId),
		conversationId: identityOf(a.conversationId),
		agentId: identityOf(a.agentId),
	};
}

/** One-to-one binding of recorded to replayed transport identities; a second, different binding is a conflict. */
export function createIdentityMap() {
	const forward = new Map<string, string>();
	const back = new Map<string, string>();
	return {
		bind(kind: IdentityKind, recorded: string | null, actual: string | null) {
			if (recorded === null || actual === null)
				return recorded === actual
					? null
					: `${kind}: ${recorded ?? "null"} vs ${actual ?? "null"}`;
			const r = `${kind}\0${recorded}`;
			const a = `${kind}\0${actual}`;
			const f = forward.get(r);
			const b = back.get(a);
			if ((f !== undefined && f !== a) || (b !== undefined && b !== r))
				return `${kind}: ${recorded} already bound differently`;
			forward.set(r, a);
			back.set(a, r);
			return null;
		},
		table: () =>
			[...forward].map(([r, a]) => ({
				kind: r.split("\0")[0],
				recorded: r.split("\0")[1],
				replayed: a.split("\0")[1],
			})),
	};
}

export interface TrialInferenceLog {
	readonly entries: CassetteEntry[];
	readonly requests: RequestLine[];
	readonly mismatches: Mismatch[];
	/** Physical attempts that reached the boundary (served + refused). */
	tried: number;
	/** Attempts for which a fixture response (value or error) was served. */
	served: number;
	readonly refused: { seq: number; purpose: string; reason: RefusalReason }[];
	readonly usage: {
		attemptId: string;
		purpose: string;
		usage: AttemptUsage | null;
		served: "value" | "error";
	}[];
	readonly receipts: { accepted: number; rejected: number };
	readonly clock: number[];
}

type Source =
	| { readonly mode: "record"; readonly script: Script }
	| { readonly mode: "replay"; readonly entries: readonly CassetteEntry[] };

class BoundaryRefusal extends Error {
	constructor(readonly reason: RefusalReason) {
		super(reason === "attempt_cap" ? "p0_attempt_cap" : "replay_mismatch");
	}
}

/**
 * The inference port passed to the product `createAgencyLlmPort`. `now` is the virtual clock;
 * the fixture makes no network call and holds no store. `maxAttempts` caps served attempts over the run.
 */
export function createFixtureInference(
	now: () => number,
	options: { readonly maxAttempts?: number } = {},
) {
	const maxAttempts = options.maxAttempts ?? Number.POSITIVE_INFINITY;
	const identities = createIdentityMap();
	let servedTotal = 0;
	let refusedTotal = 0;
	let capHit = false;
	let trial: {
		id: string;
		source: Source;
		controller: AbortController;
		queues: Record<Purpose, FixtureResponse[]>;
		next: number;
		log: TrialInferenceLog;
		captures: Map<string, Record<string, unknown>>;
		requests: number;
	} | null = null;
	const usageByAttempt = new Map<string, AttemptUsage | null>();
	const current = () => {
		if (!trial) throw new Error("fixture inference: begin() was not called");
		return trial;
	};

	const port = {
		captureBackgroundControlInTransaction(
			_db: unknown,
			input: Record<string, unknown>,
		) {
			const t = current();
			const id = `req-${t.id}-${++t.requests}`;
			t.captures.set(id, { ...input });
			return id;
		},
		async executeControl(
			requestId: string,
			messages: Message[],
			_signal: AbortSignal,
			control: unknown,
			session: Record<string, unknown> | undefined,
		) {
			const t = current();
			const capture = t.captures.get(requestId) ?? {};
			const req = requestParts(capture, messages, control, session);
			const seq = t.log.tried++;
			t.log.clock.push(now());
			const attemptId = `att-${requestId}`;
			const line = {
				schema: "agency-p0-request.v2" as const,
				trialId: t.id,
				seq,
				purpose: req.parts.purpose,
				system: req.parts.system,
				prompt: req.parts.prompt,
				schemaJson: req.parts.schema,
				options: req.parts.options,
			};
			const refuse = (
				reason: RefusalReason,
				mismatch?: Omit<Mismatch, "trialId" | "seq">,
			): never => {
				refusedTotal++;
				t.log.refused.push({ seq, purpose: req.parts.purpose, reason });
				t.log.requests.push({ ...line, disposition: `refused:${reason}` });
				if (mismatch)
					t.log.mismatches.push({ ...mismatch, trialId: t.id, seq });
				throw new BoundaryRefusal(reason);
			};
			// The cap is checked before anything is served, so it is never exceeded (retries included).
			if (servedTotal >= maxAttempts) {
				capHit = true;
				refuse("attempt_cap");
			}
			let response: FixtureResponse;
			let identity: TransportIdentity = {
				decisionId: req.decisionId,
				requestId,
				attemptId,
				conversationId: req.conversationId,
				agentId: req.agentId,
			};
			if (t.source.mode === "record") {
				const next = t.queues[req.parts.purpose as Purpose]?.shift();
				if (!next)
					refuse("script_exhausted", {
						kind: "script_exhausted",
						detail: req.parts.purpose,
					});
				response = next!;
			} else {
				const expected = t.source.entries[t.next];
				if (!expected) refuse("extra_call", { kind: "extra_call" });
				t.next++;
				const parts = REQUEST_PARTS.filter(
					(p) => expected!.digests[p] !== req.digests[p],
				);
				if (parts.length || expected!.digests.request !== req.digests.request)
					refuse("request_digest_mismatch", {
						kind: "request_digest_mismatch",
						parts,
					});
				for (const kind of TRANSPORT_IDENTITIES) {
					const conflict = identities.bind(
						kind,
						expected!.identity[kind],
						identity[kind],
					);
					if (conflict)
						refuse("identity_conflict", {
							kind: "identity_conflict",
							detail: conflict,
						});
				}
				// The stored response must still be the one recorded: a corrupted entry is never served.
				if (digest(expected!.response) !== expected!.responseDigest)
					refuse("response_digest_mismatch", {
						kind: "response_digest_mismatch",
					});
				response = expected!.response;
				identity = { ...identity };
			}
			servedTotal++;
			t.log.served++;
			t.log.requests.push({ ...line, disposition: "served" });
			t.log.entries.push({
				schema: "agency-p0-cassette.v2",
				trialId: t.id,
				seq,
				purpose: req.parts.purpose,
				identity,
				digests: req.digests,
				response,
				responseDigest: digest(response),
			});
			const usage = response.kind === "value" ? (response.usage ?? null) : null;
			usageByAttempt.set(attemptId, usage);
			t.log.usage.push({
				attemptId,
				purpose: req.parts.purpose,
				usage,
				served: response.kind,
			});
			if (response.kind === "error") throw new Error(response.code);
			// An uncooperative model: the caller is cancelled while it ignores the signal and still answers.
			if (response.abortCaller) t.controller.abort();
			return { requestId, attemptId, value: response.text };
		},
		acceptInTransaction() {
			current().log.receipts.accepted++;
			return true;
		},
		rejectControlInTransaction() {
			current().log.receipts.rejected++;
		},
	};

	return {
		port,
		/** Raw usage of the served attempt, before the product port fills missing counts with 0. */
		attemptUsage: (attemptId: string) => usageByAttempt.get(attemptId) ?? null,
		identities,
		/** Served attempts over the run, refused ones, and whether the cap refused an attempt. */
		totals: () => ({
			served: servedTotal,
			refused: refusedTotal,
			capHit,
			maxAttempts,
		}),
		begin(id: string, source: Source, controller: AbortController) {
			trial = {
				id,
				source,
				controller,
				queues: {
					update: [
						...((source.mode === "record" && source.script.update) || []),
					],
					select: [
						...((source.mode === "record" && source.script.select) || []),
					],
				},
				next: 0,
				requests: 0,
				captures: new Map(),
				log: {
					entries: [],
					requests: [],
					mismatches: [],
					tried: 0,
					served: 0,
					refused: [],
					usage: [],
					receipts: { accepted: 0, rejected: 0 },
					clock: [],
				},
			};
		},
		/** Ends a step; a recorded response left unserved is a mismatch in replay and a fixture error in record. */
		end(): TrialInferenceLog {
			const t = current();
			// A step stopped by the cap leaves the rest of its script by design; that is not a script error.
			const stopped = t.log.refused.some((r) => r.reason === "attempt_cap");
			if (stopped) {
				// Not served because the run stopped; the trial is recorded as incomplete instead.
			} else if (t.source.mode === "replay")
				for (const e of t.source.entries.slice(t.next))
					t.log.mismatches.push({
						kind: "unconsumed_response",
						trialId: t.id,
						seq: e.seq,
					});
			else
				for (const purpose of ["update", "select"] as const)
					if (t.queues[purpose].length)
						t.log.mismatches.push({
							kind: "script_unconsumed",
							trialId: t.id,
							seq: -1,
							detail: `${purpose}:${t.queues[purpose].length}`,
						});
			trial = null;
			return t.log;
		},
	};
}
export type FixtureInference = ReturnType<typeof createFixtureInference>;
