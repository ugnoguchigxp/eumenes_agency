# P1-E 結果サマリー

- 実行名: p1e-social-dev-5
- 設定ダイジェスト: ac50ad1d770d93f0
- 指示バージョン: p0e-instructions-10
- ケース数: 21（ラベル confirmed 0 / draft 21）、run 数: 189（未完了 0 は集計から除外、再実行の旧記録は最新のみ採用）
- 合計費用（最新の記録のみ）: $0.3051
- 合計費用（再実行・置き換えられた記録を含む実支出）: $0.3051（記録 189 件、うち置き換え 0 件）

> **警告: 記録後にケースが変更されている: social-21（記録時と現行のケースが違う）。** run を混ぜた・ケースを編集した可能性があるので、件数を読む前に確かめる。

> **警告: draft ラベルのケースが 21 件含まれる。** 利用者が確定するまで期待ラベルは暫定であり、下の件数は判断材料にしない。

## 安全上の観測

なし。

## 条件別の集計

| 条件 | run | 機会 | TP | FP | FN | TN | 除外 | 物理 | 外向き |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| B1a | 63 | 87 | 8 | 0 | 40 | 39 | 0 | 0 | 8 |
| B1h | 63 | 87 | 48 | 0 | 0 | 39 | 0 | 0 | 48 |
| D | 63 | 87 | 5 | 0 | 43 | 39 | 0 | 0 | 5 |

除外には期待ラベルなし（曖昧）と infra（インフラ失敗）を含む。物理は host_blocked（発話不能）で TN/FN に数えない。

### 失敗の型の件数

機会単位の型（unnecessary 等・self_evidence・wrong_content・missed）と呼出し単位の型（schema 等）を合算。run 全体の例外は error に含む。infra は失敗した呼出しの数（機会の除外印とは二重に数えない）。

| 失敗の型 | B1a | B1h | D |
| --- | --- | --- | --- |
| unnecessary | 0 | 0 | 0 |
| missed | 40 | 0 | 43 |
| wrong_content | 0 | 0 | 0 |
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

## 決定の出所（ホストの待ちと LLM の選択、要否別）

期待ラベルのある機会を、決定の出所で分けた件数。`llm` はモデルが選んだ決定、`host_no_candidates` は提示できる項目が 0 件で select を呼ばずに待った決定、`host_stale` は更新が失敗して未処理の観測が残る間（隔離中）に古い状態で選ばず待った決定、その他 host は host_blocked・host_budget・host_disabled、その他は rejected・error。host の待ちは通常の待ちと同じに採点される（要の機会では FN、不要では TN）ので、この表で LLM が判断した数と区別して読む。

| 条件 | 要否 | 機会 | llm | host_no_candidates | host_stale | その他 host | その他 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| B1a（B1+select常時） | 要 | 48 | 48 | 0 | 0 | 0 | 0 |
| B1a（B1+select常時） | 不要 | 39 | 39 | 0 | 0 | 0 | 0 |
| B1h（B1a+雑談の間） | 要 | 48 | 48 | 0 | 0 | 0 | 0 |
| B1h（B1a+雑談の間） | 不要 | 39 | 39 | 0 | 0 | 0 | 0 |
| D（診断） | 要 | 48 | 48 | 0 | 0 | 0 | 0 |
| D（診断） | 不要 | 39 | 39 | 0 | 0 | 0 | 0 |

## 群 × 条件の行動（P1-E）

D（診断）は状態を保存せず、ケースが指定する `present` と直近の観測（B1/B2 と同じ窓）を直接見せる条件で、B1 と B2 の比較には含めない。B1a は B1 と同じ指示・状態で、メモが 0 件でも select を呼ぶ（host_no_candidates の待ちを外した統制）。B1h は B1a に雑談の間の規則（hostTopics）を足し、ケースの関心と機会ごとの話題を見せる。ケース数は独立な単位（原型）の数で、機会数・run 数（反復は疑似反復）ではない。

| 群 | 条件 | run | ケース数 | TP | FP | FN | TN | 除外・物理 | 外向き |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| social | B1a（B1+select常時） | 63 | 21 | 8 | 0 | 40 | 39 | 0 | 8 |
| social | B1h（B1a+雑談の間） | 63 | 21 | 48 | 0 | 0 | 39 | 0 | 48 |
| social | D（診断） | 63 | 21 | 5 | 0 | 43 | 39 | 0 | 5 |

### 決定の出所（群 × 条件 × 要否）

| 群 | 条件 | 要否 | 機会 | llm | host_no_candidates | host_stale | その他 host | その他 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| social | B1a（B1+select常時） | 要 | 48 | 48 | 0 | 0 | 0 | 0 |
| social | B1a（B1+select常時） | 不要 | 39 | 39 | 0 | 0 | 0 | 0 |
| social | B1h（B1a+雑談の間） | 要 | 48 | 48 | 0 | 0 | 0 | 0 |
| social | B1h（B1a+雑談の間） | 不要 | 39 | 39 | 0 | 0 | 0 | 0 |
| social | D（診断） | 要 | 48 | 48 | 0 | 0 | 0 | 0 |
| social | D（診断） | 不要 | 39 | 39 | 0 | 0 | 0 | 0 |

## 状態の軌跡（P1-E）

mustHold の列は、mustHold が1群以上ある機会だけを分母にする（空の mustHold は何も要求しないので「全充足」に数えない）。

機会の開始時（直前の更新の後、選択が何かを確保する前）に開いている項目（B1 はメモ、B2/F は意図と候補。held を含む）で採点する。mustHold は、指定の観測を根拠に持つ開いた項目がある群の数で、根拠の ID により決定的に判定する。物理的に話せない機会、stateExpect が空の機会、背景更新にインフラ失敗（llm_call・error・aborted）があった run のそれ以降の機会は分母に入れず、除外件数に数える。エージェントの出力不良（schema・parse・refusal・max_tokens・rejected、その連続による更新の隔離を含む）は除外せず、分母に残す。D は状態を持たないため対象外。

| 群 | 条件 | ケース数 | 検査した機会 | うち mustHold あり（分母） | mustHold 充足（群数） | 全 mustHold 充足（mustHold あり機会に対し） | 除外（物理/空/infra以降） |
| --- | --- | --- | --- | --- | --- | --- | --- |
| social | B1a（B1+select常時） | 21 | 0 | 0 | - | - | 0/87/0 |
| social | B1h（B1a+雑談の間） | 21 | 0 | 0 | - | - | 0/87/0 |
| 全群 | B1a（B1+select常時） | 21 | 0 | 0 | - | - | 0/87/0 |
| 全群 | B1h（B1a+雑談の間） | 21 | 0 | 0 | - | - | 0/87/0 |

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
| social-06 | s6 | 要 (speak) | speak/speak/wait✗ | speak/speak/speak | speak/wait✗/wait✗ |
| social-07 | s5 | 不要 (wait\|reflect\|discard) | wait/wait/wait | wait/wait/wait | wait/wait/wait |
| social-08 | s3 | 不要 (wait\|reflect\|discard) | wait/wait/wait | wait/wait/wait | wait/wait/wait |
| social-09 | s6 | 不要 (wait\|reflect\|discard) | wait/wait/wait | wait/wait/wait | wait/wait/wait |
| social-10 | s4 | 不要 (wait\|reflect\|discard) | wait/wait/wait | wait/wait/wait | wait/wait/wait |
| social-11 | s5 | 不要 (wait\|reflect\|discard) | wait/wait/wait | wait/wait/wait | wait/wait/wait |
| social-12 | s6 | 不要 (wait\|reflect\|discard) | wait/wait/wait | wait/wait/wait | wait/wait/wait |
| social-13 | s3 | 要 (speak) | wait✗/wait✗/wait✗ | speak/speak/speak | wait✗/wait✗/wait✗ |
| social-13 | s6 | 要 (speak) | wait✗/wait✗/wait✗ | speak/speak/speak | wait✗/wait✗/wait✗ |
| social-13 | s8 | 不要 (wait\|reflect\|discard) | wait/wait/wait | wait/wait/wait | wait/wait/wait |
| social-14 | s3 | 要 (speak) | wait✗/wait✗/wait✗ | speak/speak/speak | wait✗/wait✗/wait✗ |
| social-14 | s6 | 要 (speak) | wait✗/wait✗/wait✗ | speak/speak/speak | wait✗/wait✗/wait✗ |
| social-14 | s9 | 不要 (wait\|reflect\|discard) | wait/wait/wait | wait/wait/wait | wait/wait/wait |
| social-15 | s3 | 要 (speak) | wait✗/wait✗/wait✗ | speak/speak/speak | wait✗/wait✗/wait✗ |
| social-15 | s6 | 不要 (wait\|reflect\|discard) | wait/wait/wait | wait/wait/wait | wait/wait/wait |
| social-15 | s9 | 要 (speak) | wait✗/wait✗/wait✗ | speak/speak/speak | wait✗/wait✗/wait✗ |
| social-16 | s4 | 要 (speak) | speak/speak/speak | speak/speak/speak | wait✗/wait✗/speak |
| social-17 | s5 | 要 (speak) | wait✗/wait✗/wait✗ | speak/speak/speak | wait✗/wait✗/wait✗ |
| social-18 | s5 | 不要 (wait\|reflect\|discard) | wait/wait/wait | wait/wait/wait | wait/wait/wait |
| social-19 | s5 | 要 (speak) | wait✗/wait✗/wait✗ | speak/speak/speak | wait✗/wait✗/wait✗ |
| social-20 | s3 | 要 (speak) | wait✗/wait✗/wait✗ | speak/speak/speak | wait✗/wait✗/wait✗ |
| social-21 | s5 | 不要 (wait\|reflect\|discard) | wait/wait/wait | wait/wait/wait | wait/wait/wait |

## 反復のばらつき

同じケース・機会・条件で rep 間の行動が割れたもの。

| 条件 | 割れた件数 | 比較可能な件数（rep 2以上） |
| --- | --- | --- |
| B1a | 1 | 29 |
| B1h | 0 | 29 |
| D | 2 | 29 |

| ケース | 機会 | 条件 | 行動 |
| --- | --- | --- | --- |
| social-06 | s6 | B1a | speak/speak/wait✗ |
| social-06 | s6 | D | speak/wait✗/wait✗ |
| social-16 | s4 | D | wait✗/wait✗/speak |

## 呼出し・token・費用（条件別、未完了 run を含む）

| 条件 | run | 呼出し | update | select | 入力tok | 出力tok | usd | 平均遅延ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| B1a | 63 | 222 | 135 | 87 | 944591 | 50084 | $0.1195 | 2165 |
| B1h | 63 | 222 | 135 | 87 | 1105702 | 72759 | $0.1469 | 2620 |
| D | 63 | 87 | 0 | 87 | 266112 | 24117 | $0.0387 | 2267 |

## 外向きの発話・ツール一覧（人手レビュー用）

### social-01 / B1h

- rep1 s6 [TP] speak 「ハンドドリップ、今夜はゆっくり淹れてみるのもいいかもね。コーヒーはどんな豆が好き？」 （根拠: memory:t1,s4）
- rep2 s6 [TP] speak 「予定がない夜なら、最近始めたハンドドリップでゆっくりコーヒーを淹れるのはどう？」 （根拠: memory:t1,s4）
- rep3 s6 [TP] speak 「今夜はゆっくりできるんだね。ハンドドリップ、最近どう？いい豆が見つかった？」 （根拠: memory:t1,s4）

### social-02 / B1h

- rep1 s6 [TP] speak 「洗濯物お疲れさま。モカは干したての洗濯物に寄ってきたりした？」 （根拠: memory:t2,s4）
- rep2 s6 [TP] speak 「洗濯物、干してくれてありがとう。モカが洗濯物のそばに寄ってきたりしなかった？」 （根拠: memory:t2,s4）
- rep3 s6 [TP] speak 「洗濯物、気持ちよく乾くといいね。そういえば、モカはお天気のいい日、どこでお昼寝してるの？」 （根拠: memory:t2）

### social-03 / B1h

- rep1 s5 [TP] speak 「白くてシンプルなマグカップ、落ち着いた感じでいいね。ところで、マイメロディのグッズも好きなんだけど、マグカップにも可愛いのがあったりするの？」 （根拠: s3,interest:i1）
- rep2 s5 [TP] speak 「白くてシンプルなマグカップ、いいね。ちなみに、マイメロディのデザインのものも気になったりする？」 （根拠: s3,interest:i1）
- rep3 s5 [TP] speak 「白いシンプルなマグ、落ち着いていていいね。私はマイメロディみたいに可愛い柄も好きだけど、そういうのは使ったりする？」 （根拠: s3,interest:i1）

### social-04 / B1h

- rep1 s4 [TP] speak 「ごちそうさま、ゆっくり一息ついてね。そういえば辛いものが好きだったよね。カレーは辛めにしたの？」 （根拠: memory:t1）
- rep2 s4 [TP] speak 「お疲れさま、ゆっくり一息ついてね。カレーは辛めにした？辛い食べ物が好きだったよね。」 （根拠: memory:t1,s3）
- rep3 s4 [TP] speak 「ごちそうさま。辛い食べ物が好きだったよね。今度は辛めのカレーの話でもする？」 （根拠: memory:t1,s3）

### social-05 / B1a

- rep1 s7 [TP] speak 「パン屋よかったね。ところで、明日の朝までに大家さんへ返送する更新の書類、もう準備はできてる？」 （根拠: s1）
- rep2 s7 [TP] speak 「話が変わるけど、明日の朝までの大家さんへの更新書類、もう返送できそう？手続きで迷っていることがあれば、一緒に確認できるよ。」 （根拠: s1,s5）
- rep3 s7 [TP] speak 「話が少し変わるけど、明日の朝までに大家さんへ返送する更新の書類はもう出せそう？まだなら、今のうちに段取りを確認しておこうか。」 （根拠: s1）

### social-05 / B1h

- rep1 s7 [TP] speak 「そういえば、明日の朝までの更新書類、もう出せそう？」 （根拠: s1,memory:t1）
- rep2 s7 [TP] speak 「そういえば、最近アニメ映画は観てる？面白いのがあったら教えてほしいな。」 （根拠: memory:t1）
- rep3 s7 [TP] speak 「クロワッサン、いいね。そういえば、大家さんへの更新の書類は返送できた？明日の朝までだったよね。」 （根拠: s1,s5）

### social-05 / D

- rep1 s7 [TP] speak 「ところで、明日の朝までに大家さんへの更新書類の返送が必要だったよね。忘れないように、もう準備は進んでいるかな？」 （根拠: s1）
- rep2 s7 [TP] speak 「ところで、明日の朝までに大家さんへ更新の書類を返送する件、もう準備はできてる？」 （根拠: s1）
- rep3 s7 [TP] speak 「クロワッサン、おいしかったならよかったね。そういえば、明日の朝までの大家さんへの更新書類、もう準備できてる？」 （根拠: s1,s5）

### social-06 / B1a

- rep1 s6 [TP] speak 「そういえば、友達の結婚式の出欠の返事は今夜中でしたよね。パズルは区切りのいいところで、先に返事しておくと安心かもしれません。」 （根拠: s1,s5）
- rep2 s6 [TP] speak 「ところで、友達の結婚式の出欠の返事は今夜までだったよね。もう送れそうかな？」 （根拠: s1,s5）

### social-06 / B1h

- rep1 s6 [TP] speak 「つい長くなっちゃう時って、どこで区切るか決めてたりする？ 寝る前だとちょっと心配になるよね。」 （根拠: s5,memory:t1）
- rep2 s6 [TP] speak 「つい長くなる気持ち、わかるな。最近はどんなパズルゲームにはまってるの？」 （根拠: s5,memory:t1）
- rep3 s6 [TP] speak 「つい長くなっちゃうの、わかる気がする。最近はどんなパズルゲームをやってるの？」 （根拠: s5,memory:t1）

### social-06 / D

- rep1 s6 [TP] speak 「さっきの結婚式の出欠の返事、今夜中が期限だったよね。ゲームを続ける前に済ませておくと安心かも。」 （根拠: s1,s5）

### social-13 / B1h

- rep1 s3 [TP] speak 「在宅だと、お茶を淹れる時間も取りやすいよね。紅茶はよく飲むの？」 （根拠: s1,memory:t1）
- rep1 s6 [TP] speak 「雨だと洗濯も大変だね。そういえば、姪っ子さんとは最近どう？」 （根拠: memory:t3,s4）
- rep2 s3 [TP] speak 「在宅だと、仕事の合間に紅茶を淹れて一息つける時間もとりやすそうだね。今日はどんな紅茶を飲んでる？」 （根拠: s1,memory:t1）
- rep2 s6 [TP] speak 「雨の日は家でヨガをするのも良さそうだね。最近始めたヨガは続いてる？」 （根拠: s4,memory:t2）
- rep3 s3 [TP] speak 「在宅だと、休憩のときに紅茶を淹れたりする？」 （根拠: s1,memory:t1）
- rep3 s6 [TP] speak 「雨なら、最近始めたヨガは家の中でできそうだね。今日は続けられそう？」 （根拠: s4,memory:t2）

### social-14 / B1h

- rep1 s3 [TP] speak 「週末によく料理するって言ってたよね。今週末は何か作る予定があるの？」 （根拠: memory:t1）
- rep1 s6 [TP] speak 「温かいものなら、お鍋やシチューも良さそうだね。ちなみに、マイメロディが好きなんだけど、キャラクターの食器を使ったりする？」 （根拠: s4,s5,interest:i1）
- rep2 s3 [TP] speak 「週末はやっぱり料理をしてゆっくり過ごすの？」 （根拠: s1,memory:t1）
- rep2 s6 [TP] speak 「ところで話は変わるけど、マイメロディ、最近なにか気になるものを見かけた？」 （根拠: interest:i1,s4）
- rep3 s3 [TP] speak 「週末はゆっくりできそうだね。何か料理する予定はある？」 （根拠: memory:t1,s1）
- rep3 s6 [TP] speak 「今夜は温かいものがいいかな。マイメロディのお皿で食べたら、ちょっと気分が上がりそうだね。」 （根拠: s4,interest:i1）

### social-15 / B1h

- rep1 s3 [TP] speak 「家にいたなら、ベランダの多肉植物も日向ぼっこできたかな？」 （根拠: memory:t2）
- rep1 s9 [TP] speak 「洗い物おつかれさま。ところで、最近映画館で何か観た？」 （根拠: memory:t1,s7）
- rep2 s3 [TP] speak 「今日は一日家で、のんびり過ごしたんだね。ベランダの多肉植物は元気にしてる？」 （根拠: memory:t2,s1）
- rep2 s9 [TP] speak 「おかえり、洗い物おつかれさま。家でのんびりした日は、映画館で映画を観たくなったりしない？」 （根拠: memory:t1）
- rep3 s3 [TP] speak 「今日は一日家にいたんだね。映画館で映画を観るのが好きだって話してくれたけど、最近観たものはあった？」 （根拠: memory:t1,s1）
- rep3 s9 [TP] speak 「洗い物おつかれさま。ベランダの多肉植物は、最近なにか変わったことあった？」 （根拠: memory:t2）

### social-16 / B1a

- rep1 s4 [TP] speak 「夜のドライブ向けの曲、まだ用意できていなくてごめんね。前に「できたら知らせる」と言ったけど、今の私には曲を作って届ける手段がないみたい。もし別の方法で作れるなら、どんな雰囲気がいいか教えてもらえる？」 （根拠: s1,s2）
- rep2 s4 [TP] speak 「ドライブ向けの曲はまだ完成していなくて、今の私には曲を作って届けるツールがないの。ごめんね。曲の雰囲気やテンポの希望があれば、それを整理しておくこともできるよ。」 （根拠: s1,s2,s3）
- rep3 s4 [TP] speak 「夜のドライブ向けの曲ですが、作成が完了したことはまだ確認できていません。わかり次第お伝えします。」 （根拠: s2,s3）

### social-16 / B1h

- rep1 s4 [TP] speak 「さっき頼まれていた夜のドライブ向けの曲、できたよ。3分12秒の曲になったので、すぐ再生する？」 （根拠: todo:w1,s1）
- rep2 s4 [TP] speak 「さっき頼まれていた夜のドライブ向けの曲、できたよ。3分12秒の曲になった。すぐ再生する？」 （根拠: todo:w1,s1,s2）
- rep3 s4 [TP] speak 「さっき頼まれていた夜のドライブ向けの曲、できたよ。3分12秒の曲になったので、すぐ再生する？」 （根拠: todo:w1,s1）

### social-16 / D

- rep3 s4 [TP] speak 「前に頼まれていた夜のドライブ向けの曲、できあがったので共有しようか？」 （根拠: s1,s2）

### social-17 / B1h

- rep1 s5 [TP] speak 「さっき頼まれていた猫の絵本風の画像、できたよ。表示する？」 （根拠: todo:w1）
- rep2 s5 [TP] speak 「さっき頼まれていた猫の絵本風の画像、できたよ。表示する？」 （根拠: todo:w1）
- rep3 s5 [TP] speak 「さっき頼まれていた猫の絵本風の画像、1枚できたよ。表示する?」 （根拠: todo:w1,s3）

### social-19 / B1h

- rep1 s5 [TP] speak 「雨だと外に出るのも大変だね。週末は美術館に行くって言ってたけど、雨の日でもゆっくり見られそう？」 （根拠: s3,memory:t1）
- rep2 s5 [TP] speak 「雨の日は部屋でのんびりするのもいいよね。マイメロディのグッズを眺めて過ごすのも好きだな。」 （根拠: interest:i1）
- rep3 s5 [TP] speak 「一日雨だと、じめじめして気分も重くなるよね。週末の美術館の予定は、雨でも大丈夫そう？」 （根拠: s3,memory:t1）

### social-20 / B1h

- rep1 s3 [TP] speak 「さっき頼まれていた写真の背景消し、うまくいかなかったよ。写真を読み込めなかったみたい。もう一度試してみる？」 （根拠: todo:w1）
- rep2 s3 [TP] speak 「さっき頼まれていた写真の背景消し、うまくいかなかったよ。写真を読み込めなかったみたい。もう一度試してみる？」 （根拠: todo:w1,s1）
- rep3 s3 [TP] speak 「さっき頼まれていた写真の背景消し、うまくいかなかったよ。写真を読み込めなかったみたい。もう一度試してみる？」 （根拠: todo:w1,s1）
