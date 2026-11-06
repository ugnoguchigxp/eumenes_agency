/** Scripted evaluation fixture. Decisions are queued, never matched to words in user messages. */
import { type LlmRequest, type ActionTicket } from "../../src/index.ts";
import {
	candidateAddOp,
	fakeLlm,
	intentAddOp,
	participation,
	proposal,
} from "../../test/core/helpers.ts";
import { type MockSubagent } from "./mock-toolchain.ts";
import { createVirtualScene } from "./scene.ts";

export const MIN = 60000;
export const fixtureAnswer =
	"記録では、置き場所は明るい日陰を希望し、水やりは週に一度くらいがよいと話していました。";
export const mockRevision = "mock-history@1";

export function createMockScene(
	subagent: MockSubagent = {
		async run() {
			return { status: "succeeded", summary: fixtureAnswer };
		},
	},
	directory?: string,
) {
	const llm = fakeLlm();
	const scene = createVirtualScene(
		llm,
		[
			{
				revisionId: mockRevision,
				title: "会話の記録の確認",
				description: "会話の資料から確かめるmock調査",
				requiresApproval: false,
				subagent,
			},
		],
		directory,
	);
	const { host } = scene;
	const select =
		(kind: "tool" | "share", utterance?: string, evidence?: string[]) =>
		(request: LlmRequest<unknown>) => {
			const data = JSON.parse(request.prompt);
			const candidate = data.candidates.find(
				(c: { kind: string }) => c.kind === kind,
			);
			if (!candidate) throw new Error("scenario candidate missing");
			return participation({
				action: kind === "tool" ? "tool" : "speak",
				candidateRef: { id: candidate.id, revision: candidate.revision },
				...(utterance ? { utterance } : {}),
				evidenceRefs: evidence ?? ["o1"],
			});
		};
	return {
		...scene,
		llm,
		queueIdea(revisionId = mockRevision) {
			llm.push(
				"update",
				proposal(
					[
						intentAddOp("g", {
							desiredState: "会話で気になった置き場所の条件を確かめる",
							motive: "利用者との会話から、候補を考える材料が必要",
							completionCondition: "確認した条件を会話に活かす",
							evidenceRefs: ["o1"],
						}),
						candidateAddOp("investigate", "g", {
							kind: "tool",
							content: "以前の会話で分かった置き場所と手入れの条件を調べる",
							toolName: "delegate",
							toolInput: JSON.stringify({
								revisionId,
								question:
									"以前の会話で分かった置き場所と手入れの条件を、出典の範囲で確かめてください。",
							}),
							evidenceRefs: ["o1"],
						}),
					],
					{ interestOps: [] },
				),
			);
			llm.push("select", select("tool"));
		},
		queueSpeech(text: string, evidence: string[]) {
			llm.push("update", (request: LlmRequest<unknown>) => {
				const data = JSON.parse(request.prompt);
				const intent = data.state.intents.find(
					(i: { state: string }) => i.state === "adopted",
				);
				if (!intent) throw new Error("scenario intent missing");
				return proposal(
					[
						candidateAddOp("say", intent.id, {
							kind: "share",
							content: text,
							evidenceRefs: evidence,
						}),
					],
					{ interestOps: [] },
				);
			});
			llm.push("select", select("share", text, evidence));
		},
		queueNewConversation(sourceId: string, text: string) {
			llm.push(
				"update",
				proposal(
					[
						intentAddOp("conversation", {
							desiredState: "今の会話に一言返す",
							evidenceRefs: [sourceId],
						}),
						candidateAddOp("say", "conversation", {
							kind: "share",
							content: text,
							evidenceRefs: [sourceId],
						}),
					],
					{ interestOps: [] },
				),
			);
			llm.push("select", select("share", text, [sourceId]));
		},
		publish(ticket: ActionTicket, at: number) {
			if (ticket.action !== "speak") throw Error("not a speech ticket");
			return host.recordResult({
				ticketId: ticket.id,
				status: "succeeded",
				at,
				resultText: ticket.utterance ?? "",
			});
		},
	};
}

export async function runMockConversation() {
	const scene = createMockScene();
	try {
		const { host, chain } = scene;
		host.observe({
			id: "o1",
			kind: "user.report",
			actor: "user",
			occurredAt: 0,
			text: "部屋に植物がある暮らしは気になるけど、まだ何が合うか決めていないんだ。",
		});
		scene.setViews(
			[
				{
					id: "topic-1",
					text: host.memory.get("o1")!.observation.text,
					input: { sources: ["o1"], complete: true },
				},
			],
			[],
		);
		scene.queueIdea();
		const idea = await host.decide(scene.opportunity("idea", MIN));
		if (!idea.decision.ticket) throw Error("idea not delegated");
		const dispatch = chain.handoff(host, idea.decision.ticket, MIN);
		if (!dispatch.accepted || !dispatch.started)
			throw Error("dispatch missing");
		const returned = await chain.finish(host, dispatch.workRef, 2 * MIN);
		if (!returned.accepted) throw Error("result not accepted");
		scene.setViews(
			[],
			[
				{
					id: dispatch.workRef,
					title: "会話の記録の確認",
					status: "done",
					requestedAt: MIN,
					doneAt: 2 * MIN,
					result: fixtureAnswer,
					input: { sources: [returned.observationId], complete: true },
				},
			],
		);
		const speech =
			"前に話した条件だと、明るい日陰に置けて、水やりが少なめのものが合いそうだね。そこから候補を考えてみようか。";
		scene.queueSpeech(speech, [returned.observationId]);
		const response = await host.decide(scene.opportunity("share", 3 * MIN));
		if (!response.decision.ticket) throw Error("response missing");
		scene.publish(response.decision.ticket, 3 * MIN + 1);
		return {
			success: true,
			scope:
				"Scripted model and mock execution; real Agency F, pinned host instructions, real Memory public API. No external execution or paid API. Integration success only; not a behavior-quality score.",
			events: [
				{ stage: "agency.idea", workRef: dispatch.workRef },
				...chain.events,
				{ stage: "agency.speech" },
			],
			utterance: response.decision.utterance,
			workRef: dispatch.workRef,
			resultObservationId: returned.observationId,
			apiCalls: 0,
		};
	} finally {
		scene.close();
	}
}
