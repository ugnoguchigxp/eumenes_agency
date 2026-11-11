/**
 * The CLI's reply: the packaged reply (src/agenda/reply.ts, what Eumenes gets) with the CLI's
 * toolchain catalog, mocked (a toolchain that fits is always found; its work is a mock note).
 */
import {
	agendaReplyMessages as packagedReplyMessages,
	agendaReplySystem as packagedReplySystem,
	createAgendaReplyTools as packagedReplyTools,
	type AgendaToolchains,
} from "../src/agenda/reply.ts";
import { mockToolchainFor } from "../examples/virtual-eumenes/agenda/research.ts";

export * from "../src/agenda/reply.ts";

export const mockToolchains: AgendaToolchains = {
	find: (query) => [mockToolchainFor(query)],
};

/** The reply's tools with the mock toolchains (the CLI, the evaluation and the tests). */
export function createAgendaReplyTools(
	input: Omit<Parameters<typeof packagedReplyTools>[0], "toolchains">,
) {
	return packagedReplyTools({ ...input, toolchains: mockToolchains });
}

/** The reply's rules with the toolchain tools' (they are offered here). */
export const agendaReplySystem = (persona?: string) =>
	packagedReplySystem(persona, { toolchains: true });

/** The reply's messages, with the toolchain tools' rules (they are offered here). */
export const agendaReplyMessages = (
	input: Omit<Parameters<typeof packagedReplyMessages>[0], "toolchains">,
) => packagedReplyMessages({ ...input, toolchains: true });
