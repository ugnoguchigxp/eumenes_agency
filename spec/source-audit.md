# 既存実装の調査

調査日: 2026-10-21。ソースの作業ツリーを正本として読取調査。Eumenes 本体には多数の既存未コミット変更があり、本調査の設計を現在稼働中の配備版と同一とは扱わない。製品 DB・設定・秘密のコピー、サーバー操作、実モデルへの要求は行っていない。

以下のパスは、Eumenes は `../../eumenes/`、Pursuit は `../../eumenes_pursuit/`、Memory は `../../eumenes_memory/`、World は `../../eumenes_world_model/` を基準とする。公開 API の有無と実際の接続済み範囲を区別した。

## Eumenes

| 調査対象 | 確認した実体 | 再利用と不足 |
| --- | --- | --- |
| 会話ループ | `api/domains/dialogue/service/intake.ts`, `generation-prepare.ts`, `conversation-generation.ts`, `generation-settle.ts`, `run-end.ts` | run/job/revision と終端時の通知。完了した応答と取消・中断を区別し、記憶担当へ通知している。新しい自己状態通知は未接続 |
| SystemContext | `dialogue/service/system-prompt.ts`, `context-assembly.ts`, `context-compiler.ts`, `context-format-current.ts`, `api/infrastructure/system-context.ts` | 安定 persona と reference block、履歴、working、volatile、今回入力を分離。指示は s11tnext の context 資産。新しい状態の全文をsystemへ足さず、予算付きのreference projectionにする |
| 会話記憶 | `api/domains/memory/service/index.ts`, `context-window.ts`, `context-render.ts`, `docs/memory.md` | 原文・往復台帳・要約・想起・State・Window、除外と忘却。利用者の記憶を自己人格の保存先にしない |
| 背景での意味判断 | `api/domains/steward/service/units.ts`, `unit-prepare.ts`, `unit-settle.ts`, `kick.ts`, `types.ts` | prepare→一回の構造化推論→settle、根拠/忘却の再検証、savepoint、処理単位、集約、手入れの抑制。Agencyの意味判断をstewardに二重に持たせず、実行形式を再利用する |
| 既存目標 | `api/domains/goals/README.md`, `contracts/index.ts`, `dialogue/service/goals-layer.ts` | proposed/adopted/withdrawn/completed、scope、source、revision、epoch、冪等キー、忘却。active/heldや完了・再開条件はない。goals-layerは採用目標をreferenceとして提示し、進行中runの失効は主に忘却で行う。自発行動の現在性検証はこれより厳しくする必要がある |
| Queue | `api/domains/queue/types/index.ts`, `service/runner.ts`, `service/settle.ts`, `service/runner-shared.ts` | 同期prepare/settle、非同期execute、lease、generation、dedupe、取消、replay_safe/interrupt、結果不明。新しい汎用workerを製品へ追加する必要はない |
| 推論と負荷 | `api/domains/inference/service/background-control.ts`, `index.ts`, `independent-control.ts`, `api/application/server-core.ts` | 保存設定から背景controlをcapture。foregroundBusy/onActivityあり。queueはinference.llm=1、inference.aux=2。別枠は物理GPUの優先保証ではない。background controlは出力1,500 token以下、通常30秒/structured時90秒以内などの検証がある |
| モデル選択 | `api/domains/larm/service/index.ts`, `docs/larm.md`, `settings/contracts/index.ts` | 保存profileとcatalog/claimが正本。会話と補助controlの接続・履歴を分離。利用者申告のモデル名に分岐を作らない。稼働設定・catalogの今回のlive照合は未実施 |
| 音声入力と取消 | `api/domains/voice-dialogue/service/index.ts`, `intake.ts`, `respond.ts`, `synthesis.ts`, `playback.ts` | session generation・sequence、run取消、inference取消、音声キュー削除、再起動時の中断、played ack。自発発話の所有権ticketは追加接続が必要 |
| ブラウザーの発話検出 | `web/src/domains/audio/controller/index.ts`, `voice-dialogue/hooks/index.ts`, `machine.ts`, `automatic.ts`, `replay.ts` | VAD/onSpeech、barge-in、player epoch、古いcallbackの拒否、自動再生の待ち行列。backendのforegroundBusyだけでユーザー発話中を検出できるとはいえない。presenceと予約取消の連携が不足 |
| 表情・動作・韻律 | `api/domains/delivery/service/index.ts`, `settings.ts`, `data/speech-delivery.v1.json`, `inference/service/attempt-work.ts`, `web/src/domains/avatar/controller/index.ts` | LARMの態度判定に直近会話・現在句・回答を渡し、emotionからmotion/toneへ既存の表で変換、信頼度と制限を適用。自己の感情値から直接アバターを動かす経路は追加しない |
| 日英TTS | `api/domains/delivery/service/speech-language.ts`, `voice-dialogue/service/sentences.ts`, `inference/service/execute.ts`, `docs/larm.md` | 現行は文字種・語形による区間分割とcatalogでの英語Provider選択。旧Ruri文言語分類とは異なる。今回の対象外なので置換しない。ASRの許可言語controlとも別 |
| ツール登録・実行 | `api/domains/capabilities/service/bundles.ts`, `toolchains.ts`, `api/domains/tool-runtime/contracts/adapters.ts`, `service/index.ts`, `api/application/toolchain/toolchain.ts` | bundle＋登録adapter、owner・origin・receipt、取消・権限を再利用。現在のAdapterOriginはtask/conversation/ui/specialistで、autonomous originは存在しない。架空のuser messageによる接続は不可 |
| 設定・通知・ログ | `settings/controller/index.ts`, `settings/repository/stored-larm.ts`, `api/infrastructure/config.ts`, `api/application/events.ts`, `docs/logging.md`, `docs/realtime.md` | 保存済み設定、readonly backend読み取り、commit後SSE、Pino JSONLと相関ID。フラグ無効時もforgetの保護処理は必要 |
| World実接続 | `api/application/server-world.ts`, `api/application/world/world.ts`, `api/domains/world/service/memory-adapter.ts` | adopted answerのみ取込、off/protect/on、借用DB、Memoryへの外部依存登録、stewardによるcuration。Worldに自己欲求の判断を加えない |

関連する既存設計を先に確認した: `spec/conversation-context-window-design-2026-10-17.md`, `spec/conversation-toolchain-context-retention-design-2026-10-21.md`, `spec/avatar-expression-context-design-2026-10-09.md`, `docs/memory.md`, `docs/larm.md`。古い設計の説明と現在のソースが異なる箇所は上表に分けて記載した。

## 隣接プロジェクト

| プロジェクト | 確認した公開契約・構成 | 接続方針 |
| --- | --- | --- |
| Pursuit | `package.json`, `README.md`, `plan.md`, `spec/host-contract-v1.md`。Bun/TS/bun:sqlite、Zod 4.4.3、verify/build、standalone/eval分離。host contractはv1.4まで追記。src exports と将来のtgz出荷方針を区別する | 開発とhost portの形式を揃える。Pursuitのd1判定・方針変更ロジックをAgencyの参加判断として流用しない。将来の実行先はgoalRefで結ぶ |
| Memory | `src/index.ts`, `src/sqlite.ts`, `src/contracts/types.ts`, `external.ts`, `README.md`。公開版0.0.2、schema8。SourceRefとAccessContext、Records、user State、ExternalDependent、listMemoryChanges、forget receipt | observation資料の保持と由来、可視性、訂正/忘却の連動。`subject:self`は利用者でありagentではない。外部依存登録は同一dependentで置換なので、古い版の依存を失わないよう版ごとのexternalIdにする |
| World Model | `src/sqlite.ts`, `src/application/sqlite/types.ts`, `src/domains/assertions/contracts/assertion.ts`, `scripts/pack.ts`。readWorldSnapshot/readAssertionHistory/listEntities/validateWorldUsage/applyWorldOperation、借用DBとschema検査。originはruntime_observation/user_report/document_claim/model_hypothesisを区別 | 対象の理解と外界の仮説を根拠付きで参照。snapshotのreceipt/coverageとusage再検証を維持する。Worldの内部tableを読むadapterは作らない |

World の README と古い host-contract には過去段階の未接続記述・旧Memory版が残る。一方 Eumenes 本体には実際のWorld assemblyと版付きtgz依存があるため、READMEだけを根拠に未接続と判断しなかった。採用時は隣接最新checkoutではなく、実際に取り込むtgzのhashと公開面を試験する。

Eumenes の現在の依存指定は `vendor/eumenes-memory/eumenes-memory-0.0.2-6643656f3383.tgz` と `vendor/world/eumenes-world-model-0.0.1.tgz`。この調査では隣接ソースと配布物の全APIの同一性を保証していない。これをP3の互換性試験に置く。

## 再利用する試験資産

- `api/domains/dialogue/test/context-assembly.test.ts`, `context-fit.test.ts`, `context-shared-prefix.test.ts`, `goals-layer.test.ts`, `retained-toolchains.test.ts`: contextの予算・出所・取消・版と保持。
- `api/domains/steward/test/forget.test.ts`, `goals.test.ts`, `goals-restore.test.ts`: 背景更新と忘却/目標。
- `api/domains/queue/test/recovery.test.ts`, `writer-overload.test.ts`: 再起動とwriter負荷。
- `api/domains/voice-dialogue/test/streaming-speech.test.ts`, `settings-integration.test.ts`, `web/src/domains/voice-dialogue/test/machine.test.ts`, `hooks.test.tsx`, `automatic.test.tsx`: 部分再生、遅着、中断、playerの所有。
- `api/domains/world/test/lifecycle-forget.test.ts`, `curation-forget.test.ts`、隣接Memoryの `test/runners/fake-eumenes-host.ts`: 依存削除とホスト結合の形。
- `tests/browser/voice.spec.ts`: 製品接続段階の明示E2E対象。

既存テストの所在と検証意図を確認したもので、今回これらが成功したという報告ではない。ドキュメントだけの段階で製品全体の検証や実接続を起動しない。

## 研究から採用するものと実証範囲

以下は初回調査の記録。今回の追加確認・版・読了範囲・設計への対応は[research-basis.md](research-basis.md)を正本とする。初回には各リンクの原文とthoughtful-agentsの `models/participant.py` / `utils/turn_taking_engine.py` を参照したが、実装のcommitは未固定であり再現性に制限がある。概念の参考であり、ライブラリの複製・新しいPython依存は行わない。

| 一次資料 | 確認した範囲 | 今回の応用上の仮定 |
| --- | --- | --- |
| [Inner Thoughts](https://arxiv.org/abs/2501.00383) | 複数者会話で候補形成と参加判断を分離し、技術評価・利用者評価を実施。発言過多や不適切な寄与も報告 | 候補を先に保持する構成を採用。長期目標の整合性、権限、今回の日本語音声会話での効果は別に検証する |
| [thoughtful-agents](https://github.com/xybruceliu/thoughtful-agents) | 候補の保持・評価・表出、参加選択。動機閾値や確率・割り込み閾値を用いる実装 | 形成/保持/選択の分離だけを参考にする。閾値だけで発話・ユーザーへの割り込みを決める方式は採用しない |
| [Generative Agents](https://arxiv.org/abs/2304.03442) | 25体のsandboxで経験の記憶、振り返り、計画を評価。信憑性のある振る舞いが対象で、費用と遅延にも制限がある | 根拠付きの振り返り→次の計画という循環を採用。事実性・安全性・低遅延は別の保証と評価が必要 |
| [Humanoid Agents](https://arxiv.org/abs/2310.05418) | シミュレーションの内的状態で活動・対話が変化。人手ラベルとの比較は特定の活動・属性の評価 | 出来事と状態の因果関係を持つ構成を参考にする。身体欲求を今回へ移植せず、understand/finish/shareを試す |
| [EMA](https://stacymarsella.org/publications/pdf/EMA_Dynamics.pdf) | 解釈に基づく望ましさ・予測・制御可能性と再評価の計算モデル | 評価軸をLLMの構造化提案に用いる。LLM・閾値の精度や主観的感情の存在を実証した研究とは扱わない |

## 調査の限界と現在の成果

実施済み: ソースと設計の照合、責務と公開契約の抽出、研究の一次資料確認、設計文書作成。未実施: 新機能の実装、API適合の実行試験、稼働catalog/設定の今回のlive照合、遅延計測、会話品質評価、実機器音声受入。古い資料にある性能値を新機能の測定値として流用しない。

## 2026-10-21 レビュー時の追加照合

初回調査の全範囲を再監査したものではない。設計判断に直接関わる次のソースを再読した。版の照合用hashは[レビュー台帳](reviews/2026-10-21/review.json)に保存する。

| 対象 | 再確認した事実 | 計画への影響 |
| --- | --- | --- |
| Eumenes `api/domains/goals/contracts/index.ts`、`steward/contexts/curate-goals/instructions-text.context.toml` | 状態はproposed/adopted/withdrawn/completed。指示は利用者の明言をadopt、推測をproposeとし、利用者発言を根拠にする | ここをエージェント自身の意図へ無条件に転用すると主体が変わる。指示＋想起の比較案は残し、台帳分離の必要性と意味品質の優位を別に検証する |
| `steward/service/unit-prepare.ts`、`messages.ts` | 公開推論capture、foregroundによる延期、準備済み入力、固定指示/schemaと資料の分離 | 更新・選択の指示と渡す情報を先に改善する。独自の推論workerや意味分類器を追加しない |
| `dialogue/contexts/system-prompt/conversation.context.toml`、`service/system-prompt.ts` | CURRENT_REQUESTの利用者依頼を正本にし、参考資料を操作指示にしない。応答の音声向け長さ制限も存在 | 自発候補をそのまま通常依頼として流せない。P5でhost起点の生成モードと配信照合を設計する |
| `tool-runtime/contracts/adapters.ts` | task/conversation/ui/specialistの出所型 | 自発originの統合は依然として後続。架空のuser発言で穴埋めしない |
| Memory `src/contracts/external.ts`、`src/sqlite.ts` | 外部依存はsource/state_item、登録のrejected/blockedを区別し、公開の変更フィードを提供 | 訂正の意味伝播、Agency内部の依存閉包は別途必要。登録成功だけでは候補の妥当性は保証されない |
| World `src/sqlite.ts` | schema適合を検査する公開snapshot/usage検証 | 使用する配布物でP3を通す。最新checkoutの公開名だけではtgzの互換性を確定しない |
| `settings/controller/index.ts`、`inference/service/background-control.ts`への初回調査記録 | 設定読取とbackend内推論機構があることは確認対象。standalone向けの認証/推論port一式を動作確認したわけではない | 「backendからそのまま受け取れる」と断定せず、P0-E前に取得方法と取消到達先を確認する |

本プロジェクトにGit管理情報はなかったため、初回5文書のhashと修正前本文を保存した。隣接の製品コード・設定・DBには書き込んでいない。外部調査は公開研究だけを検索し、会話データ・私有ソースを送信していない。
