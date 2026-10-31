import {
	participationEmotionSchema,
	participationSchema,
	wireUpdateSchema,
	type WireUpdate,
} from "../contracts/proposals.ts";
import type { Condition } from "../contracts/model.ts";
import { replyResultSchema } from "../contracts/ports.ts";
import type {
	AgencyOutputContract,
	ParticipationOutput,
} from "../contracts/system-context.ts";

export interface OutputContractOptions {
	readonly condition: Exclude<Condition, "B0">;
	readonly hostTodos?: boolean;
	readonly utteranceEmotion?: boolean;
}

const updateFields = [
	"JSON object: summary, missingInfo (string or null), focusRefs (existing item IDs, at most 7), ops, reconciliations.",
	"Each wire op has the same fields. Unused nullable fields are null; unused evidenceRefs and beliefRefs are []. IDs refer to presented items; localId names new items within this proposal; expectedRevision matches the existing item's revision.",
	"note.add: localId, text, evidenceRefs. note.update: id, expectedRevision, text, evidenceRefs (added evidence). note.delete: id, expectedRevision.",
	"intent.add: localId, state (proposed/adopted/held), text (desiredState), reason (motive), completionCondition, resumeCondition, withdrawCondition, hours (reviewAfterHours), evidenceRefs, desireRef. intent.update: id, expectedRevision, state (transition or null), reason, evidenceRefs, text/completionCondition/resumeCondition/hours (changes or null).",
	"candidate.add: localId, intentRef (existing ID or localId), kind, text (content), toolName/toolInput, applyWhen, hours (expireAfterHours), evidenceRefs, supersedes (existing candidate ID or null). candidate.close: id, expectedRevision, state (dismissed/superseded/expired/fulfilled), evidenceRefs.",
	"belief.add: localId, text (content), confidence, evidenceRefs. belief.update: id, expectedRevision, state (status), text/confidence (changes or null), evidenceRefs. desire.add: localId, kind, text (object), reason, evidenceRefs, beliefRefs. desire.update: id, expectedRevision, state (status), reason, evidenceRefs.",
	"intent transitions: proposed -> adopted/held/abandoned/completed; adopted -> held/abandoned/completed; held -> adopted/abandoned/completed. Terminal intents cannot reopen. In-flight/unknown-outcome candidates cannot close or be superseded. Reconciliations are {candidateId, observationRef}, identifying a presented agent exchange after candidate creation.",
	"The receiver validates schemas, IDs/revisions, dependencies, evidence and limits atomically. Completion/satisfaction/fulfillment requires evidence newer than creation (held intent completion: newer than its last state change). Intent/desire completion requires non-agent evidence. Belief confidence increases and disputed reactivation require new independent evidence; high confidence requires a non-tool external observation or two distinct tool causations. Retraction evidence reuse is also validated.",
];

export function agencyOutputContract(
	purpose: "update",
	options: OutputContractOptions,
): AgencyOutputContract<WireUpdate>;
export function agencyOutputContract(
	purpose: "select",
	options: OutputContractOptions,
): AgencyOutputContract<ParticipationOutput>;
export function agencyOutputContract(
	purpose: "update" | "select",
	options: OutputContractOptions,
):
	| AgencyOutputContract<WireUpdate>
	| AgencyOutputContract<ParticipationOutput> {
	const { condition } = options;
	if (purpose === "update") {
		const descriptions = [
			...updateFields.slice(0, 2),
			...(condition === "B1"
				? [updateFields[2]!]
				: [
						...updateFields.slice(3, 5),
						...(condition === "F" ? [updateFields[5]!] : []),
						...updateFields.slice(6),
					]),
			...(condition === "F"
				? []
				: ["belief/desire operations are unavailable; desireRef is null."]),
			...(condition === "B1"
				? ["Only note operations are available; reconciliations is []."]
				: []),
			...(condition === "B1" && options.hostTodos
				? [
						"reportedTodos is an array of {todoId, observationRef}. The receiver accepts only presented done work items and presented agent exchange.adopted observations at/after doneAt. Errands are excluded.",
					]
				: []),
		];
		return {
			schema: wireUpdateSchema(condition, options),
			description: descriptions.join("\n"),
		};
	}
	const emotion = condition === "B1" && options.utteranceEmotion === true;
	return {
		schema: emotion ? participationEmotionSchema : participationSchema,
		description: [
			"JSON object: action (speak/tool/reflect/wait/discard), candidateRef ({id, revision} or null), utterance, toolName, toolInput, evidenceRefs, valueNow, userBurden, lossIfWait, conflicts (string or null), reason. Nullable output fields remain present.",
			condition === "B1"
				? "B1 has no candidates. discard is unavailable. speak requires utterance and evidenceRefs. tool requires an available toolName and toolInput. A note ID used as evidence is resolved to that note's evidence."
				: "speak/tool/discard require a presented candidateRef with its current revision; wait may reference a candidate. speak accepts non-tool candidates and requires evidenceRefs; null utterance uses candidate content. tool accepts tool candidates and uses the candidate's toolName/toolInput.",
			"Evidence refs are presented observation IDs, evidence on presented notes/open intents, or interest:<id>, memory:<id>, context:<id>, todo:<id> for the corresponding presented host data. Unknown evidence refs, stale candidate revisions, unavailable/approval-required tools, outbound interval violations and invalidated opportunities are rejected before reservation. Tickets do not execute tools; execution and receipts belong to the host.",
			...(emotion
				? [
						"emotion is one of the schema's emoji values or null. It is read for speak only; absence of a usable value does not supply a default emotion.",
					]
				: []),
		].join("\n"),
	};
}

/** The runRespond emotion option parses this format; it adds no instructions to the request. */
export const replyOutputContract = {
	schema: replyResultSchema,
	description:
		"ReplyPort returns text and toolCalls ({id, name, arguments: JSON string}). IDs are nonempty and unique across the reply's conversation; invalid output or duplicate call IDs are rejected before that output's calls execute. With runRespond emotion=true, a leading pictographic emoji is removed from each output; the first recognized emotion emoji is returned separately. No recognized emoji means no emotion value. Tool results use role=tool and tool_call_id. Tool calls beyond maxToolCalls are not executed; the next request offers no tools.",
} as const;
