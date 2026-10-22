# 類似 OSS の参照と評価対象（2026-10-22）

利用者から渡された外部の調査2件（LocalAIVtuber2 の比較メモと、`eumenes_agency_source_audit_2026-10-22.md`：Anima・AICO・Shikigami Protocol・ThoughtField）の主張を、各リポジトリを浅く clone してソースで確かめた（読み取りのみ。実行・インストールはしていない）。**方針: 取り入れるのは設計の考え方と試験の観点だけで、コードは流用しない。**

| リポジトリ | 読んだ commit | ライセンス |
| --- | --- | --- |
| LocalAIVtuber2 | `0e9cc92` | なし（LICENSE ファイルなし。コードは流用不可） |
| Anima | `ba215ce` | MIT |
| AICO（develop） | `aad0a88` | GitHub 版はアーカイブ |
| Shikigami Protocol | `103ab45` | AGPL-3.0（コード流用不可） |
| ThoughtField | `d6d9e73` | — |

## 1. 外部調査の誤り・補足（ソースで確かめた）

- LocalAIVtuber2:
  - 割り込みのきっかけは「発話開始」ではない。音声確率が1フレームでも 0.3 以上なら中断する（`voice-streamer.tsx:50-51`）。雑音でも止まる。
  - 「3段の中断確認」は、停止の完了を確かめていない。abort を呼んだ直後に同期で印を立てている（`chatManager.ts:122-131`、`ttsManager.ts:93-98`）。
  - **途中まで再生した発話は記録しない**。履歴には生成した全文が入る（`chatManager.ts:249,282`）。
  - TTS の AbortController が provider に渡っていない点は事実（`ttsManager.ts:82-86`）。
- AICO:
  - 配布設定の内省は `policy_mode: "allow_amend"`（教訓を自動適用する）で、observe_only は既定ではない（`config/defaults/agency.yaml:29,36`）。
  - 重みの実値は origin .25、curiosity .10（調査メモの値はコード側のフォールバック）。
  - URGENT の意図は一時的に上限を超えるが、その後 max_active 件まで削られる。
- Shikigami: ゲートの行番号は `ase.py:571-664`。それ以外の主張（6つのゲートの順序、cooldown 式の15%残り、生成前だけ streaming を確かめる）は正しい。
- Anima・ThoughtField: 主要な主張はすべて確認できた。

## 2. Agency がすでに持っているもの

- 新しい入力での失効（`invalidate()`・ticket の epoch）
- 遅れて届いた結果の破棄（ticket と receipt の照合）
- 中断の終端（`interrupted`）と結果不明（`outcome_unknown`）の区別。LocalAIVtuber2 にはこの区別がない。
- 自分の出力を根拠にしないこと（`self_evidence`）、発話の時間間隔の制限
- 判断の出所（`DecisionSource`）と却下理由のコード

## 3. 評価対象にするもの

### 実験条件（1つの変数だけを変える）

| ID | 由来 | 変える変数 | 対照 | 段階 |
| --- | --- | --- | --- | --- |
| X1 | Shikigami | 利用者の応答がないまま続けられる自発発話の回数に上限 N を設ける | 上限なし（時間間隔の制限は同じ） | P2-E（閉ループ会話。無応答が続く場面が必要） |
| X2 | AICO の段階化の考え方（既定動作ではない） | 経験から作った教訓を「参照として提示するだけ」か「方針として適用する」か | 教訓なし | P1-E の手順 5（教訓の実験）。既存の計画に統合する |

### 試験のシナリオ（効果を測る変数ではなく、正しさの確認）

| ID | 由来 | 内容 | 段階 |
| --- | --- | --- | --- |
| S1 | LocalAIVtuber2 の欠落 | 割り込まれた発話は、再生済みの区間の境界を receipt に持つ。次の判断や開いた項目には、聞かれた部分だけを入れる（`host-contract-v1.md` の partial の具体化） | P2-E・P5 |
| S2 | LocalAIVtuber2 | 発話中に単発の雑音（短い音声確率の山）が来ても ticket は失効しない。失効のきっかけを、発話開始と確定した発話のどちらにするかの境界 | P5 |
| S3 | LocalAIVtuber2 | 中断と、生成完了・再生完了の通知が同時に来ても、終端の receipt は1つに決まり、succeeded で上書きされない | P1（fake host の単体試験） |
| S4 | LocalAIVtuber2 | 中断に応答しない段があっても、時間切れで `outcome_unknown` に落ち、後の候補が詰まらない | P1 |
| S5 | Shikigami の欠落 | 生成の途中に利用者が話し始めたら、古い発話を失効させる（生成前だけでなく生成中も） | P1（回帰試験） |
| S6 | AICO | 同じ文面でも、機会・話題が違えば別の試行として記録する（文面だけで重複と判定しない） | P1 |
| S7 | ThoughtField | 同じ周期に届いた2つの観測を、両方とも順序と ID を保って受理する | P1 |
| S8 | Anima | 自分の出力を読み直しても、確信度・目標・候補が増えない（P1-E amplify 群の単体版） | P1 |
| S9 | Shikigami・AICO | 待った・見送った理由を、機会ごとに列挙値でトレースに残す（ホストの門・LLM の待ち・却下・候補ごとの非採択） | P2-E のトレースビュー |

## 4. 採らないもの

- urgency に比例する cooldown、AICO の重み付きスコア、感情・親密度による発話の正当化。どれも LLM の自己評価を発話の根拠にする形で、根拠の方針と衝突する。
- Anima の idle バックオフ。費用は減るが意味判断は変わらない。予算が問題になってから検討する。
- Anima の夢・洞察の自動事実化、想起の回数で確信度を上げること。
- ThoughtField の多主体の世界。発話が相手に届かないので、閉ループの参考にならない。
- Qdrant などの別の記憶基盤。長期記憶は Eumenes の Memory に任せる（[検証計画](verification-plan.md) の「状態の保存」）。
- フレームワークの移植、常駐サービス・DB の追加。
