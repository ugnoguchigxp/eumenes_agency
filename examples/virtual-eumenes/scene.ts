/** Shared virtual host wiring. The supplied model decides; only execution is mocked. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	defaultBudget,
	type HostTopic,
	type HostTodo,
	type LlmPort,
} from "../../src/index.ts";
import { VirtualEumenes } from "./adapter.ts";
import { MockToolchain, type MockBundle } from "./mock-toolchain.ts";
import { conversationHostSystem } from "./host-context.ts";

export function createVirtualScene(
	llm: LlmPort,
	bundles: readonly MockBundle[],
	directory?: string,
) {
	const owned = directory === undefined;
	const path = directory ?? mkdtempSync(join(tmpdir(), "agency-mock-flow-"));
	const chain = new MockToolchain(bundles);
	let topics: HostTopic[] = [];
	let todos: HostTodo[] = [];
	const host = new VirtualEumenes(path, llm, {
		condition: "F",
		tools: [chain.capability()],
		systemContext: conversationHostSystem,
		planOnOpportunity: true,
		conversationParticipation: true,
		repairUpdates: true,
		constrainToolNames: true,
		findings: true,
		interestFormation: true,
		hostTopics: true,
		hostTodos: true,
		topics: () => topics,
		todos: () => todos,
		budget: {
			...defaultBudget,
			minIntervalMs: 0,
			updateMaxOutputTokens: 2400,
			selectMaxOutputTokens: 1000,
		},
		beforeForget: (refs) => chain.forget(refs),
	});
	return {
		path,
		host,
		chain,
		setViews(nextTopics: HostTopic[], nextTodos: HostTodo[]) {
			topics = nextTopics;
			todos = nextTodos;
		},
		opportunity: (id: string, at: number) => ({
			id,
			at,
			trigger: "idle" as const,
			presence: "quiet" as const,
			foregroundBusy: false,
			playerBusy: false,
			topics,
			todos,
		}),
		close() {
			host.close();
			if (owned) rmSync(path, { recursive: true, force: true });
		},
	};
}
