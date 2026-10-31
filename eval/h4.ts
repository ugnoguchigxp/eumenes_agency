/**
 * H4 harness (plan P2-b): interest formation, F vs I (= F + interestFormation).
 * Self-inference only: SELF_PORT_DIR must be set (no model API).
 *   bun eval/h4.ts run --split dev|unseen|all --out eval/results/h4-<name>
 *   bun eval/h4.ts score --out eval/results/h4-<name>
 * Answers are written blind to labels (the answerer sees only prompts); the same
 * agent also authored cases and judges → disclosed limitation.
 */
import {
	mkdirSync,
	readdirSync,
	readFileSync,
	writeFileSync,
	existsSync,
} from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { createAgencyRuntime } from "../src/index.ts";
import { createSelfPort } from "./self-port/port.ts";
import { independentRefs } from "../src/domains/agency/settle-interests.ts";

type Step =
	| { actor: "user" | "agent" | "tool"; text: string; causationId?: string }
	| { batch: true };
type H4Case = {
	id: string;
	split: "dev" | "unseen";
	kind: "interest" | "oneoff" | "echo";
	steps: Step[];
	expect: { topics: string[][]; interestShown: boolean };
};
const CONDS = ["F", "I"] as const;
const casesDir = join(import.meta.dir, "cases/h4");

export function loadH4(split: string): H4Case[] {
	return readdirSync(casesDir)
		.filter((f) => f.endsWith(".json"))
		.sort()
		.map((f) => JSON.parse(readFileSync(join(casesDir, f), "utf8")) as H4Case)
		.filter((c) => split === "all" || c.split === split);
}

async function runOne(c: H4Case, cond: (typeof CONDS)[number], dir: string) {
	const port = createSelfPort(dir);
	port.setSalt(`h4:${c.id}:${cond}`);
	const rt = createAgencyRuntime({
		systemContext: "experimental",
		condition: "F",
		llm: port,
		tools: [],
		...(cond === "I" ? { interestFormation: true } : {}),
	} as never);
	let now = 1_700_000_000_000;
	const codes: string[] = [];
	let n = 0;
	const flush = async () => {
		const out = await rt.runBackground(now, new AbortController().signal);
		for (const o of out) codes.push(o.code, ...o.rejectCodes);
	};
	for (const s of c.steps) {
		if ("batch" in s) {
			await flush();
			continue;
		}
		now += 60_000;
		rt.observe({
			id: `o${++n}`,
			kind: s.actor === "tool" ? "tool.result" : "exchange.adopted",
			actor: s.actor,
			occurredAt: now,
			text: s.text,
			...(s.causationId ? { causationId: s.causationId } : {}),
		} as never);
	}
	await flush();
	return { case: c.id, cond, codes, snap: rt.snapshot() };
}

const match = (topic: string, alts: string[]) =>
	alts.some((k) => topic.includes(k));

export function scoreRecords(
	cases: H4Case[],
	recs: ReturnType<typeof JSON.parse>[],
) {
	const by = new Map(cases.map((c) => [c.id, c]));
	const out: Record<string, Record<string, number>> = {};
	for (const cond of CONDS) {
		let tp = 0,
			fp = 0,
			fn = 0,
			shown = 0,
			shownDI = 0,
			quiet = 0,
			quietDI = 0,
			m9 = 0,
			m3 = 0,
			pending = 0,
			ints = 0;
		for (const r of recs.filter((x) => x.cond === cond)) {
			const c = by.get(r.case);
			if (!c) continue;
			if (
				r.codes.some(
					(x: string) => x.startsWith("error:") || x.startsWith("llm_call"),
				)
			)
				pending++;
			const st = r.snap.state;
			const obs = new Map(
				r.snap.observations.map(
					(o: { id: string; actor: string; causationId?: string }) => [
						o.id,
						{ actor: o.actor, causationId: o.causationId ?? null },
					],
				),
			);
			const live = (st.interests ?? []).filter(
				(i: { status: string }) => i.status !== "faded",
			);
			ints += live.length;
			m3 += live.filter(
				(i: { derivedFrom: string | null }) => i.derivedFrom,
			).length;
			for (const alts of c.expect.topics)
				if (live.some((i: { topic: string }) => match(i.topic, alts))) tp++;
				else fn++;
			fp += live.filter(
				(i: { topic: string }) =>
					!c.expect.topics.some((a) => match(i.topic, a)),
			).length;
			for (const i of live as { status: string; evidence: string[] }[])
				if (
					i.status === "active" &&
					independentRefs(i.evidence, [], obs as never).length < 2
				)
					m9++;
			for (const b of st.beliefs as {
				confidence: string;
				evidence: string[];
			}[])
				if (
					b.confidence === "high" &&
					independentRefs(b.evidence, [], obs as never).length === 0
				)
					m9++;
			const di = st.desires.length + st.intents.length > 0 ? 1 : 0;
			if (c.expect.interestShown) {
				shown++;
				shownDI += di;
			} else {
				quiet++;
				quietDI += di;
			}
		}
		out[cond] = {
			interests: ints,
			tp,
			fp,
			fn,
			precision: tp + fp ? tp / (tp + fp) : 0,
			recall: tp + fn ? tp / (tp + fn) : 0,
			m2_shownDI: shown ? shownDI / shown : 0,
			quietDI: quiet ? quietDI / quiet : 0,
			m3_derived: m3,
			m9,
			pending,
		};
	}
	return out;
}

if (import.meta.main) {
	const { values, positionals } = parseArgs({
		args: Bun.argv.slice(2),
		allowPositionals: true,
		options: {
			split: { type: "string", default: "all" },
			out: { type: "string" },
		},
	});
	const out = values.out!;
	const cases = loadH4(values.split!);
	if (positionals[0] === "run") {
		const dir = process.env.SELF_PORT_DIR;
		if (!dir) throw new Error("SELF_PORT_DIR required (self-inference only)");
		mkdirSync(out, { recursive: true });
		const recs = [];
		for (const c of cases)
			for (const cond of CONDS) recs.push(await runOne(c, cond, dir));
		writeFileSync(
			join(out, `records-${values.split}.json`),
			JSON.stringify(recs),
		);
		console.log(JSON.stringify(scoreRecords(cases, recs), null, 1));
	} else {
		const f = join(out, `records-${values.split}.json`);
		if (!existsSync(f)) throw new Error(`no ${f}`);
		console.log(
			JSON.stringify(
				scoreRecords(cases, JSON.parse(readFileSync(f, "utf8"))),
				null,
				1,
			),
		);
	}
}
