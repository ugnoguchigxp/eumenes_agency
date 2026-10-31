/** P4-b: build the host-facing DelegationRequest from an autonomous delegate ticket. */
import type {
	DelegationBudget,
	DelegationRequest,
} from "../contracts/delegation.ts";
import type { Intent } from "../contracts/model.ts";
import type { ActionTicket } from "../contracts/runtime.ts";
import { DELEGATE_TOOL } from "./runtime.ts";

/** Null unless the ticket is an autonomous delegate tool ticket bound to an intent (intent.workRef = ticket id). */
export const delegationRequest = (
	ticket: ActionTicket,
	state: { readonly intents: readonly Intent[] },
	budget: DelegationBudget,
	at: number,
): DelegationRequest | null => {
	if (ticket.action !== "tool" || ticket.toolName !== DELEGATE_TOOL)
		return null;
	if (ticket.origin !== "autonomous") return null;
	const it = state.intents.find((i) => i.workRef === ticket.id);
	if (!it) return null;
	const question = (ticket.toolInput ?? "").trim();
	if (!question) return null;
	return {
		workRef: ticket.id,
		intentId: it.id,
		question,
		desiredState: it.desiredState,
		motive: it.motive,
		acceptance: it.completionCondition,
		budget,
		origin: "autonomous",
		requestedAt: at,
	};
};
