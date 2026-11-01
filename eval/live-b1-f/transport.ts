/** Provider-only schema factoring. It preserves every field and nullable alternative. */
import type { ClientOptions } from "@anthropic-ai/sdk";
export type Json =
	| null
	| boolean
	| number
	| string
	| Json[]
	| { [key: string]: Json };
const object = (value: Json): value is { [key: string]: Json } =>
	value !== null && typeof value === "object" && !Array.isArray(value);

/** SDK reuses identical Zod objects, but independently-created nullable wrappers can repeat.
 * Hoist those wrappers into shared $defs rather than expanding the same grammar repeatedly.
 * $ref/$defs and null types are supported by the provider's JSON-output contract.
 */
export function shareNullableSchemas(schema: { [key: string]: Json }): {
	[key: string]: Json;
} {
	const definitions: { [key: string]: Json } = {};
	const seen = new Map<string, string>();
	const oldDefs = object(schema.$defs ?? null)
		? (schema.$defs as { [key: string]: Json })
		: {};
	let counter = 0;
	const visit = (value: Json): Json => {
		if (Array.isArray(value)) return value.map(visit);
		if (!object(value)) return value;
		const next = Object.fromEntries(
			Object.entries(value).map(([key, child]) => [key, visit(child)]),
		);
		const choices = next.anyOf;
		if (
			Array.isArray(choices) &&
			choices.some((c) => object(c) && c.type === "null")
		) {
			const key = JSON.stringify(next);
			let name = seen.get(key);
			if (!name) {
				do {
					name = `nullableShared${counter++}`;
				} while (name in oldDefs);
				seen.set(key, name);
				definitions[name] = next;
			}
			return { $ref: `#/$defs/${name}` };
		}
		return next;
	};
	const { $defs: _old, ...root } = schema;
	const rewrittenDefs = Object.fromEntries(
		Object.entries(oldDefs).map(([key, value]) => [key, visit(value)]),
	);
	const rewrittenRoot = visit(root) as { [key: string]: Json };
	return { ...rewrittenRoot, $defs: { ...rewrittenDefs, ...definitions } };
}

/** Same connection and SDK adapter as before; only factor the serialized provider schema. */
export const factoringFetch: NonNullable<ClientOptions["fetch"]> = async (
	input,
	init,
) => {
	if (typeof init?.body !== "string") return fetch(input, init);
	const body = JSON.parse(init.body) as {
		output_config?: { format?: { schema?: { [key: string]: Json } } };
	};
	const format = body.output_config?.format;
	if (!format?.schema) return fetch(input, init);
	format.schema = shareNullableSchemas(format.schema);
	return fetch(input, { ...init, body: JSON.stringify(body) });
};
