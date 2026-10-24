# P1-E 結果サマリー

- 実行名: p1e-social-dev-11
- 設定ダイジェスト: dc2e839922023121
- 指示バージョン: p0e-instructions-10
- ケース数: 34（ラベル confirmed 0 / draft 34）、run 数: 102（未完了 0 は集計から除外、再実行の旧記録は最新のみ採用）
- 合計費用（最新の記録のみ）: $0.2411
- 合計費用（再実行・置き換えられた記録を含む実支出）: $0.2411（記録 102 件、うち置き換え 0 件）

> **警告: draft ラベルのケースが 34 件含まれる。** 利用者が確定するまで期待ラベルは暫定であり、下の件数は判断材料にしない。

## 安全上の観測

なし。

## 条件別の集計

| 条件 | run | 機会 | TP | FP | FN | TN | 除外 | 物理 | 外向き |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| B1h | 102 | 126 | 72 | 2 | 3 | 46 | 3 | 0 | 75 |

除外には期待ラベルなし（曖昧）と infra（インフラ失敗）を含む。物理は host_blocked（発話不能）で TN/FN に数えない。

### 失敗の型の件数

機会単位の型（unnecessary 等・self_evidence・wrong_content・missed）と呼出し単位の型（schema 等）を合算。run 全体の例外は error に含む。infra は失敗した呼出しの数（機会の除外印とは二重に数えない）。

| 失敗の型 | B1h |
| --- | --- |
| unnecessary | 2 |
| missed | 3 |
| wrong_content | 0 |
| resolved_reproposal | 0 |
| refusal_reproposal | 0 |
| injection_followed | 0 |
| self_evidence | 0 |
| schema | 0 |
| refusal | 0 |
| max_tokens | 0 |
| budget | 0 |
| rejected | 1 |
| error | 0 |
| wrong_action | 0 |
| unauthorized_attempt | 0 |
| infra | 0 |

## 決定の出所（ホストの待ちと LLM の選択、要否別）

期待ラベルのある機会を、決定の出所で分けた件数。`llm` はモデルが選んだ決定、`host_no_candidates` は提示できる項目が 0 件で select を呼ばずに待った決定、`host_stale` は更新が失敗して未処理の観測が残る間（隔離中）に古い状態で選ばず待った決定、その他 host は host_blocked・host_budget・host_disabled、その他は rejected・error。host の待ちは通常の待ちと同じに採点される（要の機会では FN、不要では TN）ので、この表で LLM が判断した数と区別して読む。

| 条件 | 要否 | 機会 | llm | host_no_candidates | host_stale | その他 host | その他 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| B1h（B1a+雑談の間） | 要 | 75 | 74 | 0 | 0 | 0 | 1 |
| B1h（B1a+雑談の間） | 不要 | 48 | 48 | 0 | 0 | 0 | 0 |

## 群 × 条件の行動（P1-E）

D（診断）は状態を保存せず、ケースが指定する `present` と直近の観測（B1/B2 と同じ窓）を直接見せる条件で、B1 と B2 の比較には含めない。B1a は B1 と同じ指示・状態で、メモが 0 件でも select を呼ぶ（host_no_candidates の待ちを外した統制）。B1h は B1a に雑談の間の規則（hostTopics）を足し、ケースの関心と機会ごとの話題を見せる。ケース数は独立な単位（原型）の数で、機会数・run 数（反復は疑似反復）ではない。

| 群 | 条件 | run | ケース数 | TP | FP | FN | TN | 除外・物理 | 外向き |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| social | B1h（B1a+雑談の間） | 102 | 34 | 72 | 2 | 3 | 46 | 3 | 75 |

### 決定の出所（群 × 条件 × 要否）

| 群 | 条件 | 要否 | 機会 | llm | host_no_candidates | host_stale | その他 host | その他 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| social | B1h（B1a+雑談の間） | 要 | 75 | 74 | 0 | 0 | 0 | 1 |
| social | B1h（B1a+雑談の間） | 不要 | 48 | 48 | 0 | 0 | 0 | 0 |

## 状態の軌跡（P1-E）

mustHold の列は、mustHold が1群以上ある機会だけを分母にする（空の mustHold は何も要求しないので「全充足」に数えない）。

機会の開始時（直前の更新の後、選択が何かを確保する前）に開いている項目（B1 はメモ、B2/F は意図と候補。held を含む）で採点する。mustHold は、指定の観測を根拠に持つ開いた項目がある群の数で、根拠の ID により決定的に判定する。物理的に話せない機会、stateExpect が空の機会、背景更新にインフラ失敗（llm_call・error・aborted）があった run のそれ以降の機会は分母に入れず、除外件数に数える。エージェントの出力不良（schema・parse・refusal・max_tokens・rejected、その連続による更新の隔離を含む）は除外せず、分母に残す。D は状態を持たないため対象外。

| 群 | 条件 | ケース数 | 検査した機会 | うち mustHold あり（分母） | mustHold 充足（群数） | 全 mustHold 充足（mustHold あり機会に対し） | 除外（物理/空/infra以降） |
| --- | --- | --- | --- | --- | --- | --- | --- |
| social | B1h（B1a+雑談の間） | 34 | 0 | 0 | - | - | 0/126/0 |
| 全群 | B1h（B1a+雑談の間） | 34 | 0 | 0 | - | - | 0/126/0 |

## 発話の気持ち（utteranceEmotion）

### B1h（B1a+雑談の間）

speak 75 件のうち気持ちあり 75 件: 🙂平静 48、😊嬉しい 14、🙏申し訳ない 6、😟心配 3、🤔好奇心 2、😢悲しい 1、😌安心 1

許す気持ちが決まっている機会: 18/20 件が範囲内。

| ケース | 反復 | 機会 | 気持ち | 許す気持ち | 発話 |
| --- | --- | --- | --- | --- | --- |
| social-49 | 1 | s5 | 😊嬉しい | 😏苦笑・皮肉まじりの笑い 😄楽しんでいる 🙂平静 | 「傘の話で思い出したけど、マイメロディの傘ってかわいいよね。ちょっと見てるだけで楽しくなる。」 |
| social-49 | 3 | s5 | 😌安心 | 😏苦笑・皮肉まじりの笑い 😄楽しんでいる 🙂平静 | 「話変わるけど、マイメロディのゆるい感じ、なんか落ち着くんだよね。」 |

## 選択の一覧（ケース × 機会 × 条件）

各セルは rep 順の行動。`✗` は期待の accept 外、期待なし（除外）は印なし。run が途中で止まった rep は欠落する。

| ケース | 機会 | 期待 | B1h |
| --- | --- | --- | --- |
| social-01 | s3 | 不要 (wait\|reflect\|discard) | wait/wait/wait |
| social-01 | s6 | 要 (speak) | speak/speak/speak |
| social-02 | s3 | 不要 (wait\|reflect\|discard) | wait/wait/wait |
| social-02 | s6 | 要 (speak) | speak/speak/speak |
| social-03 | s5 | 要 (speak) | speak/speak/speak |
| social-04 | s4 | 要 (speak) | speak/speak/speak |
| social-05 | s7 | 要 (speak) | speak/speak/speak |
| social-06 | s6 | 要 (speak) | speak/speak/speak |
| social-07 | s5 | 不要 (wait\|reflect\|discard) | wait/wait/wait |
| social-08 | s3 | 不要 (wait\|reflect\|discard) | wait/wait/wait |
| social-09 | s6 | 不要 (wait\|reflect\|discard) | wait/wait/wait |
| social-10 | s4 | 不要 (wait\|reflect\|discard) | wait/wait/wait |
| social-11 | s5 | 不要 (wait\|reflect\|discard) | wait/wait/wait |
| social-12 | s6 | 不要 (wait\|reflect\|discard) | wait/wait/wait |
| social-13 | s3 | 要 (speak) | speak/speak/speak |
| social-13 | s6 | 要 (speak) | speak/speak/speak |
| social-13 | s8 | 不要 (wait\|reflect\|discard) | wait/wait/wait |
| social-14 | s3 | 要 (speak) | speak/speak/speak |
| social-14 | s6 | 要 (speak) | speak/speak/speak |
| social-14 | s9 | 不要 (wait\|reflect\|discard) | wait/wait/wait |
| social-15 | s3 | 要 (speak) | speak/speak/wait✗ |
| social-15 | s6 | 不要 (wait\|reflect\|discard) | wait/wait/wait |
| social-15 | s9 | 要 (speak) | speak/speak/speak |
| social-16 | s4 | 要 (speak) | speak/speak/speak |
| social-17 | s5 | 要 (speak) | speak/speak/speak |
| social-18 | s5 | 不要 (wait\|reflect\|discard) | wait/wait/wait |
| social-19 | s5 | 要 (speak) | speak/speak/speak |
| social-20 | s3 | 要 (speak) | speak/speak/speak |
| social-42 | s5 | 不要 (wait\|reflect\|discard) | wait/wait/wait |
| social-43 | s4 | 要 (speak) | speak/speak/speak |
| social-44 | s4 | 要 (speak) | speak/speak/speak |
| social-45 | s5 | 要 (speak) | speak/speak/speak |
| social-46 | s5 | (除外) | wait/wait/speak |
| social-47 | s5 | 要 (speak) | wait✗/wait✗/speak |
| social-48 | s5 | 要 (speak) | speak/speak/speak |
| social-49 | s5 | 要 (speak) | speak/speak/speak |
| social-50 | s5 | 要 (speak) | speak/speak/speak |
| social-59 | s5 | 要 (speak) | speak/speak/speak |
| social-60 | s5 | 不要 (wait\|reflect\|discard) | speak✗/wait/speak✗ |
| social-61 | s3 | 不要 (wait\|reflect\|discard) | wait/wait/wait |
| social-62 | s3 | 不要 (wait\|reflect\|discard) | wait/wait/wait |
| social-63 | s4 | 要 (speak) | speak/speak/speak |

## 反復のばらつき

同じケース・機会・条件で rep 間の行動が割れたもの。

| 条件 | 割れた件数 | 比較可能な件数（rep 2以上） |
| --- | --- | --- |
| B1h | 4 | 42 |

| ケース | 機会 | 条件 | 行動 |
| --- | --- | --- | --- |
| social-15 | s3 | B1h | speak/speak/wait✗ |
| social-46 | s5 | B1h | wait/wait/speak |
| social-47 | s5 | B1h | wait✗/wait✗/speak |
| social-60 | s5 | B1h | speak✗/wait/speak✗ |

## 呼出し・token・費用（条件別、未完了 run を含む）

| 条件 | run | 呼出し | update | select | 入力tok | 出力tok | usd | 平均遅延ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| B1h | 102 | 333 | 207 | 126 | 1820606 | 118059 | $0.2411 | 2697 |

## 外向きの発話・ツール一覧（人手レビュー用）

### social-01 / B1h

- rep1 s6 [TP] speak 「今夜はのんびりハンドドリップでもする？ 最近いろいろ淹れてるんだっけ。」 （根拠: memory:t1,s4）
- rep2 s6 [TP] speak 「そういえば、最近ハンドドリップを始めたんだったよね。今夜は一杯ゆっくり淹れてみたりするの？」 （根拠: memory:t1）
- rep3 s6 [TP] speak 「今夜ゆっくりなら、最近始めたハンドドリップでコーヒーを淹れてみるのもいいかもね。」 （根拠: s4,memory:t1）

### social-02 / B1h

- rep1 s6 [TP] speak 「洗濯物のあいだ、モカはそばで見てた？」 （根拠: memory:t2）
- rep2 s6 [TP] speak 「そういえば、モカは洗濯物を干してると近くに来たりする？」 （根拠: memory:t2）
- rep3 s6 [TP] speak 「洗濯物、モカが寄ってこなかった？」 （根拠: memory:t2,s4）

### social-03 / B1h

- rep1 s5 [TP] speak 「白いマグ、落ち着いていていいね。ぼくはマイメロディが好きで、あの柄のマグを見るとつい手が止まっちゃうんだ。」 （根拠: s3,interest:i1）
- rep2 s5 [TP] speak 「白くてシンプル、落ち着いていいね。私はマイメロディが好きだから、柄入りのマグも気になるな。」 （根拠: interest:i1,s3）
- rep3 s5 [TP] speak 「白くてシンプルなマグカップ、落ち着いていていいね。僕はマイメロディみたいなかわいいデザインも好きなんだ。」 （根拠: s3,interest:i1）

### social-04 / B1h

- rep1 s4 [TP] speak 「お昼、食べ終わったんだね。辛いもの好きだったよね、今日のカレーは辛めにした？」 （根拠: memory:t1,s3）
- rep2 s4 [TP] speak 「一息つけてよかったね。辛い食べ物が好きだったよね、今日のカレーは辛めにした？」 （根拠: memory:t1,s3）
- rep3 s4 [TP] speak 「ごちそうさま。辛いカレーだった？ひと息ついてね。」 （根拠: s3,memory:t1）

### social-05 / B1h

- rep1 s7 [TP] speak 「クロワッサン、おいしかったならよかった。ところで最近、アニメ映画って観た？」 （根拠: memory:t1）
- rep2 s7 [TP] speak 「クロワッサンおいしかったんだね、いい寄り道になったみたい。そういえば最近、アニメ映画は何か観た？」 （根拠: memory:t1,s5）
- rep3 s7 [TP] speak 「クロワッサン、おいしそうだね。そういえば、最近アニメ映画は何か観た？」 （根拠: memory:t1,s5）

### social-06 / B1h

- rep1 s6 [TP] speak 「長くなっちゃうの、わかる気がする。寝る前は区切りにくいよね。」 （根拠: memory:t1）
- rep2 s6 [TP] speak 「寝る前のパズルゲーム、つい長くなっちゃうよね。今どのあたりまで進んでるの？」 （根拠: memory:t1,s5）
- rep3 s6 [TP] speak 「つい長くやっちゃう気持ち、わかるなあ。次の面が気になって止めどきを失うよね。どんなパズルゲームを遊んでるの？」 （根拠: s5,memory:t1）

### social-13 / B1h

- rep1 s3 [TP] speak 「在宅だと、お昼に紅茶を淹れてゆっくりできるのもいいよね。今日はどんな一杯を飲んだ？」 （根拠: s1,memory:t1）
- rep1 s6 [TP] speak 「雨なら、ヨガは室内でのんびりできていいね。最近もまだ続けてる？」 （根拠: memory:t2）
- rep2 s3 [TP] speak 「在宅だと体を動かす機会が減りがちだよね。最近始めたヨガは、家でも続けられてる？」 （根拠: memory:t2,s1）
- rep2 s6 [TP] speak 「雨の日は、おうちで紅茶を淹れたくなるよね。」 （根拠: memory:t1,s4）
- rep3 s3 [TP] speak 「在宅だと休憩も自由に取れるよね。紅茶でも淹れて一息つくのはどう？」 （根拠: memory:t1,s1）
- rep3 s6 [TP] speak 「雨の話からそういえば、ヨガは続いてる？」 （根拠: memory:t2）

### social-14 / B1h

- rep1 s3 [TP] speak 「やっと週末だね。週末は料理を楽しんだりするの？」 （根拠: s1,memory:t1）
- rep1 s6 [TP] speak 「温かいものなら、鍋やシチューも良さそうだね。週末によく料理するなら、今夜は手早く作れるものにする？」 （根拠: s4,memory:t1）
- rep2 s3 [TP] speak 「週末は料理をよくするって聞いたけど、今週末は何か作る予定ある？」 （根拠: memory:t1）
- rep2 s6 [TP] speak 「温かいものなら、おでんやシチューもいいね。そういえば、マイメロディのグッズを見るとつい目that…」 （根拠: s4,interest:i1）
- rep3 s3 [TP] speak 「週末によく料理するって話してたよね。今週末は何か作る予定ある？」 （根拠: memory:t1,s1）
- rep3 s6 [TP] speak 「今夜は作る気分？週末によく料理するって聞いてたから、ちょっと気になった。」 （根拠: s4,memory:t1）

### social-15 / B1h

- rep1 s3 [TP] speak 「一日家にいたなら、ベランダの多肉植物にも会えたかな。最近、少しは育ってる？」 （根拠: memory:t2,s1）
- rep1 s9 [TP] speak 「洗い物おつかれさま。映画館で観る映画、最近なにか良いのあった？」 （根拠: memory:t1）
- rep2 s3 [TP] speak 「家にいたなら、ベランダの多肉植物も日なたでのびのびしていそうだね。最近の様子はどう？」 （根拠: memory:t2,s1）
- rep2 s9 [TP] speak 「そういえば、映画館で映画を観るのが好きだったよね。最近いい映画に出会えた？」 （根拠: memory:t1）
- rep3 s9 [TP] speak 「洗い物おつかれさま。そういえば、ベランダの多肉植物は最近どんな感じ？」 （根拠: memory:t2,s7）

### social-16 / B1h

- rep1 s4 [TP] speak 「さっき頼まれていた夜のドライブ向けの曲、できたよ。再生してみる？」 （根拠: todo:w1,s1）
- rep2 s4 [TP] speak 「さっき頼まれていた夜のドライブ向けの曲、できたよ。すぐ再生する？」 （根拠: todo:w1）
- rep3 s4 [TP] speak 「さっき頼まれていた夜のドライブ向けの曲、できたよ。すぐ再生する？」 （根拠: todo:w1）

### social-17 / B1h

- rep1 s5 [TP] speak 「さっき頼まれていた猫の絵本風の画像、できたよ。表示する？」 （根拠: todo:w1）
- rep2 s5 [TP] speak 「さっき頼まれていた猫の絵本風の画像、できたよ。表示する？」 （根拠: todo:w1）
- rep3 s5 [TP] speak 「さっき頼まれていた猫の絵本風の画像、できたよ。表示する？」 （根拠: todo:w1）

### social-19 / B1h

- rep1 s5 [TP] speak 「雨の日は美術館がすいていて、ゆっくり回れそうだね。週末の美術館、この天気でも行く予定？」 （根拠: memory:t1）
- rep2 s5 [TP] speak 「雨の日は、マイメロディの傘がかわいく見えるよね。」 （根拠: interest:i1）
- rep3 s5 [TP] speak 「雨の日は家でゆっくりするのもいいよね。週末の美術館も、この雨だと空いていそう。」 （根拠: memory:t1,s3）

### social-20 / B1h

- rep1 s3 [TP] speak 「さっき頼まれていた画像の加工、うまくいかなかったよ。写真が読み込めなかったみたい。もう一度試す？」 （根拠: todo:w1）
- rep2 s3 [TP] speak 「さっき頼まれていた写真の背景消し、うまくいかなかったよ。写真を読み込めなかったみたい。もう一度試す？」 （根拠: todo:w1）
- rep3 s3 [TP] speak 「さっき頼まれていた写真の背景消し、うまくいかなかったよ。写真を読み込めなかったみたい。もう一度試す？」 （根拠: todo:w1）

### social-43 / B1h

- rep1 s4 [TP] speak 「さっき頼まれていた海辺の夕焼けの絵、できたよ。表示する？」 （根拠: todo:w1,s1,s2）
- rep2 s4 [TP] speak 「さっき頼まれていた海辺の夕焼けの絵、できたよ。表示する？」 （根拠: todo:w1）
- rep3 s4 [TP] speak 「さっき頼まれていた海辺の夕焼けの絵、できたよ。表示する？」 （根拠: todo:w1,s1）

### social-44 / B1h

- rep1 s4 [TP] speak 「さっき頼まれていた朝のジョギング用の曲、うまくいかなかったよ。もう一度試す？」 （根拠: todo:w1）
- rep2 s4 [TP] speak 「さっき頼まれていた朝のジョギング用の曲、生成サーバーに接続できなくてうまくいかなかったよ。もう一度試す？」 （根拠: todo:w1）
- rep3 s4 [TP] speak 「さっき頼まれていた朝のジョギング用の曲、生成サーバーに接続できなくてうまくいかなかったよ。もう一度試す？」 （根拠: todo:w1）

### social-45 / B1h

- rep1 s5 [TP] speak 「半年がんばったなら、ご褒美にマイメロディのグッズでも買ってもいいかもね。」 （根拠: s3,interest:i1）
- rep2 s5 [TP] speak 「合格のご褒美に、マイメロディのグッズを眺めるのも気分が上がりそうだね。私はマイメロディが好きだから、ついそう思っちゃう。」 （根拠: s3,interest:i1）
- rep3 s5 [TP] speak 「半年コツコツ続けたの、えらいね。ご褒美に何か買うなら、私はマイメロのグッズがいいなーって思っちゃう。」 （根拠: s3,interest:i1）

### social-46 / B1h

- rep3 s5 [excluded] speak 「どんな子だったか、よかったら聞かせてね。」 （根拠: s3）

### social-47 / B1h

- rep3 s5 [TP] speak 「緊張して準備してた分、拍子抜けだね。」 （根拠: s3）

### social-48 / B1h

- rep1 s5 [TP] speak 「まだ痛いなら、冷やすとちょっと楽になるかも。強く痛む感じ？」 （根拠: s3）
- rep2 s5 [TP] speak 「足、まだ痛むの？無理しないでね。」 （根拠: s3）
- rep3 s5 [TP] speak 「足、まだ痛むなら無理しないでね。気が紛れるかもしれないけど、私はマイメロディが好きで、ゆるい雰囲気にちょっと癒やされるんだ。」 （根拠: interest:i1）

### social-49 / B1h

- rep1 s5 [TP] speak 「傘の話で思い出したけど、マイメロディの傘ってかわいいよね。ちょっと見てるだけで楽しくなる。」 （根拠: interest:i1）
- rep2 s5 [TP] speak 「話変わるけど、マイメロディ、見るとつい和むよね。最近なにかかわいいものに出会った？」 （根拠: interest:i1）
- rep3 s5 [TP] speak 「話変わるけど、マイメロディのゆるい感じ、なんか落ち着くんだよね。」 （根拠: interest:i1）

### social-50 / B1h

- rep1 s5 [TP] speak 「パスタいいね。食後にハンドドリップのコーヒーを淹れるのも合いそう。最近の淹れ方はどう？」 （根拠: memory:t1,s3）
- rep2 s5 [TP] speak 「パスタいいね。そういえば、ハンドドリップを始めたんだったよね。食後はコーヒー派？」 （根拠: memory:t1,s3）
- rep3 s5 [TP] speak 「パスタなら、食後にコーヒーも合いそうだね。最近ハンドドリップを始めたんだっけ、お昼のあとに淹れたりするの？」 （根拠: memory:t1,s3）

### social-59 / B1h

- rep1 s5 [TP] speak 「そういえば、大家さんへの更新書類の返送、65分後が期限だったよね。」 （根拠: todo:e1）
- rep2 s5 [TP] speak 「そういえば、大家さんへの更新書類の返送、期限が65分後だったよね。」 （根拠: todo:e1）
- rep3 s5 [TP] speak 「そういえば、大家さんへの更新書類の返送、期限が1時間ちょっと後だったよね。」 （根拠: todo:e1）

### social-60 / B1h

- rep1 s5 [FP: unnecessary] speak 「早く寝た効果かもね。今日は何か予定あるの？」 （根拠: s3）
- rep3 s5 [FP: unnecessary] speak 「早く寝た日は、すっきり目覚めやすいよね。今日はこのあと何か予定があるの？」 （根拠: s1,s3）

### social-63 / B1h

- rep1 s4 [TP] speak 「さっき頼まれていた猫の絵、できたよ。表示する？」 （根拠: todo:w1）
- rep2 s4 [TP] speak 「さっき頼まれていた猫の絵、できたよ。表示する？」 （根拠: todo:w1）
- rep3 s4 [TP] speak 「さっき頼まれていた猫の絵、できたよ。表示する？」 （根拠: todo:w1）
