/**
 * Mock/testing helper: a ToolPort with the tool names and argument shapes of the Eumenes host
 * (find_toolchain, delegate, work, memory) but no toolchains behind it. For the standalone CLI
 * and tests only; a real host passes its own ToolPort.
 */
import type { HostTodo } from "../contracts/model.ts";
import type {
	ReplyToolCall,
	ToolDefinition,
	ToolPort,
} from "../contracts/ports.ts";

export interface MockToolchain {
	readonly toolchain: string;
	readonly description: string;
}

export interface MockToolPortOptions {
	/** Clock for `requestedAt` / `doneAt`. Default: a logical counter (1, 2, ...). */
	readonly now?: () => number;
	/** Candidates `find_toolchain` returns (fixed, whatever the query). */
	readonly toolchains?: readonly MockToolchain[];
	/** What `memory` `read` returns. */
	readonly memory?: string;
}

export interface MockCompletion {
	readonly outcome: "succeeded" | "partial" | "failed";
	readonly result: string;
	readonly nextActions?: readonly string[];
}

export interface MockToolPort extends ToolPort {
	/** The host-side work items (not archived), oldest first; fits `RuntimeDeps.todos`. */
	todos(): readonly HostTodo[];
	/** The sub-agent finished the item (status done). Throws for an unknown or finished item. */
	complete(todoId: string, completion: MockCompletion): HostTodo;
	/** The sub-agent asks the user a question (status waiting). Throws for an unknown or finished item. */
	ask(todoId: string, question: string): HostTodo;
	/** The host archives a reported item: it leaves `todos()`. Returns false when unknown. */
	archive(todoId: string): boolean;
}

export const defaultMockToolchains: readonly MockToolchain[] = [
	{
		toolchain: "web.search",
		description: "Webを検索して現在の情報を調べる",
	},
	{
		toolchain: "music.generate",
		description: "指定した雰囲気の楽曲を生成する",
	},
];

const object = (
	properties: Record<string, unknown>,
	required: readonly string[],
): Record<string, unknown> => ({
	type: "object",
	properties,
	required,
	additionalProperties: false,
});

const definitions: readonly ToolDefinition[] = [
	{
		name: "find_toolchain",
		description:
			"仕事を任せられる専門の担当（toolchain）を探す。必要な仕事の内容を query に書く。",
		parameters: object({ query: { type: "string" } }, ["query"]),
	},
	{
		name: "delegate",
		description:
			"見つけた担当に仕事を依頼する。依頼するとTODOができ、結果は後で届く。",
		parameters: object(
			{
				mode: { type: "string", enum: ["execute", "confirm", "approve"] },
				toolchain: { type: "string" },
				request: { type: "string" },
				announcement: { type: "string" },
				impact: { type: "string" },
			},
			["mode", "toolchain", "request", "impact"],
		),
	},
	{
		name: "work",
		description:
			"依頼した仕事の操作。check=状況の確認、answer=担当の質問への回答、amend=依頼の訂正、cancel=取消。",
		parameters: object(
			{
				todo: { type: "string" },
				operation: {
					type: "string",
					enum: ["check", "answer", "amend", "cancel"],
				},
				revision: { type: "integer" },
				questionId: { type: "string" },
				text: { type: "string" },
			},
			["todo", "operation", "revision"],
		),
	},
	{
		name: "memory",
		description:
			"記憶の操作。read=覚えていることを読む、request=記憶への依頼（覚える・直す）。",
		parameters: object(
			{
				operation: { type: "string", enum: ["read", "request"] },
				query: { type: "string" },
				text: { type: "string" },
			},
			["operation"],
		),
	},
];

interface Item {
	todo: HostTodo;
	revision: number;
	request: string;
	toolchain: string;
	questionId: string | null;
}

const modes = ["execute", "confirm", "approve"];
const operations = ["check", "answer", "amend", "cancel"];

const json = (value: unknown): { content: string } => ({
	content: JSON.stringify(value),
});
const failure = (error: string, detail?: string) =>
	json({ status: "error", error, ...(detail === undefined ? {} : { detail }) });

const str = (v: unknown): string | undefined =>
	typeof v === "string" && v.trim() !== "" ? v : undefined;

const clip = (text: string, limit = 60) =>
	text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;

export const createMockToolPort = (
	options: MockToolPortOptions = {},
): MockToolPort => {
	let tick = 0;
	const now = options.now ?? (() => ++tick);
	const toolchains = options.toolchains ?? defaultMockToolchains;
	const memory = options.memory ?? "該当する記憶はありません。";
	const items = new Map<string, Item>();
	let counter = 0;

	const open = (id: string): Item => {
		const item = items.get(id);
		if (!item) throw new Error(`unknown todo: ${id}`);
		if (item.todo.status === "done") throw new Error(`todo is done: ${id}`);
		return item;
	};
	const set = (item: Item, todo: HostTodo): HostTodo => {
		item.todo = todo;
		return todo;
	};

	const run = (call: ReplyToolCall): { content: string } => {
		let args: Record<string, unknown>;
		try {
			const parsed: unknown = JSON.parse(call.arguments);
			if (
				typeof parsed !== "object" ||
				parsed === null ||
				Array.isArray(parsed)
			)
				return failure("invalid_arguments", "object expected");
			args = parsed as Record<string, unknown>;
		} catch {
			return failure("invalid_arguments", "not JSON");
		}
		switch (call.name) {
			case "find_toolchain": {
				if (str(args.query) === undefined)
					return failure("invalid_arguments", "query");
				return json({ candidates: toolchains });
			}
			case "delegate": {
				const request = str(args.request);
				const toolchain = str(args.toolchain);
				if (
					!modes.includes(String(args.mode)) ||
					request === undefined ||
					toolchain === undefined ||
					str(args.impact) === undefined
				)
					return failure(
						"invalid_arguments",
						"mode, toolchain, request, impact",
					);
				if (!toolchains.some((t) => t.toolchain === toolchain))
					return failure("unknown_toolchain", toolchain);
				const id = `t${++counter}`;
				items.set(id, {
					todo: {
						id,
						title: clip(request),
						status: "todo",
						requestedAt: now(),
					},
					revision: 1,
					request,
					toolchain,
					questionId: null,
				});
				return json({ status: "accepted", todo: id, revision: 1 });
			}
			case "work": {
				const id = str(args.todo);
				const operation = String(args.operation);
				const item = id === undefined ? undefined : items.get(id);
				if (!operations.includes(operation) || !item || id === undefined)
					return failure("unknown_todo_or_operation");
				if (args.revision !== item.revision)
					return failure("revision_conflict", String(item.revision));
				const todo = item.todo;
				if (operation === "check")
					return json({
						status: todo.status,
						revision: item.revision,
						title: todo.title,
						...(todo.question === undefined
							? {}
							: { question: todo.question, questionId: item.questionId }),
						...(todo.status === "done"
							? { outcome: todo.outcome, result: todo.result }
							: {}),
					});
				if (todo.status === "done") return failure("already_done");
				if (operation === "answer") {
					if (todo.status !== "waiting" || args.questionId !== item.questionId)
						return failure("no_such_question");
					if (str(args.text) === undefined)
						return failure("invalid_arguments", "text");
					const { question: _question, ...rest } = todo;
					set(item, { ...rest, status: "todo" });
					item.questionId = null;
					item.revision += 1;
					return json({ status: "accepted", revision: item.revision });
				}
				if (operation === "amend") {
					const text = str(args.text);
					if (text === undefined) return failure("invalid_arguments", "text");
					item.request = `${item.request}\n${text}`;
					item.revision += 1;
					return json({ status: "accepted", revision: item.revision });
				}
				items.delete(id);
				return json({ status: "cancelled" });
			}
			case "memory": {
				if (args.operation === "read") return json({ result: memory });
				if (args.operation === "request" && str(args.text) !== undefined)
					return json({ status: "accepted" });
				return failure("invalid_arguments", "operation");
			}
			default:
				return failure("unknown_tool", call.name);
		}
	};

	return {
		tools: definitions,
		call: async (call, signal) => {
			signal.throwIfAborted();
			return run(call);
		},
		todos: () => [...items.values()].map((x) => x.todo),
		complete(todoId, completion) {
			const item = open(todoId);
			const { question: _question, ...rest } = item.todo;
			item.questionId = null;
			return set(item, {
				...rest,
				status: "done",
				outcome: completion.outcome,
				result: completion.result,
				...(completion.nextActions
					? { nextActions: completion.nextActions }
					: {}),
				doneAt: now(),
			});
		},
		ask(todoId, question) {
			const item = open(todoId);
			item.questionId = `q${++counter}`;
			return set(item, { ...item.todo, status: "waiting", question });
		},
		archive: (todoId) => items.delete(todoId),
	};
};
