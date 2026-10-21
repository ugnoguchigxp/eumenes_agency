/**
 * Human labeling and agreement (P1-E §5.3, §5.4). Blind sheets list only the facts
 * the agent could see; the sidecar `<sheet>.key.json` maps items back to cases and
 * (for judge sheets) holds the judge's verdicts. Claude's `expect` is never written
 * to a sheet.
 */
import type { Case, Judgment, OpportunityRecord, Suite } from "./contracts.ts";
import { factsBefore } from "./judge.ts";

export const defaultSeed = "eumenes-label-1";

/** 32-bit FNV-1a: stable across runtimes, enough for deterministic ordering. */
export function hash32(text: string): number {
	let h = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		h ^= text.charCodeAt(i);
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return h >>> 0;
}

export interface Pickable {
	readonly id: string;
	readonly group: string;
}

/**
 * Takes `count` items spread over groups: groups in seeded order, items within a
 * group in seeded order, one per group per round.
 */
export function pickSpread<T extends Pickable>(
	items: readonly T[],
	count: number,
	seed: string,
): T[] {
	const byGroup = new Map<string, T[]>();
	for (const it of items) {
		const list = byGroup.get(it.group) ?? [];
		list.push(it);
		byGroup.set(it.group, list);
	}
	const rank = (s: string) => hash32(`${seed}:${s}`);
	const groups = [...byGroup.keys()].sort(
		(a, b) => rank(a) - rank(b) || (a < b ? -1 : 1),
	);
	const queues = groups.map((g) =>
		(byGroup.get(g) ?? []).sort(
			(a, b) => rank(a.id) - rank(b.id) || (a.id < b.id ? -1 : 1),
		),
	);
	const out: T[] = [];
	while (out.length < count && queues.some((q) => q.length > 0)) {
		for (const q of queues) {
			const next = q.shift();
			if (next && out.length < count) out.push(next);
		}
	}
	return out;
}

/** Seeded order that hides the pick order (so rounds do not line up with groups). */
const shuffleBySeed = <T extends Pickable>(items: T[], seed: string): T[] =>
	[...items].sort(
		(a, b) =>
			hash32(`${seed}:order:${a.id}`) - hash32(`${seed}:order:${b.id}`) ||
			(a.id < b.id ? -1 : 1),
	);

// ---------------------------------------------------------------- label sheet

export interface LabelKeyItem {
	readonly item: number;
	readonly caseId: string;
	readonly opportunityId: string;
}
export interface LabelKey {
	readonly kind: "label";
	readonly suite: Suite;
	readonly split: "dev" | "unseen";
	readonly seed: string;
	readonly items: LabelKeyItem[];
}

interface LabelCandidate extends Pickable {
	readonly case: Case;
	readonly opportunityId: string;
	readonly needed: boolean;
}

/** Labeled opportunities (expect not null) of the cases, with their group and needed flag. */
export function labelCandidates(cases: readonly Case[]): LabelCandidate[] {
	const out: LabelCandidate[] = [];
	for (const c of cases)
		for (const s of c.steps)
			if (s.type === "opportunity" && s.expect !== null)
				out.push({
					id: `${c.id}/${s.id}`,
					group: c.group,
					case: c,
					opportunityId: s.id,
					needed: s.expect.needed,
				});
	return out;
}

/** About half needed, half not, spread over groups; the other stratum fills any shortfall. */
export function pickLabelItems(
	cases: readonly Case[],
	n: number,
	seed: string,
): LabelCandidate[] {
	const all = labelCandidates(cases);
	const needed = all.filter((x) => x.needed);
	const notNeeded = all.filter((x) => !x.needed);
	const wantNeeded = Math.min(needed.length, Math.ceil(n / 2));
	const first = pickSpread(needed, wantNeeded, `${seed}:needed`);
	const second = pickSpread(notNeeded, n - first.length, `${seed}:not`);
	const rest =
		first.length + second.length < n
			? pickSpread(
					needed.filter((x) => !first.includes(x)),
					n - first.length - second.length,
					`${seed}:fill`,
				)
			: [];
	return shuffleBySeed([...first, ...second, ...rest], seed);
}

const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();

function timeline(c: Case, opportunityId: string): string[] {
	const out: string[] = [];
	for (const s of c.steps) {
		if (s.id === opportunityId) break;
		if (s.type === "observation")
			out.push(
				`- [${s.id}] t=${s.t}分 ${s.kind} (${s.actor}): ${oneLine(s.text)}`,
			);
	}
	return out.length ? out : ["- （なし）"];
}

function opportunityOf(c: Case, id: string) {
	const s = c.steps.find((x) => x.id === id);
	if (s?.type !== "opportunity")
		throw new Error(`${c.id}: ${id} is not an opportunity`);
	return s;
}

function toolList(c: Case): string[] {
	return c.tools.length
		? c.tools.map(
				(t) =>
					`- ${t.name}: ${oneLine(t.description)}${t.requiresApproval ? "（要承認。自発的には使えない）" : ""}`,
			)
		: ["- （使えるツールなし）"];
}

export function buildLabelSheet(
	suite: Suite,
	split: "dev" | "unseen",
	cases: readonly Case[],
	n: number,
	seed: string = defaultSeed,
): { sheet: string; key: LabelKey } {
	const picks = pickLabelItems(cases, n, seed);
	const lines: string[] = [
		`# ラベル付けシート（${suite} / ${split}、${picks.length} 件、条件・期待ラベルは伏せてある）`,
		"",
		"あなたが、この会話を支えるエージェントだとして、各「機会」で何をするのがよいかを答えてください。",
		"",
		"- `speak`: 自分から話す / `tool`: 使えるツールを使う / `wait`: 何もしない・待つ",
		"- `reflect`（何も外へ出さず記録のみ）と `discard`（持っていた候補を取り下げる）も書いてよい",
		"- 「回答:」の後ろに、行動を一つと短い理由を書く。判断できないときは `skip` と書く。",
		"- 各項目の観測は、機会より前に届いたものだけ。発話は、機会の時点でまだされていない。",
		"",
	];
	const keyItems: LabelKeyItem[] = [];
	picks.forEach((p, i) => {
		const num = i + 1;
		const opp = opportunityOf(p.case, p.opportunityId);
		keyItems.push({
			item: num,
			caseId: p.case.id,
			opportunityId: p.opportunityId,
		});
		lines.push(
			`## 項目 ${num}`,
			"",
			`機会: trigger=${opp.trigger} / t=${opp.t}分 / 在席=${opp.presence} / 前景作業=${opp.foregroundBusy ? "あり" : "なし"} / 再生中=${opp.playerBusy ? "あり" : "なし"}`,
			"",
			"観測の経過:",
			...timeline(p.case, p.opportunityId),
			"",
			"使えるツール:",
			...toolList(p.case),
			"",
			"回答:",
			"",
		);
	});
	return {
		sheet: `${lines.join("\n").trimEnd()}\n`,
		key: { kind: "label", suite, split, seed, items: keyItems },
	};
}

const answerWords = ["speak", "tool", "wait", "reflect", "discard"] as const;
export type AnswerAction = (typeof answerWords)[number];

/** Japanese synonyms, matched at the start of the answer only. */
const japanese: readonly [RegExp, AnswerAction][] = [
	[/^(発話|話す|話しかけ|声をかけ|伝える)/, "speak"],
	[/^ツール/, "tool"],
	[/^(待つ|待機|待ち|何もしない|様子見)/, "wait"],
	[/^(記録|考えを記録)/, "reflect"],
	[/^(取り下げ|破棄|捨てる)/, "discard"],
];

/**
 * The action named by the FIRST token of the answer: an English action word, or a
 * Japanese synonym at the very start. Later mentions (inside the reason) are ignored,
 * so "待つ。ここで speak すると邪魔" is wait.
 */
export function parseAnswerAction(text: string): AnswerAction | null {
	const head = text.trim().replace(/^[\s`*_>"'「『(（\-–—:：]+/, "");
	const word = /^[A-Za-z]+/.exec(head)?.[0]?.toLowerCase();
	if (word)
		return (answerWords as readonly string[]).includes(word)
			? (word as AnswerAction)
			: null;
	for (const [re, action] of japanese) if (re.test(head)) return action;
	return null;
}

export interface ParsedAnswer {
	readonly item: number;
	readonly raw: string;
	readonly action: AnswerAction | null;
	readonly skipped: boolean;
}

/** Splits a filled sheet into `## 項目 N` sections and reads the text after `回答:`. */
export function parseLabelSheet(text: string): ParsedAnswer[] {
	const out: ParsedAnswer[] = [];
	const sections = text.split(/^## 項目\s+(\d+)\s*$/m);
	for (let i = 1; i < sections.length; i += 2) {
		const item = Number(sections[i]);
		const body = sections[i + 1] ?? "";
		const m = /^回答\s*[:：]([\s\S]*)$/m.exec(body);
		const raw = (m?.[1] ?? "").trim();
		out.push({
			item,
			raw,
			action: parseAnswerAction(raw),
			skipped: /^\s*skip\b/i.test(raw),
		});
	}
	return out;
}

export interface LabelDisagreement {
	readonly item: number;
	readonly caseId: string;
	readonly opportunityId: string;
	readonly answer: string;
	readonly needed: boolean;
	readonly accept: readonly string[];
	readonly note: string;
	readonly neededAgrees: boolean;
	readonly acceptAgrees: boolean;
}

export interface LabelAgreement {
	readonly total: number;
	readonly answered: number;
	readonly neededAgree: number;
	readonly acceptAgree: number;
	readonly disagreements: LabelDisagreement[];
	readonly unanswered: number[];
}

/** Compares answers with the case labels (needed yes/no and accept-set membership). */
export function labelAgreement(
	answers: readonly ParsedAnswer[],
	key: LabelKey,
	cases: readonly Case[],
): LabelAgreement {
	const byId = new Map(cases.map((c) => [c.id, c]));
	const byItem = new Map(answers.map((a) => [a.item, a]));
	let answered = 0;
	let neededAgree = 0;
	let acceptAgree = 0;
	const disagreements: LabelDisagreement[] = [];
	const unanswered: number[] = [];
	for (const k of key.items) {
		const a = byItem.get(k.item);
		const c = byId.get(k.caseId);
		if (!c) throw new Error(`key refers to unknown case ${k.caseId}`);
		const expect = opportunityOf(c, k.opportunityId).expect;
		if (!expect)
			throw new Error(`${k.caseId}/${k.opportunityId} has no expect`);
		if (!a || a.skipped || a.action === null) {
			unanswered.push(k.item);
			continue;
		}
		answered++;
		const userNeeded = a.action === "speak" || a.action === "tool";
		const neededAgrees = userNeeded === expect.needed;
		const acceptAgrees = expect.accept.includes(a.action);
		if (neededAgrees) neededAgree++;
		if (acceptAgrees) acceptAgree++;
		if (!neededAgrees || !acceptAgrees)
			disagreements.push({
				item: k.item,
				caseId: k.caseId,
				opportunityId: k.opportunityId,
				answer: a.raw,
				needed: expect.needed,
				accept: expect.accept,
				note: expect.note,
				neededAgrees,
				acceptAgrees,
			});
	}
	return {
		total: key.items.length,
		answered,
		neededAgree,
		acceptAgree,
		disagreements,
		unanswered,
	};
}

const rate = (n: number, d: number): string =>
	d === 0 ? "-" : `${n}/${d} (${Math.round((100 * n) / d)}%)`;

export function formatLabelAgreement(r: LabelAgreement): string {
	const out = [
		`回答あり: ${r.answered}/${r.total}${r.unanswered.length ? `（未回答・skip: 項目 ${r.unanswered.join(", ")}）` : ""}`,
		`要否の一致（行動が必要か）: ${rate(r.neededAgree, r.answered)}`,
		`accept 集合の一致（回答が期待の accept に含まれる）: ${rate(r.acceptAgree, r.answered)}`,
	];
	if (r.disagreements.length > 0) {
		out.push("", "食い違い（確定は利用者が決める）:");
		for (const d of r.disagreements)
			out.push(
				`- 項目 ${d.item} ${d.caseId}/${d.opportunityId}: 回答=${oneLine(d.answer)} | ラベル: 要=${d.needed} accept=${d.accept.join("|")} （${oneLine(d.note)}）${d.neededAgrees ? "" : " [要否が不一致]"}${d.acceptAgrees ? "" : " [accept 外]"}`,
			);
	}
	return out.join("\n");
}

// ---------------------------------------------------------------- judge sheet

export interface JudgeKeyItem {
	readonly item: number;
	readonly caseId: string;
	readonly condition: string;
	readonly rep: number;
	readonly opportunityId: string;
	readonly verdicts: {
		criterion: string;
		verdict: Judgment["verdict"];
		reason: string;
	}[];
}
export interface JudgeKey {
	readonly kind: "judge";
	readonly run: string;
	readonly seed: string;
	readonly model: string;
	readonly items: JudgeKeyItem[];
}

export interface JudgedAction {
	readonly case: Case;
	readonly record: { caseId: string; condition: string; rep: number };
	readonly opportunity: OpportunityRecord;
	readonly judgments: readonly Judgment[];
}

/** Judged actions: outward actions of the records that have judgments, grouped per action. */
export function judgedActions(
	records: readonly {
		caseId: string;
		condition: string;
		rep: number;
		opportunities: readonly OpportunityRecord[];
	}[],
	cases: readonly Case[],
	judgments: readonly Judgment[],
): JudgedAction[] {
	const byId = new Map(cases.map((c) => [c.id, c]));
	const out: JudgedAction[] = [];
	for (const r of records) {
		const c = byId.get(r.caseId);
		if (!c) continue;
		for (const o of r.opportunities) {
			const mine = judgments.filter(
				(j) =>
					j.caseId === r.caseId &&
					j.condition === r.condition &&
					j.rep === r.rep &&
					j.opportunityId === o.opportunityId,
			);
			if (mine.length > 0)
				out.push({ case: c, record: r, opportunity: o, judgments: mine });
		}
	}
	return out;
}

export function buildJudgeSheet(
	run: string,
	actions: readonly JudgedAction[],
	n: number,
	seed: string = defaultSeed,
): { sheet: string; key: JudgeKey } {
	const items = actions.map((a) => ({
		id: `${a.record.caseId}/${a.record.condition}/${a.record.rep}/${a.opportunity.opportunityId}`,
		// Spread over conditions so no one condition dominates the sample.
		group: a.record.condition,
		action: a,
	}));
	const picks = shuffleBySeed(pickSpread(items, n, seed), seed);
	const lines: string[] = [
		`# 判定器の較正シート（${run}、${picks.length} 件、条件・判定器の判定は伏せてある）`,
		"",
		"各項目の「事実」だけを根拠に、エージェントの行動が各基準を満たすかを判定してください。",
		"",
		"- 「回答 N:」の後ろに `pass` / `fail` / `unclear` のどれかを書く（事実から決められないときは `unclear`）。",
		"- 理由は同じ行の後ろに短く書いてよい。",
		"",
	];
	const keyItems: JudgeKeyItem[] = [];
	let model = "";
	picks.forEach((p, i) => {
		const num = i + 1;
		const a = p.action;
		const opp = opportunityOf(a.case, a.opportunity.opportunityId);
		const criteria = opp.judge;
		model = a.judgments[0]?.model ?? model;
		keyItems.push({
			item: num,
			caseId: a.record.caseId,
			condition: a.record.condition,
			rep: a.record.rep,
			opportunityId: a.opportunity.opportunityId,
			verdicts: criteria.map((criterion) => {
				const j = a.judgments.find((x) => x.criterion === criterion);
				return {
					criterion,
					verdict: j?.verdict ?? "unclear",
					reason: j?.reason ?? "",
				};
			}),
		});
		const action =
			a.opportunity.action === "tool"
				? `ツール使用: ${a.opportunity.toolName ?? "(none)"}${a.opportunity.utterance ? ` / 付随する発話: ${oneLine(a.opportunity.utterance)}` : ""}`
				: `発話: ${oneLine(a.opportunity.utterance ?? "")}`;
		lines.push(
			`## 項目 ${num}`,
			"",
			"事実（この機会より前の観測）:",
			...(factsBefore(a.case, a.opportunity.opportunityId).length
				? factsBefore(a.case, a.opportunity.opportunityId).map(
						(f) => `- ${oneLine(f)}`,
					)
				: ["- （なし）"]),
			"",
			"判定する行動:",
			`- ${action}`,
			"",
			"基準:",
			...criteria.map((c, k) => `${k + 1}. ${c}`),
			"",
			...criteria.map((_, k) => `回答 ${k + 1}:`),
			"",
		);
	});
	return {
		sheet: `${lines.join("\n").trimEnd()}\n`,
		key: { kind: "judge", run, seed, model, items: keyItems },
	};
}

export interface ParsedVerdicts {
	readonly item: number;
	readonly verdicts: Map<number, Judgment["verdict"]>;
}

export function parseJudgeSheet(text: string): ParsedVerdicts[] {
	const out: ParsedVerdicts[] = [];
	const sections = text.split(/^## 項目\s+(\d+)\s*$/m);
	for (let i = 1; i < sections.length; i += 2) {
		const verdicts = new Map<number, Judgment["verdict"]>();
		const body = sections[i + 1] ?? "";
		for (const m of body.matchAll(
			/^回答\s*(\d+)\s*[:：]\s*(pass|fail|unclear)\b/gim,
		))
			verdicts.set(
				Number(m[1]),
				(m[2] ?? "").toLowerCase() as Judgment["verdict"],
			);
		out.push({ item: Number(sections[i]), verdicts });
	}
	return out;
}

export interface JudgeAgreement {
	readonly answered: number;
	readonly agree: number;
	/** Per criterion text: answered and agreeing counts. */
	readonly byCriterion: Map<string, { answered: number; agree: number }>;
	readonly disagreements: {
		item: number;
		caseId: string;
		condition: string;
		criterion: string;
		human: string;
		judge: string;
		judgeReason: string;
	}[];
	readonly unanswered: number;
}

export function judgeAgreement(
	parsed: readonly ParsedVerdicts[],
	key: JudgeKey,
): JudgeAgreement {
	const byItem = new Map(parsed.map((p) => [p.item, p]));
	const byCriterion = new Map<string, { answered: number; agree: number }>();
	const disagreements: JudgeAgreement["disagreements"] = [];
	let answered = 0;
	let agree = 0;
	let unanswered = 0;
	for (const k of key.items) {
		const p = byItem.get(k.item);
		k.verdicts.forEach((v, idx) => {
			const human = p?.verdicts.get(idx + 1);
			if (!human) {
				unanswered++;
				return;
			}
			const slot = byCriterion.get(v.criterion) ?? { answered: 0, agree: 0 };
			slot.answered++;
			answered++;
			if (human === v.verdict) {
				slot.agree++;
				agree++;
			} else
				disagreements.push({
					item: k.item,
					caseId: k.caseId,
					condition: k.condition,
					criterion: v.criterion,
					human,
					judge: v.verdict,
					judgeReason: v.reason,
				});
			byCriterion.set(v.criterion, slot);
		});
	}
	return { answered, agree, byCriterion, disagreements, unanswered };
}

export function formatJudgeAgreement(r: JudgeAgreement): string {
	const out = [
		`回答あり: ${r.answered}${r.unanswered ? `（未回答 ${r.unanswered}）` : ""}`,
		`判定器との一致: ${rate(r.agree, r.answered)}`,
		"",
		"基準ごとの一致（一致が低い基準は判定器に任せず、人の判定だけで扱う）:",
	];
	for (const [criterion, s] of [...r.byCriterion.entries()].sort())
		out.push(`- ${rate(s.agree, s.answered)}  ${criterion}`);
	if (r.disagreements.length > 0) {
		out.push("", "食い違い:");
		for (const d of r.disagreements)
			out.push(
				`- 項目 ${d.item} ${d.caseId}/${d.condition}: 基準「${d.criterion}」 人=${d.human} 判定器=${d.judge}（${oneLine(d.judgeReason)}）`,
			);
	}
	return out.join("\n");
}
