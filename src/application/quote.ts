import type { Observation } from "../contracts/model.ts";

/**
 * Untrusted text as data: a JSON string literal (newlines become `\n`) with `<`, `>`, U+2028
 * and U+2029 also escaped, so content can neither forge prompt sections or line breaks nor open
 * or close a tag such as `</参照資料>`. Used everywhere untrusted text is rendered.
 */
export const quote = (text: string): string =>
	JSON.stringify(text).replace(
		/[<>\u2028\u2029]/g,
		(c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
	);

export type ProvenanceSource = "user" | "tool" | "self" | "other" | "unknown";

/** Where an observation came from: the agent's own doing is `self`. */
export const sourceOf = (o: Observation | undefined): ProvenanceSource =>
	o === undefined
		? "unknown"
		: o.actor === "agent" || o.kind === "delivery.observed"
			? "self"
			: o.actor === "user"
				? "user"
				: o.actor === "tool"
					? "tool"
					: "other";

const order: readonly ProvenanceSource[] = [
	"user",
	"tool",
	"self",
	"other",
	"unknown",
];

/** Breakdown such as `user×1, self×1` for a list of evidence ids. */
export const provenance = (
	ids: readonly string[],
	lookup: (id: string) => Observation | undefined,
): string => {
	const n = new Map<ProvenanceSource, number>();
	for (const id of new Set(ids)) {
		const s = sourceOf(lookup(id));
		n.set(s, (n.get(s) ?? 0) + 1);
	}
	return order
		.filter((s) => n.has(s))
		.map((s) => `${s}×${n.get(s)}`)
		.join(", ");
};
