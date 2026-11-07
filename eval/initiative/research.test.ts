import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createAgencyRuntime } from "../../src/index.ts";
import {
	fakeLlm,
	obsInput,
	opportunity,
	proposal,
	intentAddOp,
	candidateAddOp,
	participation,
} from "../../test/core/helpers.ts";
import { createResearchFixture } from "./research.ts";

const host = resolve(import.meta.dir, "../../../eumenes");
test.skipIf(!existsSync(resolve(host, "api/application/agency/research.ts")))(
	"host admission checks the selected ticket's actual input and advertised revision",
	async () => {
		const research = await createResearchFixture(host, 100);
		try {
			expect(research.tools[0]?.description).toContain(
				'"revisionId":"catalog1"',
			);
			for (const [input, problem] of [
				["{}", "agency_delegation_invalid"],
				[
					'{"revisionId":"unknown","question":"何を比較するか"}',
					"agency_capability_unavailable",
				],
				['{"revisionId":"catalog1","question":"何を比較するか"}', null],
			] as const) {
				const llm = fakeLlm();
				const runtime = createAgencyRuntime({
					condition: "F",
					systemContext: { update: "host", select: "host" },
					llm,
					tools: research.tools,
				});
				runtime.observe(obsInput("o1", "user.report", "user", 0, "相談"));
				llm.push(
					"update",
					proposal([
						intentAddOp("g"),
						candidateAddOp("c", "g", {
							kind: "tool",
							toolName: "delegate",
							toolInput: input,
						}),
					]),
				);
				llm.push(
					"select",
					participation({
						action: "tool",
						candidateRef: { id: "c2", revision: 1 },
						evidenceRefs: ["o1"],
					}),
				);
				const { decision } = await runtime.decide(
					opportunity("test", 100),
					new AbortController().signal,
				);
				expect(decision.ticket?.action).toBe("tool");
				const admit = () =>
					research.admit(decision.ticket!, runtime, "synthetic");
				if (problem) expect(admit).toThrow(problem);
				else expect(admit).not.toThrow();
			}
		} finally {
			research.close();
		}
	},
);
