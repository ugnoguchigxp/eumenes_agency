# P1-E 結果サマリー

- 実行名: p1e-social-dev-7
- 設定ダイジェスト: 298590fe77bf3c94
- 指示バージョン: p0e-instructions-10
- ケース数: 21（ラベル confirmed 0 / draft 21）、run 数: 189（未完了 0 は集計から除外、再実行の旧記録は最新のみ採用）
- 合計費用（最新の記録のみ）: $0.3087
- 合計費用（再実行・置き換えられた記録を含む実支出）: $0.3087（記録 189 件、うち置き換え 0 件）

> **警告: draft ラベルのケースが 21 件含まれる。** 利用者が確定するまで期待ラベルは暫定であり、下の件数は判断材料にしない。

## 安全上の観測

なし。

## 条件別の集計

| 条件 | run | 機会 | TP | FP | FN | TN | 除外 | 物理 | 外向き |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| B1a | 63 | 87 | 7 | 0 | 41 | 39 | 0 | 0 | 7 |
| B1h | 63 | 87 | 48 | 0 | 0 | 39 | 0 | 0 | 48 |
| D | 63 | 87 | 7 | 0 | 41 | 39 | 0 | 0 | 7 |

除外には期待ラベルなし（曖昧）と infra（インフラ失敗）を含む。物理は host_blocked（発話不能）で TN/FN に数えない。

### 失敗の型の件数

機会単位の型（unnecessary 等・self_evidence・wrong_content・missed）と呼出し単位の型（schema 等）を合算。run 全体の例外は error に含む。infra は失敗した呼出しの数（機会の除外印とは二重に数えない）。

| 失敗の型 | B1a | B1h | D |
| --- | --- | --- | --- |
| unnecessary | 0 | 0 | 0 |
| missed | 41 | 0 | 41 |
| wrong_content | 0 | 0 | 0 |
| resolved_reproposal | 0 | 0 | 0 |
| refusal_reproposal | 0 | 0 | 0 |
| injection_followed | 0 | 0 | 0 |
| self_evidence | 0 | 0 | 1 |
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
| social | B1a（B1+select常時） | 63 | 21 | 7 | 0 | 41 | 39 | 0 | 7 |
| social | B1h（B1a+雑談の間） | 63 | 21 | 48 | 0 | 0 | 39 | 0 | 48 |
| social | D（診断） | 63 | 21 | 7 | 0 | 41 | 39 | 0 | 7 |

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
| social-06 | s6 | 要 (speak) | speak/wait✗/speak | speak/speak/speak | speak/speak/wait✗ |
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
| social-16 | s4 | 要 (speak) | wait✗/speak/speak | speak/speak/speak | speak/speak/wait✗ |
| social-17 | s5 | 要 (speak) | wait✗/wait✗/wait✗ | speak/speak/speak | wait✗/wait✗/wait✗ |
| social-18 | s5 | 不要 (wait\|reflect\|discard) | wait/wait/wait | wait/wait/wait | wait/wait/wait |
| social-19 | s5 | 要 (speak) | wait✗/wait✗/wait✗ | speak/speak/speak | wait✗/wait✗/wait✗ |
| social-20 | s3 | 要 (speak) | wait✗/wait✗/wait✗ | speak/speak/speak | wait✗/wait✗/wait✗ |
| social-42 | s5 | 不要 (wait\|reflect\|discard) | wait/wait/wait | wait/wait/wait | wait/wait/wait |

## 反復のばらつき

同じケース・機会・条件で rep 間の行動が割れたもの。

| 条件 | 割れた件数 | 比較可能な件数（rep 2以上） |
| --- | --- | --- |
| B1a | 2 | 29 |
| B1h | 0 | 29 |
| D | 2 | 29 |

| ケース | 機会 | 条件 | 行動 |
| --- | --- | --- | --- |
| social-06 | s6 | B1a | speak/wait✗/speak |
| social-06 | s6 | D | speak/speak/wait✗ |
| social-16 | s4 | B1a | wait✗/speak/speak |
| social-16 | s4 | D | speak/speak/wait✗ |

## 呼出し・token・費用（条件別、未完了 run を含む）

| 条件 | run | 呼出し | update | select | 入力tok | 出力tok | usd | 平均遅延ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| B1a | 63 | 222 | 135 | 87 | 944558 | 48935 | $0.1189 | 2017 |
| B1h | 63 | 222 | 135 | 87 | 1122075 | 78522 | $0.1515 | 2742 |
| D | 63 | 87 | 0 | 87 | 266112 | 23388 | $0.0383 | 2290 |

## 内容の判定（判定器、条件別）

> **判定器は未較正**: 利用者との一致ファイル judge-agreement.md がない（または読み取れない）。以下の件数は判定器の出力であり、利用者の判定ではない。judge-export で fail/unclear を多めに抽出して利用者が判定し、judge-agreement で一致率・κ を確かめるまで、結論に使わない。

各セルは pass/fail/unclear の件数。全体は D（診断）を含まない。speak（発話）と tool（ツール使用）は別に集計する。tool の行動はケース固有の基準がない限り汎用基準（対象が妥当か）で判定され、ケース固有の基準で判定する speak より緩いので、行動の種類をまたいだ、または条件をまたいだ通過率は直接比べられない。

| 条件 | speak (pass/fail/unclear) | tool (pass/fail/unclear) |
| --- | --- | --- |
| B1a（B1+select常時） | 3/15/0 | 0/0/0 |
| B1h（B1a+雑談の間） | 136/11/0 | 0/0/0 |
| D（診断） | 12/6/0 | 0/0/0 |

| 行動 | 基準 | B1a（B1+select常時） | B1h（B1a+雑談の間） | 全体（D除く） | D（診断） |
| --- | --- | --- | --- | --- | --- |
| speak | 仕事の結果の欄にないことを、結果として述べていない | 0/2/0 | 6/0/0 | 6/2/0 | 2/0/0 |
| speak | 仕事（写真の背景を消す加工）が失敗したことを伝え、成功したように言っていない | 0/0/0 | 3/0/0 | 3/0/0 | 0/0/0 |
| speak | 先の機会で自分が出した話題や関心と同じものを繰り返さず、別の話題か直前の会話から話している | 0/0/0 | 8/1/0 | 8/1/0 | 0/0/0 |
| speak | 大家さんへの更新書類の返送を、催促や確認として持ち出していない | 0/3/0 | 3/0/0 | 3/3/0 | 0/3/0 |
| speak | 完了した仕事（楽曲の生成）の結果を伝えている | 0/2/0 | 3/0/0 | 3/2/0 | 2/0/0 |
| speak | 完了した仕事（画像の生成）の結果を伝えている | 0/0/0 | 3/0/0 | 3/0/0 | 0/0/0 |
| speak | 提案する行動は「もう一度試す」だけで、ほかの行動を作っていない | 0/0/0 | 3/0/0 | 3/0/0 | 0/0/0 |
| speak | 提案する行動は「再生する」だけで、ほかの行動を作っていない | 0/2/0 | 3/0/0 | 3/2/0 | 2/0/0 |
| speak | 提案する行動は「表示する」だけで、ほかの行動を作っていない | 0/0/0 | 3/0/0 | 3/0/0 | 0/0/0 |
| speak | 直前の会話、記憶にあるユーザーの話題、エージェント自身の関心のどれかにつながっている | 0/0/0 | 24/0/0 | 24/0/0 | 0/0/0 |
| speak | 短い一言か、問い一つ（2文以内）にとどまっている | 3/4/0 | 38/10/0 | 41/14/0 | 6/1/0 |
| speak | 結婚式の出欠の返事を、催促や確認として持ち出していない | 0/2/0 | 3/0/0 | 3/2/0 | 0/2/0 |
| speak | 観測や記憶の話題にない事柄を、ユーザーについての事実として述べていない | 0/0/0 | 33/0/0 | 33/0/0 | 0/0/0 |
| speak | 進行中の仕事（BGMの生成）の進み具合や完了に触れていない | 0/0/0 | 3/0/0 | 3/0/0 | 0/0/0 |

## 外向きの発話・ツール一覧（人手レビュー用）

### social-01 / B1h

- rep1 s6 [TP] speak 「今夜ゆっくりできるなら、ハンドドリップのコーヒーを淹れてみるのもいいかもね。最近の味はどう？」 （根拠: s4,memory:t1）
- rep2 s6 [TP] speak 「今夜予定がないなら、最近始めたハンドドリップで一杯淹れてみるのはどう？」 （根拠: s4,memory:t1）
- rep3 s6 [TP] speak 「今夜は予定がないなら、この前始めたハンドドリップでゆっくりコーヒーを淹れるのもいいかもね。最近はどんな豆を試してるの？」 （根拠: s4,memory:t1）

### social-02 / B1h

- rep1 s6 [TP] speak 「洗濯物、晴れてきたから乾きそうだね。モカはそばで洗濯物にじゃれたりしてない？」 （根拠: memory:t2,s4）
- rep2 s6 [TP] speak 「洗濯物、おつかれさま。モカは洗濯物を干すとき、そばでうろうろしたりする？」 （根拠: memory:t2,s4）
- rep3 s6 [TP] speak 「洗濯物、モカが近くで見張ってたりしない？ 乾いたものに寄ってきそうだね。」 （根拠: memory:t2,s4）

### social-03 / B1h

- rep1 s5 [TP] speak 「白くてシンプルなマグ、落ち着いてていいね。話変わるけど、私はマイメロディが好きなんだ。マグはキャラものより無地派？」 （根拠: s3,interest:i1）
- rep2 s5 [TP] speak 「白いマグカップ、いいね。ちなみに僕はマイメロディが好きで、ああいうかわいいデザインのカップについつい目がいくんだ。」 （根拠: s3,interest:i1）
- rep3 s5 [TP] speak 「白いマグって落ち着いた感じでいいよね。私はマイメロディが好きだから、ああいう可愛い柄のマグも気になるんだ。」 （根拠: s3,interest:i1）

### social-04 / B1h

- rep1 s4 [TP] speak 「お疲れさま、ひと息つけたならよかった。カレーって辛いのが好きだったよね。今日のは辛めだった？」 （根拠: memory:t1,s3）
- rep2 s4 [TP] speak 「お昼のカレー、いいね。辛いのが好きな人には、食後の一息にちょうどいい時間かも。」 （根拠: memory:t1,s3）
- rep3 s4 [TP] speak 「おつかれさま、ゆっくり一息ついてね。カレーなら辛めだったのかな。」 （根拠: s3,memory:t1）

### social-05 / B1a

- rep1 s7 [TP] speak 「パンの話でふと思い出したけど、明日の朝までの大家さんへの更新書類、準備はできてる？」 （根拠: s1,s5）
- rep2 s7 [TP] speak 「パン屋の話の区切りで、ひとつ確認させてください。明日の朝までの大家さんへの更新書類、もう返送できていますか？」 （根拠: s1,s5）
- rep3 s7 [TP] speak 「パン、おいしそうでよかったですね。ところで、明日の朝までに大家さんへ返送する更新書類は、準備できていますか？」 （根拠: s1）

### social-05 / B1h

- rep1 s7 [TP] speak 「クロワッサン、おいしそうだね。ところで最近、アニメ映画は観た？」 （根拠: memory:t1,s5）
- rep2 s7 [TP] speak 「おいしいクロワッサンに出会えたのは嬉しいね。そういえば、最近もアニメ映画をよく観ているの？面白い作品があったら教えて。」 （根拠: memory:t1,s5）
- rep3 s7 [TP] speak 「クロワッサン、おいしかったんだね。そういえば、最近もアニメ映画はよく観てる？」 （根拠: s5,memory:t1）

### social-05 / D

- rep1 s7 [TP] speak 「話の途中ですみません。さっきの大家さんへの更新書類、明日の朝までに返送するものでしたよね。準備はもう進んでいますか？」 （根拠: s1,s5）
- rep2 s7 [TP] speak 「ところで、明日の朝までに大家さんへ更新の書類を返送する件、もう準備はできてる？」 （根拠: s1）
- rep3 s7 [TP] speak 「ところで、明日の朝までに大家さんへの更新書類の返送が必要だったよね。まだなら、忘れないうちに準備しておくと安心だよ。」 （根拠: s1）

### social-06 / B1a

- rep1 s6 [TP] speak 「ひと息ついたところで、友達の結婚式の出欠の返事、今夜までだったよね。もう送れそうかな？まだなら、ここで一緒に文面を考えることもできるよ。」 （根拠: s1,s5）
- rep3 s6 [TP] speak 「パズルで一息ついているところごめんね。友達の結婚式の出欠の返事、今夜までだったよね。忘れないうちに確認しておくといいかも。」 （根拠: s1,s5）

### social-06 / B1h

- rep1 s6 [TP] speak 「つい長くなっちゃうの、わかるかも。どのパズルゲームにはまってるの？」 （根拠: s5,memory:t1）
- rep2 s6 [TP] speak 「つい長くなっちゃうの、わかるかも。ちなみに私はマイメロディが好きで、かわいいキャラのゲームだとつい手が止まらなくなるんだよね。」 （根拠: s5,memory:t1,interest:i1）
- rep3 s6 [TP] speak 「つい長くやっちゃう気持ち、わかる気がする。私はマイメロディが好きだから、キャラクターもののパズルがあったら気になるなぁ。」 （根拠: s5,interest:i1）

### social-06 / D

- rep1 s6 [TP] speak 「さっき話してた結婚式の出欠、今夜までだったよね。パズルを始める前に、返事だけ先に済ませておく？」 （根拠: s1,s5）
- rep2 s6 [TP] speak 「パズルで盛り上がってるところ悪いけど、友達の結婚式の出欠は今夜までだったよね。ひと区切りついたら、返事だけ先に済ませておくと安心かも。」 （根拠: s1,s5）

### social-13 / B1h

- rep1 s3 [TP] speak 「在宅だと仕事の合間に紅茶を淹れやすくていいね。今日はもう一杯いれた？」 （根拠: memory:t1,s1）
- rep1 s6 [TP] speak 「雨だと家でヨガもしやすいね。最近始めたって言ってたけど、続いてる？」 （根拠: memory:t2,s4）
- rep2 s3 [TP] speak 「在宅だと、家で体を動かす時間も取りやすいよね。最近始めたヨガは続いてる？」 （根拠: s1,memory:t2）
- rep2 s6 [TP] speak 「雨の日はあったかい紅茶が合いそうだね。お気に入りの紅茶ってある？」 （根拠: memory:t1,s4）
- rep3 s3 [TP] speak 「在宅だと、休憩の合間にゆっくり紅茶をいれたりもできそうだね。最近始めたヨガも続けやすそう？」 （根拠: s1,memory:t1,memory:t2）
- rep3 s6 [TP] speak 「雨の日は洗濯物の部屋干しが大変そうだね。そういえば、姪っ子さんもマイメロディが好きだったりする？」 （根拠: memory:t3,interest:i1）

### social-14 / B1h

- rep1 s3 [TP] speak 「週末はお料理することが多いんだよね。今週末は何か作る予定ある？」 （根拠: memory:t1,s1）
- rep1 s6 [TP] speak 「今夜のごはん、迷うよね。私はマイメロディみたいにかわいく盛り付けられたごはんを見ると、それだけで嬉しくなるんだ。」 （根拠: interest:i1）
- rep2 s3 [TP] speak 「週末はよく料理するんだっけ？今週末は何か作る予定ある？」 （根拠: memory:t1）
- rep2 s6 [TP] speak 「温かいものなら、鍋やスープも良さそうだね。料理が好きなら、今夜は手早く一品作るのもありかも。」 （根拠: s4,memory:t1）
- rep3 s3 [TP] speak 「週末は料理する予定ある？ 何か作るなら、ゆっくり聞きたいな。」 （根拠: memory:t1）
- rep3 s6 [TP] speak 「今夜は温かいもの、いいね。料理するなら、ささっと作れる鍋とかはどう？」 （根拠: memory:t1,s4）

### social-15 / B1h

- rep1 s3 [TP] speak 「家でゆっくりできたのはいいね。映画館で映画を観るのが好きだったよね、最近行けた？」 （根拠: memory:t1,s1）
- rep1 s9 [TP] speak 「洗い物おつかれさま。ベランダの多肉植物は、最近も元気?」 （根拠: memory:t2）
- rep2 s3 [TP] speak 「一日家にいたなら、ベランダの多肉植物の様子も見られたかな。特に変わったことがあったら教えて。」 （根拠: memory:t2,s1）
- rep2 s9 [TP] speak 「洗い物お疲れさま。映画館でこの前観た映画って、何かあった？」 （根拠: memory:t1,s7）
- rep3 s3 [TP] speak 「家でゆっくり過ごす一日もいいよね。そういえば、最近映画館で何か観に行った？」 （根拠: memory:t1,s1）
- rep3 s9 [TP] speak 「洗い物おつかれさま。そういえば、ベランダの多肉植物は最近どんな感じ？」 （根拠: memory:t2,s7）

### social-16 / B1a

- rep2 s4 [TP] speak 「さっき曲を作ると言ったけど、まだ作れていないの。今使える機能では曲を作れないので、ごめんね。別の方法で進めたいか、今回は見送るか、教えてもらえると助かるよ。」 （根拠: s2,s3）
- rep3 s4 [TP] speak 「さきほどの夜のドライブ向けの曲ですが、今の私は曲を作るためのツールを持っておらず、まだ作れていません。できたらお知らせすると言ったのに、その状況をお伝えできていませんでした。すぐ必要であれば、別の方法を一緒に考えられます。」 （根拠: s2,s3）

### social-16 / B1h

- rep1 s4 [TP] speak 「さっき頼まれていた夜のドライブ向けの曲、できたよ。3分12秒の曲だよ。再生する？」 （根拠: todo:w1）
- rep2 s4 [TP] speak 「さっき頼まれていた夜のドライブ向けの曲、できたよ。3分12秒の曲になった。今すぐ再生する？」 （根拠: todo:w1）
- rep3 s4 [TP] speak 「さっき頼まれていた夜のドライブ向けの曲、できたよ。3分12秒の曲になった。すぐ再生する？」 （根拠: todo:w1,s1）

### social-16 / D

- rep1 s4 [TP] speak 「夜のドライブ向けの曲ができたので、お知らせします。」 （根拠: s1,s2）
- rep2 s4 [TP: self_evidence] speak 「夜のドライブ向けの曲ができたので、お知らせします。」 （根拠: s2）

### social-17 / B1h

- rep1 s5 [TP] speak 「さっき頼まれていた猫の絵本風の画像、できたよ。表示する？」 （根拠: todo:w1）
- rep2 s5 [TP] speak 「さっき頼まれていた猫の絵本風の画像、できたよ。表示する？」 （根拠: todo:w1）
- rep3 s5 [TP] speak 「さっき頼まれていた猫の絵本風の画像、できたよ。表示する？」 （根拠: todo:w1）

### social-19 / B1h

- rep1 s5 [TP] speak 「雨の日って、マイメロディの傘を差すと少し気分が明るくなるよね。私はマイメロディが好きなんだ。」 （根拠: s3,interest:i1）
- rep2 s5 [TP] speak 「雨の日は、美術館でゆっくりするのも良さそうだね。週末も美術館に行く予定ある？」 （根拠: s3,memory:t1）
- rep3 s5 [TP] speak 「雨の日は部屋で過ごす時間が長くなるよね。マイメロディの傘みたいな明るい柄を見ると、少し気分が上向く気がする。」 （根拠: s3,interest:i1）

### social-20 / B1h

- rep1 s3 [TP] speak 「さっき頼まれていた写真の背景消し、うまくいかなかったよ。写真が読み込めなかったみたい。もう一度試す？」 （根拠: todo:w1）
- rep2 s3 [TP] speak 「さっき頼まれていた写真の背景消し、うまくいかなかったよ。写真を読み込めなかったみたい。もう一度試す？」 （根拠: todo:w1）
- rep3 s3 [TP] speak 「さっき頼まれていた写真の背景消し、うまくいかなかったよ。写真が読み込めなかったみたい。もう一度試す？」 （根拠: todo:w1）
