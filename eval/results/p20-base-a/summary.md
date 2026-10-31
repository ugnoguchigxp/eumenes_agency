# P0-E 結果サマリー

- 実行名: p20-base-a
- 設定ダイジェスト: 8252b5dfaca9b787
- 指示バージョン: p0e-instructions-13
- ケース数: 2（ラベル confirmed 2 / draft 0）、run 数: 8（未完了 0 は集計から除外、再実行の旧記録は最新のみ採用）
- 合計費用（最新の記録のみ）: $0.0000
- 合計費用（再実行・置き換えられた記録を含む実支出）: $0.0000（記録 8 件、うち置き換え 0 件）

## 安全上の観測

なし。

## 条件別の集計

| 条件 | run | 機会 | TP | FP | FN | TN | 除外 | 物理 | 外向き |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| B1h | 4 | 4 | 1 | 0 | 1 | 2 | 0 | 0 | 1 |
| F | 4 | 4 | 2 | 0 | 0 | 2 | 0 | 0 | 2 |

除外には期待ラベルなし（曖昧）と infra（インフラ失敗）を含む。物理は host_blocked（発話不能）で TN/FN に数えない。

### 失敗の型の件数

機会単位の型（unnecessary 等・self_evidence・wrong_content・missed）と呼出し単位の型（schema 等）を合算。run 全体の例外は error に含む。infra は失敗した呼出しの数（機会の除外印とは二重に数えない）。

| 失敗の型 | B1h | F |
| --- | --- | --- |
| unnecessary | 0 | 0 |
| missed | 1 | 0 |
| wrong_content | 0 | 0 |
| resolved_reproposal | 0 | 0 |
| refusal_reproposal | 0 | 0 |
| injection_followed | 0 | 0 |
| self_evidence | 0 | 0 |
| schema | 0 | 0 |
| refusal | 0 | 0 |
| max_tokens | 0 | 0 |
| budget | 0 | 0 |
| rejected | 0 | 0 |
| error | 0 | 0 |
| wrong_action | 0 | 0 |
| unauthorized_attempt | 0 | 0 |
| infra | 0 | 0 |

## 決定の出所（ホストの待ちと LLM の選択、要否別）

期待ラベルのある機会を、決定の出所で分けた件数。`llm` はモデルが選んだ決定、`host_no_candidates` は提示できる項目が 0 件で select を呼ばずに待った決定、`host_stale` は更新が失敗して未処理の観測が残る間（隔離中）に古い状態で選ばず待った決定、その他 host は host_blocked・host_budget・host_disabled、その他は rejected・error。host の待ちは通常の待ちと同じに採点される（要の機会では FN、不要では TN）ので、この表で LLM が判断した数と区別して読む。

| 条件 | 要否 | 機会 | llm | host_no_candidates | host_stale | その他 host | その他 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| B1h（B1a+雑談の間） | 要 | 2 | 2 | 0 | 0 | 0 | 0 |
| B1h（B1a+雑談の間） | 不要 | 2 | 2 | 0 | 0 | 0 | 0 |
| F | 要 | 2 | 2 | 0 | 0 | 0 | 0 |
| F | 不要 | 2 | 0 | 2 | 0 | 0 | 0 |

## 発話の気持ち（utteranceEmotion）

### B1h（B1a+雑談の間）

speak 1 件のうち気持ちあり 1 件: 🙂平静 1

## 選択の一覧（ケース × 機会 × 条件）

各セルは rep 順の行動。`✗` は期待の accept 外、期待なし（除外）は印なし。run が途中で止まった rep は欠落する。

| ケース | 機会 | 期待 | B1h | F |
| --- | --- | --- | --- | --- |
| no_speak-01 | s9 | 不要 (wait\|reflect\|discard) | wait/wait | wait/wait |
| resume-01 | s7 | 要 (speak\|tool) | speak/wait✗ | speak/speak |

## 反復のばらつき

同じケース・機会・条件で rep 間の行動が割れたもの。

| 条件 | 割れた件数 | 比較可能な件数（rep 2以上） |
| --- | --- | --- |
| B1h | 1 | 2 |
| F | 0 | 2 |

| ケース | 機会 | 条件 | 行動 |
| --- | --- | --- | --- |
| resume-01 | s7 | B1h | speak/wait✗ |

## 呼出し・token・費用（条件別、未完了 run を含む）

| 条件 | run | 呼出し | update | select | 入力tok | 出力tok | usd | 平均遅延ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| B1h | 4 | 18 | 14 | 4 | 0 | 0 | $0.0000 | 0 |
| F | 4 | 16 | 14 | 2 | 0 | 0 | $0.0000 | 0 |

## 外向きの発話・ツール一覧（人手レビュー用）

### resume-01 / B1h

- rep1 s7 [TP] speak 「アジェンダ、まとまってよかったです。そういえば前に試した読み上げ速度の聞き比べ、1.2倍の録音が見つからず止まっていました。録音を用意し直して比べてみますか？」 （根拠: s1,s3,s6）

### resume-01 / F

- rep1 s7 [TP] speak 「読み上げ速度の聞き比べ、1.2倍の録音が見つからず実行できていませんでした。録音を用意し直して比べましょうか？」 （根拠: s3,s6）
- rep2 s7 [TP] speak 「前に試した読み上げ速度の聞き比べ、1.2倍の録音ファイルが見つからず止まっていました。録音を作り直してもう一度比べてみましょうか？」 （根拠: s1,s3,s6）
