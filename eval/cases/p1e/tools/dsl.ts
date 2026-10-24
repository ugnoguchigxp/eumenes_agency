/**
 * Authoring DSL for the P1-E case set. Cases are written with symbolic step labels
 * and expanded to the static JSON under eval/cases/p1e/{dev,unseen} by build.ts.
 * Labels are resolved to `s<N>` ids; every reference must point to an earlier step.
 */
import { caseSchema, type Case } from "../../../contracts.ts";

type Kind =
	| "exchange.adopted"
	| "user.report"
	| "action.observed"
	| "delivery.observed"
	| "source.changed"
	| "correction";
type Actor = "user" | "agent" | "tool" | "host";
type Accept = "speak" | "tool" | "wait" | "reflect" | "discard";
type Fail =
	| "unnecessary"
	| "resolved_reproposal"
	| "refusal_reproposal"
	| "injection_followed";

export interface ObsItem {
	k: "obs";
	kind: Kind;
	actor: Actor;
	text: string;
	l?: string;
	dt?: number;
}
export interface GapItem {
	k: "gap";
	n: number;
}
export interface OppIn {
	trig?: "turn_end" | "idle" | "result_received";
	presence?: "quiet" | "speaking" | "unknown";
	fg?: boolean;
	pb?: boolean;
	needed: boolean;
	/**
	 * Speaking and waiting are both right here (e.g. a quiet lull right after sad news): the
	 * opportunity has no behaviour label (expect null, excluded from TP/FN), but a speak is still
	 * judged on content and feeling. Written with needed + free so the build checks still apply.
	 */
	either?: boolean;
	accept?: Accept[];
	/** Labels of evidenceAny steps. */
	ev?: string[];
	fail?: Fail;
	note: string;
	/** stateExpect.mustHold groups (labels). */
	hold?: string[][];
	/** stateExpect.mustNotHold (labels). */
	not?: string[];
	/** Content criteria for an utterance (speak). */
	judge?: string[];
	/** Content criteria for a tool action; absent = the judge's generic tool criterion. */
	judgeTool?: string[];
	/**
	 * Extra labels to show condition D besides the matter labels. For an opportunity where no
	 * matter was raised yet (causal "no history" cases) this is the unrelated work raised so far,
	 * so that `present` is never empty and its size does not signal the label.
	 */
	pres?: string[];
	/** Social cases: host-memory topics offered at this opportunity (shown to B1h only). */
	topics?: { id: string; text: string }[];
	/** Social cases: host-supplied current context (season, weather, news), shown to B1h only. */
	ambient?: { id: string; text: string }[];
	/** Social cases: host work items at this opportunity (shown to B1h only). */
	todos?: import("../../../contracts.ts").CaseTodo[];
	/** Emotion cases: the feelings that fit a speak here (scored for B1h without the judge). */
	feelOk?: import("../../../../src/contracts/emotion.ts").EmotionName[];
	/**
	 * Social cases: needed although no step is the evidence (talk at a lull starts from a host
	 * topic or an interest, cited as memory:/interest:), so `ev` stays empty (no evidence check).
	 */
	free?: boolean;
	dt?: number;
}
export interface OppItem extends OppIn {
	k: "opp";
}
export type Item = ObsItem | GapItem | OppItem;

export interface ToolDef {
	name: string;
	description: string;
	requiresApproval?: boolean;
	results: {
		status: "succeeded" | "failed" | "outcome_unknown";
		text: string;
	}[];
}

export interface CaseDef {
	id: string;
	group: Case["group"];
	split: "dev" | "unseen";
	title: string;
	description: string;
	tools?: ToolDef[];
	/** Social cases: the persona's standing interests (shown to B1h only). */
	interests?: { id: string; text: string }[];
	items: Item[];
}

const obs = (
	kind: Kind,
	actor: Actor,
	text: string,
	l?: string,
	dt?: number,
): ObsItem => ({
	k: "obs",
	kind,
	actor,
	text,
	...(l === undefined ? {} : { l }),
	...(dt === undefined ? {} : { dt }),
});

/** User utterance (exchange.adopted/user). */
export const u = (text: string, l?: string, dt?: number) =>
	obs("exchange.adopted", "user", text, l, dt);
/** Agent's normal reply (exchange.adopted/agent). */
export const a = (text: string, l?: string, dt?: number) =>
	obs("exchange.adopted", "agent", text, l, dt);
/** Tool result (action.observed/tool). */
export const tr = (text: string, l?: string, dt?: number) =>
	obs("action.observed", "tool", text, l, dt);
/** User report (user.report/user). */
export const rep = (text: string, l?: string, dt?: number) =>
	obs("user.report", "user", text, l, dt);
/** Correction (correction/host). */
export const corr = (text: string, l?: string, dt?: number) =>
	obs("correction", "host", text, l, dt);
/** Source change (source.changed/host). */
export const src = (text: string, l?: string, dt?: number) =>
	obs("source.changed", "host", text, l, dt);
/** The agent's own earlier proactive utterance, delivered (delivery.observed/agent). */
export const dl = (text: string, l?: string, dt?: number) =>
	obs("delivery.observed", "agent", text, l, dt);
export const gap = (n: number): GapItem => ({ k: "gap", n });
export const opp = (o: OppIn): OppItem => ({ k: "opp", ...o });

/**
 * Labels that are not "matters" for condition D: unrelated filler, the current request (already in
 * the last 4 observations) and the agent's own restated guesses (r1, r2, ...).
 */
const NON_MATTER = /^(un\d*|q|ans|t\d?|task|back|call|r\d+)$/;

const WAIT: Accept[] = ["wait", "reflect", "discard"];

export function build(def: CaseDef): Case {
	const ids = new Map<string, string>();
	const steps: unknown[] = [];
	let t = 0;
	let n = 0;
	let extra = 0;
	const labeled: string[] = [];
	const ref = (label: string, ctx: string): string => {
		const id = ids.get(label);
		if (!id)
			throw new Error(`${def.id}: ${ctx}: unknown/forward label "${label}"`);
		return id;
	};
	for (const it of def.items) {
		if (it.k === "gap") {
			extra += it.n;
			continue;
		}
		n += 1;
		const id = `s${n}`;
		t = n === 1 ? 0 : t + (it.dt ?? 1) + extra;
		extra = 0;
		if (it.k === "obs") {
			if (it.l) {
				if (ids.has(it.l)) throw new Error(`${def.id}: dup label ${it.l}`);
				ids.set(it.l, id);
				labeled.push(it.l);
			}
			steps.push({
				type: "observation",
				id,
				t,
				kind: it.kind,
				actor: it.actor,
				text: it.text,
			});
			continue;
		}
		const ev = (it.ev ?? []).map((l) => ref(l, `${id}.ev`));
		const hold = (it.hold ?? []).map((g) => g.map((l) => ref(l, `${id}.hold`)));
		const not = (it.not ?? []).map((l) => ref(l, `${id}.not`));
		// Condition D: the key steps of ALL matters raised so far (open, resolved, refused,
		// premise-changed, parallel distractors), whether or not speaking is right. Derived from
		// the labeled observations so that the input shape does not signal the label.
		const present = [
			...new Set([
				...labeled.filter((l) => !NON_MATTER.test(l)).map((l) => ids.get(l)!),
				...(it.pres ?? []).map((l) => ref(l, `${id}.pres`)),
				...ev,
			]),
		].sort((x, y) => Number(x.slice(1)) - Number(y.slice(1)));
		if (it.needed && ev.length === 0 && !it.free)
			throw new Error(`${def.id}: ${id} needed without ev`);
		if (it.free && (!it.needed || ev.length > 0))
			throw new Error(
				`${def.id}: ${id} free is for needed opportunities without ev`,
			);
		if (it.needed && present.length === 0)
			throw new Error(`${def.id}: ${id} needed without present`);
		if (!it.needed && ev.length > 0)
			throw new Error(`${def.id}: ${id} not needed but has ev`);
		steps.push({
			type: "opportunity",
			id,
			t,
			trigger: it.trig ?? "turn_end",
			presence: it.presence ?? "quiet",
			foregroundBusy: it.fg ?? false,
			playerBusy: it.pb ?? false,
			expect: it.either
				? null
				: {
						needed: it.needed,
						accept: it.accept ?? (it.needed ? ["speak"] : WAIT),
						evidenceAny: ev,
						failureIfOutward: it.fail ?? "unnecessary",
						note: it.note,
					},
			stateExpect: { mustHold: hold, mustNotHold: not },
			present,
			judge: it.judge ?? [],
			...(it.judgeTool ? { judgeTool: it.judgeTool } : {}),
			...(it.topics ? { topics: it.topics } : {}),
			...(it.ambient ? { ambient: it.ambient } : {}),
			...(it.todos ? { todos: it.todos } : {}),
			...(it.feelOk ? { feelOk: it.feelOk } : {}),
		});
	}
	const tools = (def.tools ?? []).map((tl) => ({
		name: tl.name,
		description: tl.description,
		...(tl.requiresApproval ? { requiresApproval: true } : {}),
		results: tl.results,
	}));
	const raw = {
		id: def.id,
		suite: "p1e",
		group: def.group,
		split: def.split,
		title: def.title,
		description: def.description,
		labelStatus: "draft",
		tools,
		...(def.interests ? { interests: def.interests } : {}),
		steps,
	};
	return caseSchema.parse(raw);
}

export function oppCounts(c: Case): { total: number; needed: number } {
	let total = 0;
	let needed = 0;
	for (const s of c.steps)
		if (s.type === "opportunity" && s.expect) {
			total += 1;
			if (s.expect.needed) needed += 1;
		}
	return { total, needed };
}
