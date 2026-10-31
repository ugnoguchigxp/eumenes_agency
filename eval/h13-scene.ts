/**
 * H13 (P5-a): conversation use of findings. Same user turn, with / without a past
 * investigation (closed intent with a work return, 3 days old).
 *   noInv  = no investigation in state (findings mode on)
 *   invOff = investigation present, today's prompt (closed intents show only state/desiredState)
 *   invOn  = investigation present, findings mode (when looked up + certainty + rule)
 * Answerer: self-port (salt per condition; condition names never in the request).
 * Judge: eval/h13-judge.ts (separate pass, blind A/B).
 */
import { createAgencyRuntime, type AgencyState } from "../src/index.ts";
import { defaultBudget } from "../src/contracts/runtime.ts";
import {
	HOUR,
	fakeLlm,
	intentAddOp,
	obsInput,
	opportunity,
	proposal,
	tools,
} from "../test/core/helpers.ts";
import { writeFileSync, mkdirSync } from "node:fs";
import { createSelfPort, SelfPortPending } from "./self-port/port.ts";

const D = 24 * HOUR;
const NOW = 10 * D;
export const SUMMARY =
	"角換わり腰掛け銀の先手の指し方を3系統に整理: ①4八金・2九飛型で待つ ②6八玉型で早めに仕掛ける ③相手の早繰り銀には腰掛け銀から組み替える。出典は定跡書2冊とプロ棋戦3局。2025年以降の最新形は未確認。";

const baseState = async (withInv: boolean): Promise<AgencyState> => {
	const llm = fakeLlm();
	const rt = createAgencyRuntime({
		systemContext: "experimental",
		condition: "F",
		llm,
		tools: [],
	});
	rt.observe(
		obsInput(
			"u1",
			"user.report",
			"user",
			0,
			"角換わりの腰掛け銀を調べておいて",
		),
	);
	llm.push(
		"update",
		proposal([
			intentAddOp("g", {
				evidenceRefs: ["u1"],
				desiredState: "角換わり腰掛け銀の指し方を調べて整理する",
			}),
		]),
	);
	await rt.runBackground(1, new AbortController().signal);
	const s = structuredClone(rt.snapshot().state) as any;
	if (!withInv) return { ...s, intents: [] };
	const i = s.intents[0];
	s.intents[0] = {
		...i,
		state: "completed",
		evidence: ["u1", "w1"],
		lastReturn: {
			at: NOW - 3 * D,
			workRef: "work:1",
			status: "succeeded",
			summary: SUMMARY,
			question: null,
		},
	};
	return s;
};

export const TURNS = [
	{
		id: "t1",
		related: true,
		text: "週末の将棋大会で角換わりになったらどう指そうかな",
	},
	{
		id: "t2",
		related: true,
		text: "腰掛け銀って結局どう構えるのがいいんだろう",
	},
	{ id: "t3", related: false, text: "今日は仕事で疲れたから早めに寝るよ" },
	{ id: "t4", related: false, text: "ベランダのトマトの葉が黄色くなってきた" },
];
export const CONDS = ["noInv", "invOff", "invOn"] as const;
const SALT: Record<string, string> = { noInv: "m3", invOff: "p8", invOn: "z5" };

export async function runH13(dir: string) {
	const port = createSelfPort(dir);
	const out: any[] = [];
	let pending = 0;
	for (const c of CONDS) {
		for (const t of TURNS) {
			port.setSalt(`h13:${SALT[c]}:${t.id}`);
			const rt = createAgencyRuntime({
				systemContext: "experimental",
				condition: "F",
				llm: port,
				tools,
				budget: { ...defaultBudget, minIntervalMs: 0 },
				restore: { state: await baseState(c !== "noInv") },
				...(c === "invOff" ? {} : { findings: true }),
			} as never);
			rt.observe(obsInput("u9", "user.report", "user", NOW, t.text));
			try {
				const d = await rt.decide(
					{ ...opportunity("op9", NOW + 2), trigger: "turn_end" } as never,
					new AbortController().signal,
				);
				const tk = d.decision.ticket;
				let deliveredTts: boolean | null = null;
				if (tk) {
					rt.recordResult({
						ticketId: tk.id,
						status: "succeeded",
						at: NOW + 3,
						resultText: tk.utterance ?? "",
					});
					const o = rt
						.snapshot()
						.observations.filter((x: any) => x.kind === "delivery.observed")
						.at(-1) as any;
					deliveredTts = o?.tts ?? null;
				}
				out.push({
					cond: c,
					turn: t.id,
					related: t.related,
					action: d.decision.action ?? (d.decision as any).kind,
					why: JSON.stringify(d.decision).slice(0, 400),
					utterance: tk?.utterance ?? null,
					ticketTts: tk ? tk.tts : null,
					deliveredTts,
				});
				if (port.pending() > 0) pending++;
				port.reset();
			} catch (e) {
				if (e instanceof SelfPortPending || String(e).includes("pending"))
					pending++;
				else throw e;
			}
		}
	}
	return { out, pending };
}

if (import.meta.main) {
	const dir = process.argv[2] ?? "eval/results/p5a-h13";
	mkdirSync(dir, { recursive: true });
	const r = await runH13(dir);
	writeFileSync(`${dir}/runs.json`, JSON.stringify(r, null, 2));
	console.log(JSON.stringify(r, null, 1));
}
