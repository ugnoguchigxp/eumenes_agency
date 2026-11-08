# Eumenes への依頼：always-on の取り込み

**宛先: Eumenes のコーディングエージェント。** 本書は、そのまま渡して実装してもらう依頼文である。eumenes_agency（このリポジトリ）で実装・検証した always-on を、Eumenes のAgencyホスト（`api/application/agency/`）へ取り込む。eumenes_agency の作業では Eumenes のコードを変更しない。本書は、Eumenes の現行コード（2026-11-07 時点、`createAgencyRuntime` の F 方式、`docs/memory.md` の steward）を読んで書いた。背景は[設計書](../spec/always-on-agency-design-2026-11-07.md)、検証の結果は[進捗](always-on-progress-2026-11-07.md)にある。

## 0. 依頼の要点

- **目的**: 背景の判断を always-on に置き換え、Eumenes が「利用者が話すまで待つだけ」でなく、常に考え、頼まれていなくても準備し、良い間合いで自分から話すようにする。
- **やること**: 5節の手順1〜7。各手順の終わりに、その手順の確認を行う。
- **決めてあること**: 0.1節。ここは変えずに実装する。合わない点が見つかったら、実装で回避せず報告する。
- **守ること**:
  - 通常応答の経路、Memory と steward、ツールチェーンの実行、発話の配送、checkpoint、忘却の journal は、既存のものを使う。
  - 同じ会話で旧runtimeと always-on を同時に動かさない。
  - 設定で旧runtimeへ戻せるようにする。
  - always-on の思考と準備に、呼び出し・費用の上限を入れない。

## 0.1 決めてあること

1. **推論は並列にする。** always-on の思考（purpose `think`）と準備の実行は、会話・steward・専門担当と別の接続で並列に動かす。
   - ローカル推論（LARM）の1枠を取り合わない。
   - steward の直列化（`concurrencyKey`、`larm_preempted` による取り消し、保守の待ち）を always-on に当てはめない。
   - 利用者の呼び出しが始まっても、思考を取り消さない。
   - 入力中・返事の生成中・読み上げ中に tick しない規則（`busy`）は残す。これは推論の資源のためではなく、利用者に話しかぶせないため。
   - 新しい利用者の発言で古い思考の行動が拒否される仕組み（stale）は、always-on 側にある。
2. **利用者についての事実の正本は steward の記憶。**
   - steward の State を `known` で渡す（`memory:<id>` で引用される）。always-on はそれを話題選びや準備に使うが、書き換えない。
   - always-on の user model は、知りたいこと（gap）、仮説、準備の材料、考えといった、自分から動くための作業メモとして使う。
   - 現状の always-on は、`known` があっても、利用者の発言から事実（stated / observed）を自分でも記録する。そのため steward と二重に持つことになる。これをやめる変更は、eumenes_agency 側で行う予定で、まだ実装していない（4節の7）。
3. **メモリー整理は steward のまま。**
   - always-on に記憶の統合・停止・訂正をさせない。待ちの時間をその仕事で埋めることもしない。
   - 理由: 整理は新しいことがあったときだけ走るべきもので、steward はすでにそう動いている。また always-on が自分から使ってよいのは、読み取りと新規作成だけである。

## 1. 何を置き換えるか

Eumenes の現行の背景処理は、会話ごとの `createAgencyRuntime`（F 方式）、idle planner、1分ごとの review、`wake`、`find_toolchain`→`delegate` の2段の委譲で動いている。always-on はこのうち**背景の判断の部分**を置き換える。

- 置き換えるもの: `runtime.decide` / `runtime.wake` / `runBackground` と idle planner・review timer による起動。
- そのまま使うもの: 通常応答の経路、Memory、ツールチェーンの実行（受付・照会・取消・結果の確定）、発話の配送（`SpeechRouter`、`recordSpokeInTransaction`）、単一writerのcheckpoint、忘却のjournal。

同じ会話で旧runtimeと always-on を同時に動かさない。どちらも自分から話すため、二重に発話する。

## 2. 対応表

| Eumenes の現行 | always-on | 注意 |
| --- | --- | --- |
| `Conv.runtime = createAgencyRuntime(...)`（`runtime.ts`） | `createAlwaysOnAgent(deps)`（会話scopeごと） | `condition`、`planOnOpportunity`、`hostTopics`、`findings`などのフラグは不要 |
| `agencyBackgroundSystem()`（`system-context.ts`、TOMLの指示資産） | `system: () => ({ value: alwaysOnSystem({ persona }), input })` | 人格（`persona`）だけ差し替え、データの意味（`frame`）と安全（`safety`）は残す。全文を自前で書く場合は `alwaysOnOutputContract.description` を含める |
| idle planner・`createIdleScheduler`・review timer（1分）・`wake` | `createHeartbeat` + `createHeartbeatScheduler` | 何か起きたら10秒後、何もなければ2倍ずつ伸ばし上限10分。`event()` は利用者の発言、返事の終了、結果の返却で呼ぶ。`enter()`/`leave()` は入力中・返事の生成中・読み上げ中 |
| `foregroundBusy`、`conversationBusy`、`playerBusy` | `tick(now, () => ({ busy }), signal)` の `busy` | `busy` は呼び出しの直前と、行動を確定する直前の2回読まれる |
| `idleSec` / `maxUnanswered` の設定 | `speechIntervalSec`（10 / 60 / 600） | 返事のない発話は間隔が2倍ずつ伸び、10分を超えると利用者が話すまで保留になる。考えることは止まらない |
| feed の `runtime.observe(input, context)` | `agent.observe({ id, kind, actor, occurredAt, text })` | **観測ごとの `InputContext` を受け取らない**（4節の1）。観測のIDがそのまま忘却の参照になる |
| `topics`（Memory の State 項目、`topics.ts`） | `known: () => [{ id, text, input }]` | 参照のみで、`memory:<id>` で引用される。忘却は `agent.forget(["memory:<id>"])`。渡さなければ、指示文にも入力にも何も加わらない |
| `standingInterests`（設定の関心） | `interests: [{ id, text, input }]` | エージェント自身の好き。利用者の好みとは区別する |
| `researchTools()` の `find_toolchain` / `delegate` | `tools: AlwaysOnTool[]`（`effect` 付き） | 3節 |
| `delivery.ts` の speak の配送 | `ticket.action` が `speak` / `ask` のとき配送し、`agent.recordResult({ ticketId, status, at })` | 届いた発話だけが観測になり、返事のない回数に数えられる |
| `delivery.ts` の tool の受付 | `ticket.action === "prepare"` を実行先へ渡し、受付は `recordResult(succeeded)`、拒否は `recordResult(failed)` | 結果不明・中断は失敗扱いにしない。6時間で失効する |
| `returns.ts` の `work.returned` と `recordResult` | `agent.workReturned({ ticketId, at, status, summary })` | 結果の本文は、コードが「調べた結果（finding）」として材料にする。モデルには書かせない |
| `hostTodos`（頼まれた仕事の完了報告、`work.ts`） | **対応する仕組みがない**（4節の2） | |
| `utteranceEmotion`（読み上げの気持ち） | **出力がない**（4節の3） | |
| `snapshot()` を AgencyStatePort に保存 | `agent.snapshot()`（`AlwaysOnSnapshot` version 1）とheartbeatの`checkpoint()` | 旧runtimeとは形が違うので、保存の列か種類を分ける。発行済みで未配送の発話票は保存されない |
| `prepareForgetting` と Memory の forget journal | `agent.forget(refs)` | 観測ID、`memory:<id>`、ホスト入力の出所（`sources`）のどれでもよい。派生物は不動点まで連鎖して消える |
| `createAgencyLlmPort`（purpose ごとの system 要求・出力上限・期限） | purpose が `"think"` の呼び出しが1種類だけ | Eumenes の LlmPort は purpose ごとに system を要求している（`llm-port.ts:99`）ので、`think` を受け付けるようにする。接続は会話・stewardと別にし、並列に動かす（0.1節の1） |
| 活動予算・呼び出し予算 | always-on 側では適用しない（設計の決定） | Eumenes の利用制限は、ホストが票を拒否する形で効かせる（3節） |

## 2.1 通常応答も always-on の声にする（利用者の試用で判明、2026-11-07）

利用者のCLI試用で、通常応答が旧来の汎用指示のままだった。そのため「ツールは見えていない」「確かめられない」と答え、背景で準備が進んでいるのに、それを知らないまま返事をしていた（口と頭が別々の状態）。このリポジトリのCLIでは、次のように直した（`standalone/always-on-host.ts`）。Eumenes でも、通常応答の指示とデータに同じことを入れる。

- 通常応答の指示: 自分は常に考えて自分から動くエージェントであること、使える準備の能力、頼まれたらその場で準備を始めること、「見えていない」で終わらせないこと、質問や選択肢で締めくくらないこと（`alwaysOnReplySystem`）。
- 通常応答の参照資料に、エージェントの今の状態を渡す: 現在時刻、利用者について知っていること、準備中のこと（利用者が頼んだものか）、準備できた結果、直前の考え。
- 通常応答のツール `start_preparation`: 利用者に頼まれたら、返事の中で `agent.requestPrepare(...)` を呼び、返った票をいつもの準備と同じく実行する（`createReplyTools`）。結果は、背景の思考が自分から伝える。
- 記憶をセッションをまたいで残す: CLIは終了時と出来事のたびに `agent.snapshot()` を保存し、次の起動で戻す。Eumenes では既存のcheckpointに載せる（2節の対応表）。

## 3. 準備（prepare）とツールチェーンのつなぎ方

always-on の準備は、**ツール単位の1段**で選ぶ（`toolName` と `toolInput`）。コードが自発で許すのは `effect` が `read` か `create` で、`requiresApproval: false` のツールだけ。Eumenes の現行は「担当を探す（`find_toolchain`）→ 委譲する（`delegate`）」の2段で、許可は担当（capability）ごとに決まる。つなぎ方は2通りある。

**A. 担当をツールとして直接見せる（推奨の初手）**

読み取りの調査、画像の生成、音楽の生成など、自発で使ってよい担当を少数選ぶ。それぞれを `AlwaysOnTool` にして、`effect`・説明・`input: { sources: ["capability:<revisionId>"], complete: true }` を付ける。1回の思考で準備を始められるので、遅延が短い。カタログの全件は載せない。

**B. 探す段も準備として扱う**

`find_toolchain` を `effect: "read"` の準備ツールにする。返ったカード一覧が材料になり、次の思考で `delegate` を準備ツールとして選ぶ。`delegate` の `effect` は対象の担当で変わるので、**ホストが受付時に対象のcapabilityの副作用を確かめ**、`read`・`create` でなければ `recordResult(failed)` で拒否する。2回の思考が要る。

どちらでも、Eumenes の既存の制限（同時1件、日次3件、12時間の冷却、能力ごとの呼出上限）は、ホストが受付時に拒否する形で効かせる。拒否されると、エージェントには「準備を始められなかった」という観測が入る。既存物の変更・送信・支払い・削除は `effect` を `modify` / `external` にし、自発では使わせない。

## 4. 未解決の点と提案

1. **観測ごとの入力の出所**: `observe` は `InputContext` を受け取らない。観測IDを Memory の記録IDと1対1にすれば、忘却はそのまま効く。1つの観測が複数の記録から作られる場合は、`observe` に `input` を足す必要がある（このリポジトリで小さく足せる）。
2. **頼まれた仕事の完了報告**: 旧runtimeの `hostTodos` にあたるものがない。提案: 頼まれた仕事の完了や質問を、ホストの観測（`actor: "host"`、`kind: "external.event"`、IDは仕事のID）として `observe` する。エージェントは観測を根拠に話せる。報告済みかどうかの照合（`reportedTodos`）はホスト側で行う。
3. **読み上げの気持ち**: always-on の出力に気持ちの絵文字がない。取り込みの初期は `none` で配送する。必要なら think の出力に `emotion` を足し、指示文と実モデルで検証する（指示文の変更は能動性の検証を伴う。指示文を短くした版で能動性が落ちた例がある）。
4. **複数の会話**: 現行の `activeId`（表示中・最後に話した会話）に合わせ、heartbeat は表示中の会話だけで回すのが簡単。表示していない会話は、準備だけ続けるか止めるかを決める必要がある。
5. **prompt cache**: このリポジトリでは `standalone/claude.ts` で思考の指示文に1時間のcacheを付けた。Eumenes は自前の呼び出し経路を使うので、同じことを Eumenes 側で行う。入力の約7割がcacheから読まれ、費用は56%減った（[進捗](always-on-progress-2026-11-07.md)の「入力の縮小とprompt cache」）。
6. **再起動**: 発行済みで未配送の発話票は保存されない。再起動後に古い発話を届けない、という意味では安全側。準備中のものは保存され、結果が返れば受け付ける。
7. **事実の二重記録**（eumenes_agency 側の課題）: 0.1節の2のとおり、`known` を渡したときに always-on が自分で事実を記録しない変更が要る。この変更が入るまでは、always-on の facts と steward の記憶が並ぶ。どちらも同じ発言から作られるので、通常は食い違わない。ただし、入力が増える。

## 5. 手順

1. このリポジトリで `bun run pack` を実行し、配布物を Eumenes の `vendor/agency/` に置いて依存を更新する。always-on の名前は pack の検査で必須にしてある（`scripts/pack.ts` の `requiredExports`）。
2. Eumenes の LlmPort に purpose `think` を足す。system の差し替えと prompt cache もここで行う。接続は会話・stewardと別にし、利用者の呼び出しと並列に動くことを確かめる（0.1節の1）。
3. 会話ごとに `createAlwaysOnAgent` と heartbeat を作る。feed の観測、返事、配送の結果、返った仕事を、2節の対応表どおりにつなぐ。
4. 準備は3節のAから始める。読み取り調査1つと独立成果物の生成1つ程度に絞る。
5. checkpoint に `AlwaysOnSnapshot` を保存し、再起動のあと `restore` で戻す。
6. 忘却の journal から `agent.forget` を呼ぶ。
7. 旧runtimeの背景処理を止める。設定で切り替えられるようにしておく。

## 6. 受入

- **固定試験**: このリポジトリの `test/always-on/scenarios.test.ts`（S1〜S10）は、組み込みの指示文とホスト所有の指示文の両方で通る。Eumenes 側でも、同じシナリオを scripted LLM で再現する。Eumenes の配線（配送・受付・返却・忘却・再起動）を通したときに同じ結果になることを確かめる。
- **実モデル**: このリポジトリの `bun run eval:always-on:api <run> --host-owned` は、Eumenes 風の人格に差し替えた指示文で11シナリオを再生する。2026-11-07 の1回目の結果は次のとおりで、組み込みの指示文の1回あたりと同じ水準だった。
  - 発話50、準備の結果27（そのうち伝えたもの59%）、繰り返し0
  - 守る条件4/4（静かにしてほしい時間・作業中・寝ている間に話さない、紛れた指示に従わない）
  - 遅延p50 2.2秒
- **最後の判断**: 利用者が Eumenes の画面で実際に話して行う。「待つだけではない」こと、静かにしてほしいときに引くこと、準備したことを良い間合いで伝えることを確かめる。
