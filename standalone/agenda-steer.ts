/**
 * The CLI's steer for the agenda reply. It is not in the package: steer belongs to the host, and
 * Eumenes connects its own (user, 2026-11-11). Words the user sends while the reply is being written
 * go into its next model call, instead of waiting for a reply of their own (user, 2026-11-11:
 * "あなたが回答を作る前に、次のコメントを入れる事ができるようにするのにSteerがいる").
 *
 * It fills the host loop's `addedWords` seam (src/agenda/host.ts) with eumenes-steer's inbox (one
 * per process here), through the ports below, which eumenes-steer's `SteeringInbox` satisfies as
 * it is. As eumenes_steer/design.md §5 asks of Agency,
 * the boundary is each `chat.complete` of the reply loop (`runRespond` calls it again after its
 * read tools), named by the call's number. The words stay in the host's record (the agent's said
 * list); the inbox holds only their reference, and each is read again from the record when a call
 * takes it (a line forgotten meanwhile is not given). What one call took is given to the later
 * calls of the same reply too, where it was first given.
 *
 * Words that come during the last model call: where the reply's text reaches the user only when
 * the reply is done (`holdsText`, the CLI), one more call takes them and its answer is the one
 * said, so the reply answers everything the user said before it was out. Where the text streams to
 * the user as it is written (Eumenes), the first answer stands; `end` tells which words the calls
 * took, and the host answers the rest with a reply of their own right after.
 */
import type { ReplyMessage, ReplyPort } from "../src/index.ts";
import { addedWordsLine, type AgendaAddedWords } from "../src/agenda/index.ts";

/** How the reply sees words that came while it was being written (the package's mark). */
export const steeredLine = addedWordsLine;

/** One reference held by the inbox (eumenes-steer's `Required<SteeringEvent>`). */
export interface SteerEventRef {
	readonly id: string;
	readonly sourceRef: string;
	readonly sourceRevision: string;
	readonly expiresAt: number;
}

/** The handle of one target (eumenes-steer's `SteeringTarget`, the part used here). */
export interface SteerTargetPort {
	enqueue(event: {
		readonly id: string;
		readonly sourceRef: string;
		readonly sourceRevision: string;
	}): { readonly status: string };
	claim(boundaryId: string):
		| {
				readonly status: "claimed";
				readonly batch: {
					readonly id: symbol;
					readonly events: readonly SteerEventRef[];
				};
		  }
		| {
				readonly status:
					| "empty"
					| "busy"
					| "boundary_settled"
					| "closed"
					| "invalid_boundary";
		  };
	settle(
		batchId: symbol,
		outcome: "committed" | "released" | "unknown",
	): string;
	close(): number;
}

/** The inbox (eumenes-steer's `SteeringInbox`, the part used here). */
export interface SteerInboxPort {
	open(
		targetId: string,
		generation: string,
	):
		| { readonly status: "opened"; readonly target: SteerTargetPort }
		| {
				readonly status:
					| "invalid_target"
					| "generation_conflict"
					| "target_limit";
		  };
}

/** Steer as the host loop's `addedWords`. */
export type AgendaReplySteering = AgendaAddedWords;

/** Calls made again for words that came during the last one, at most (the user may keep typing). */
const MAX_RETAKES = 2;

/**
 * One steering per conversation's host loop (its replies run one at a time): `send` goes to the
 * reply open now. Many conversations share one inbox, each with its own steering.
 */
export function createAgendaReplySteering(input: {
	readonly inbox: SteerInboxPort;
	/** The words of a user's line in the host's record, or null once it is gone (forgotten). */
	readonly read: (id: string) => string | null;
	/** The inbox's clock (its `expiresAt` is read against this). */
	readonly now: () => number;
	/** The reply's text reaches the user only when the reply is done (see the module's note). */
	readonly holdsText?: boolean;
	/** Target ids are `<prefix><replyId>` (Eumenes namespaces its inbox's targets). */
	readonly targetPrefix?: string;
}): AgendaReplySteering {
	const prefix = input.targetPrefix ?? "agenda-reply:";
	let open: {
		readonly target: SteerTargetPort;
		readonly taken: Set<string>;
		sent: number;
	} | null = null;

	return {
		begin(replyId) {
			if (open) throw new Error("steer: a reply is open already");
			const opened = input.inbox.open(`${prefix}${replyId}`, "1");
			if (opened.status !== "opened")
				throw new Error(`steer: ${prefix}${replyId} ${opened.status}`);
			const run = { target: opened.target, taken: new Set<string>(), sent: 0 };
			open = run;
			return {
				wrap(chat) {
					let call = 0;
					// Words taken by an earlier call, kept where they were first given.
					const given: { at: number; message: ReplyMessage }[] = [];
					return {
						async complete(request, onDelta, signal) {
							for (let retake = 0; ; retake++) {
								call++;
								const sentBefore = run.sent;
								const claimed = run.target.claim(`call-${call}`);
								const fresh: { id: string; message: ReplyMessage }[] = [];
								if (claimed.status === "claimed")
									for (const e of claimed.batch.events) {
										if (e.expiresAt <= input.now()) continue;
										const text = input.read(e.sourceRef);
										if (text === null) continue;
										fresh.push({
											id: e.sourceRef,
											message: { role: "user", content: steeredLine(text) },
										});
									}
								const at = request.messages.length;
								const messages = [...request.messages];
								// Each place gets its words in the order sent; places from the end, so earlier
								// positions hold.
								const places = new Map<number, ReplyMessage[]>();
								for (const a of [
									...given,
									...fresh.map((f) => ({ at, message: f.message })),
								])
									places.set(a.at, [...(places.get(a.at) ?? []), a.message]);
								for (const [place, words] of [...places].sort(
									(x, y) => y[0] - x[0],
								))
									messages.splice(place, 0, ...words);
								// Held until it is known to be the answer said.
								const held: string[] = [];
								let out: Awaited<ReturnType<ReplyPort["complete"]>>;
								try {
									out = await chat.complete(
										{ ...request, messages },
										input.holdsText ? (t) => held.push(t) : onDelta,
										signal,
									);
								} catch (e) {
									// Not known to be taken: the words stay for a later call or a reply of their own.
									if (claimed.status === "claimed")
										run.target.settle(claimed.batch.id, "released");
									throw e;
								}
								if (claimed.status === "claimed")
									run.target.settle(claimed.batch.id, "committed");
								for (const f of fresh) {
									run.taken.add(f.id);
									given.push({ at, message: f.message });
								}
								const cameMeanwhile = run.sent > sentBefore;
								if (
									input.holdsText &&
									out.toolCalls.length === 0 &&
									cameMeanwhile &&
									retake < MAX_RETAKES
								)
									continue;
								for (const t of held) onDelta(t);
								return out;
							}
						},
					};
				},
				end() {
					run.target.close();
					if (open === run) open = null;
					return [...run.taken];
				},
			};
		},
		send(id) {
			if (!open) return false;
			const r = open.target.enqueue({
				id,
				sourceRef: id,
				sourceRevision: "1",
			});
			if (r.status !== "accepted") return false;
			open.sent++;
			return true;
		},
	};
}
