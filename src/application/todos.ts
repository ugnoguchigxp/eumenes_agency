import type { HostTodo } from "../contracts/model.ts";

/**
 * Host-side helper for work reports (hostTodos mode): the ids of the host work items an
 * accepted utterance reported. The host archives these once the utterance is delivered.
 */
export const reportedTodoIds = (evidenceRefs: readonly string[]): string[] => [
	...new Set(
		evidenceRefs
			.filter((ref) => ref.startsWith("todo:") && ref.length > 5)
			.map((ref) => ref.slice(5)),
	),
];

/**
 * Delivery attribute for an outward decision (spec/autonomous-interest-design.md §5.5):
 * whether the host speaks the utterance aloud. Decided mechanically from the host's
 * silent-report mode and the cited work items' origins, never by the model. Undefined
 * when the host configured no mode (nothing is stamped). A speak counts as a
 * self-originated report when it cites at least one todo of origin "self" and no todo
 * of origin "user"; only then does mode ON make it silent (tts: false).
 */
export const decisionTts = (
	silentSelfReports: boolean | undefined,
	action: "speak" | "tool",
	evidenceRefs: readonly string[],
	todos: readonly HostTodo[],
): boolean | undefined => {
	if (silentSelfReports === undefined) return undefined;
	if (!silentSelfReports || action !== "speak") return true;
	let self = false;
	for (const id of reportedTodoIds(evidenceRefs)) {
		const todo = todos.find((x) => x.id === id);
		if (todo?.origin === "user") return true;
		if (todo?.origin === "self") self = true;
	}
	return !self;
};
