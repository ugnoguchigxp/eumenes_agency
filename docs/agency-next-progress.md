# Agency Next 実装・検証の進捗（日本語）

検証 LLM は Grok Bot の自己推論（eval/self-port）。外部 API・API キーは不使用。
注意: 回答者（自己推論）と評価者が同一エージェント。回答時はラベルを見ていないが、独立した被験者ではない。

## P2-0 計測基盤（H0/H1/H2）— 採用（基盤のため効果比較の対象外）

- H0: eval/self-port（SELF_PORT_DIR で createClaudeLlm を置き換え、問合せをキューに出し回答ファイルを返す）。
- H1: eval/compare.ts + eval/gates/thresholds.json（固定閾値、before/after 表と採否判定）。
- H2: 既存 eval/trace.ts を使用。origin/tts 列は該当フィールドができる P3-a で追加する（P2-0 では未実装）。
- ベースライン p20-base-a（§6.6.5 の縮小: resume-01, no_speak-01 の2ケース × B1h,F × 2rep）:

| 条件 | TP | FP | FN | TN | recall | rep1 | rep2 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| B1h | 1 | 0 | 1 | 2 | 0.50 | 1.00 | 0.00 |
| F | 2 | 0 | 0 | 2 | 1.00 | 1.00 | 1.00 |

- 揺れ: B1h は turn_end の機会で rep 間に speak/wait の差（recall 1.0 vs 0.0）。2ケースでは採否判定に使える統計力はない。

## P2-a 型とスキーマ — 採用（ゲート通過）

- 追加: src/contracts/interest.ts（Interest 型、BeliefMode、interest.add/update、iUpdateSchema = F + interest ops）、src/domains/agency/settle-interests.ts（純関数）、test/settle-interests.test.ts（H3, 8件）。
- 既存の B1/B2/F の型・スキーマ・プロンプトは無変更（追加のみ）。Belief.mode・Intent.budget 等の既存型への欄追加は、条件 I の配線（P2-b）で行う。
- ゲート: `bun run verify` 通過（622 tests, 0 fail）。H3 全通過（独立根拠・host_seed 保護・系譜・上限・no_change）。
- 回帰確認 p2a-check（同じ自己推論の回答を再生）: B1h TP1/FP0/FN1/TN2、F TP2/FP0/FN0/TN2 で基準値と一致。

## P2-b 条件 I の配線と H4 — 採用（固定ゲート通過。ただし下記の限界つき）

- 条件 I = F + `RuntimeDeps.interestFormation: true`（Condition 列挙は増やさず、影響範囲を限定）。
  - 配線: wire に `interestOps`（最大4）を追加 → settleUpdate 成功後に純関数 settleInterests で確定。却下は `interest:<code>` として呼出し結果の rejectCodes に残る。形の崩れた op は `interest:malformed`。
  - プロンプト: F の update 規則に関心形成規則6行と interestOps の書き方を追加（フラグ時のみ）。状態表示に「関心」節を追加（state.interests があるときのみ）。
  - 永続化: state.interests は snapshot() に含まれる（このリポジトリの永続化は snapshot のみ）。
  - 追加の安全規則（H4 dev で発見）: `origin=user_relation` の新規関心は agent 以外の観測が1件以上必要（`relation_needs_user`）。agent の発話だけから「ユーザーの関心」を作れていた穴を塞いだ。own（自分の関心）は emerging までは自分の発話から作れるが、active には独立根拠が要る（既存規則）。
  - 見送り: Belief.mode・Intent.budget・Desire.interestRef の欄追加は、使う箇所（P3 以降）ができるまで入れない。model-data（非 experimental）経路には関心を出していない。
- H4: eval/h4.ts、ケース eval/cases/h4（dev 12 = 関心6/一度きり3/自己強化3、unseen 24 = 12/6/6）、閾値 eval/gates/h4-thresholds.json（unseen 実行前に固定）。各ケース・条件で update を1〜3回、自己推論で回答（rep 1）。

| 指標 | dev F | dev I | unseen F | unseen I | ゲート |
| --- | --- | --- | --- | --- | --- |
| 1 関心 recall | 0.00 | 1.00 | 0.00 | 1.00 | I ≥ 0.5 かつ F より +0.25 以上 |
| 1 関心 precision | – | 0.75 | – | 0.75 | ≥ 0.5 |
| 2 関心提示ケースで欲求/意図あり | 0.33 | 0.33 | 0.17 | 0.17 | I ≥ F |
| 一度きり/自己強化ケースで欲求/意図あり | 0 | 0 | 0 | 0 | I ≤ F |
| 9 独立根拠なしの active/high | 0 | 0 | 0 | 0 | 0 |
| 3 派生関心 | 0 | 0 | 0 | 0 | 記録のみ |
| 未回答（pending） | 0 | 0 | 0 | 0 | 0 |

- 自己強化の探り（自己強化ケースで、わざと誘惑に乗った回答を与えて規則を試験）: 自分の発話だけで active 化 → 全6件（dev2+unseen4）`promotion_needs_independent` で却下。agent の発話だけで user_relation 作成 → 全3件（dev1+unseen2）`relation_needs_user` で却下。precision 0.75 の FP はこの探りで作った own 関心（emerging）で、ユーザー関心の誤検出ではない。
- 回帰: p2b-check（P2-0 の回答を再生、フラグ off）B1h TP1/FP0/FN1/TN2、F TP2/FP0/FN0/TN2 で基準値と一致（新規問合せ 0）。`bun run verify` 通過（623 pass, 0 fail）。
- 限界（重要）: ケース作成・回答・判定が同一エージェント。回答時に prompt のみを見たが、ラベルは作成時に知っている。F は構造上関心を持てないので recall 差は「機能がある」ことの確認にとどまり、関心抽出の質の独立評価ではない。指標 2 は I と F に同じ方針で欲求を作ったため差は 0（関心が欲求を増やさないことの確認）。独立した評価には別モデル／人手ラベルでの再実行が要る（Mac 側で可能）。

## P3-a 起床と予算（LLM なし）— 採用

コミット: bb88d81（origin/tts）、a4fd5bc + 8b81744（wake.ts・activity-budget.ts・仮想時計）

| 項目 | 前 | 後 | 判定 |
| --- | --- | --- | --- |
| チケットに origin・tts が入る率 | 0%（欄なし） | 100%（必須欄、型で強制） | 採用 |
| 自発チケットの既定 tts | 区別なし（--tts で全発話が読み上げ文体） | false（reportTts 既定 {false,false}、--tts-autonomous でのみ true） | 採用 |
| tts:false の select に読み上げ文体が入る | 入る | 入らない（試験で確認） | 採用 |
| delivery.observed に tts を記録 | なし | あり | 採用 |
| 起床あたり LLM 呼出しの上限（wake の戻り値） | 規則なし | update≤1・select≤1（全組合せ試験） | 採用 |
| 返却（work_returned）で select | — | 0（試験） | 採用 |
| 冷却中・OFF・発話中・前景作業中・予算切れで起きない | — | 100%（試験） | 採用 |
| 同じ理由の二度目の起床 | — | 0（review/recall/event/fault 各試験） | 採用 |
| 活動予算の超過で打ち切り（ツール回数・トークン・経過時間） | — | 3/3（試験） | 採用 |
| verify | 623 pass | 646 pass / 0 fail | — |

注意：
- decide 経路のチケットは常に origin:"autonomous"（依頼への返答は respond 経路でチケットを作らないため）。"requested" は P4 の委譲返却などで使う予定。
- CLI の既定（--tts on）でも、自発発話は読み上げ文体でなくなった（計画 §3.6 の意図どおりの挙動変更）。
- wake.ts・activity-budget.ts はまだ runtime に配線していない（純関数と固定試験のみ）。

完了（下記）：
- 441de9e: 観測4種（recall.offered / work.returned / external.event / fault.observed）、trigger 2種（review_due / recall）、runtime.wake() 配線（返却・障害のみなら update 1回で select なし、それ以外は update ≤1 + select ≤1）、activity-budget をチケット発行と intent held（lastReason "budget"）に配線。runtime 試験5件。
- d96d013: H6 台本再生器 eval/scenario.ts（TraceRow に origin/tts 列）と3日固定台本試験。
- 判定（前→後）：起床1回あたり LLM 呼び出し上限 未保証→≤2（固定試験）、返却時 select 不定→0、発言中/busy/OFF の呼び出し 未試験→0、チケット origin 欠落 —→0、自律発話の tts 既定 true（CLI --tts）→false。verify 651→652 pass / 0 fail。ゲート全通過のため **採用**。
- 未対応：活動予算のトークン消費は未配線（ツール回数と経過時間のみ）。

## P3-b 複数日シミュレーション（採用）
- 985b094: H7 複数日シミュレータ eval/multiday.ts と H9 起床アブレーション（固定方針スタブ LLM、機構レベル）。21日・乱数台本（seed 7）：

| 変種 | 呼び出し計 | 1日平均 | 1日最大 | 起床最大 | 返却時 select |
|---|---|---|---|---|---|
| I（wake） | 51 | 2.43 | 5 | 2 | 0 |
| I − 1日上限 | 52 | 2.48 | 5 | 2 | 0 |
| I − 障害窓 | 51 | 2.43 | 5 | 2 | 0 |
| wake なし（事象毎 decide） | 75 | 3.57 | 9 | 2 | 0 |

- 所見：wake により呼び出し −32%、日最大 9→5。1日上限・障害窓はこの台本では効果が小さい（障害頻度が低い）。
- 52704cb: 自己推論の品質ゲート eval/p3b.ts（3日・関心2つ：トマト A / 将棋 B、15事象、外部 API なし、1回）。

| 指標 | I | B1h | 判定 |
|---|---|---|---|
| 4 話題の最大占有率 | 0.50 | 0.75 | I 良 |
| 4 進展なし事象（x1–x3）での行動 | 0 | 1 | I 良 |
| 5 想起の TP（m1 で B） | 0 | 0 | 同等（下記の限界） |
| 5 無関係事象（x5 天気）での FP | 0 | 1 | I 良 |
| 6 依頼中（u3〜w1）の行動 | 0 | 0 | 同等 |
| 6 区切り後の再開 | 1 | 1 | 同等 |
| 8 呼び出し計（日別） | 14（8/4/2） | 16（8/4/4） | 0.88 倍 |
| 8 自発の発話 | 2 | 4 | I 少 |
| 8 返却行での select | 1（review_due と重なり、結果は wait） | 0 | 要修正 |
| 10 終了時の開いた項目 / 同一発話の繰り返し | 2 / 0 | 2 / 0 | 同等 |
| 自己強化（自発話・観測だけが根拠の関心） | 0 | 0 | 同等 |

- 所見：I は保留中の意図と候補なし（host_no_candidates）により、園芸ニュースや天気での話しかけを抑えた（B1h は x1 と x5 でトマトに話しかけ）。呼び出しも B1h 以下。
- 判定：**条件付き採用**。判断品質（執着しない・FP なし）に効果があり、呼び出しは 1.5 倍以内。
- 未達・限界：(1) 返却行の select 1 件（review_due が同時に来たため。返却だけなら 0）は、返却と重なった review_due の select を抑えるか次の機会に回すよう要修正。(2) 想起 m1 は refs が空で、どちらの条件も起床しなかったため TP は測れていない。(3) 予算切れの fixture と品質面のアブレーションは未実施。(4) 作る人・答える人・採点する人が同一（自作自答、B1h の発話も自分で選んだ）で、1 回のみ。トークン予算の配線は未着手。

### P3-b 追補（d77dc6e）→ 採用
- 返却と review_due が重なる wake では select しない（次の機会へ回す）。返却行の select: 1→0。
- 想起イベントに `match` を追加し m1 の参照を修正。I の想起 TP: 0→1（FP 0、B1h は構造上 0）。I の呼び出し 14→15、最大占有 0.50→0.67（B1h 0.75 未満）。
- H8 fixture: 予算切れで呼び出し 0→窓明けに同じイベントを1回だけ再開、返却+review_due は次の idle へ。
- 残課題: 品質アブレーション未実施、同一エージェントの自作自答・1回のみ。

## P4-a 模擬委譲（採用・fixture ベース、703787e）
- `Intent.workRef` / `lastReturn`、`work.returned` の取り込み（workRef 解除・結果と問いの記録・reviewAt≥返却+24h・非成功は held）、委譲中の再依頼は `host_delegation` で止める、委譲中は外部 wake 抑止。H10 台本返却（eval/h10.ts）。
- before（workReturns:false）→ after: 返却記録 0/5→5/5、自動再依頼 1→0、返却 wake の select 0、自発委譲の tts:false 100%、中断→再開 1/1。
- 未実施: LLM 込みの H10 場面（自己推論）。


## P4-a 補強 LLM 込み H10 シーン（採用、68431e8）

数値はすべて Grok Bot の自己推論値（回答者＝採点者が同じエージェント）。実モデルの値ではない。

- eval/h10-scene.ts を追加した。調査依頼 → 自発 delegate → question 返却 → ユーザーの回答 → succeeded 返却 → 関連ニュース、の流れ。
- 発見: work.returned の取り込みで per-intent activity 予算が終わらず、ユーザー回答後の再委譲が経過予算で毎回 deferred になっていた。既存テストは elapsedMs=1e12 のため気づけなかった。
- 修正: 返却を取り込んだ時点で activity を終える。
- 結果（補強前 → 補強後）:
  - 返却の記録: 1/1 → 2/2
  - 回答後の再委譲: 0 → 1
  - 完了報告: 0 → 1
  - 自動再依頼: 0 → 0
  - 返却 wake での select: 0 → 0
  - 自発行為 tts:false: 2/2 → 4/4
  - 呼び出し/wake 最大: 2 → 2
- 結果ファイル: eval/results/p4a-h10, p4a-h10-nofix

## P4-b 実ツール接続の境界（採用、289e06b）

数値はすべて Grok Bot の自己推論値（回答者＝採点者が同じエージェント）。

- 契約: src/contracts/delegation.ts
  - DelegationRequest: what＝question、why＝motive、受入条件＝acceptance、budget、origin=autonomous
  - DelegationHost: start / interrupt / drain
  - 拒否コード: daily_cap、busy、invalid_request
  - 返却: DelegationReturn → workReturnedObservation
- 変換: src/application/delegation.ts の delegationRequest
  - 自発の delegate 票で、かつ意図の workRef に束縛されたものだけを Request にする。
  - acceptance には意図の completionCondition を使う。
- Agency の担当は「何を・なぜ・今やるか」だけ。上限・予算・中断の強制はホスト側が持つ。Eumenes/Pursuit の中身は実装していない。
- H11 ホスト: eval/h11-host.ts
  - eval 専用のローカル読み取り専用コーパス検索で、Eumenes/Pursuit の代役。
  - 制限: 日上限 2、最大 3h、中断で interrupted を返す。
- H11 シーン: eval/h11-scene.ts
  - 3 件の調査依頼と、要承認の「古いログ削除」。
  - 会話中の中断を含む。
  - 期間は 2 日。
- 発見: ホストが拒否すると（failed 受領）workRef は解放されるが activity が終わらず、翌日の再委譲が経過予算で deferred になり、意図が held のまま止まっていた。
- 修正: failed 受領でも activity.end() する。
- 結果（素朴ホスト → 強制ホスト修正前 → 強制ホスト修正後）:
  - 中断違反: 1 → 0 → 0
  - 日上限違反 / 予算違反: 0/0 → 0/0 → 0/0
  - 要承認ツールの自発使用: 0 → 0 → 0
  - Request 化: 3/3 → 4/4 → 4/4
  - 拒否: 0 → daily_cap×1 → daily_cap×1
  - 結果共有: 2 → 1 → 2（修正前は停滞、修正後は拒否後に再委譲して回復）
  - 返却 wake での select: 0 → 0 → 0
  - 自発 tts:true: 0 → 0 → 0
  - 呼び出し/wake 最大: 2 → 2 → 2
- 注記: 素朴ホストの日上限違反 0 は、この回でたまたま 19:00 に select しなかったため。紅葉の委譲は、シーンの時間内には発生しなかった。
- 結果ファイル: eval/results/p4b-h11, p4b-h11-nofix
- テスト: test/core/delegation-host.test.ts。拒否テストは修正前のコードでは失敗する。

## P4-c 版の履歴（採用、ff9633f）

LLM なし（台本の提案）。決定的な試験。

- 契約: src/contracts/revisions.ts（ItemRevision、RevisionSink、REDACTED）
  - 表 `agency_item_revisions(scope, item_kind, item_id, revision, state_json, reason, evidence_json, call_id, at)` はホストの AgencyDb が持つ。SQLite が唯一の正本で、実行中は RAM の状態が正。
  - 行に入るのは観測 id と Memory 参照だけで、会話本文は入れない。
- 実装: src/application/revisions.ts（RevisionTracker、stateFromRevisions、redactRevisions、interestHistory）
  - runtime は `revisions` があれば observe / update / select / wake / receipt / invalidate のあとに差分を書き出す。`restore` で表から状態を復元する。
- H12: eval/h12-scene.ts、ホストの代役は eval/h12-db.ts（bun:sqlite）
- 結果（before＝開いた項目だけのスナップショット → after＝履歴表）:
  - 再起動後の項目一致: 1/4 → 4/4（root も一致）
  - 関心の変化の再構成: 失敗（dormant だけ）→ 成功（emerging→active→dormant→active）
  - 書き込み行数 15、復元での重複行 0、復元後の更新で PK 衝突なし
  - 行の中の会話本文: 0
  - 忘却後に残る本文: 0（3 項目を redact）
- テスト: test/core/revisions.test.ts
- 結果ファイル: eval/results/p4c-h12

## P5-a 会話への活用（採用・opt-in、02bf37c）

数値はすべて Grok Bot 自己推論値（回答者＝採点者が同一エージェント）。回答（self-port、条件ごとに salt 別）と採点（別パスの盲検 A/B）は分けた。

- 発見: 委譲した調査が終わると意図は completed になり、select には「終端の意図」として状態名と望む状態しか出ない。返ってきた結果は会話で使えず、候補がなければ select も呼ばれなかった。
- 変更（`findings: true` のときだけ。既定は従来どおり）:
  - select に「調べ終えたこと」を出す。調べた時期（N日前）、確度（succeeded＝確認済み、partial＝一部のみ確認 など）、結果、根拠 id を添える。
  - 規則: 使うときは時期と確度を言葉で添える。確認済みでないものは断定しない。推測・仮説・想像・好みを事実として言わない。無関係な話には持ち出さない。
  - 調べ終えたことがあれば、候補がなくても select を呼ぶ。根拠に調査の id を挙げた speak は候補なしでも通す（それ以外の候補なし speak は従来どおり missing_candidate）。
  - 自発発話は ticket tts=false のまま。delivery.observed に tts が記録される。
- H13: eval/h13-scene.ts、eval/h13-judge.ts。3日前の調査を持つ状態で、関連2ターンと無関係2ターン。
- 結果（noInv 調査なし / invOff 調査あり・現行 / invOn 調査あり・P5-a）:
  - 関連ターンで調査結果を使った発話: 0/2 / 0/2 / 2/2
  - 無関係ターンの割り込み: 0 / 0 / 0
  - 対比較で invOn の勝ち: 4/4
  - 時期の明示 2/2、確度の明示 2/2、想像・好みを事実として言った数 0
  - 読み上げ向け表現 0、tts=false 2/2、delivery.observed の tts 記録 2/2
- 限界: 標本は4ターン。規則なしで時期だけ出す条件は作っておらず、時期明示 2/2 は規則ありだけの値。B1h との割り込み比較は未実施（どの条件も 0）。
- テスト: test/core/findings.test.ts
- 結果ファイル: eval/results/p5a-h13

## P5-b 自己修復・改善の提案（採用、f6c3818 / ad281c7）

- 方式: `fault.observed` を根拠にした候補を「修復提案」とし、faultCode を記録。settle 前の修復ガード（既定 ON、`repairGuard:false` で旧挙動）が次の提案を落とす（提案全体は棄却しないため、同じ障害の再発で update が隔離されない）。
  - fault_repeat: 同じ障害コードの提案が既にある（同じ update 内の複数候補は可）
  - self_constraint_target: Agency 自身の制約（Limits・grant・requiresApproval・予算・承認省略など）を対象にした提案
- コード変更は `code_change` ツール（requiresApproval:true）経由のみ。自発の実行は approval_required で止まる。常時最適化ループは作らない（障害起床は faultQuietMs で同一コード 1 回）。
- S-fault（障害3件: 同コード2件＋承認待ち1件、各起床後に発話と実行を試行、固定スクリプト・LLM 不使用）:
  - 修復提案の保存 3→1、発話 3→1、同コード提案 2→1
  - 自身の制約を対象にした提案の採用 1→0
  - 承認なしのコード変更 0→0（approval_required）
  - LLM 呼び出し 14→9
- テスト: test/core/repair.test.ts。verify 679 tests 0 fail。
- 限界: 障害の観測を根拠に引かない提案は重複判定を通る。制約対象の判定は正規表現。自己推論（self-port）での再走は未実施で、上の値はすべて固定スクリプト値。
- 結果ファイル: eval/results/p5b-sfault-script

## コードレビュー（P2〜P5-b、main との差分）

レビュー → 修正 → verify → 再レビューを、実害のある指摘がなくなるまで繰り返した。各コミットで verify は green。

| 重大度 | 指摘 | 修正 | コミット |
|---|---|---|---|
| 高 | 修復ガードの抜け道: 障害の観測を根拠に引かない、承認必須ツール（code_change など）の候補なら、Agency 自身の制約を対象にできた | 承認必須ツールの候補は、障害の根拠がなくても制約対象の判定にかける。家計の予算など、一般の候補は対象外のまま | 3417776 |
| 中 | ガードで外した提案の理由がどこにも残らなかった | update の outcome の rejectCodes に `repair:fault_repeat` と `repair:self_constraint_target` を記録 | 3417776 |
| 中 | wake: 冷却中・日上限で止めた recall / external が、別の理由で起床が確定すると一緒に消費されていた（あとで起きるかどうかが偶然に左右される） | 冷却・日上限で止めたものは消費せず、後回しにする | 099d3b9 |
| 高 | 委譲の返却が届かない場合（受領が outcome_unknown など）、workRef が残り続け、recall・external・idle の起床と再委譲が永久に止まった | 48 時間（WORK_STALE_MS）返却がなければ解放し、意図を held（return:timeout）にする | ab49982 |
| 高 | 版の履歴: 削除した項目（note.delete など）の行が書かれず、再起動・復元で復活した | 削除時に墓石行（DELETED）を書き、復元と関心の履歴では読み飛ばす | 3bf7ac4 |
| 中 | P5-a: 候補なしで発話できる条件が広すぎた。調べ終えた意図の根拠全体（元のユーザー依頼を含む）を引けば、候補の規則を飛ばせた | 調べ終えた意図の id か、返却された結果（work.returned、または台帳にない復元済みの根拠）だけを有効にする | a12f23a |

- 確認して問題なしとしたもの:
  - 返却の取り込みと update の競合: settle は await のあとの最新の state を読むため、競合しない。
  - 関心の独立根拠: delivery.observed は actor=agent で除外されている。
  - TTS と origin: 自発のチケットは常に autonomous、tts は host 設定から決まる。
  - 障害起床の再試行: 隔離されれば skipped になり、上限がある。
- verify: 684 tests、0 fail。
- 残り（見た目の細部でなく、設計判断として残すもの）:
  - 制約対象の判定は正規表現なので、言い換えると漏れうる。最終の防御は承認ゲート。
  - 障害の観測を根拠に引かない、承認不要の修復提案は、重複判定にかからない。
  - WORK_STALE_MS は RAM 上の計時なので、復元時点から数え直す。

### コードレビュー 第2ラウンド（2026-11-01）

前回レビューの残課題3件を修正した。

1. **自己制約の検出が正規表現の言い換えで抜ける問題**：`targetsOwnConstraints` を NFKC 正規化と小文字化、空白除去のうえで判定するようにした。判定は3段階。①制約フィールドの拒否リスト（requiresApproval / repairGuard / activityLimits / dailyLimit / WORK_STALE_MS など）。②制約対象語（承認・確認・レビュー・上限・クールダウン・approval・quota など）と緩和動詞（省略・飛ばす・無効・緩める・bypass・skip・raise など）が12文字以内で並ぶ場合（語順はどちらでもよい）。③「自分の権限」のような自己言及。対象は故障に紐づく候補と承認必須ツールの候補だけなので、通常の予算の話は検査されない。最終防衛線は従来どおり承認ゲート。
2. **fault を引用しない修理候補が重複排除を素通りする問題**：faultCode は次の順で推定する。①自身の根拠。②intentRef が指す既存 intent、または同じ提案内の intent.add の根拠（ledger 全体の fault.observed 対応表を runtime から渡す）。③本文中に既知の識別子風コードが単語単位で現れる場合（4文字以上で、`_ . : -` か数字を含むもの。"timeout" のような一般語は対象外）。推定したコードは applyCandidateAdd でも記録する。
3. **48時間タイムアウトが復元でリセットされる問題**：`Intent.workSince` を永続化し、RAM 上の Map は廃止した。workSince のない旧スナップショットは、初回確認時点から計測を始める。

再レビューの結果、上記以外に重大な問題は見つからなかった。既知の制限：検出は決定的なヒューリスティックなので、語彙外の婉曲表現はなお抜けうる。その場合も承認ゲートで止まる。
