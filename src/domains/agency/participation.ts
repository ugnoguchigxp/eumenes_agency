import type { ActionTicket, Decision } from "../../contracts/runtime.ts";
import type {
	AgencyState,
	Candidate,
	Condition,
	Limits,
	ToolCapability,
} from "../../contracts/model.ts";
import type { ParticipationProposal } from "../../contracts/proposals.ts";
import { allocId } from "./ids.ts";
import { closeCandidate, holdCandidate, isPresentable } from "./lifecycle.ts";

export interface ParticipationInput {
	readonly condition: Condition;
	readonly state: AgencyState;
	readonly proposal: ParticipationProposal;
	/** Observation ids shown to the model. */
	readonly presentedObservations: ReadonlySet<string>;
	/** Candidates shown to the model, with the revision it saw. */
	readonly presentedCandidates: ReadonlyMap<string, number>;
	readonly tools: readonly ToolCapability[];
	readonly limits: Limits;
	readonly at: number;
}

export type Verdict =
	| {
			ok: true;
			candidate: Candidate | null;
			utterance: string | null;
			toolName: string | null;
			toolInput: string | null;
	  }
	| { ok: false; codes: string[] };

const outward = (a: ParticipationProposal["action"]) =>
	a === "speak" || a === "tool";

/** Unknown tool, or a tool that needs the user's explicit grant (never autonomous). */
const toolProblem = (
	tools: readonly ToolCapability[],
	name: string | null,
): string | null => {
	const t = name === null ? undefined : tools.find((x) => x.name === name);
	if (!t) return "bad_tool";
	return t.requiresApproval ? "approval_required" : null;
};

/** Re-validates a participation proposal against the current state. */
export const validateParticipation = (i: ParticipationInput): Verdict => {
	const p = i.proposal;
	const codes: string[] = [];
	const add = (c: string) => {
		if (!codes.includes(c)) codes.push(c);
	};
	for (const r of p.evidenceRefs)
		if (!i.presentedObservations.has(r)) add("unknown_ref");

	const usesCandidates = i.condition === "B2" || i.condition === "F";
	const needsCandidate =
		usesCandidates && (outward(p.action) || p.action === "discard");
	let candidate: Candidate | null = null;
	if (needsCandidate || (usesCandidates && p.action === "wait")) {
		const ref = p.candidateRef;
		const found = ref
			? i.state.candidates.find((c) => c.id === ref.id)
			: undefined;
		if (ref && found) {
			const seen = i.presentedCandidates.get(ref.id);
			if (seen === undefined) add("unknown_ref");
			else if (
				seen !== ref.revision ||
				found.revision !== ref.revision ||
				!isPresentable(i.state, found)
			)
				add("stale_revision");
			else candidate = found;
		} else if (needsCandidate) add(ref ? "unknown_ref" : "missing_candidate");
	}

	let utterance: string | null = null;
	let toolName: string | null = null;
	let toolInput: string | null = null;
	if (outward(p.action)) {
		if (
			i.state.lastOutboundAt !== null &&
			i.at - i.state.lastOutboundAt < i.limits.outboundIntervalMs
		)
			add("outbound_interval");
	}
	if (usesCandidates) {
		if (candidate && p.action === "speak") {
			if (candidate.kind === "tool") add("bad_candidate_kind");
			if (p.evidenceRefs.length === 0) add("missing_evidence");
			utterance = p.utterance ?? candidate.content;
		}
		if (candidate && p.action === "tool") {
			if (candidate.kind !== "tool") add("bad_candidate_kind");
			else {
				const problem = toolProblem(i.tools, candidate.toolName);
				if (problem) add(problem);
				else if (p.toolName !== null && p.toolName !== candidate.toolName)
					add("bad_tool");
			}
			toolName = candidate.toolName;
			toolInput = candidate.toolInput;
			utterance = candidate.content;
		}
	} else {
		if (p.action === "discard") add("bad_action");
		if (p.action === "speak") {
			if (p.utterance === null) add("missing_utterance");
			if (p.evidenceRefs.length === 0) add("missing_evidence");
			utterance = p.utterance;
		}
		if (p.action === "tool") {
			const problem = toolProblem(i.tools, p.toolName);
			if (problem) add(problem);
			if (p.toolInput === null) add("bad_tool");
			toolName = p.toolName;
			toolInput = p.toolInput;
			utterance = p.utterance;
		}
	}
	if (codes.length > 0) return { ok: false, codes };
	return { ok: true, candidate, utterance, toolName, toolInput };
};

/**
 * Reserves the candidate (if any), starts an attempt and issues the ticket.
 * The ticket carries the candidate revision the decision was made against.
 */
export const reserveOutward = (
	state: AgencyState,
	opportunityId: string,
	action: "speak" | "tool",
	verdict: Extract<Verdict, { ok: true }>,
	at: number,
): ActionTicket => {
	const c = verdict.candidate;
	const candidateRevision = c ? c.revision : null;
	if (c) {
		c.state = "reserved";
		c.holdReason = null;
		c.revision += 1;
	}
	const attempt = {
		id: allocId(state, "a"),
		candidateId: c ? c.id : null,
		candidateRevision,
		opportunityId,
		action,
		status: "running" as const,
		startedAt: at,
	};
	state.attempts.push(attempt);
	state.lastOutboundAt = at;
	state.revision += 1;
	return {
		id: attempt.id,
		opportunityId,
		action,
		candidateId: attempt.candidateId,
		candidateRevision,
		stateRevision: state.revision,
		utterance: action === "speak" ? verdict.utterance : null,
		toolName: verdict.toolName,
		toolInput: verdict.toolInput,
	};
};

/** wait with a candidate: it stays, deferred to a later opportunity. */
export const deferCandidate = (state: AgencyState, c: Candidate) => {
	holdCandidate(c, "deferred");
	state.revision += 1;
};

export const dismissCandidate = (state: AgencyState, c: Candidate) => {
	closeCandidate(c, "dismissed");
	state.revision += 1;
};

export const hostDecision = (
	opportunityId: string,
	source: Decision["source"],
	reason: string,
	rejectCodes: readonly string[] = [],
): Decision => ({
	opportunityId,
	action: "wait",
	source,
	candidateId: null,
	utterance: null,
	toolName: null,
	toolInput: null,
	evidenceRefs: [],
	reason,
	ticket: null,
	rejectCodes,
});
