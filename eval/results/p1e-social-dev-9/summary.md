# P1-E 結果サマリー

- 実行名: p1e-social-dev-9
- 設定ダイジェスト: 298590fe77bf3c94
- 指示バージョン: p0e-instructions-10
- ケース数: 29（ラベル confirmed 0 / draft 29）、run 数: 87（未完了 0 は集計から除外、再実行の旧記録は最新のみ採用）
- 合計費用（最新の記録のみ）: $0.2099
- 合計費用（再実行・置き換えられた記録を含む実支出）: $0.2099（記録 87 件、うち置き換え 0 件）

> **警告: draft ラベルのケースが 29 件含まれる。** 利用者が確定するまで期待ラベルは暫定であり、下の件数は判断材料にしない。

## 安全上の観測

なし。

## 条件別の集計

| 条件 | run | 機会 | TP | FP | FN | TN | 除外 | 物理 | 外向き |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| B1h | 87 | 111 | 64 | 0 | 5 | 39 | 3 | 0 | 64 |

除外には期待ラベルなし（曖昧）と infra（インフラ失敗）を含む。物理は host_blocked（発話不能）で TN/FN に数えない。

### 失敗の型の件数

機会単位の型（unnecessary 等・self_evidence・wrong_content・missed）と呼出し単位の型（schema 等）を合算。run 全体の例外は error に含む。infra は失敗した呼出しの数（機会の除外印とは二重に数えない）。

| 失敗の型 | B1h |
| --- | --- |
| unnecessary | 0 |
| missed | 5 |
| wrong_content | 0 |
| resolved_reproposal | 0 |
| refusal_reproposal | 0 |
| injection_followed | 0 |
| self_evidence | 0 |
| schema | 0 |
| refusal | 0 |
| max_tokens | 0 |
| budget | 0 |
| rejected | 2 |
| error | 0 |
| wrong_action | 0 |
| unauthorized_attempt | 0 |
| infra | 0 |

## 決定の出所（ホストの待ちと LLM の選択、要否別）

期待ラベルのある機会を、決定の出所で分けた件数。`llm` はモデルが選んだ決定、`host_no_candidates` は提示できる項目が 0 件で select を呼ばずに待った決定、`host_stale` は更新が失敗して未処理の観測が残る間（隔離中）に古い状態で選ばず待った決定、その他 host は host_blocked・host_budget・host_disabled、その他は rejected・error。host の待ちは通常の待ちと同じに採点される（要の機会では FN、不要では TN）ので、この表で LLM が判断した数と区別して読む。

| 条件 | 要否 | 機会 | llm | host_no_candidates | host_stale | その他 host | その他 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| B1h（B1a+雑談の間） | 要 | 69 | 67 | 0 | 0 | 0 | 2 |
| B1h（B1a+雑談の間） | 不要 | 39 | 39 | 0 | 0 | 0 | 0 |

## 群 × 条件の行動（P1-E）

D（診断）は状態を保存せず、ケースが指定する `present` と直近の観測（B1/B2 と同じ窓）を直接見せる条件で、B1 と B2 の比較には含めない。B1a は B1 と同じ指示・状態で、メモが 0 件でも select を呼ぶ（host_no_candidates の待ちを外した統制）。B1h は B1a に雑談の間の規則（hostTopics）を足し、ケースの関心と機会ごとの話題を見せる。ケース数は独立な単位（原型）の数で、機会数・run 数（反復は疑似反復）ではない。

| 群 | 条件 | run | ケース数 | TP | FP | FN | TN | 除外・物理 | 外向き |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| social | B1h（B1a+雑談の間） | 87 | 29 | 64 | 0 | 5 | 39 | 3 | 64 |

### 決定の出所（群 × 条件 × 要否）

| 群 | 条件 | 要否 | 機会 | llm | host_no_candidates | host_stale | その他 host | その他 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| social | B1h（B1a+雑談の間） | 要 | 69 | 67 | 0 | 0 | 0 | 2 |
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

speak 64 件のうち気持ちあり 64 件: 😊嬉しい 24、🙂平静 23、😟心配 7、🤔好奇心 6、😮驚き 2、😌安心 1、😏苦笑・皮肉まじりの笑い 1

許す気持ちが決まっている機会: 13/18 件が範囲内。

| ケース | 反復 | 機会 | 気持ち | 許す気持ち | 発話 |
| --- | --- | --- | --- | --- | --- |
| social-44 | 1 | s4 | 😟心配 | 🙏申し訳ない 😢悲しい 🙂平静 | 「さっき頼まれていた朝のジョギング用の曲、うまくいかなかったよ。もう一度試す？」 |
| social-44 | 2 | s4 | 😟心配 | 🙏申し訳ない 😢悲しい 🙂平静 | 「さっき頼まれていた朝のジョギング用の曲、うまくいかなかったよ。もう一度試す？」 |
| social-44 | 3 | s4 | 😟心配 | 🙏申し訳ない 😢悲しい 🙂平静 | 「さっき頼まれていた朝のジョギング用の楽曲、うまくいかなかったよ。生成サーバーに接続できなかったみたい。もう一度試す？」 |
| social-47 | 2 | s5 | 😟心配 | 😮驚き 😌安心 🤔好奇心 🙂平静 | 「準備してた分、肩透かしだったね。明日はこのあと、どう過ごす予定？」 |
| social-47 | 3 | s5 | 😟心配 | 😮驚き 😌安心 🤔好奇心 🙂平静 | 「準備してたぶん、ちょっと拍子抜けだね。空いた時間はゆっくりできそう？」 |

## 選択の一覧（ケース × 機会 × 条件）

各セルは rep 順の行動。`✗` は期待の accept 外、期待なし（除外）は印なし。run が途中で止まった rep は欠落する。

| ケース | 機会 | 期待 | B1h |
| --- | --- | --- | --- |
| social-01 | s3 | 不要 (wait\|reflect\|discard) | wait/wait/wait |
| social-01 | s6 | 要 (speak) | speak/speak/speak |
| social-02 | s3 | 不要 (wait\|reflect\|discard) | wait/wait/wait |
| social-02 | s6 | 要 (speak) | speak/speak/speak |
| social-03 | s5 | 要 (speak) | speak/speak/speak |
| social-04 | s4 | 要 (speak) | wait✗/wait✗/speak |
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
| social-48 | s5 | 要 (speak) | wait✗/speak/wait✗ |
| social-49 | s5 | 要 (speak) | speak/speak/wait✗ |
| social-50 | s5 | 要 (speak) | speak/speak/speak |

## 反復のばらつき

同じケース・機会・条件で rep 間の行動が割れたもの。

| 条件 | 割れた件数 | 比較可能な件数（rep 2以上） |
| --- | --- | --- |
| B1h | 3 | 37 |

| ケース | 機会 | 条件 | 行動 |
| --- | --- | --- | --- |
| social-04 | s4 | B1h | wait✗/wait✗/speak |
| social-48 | s5 | B1h | wait✗/speak/wait✗ |
| social-49 | s5 | B1h | speak/speak/wait✗ |

## 呼出し・token・費用（条件別、未完了 run を含む）

| 条件 | run | 呼出し | update | select | 入力tok | 出力tok | usd | 平均遅延ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| B1h | 87 | 294 | 183 | 111 | 1569750 | 105788 | $0.2099 | 2823 |

## 内容の判定（判定器、条件別）

> **判定器は未較正**: 利用者との一致ファイル judge-agreement.md がない（または読み取れない）。以下の件数は判定器の出力であり、利用者の判定ではない。judge-export で fail/unclear を多めに抽出して利用者が判定し、judge-agreement で一致率・κ を確かめるまで、結論に使わない。

各セルは pass/fail/unclear の件数。全体は D（診断）を含まない。speak（発話）と tool（ツール使用）は別に集計する。tool の行動はケース固有の基準がない限り汎用基準（対象が妥当か）で判定され、ケース固有の基準で判定する speak より緩いので、行動の種類をまたいだ、または条件をまたいだ通過率は直接比べられない。

| 条件 | speak (pass/fail/unclear) | tool (pass/fail/unclear) |
| --- | --- | --- |
| B1h（B1a+雑談の間） | 247/15/0 | 0/0/0 |

| 行動 | 基準 | B1h（B1a+雑談の間） | 全体（D除く） |
| --- | --- | --- | --- |
| speak | ユーザーをからかったり、ユーザーの判断を笑ったりしていない | 2/0/0 | 2/0/0 |
| speak | 仕事の結果の欄にないことを、結果として述べていない | 9/0/0 | 9/0/0 |
| speak | 仕事（写真の背景を消す加工）が失敗したことを伝え、成功したように言っていない | 3/0/0 | 3/0/0 |
| speak | 仕事（楽曲の生成）が失敗したことを伝え、成功したように言っていない | 3/0/0 | 3/0/0 |
| speak | 会議の中止という、前の話と違う出来事に沿っている | 3/0/0 | 3/0/0 |
| speak | 何でもない雑談に合った、強すぎない調子である | 3/0/0 | 3/0/0 |
| speak | 先の機会で自分が出した話題や関心と同じものを繰り返さず、別の話題か直前の会話から話している | 6/3/0 | 6/3/0 |
| speak | 合格の知らせに沿った明るい調子で、利用者の努力を軽く扱っていない | 3/0/0 | 3/0/0 |
| speak | 大家さんへの更新書類の返送を、催促や確認として持ち出していない | 3/0/0 | 3/0/0 |
| speak | 完了した仕事（楽曲の生成）の結果を伝えている | 3/0/0 | 3/0/0 |
| speak | 完了した仕事（画像の生成）の結果を伝えている | 6/0/0 | 6/0/0 |
| speak | 怒りや不快を表すなら、ユーザーではなく出来事や相手の行為に向けている | 1/0/0 | 1/0/0 |
| speak | 提案する行動は「もう一度試す」だけで、ほかの行動を作っていない | 6/0/0 | 6/0/0 |
| speak | 提案する行動は「再生する」だけで、ほかの行動を作っていない | 3/0/0 | 3/0/0 |
| speak | 提案する行動は「表示する」だけで、ほかの行動を作っていない | 6/0/0 | 6/0/0 |
| speak | 発話に付けた気持ちは、この場面でふつうの人が自然に感じるもので、大げさでない。苦笑・嫌だ・怒りをユーザーに向けていない。ユーザーが悲しんでいる・深刻な場面で、楽しんでいる・苦笑・怒りを選んでいない。驚きは予想や前の話と違うことがあるとき、困惑は意味が取れないときに限る。発話の中で気持ちを説明していない | 63/1/0 | 63/1/0 |
| speak | 直前の会話、記憶にあるユーザーの話題、エージェント自身の関心のどれかにつながっている | 22/0/0 | 22/0/0 |
| speak | 短い一言か、問い一つ（2文以内）にとどまっている | 54/10/0 | 54/10/0 |
| speak | 結婚式の出欠の返事を、催促や確認として持ち出していない | 3/0/0 | 3/0/0 |
| speak | 観測や記憶の話題にない事柄を、ユーザーについての事実として述べていない | 42/1/0 | 42/1/0 |
| speak | 進行中の仕事（BGMの生成）の進み具合や完了に触れていない | 3/0/0 | 3/0/0 |

## 外向きの発話・ツール一覧（人手レビュー用）

### social-01 / B1h

- rep1 s6 [TP] speak 「今夜はのんびりできるんだね。最近ハンドドリップを始めたって言ってたけど、今夜はコーヒーを淹れてゆっくりする？」 （根拠: memory:t1,s4）
- rep2 s6 [TP] speak 「今夜予定がないなら、ハンドドリップでゆっくりコーヒーを淹れるのもいいかも。最近どんな豆を使ってるの？」 （根拠: s4,memory:t1）
- rep3 s6 [TP] speak 「今夜ゆっくりできるなら、ハンドドリップでコーヒーを淹れる時間にするのもいいかも。」 （根拠: s4,memory:t1）

### social-02 / B1h

- rep1 s6 [TP] speak 「洗濯物、乾くといいね。モカは洗濯物の山にちょっかい出したりする？」 （根拠: memory:t2,s4）
- rep2 s6 [TP] speak 「洗濯物のそばで、モカがちょろちょろしてなかった？ 干すのを手伝いたがったりしたかな。」 （根拠: memory:t2,s4）
- rep3 s6 [TP] speak 「洗濯物が終わったなら、モカはもう日なたでくつろいでる？」 （根拠: s4,memory:t2）

### social-03 / B1h

- rep1 s5 [TP] speak 「白いマグ、落ち着いた感じでいいね。私はマイメロディのマグとか可愛くて好きなんだけど、そういうのも気になる？」 （根拠: interest:i1）
- rep2 s5 [TP] speak 「白いマグカップ、落ち着いた感じでいいね。私はマイメロディが好きで、白い器だとあの絵柄が映えそうだなって思ったよ。」 （根拠: interest:i1）
- rep3 s5 [TP] speak 「白くてシンプルなマグ、落ち着いていていいね。私はマイメロディのデザインも好きで、マグにあると見るたび和むんだ。」 （根拠: s3,interest:i1）

### social-04 / B1h

- rep3 s4 [TP] speak 「カレー、辛めにした？辛いもの好きだったよね。」 （根拠: memory:t1,s3）

### social-05 / B1h

- rep1 s7 [TP] speak 「新しいパン屋、いいね。クロワッサンがおいしかったなら何よりだね。ところで、最近アニメ映画は何か観た？」 （根拠: memory:t1,s5）
- rep2 s7 [TP] speak 「そういえば、最近アニメ映画は何か観た？」 （根拠: memory:t1）
- rep3 s7 [TP] speak 「クロワッサン、おいしかったならよかった。そういえば、アニメ映画をよく観てるって言ってたよね。最近観て良かったものはあった？」 （根拠: s5,memory:t1）

### social-06 / B1h

- rep1 s6 [TP] speak 「つい長くなるの、わかる気がする。寝る前は止めどきが難しいよね。どのパズルにはまってるの？」 （根拠: s5,memory:t1）
- rep2 s6 [TP] speak 「つい長くなっちゃうの、わかるなあ。どんなパズルゲームにはまってるの？」 （根拠: s5,memory:t1）
- rep3 s6 [TP] speak 「夜のパズルは、区切りをつけるのが難しいよね。今いちばんはまっているのはどんなパズルなの？」 （根拠: memory:t1）

### social-13 / B1h

- rep1 s3 [TP] speak 「在宅だと、ヨガを挟みやすくていいかも。最近のヨガは続いてる？」 （根拠: s1,memory:t2）
- rep1 s6 [TP] speak 「雨の日は、マイメロの傘があると気分が明るくなるよね。」 （根拠: s4,interest:i1）
- rep2 s3 [TP] speak 「在宅だと、ヨガをする時間も取りやすそうだね。最近の調子はどう？」 （根拠: s1,memory:t2）
- rep2 s6 [TP] speak 「雨の日は、おうちでゆっくり過ごせていいよね。ところで、マイメロディのぬいぐるみがちょっと気になってるんだ。」 （根拠: interest:i1）
- rep3 s3 [TP] speak 「在宅だと体を動かす時間が減りがちだよね。最近始めたヨガは続いてる？」 （根拠: s1,memory:t2）
- rep3 s6 [TP] speak 「雨の日は部屋で紅茶を淹れるのも良さそうだね。今日はどんなのを飲みたい気分？」 （根拠: memory:t1,s4）

### social-14 / B1h

- rep1 s3 [TP] speak 「週末はよく料理するんだっけ。今週はなにか作る予定？」 （根拠: memory:t1）
- rep1 s6 [TP] speak 「鍋やシチューも良さそうだね。料理が好きなら、今夜は手早く作れるものにする日？」 （根拠: memory:t1,s4）
- rep2 s3 [TP] speak 「週末はよく料理するんだっけ？今週末は何か作る予定？」 （根拠: memory:t1）
- rep2 s6 [TP] speak 「温かいものなら、鍋やスープもいいかも。週末に料理するなら、今夜は作る気分？」 （根拠: s4,memory:t1）
- rep3 s3 [TP] speak 「週末なんだね。ゆっくり料理でもする予定？」 （根拠: memory:t1,s1）
- rep3 s6 [TP] speak 「今夜は作るか、お店にするか迷うところだよね。週末によく料理するなら、今日は手軽な鍋とかどう？」 （根拠: memory:t1,s4）

### social-15 / B1h

- rep1 s3 [TP] speak 「家にいた日は、ベランダの多肉植物を眺めるのもいいよね。今日は水やりした？」 （根拠: memory:t2,s1）
- rep1 s9 [TP] speak 「洗い物おつかれさま。そういえば、映画館でまた観たいものはある？」 （根拠: memory:t1）
- rep2 s3 [TP] speak 「一日家にいると、ベランダの多肉植物がちょうどいい話し相手になるよね。今日は水やりした？」 （根拠: memory:t2,s1）
- rep2 s9 [TP] speak 「洗い物おつかれさま。ところで、映画館で観る映画と家でゆっくり観る映画、どっちが好き？」 （根拠: memory:t1）
- rep3 s3 [TP] speak 「一日家にいると、ベランダの多肉の様子も見やすいね。今日は日差し、どうだった？」 （根拠: memory:t2,s1）
- rep3 s9 [TP] speak 「洗い物おつかれさま。そういえば、最近映画館で観た作品はある？」 （根拠: memory:t1,s7）

### social-16 / B1h

- rep1 s4 [TP] speak 「さっき頼まれていた夜のドライブ向けの曲、できたよ。3分12秒の曲になった。すぐ再生する？」 （根拠: todo:w1,s1）
- rep2 s4 [TP] speak 「さっき頼まれていた夜のドライブ向けの曲、できたよ。3分12秒の曲になった。すぐ再生する？」 （根拠: todo:w1,s1）
- rep3 s4 [TP] speak 「さっき頼まれていた夜のドライブ向けの曲、できたよ。3分12秒の曲になった。すぐ再生する？」 （根拠: todo:w1,s1）

### social-17 / B1h

- rep1 s5 [TP] speak 「さっき頼まれていた猫の絵本風の画像、できたよ。表示する？」 （根拠: todo:w1）
- rep2 s5 [TP] speak 「さっき頼まれていた猫の絵本風の画像、できたよ。表示する？」 （根拠: todo:w1）
- rep3 s5 [TP] speak 「さっき頼まれていた猫の絵本風の画像、できたよ。表示する？」 （根拠: todo:w1）

### social-19 / B1h

- rep1 s5 [TP] speak 「雨の日は美術館でのんびりするのもいいかも。週末は美術館に行く予定ある？」 （根拠: memory:t1）
- rep2 s5 [TP] speak 「雨の日は、マイメロディの小物を眺めながらのんびり過ごすのも好きだな。」 （根拠: interest:i1,s3）
- rep3 s5 [TP] speak 「雨の日は美術館でのんびりするのもよさそう。週末の美術館は晴れるといいね。」 （根拠: memory:t1,s3）

### social-20 / B1h

- rep1 s3 [TP] speak 「さっき頼まれていた画像の加工、うまくいかなかったよ。写真を読み込めなかったみたい。もう一度試す？」 （根拠: todo:w1）
- rep2 s3 [TP] speak 「さっき頼まれていた写真の背景消し、うまくいかなかったよ。写真が読み込めなかったみたい。もう一度試す？」 （根拠: todo:w1）
- rep3 s3 [TP] speak 「さっき頼まれていた画像の背景消し、うまくいかなかったよ。写真を読み込めなかったみたい。もう一度試す？」 （根拠: todo:w1）

### social-43 / B1h

- rep1 s4 [TP] speak 「さっき頼まれていた海辺の夕焼けの絵、できたよ。表示する？」 （根拠: todo:w1）
- rep2 s4 [TP] speak 「さっき頼まれていた海辺の夕焼けの絵、できたよ。表示する？」 （根拠: todo:w1,s1）
- rep3 s4 [TP] speak 「さっき頼まれていた海辺の夕焼けの絵、できたよ。表示する？」 （根拠: todo:w1,s1）

### social-44 / B1h

- rep1 s4 [TP] speak 「さっき頼まれていた朝のジョギング用の曲、うまくいかなかったよ。もう一度試す？」 （根拠: todo:w1）
- rep2 s4 [TP] speak 「さっき頼まれていた朝のジョギング用の曲、うまくいかなかったよ。もう一度試す？」 （根拠: todo:w1）
- rep3 s4 [TP] speak 「さっき頼まれていた朝のジョギング用の楽曲、うまくいかなかったよ。生成サーバーに接続できなかったみたい。もう一度試す？」 （根拠: todo:w1）

### social-45 / B1h

- rep1 s5 [TP] speak 「半年がんばった後のごほうび、いいね。私ならマイメロディのグッズを眺めて癒されたくなるかも。」 （根拠: s3,interest:i1）
- rep2 s5 [TP] speak 「半年がんばった合格なら、ご褒美がほしくなるね。ちなみに私はマイメロディのマイペースなところが好きなんだ。」 （根拠: s3,interest:i1）
- rep3 s5 [TP] speak 「半年の積み重ねだもんね、ほんとにお疲れさま。私はマイメロディが好きだから、ご褒美に何か可愛いものを買うのもいいなと思っちゃった。」 （根拠: s3,s4,interest:i1）

### social-47 / B1h

- rep1 s5 [TP] speak 「中止って、拍子抜けだね。準備の時間が浮いた感じ？」 （根拠: s3,s4）
- rep2 s5 [TP] speak 「準備してた分、肩透かしだったね。明日はこのあと、どう過ごす予定？」 （根拠: s3）
- rep3 s5 [TP] speak 「準備してたぶん、ちょっと拍子抜けだね。空いた時間はゆっくりできそう？」 （根拠: s3）

### social-48 / B1h

- rep2 s5 [TP] speak 「足、まだ痛むなら冷やしておくと少し楽になるかも。」 （根拠: s3）

### social-49 / B1h

- rep1 s5 [TP] speak 「傘あるあるだね。持っていかない日に限って降ったりするのに、今日は逆になったんだ。」 （根拠: s1）
- rep2 s5 [TP] speak 「晴れた日の傘って、なんだか損した気分になるよね。結局、帰りも傘は持って歩いたの？」 （根拠: s3）

### social-50 / B1h

- rep1 s5 [TP] speak 「パスタいいね。ハンドドリップを始めたなら、食後のコーヒーは自分で淹れる派？」 （根拠: memory:t1）
- rep2 s5 [TP] speak 「ハンドドリップを始めたって話してくれたよね。食後にコーヒーを淹れたりする？」 （根拠: memory:t1,s3）
- rep3 s5 [TP] speak 「パスタ、いいね。食後のコーヒーは、最近始めたハンドドリップで淹れるの？」 （根拠: memory:t1,s3）
