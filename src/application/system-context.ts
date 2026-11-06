import { SystemContextConfigurationError } from "../contracts/errors.ts";
import type {
	BackgroundSystemContext,
	SystemContextSource,
} from "../contracts/system-context.ts";
import type { WithInput } from "../contracts/memory.ts";
import { mergeInputs, unknownInput } from "./provenance.ts";

export const requireSystemText = (value: unknown, purpose: string): string => {
	if (typeof value !== "string" || value.trim() === "")
		throw new SystemContextConfigurationError(purpose);
	return value;
};

const declaredSystem = (
	value: string | WithInput<string>,
	purpose: string,
): WithInput<string> =>
	typeof value === "string"
		? { value: requireSystemText(value, purpose), input: unknownInput }
		: {
				value: requireSystemText(value?.value, purpose),
				input: mergeInputs(value.input),
			};

/** Capture the host's sources, so later edits to its configuration cannot replace them. */
export const captureSystemContext = (
	value: BackgroundSystemContext | "experimental",
): BackgroundSystemContext | "experimental" => {
	if (value === "experimental") return value;
	if (!value || typeof value !== "object")
		throw new SystemContextConfigurationError("background");
	const { update, select } = value;
	for (const [purpose, source] of Object.entries({ update, select })) {
		if (typeof source !== "function") {
			try {
				declaredSystem(source, purpose);
			} catch {
				throw new SystemContextConfigurationError(purpose);
			}
		}
	}
	const capture = <T>(source: SystemContextSource<T>) =>
		typeof source === "function" || typeof source === "string"
			? source
			: structuredClone(source);
	return { update: capture(update), select: capture(select) };
};

export const resolveSystemContext = <T>(
	source: SystemContextSource<T>,
	input: T,
	purpose: "update" | "select",
): string => {
	return resolveSystemContextInput(source, input, purpose).value;
};

/** Resolve text and its declaration once; retries use the same captured result. */
export const resolveSystemContextInput = <T>(
	source: SystemContextSource<T>,
	input: T,
	purpose: "update" | "select",
): WithInput<string> => {
	try {
		return declaredSystem(
			typeof source === "function" ? source(input) : source,
			purpose,
		);
	} catch {
		// Host errors may contain instruction text or secrets; expose only the configuration category.
		throw new SystemContextConfigurationError(purpose);
	}
};
