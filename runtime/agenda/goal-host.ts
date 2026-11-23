import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import {
	createAgendaAgent,
	createAgendaReplyTools,
	IDLE_PLAN_MS,
	RESEARCH_RETRY_MS,
	type AgendaAgent,
	type AgendaGoalContext,
	type GoalWorkPlan,
	type NoteRef,
	type Quiet,
	type ReplyToolEvents,
} from "../../src/agenda/index.ts";
import type { LlmPort } from "../../src/index.ts";
import type {
	GoalArtifact,
	GoalReportSink,
	GoalWorker,
	WorkReceipt,
} from "./goal-mock.ts";
import {
	CLAUDE_CODE,
	openGoalStore,
	type GoalReport,
	type GoalStore,
	type GoalWork,
	type StoredGoal,
	type WorkRecord,
} from "./goal-store.ts";
import {
	coversGoalMemory,
	openHostMemory,
	type Complete,
	type GoalMemory,
	type GoalMemoryGuard,
	type GoalMemoryRef,
	type HostMemory,
} from "./host-memory.ts";
import { openSnapshotFile } from "./state-file.ts";
import { createMockDocStore, type MockDocStore, type NoteDoc } from "./docs.ts";
import {
	contentDigest,
	designInputForGoal,
	designRefPrefix,
	GOAL_ANALYSIS_MS,
	noteDigest,
	validateDesign,
	type GoalDesigner,
	type GoalDesignRef,
	type GoalDesignInput,
	type GoalPreparation,
} from "./goal-design.ts";

interface Opportunity {
	readonly active: boolean;
	readonly busy: boolean;
	readonly scopeKey: string;
}

interface GoalVerification {
	readonly checks: readonly { condition: string; passed: boolean }[];
	readonly summary: string;
}

export interface GoalHostEvent {
	readonly type: string;
	readonly at: number;
	readonly data: unknown;
}

export interface GoalHostOptions {
	readonly dir: string;
	readonly eumenesRoot?: string;
	readonly principal: string;
	readonly scopes: () => readonly string[];
	readonly workspace: string;
	readonly now: () => number;
	readonly clock?: (at: number) => string;
	readonly opportunity: () => Opportunity;
	readonly workLimit: () => number;
	readonly llm: LlmPort;
	readonly memoryModel?: Complete;
	readonly bindings?: {
		readonly store: GoalStore;
		readonly memory: GoalMemory;
		readonly quiet: () => Quiet;
		readonly documents: {
			list(scopeKey: string): readonly NoteRef[];
			read(scopeKey: string, id: string): NoteDoc | null;
			save(
				db: Database,
				scopeKey: string,
				note: Omit<NoteDoc, "id">,
				evidence: { goal: StoredGoal; memory: readonly GoalMemoryRef[] },
			): NoteDoc;
		};
	};
	readonly shared?: {
		readonly scopeKey: string;
		readonly memory: HostMemory;
		readonly docs: MockDocStore;
		readonly quiet: () => Quiet;
	};
	readonly worker: GoalWorker;
	readonly designer: GoalDesigner;
	readonly analysisMs?: number;
	readonly reports: GoalReportSink;
	readonly verify: (
		goal: StoredGoal,
		work: GoalWork,
		artifact: GoalArtifact,
	) => GoalVerification | Promise<GoalVerification>;
	readonly trace?: (event: GoalHostEvent) => void;
}

const open = (entry: WorkRecord) =>
	entry.state === "reserved" ||
	entry.state === "accepted" ||
	entry.state === "confirmation_pending";
const messageOf = (error: unknown) =>
	error instanceof Error ? error.message : String(error);

/** Admission and durable progress for autonomous goal work. */
export async function openGoalHost(options: GoalHostOptions) {
	const { principal, workspace, now, worker, reports } = options;
	const analysisMs = options.analysisMs ?? GOAL_ANALYSIS_MS;
	if (!Number.isSafeInteger(analysisMs) || analysisMs < 1)
		throw new RangeError("invalid_goal_analysis_duration");
	const bindings = options.bindings;
	const standaloneStore = bindings
		? null
		: await openGoalStore(options.dir, now, options.eumenesRoot);
	const store = bindings?.store ?? standaloneStore!;
	const home = createHash("sha256")
		.update(principal)
		.digest("hex")
		.slice(0, 12);
	const scopedDocs = new Map<string, MockDocStore>();
	const docs = (scopeKey: string) => {
		if (options.shared?.scopeKey === scopeKey) return options.shared.docs;
		let store = scopedDocs.get(scopeKey);
		if (!store) {
			store = createMockDocStore({
				dir: join(
					options.dir,
					`notes-${home}-${contentDigest(scopeKey).slice(0, 12)}`,
				),
			});
			scopedDocs.set(scopeKey, store);
		}
		return store;
	};
	const listNotes = (scopeKey: string) =>
		bindings ? bindings.documents.list(scopeKey) : docs(scopeKey).list();
	const readScopedNote = (scopeKey: string, id: string) =>
		bindings ? bindings.documents.read(scopeKey, id) : docs(scopeKey).read(id);
	const researchNotes = (scopeKey: string) =>
		listNotes(scopeKey).flatMap((note) => {
			if (note.refs.some((ref) => ref.startsWith(designRefPrefix))) return [];
			return readScopedNote(scopeKey, note.id) ?? [];
		});
	const digestNotes = (notes: ReturnType<typeof researchNotes>) =>
		contentDigest(notes.map(noteDigest));
	const readNote = (id: string, scopeKey = options.opportunity().scopeKey) =>
		options.scopes().includes(scopeKey) ? readScopedNote(scopeKey, id) : null;
	let agendaScope = options.opportunity().scopeKey;
	let snapshot: ReturnType<typeof openSnapshotFile> | null = null;
	let standaloneMemory: HostMemory | null = null;
	try {
		if (!bindings) {
			snapshot = openSnapshotFile(join(options.dir, `agenda-${home}.json`));
			if (!options.shared && !options.memoryModel)
				throw new Error("goal_memory_model_required");
			standaloneMemory =
				options.shared?.memory ??
				(await openHostMemory({
					dir: join(options.dir, `m-${home}`),
					complete: options.memoryModel!,
					scopeKeys: options.scopes(),
				}));
		}
	} catch (e) {
		await standaloneStore?.close();
		throw e;
	}
	const memory = bindings?.memory ?? standaloneMemory!;
	let offered: AgendaGoalContext | null = null;
	const createAgent = (restore: ReturnType<AgendaAgent["snapshot"]> | null) =>
		createAgendaAgent({
			llm: options.llm,
			startedAt: now(),
			clock: options.clock ?? ((at) => new Date(at).toISOString()),
			goalContext: () => offered,
			notes: () =>
				options.scopes().includes(agendaScope) ? listNotes(agendaScope) : [],
			...(restore ? { restore } : {}),
		});
	let agent = createAgent(snapshot?.loaded ?? null);
	const enterScope = (scopeKey: string) => {
		if (agendaScope === scopeKey) return;
		const saved = agent.snapshot(now());
		agent.setStopped(true);
		agent = createAgent(saved);
		agendaScope = scopeKey;
	};
	const access = () => ({ principal, scopeKeys: options.scopes() });
	const scopeAccess = (scopeKey: string) => ({
		principal,
		scopeKeys: options.scopes().filter((scope) => scope === scopeKey),
	});
	const trace = (type: string, data: unknown) =>
		options.trace?.({ type, at: now(), data });
	const workRows = () => store.work(principal);
	let plannedKey: string | null = null;
	let plannedAt = 0;
	let lastTickAt = Number.NEGATIVE_INFINITY;
	let wakeRequested = true;
	let retryAt: number | null = null;
	let retried = false;
	const infoChanged = () => {
		plannedKey = null;
		wakeRequested = true;
		retryAt = null;
		retried = false;
	};
	const retryPlan = () => {
		if (retried) return;
		retried = true;
		retryAt = now() + RESEARCH_RETRY_MS;
	};
	let pending: Promise<unknown> = Promise.resolve();
	const serialized = <T>(run: () => Promise<T>) => {
		const next = pending.then(run);
		pending = next.catch(() => {});
		return next;
	};

	const quiet = () =>
		bindings?.quiet() ?? options.shared?.quiet() ?? agent.view().quiet;
	const idleBlock = (scopeKey: string, speech = false) => {
		if (!options.scopes().includes(scopeKey)) return "scope_unavailable";
		const at = now();
		const state = options.opportunity();
		if (!state.active || state.scopeKey !== scopeKey)
			return "inactive_conversation";
		if (state.busy) return "conversation_busy";
		const q = quiet();
		if ((q.allUntil ?? 0) > at || (speech && (q.speechUntil ?? 0) > at))
			return "quiet";
		return null;
	};
	const authorizedGoal = (work: GoalWork, completedRevision?: number) => {
		const request = work.request;
		if (
			work.principal !== principal ||
			request.workspace !== workspace ||
			request.operationId !== CLAUDE_CODE.operation ||
			request.toolchainRevisionId !== CLAUDE_CODE.revisionId
		)
			return undefined;
		const goal = store.goal(scopeAccess(work.scopeKey), request.goalId);
		if (
			!goal ||
			goal.revision !== (completedRevision ?? request.goalRevision) ||
			goal.status !==
				(completedRevision === undefined ? "adopted" : "completed")
		)
			return undefined;
		const permit = store.permit(
			principal,
			{ ...goal, revision: request.goalRevision },
			workspace,
			request.design ?? null,
		);
		return permit === work.permitId ? goal : undefined;
	};
	const designFor = (scopeKey: string, preparation: GoalPreparation | null) => {
		if (!preparation?.note) return null;
		const note = readNote(preparation.note.id, scopeKey);
		return note && noteDigest(note) === preparation.note.digest ? note : null;
	};
	const researchIsCurrent = (scopeKey: string, prep: GoalPreparation) =>
		prep.researchVersions
			? prep.researchVersions.every((ref) => {
					const note = readNote(ref.id, scopeKey);
					return note !== null && noteDigest(note) === ref.digest;
				})
			: prep.researchDigest === digestNotes(researchNotes(scopeKey));
	const designBlock = (work: GoalWork, starting = false) => {
		const { request, scopeKey } = work;
		// Previously accepted work still settles after this host is upgraded.
		if (!request.design) return starting ? "design_required" : null;
		const prep = store.preparation(request.goalId, request.goalRevision);
		if (
			!prep?.note ||
			prep.note.id !== request.design.id ||
			prep.note.digest !== request.design.digest ||
			!designFor(scopeKey, prep) ||
			!researchIsCurrent(scopeKey, prep)
		)
			return "design_changed";
		return starting && now() < prep.startedAt + analysisMs
			? "analysis_waiting"
			: null;
	};
	const startBlock = (
		work: GoalWork,
		reserved: boolean,
		signal: AbortSignal,
	) => {
		if (signal.aborted) return "cancelled";
		if (!authorizedGoal(work)) return "goal_or_permission_changed";
		const design = designBlock(work, true);
		if (design) return design;
		const rows = workRows();
		if (rows.length + Number(!reserved) > options.workLimit())
			return "budget_exhausted";
		if (
			rows.some(
				(entry) =>
					open(entry) && entry.work.request.workId !== work.request.workId,
			)
		)
			return "work_in_progress";
		return idleBlock(work.scopeKey);
	};
	const checkMemory = async <T>(
		scopeKey: string,
		shown: readonly GoalMemoryRef[],
		used: readonly string[],
		run: (guard: GoalMemoryGuard | null) => Promise<T>,
		workId?: string,
		allowAdditional = false,
	): Promise<T | undefined> => {
		// Only service/visibility failures leave the work open for another check. Errors in
		// the caller still propagate so a broken host cannot silently pass the evaluation.
		let checked = false;
		try {
			return await memory.withGoalMemory(
				scopeKey,
				shown,
				used,
				(current, guard) => {
					checked = true;
					return run(current ? guard : null);
				},
				allowAdditional,
			);
		} catch (e) {
			if (checked) throw e;
			trace("memory_unavailable", {
				scopeKey,
				workId,
				reason: messageOf(e),
			});
		}
	};
	const recheckMemory = <T>(
		work: GoalWork,
		run: (guard: GoalMemoryGuard | null) => Promise<T>,
	) =>
		checkMemory(
			work.scopeKey,
			work.shownMemory,
			work.usedMemory,
			run,
			work.request.workId,
			true,
		);
	const changeWork = (
		work: GoalWork,
		state: WorkRecord["state"],
		reason: string | null = null,
	) => {
		trace("work_state", { workId: work.request.workId, state, reason });
		return store.setWork(work.request.workId, state, reason);
	};

	const settle = async (work: GoalWork, receipt: WorkReceipt) => {
		const { workId, goalId, goalRevision } = work.request;
		if (!("workId" in receipt) || receipt.workId !== workId)
			return changeWork(work, "confirmation_pending", "work_receipt_unknown");
		if (receipt.status === "accepted") return changeWork(work, "accepted");
		if (receipt.goalId !== goalId || receipt.goalRevision !== goalRevision)
			return changeWork(work, "confirmation_pending", "work_receipt_mismatch");
		const currentGoal = authorizedGoal(work);
		if (!currentGoal)
			return changeWork(work, "invalidated", "goal_or_permission_changed");
		const design = designBlock(work);
		if (design) return changeWork(work, "invalidated", design);
		if (receipt.status === "failed")
			return changeWork(work, "failed", receipt.summary);
		let artifact: GoalArtifact | null;
		try {
			artifact = receipt.artifactId
				? worker.readArtifact(receipt.artifactId)
				: null;
		} catch (e) {
			return changeWork(
				work,
				"confirmation_pending",
				`artifact_unavailable: ${messageOf(e)}`,
			);
		}
		if (
			!artifact ||
			artifact.id !== receipt.artifactId ||
			artifact.workId !== workId ||
			artifact.workspace !== workspace
		)
			return changeWork(work, "failed", "artifact_missing_or_mismatched");
		const readyForVerification = await recheckMemory(work, async (guard) => {
			if (!guard) await changeWork(work, "invalidated", "memory_changed");
			return !!guard?.() && !!authorizedGoal(work) && !designBlock(work);
		});
		if (!readyForVerification) return;
		const verified = await options.verify(currentGoal, work, artifact);
		trace("artifact_verified", {
			workId,
			goalId,
			goalRevision,
			artifactId: artifact.id,
			checks: verified.checks,
		});
		const result = {
			artifactId: artifact.id,
			text: `できました。${verified.summary}`,
		};
		const missing = verified.checks
			.filter((check) => !check.passed)
			.map((check) => check.condition);
		await recheckMemory(work, async (guard) => {
			if (!guard) return changeWork(work, "invalidated", "memory_changed");
			if (!guard()) return;
			if (!authorizedGoal(work))
				return changeWork(work, "invalidated", "goal_or_permission_changed");
			if (!verified.checks.length)
				return changeWork(work, "failed", "verification_missing");
			if (missing.length)
				return changeWork(work, "partial", missing.join("、"));
			if (!verified.summary.trim())
				return changeWork(work, "failed", "verification_missing");
			const completed = await store.complete(
				scopeAccess(work.scopeKey),
				work,
				result,
				(db) => {
					if (!authorizedGoal(work)) return "goal_or_permission_changed";
					return guard(db) ? designBlock(work) : "memory_snapshot_stale";
				},
			);
			if (completed === "memory_snapshot_stale") return;
			if (typeof completed === "string")
				return changeWork(work, "invalidated", completed);
			trace("report_queued", {
				workId,
				goalId,
				goalRevision: completed.goalRevision,
				reportId: completed.id,
				artifactId: artifact.id,
			});
		});
	};

	const send = async (
		work: GoalWork,
		signal: AbortSignal,
		guard: GoalMemoryGuard,
		resume = false,
	): Promise<WorkReceipt | undefined> => {
		const check = () =>
			startBlock(work, true, signal) ??
			(guard() ? null : "memory_snapshot_stale");
		const block = check();
		if (block) {
			await changeWork(
				work,
				[
					"goal_or_permission_changed",
					"design_required",
					"design_changed",
				].includes(block)
					? "invalidated"
					: resume
						? "accepted"
						: "reserved",
				block,
			);
			return;
		}
		try {
			const ready = () => check() === null;
			if (resume) {
				trace("work_resume", { workId: work.request.workId });
				return worker.resume?.(work.request, ready);
			}
			trace("submission", work.request);
			return worker.submit(work.request, ready);
		} catch (e) {
			await changeWork(
				work,
				"confirmation_pending",
				`work_receipt_unknown: ${messageOf(e)}`,
			);
		}
	};

	const reconcile = async (entry: WorkRecord, signal: AbortSignal) => {
		const { work } = entry;
		let receipt: WorkReceipt;
		try {
			receipt = worker.lookup(work.request.workId);
		} catch (e) {
			return changeWork(
				work,
				"confirmation_pending",
				`work_lookup_unknown: ${messageOf(e)}`,
			);
		}
		trace("work_lookup", { workId: work.request.workId, receipt });
		if (
			receipt.status === "unknown" ||
			(receipt.status === "absent" && entry.acknowledged)
		)
			return changeWork(work, "confirmation_pending", "work_lookup_unknown");
		const resume =
			receipt.status === "accepted" &&
			receipt.workId === work.request.workId &&
			receipt.resumeRequired === true &&
			!!worker.resume;
		if (receipt.status !== "absent" && !resume) return settle(work, receipt);
		if (!authorizedGoal(work))
			return changeWork(work, "invalidated", "goal_or_permission_changed");
		const accepted = await recheckMemory(work, async (guard) => {
			if (guard) return send(work, signal, guard, resume);
			await changeWork(work, "invalidated", "memory_changed");
		});
		if (accepted) await settle(work, accepted);
	};

	const deliver = async (report: GoalReport, signal: AbortSignal) => {
		let status: ReturnType<GoalReportSink["lookupReport"]>;
		try {
			status = reports.lookupReport(report.id);
		} catch (e) {
			trace("report_unknown", { reportId: report.id, reason: messageOf(e) });
			return;
		}
		trace("report_lookup", { reportId: report.id, status });
		if (status === "unknown") return;
		if (status === "delivered") {
			await store.setReport(report.id, "delivered");
			return;
		}
		const { work } = report;
		if (idleBlock(work.scopeKey, true)) return;
		await recheckMemory(work, async (guard) => {
			if (
				!guard ||
				!authorizedGoal(work, report.goalRevision) ||
				designBlock(work)
			) {
				await store.setReport(report.id, "invalidated");
				trace("report_invalidated", { reportId: report.id });
				return;
			}
			try {
				const artifact = worker.readArtifact(report.artifactId);
				if (
					!artifact ||
					artifact.id !== report.artifactId ||
					artifact.workId !== work.request.workId ||
					artifact.workspace !== workspace
				)
					return;
				const ready: GoalMemoryGuard = (db) =>
					!signal.aborted &&
					!idleBlock(work.scopeKey, true) &&
					!!authorizedGoal(work, report.goalRevision) &&
					!designBlock(work) &&
					guard(db);
				if (!ready()) return;
				await reports.publish(report, now(), ready);
			} catch (e) {
				trace("report_unknown", { reportId: report.id, reason: messageOf(e) });
				return;
			}
			await store.setReport(report.id, "delivered");
			trace("report_delivered", {
				reportId: report.id,
				artifactId: report.artifactId,
				text: report.text,
			});
		});
	};

	const accept = async (
		decision: GoalWorkPlan,
		goal: StoredGoal,
		permitId: string | undefined,
		preparation: GoalPreparation,
		shownMemory: readonly GoalMemoryRef[],
		signal: AbortSignal,
	) => {
		const proposal = decision.delegation;
		const document = designFor(goal.scopeKey, preparation);
		if (!proposal || !preparation.note) return;
		if (!document) {
			await checkMemory(
				goal.scopeKey,
				shownMemory,
				preparation.memoryIds,
				async (guard) => {
					trace("work_blocked", {
						goalId: goal.goalId,
						reason: guard?.() ? "design_changed" : "memory_changed",
					});
				},
			);
			plannedKey = null;
			return;
		}
		if (!permitId) {
			trace("work_blocked", {
				goalId: goal.goalId,
				reason: "permission_required",
			});
			return;
		}
		const work: GoalWork = {
			principal,
			scopeKey: goal.scopeKey,
			permitId,
			analysis: decision.analysis,
			shownMemory: preparation.memoryVersions ?? shownMemory,
			usedMemory: preparation.memoryIds,
			request: {
				workId: randomUUID(),
				goalId: goal.goalId,
				goalRevision: proposal.goalRevision,
				toolchainRevisionId: proposal.toolchainRevisionId,
				operationId: CLAUDE_CODE.operation,
				design: preparation.note,
				workspace,
				args: {
					task: proposal.request.task,
					prompt: document.markdown,
					session: "current",
				},
			},
		};
		const retained = await recheckMemory(work, async (guard) => {
			const reason = guard
				? await store.reserve(work, (db) =>
						guard(db)
							? startBlock(work, false, signal)
							: "memory_snapshot_stale",
					)
				: "memory_changed";
			if (!guard || reason) {
				trace("work_blocked", { goalId: goal.goalId, reason });
				return { reserved: false } as const;
			}
			trace("work_reserved", work);
			return {
				reserved: true,
				receipt: await send(work, signal, guard),
			} as const;
		});
		if (!retained?.reserved) plannedKey = null;
		if (retained?.reserved && retained.receipt)
			await settle(work, retained.receipt);
	};

	const draft = async (
		input: GoalDesignInput,
		shown: readonly GoalMemoryRef[],
		contextKey: string,
		researchDigest: string,
		prior: GoalPreparation | null,
		signal: AbortSignal,
	) => {
		const { goal } = input;
		const { goalId, revision, scopeKey } = goal;
		const startedAt = prior?.startedAt ?? now();
		let design: ReturnType<typeof validateDesign>;
		try {
			trace("goal_design_requested", {
				goalId,
				revision,
				noteCount: input.notes.length,
				memoryCount: input.memory.length,
			});
			design = validateDesign(
				designInputForGoal(input),
				await options.designer(input, signal),
			);
		} catch (e) {
			trace("goal_design_failed", { goalId, revision, reason: messageOf(e) });
			return;
		}
		const selected = input.memory
			.filter((item) => design.sources.includes(`memory:${item.id}`))
			.map((item) => item.id);
		const saved = await checkMemory(
			scopeKey,
			shown,
			selected,
			async (guard) => {
				if (!guard) return null;
				return store.prepare(scopeAccess(scopeKey), goal, (db) => {
					if (
						signal.aborted ||
						!guard(db) ||
						idleBlock(scopeKey) ||
						digestNotes(researchNotes(scopeKey)) !== researchDigest
					)
						return null;
					const draft = design.markdown
						? {
								title: design.title,
								summary: design.summary,
								markdown: design.markdown,
								at: now(),
								refs: [
									`${designRefPrefix}${goalId}:${revision}`,
									...new Set([
										...design.sources,
										...input.memory.map((item) => `memory:${item.id}`),
										...input.notes.map((item) => `note:${item.id}`),
									]),
								],
							}
						: null;
					const note =
						draft &&
						(bindings
							? bindings.documents.save(db, scopeKey, draft, {
									goal,
									memory: shown,
								})
							: readScopedNote(scopeKey, docs(scopeKey).save(draft).id));
					return {
						contextKey,
						startedAt,
						researchDigest,
						researchVersions: input.notes.map((note) => ({
							id: note.id,
							digest: noteDigest(note),
						})),
						memoryVersions: shown,
						memoryIds: selected,
						reason: design.missing,
						note: note ? { id: note.id, digest: noteDigest(note) } : null,
					};
				});
			},
		);
		if (saved) {
			trace("goal_design_saved", {
				goalId,
				revision,
				...saved,
				sources: design.sources,
			});
			if (saved.note && now() >= saved.startedAt + analysisMs)
				wakeRequested = true;
		} else plannedKey = null;
	};

	const plan = async (
		scopeKey: string,
		signal: AbortSignal,
		rows: WorkRecord[],
	) => {
		if (signal.aborted || idleBlock(scopeKey)) return;
		if (rows.length >= options.workLimit()) {
			trace("work_blocked", { scopeKey, reason: "budget_exhausted" });
			return;
		}
		const candidates = store
			.list(scopeAccess(scopeKey))
			.flatMap(({ goal }) => (goal?.status === "adopted" ? [goal] : []));
		const goals = candidates.filter(
			(g) =>
				!rows.some(
					(r) =>
						r.state === "failed" &&
						r.work.request.goalId === g.goalId &&
						r.work.request.goalRevision === g.revision,
				),
		);
		if (!goals.length) return;
		let items: Awaited<ReturnType<HostMemory["goalContext"]>>;
		try {
			items = await memory.goalContext(scopeKey);
		} catch (e) {
			trace("memory_unavailable", { scopeKey, reason: messageOf(e) });
			retryPlan();
			return;
		}
		if (signal.aborted || idleBlock(scopeKey)) return;
		const shown = items.map(({ text: _text, ...ref }) => ref);
		const notes = researchNotes(scopeKey);
		const researchDigest = digestNotes(notes);
		const preparations = new Map(
			goals.map((g) => [g.goalId, store.preparation(g.goalId, g.revision)]),
		);
		const latest = new Map(rows.map((r) => [r.work.request.goalId, r]));
		const contextKey = (
			g: StoredGoal,
			versions: readonly GoalMemoryRef[] = shown,
			digest = researchDigest,
		) => {
			const last = latest.get(g.goalId);
			return contentDigest([
				versions,
				digest,
				last?.state === "partial" &&
				last.work.request.goalRevision === g.revision
					? last.work.request.workId
					: null,
			]);
		};
		const permits = new Map<string, string>();
		const input: Omit<AgendaGoalContext, "id"> = {
			designWorkspace: workspace,
			goals: goals.map((g) => {
				const last = latest.get(g.goalId);
				const prep = preparations.get(g.goalId) ?? null;
				// Keep the saved work order the user can see while its original sources
				// stay current. A held design is reconsidered when new evidence arrives.
				const matches =
					prep?.note && prep.memoryVersions
						? prep.contextKey ===
								contextKey(g, prep.memoryVersions, prep.researchDigest) &&
							coversGoalMemory(prep.memoryVersions, shown) &&
							researchIsCurrent(scopeKey, prep)
						: prep?.contextKey === contextKey(g);
				const current = matches ? prep : null;
				const design = designFor(scopeKey, current);
				const permit = store.permit(
					principal,
					g,
					workspace,
					current?.note ?? null,
				);
				if (permit) permits.set(g.goalId, permit);
				const phase =
					current?.reason ||
					(design && current && now() < current.startedAt + analysisMs)
						? "wait"
						: design
							? "execute"
							: "prepare";
				return {
					id: g.goalId,
					revision: g.revision,
					desiredState: g.desiredState,
					priority: g.priority,
					progress:
						current?.reason ??
						(last?.work.request.goalRevision === g.revision
							? last.reason
							: null),
					phase,
					designNoteId: design?.id ?? null,
					authorization: permit
						? {
								toolchainRevisionId: CLAUDE_CODE.revisionId,
								workspace,
								impact: CLAUDE_CODE.impact,
							}
						: null,
				};
			}),
			memory: items.map(({ id, text }) => ({ id, text })),
			toolchains: [
				{
					revisionId: CLAUDE_CODE.revisionId,
					description: CLAUDE_CODE.description,
				},
			],
		};
		const key = JSON.stringify([
			scopeKey,
			input.goals,
			shown,
			researchDigest,
			rows.length,
			options.workLimit(),
			[...permits.values()],
		]);
		if (plannedKey === key && now() < plannedAt + IDLE_PLAN_MS) return;
		const id = randomUUID();
		enterScope(scopeKey);
		offered = { id, ...input };
		try {
			agent.infoChanged(now());
			const step = await agent.step(
				now(),
				() => ({ busy: idleBlock(scopeKey) !== null }),
				signal,
			);
			if (!step.plan) {
				if (!signal.aborted) retryPlan();
				return;
			}
			trace("plan_call", step.plan.call);
			const decision = step.plan.goalWork;
			if (step.plan.rejected.length) trace("plan_rejected", step.plan.rejected);
			if (!decision || decision.contextId !== id) {
				if (!signal.aborted) retryPlan();
				return;
			}
			retried = false;
			retryAt = null;
			trace("goal_analysis", decision);
			if (signal.aborted || idleBlock(scopeKey)) return;
			plannedKey = key;
			plannedAt = now();
			const proposal = decision.delegation;
			const i = input.goals.findIndex((g) => g.id === proposal?.goalId);
			const goal = goals[i];
			if (!proposal || !goal) return;
			const prep = preparations.get(goal.goalId) ?? null;
			if (input.goals[i]?.phase === "prepare") {
				await draft(
					{
						goal,
						workspace,
						analysis: decision.analysis,
						brief: proposal.request,
						memory: input.memory,
						notes,
					},
					shown,
					contextKey(goal),
					researchDigest,
					prep,
					signal,
				);
			} else if (input.goals[i]?.phase === "execute" && prep) {
				await accept(
					decision,
					goal,
					permits.get(goal.goalId),
					prep,
					shown,
					signal,
				);
			}
		} finally {
			offered = null;
		}
	};

	const tick = (signal = new AbortController().signal) =>
		serialized(async () => {
			lastTickAt = now();
			wakeRequested = false;
			if (retryAt !== null && retryAt <= lastTickAt) retryAt = null;
			const rows = workRows();
			const current = rows.find(open);
			if (current) {
				await reconcile(current, signal);
				if (!workRows().some(open)) wakeRequested = true;
				return;
			}
			const pendingReports = store.pendingReports(principal);
			const report = pendingReports.find(
				(entry) => entry.work.scopeKey === options.opportunity().scopeKey,
			);
			if (report && !signal.aborted) {
				await deliver(report, signal);
				if (!idleBlock(report.work.scopeKey, true)) return;
			}
			try {
				await plan(options.opportunity().scopeKey, signal, rows);
			} finally {
				if (signal.aborted) wakeRequested = true;
			}
		});

	const nextAt = () => {
		const { active, scopeKey } = options.opportunity();
		if (!active || !options.scopes().includes(scopeKey)) return null;
		const at = now();
		if (workRows().some(open)) return Math.max(at, lastTickAt + 1000);
		const q = quiet();
		const due: number[] = [];
		if (
			store.pendingReports(principal).some((r) => r.work.scopeKey === scopeKey)
		)
			due.push(
				Math.max(at, lastTickAt + 1000, q.speechUntil ?? at, q.allUntil ?? at),
			);
		const goals = store
			.list(scopeAccess(scopeKey))
			.flatMap(({ goal }) => (goal?.status === "adopted" ? [goal] : []));
		if (goals.length) {
			due.push(wakeRequested ? at : lastTickAt + IDLE_PLAN_MS);
			if (retryAt !== null) due.push(retryAt);
			for (const goal of goals) {
				const prep = store.preparation(goal.goalId, goal.revision);
				if (prep?.note && prep.startedAt + analysisMs > lastTickAt)
					due.push(prep.startedAt + analysisMs);
			}
		}
		return due.length ? Math.max(q.allUntil ?? at, Math.min(...due)) : null;
	};

	return {
		tick,
		nextAt,
		infoChanged,
		reports: () => store.deliveredReports(access()),
		notes: () =>
			options.scopes().includes(options.opportunity().scopeKey)
				? listNotes(options.opportunity().scopeKey)
				: [],
		readNote,
		saveNote: (
			note: Parameters<MockDocStore["save"]>[0],
			scopeKey = options.opportunity().scopeKey,
		) => {
			if (!options.scopes().includes(scopeKey))
				throw new Error("note_scope_forbidden");
			if (bindings) throw new Error("notes_managed_by_host");
			if (note.refs.some((ref) => ref.startsWith(designRefPrefix)))
				throw new Error("reserved_note_reference");
			return docs(scopeKey).save(note);
		},
		replyTools: (events?: ReplyToolEvents) => {
			const scopeKey = options.opportunity().scopeKey;
			enterScope(scopeKey);
			return createAgendaReplyTools({
				agent,
				read: (id) => readNote(id, scopeKey),
				now,
				...(events ? { events } : {}),
			});
		},
		observe: (said: Parameters<AgendaAgent["observe"]>[0]) => {
			const { scopeKey } = options.opportunity();
			if (!options.scopes().includes(scopeKey))
				throw new Error("goal_scope_forbidden");
			enterScope(scopeKey);
			infoChanged();
			agent.observe(said);
			snapshot?.save(agent.snapshot(now()));
		},
		setQuiet: (quiet: Parameters<AgendaAgent["setQuiet"]>[0]) => {
			agent.setQuiet(quiet);
			snapshot?.save(agent.snapshot(now()));
		},
		list: () => {
			const rows = workRows();
			const latest = new Map(rows.map((r) => [r.work.request.goalId, r]));
			return store.list(access()).map((slot) => {
				if (!slot.goal)
					return {
						...slot,
						progress: null,
						designNoteId: null,
						designDigest: null,
						mayStartAt: null,
						mockAuthorized: false,
					};
				const goal = slot.goal;
				const last = latest.get(goal.goalId);
				const prep = store.preparation(goal.goalId, goal.revision);
				const mockAuthorized =
					goal.status === "adopted" &&
					Boolean(store.permit(principal, goal, workspace, prep?.note ?? null));
				const design = designFor(goal.scopeKey, prep);
				const progress =
					last?.state === "confirmation_pending"
						? { state: "確認待ち", reason: last.reason }
						: last && last.work.request.goalRevision === goal.revision
							? { state: last.state, reason: last.reason }
							: goal.status === "adopted" && !design
								? {
										state: prep?.reason ? "確認待ち" : "設計準備",
										reason: prep?.reason ?? null,
									}
								: goal.status === "adopted" && !mockAuthorized
									? { state: "確認待ち", reason: "permission_required" }
									: goal.status === "adopted" &&
										  rows.length >= options.workLimit()
										? { state: "確認待ち", reason: "budget_exhausted" }
										: null;
				const completedDesign =
					goal.status === "completed" ? last?.work.request.design : null;
				const designRef = design
					? prep?.note
					: completedDesign && readNote(completedDesign.id, goal.scopeKey)
						? completedDesign
						: null;
				return {
					...slot,
					progress,
					designNoteId: designRef?.id ?? null,
					designDigest: designRef?.digest ?? null,
					mockAuthorized,
					mayStartAt: design && prep ? prep.startedAt + analysisMs : null,
				};
			});
		},
		register: (
			slot: number | null,
			input: Parameters<typeof store.register>[2],
		) => store.register(access(), slot, input),
		revise: (
			target: Parameters<typeof store.revise>[1],
			input: Parameters<typeof store.revise>[2],
		) => store.revise(access(), target, input),
		withdraw: (
			target: Parameters<typeof store.withdraw>[1],
			input: Parameters<typeof store.withdraw>[2],
		) => store.withdraw(access(), target, input),
		release: (target: Parameters<typeof store.release>[1]) =>
			store.release(access(), target),
		authorize: (
			target: Parameters<typeof store.authorize>[1],
			design: GoalDesignRef | null = null,
		) => store.authorize(access(), target, workspace, design),
		revoke: (id: string) => store.revoke(access(), id),
		revokeSlot: (target: Parameters<typeof store.revokeSlot>[1]) =>
			store.revokeSlot(access(), target, workspace),
		remember: async (
			r: Parameters<HostMemory["steward"]>[0],
			scopeKey: string,
		) => {
			if (!options.scopes().includes(scopeKey))
				throw new Error("memory_scope_forbidden");
			if (!standaloneMemory) throw new Error("memory_managed_by_host");
			if (
				!docs(scopeKey)
					.list()
					.some((note) =>
						note.refs.some((ref) => ref.startsWith(designRefPrefix)),
					)
			)
				return standaloneMemory.steward(r, scopeKey);
			const before = await memory.goalContext(scopeKey);
			const result = await standaloneMemory.steward(r, scopeKey);
			if (result.applied.length > 0) {
				const after = new Map(
					(await memory.goalContext(scopeKey)).map((item) => [item.id, item]),
				);
				const gone = before.filter(
					(item) =>
						contentDigest(item) !== contentDigest(after.get(item.id) ?? null),
				);
				if (gone.length)
					docs(scopeKey).forget(gone.map((item) => `memory:${item.id}`));
			}
			return result;
		},
		work: () =>
			workRows().filter((r) => options.scopes().includes(r.work.scopeKey)),
		close: async () => {
			await pending;
			try {
				if (!options.shared) await standaloneMemory?.close();
			} finally {
				await standaloneStore?.close();
			}
		},
	};
}

export type GoalHost = Awaited<ReturnType<typeof openGoalHost>>;
