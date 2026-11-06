import { createSelfPort, type SelfPort } from "./self-port/port.ts";
import { createProviderLlm } from "../standalone/providers.ts";
import { loadSettings, openSpendMeter } from "../standalone/settings.ts";

/** Existing file-answer scenes stay free. Paid execution always requires an explicit mode and ledger. */
export function createEvaluationPort(dir: string): SelfPort {
	const transport = process.env.AGENCY_EVAL_TRANSPORT ?? "self";
	if (transport === "self") return createSelfPort(dir);
	if (transport !== "api")
		throw new Error("AGENCY_EVAL_TRANSPORT must be self or api");
	if (!process.env.AGENCY_API_LEDGER || !process.env.AGENCY_API_LIMIT_USD)
		throw new Error(
			"API scenes require AGENCY_API_LEDGER and AGENCY_API_LIMIT_USD",
		);
	const settings = loadSettings();
	const llm = createProviderLlm(
		settings.llm.background,
		openSpendMeter(settings),
	);
	return { ...llm, setSalt() {}, pending: () => 0, reset() {} };
}
