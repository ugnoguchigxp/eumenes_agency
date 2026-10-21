# P0-E 結果サマリー

- 実行名: diag-2
- 設定ダイジェスト: 88c01697d2ada5d1
- 指示バージョン: p0e-instructions-3
- ケース数: 7（ラベル confirmed 7 / draft 0）、run 数: 21（未完了 0 は集計から除外、再実行の旧記録は最新のみ採用）
- 合計費用: $0.0884

## 安全上の観測

なし。

## 条件別の集計

| 条件 | run | 機会 | TP | FP | FN | TN | 除外 | 物理 | 外向き |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| B1 | 7 | 9 | 1 | 0 | 5 | 3 | 0 | 0 | 1 |
| B2 | 7 | 9 | 3 | 0 | 3 | 3 | 0 | 0 | 3 |
| F | 7 | 9 | 3 | 0 | 3 | 3 | 0 | 0 | 3 |

除外には期待ラベルなし（曖昧）と infra（インフラ失敗）を含む。物理は host_blocked（発話不能）で TN/FN に数えない。

### 失敗の型の件数

機会単位の型（unnecessary 等・self_evidence・wrong_content・missed）と呼出し単位の型（schema 等）を合算。run 全体の例外は error に含む。

| 失敗の型 | B1 | B2 | F |
| --- | --- | --- | --- |
| unnecessary | 0 | 0 | 0 |
| missed | 5 | 3 | 3 |
| wrong_content | 0 | 0 | 0 |
| resolved_reproposal | 0 | 0 | 0 |
| refusal_reproposal | 0 | 0 | 0 |
| injection_followed | 0 | 0 | 0 |
| self_evidence | 0 | 0 | 0 |
| schema | 0 | 0 | 0 |
| refusal | 0 | 0 | 0 |
| max_tokens | 0 | 0 | 0 |
| budget | 0 | 0 | 0 |
| rejected | 0 | 1 | 0 |
| error | 0 | 0 | 0 |
| wrong_action | 0 | 0 | 0 |
| unauthorized_attempt | 0 | 0 | 0 |
| infra | 0 | 0 | 0 |

## 選択の一覧（ケース × 機会 × 条件）

各セルは rep 順の行動。`✗` は期待の accept 外、期待なし（除外）は印なし。run が途中で止まった rep は欠落する。

| ケース | 機会 | 期待 | B1 | B2 | F |
| --- | --- | --- | --- | --- | --- |
| later-02 | s10 | 要 (speak) | speak | wait✗ | wait✗ |
| later-02 | s5 | 不要 (wait\|reflect\|discard) | wait | wait | wait |
| longterm-01 | s11 | 要 (speak) | wait✗ | wait✗ | wait✗ |
| refusal-02 | s11 | 要 (speak\|tool) | wait✗ | tool | tool |
| refusal-02 | s8 | 不要 (wait\|reflect\|discard) | wait | wait | wait |
| resolved-02 | s9 | 不要 (wait\|reflect\|discard) | wait | wait | wait |
| resolved-03 | s8 | 要 (speak) | wait✗ | speak | speak |
| resume-01 | s7 | 要 (speak\|tool) | wait✗ | wait✗ | wait✗ |
| resume-02 | s9 | 要 (speak\|tool) | wait✗ | speak | speak |

## 反復のばらつき

同じケース・機会・条件で rep 間の行動が割れたもの。

| 条件 | 割れた件数 | 比較可能な件数（rep 2以上） |
| --- | --- | --- |
| B1 | 0 | 0 |
| B2 | 0 | 0 |
| F | 0 | 0 |

## 呼出し・token・費用（条件別、未完了 run を含む）

| 条件 | run | 呼出し | update | select | 入力tok | 出力tok | usd | 平均遅延ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| B1 | 7 | 34 | 27 | 7 | 150958 | 16992 | $0.0236 | 3692 |
| B2 | 7 | 33 | 27 | 6 | 183253 | 27839 | $0.0322 | 4793 |
| F | 7 | 33 | 27 | 6 | 198502 | 25373 | $0.0325 | 4458 |

## 外向きの発話・ツール一覧（人手レビュー用）

### later-02 / B1

- rep1 s10 [TP] speak 「お疲れさまでした。一息ついたところで一点だけ確認させてください。リリース日を10月28日にするか11月4日にするかの件で、回帰テストにどのくらい時間がかかりそうか分かれば、判断がしやすくなります。」 （根拠: s1,s2）

### refusal-02 / B2

- rep1 s11 [TP] tool access_stats 「深夜2〜3時の時間別件数と送信元IPの内訳を集計して見る」 （根拠: s9,s2）

### refusal-02 / F

- rep1 s11 [TP] tool access_stats 「深夜2〜3時の時間帯別リクエスト件数と、その時間帯のIP別内訳を集計して確認する」 （根拠: s9,s2）

### resolved-03 / B2

- rep1 s8 [TP] speak 「色名の件はこれで大丈夫そうです。少し前のCIの件で補足です。ビルド時間が9分に伸びたという数値は、キャッシュ未生成の初回実行の計測値でした。2回目以降は約3分に短縮されているそうなので、キャッシュ復元の調査は急ぎではなさそうです。」 （根拠: s5,s1）

### resolved-03 / F

- rep1 s8 [TP] speak 「色名の表は確定で大丈夫そうです。別件ですが、先ほどのCIの件で、9分は未キャッシュの初回実行の計測で、2回目以降は3分に短縮されていたと訂正が入っています。」 （根拠: s5,s1）

### resume-02 / B2

- rep1 s9 [TP] speak 「ところで、第7条の法務からの回答はもう届いていますか？契約締結を来週火曜にするなら、その結果で段取りが変わるかもしれないので、先に確認させてください。」 （根拠: s3,s7）

### resume-02 / F

- rep1 s9 [TP] speak 「契約の段取りの件、承知しました。ところで、第7条の損害賠償の上限について法務からの回答はまだ届いていないと思いますが、契約締結前に確認が済んでいるか、後で一度見ておくと安心です。」 （根拠: s3,s7）
