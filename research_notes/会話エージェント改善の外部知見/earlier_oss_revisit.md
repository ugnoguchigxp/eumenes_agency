# Earlier OSS survey revisit (LocalAIVtuber2, Anima, AICO, Shikigami Protocol, ThoughtField) — 2026-10-24

Scope: re-read `spec/oss-reference-2026-10-22.md` against the features added since (lull talk with host topics, work-report TODOs, errands, utterance emotion), and check the repositories online. Ideas only: LocalAIVtuber2 has no license, Shikigami is AGPL-3.0 — no code reuse. No repo file was edited.

## Q1. Which "not adopted / later" mechanisms now make sense given the new features?

### Takeaway
Most of the survey's items are already in place (X1 unanswered cap = 1, S1 heard-part receipts in the host contract, S9 reason codes). The new features open three concrete gaps the survey did not foresee: (a) what an **interrupted** TODO report / errand reminder / lull topic means (the core only counts `succeeded`), (b) a **persistent "don't raise this topic"** signal back to the host (AICO-style block), and (c) X2 lessons should follow AICO's documented safeguards (observe-only default, min sample, status lifecycle, rollback). The rejected items (urgency-proportional cooldown, weighted scoring, energy/affinity, emotion-justified speech) should stay rejected; emotion-design reinforces that.

### Cited Findings
External:
- AICO's goal arbiter scores goals by a weighted sum and its origin weight "prefers user-origin and safety/maintenance over curiosity/agent_self by default"; `IntentionSet.max_active` defaults to 3; pin/block controls are described ("a blocked goal is never activated") but the explicit fields/API are WIP. No cooldown or interruption handling is described — [AICO Goal Arbiter doc](https://boeni-industries.github.io/aico/concepts/agency/agency-component-goal-arbiter-meta-control/)
- AICO self-reflection: lessons have status `active | superseded | rejected`; `observe_only` is described as "(default, safest)" and "does not change any PolicyRule rows"; `allow_amend` is config-gated; thresholds `min_sample_size: 10`, `confidence_threshold: 0.7`; amendments must be "fully logged, auditable, and reversible" with a provenance chain run → lesson → change; the doc does not say how to tell whether an applied lesson improved outcomes — [AICO Self-Reflection doc](https://boeni-industries.github.io/aico/concepts/agency/agency-component-self-reflection/). Note: this contradicts the local survey, which found the shipped config at `policy_mode: "allow_amend"` (`spec/oss-reference-2026-10-22.md:21`). Docs say observe_only is default; distributed config (as read at `aad0a88`) says allow_amend.
- Shikigami: proactive outreach "driven by internal state — not a fixed timer"; energy system ("Social Burnout ... conversations drain energy"); 8 relationship tiers; "Emotion-aware TTS ... Voice instruct and pitch adapt to current mood state"; Persona Evolution with an immutable "core anchor", original kept read-only, "per-run changelog ... and one-click rollback"; `/todo` and `/timer` "Natural Reminders" in chat flow; `reflection.enabled` and `ase.enabled` default `false` — [Shikigami README](https://github.com/Shikigami-Lab/Shikigami-Protocol)
- Newer reference for interruption handling: Pipecat commits only the spoken-so-far text as the assistant message on interruption ("Text that never played never reaches the assistant aggregator"), and offers `MinWordsUserTurnStartStrategy(min_words=3)` so short utterances don't interrupt, plus model-based filtering of backchannels ("uh-huh") — [Pipecat interruptions](https://docs.pipecat.ai/pipecat/fundamentals/interruptions)
- Pydantic AI realtime records cutoffs as `SpeechPart.interrupted_at_ms`; "Any reply generated after it, which the user never heard, is truncated at 0"; stored history is never edited, an interruption note is added when sent to a text model; with `handle_barge_in=True` "the session does nothing when the previous reply was heard in full"; warns that stopping the model isn't enough because audio is generated ahead of playback — [Pydantic AI realtime turns](https://pydantic.dev/docs/ai/realtime/turns/)

Internal (current agency state):
- X1 is implemented: `defaultMaxUnanswered = 1`, idle blocks with `"unanswered"` until the user speaks (`src/application/idle.ts:10,47,55-60,70-74`); silent cycles back off by doubling and give up after `maxRetries` (default 2) (`src/application/idle.ts:33,51,76-80`). So Anima's idle backoff, listed as "not adopted" (`spec/oss-reference-2026-10-22.md:61`), is in fact now present in a form.
- Lull-talk select rule (c) already waits after a proactive utterance answered only by a non-extending one-liner (`src/application/prompts.ts:165`), i.e. a semantic version of the unanswered cap.
- Topic/interest "last used" is recorded only on a `succeeded` receipt (`src/application/runtime.ts:586-587`); emotion is kept only for `succeeded` (`runtime.ts:580-581`). Interrupted utterances still appear in "delivered" with an `[interrupted] ` prefix and `resultText` if the host supplies it (`src/domains/agency/results.ts:59-66`, `runtime.ts:136-141`).
- TODO/errand reported state: host archives / marks `reminded` only when the delivery receipt is `succeeded` (`spec/todo-design.md:48`, `spec/errand-design.md:32,56`). The select rules say errands are mentioned "一度だけ" and reports are not repeated (`src/application/prompts.ts:177-186`), but no rule covers a report or reminder that was cut off.
- Host contract already plans S1: voice-stage interrupted receipt carries only the played sentences (`spec/eumenes-integration-spike.md:52`), and `heard: "full"|"partial"` in the main-context layer (`spec/eumenes-integration-spike.md:94`). No eval case in `eval/cases` contains an interrupted receipt (grep for "interrupted" returns 0 files).
- Refused topics are handled per opportunity by rule (b) (`src/application/prompts.ts:165`) and the social spec (`spec/social-lull-experiment.md:29`); last-use is RAM only (`spec/social-lull-experiment.md:69`). There is no path for the agency to tell the host "the user declined this `memory:<id>`" (only `reportedTodoIds` exists for TODOs, `spec/todo-design.md:107`).
- Emotion is an utterance attribute with no state (`spec/emotion-design.md:8,15`); voice style switching by emotion is deferred (`spec/emotion-design.md:88`).

### Inferences (adoptable ideas, new vs covered)
New:
1. **Interrupted work report / errand reminder (from LocalAIVtuber2 S1 + Pipecat/Pydantic).** Decide and test what happens when the report "楽曲できたよ。すぐ再生する？" is cut off. Today the TODO stays `done` (not archived) and the delivered list shows `[interrupted] <heard part>`; the LLM may then repeat it, or suppress it under "同じ内容をすでに伝えている" (`prompts.ts:123`). Suggest: one select sentence — "if the delivered utterance is `[interrupted]` and the item is still listed, the user did not hear it in full; report it again once at the next fitting moment, briefly; if the heard part already covered the result, offer only the next action." Plus 2–4 social cases (interrupted report → idle → re-report once; interrupted errand reminder inside window). Also: an interruption where nothing was played (Pydantic's "truncated at 0") should count as not delivered at all.
2. **Interrupted lull talk as a signal.** Topics cut off are not marked used (`runtime.ts:586`), so the same topic may come back next lull. If the user barged in to talk, that's fine; if the user barged in to stop it, it should count as used or as declined. Minimal change: mark topic refs used on `interrupted` too (ticket's evidence), keep `succeeded`-only for TODO archive. Eval case: interrupted topic → next idle should pick a different topic.
3. **Persistent topic block (AICO pin/block).** Add a helper like `declinedTopicRefs` (or emit in Decision/trace) so Eumenes can mark a `memory:<id>` "don't raise proactively" after the user says "その話はいいや". Current behaviour only waits within the conversation. Must keep the "don't pick up user's stated errands" rule intact.
4. **X2 lesson guardrails (AICO).** When P1-E step 5 runs, mirror the documented design: observe-only first (lesson shown as reference, not applied), minimum sample before a lesson is proposed, lesson status `active/superseded/rejected`, provenance (run → lesson → rule text), one-step rollback. Also add what AICO lacks: an A/B check that the applied lesson improved the eval metric (AICO doc has none).
5. **Shikigami "core anchor" analogue for persona/interests.** If standing interests or utterance style are ever auto-updated from memory, keep a read-only original + immutable anchor statements + changelog/rollback. Not needed now (interests are fixed per host).
6. **S2 refinement (Pipecat/Pydantic).** Invalidate on VAD speech start only when an agency utterance is in flight or pending; for a fully played utterance do nothing; consider a min-words or backchannel filter before treating speech as barge-in (`spec/eumenes-integration-spike.md:122` already plans to log false invalidations).

Covered (no action): X1 cap (idle.ts), elapsed-time-based topic rotation (`spec/social-lull-experiment.md:69`) which plays the cooldown role without urgency, user-origin priority (TODO/errand before lull topics, `prompts.ts:180,186`) matching AICO's origin preference qualitatively, S3/S4/S5 in the host spike plan (`spec/eumenes-integration-spike.md:52,92`).

Still reject: urgency-proportional cooldown and weighted scores (LLM self-rating as speech basis, `spec/oss-reference-2026-10-22.md:60`); Shikigami energy/affinity tiers and "check-ins/teasing ... you're late tonight" outreach — they conflict with emotion-design's "don't speak because of feelings" (`spec/emotion-design.md:18,58`) and the errand rule that only registered TODOs are raised (`spec/errand-design.md:7`). Shikigami's mood-driven TTS pitch is the same idea as emotion-design §8, but agency keeps it per-utterance, not as persistent mood.

### Gaps
- Whether the current LLM rule set repeats or suppresses an interrupted report is untested (no eval case); the above is inference from code.
- Whether `proactiveSpoke` is called for interrupted utterances (affects X1 counting) was not traced in the host code.

## Q2. Notable changes in the repositories since 2026-10-22, and newer related projects

### Takeaway
None of the five surveyed repos has changed since the commits the survey read. AICO moved off GitHub (archived 2026-06-29, now on Gitoro, unreadable by fetch). Anima's repository could not be re-located online. The useful new references are framework docs (Pipecat, Pydantic AI realtime) on interruption/partial playback.

### Cited Findings
- LocalAIVtuber2 (`0Xiaohei0/LocalAIVtuber2`): latest commit `0e9cc92` 2026-02-14 "Update README with system requirements and known issues" — the same commit the survey read; no license; ~246 stars — [GitHub](https://github.com/0Xiaohei0/LocalAIVtuber2) (checked via `gh api`, 2026-10-24)
- Shikigami Protocol (`Shikigami-Lab/Shikigami-Protocol`): latest commit `103ab45` 2026-08-27 "docs(readme): neutralize companion-app framing" — same as surveyed; AGPL-3.0 — [GitHub](https://github.com/Shikigami-Lab/Shikigami-Protocol)
- AICO (`boeni-industries/aico`): archived; develop head `aad0a88` 2026-06-29 "Update README to indicate repository archiving" (same as surveyed); README: "AICO is now hosted on Gitoro ... https://gitoro.com/boeni-industries/aico", same license (MIT per GitHub) — [GitHub](https://github.com/boeni-industries/aico). The Gitoro page returned only a title on fetch, so post-move activity is unknown — [Gitoro](https://gitoro.com/boeni-industries/aico). Docs remain at [boeni-industries.github.io/aico](https://boeni-industries.github.io/aico/welcome/), which list proactive engagement / conversation starters / idle background learning as *planned*.
- ThoughtField (`spati10/ThoughtField`): latest commit `d6d9e73` 2026-05-26 "Use Python 3.11" — same as surveyed; no license file reported by GitHub — [GitHub](https://github.com/spati10/ThoughtField)
- Anima: `darxkies/anima` (LGPL-2.1, "persistent AI character that reads world news ... evolves an emotional state") is **not** the surveyed repo — commit `ba215ce` does not exist there and the survey records MIT — [GitHub darxkies/anima](https://github.com/darxkies/anima). Other "Anima" hits (AnimaWorks, Apache-2.0) are different projects — [AnimaWorks on PyPI](https://pypi.org/project/animaworks/0.10.0/).
- Newer/related: [Pipecat interruptions](https://docs.pipecat.ai/pipecat/fundamentals/interruptions) and [Pydantic AI realtime turns](https://pydantic.dev/docs/ai/realtime/turns/) (details in Q1).

### Inferences
- No new upstream mechanism to import; the survey's reading is still current for four of five repos.
- Pipecat/Pydantic give a well-specified model for S1/S2 that the host spike can follow (spoken-text-only commit; cutoff offset; ignore barge-in when the reply was fully heard).

### Gaps
- Anima's original URL is not recorded in the repo (`spec/oss-reference-2026-10-22.md:8` has commit and license only); could not verify its current state.
- AICO's Gitoro repository contents/activity not readable.

## Q3. Risks identified by the survey that the agency still has

### Takeaway
The noise-triggered invalidation risk (S2) and the "abort marked complete without confirming stop" risk (S3/S4) are designed for in the host spike but not yet verified on a real voice path; the partial-playback risk (S1) is now larger because TODO/errand/topic bookkeeping depends on `succeeded` only.

### Cited Findings
- Survey risks: LocalAIVtuber2 interrupts on a single VAD frame ≥0.3 (noise stops speech); abort marks completion synchronously; partial playback is not recorded (full text goes into history) (`spec/oss-reference-2026-10-22.md:16-19`).
- Agency status: S2 is open — spike starts with `onSpeech` (safe side) and will log false invalidations (`spec/eumenes-integration-spike.md:122`); real-device barge-in and VAD noise checks are listed as untested beyond fixtures (`spec/eumenes-integration-spike.md:128`).
- S3/S4 designed: one terminal receipt per ticket, 60 s no-report → `outcome_unknown` (`spec/eumenes-integration-spike.md:52`); late success after interrupted/unknown is allowed (`src/application/runtime.ts:588-590`, `src/domains/agency/results.ts:48-49`).
- Pydantic warns stopping the model is not enough since audio is generated ahead of playback — supports keeping stop confirmation at the player (receipt), not at abort — [Pydantic AI realtime turns](https://pydantic.dev/docs/ai/realtime/turns/)

### Inferences
- Late success after `interrupted` (`results.ts:48-49`) could, with a host bug, flip an interrupted report to `succeeded` and archive a TODO the user didn't hear; worth an S3-style unit test specific to TODO archive.
- Shikigami's design risk (urgency built from inner monologue → outreach) is avoided by policy; no residual risk found.

### Gaps
- No real-device data yet on false invalidation rate or partial-playback accuracy (by design pending in the spike).
