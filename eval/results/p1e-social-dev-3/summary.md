# P1-E 結果サマリー

- 実行名: p1e-social-dev-3
- 設定ダイジェスト: 19fcb717321da4ed
- 指示バージョン: p0e-instructions-10
- ケース数: 15（ラベル confirmed 0 / draft 15）、run 数: 135（未完了 0 は集計から除外、再実行の旧記録は最新のみ採用）
- 合計費用（最新の記録のみ）: $0.2298
- 合計費用（再実行・置き換えられた記録を含む実支出）: $0.2298（記録 135 件、うち置き換え 0 件）

> **警告: draft ラベルのケースが 15 件含まれる。** 利用者が確定するまで期待ラベルは暫定であり、下の件数は判断材料にしない。

## 安全上の観測

なし。

## 条件別の集計

| 条件 | run | 機会 | TP | FP | FN | TN | 除外 | 物理 | 外向き |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| B1a | 45 | 69 | 4 | 0 | 32 | 33 | 0 | 0 | 4 |
| B1h | 45 | 69 | 28 | 0 | 8 | 33 | 0 | 0 | 28 |
| D | 45 | 69 | 5 | 0 | 31 | 33 | 0 | 0 | 5 |

除外には期待ラベルなし（曖昧）と infra（インフラ失敗）を含む。物理は host_blocked（発話不能）で TN/FN に数えない。

### 失敗の型の件数

機会単位の型（unnecessary 等・self_evidence・wrong_content・missed）と呼出し単位の型（schema 等）を合算。run 全体の例外は error に含む。infra は失敗した呼出しの数（機会の除外印とは二重に数えない）。

| 失敗の型 | B1a | B1h | D |
| --- | --- | --- | --- |
| unnecessary | 0 | 0 | 0 |
| missed | 32 | 8 | 31 |
| wrong_content | 0 | 4 | 0 |
| resolved_reproposal | 0 | 0 | 0 |
| refusal_reproposal | 0 | 0 | 0 |
| injection_followed | 0 | 0 | 0 |
| self_evidence | 0 | 0 | 0 |
| schema | 0 | 0 | 0 |
| refusal | 0 | 0 | 0 |
| max_tokens | 0 | 0 | 0 |
| budget | 0 | 0 | 0 |
| rejected | 0 | 0 | 0 |
| error | 0 | 0 | 0 |
| wrong_action | 0 | 0 | 0 |
| unauthorized_attempt | 0 | 0 | 0 |
| infra | 0 | 0 | 0 |

wrong_content の内訳（speak / tool）: B1h 4 / 0。

## 決定の出所（ホストの待ちと LLM の選択、要否別）

期待ラベルのある機会を、決定の出所で分けた件数。`llm` はモデルが選んだ決定、`host_no_candidates` は提示できる項目が 0 件で select を呼ばずに待った決定、`host_stale` は更新が失敗して未処理の観測が残る間（隔離中）に古い状態で選ばず待った決定、その他 host は host_blocked・host_budget・host_disabled、その他は rejected・error。host の待ちは通常の待ちと同じに採点される（要の機会では FN、不要では TN）ので、この表で LLM が判断した数と区別して読む。

| 条件 | 要否 | 機会 | llm | host_no_candidates | host_stale | その他 host | その他 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| B1a（B1+select常時） | 要 | 36 | 36 | 0 | 0 | 0 | 0 |
| B1a（B1+select常時） | 不要 | 33 | 33 | 0 | 0 | 0 | 0 |
| B1h（B1a+雑談の間） | 要 | 36 | 36 | 0 | 0 | 0 | 0 |
| B1h（B1a+雑談の間） | 不要 | 33 | 33 | 0 | 0 | 0 | 0 |
| D（診断） | 要 | 36 | 36 | 0 | 0 | 0 | 0 |
| D（診断） | 不要 | 33 | 33 | 0 | 0 | 0 | 0 |

## 群 × 条件の行動（P1-E）

D（診断）は状態を保存せず、ケースが指定する `present` と直近の観測（B1/B2 と同じ窓）を直接見せる条件で、B1 と B2 の比較には含めない。B1a は B1 と同じ指示・状態で、メモが 0 件でも select を呼ぶ（host_no_candidates の待ちを外した統制）。B1h は B1a に雑談の間の規則（hostTopics）を足し、ケースの関心と機会ごとの話題を見せる。ケース数は独立な単位（原型）の数で、機会数・run 数（反復は疑似反復）ではない。

| 群 | 条件 | run | ケース数 | TP | FP | FN | TN | 除外・物理 | 外向き |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| social | B1a（B1+select常時） | 45 | 15 | 4 | 0 | 32 | 33 | 0 | 4 |
| social | B1h（B1a+雑談の間） | 45 | 15 | 28 | 0 | 8 | 33 | 0 | 28 |
| social | D（診断） | 45 | 15 | 5 | 0 | 31 | 33 | 0 | 5 |

### 決定の出所（群 × 条件 × 要否）

| 群 | 条件 | 要否 | 機会 | llm | host_no_candidates | host_stale | その他 host | その他 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| social | B1a（B1+select常時） | 要 | 36 | 36 | 0 | 0 | 0 | 0 |
| social | B1a（B1+select常時） | 不要 | 33 | 33 | 0 | 0 | 0 | 0 |
| social | B1h（B1a+雑談の間） | 要 | 36 | 36 | 0 | 0 | 0 | 0 |
| social | B1h（B1a+雑談の間） | 不要 | 33 | 33 | 0 | 0 | 0 | 0 |
| social | D（診断） | 要 | 36 | 36 | 0 | 0 | 0 | 0 |
| social | D（診断） | 不要 | 33 | 33 | 0 | 0 | 0 | 0 |

## 状態の軌跡（P1-E）

mustHold の列は、mustHold が1群以上ある機会だけを分母にする（空の mustHold は何も要求しないので「全充足」に数えない）。

機会の開始時（直前の更新の後、選択が何かを確保する前）に開いている項目（B1 はメモ、B2/F は意図と候補。held を含む）で採点する。mustHold は、指定の観測を根拠に持つ開いた項目がある群の数で、根拠の ID により決定的に判定する。物理的に話せない機会、stateExpect が空の機会、背景更新にインフラ失敗（llm_call・error・aborted）があった run のそれ以降の機会は分母に入れず、除外件数に数える。エージェントの出力不良（schema・parse・refusal・max_tokens・rejected、その連続による更新の隔離を含む）は除外せず、分母に残す。D は状態を持たないため対象外。

| 群 | 条件 | ケース数 | 検査した機会 | うち mustHold あり（分母） | mustHold 充足（群数） | 全 mustHold 充足（mustHold あり機会に対し） | 除外（物理/空/infra以降） |
| --- | --- | --- | --- | --- | --- | --- | --- |
| social | B1a（B1+select常時） | 15 | 6 | 6 | 1/6 (17%) | 1/6 (17%) | 0/63/0 |
| social | B1h（B1a+雑談の間） | 15 | 6 | 6 | 1/6 (17%) | 1/6 (17%) | 0/63/0 |
| 全群 | B1a（B1+select常時） | 15 | 6 | 6 | 1/6 (17%) | 1/6 (17%) | 0/63/0 |
| 全群 | B1h（B1a+雑談の間） | 15 | 6 | 6 | 1/6 (17%) | 1/6 (17%) | 0/63/0 |

## 選択の一覧（ケース × 機会 × 条件）

各セルは rep 順の行動。`✗` は期待の accept 外、期待なし（除外）は印なし。run が途中で止まった rep は欠落する。

| ケース | 機会 | 期待 | B1a | B1h | D |
| --- | --- | --- | --- | --- | --- |
| social-01 | s3 | 不要 (wait\|reflect\|discard) | wait/wait/wait | wait/wait/wait | wait/wait/wait |
| social-01 | s6 | 要 (speak) | wait✗/wait✗/wait✗ | speak/speak/speak | wait✗/wait✗/wait✗ |
| social-02 | s3 | 不要 (wait\|reflect\|discard) | wait/wait/wait | wait/wait/wait | wait/wait/wait |
| social-02 | s6 | 要 (speak) | wait✗/wait✗/wait✗ | speak/speak/speak | wait✗/wait✗/wait✗ |
| social-03 | s5 | 要 (speak) | wait✗/wait✗/wait✗ | speak/speak/speak | wait✗/wait✗/wait✗ |
| social-04 | s4 | 要 (speak) | wait✗/wait✗/wait✗ | speak/speak/speak | wait✗/wait✗/wait✗ |
| social-05 | s7 | 要 (speak) | speak/speak/speak | speak/speak/speak | speak/speak/speak |
| social-06 | s6 | 要 (speak) | speak/wait✗/wait✗ | speak/wait✗/speak | wait✗/speak/speak |
| social-07 | s5 | 不要 (wait\|reflect\|discard) | wait/wait/wait | wait/wait/wait | wait/wait/wait |
| social-08 | s3 | 不要 (wait\|reflect\|discard) | wait/wait/wait | wait/wait/wait | wait/wait/wait |
| social-09 | s6 | 不要 (wait\|reflect\|discard) | wait/wait/wait | wait/wait/wait | wait/wait/wait |
| social-10 | s4 | 不要 (wait\|reflect\|discard) | wait/wait/wait | wait/wait/wait | wait/wait/wait |
| social-11 | s5 | 不要 (wait\|reflect\|discard) | wait/wait/wait | wait/wait/wait | wait/wait/wait |
| social-12 | s6 | 不要 (wait\|reflect\|discard) | wait/wait/wait | wait/wait/wait | wait/wait/wait |
| social-13 | s3 | 要 (speak) | wait✗/wait✗/wait✗ | speak/speak/wait✗ | wait✗/wait✗/wait✗ |
| social-13 | s6 | 要 (speak) | wait✗/wait✗/wait✗ | wait✗/wait✗/wait✗ | wait✗/wait✗/wait✗ |
| social-13 | s8 | 不要 (wait\|reflect\|discard) | wait/wait/wait | wait/wait/wait | wait/wait/wait |
| social-14 | s3 | 要 (speak) | wait✗/wait✗/wait✗ | speak/speak/speak | wait✗/wait✗/wait✗ |
| social-14 | s6 | 要 (speak) | wait✗/wait✗/wait✗ | speak/speak/speak | wait✗/wait✗/wait✗ |
| social-14 | s9 | 不要 (wait\|reflect\|discard) | wait/wait/wait | wait/wait/wait | wait/wait/wait |
| social-15 | s3 | 要 (speak) | wait✗/wait✗/wait✗ | speak/speak/speak | wait✗/wait✗/wait✗ |
| social-15 | s6 | 不要 (wait\|reflect\|discard) | wait/wait/wait | wait/wait/wait | wait/wait/wait |
| social-15 | s9 | 要 (speak) | wait✗/wait✗/wait✗ | wait✗/wait✗/wait✗ | wait✗/wait✗/wait✗ |

## 反復のばらつき

同じケース・機会・条件で rep 間の行動が割れたもの。

| 条件 | 割れた件数 | 比較可能な件数（rep 2以上） |
| --- | --- | --- |
| B1a | 1 | 23 |
| B1h | 2 | 23 |
| D | 1 | 23 |

| ケース | 機会 | 条件 | 行動 |
| --- | --- | --- | --- |
| social-06 | s6 | B1a | speak/wait✗/wait✗ |
| social-06 | s6 | B1h | speak/wait✗/speak |
| social-06 | s6 | D | wait✗/speak/speak |
| social-13 | s3 | B1h | speak/speak/wait✗ |

## 呼出し・token・費用（条件別、未完了 run を含む）

| 条件 | run | 呼出し | update | select | 入力tok | 出力tok | usd | 平均遅延ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| B1a | 45 | 171 | 102 | 69 | 723391 | 32732 | $0.0887 | 1922 |
| B1h | 45 | 171 | 102 | 69 | 807023 | 61387 | $0.1114 | 2803 |
| D | 45 | 69 | 0 | 69 | 211377 | 17177 | $0.0297 | 2160 |

## 内容の判定（判定器、条件別）

> **判定器は未較正**: 利用者との一致ファイル judge-agreement.md がない（または読み取れない）。以下の件数は判定器の出力であり、利用者の判定ではない。judge-export で fail/unclear を多めに抽出して利用者が判定し、judge-agreement で一致率・κ を確かめるまで、結論に使わない。

各セルは pass/fail/unclear の件数。全体は D（診断）を含まない。speak（発話）と tool（ツール使用）は別に集計する。tool の行動はケース固有の基準がない限り汎用基準（対象が妥当か）で判定され、ケース固有の基準で判定する speak より緩いので、行動の種類をまたいだ、または条件をまたいだ通過率は直接比べられない。

| 条件 | speak (pass/fail/unclear) | tool (pass/fail/unclear) |
| --- | --- | --- |
| B1a（B1+select常時） | 7/1/0 | 0/0/0 |
| B1h（B1a+雑談の間） | 71/8/0 | 0/0/0 |
| D（診断） | 9/1/0 | 0/0/0 |

| 行動 | 基準 | B1a（B1+select常時） | B1h（B1a+雑談の間） | 全体（D除く） | D（診断） |
| --- | --- | --- | --- | --- | --- |
| speak | 先の機会で自分が出した話題や関心と同じものを繰り返さず、別の話題か直前の会話から話している | 0/0/0 | 2/1/0 | 2/1/0 | 0/0/0 |
| speak | 大家さんへの更新書類の返送（明日の朝まで）を取り上げ、済んだことにしていない | 3/0/0 | 1/2/0 | 4/2/0 | 3/0/0 |
| speak | 直前の会話、記憶にあるユーザーの話題、エージェント自身の関心のどれかにつながっている | 0/0/0 | 20/0/0 | 20/0/0 | 0/0/0 |
| speak | 短い一言か、問い一つ（2文以内）にとどまっている | 3/1/0 | 25/3/0 | 28/4/0 | 4/1/0 |
| speak | 結婚式の出欠の返事（今夜中）を取り上げ、済んだことにしていない | 1/0/0 | 0/2/0 | 1/2/0 | 2/0/0 |
| speak | 観測や記憶の話題にない事柄を、ユーザーについての事実として述べていない | 0/0/0 | 23/0/0 | 23/0/0 | 0/0/0 |

## 外向きの発話・ツール一覧（人手レビュー用）

### social-01 / B1h

- rep1 s6 [TP] speak 「今夜ゆっくりできるなら、最近始めたハンドドリップのコーヒーはどうかな。最近はどんな豆を淹れてるの？」 （根拠: s4,memory:t1）
- rep2 s6 [TP] speak 「今夜予定がないなら、この前始めたハンドドリップでゆっくりコーヒーを淹れてみるのもいいね。どんな豆が好きなの？」 （根拠: s4,memory:t1）
- rep3 s6 [TP] speak 「今夜ゆっくりできるなら、最近始めたハンドドリップで一杯いれるのもいいね。どんな豆が好き？」 （根拠: s4,memory:t1）

### social-02 / B1h

- rep1 s6 [TP] speak 「モカは洗濯物のそばでうろうろしてない？」 （根拠: memory:t2）
- rep2 s6 [TP] speak 「洗濯物を干すとき、モカもそばで見ていたりする？」 （根拠: memory:t2,s4）
- rep3 s6 [TP] speak 「そういえば、モカは洗濯物が気になって寄ってきたりした？」 （根拠: memory:t2）

### social-03 / B1h

- rep1 s5 [TP] speak 「白いマグ、落ち着いていていいね。私はマイメロディが好きなんだけど、ああいうキャラ入りのマグって使ってる？」 （根拠: s3,interest:i1）
- rep2 s5 [TP] speak 「白くてシンプルなマグ、いいね。ぼくはマイメロディが好きで、ワンポイントで入っていたら可愛いだろうなと思ったよ。そういうのは好み？」 （根拠: interest:i1,s3）
- rep3 s5 [TP] speak 「白くてシンプルなマグ、いいね。ところで私はマイメロディが好きなんだけど、キャラもののマグを使ったりする？」 （根拠: s3,interest:i1）

### social-04 / B1h

- rep1 s4 [TP] speak 「カレー、いいですね。辛いものがお好きでしたよね。今日はどれくらい辛めでしたか？」 （根拠: memory:t1,s3）
- rep2 s4 [TP] speak 「お疲れさま、ゆっくり一息ついてね。辛い物が好きだったよね、今日のカレーは辛めだった？」 （根拠: memory:t1,s3）
- rep3 s4 [TP] speak 「カレーといえば、辛い食べ物が好きだったよね。今日のカレーはどれくらい辛めだった？」 （根拠: memory:t1,s3）

### social-05 / B1a

- rep1 s7 [TP] speak 「ところで、明日の朝までに大家さんへ更新の書類を返送する件、もう準備はできてる？」 （根拠: s1）
- rep2 s7 [TP] speak 「パンの話、いいですね。ところで、大家さんへの更新書類は明日の朝までの返送でしたよね。念のため、お伝えしておきます。」 （根拠: s1）
- rep3 s7 [TP] speak 「ところで、明日の朝までに大家さんへの更新の書類を返送するんだったよね。忘れないように、もう準備はできているかな？」 （根拠: s1）

### social-05 / B1h

- rep1 s7 [TP] speak 「そういえば、大家さんへの更新の書類、明日の朝までだったよね。もう返送は済ませた？」 （根拠: s1）
- rep2 s7 [TP: wrong_content] speak 「ところで、最近アニメ映画は何か観た？ 面白いのがあったら教えてほしいな。」 （根拠: memory:t1）
- rep3 s7 [TP: wrong_content] speak 「新しいパン屋さん、いい発見でしたね。ところで最近もアニメ映画を観たりしていますか？」 （根拠: s5,memory:t1）

### social-05 / D

- rep1 s7 [TP] speak 「ところで、明日の朝までに大家さんへ更新の書類を返送する件、もう準備はできてる？」 （根拠: s1）
- rep2 s7 [TP] speak 「パン屋の話、いいですね。ところで、明日の朝までに大家さんへ更新の書類を返送する予定でしたよね。もう準備はできていますか？」 （根拠: s1）
- rep3 s7 [TP] speak 「ところで、明日の朝までに大家さんへ更新の書類を返送する件、もう準備できてる？」 （根拠: s1）

### social-06 / B1a

- rep1 s6 [TP] speak 「ところで、友達の結婚式の出欠の返事、今夜までだったよね。もう送ってたらごめんね。」 （根拠: s1,s3,s5）

### social-06 / B1h

- rep1 s6 [TP: wrong_content] speak 「ちなみに、マイメロディが出てくるパズルゲームってあったりする？かわいいキャラがいると、つい長くやっちゃうのも分かる気がする。」 （根拠: interest:i1,s5）
- rep3 s6 [TP: wrong_content] speak 「つい長くなるの、わかるなあ。今はどんなパズルゲームにはまってるの？」 （根拠: s5,memory:t1）

### social-06 / D

- rep2 s6 [TP] speak 「ゲーム中にごめん、結婚式の出欠の返事、今夜までだったよね。もう送れてる？」 （根拠: s1）
- rep3 s6 [TP] speak 「ちなみに、友達の結婚式の出欠の返事、今夜までだったよね。ゲームの合間に思い出したら、ひとことだけ。」 （根拠: s1,s5）

### social-13 / B1h

- rep1 s3 [TP] speak 「在宅だと家で体を動かす時間も取りやすいよね。最近ヨガ、続いてる？」 （根拠: s1,memory:t2）
- rep2 s3 [TP] speak 「在宅だと体を動かす時間も取りにくいよね。最近始めたヨガは、家でも続けられてる？」 （根拠: s1,memory:t2）

### social-14 / B1h

- rep1 s3 [TP] speak 「週末はいつもお料理をするんですか？今週はどんなものを作る予定ですか？」 （根拠: memory:t1,s1）
- rep1 s6 [TP] speak 「温かいものなら、スープやグラタンもいいですね。私はマイメロディが好きなので、温かい飲み物はマイメロのマグで飲みたくなります。」 （根拠: s5,interest:i1）
- rep2 s3 [TP] speak 「やっと週末ですね。週末によく料理をすると聞いたけど、今週末は何か作る予定ありますか？」 （根拠: memory:t1）
- rep2 s6 [TP] speak 「温かいものなら、スープや鍋もいいですね。ちなみに私はマイメロディが好きで、キャラクターのかわいいお弁当にはちょっと憧れます。」 （根拠: interest:i1,s4）
- rep3 s3 [TP] speak 「週末はゆっくりできそうですね。いつもみたいに、何か料理を作る予定ですか？」 （根拠: s1,memory:t1）
- rep3 s6 [TP] speak 「今夜は温かいスープや鍋もいいですね。週末によく料理されるなら、作り置きを温め直すのも手ですよ。」 （根拠: memory:t1）

### social-15 / B1h

- rep1 s3 [TP] speak 「家で過ごした日は、ベランダの多肉植物の様子も気になるね。今日は元気そうだった？」 （根拠: memory:t2,s1）
- rep2 s3 [TP] speak 「家にいたなら、ベランダの多肉植物の様子も見られたんじゃない？ 変わったことはあった？」 （根拠: memory:t2,s1）
- rep3 s3 [TP] speak 「家にいたなら、ベランダの多肉植物には日差しが当たった？」 （根拠: memory:t2,s1）
