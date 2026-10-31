import { SystemContextConfigurationError } from "../contracts/errors.ts";
import type {
	BackgroundSystemContext,
	SystemContextSource,
} from "../contracts/system-context.ts";

export const requireSystemText = (value: unknown, purpose: string): string => {
	if (typeof value !== "string" || value.trim() === "")
		throw new SystemContextConfigurationError(purpose);
	return value;
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
		if (typeof source !== "function") requireSystemText(source, purpose);
	}
	return { update, select };
};

export const resolveSystemContext = <T>(
	source: SystemContextSource<T>,
	input: T,
	purpose: "update" | "select",
): string => {
	try {
		return requireSystemText(
			typeof source === "function" ? source(input) : source,
			purpose,
		);
	} catch {
		// Host errors may contain instruction text or secrets; expose only the configuration category.
		throw new SystemContextConfigurationError(purpose);
	}
};
