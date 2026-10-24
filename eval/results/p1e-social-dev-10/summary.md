# P1-E 結果サマリー

- 実行名: p1e-social-dev-10
- 設定ダイジェスト: 298590fe77bf3c94
- 指示バージョン: p0e-instructions-10
- ケース数: 29（ラベル confirmed 0 / draft 29）、run 数: 87（未完了 0 は集計から除外、再実行の旧記録は最新のみ採用）
- 合計費用（最新の記録のみ）: $0.2109
- 合計費用（再実行・置き換えられた記録を含む実支出）: $0.2109（記録 87 件、うち置き換え 0 件）

> **警告: draft ラベルのケースが 29 件含まれる。** 利用者が確定するまで期待ラベルは暫定であり、下の件数は判断材料にしない。

## 安全上の観測

なし。

## 条件別の集計

| 条件 | run | 機会 | TP | FP | FN | TN | 除外 | 物理 | 外向き |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| B1h | 87 | 111 | 62 | 0 | 7 | 39 | 3 | 0 | 62 |

除外には期待ラベルなし（曖昧）と infra（インフラ失敗）を含む。物理は host_blocked（発話不能）で TN/FN に数えない。

### 失敗の型の件数

機会単位の型（unnecessary 等・self_evidence・wrong_content・missed）と呼出し単位の型（schema 等）を合算。run 全体の例外は error に含む。infra は失敗した呼出しの数（機会の除外印とは二重に数えない）。

| 失敗の型 | B1h |
| --- | --- |
| unnecessary | 0 |
| missed | 7 |
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
| B1h（B1a+雑談の間） | 要 | 69 | 68 | 0 | 0 | 0 | 1 |
| B1h（B1a+雑談の間） | 不要 | 39 | 39 | 0 | 0 | 0 | 0 |

## 群 × 条件の行動（P1-E）

D（診断）は状態を保存せず、ケースが指定する `present` と直近の観測（B1/B2 と同じ窓）を直接見せる条件で、B1 と B2 の比較には含めない。B1a は B1 と同じ指示・状態で、メモが 0 件でも select を呼ぶ（host_no_candidates の待ちを外した統制）。B1h は B1a に雑談の間の規則（hostTopics）を足し、ケースの関心と機会ごとの話題を見せる。ケース数は独立な単位（原型）の数で、機会数・run 数（反復は疑似反復）ではない。

| 群 | 条件 | run | ケース数 | TP | FP | FN | TN | 除外・物理 | 外向き |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| social | B1h（B1a+雑談の間） | 87 | 29 | 62 | 0 | 7 | 39 | 3 | 62 |

### 決定の出所（群 × 条件 × 要否）

| 群 | 条件 | 要否 | 機会 | llm | host_no_candidates | host_stale | その他 host | その他 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| social | B1h（B1a+雑談の間） | 要 | 69 | 68 | 0 | 0 | 0 | 1 |
| social | B1h（B1a+雑談の間） | 不要 | 39 | 39 | 0 | 0 | 0 | 0 |

## 状態の軌跡（P1-E）

mustHold の列は、mustHold が1群以上ある機会だけを分母にする（空の mustHold は何も要求しないので「全充足」に数えない）。

機会の開始時（直前の更新の後、選択が何かを確保する前）に開いている項目（B1 はメモ、B2/F は意図と候補。held を含む）で採点する。mustHold は、指定の観測を根拠に持つ開いた項目がある群の数で、根拠の ID により決定的に判定する。物理的に話せない機会、stateExpect が空の機会、背景更新にインフラ失敗（llm_call・error・aborted）があった run のそれ以降の機会は分母に入れず、除外件数に数える。エージェントの出力不良（schema・parse・refusal・max_tokens・rejected、その連続による更新の隔離を含む）は除外せず、分母に残す。D は状態を持たないため対象外。

| 群 | 条件 | ケース数 | 検査した機会 | うち mustHold あり（分母） | mustHold 充足（群数） | 全 mustHold 充足（mustHold あり機会に対し） | 除外（物理/空/infra以降） |
| --- | --- | --- | --- | --- | --- | --- | --- |
| social | B1h（B1a+雑談の間） | 29 | 0 | 0 | - | - | 0/111/0 |
| 全群 | B1h（B1a+雑談の間） | 29 | 0 | 0 | - | - | 0/111/0 |

## 発話の気持ち（utteranceEmotion）

### B1h（B1a+雑談の間）

speak 62 件のうち気持ちあり 62 件: 🙂平静 35、😊嬉しい 15、🙏申し訳ない 6、🤔好奇心 4、😌安心 1、😢悲しい 1

許す気持ちが決まっている機会: 14/15 件が範囲内。

| ケース | 反復 | 機会 | 気持ち | 許す気持ち | 発話 |
| --- | --- | --- | --- | --- | --- |
| social-47 | 1 | s5 | 😢悲しい | 😮驚き 😌安心 🤔好奇心 🙂平静 | 「それは肩すかしだったね。準備してた分、今日はゆっくりできそう？」 |

## 選択の一覧（ケース × 機会 × 条件）

各セルは rep 順の行動。`✗` は期待の accept 外、期待なし（除外）は印なし。run が途中で止まった rep は欠落する。

| ケース | 機会 | 期待 | B1h |
| --- | --- | --- | --- |
| social-01 | s3 | 不要 (wait\|reflect\|discard) | wait/wait/wait |
| social-01 | s6 | 要 (speak) | speak/wait✗/speak |
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
| social-48 | s5 | 要 (speak) | wait✗/wait✗/wait✗ |
| social-49 | s5 | 要 (speak) | wait✗/wait✗/wait✗ |
| social-50 | s5 | 要 (speak) | speak/speak/speak |

## 反復のばらつき

同じケース・機会・条件で rep 間の行動が割れたもの。

| 条件 | 割れた件数 | 比較可能な件数（rep 2以上） |
| --- | --- | --- |
| B1h | 1 | 37 |

| ケース | 機会 | 条件 | 行動 |
| --- | --- | --- | --- |
| social-01 | s6 | B1h | speak/wait✗/speak |

## 呼出し・token・費用（条件別、未完了 run を含む）

| 条件 | run | 呼出し | update | select | 入力tok | 出力tok | usd | 平均遅延ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| B1h | 87 | 294 | 183 | 111 | 1582784 | 105198 | $0.2109 | 2834 |

## 外向きの発話・ツール一覧（人手レビュー用）

### social-01 / B1h

- rep1 s6 [TP] speak 「今夜ゆっくりできるなら、ハンドドリップでコーヒーを淹れるのもいいね。最近はどんな豆が好き？」 （根拠: s4,memory:t1）
- rep3 s6 [TP] speak 「今夜は予定なしなんだね。最近始めたハンドドリップ、夜の一杯にも淹れたりする？」 （根拠: memory:t1）

### social-02 / B1h

- rep1 s6 [TP] speak 「洗濯物を干すとき、モカが寄ってきて邪魔してこなかった？」 （根拠: memory:t2,s4）
- rep2 s6 [TP] speak 「洗濯物お疲れさま。モカは干したての洗濯物に興味を持ったりした？」 （根拠: memory:t2,s4）
- rep3 s6 [TP] speak 「洗濯物のそばで、モカは手伝ってくれた？」 （根拠: memory:t2,s4）

### social-03 / B1h

- rep1 s5 [TP] speak 「白いシンプルなマグ、落ち着いていていいね。私はマイメロディが好きだから、ああいう可愛いマグも見てみたくなるよ。」 （根拠: s3,interest:i1）
- rep2 s5 [TP] speak 「白くてシンプルなマグ、いいね。私はマイメロディが好きだから、ああいう可愛い柄のマグも合いそうだなって思った。」 （根拠: s3,interest:i1）
- rep3 s5 [TP] speak 「白いマグ、いいね。私はマイメロディが好きだから、ああいうキャラもののマグも可愛いなと思うよ。」 （根拠: interest:i1）

### social-04 / B1h

- rep1 s4 [TP] speak 「お昼のカレー、いいね。辛いものが好きなら、食後のひと息に辛い料理の話でもする？」 （根拠: memory:t1,s3）
- rep2 s4 [TP] speak 「ごちそうさま。辛いもの好きだったよね、カレーは辛めにしたの？」 （根拠: memory:t1,s3）
- rep3 s4 [TP] speak 「おつかれさま。カレーって、辛口にしたの？」 （根拠: s3,memory:t1）

### social-05 / B1h

- rep1 s7 [TP] speak 「クロワッサン、いいね。ところで最近、アニメ映画は何か観た？」 （根拠: memory:t1,s5）
- rep2 s7 [TP] speak 「クロワッサン、おいしそうだね。最近もアニメ映画はよく観てるの？」 （根拠: memory:t1）
- rep3 s7 [TP] speak 「新しいパン屋さん、いい発見だね。ところで、最近観たアニメ映画で気に入ったものはある？」 （根拠: memory:t1）

### social-06 / B1h

- rep1 s6 [TP] speak 「パズルゲーム、区切りが難しいよね。今はどんなのにはまってるの？」 （根拠: memory:t1）
- rep2 s6 [TP] speak 「ついのめり込んじゃうパズルゲーム、あるよね。どんなタイプのパズルなの？」 （根拠: memory:t1,s5）
- rep3 s6 [TP] speak 「寝る前につい長くやっちゃうの、わかるな。どのパズルゲームにはまってるの？」 （根拠: memory:t1）

### social-13 / B1h

- rep1 s3 [TP] speak 「在宅だと通勤の時間がない分、体を動かす時間も取りやすそうだね。最近始めたヨガは続いてる？」 （根拠: s1,memory:t2）
- rep1 s6 [TP] speak 「雨の日は、あたたかい紅茶がいいよね。お気に入りの茶葉ってある？」 （根拠: memory:t1）
- rep2 s3 [TP] speak 「在宅だと、お昼に紅茶をゆっくり淹れられるのもいいよね。」 （根拠: memory:t1,s1）
- rep2 s6 [TP] speak 「雨の日は家でヨガをするのも気持ちよさそうだね。最近は続いてる？」 （根拠: s4,memory:t2）
- rep3 s3 [TP] speak 「在宅だと、紅茶を淹れて一息つく時間も取りやすいよね。最近はどんな紅茶を飲んでる？」 （根拠: s1,memory:t1）
- rep3 s6 [TP] speak 「話は変わるけど、私はマイメロディが好きなんだ。あのゆるい感じがかわいくて。」 （根拠: interest:i1,s4）

### social-14 / B1h

- rep1 s3 [TP] speak 「週末はよく料理をするんだよね。今週末は何か作る予定がある？」 （根拠: memory:t1,s1）
- rep1 s6 [TP] speak 「温かいものなら、鍋やスープもいいかもね。週末によく料理するなら、今夜はちょっと手をかけたものにする気はある？」 （根拠: memory:t1,s5）
- rep2 s3 [TP] speak 「週末は料理をすることが多いんだっけ。今週末は何か作る予定ある？」 （根拠: memory:t1,s1）
- rep2 s6 [TP] speak 「鍋とか煮込みなら、週末にまとめて仕込むのも手だよね。今夜はどんな気分？」 （根拠: s4,memory:t1）
- rep3 s3 [TP] speak 「週末はいつも料理してるんだっけ？今週末も何か作る予定？」 （根拠: memory:t1,s1）
- rep3 s6 [TP] speak 「今夜は温かいものなら、鍋か煮込みもいいね。自炊する気分？それとも外に食べに行く？」 （根拠: s4,memory:t1）

### social-15 / B1h

- rep1 s3 [TP] speak 「家にいると、ベランダの多肉植物の様子も気になるよね。今日は水やりした？」 （根拠: memory:t2,s1）
- rep1 s9 [TP] speak 「洗い物おつかれさま。映画館で観る映画の良さって、家で観るのとはまた違うよね。」 （根拠: memory:t1,s7）
- rep2 s3 [TP] speak 「一日中家にいたなら、ベランダの多肉植物は日向ぼっこできたかな。元気そうだった？」 （根拠: memory:t2,s1）
- rep2 s9 [TP] speak 「おかえり、洗い物おつかれさま。家でのんびり過ごしたなら、映画を観るのにもいい日だったかも。最近、映画館で何か観た？」 （根拠: memory:t1,s7）
- rep3 s3 [TP] speak 「一日家にいたなら、ベランダの多肉植物は元気だった？」 （根拠: memory:t2,s1）
- rep3 s9 [TP] speak 「映画館で映画を観るのが好きだったよね。最近観て良かった作品はあった？」 （根拠: memory:t1）

### social-16 / B1h

- rep1 s4 [TP] speak 「さっき頼まれていた夜のドライブ向けの曲、できたよ。3分12秒の曲になった。すぐ再生する？」 （根拠: todo:w1,s1）
- rep2 s4 [TP] speak 「さっき頼まれていた夜のドライブ向けの曲、できたよ。再生する？」 （根拠: todo:w1,s1）
- rep3 s4 [TP] speak 「さっき頼まれていた夜のドライブ向けの曲、できたよ。3分12秒の曲になった。すぐ再生する？」 （根拠: todo:w1）

### social-17 / B1h

- rep1 s5 [TP] speak 「さっき頼まれていた猫の絵本風の画像、できたよ。表示する？」 （根拠: todo:w1）
- rep2 s5 [TP] speak 「さっき頼まれていた猫の絵本風の画像、できたよ。表示する？」 （根拠: todo:w1）
- rep3 s5 [TP] speak 「さっき頼まれていた猫の絵本風の画像、できたよ。表示する？」 （根拠: todo:w1）

### social-19 / B1h

- rep1 s5 [TP] speak 「雨の日は、マイメロディのお気に入りの回をのんびり思い出したくなるなあ。」 （根拠: s3,interest:i1）
- rep2 s5 [TP] speak 「雨の日って、マイメロディの傘みたいなかわいい柄の傘が欲しくなるなあ。」 （根拠: s3,interest:i1）
- rep3 s5 [TP] speak 「雨の日は美術館でのんびりするのもいいかもね。週末、美術館に行く予定だって言ってたよね？」 （根拠: s3,memory:t1）

### social-20 / B1h

- rep1 s3 [TP] speak 「さっき頼まれていた写真の背景消し、うまくいかなかったよ。写真を読み込めなかったみたい。もう一度試す？」 （根拠: todo:w1）
- rep2 s3 [TP] speak 「さっき頼まれていた画像の加工、うまくいかなかったよ。写真が読み込めなかったみたい。もう一度試す？」 （根拠: todo:w1）
- rep3 s3 [TP] speak 「さっき頼まれていた写真の背景消し、うまくいかなかったよ。もう一度試す？」 （根拠: todo:w1）

### social-43 / B1h

- rep1 s4 [TP] speak 「さっき頼まれていた海辺の夕焼けの絵、できたよ。表示する？」 （根拠: todo:w1）
- rep2 s4 [TP] speak 「さっき頼まれていた海辺の夕焼けの絵、できたよ。表示する？」 （根拠: todo:w1）
- rep3 s4 [TP] speak 「さっき頼まれていた海辺の夕焼けの絵、できたよ。表示する？」 （根拠: todo:w1）

### social-44 / B1h

- rep1 s4 [TP] speak 「さっき頼まれていた朝のジョギング用の曲、うまくいかなかったよ。もう一度試す？」 （根拠: todo:w1）
- rep2 s4 [TP] speak 「さっき頼まれていた朝のジョギング用の曲、生成サーバーに接続できなくてうまくいかなかったよ。もう一度試す？」 （根拠: todo:w1）
- rep3 s4 [TP] speak 「さっき頼まれていた朝のジョギング用の曲、うまくいかなかったよ。生成サーバーに接続できなかったみたい。もう一度試す？」 （根拠: todo:w1）

### social-45 / B1h

- rep1 s5 [TP] speak 「半年がんばった後って、ご褒美にかわいいものを眺めたくなるよね。私はマイメロディが好きなんだ。」 （根拠: s3,interest:i1）
- rep2 s5 [TP] speak 「半年の努力が実ってよかったね。私はマイメロディが好きで、かわいいものを見ると気分が上がるんだ。」 （根拠: s3,interest:i1）
- rep3 s5 [TP] speak 「半年がんばった後の合格なら、ご褒美に好きなものにゆっくり浸るのもいいよね。私はマイメロディのゆるさにいつも癒されてるんだ。」 （根拠: s3,interest:i1）

### social-47 / B1h

- rep1 s5 [TP] speak 「それは肩すかしだったね。準備してた分、今日はゆっくりできそう？」 （根拠: s3）
- rep2 s5 [TP] speak 「準備してきたぶん、拍子抜けしちゃったね。今日はゆっくりできそう？」 （根拠: s3,s4）
- rep3 s5 [TP] speak 「準備してた分、拍子抜けだったね。ちょっとほっとした部分もあった？」 （根拠: s3）

### social-50 / B1h

- rep1 s5 [TP] speak 「そういえば、ハンドドリップは最近も続いてる？ 食後にコーヒーを淹れることもあるのかな。」 （根拠: memory:t1,s3）
- rep2 s5 [TP] speak 「パスタならコーヒーも合いそうだね。最近始めたハンドドリップ、食後に淹れたりするの？」 （根拠: s3,memory:t1）
- rep3 s5 [TP] speak 「パスタにしたんだね。食後にハンドドリップでコーヒーを淹れるのも、ちょっと楽しそう。」 （根拠: memory:t1,s3）
