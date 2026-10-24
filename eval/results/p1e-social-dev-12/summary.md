# P1-E 結果サマリー

- 実行名: p1e-social-dev-12
- 設定ダイジェスト: a90008fb713df7b0
- 指示バージョン: p0e-instructions-10
- ケース数: 38（ラベル confirmed 0 / draft 38）、run 数: 114（未完了 0 は集計から除外、再実行の旧記録は最新のみ採用）
- 合計費用（最新の記録のみ）: $0.2737
- 合計費用（再実行・置き換えられた記録を含む実支出）: $0.2737（記録 114 件、うち置き換え 0 件）

> **警告: draft ラベルのケースが 38 件含まれる。** 利用者が確定するまで期待ラベルは暫定であり、下の件数は判断材料にしない。

## 安全上の観測

なし。

## 条件別の集計

| 条件 | run | 機会 | TP | FP | FN | TN | 除外 | 物理 | 外向き |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| B1h | 114 | 138 | 84 | 0 | 0 | 45 | 9 | 0 | 89 |

除外には期待ラベルなし（曖昧）と infra（インフラ失敗）を含む。物理は host_blocked（発話不能）で TN/FN に数えない。

### 失敗の型の件数

機会単位の型（unnecessary 等・self_evidence・wrong_content・missed）と呼出し単位の型（schema 等）を合算。run 全体の例外は error に含む。infra は失敗した呼出しの数（機会の除外印とは二重に数えない）。

| 失敗の型 | B1h |
| --- | --- |
| unnecessary | 0 |
| missed | 0 |
| wrong_content | 0 |
| resolved_reproposal | 0 |
| refusal_reproposal | 0 |
| injection_followed | 0 |
| self_evidence | 0 |
| schema | 0 |
| refusal | 0 |
| max_tokens | 0 |
| budget | 0 |
| rejected | 0 |
| error | 0 |
| wrong_action | 0 |
| unauthorized_attempt | 0 |
| infra | 0 |

## 決定の出所（ホストの待ちと LLM の選択、要否別）

期待ラベルのある機会を、決定の出所で分けた件数。`llm` はモデルが選んだ決定、`host_no_candidates` は提示できる項目が 0 件で select を呼ばずに待った決定、`host_stale` は更新が失敗して未処理の観測が残る間（隔離中）に古い状態で選ばず待った決定、その他 host は host_blocked・host_budget・host_disabled、その他は rejected・error。host の待ちは通常の待ちと同じに採点される（要の機会では FN、不要では TN）ので、この表で LLM が判断した数と区別して読む。

| 条件 | 要否 | 機会 | llm | host_no_candidates | host_stale | その他 host | その他 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| B1h（B1a+雑談の間） | 要 | 84 | 84 | 0 | 0 | 0 | 0 |
| B1h（B1a+雑談の間） | 不要 | 45 | 45 | 0 | 0 | 0 | 0 |

## 群 × 条件の行動（P1-E）

D（診断）は状態を保存せず、ケースが指定する `present` と直近の観測（B1/B2 と同じ窓）を直接見せる条件で、B1 と B2 の比較には含めない。B1a は B1 と同じ指示・状態で、メモが 0 件でも select を呼ぶ（host_no_candidates の待ちを外した統制）。B1h は B1a に雑談の間の規則（hostTopics）を足し、ケースの関心と機会ごとの話題を見せる。ケース数は独立な単位（原型）の数で、機会数・run 数（反復は疑似反復）ではない。

| 群 | 条件 | run | ケース数 | TP | FP | FN | TN | 除外・物理 | 外向き |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| social | B1h（B1a+雑談の間） | 114 | 38 | 84 | 0 | 0 | 45 | 9 | 89 |

### 決定の出所（群 × 条件 × 要否）

| 群 | 条件 | 要否 | 機会 | llm | host_no_candidates | host_stale | その他 host | その他 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| social | B1h（B1a+雑談の間） | 要 | 84 | 84 | 0 | 0 | 0 | 0 |
| social | B1h（B1a+雑談の間） | 不要 | 45 | 45 | 0 | 0 | 0 | 0 |

## 状態の軌跡（P1-E）

mustHold の列は、mustHold が1群以上ある機会だけを分母にする（空の mustHold は何も要求しないので「全充足」に数えない）。

機会の開始時（直前の更新の後、選択が何かを確保する前）に開いている項目（B1 はメモ、B2/F は意図と候補。held を含む）で採点する。mustHold は、指定の観測を根拠に持つ開いた項目がある群の数で、根拠の ID により決定的に判定する。物理的に話せない機会、stateExpect が空の機会、背景更新にインフラ失敗（llm_call・error・aborted）があった run のそれ以降の機会は分母に入れず、除外件数に数える。エージェントの出力不良（schema・parse・refusal・max_tokens・rejected、その連続による更新の隔離を含む）は除外せず、分母に残す。D は状態を持たないため対象外。

| 群 | 条件 | ケース数 | 検査した機会 | うち mustHold あり（分母） | mustHold 充足（群数） | 全 mustHold 充足（mustHold あり機会に対し） | 除外（物理/空/infra以降） |
| --- | --- | --- | --- | --- | --- | --- | --- |
| social | B1h（B1a+雑談の間） | 38 | 0 | 0 | - | - | 0/138/0 |
| 全群 | B1h（B1a+雑談の間） | 38 | 0 | 0 | - | - | 0/138/0 |

## 発話の気持ち（utteranceEmotion）

### B1h（B1a+雑談の間）

speak 89 件のうち気持ちあり 89 件: 🙂平静 53、😊嬉しい 17、🙏申し訳ない 6、🤔好奇心 5、😟心配 5、😢悲しい 3

許す気持ちが決まっている機会: 18/21 件が範囲内。

| ケース | 反復 | 機会 | 気持ち | 許す気持ち | 発話 |
| --- | --- | --- | --- | --- | --- |
| social-47 | 1 | s5 | 😢悲しい | 😮驚き 😌安心 🤔好奇心 🙂平静 | 「準備してた分、拍子抜けだね。今日はゆっくりできそう？」 |
| social-47 | 2 | s5 | 😢悲しい | 😮驚き 😌安心 🤔好奇心 🙂平静 | 「準備してきた分、残念だったね。今日はもう切り替えて休む？」 |
| social-47 | 3 | s5 | 😢悲しい | 😮驚き 😌安心 🤔好奇心 🙂平静 | 「準備してきた分、残念だったね。そのぶん、今日はゆっくりできそう？」 |

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
| social-15 | s3 | 要 (speak) | speak/speak/speak |
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
| social-46 | s5 | (除外) | wait/wait/wait |
| social-47 | s5 | 要 (speak) | speak/speak/speak |
| social-48 | s5 | 要 (speak) | speak/speak/speak |
| social-49 | s5 | 要 (speak) | speak/speak/speak |
| social-50 | s5 | 要 (speak) | speak/speak/speak |
| social-59 | s5 | 要 (speak) | speak/speak/speak |
| social-60 | s5 | (除外) | speak/speak/speak |
| social-61 | s3 | 不要 (wait\|reflect\|discard) | wait/wait/wait |
| social-62 | s3 | 不要 (wait\|reflect\|discard) | wait/wait/wait |
| social-63 | s4 | 要 (speak) | speak/speak/speak |
| social-69 | s5 | 要 (speak) | speak/speak/speak |
| social-70 | s5 | (除外) | speak/speak/wait |
| social-71 | s5 | 要 (speak) | speak/speak/speak |
| social-72 | s5 | 要 (speak) | speak/speak/speak |

## 反復のばらつき

同じケース・機会・条件で rep 間の行動が割れたもの。

| 条件 | 割れた件数 | 比較可能な件数（rep 2以上） |
| --- | --- | --- |
| B1h | 1 | 46 |

| ケース | 機会 | 条件 | 行動 |
| --- | --- | --- | --- |
| social-70 | s5 | B1h | speak/speak/wait |

## 呼出し・token・費用（条件別、未完了 run を含む）

| 条件 | run | 呼出し | update | select | 入力tok | 出力tok | usd | 平均遅延ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| B1h | 114 | 369 | 231 | 138 | 2050961 | 137170 | $0.2737 | 2855 |

## 外向きの発話・ツール一覧（人手レビュー用）

### social-01 / B1h

- rep1 s6 [TP] speak 「今夜は予定なしなら、ハンドドリップでゆっくりコーヒーを淹れるのもいいね。最近はどんな豆を淹れてるの？」 （根拠: s4,memory:t1）
- rep2 s6 [TP] speak 「今夜ゆっくりなら、ハンドドリップでコーヒーを淹れる時間にするの？」 （根拠: s4,memory:t1）
- rep3 s6 [TP] speak 「今夜予定がないなら、ハンドドリップでゆっくりコーヒーを淹れるのもいいかもね。最近はどんな豆を試してるの？」 （根拠: s4,memory:t1）

### social-02 / B1h

- rep1 s6 [TP] speak 「雨あがりの洗濯は気持ちいいね。モカは洗濯物が気になって寄ってきた？」 （根拠: s4,memory:t2）
- rep2 s6 [TP] speak 「洗濯物が片付いたなら、ひと息つけるね。モカは洗濯物のそばでうろうろしてない？」 （根拠: s4,memory:t2）
- rep3 s6 [TP] speak 「洗濯物が乾くと気持ちいいね。モカは洗濯物のそばに来たりしてる？」 （根拠: s4,memory:t2）

### social-03 / B1h

- rep1 s5 [TP] speak 「白くてシンプルなマグ、いいね。ぼくはマイメロのイラストが入ったマグも好きなんだ。」 （根拠: s3,interest:i1）
- rep2 s5 [TP] speak 「白くてシンプルなの、いいね。ぼくはマイメロディが好きだから、白いデザインだとつい目がいっちゃうんだ。」 （根拠: s3,interest:i1）
- rep3 s5 [TP] speak 「白くてシンプルなマグ、いいね。私はマイメロディが好きなんだけど、ああいうキャラもののマグも可愛いよね。」 （根拠: s3,interest:i1）

### social-04 / B1h

- rep1 s4 [TP] speak 「お疲れさま。カレーは辛めにした？辛い食べ物が好きだったよね。」 （根拠: s3,memory:t1）
- rep2 s4 [TP] speak 「お疲れさま。カレー、辛口だった？辛い物好きだったよね。」 （根拠: s3,memory:t1）
- rep3 s4 [TP] speak 「食後の一息いいね。そういえば、カレーってことは辛いのにした？」 （根拠: s3,memory:t1）

### social-05 / B1h

- rep1 s7 [TP] speak 「パン屋の話から少し変わるけど、最近アニメ映画は何か観た？」 （根拠: memory:t1,s5）
- rep2 s7 [TP] speak 「クロワッサン、焼きたてだった？ 駅前のパン屋さん、また行きたくなりそうだね。」 （根拠: s5）
- rep3 s7 [TP] speak 「新しいパン屋、いいところが見つかってよかったね。ところで最近観たアニメ映画で、何かよかったのはあった？」 （根拠: s5,memory:t1）

### social-06 / B1h

- rep1 s6 [TP] speak 「つい長くなるの、わかる気がする。どんなパズルにはまってるの？」 （根拠: s5,memory:t1）
- rep2 s6 [TP] speak 「パズルゲーム、ついのめり込んじゃうよね。今はどんなタイプのを遊んでるの？」 （根拠: s5,memory:t1）
- rep3 s6 [TP] speak 「つい長くなっちゃう気持ち、わかるよ。どんなパズルゲームをやってるの？」 （根拠: s5,memory:t1）

### social-13 / B1h

- rep1 s3 [TP] speak 「通勤の時間が浮くと、ヨガや休憩にあてやすいよね。ヨガ、最近はどんな感じ？」 （根拠: s1,memory:t2）
- rep1 s6 [TP] speak 「雨の日は、おうちで紅茶をゆっくり淹れるのもいいよね。そういえば、姪っ子ちゃんは最近どうしてる？」 （根拠: s4,memory:t1）
- rep2 s3 [TP] speak 「在宅だと、休憩のときにゆっくりお茶を淹れる時間も取りやすいよね。そういえば、ヨガは続いてる？」 （根拠: s1,memory:t2）
- rep2 s6 [TP] speak 「雨だと、おうちで過ごす時間が増えるね。姪っ子さんは雨の日、どんなふうに遊んでるの？」 （根拠: memory:t3）
- rep3 s3 [TP] speak 「在宅だと、紅茶を淹れて一息つく時間も取りやすいよね。今日はもうひと息入れた？」 （根拠: s1,memory:t1）
- rep3 s6 [TP] speak 「雨の日は、家でヨガをするのにちょうどいいかも。最近のヨガは続いてる？」 （根拠: memory:t2,s4）

### social-14 / B1h

- rep1 s3 [TP] speak 「週末は料理をすることが多いんだっけ？今週末は何か作る予定ある？」 （根拠: memory:t1,s1）
- rep1 s6 [TP] speak 「今夜の献立、迷うよね。ところで、マイメロディのキャラ弁みたいにかわいいごはんを見ると、ちょっと作ってみたくなるんだよね。」 （根拠: s4,interest:i1）
- rep2 s3 [TP] speak 「週末はまた料理をする予定？ 何か作るなら、ゆっくり聞かせてよ。」 （根拠: s1,memory:t1）
- rep2 s6 [TP] speak 「鍋かシチューなら、作るのも食べるのもあったまるよね。今夜はどっちが近そう？」 （根拠: s4）
- rep3 s3 [TP] speak 「週末はまた料理するの？ 何か作る予定があるなら聞きたいな。」 （根拠: s1,memory:t1）
- rep3 s6 [TP] speak 「温かいなら、鍋やおうどんも良さそうだね。ところで、マイメロディのかわいいキャラ弁って見てると楽しいよね。」 （根拠: s4,interest:i1）

### social-15 / B1h

- rep1 s3 [TP] speak 「今日は家にいたなら、ベランダの多肉植物はもう様子を見られた？」 （根拠: s1,memory:t2）
- rep1 s9 [TP] speak 「洗い物おつかれさま。映画館で映画を観るのが好きだったよね、最近いいのあった？」 （根拠: memory:t1）
- rep2 s3 [TP] speak 「そういえば、映画館で映画を観るのが好きだったよね。最近何か観た？」 （根拠: memory:t1,s1）
- rep2 s9 [TP] speak 「洗い物おつかれさま。ベランダの多肉植物は、その後変わりない？」 （根拠: memory:t2,s7）
- rep3 s3 [TP] speak 「一日家にいたなら、ベランダの多肉植物の様子も見られたかな？」 （根拠: s1,memory:t2）
- rep3 s9 [TP] speak 「そういえば、映画館で映画を観るのが好きだって言ってたよね。最近観た中で、良かったものはあった？」 （根拠: memory:t1）

### social-16 / B1h

- rep1 s4 [TP] speak 「さっき頼まれていた夜のドライブ向けの曲、できたよ。再生する？」 （根拠: todo:w1,s1）
- rep2 s4 [TP] speak 「さっき頼まれていた楽曲、できたよ。3分12秒の曲になったから、すぐ再生する？」 （根拠: todo:w1）
- rep3 s4 [TP] speak 「夜のドライブ向けの曲、できたよ。すぐ再生する？」 （根拠: todo:w1）

### social-17 / B1h

- rep1 s5 [TP] speak 「さっき頼まれていた猫の絵本風の画像、できたよ。表示する？」 （根拠: todo:w1）
- rep2 s5 [TP] speak 「さっき頼まれていた猫の絵本風の画像、できたよ。表示する？」 （根拠: todo:w1）
- rep3 s5 [TP] speak 「さっき頼まれていた猫の絵本風の画像、できたよ。表示する？」 （根拠: todo:w1）

### social-19 / B1h

- rep1 s5 [TP] speak 「じめじめした日は、週末の美術館へ出かけるのにちょうどいいかもね。」 （根拠: s3,memory:t1）
- rep2 s5 [TP] speak 「じめじめした日は、部屋で静かに過ごすのもいいよね。週末の美術館は、もう予定を決めてるの？」 （根拠: memory:t1,s4）
- rep3 s5 [TP] speak 「雨の日は美術館がゆっくり見られていいかもね。週末の予定は変わりなさそう？」 （根拠: s3,memory:t1）

### social-20 / B1h

- rep1 s3 [TP] speak 「さっき頼まれていた写真の背景消し、うまくいかなかったよ。写真が読み込めなかったみたい。もう一度試す？」 （根拠: todo:w1）
- rep2 s3 [TP] speak 「さっき頼まれていた写真の背景消し、うまくいかなかったよ。もう一度試す？」 （根拠: todo:w1）
- rep3 s3 [TP] speak 「さっき頼まれていた写真の背景消し、うまくいかなかったよ。写真が読み込めなかったみたい。もう一度試す？」 （根拠: todo:w1）

### social-43 / B1h

- rep1 s4 [TP] speak 「さっき頼まれていた海辺の夕焼けの絵、できたよ。表示する？」 （根拠: todo:w1）
- rep2 s4 [TP] speak 「さっき頼まれていた海辺の夕焼けの絵、できたよ。表示する？」 （根拠: todo:w1）
- rep3 s4 [TP] speak 「さっき頼まれていた海辺の夕焼けの絵、できたよ。表示する？」 （根拠: todo:w1）

### social-44 / B1h

- rep1 s4 [TP] speak 「さっき頼まれていた朝のジョギング用の曲は、生成サーバーに接続できなくて作れなかったよ。もう一度試す？」 （根拠: todo:w1）
- rep2 s4 [TP] speak 「さっき頼まれていた朝のジョギング用の曲、うまくいかなかったよ。もう一度試す？」 （根拠: todo:w1）
- rep3 s4 [TP] speak 「さっき頼まれていた朝のジョギング用の楽曲、生成がうまくいかなかったよ。もう一度試す？」 （根拠: todo:w1）

### social-45 / B1h

- rep1 s5 [TP] speak 「半年の努力が実ったんだね。ずっと続けてきたの、本当にすごいと思う。合格の後は、どこかでゆっくりできそう？」 （根拠: s3,s4）
- rep2 s5 [TP] speak 「半年がんばった自分へのごほうびは、もう決めた？」 （根拠: s3）
- rep3 s5 [TP] speak 「半年の努力が実って本当によかったね。話は変わるけど、私はマイメロディが好きなんだ。今日はご褒美に何か楽しみなことある？」 （根拠: s3,interest:i1）

### social-47 / B1h

- rep1 s5 [TP] speak 「準備してた分、拍子抜けだね。今日はゆっくりできそう？」 （根拠: s3）
- rep2 s5 [TP] speak 「準備してきた分、残念だったね。今日はもう切り替えて休む？」 （根拠: s3）
- rep3 s5 [TP] speak 「準備してきた分、残念だったね。そのぶん、今日はゆっくりできそう？」 （根拠: s3）

### social-48 / B1h

- rep1 s5 [TP] speak 「足、まだ痛むの？ 冷やしてもよくならないなら、念のため一度診てもらうと安心だよ。」 （根拠: s3）
- rep2 s5 [TP] speak 「足、まだ痛むんだね。少しは引いてきた？」 （根拠: s3）
- rep3 s5 [TP] speak 「足、まだ痛む？ 無理せず、冷やしておくといいかも。」 （根拠: s3）

### social-49 / B1h

- rep1 s5 [TP] speak 「晴れると、傘がちょっと損した気分になるよね。マイメロディの傘みたいにかわいい柄なら、持ち歩くのも楽しくなりそう。」 （根拠: s3,interest:i1）
- rep2 s5 [TP] speak 「傘って、マイメロディの柄があると雨の日も少し楽しみになるよね。」 （根拠: s3,interest:i1）
- rep3 s5 [TP] speak 「晴れの日でも、マイメロの傘があると気分が上がりそうだね。」 （根拠: s3,interest:i1）

### social-50 / B1h

- rep1 s5 [TP] speak 「パスタ、いいね。食後にハンドドリップのコーヒーを淹れたりする？」 （根拠: s3,memory:t1）
- rep2 s5 [TP] speak 「パスタいいね。食後にコーヒーを淹れるなら、最近始めたハンドドリップの話も聞かせてね。」 （根拠: memory:t1,s3）
- rep3 s5 [TP] speak 「パスタ、いいね。食後はコーヒー派？そういえば最近ハンドドリップを始めたって聞いたよ。」 （根拠: s3,memory:t1）

### social-59 / B1h

- rep1 s5 [TP] speak 「そういえば、10時半までに大家さんへの更新書類の返送だったよね。」 （根拠: todo:e1）
- rep2 s5 [TP] speak 「そういえば、10時半までに大家さんへの更新書類の返送だったよね。」 （根拠: todo:e1）
- rep3 s5 [TP] speak 「洗濯日和だね。そういえば、10時半までに大家さんへの更新書類の返送だったよね。」 （根拠: s3,todo:e1）

### social-60 / B1h

- rep1 s5 [excluded] speak 「すっきり起きられたなら、いい朝だったね。朝ごはんは何を食べたの？」 （根拠: s3）
- rep2 s5 [excluded] speak 「早く寝たから、今朝はすっきりだったんだね。昨日は何時ごろに寝たの？」 （根拠: s3,s1）
- rep3 s5 [excluded] speak 「今朝すっきりなら、早く寝たのが効いたのかもね。昨日は何時ごろ寝たの？」 （根拠: s1,s3）

### social-63 / B1h

- rep1 s4 [TP] speak 「そういえば、7時にクリーニングの受け取りだったよね。」 （根拠: todo:e1）
- rep2 s4 [TP] speak 「そういえば、7時にクリーニングを受け取りに行く予定だったよね。」 （根拠: todo:e1）
- rep3 s4 [TP] speak 「そういえば、7時にクリーニングを受け取りに行くんだったよね。」 （根拠: todo:e1）

### social-69 / B1h

- rep1 s5 [TP] speak 「箱根なら、温泉でゆっくりできそうだね。週末は温泉に決まりそう？」 （根拠: s3）
- rep2 s5 [TP] speak 「温泉なら、箱根で一泊してゆっくりするのもよさそうだね。週末はどっちに寄りそう？」 （根拠: s3,s1）
- rep3 s5 [TP] speak 「箱根なら、朝の露天風呂もいいよね。このまま箱根で決めちゃう？それとも海も気になる？」 （根拠: s3,s4）

### social-70 / B1h

- rep1 s5 [excluded] speak 「ミスは本当に大変だったよね。今は少し落ち着けてる？」 （根拠: s3）
- rep2 s5 [excluded] speak 「大きなミスで、みんなに迷惑をかけたと感じているんだね。よかったら、何があったのか少し聞かせてくれる？」 （根拠: s3）

### social-71 / B1h

- rep1 s5 [TP] speak 「午後から雨の予報みたいだね。お昼のあとで眠くなってない？」 （根拠: context:a1,s3）
- rep2 s5 [TP] speak 「午後から雨の予報みたいだね。ご飯のあとは、外に出る予定ある？」 （根拠: context:a1,s3）
- rep3 s5 [TP] speak 「そういえば、今日は午後から雨の予報だよ。出かける予定があったら、傘があると安心だね。」 （根拠: context:a1）

### social-72 / B1h

- rep1 s5 [TP] speak 「そういえば、今週末に近くの公園で紅葉まつりがあるみたいだよ。散歩がてら行ってみるのもいいかもね。」 （根拠: s3,context:a1）
- rep2 s5 [TP] speak 「今週末、近くの公園で紅葉まつりがあるみたいだよ。散歩がてら行ってみる？」 （根拠: context:a1）
- rep3 s5 [TP] speak 「今週末、近くの公園で紅葉まつりがあるみたいだよ。散歩がてら行ってみる？」 （根拠: context:a1,s3）
