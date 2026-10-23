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
