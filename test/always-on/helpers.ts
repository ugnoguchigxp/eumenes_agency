import type {
	LlmPort,
	LlmRequest,
	ThinkOutput,
	TickHost,
	UserOp,
} from "../../src/index.ts";

export const idle: () => TickHost = () => ({ busy: false });

const think = (
	base: ThinkOutput,
	extra: Partial<ThinkOutput>,
): ThinkOutput => ({
	thought: extra.thought ?? base.thought,
	drive: extra.drive ?? base.drive,
	userOps: extra.userOps ?? base.userOps,
	stockOps: extra.stockOps ?? base.stockOps,
	pace: extra.pace ?? base.pace,
	action: extra.action ?? base.action,
	next: extra.next ?? base.next,
});

export const noPace: ThinkOutput["pace"] = {
	op: "none",
	minutes: null,
	evidenceRefs: [],
};

/** An action with every unused field null. */
export const action = (
	kind: ThinkOutput["action"]["kind"],
	a: Partial<ThinkOutput["action"]> = {},
): ThinkOutput["action"] => ({
	kind,
	utterance: a.utterance ?? null,
	toolName: a.toolName ?? null,
	toolInput: a.toolInput ?? null,
	evidenceRefs: a.evidenceRefs ?? [],
});

export const prepare = (
	toolName: string,
	toolInput: string,
	evidenceRefs: string[],
	extra: Partial<ThinkOutput> = {},
): ThinkOutput =>
	think(
		wait({
			drive: "delight",
			action: action("prepare", { toolName, toolInput, evidenceRefs }),
		}),
		extra,
	);

export const say = (
	utterance: string,
	evidenceRefs: string[] = [],
	extra: Partial<ThinkOutput> = {},
): ThinkOutput =>
	think(
		{
			thought: "話しかけてみよう",
			drive: "presence",
			userOps: [],
			stockOps: [],
			pace: noPace,
			action: action("speak", {
				utterance,
				evidenceRefs,
			}),
			next: "normal",
		},
		extra,
	);

export const ask = (
	utterance: string,
	evidenceRefs: string[] = [],
	extra: Partial<ThinkOutput> = {},
): ThinkOutput =>
	think(
		say(utterance, evidenceRefs, {
			drive: "know_user",
			action: action("ask", { utterance, evidenceRefs }),
		}),
		extra,
	);

export const wait = (extra: Partial<ThinkOutput> = {}): ThinkOutput =>
	think(
		{
			thought: "今は様子を見る",
			drive: "rest",
			userOps: [],
			stockOps: [],
			pace: noPace,
			action: action("wait"),
			next: "normal",
		},
		extra,
	);

/** A user-model op with every unused field null. */
export const op = (o: Partial<UserOp> & Pick<UserOp, "op">): UserOp => ({
	id: null,
	aspect: null,
	basis: null,
	text: null,
	reason: null,
	evidenceRefs: [],
	...o,
});

export interface ScriptedThink extends LlmPort {
	readonly requests: LlmRequest<unknown>[];
}

/** Answers each think call from `reply` (called with the parsed prompt data). */
export const scriptedThink = (
	reply: (data: Record<string, unknown>, n: number) => ThinkOutput,
	hooks: { before?: () => void } = {},
): ScriptedThink => {
	const requests: LlmRequest<unknown>[] = [];
	return {
		requests,
		complete<T>(req: LlmRequest<T>) {
			requests.push(req as LlmRequest<unknown>);
			hooks.before?.();
			const value = reply(
				JSON.parse(req.prompt) as Record<string, unknown>,
				requests.length,
			);
			return Promise.resolve({
				value: req.schema.parse(value),
				model: "scripted",
				inputTokens: req.prompt.length,
				outputTokens: 50,
				cacheReadTokens: 0,
				latencyMs: 1,
			});
		},
	};
};

export const signal = () => new AbortController().signal;
