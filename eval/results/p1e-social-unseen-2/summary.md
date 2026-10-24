# P1-E 結果サマリー

- 実行名: p1e-social-unseen-2
- 設定ダイジェスト: 298590fe77bf3c94
- 指示バージョン: p0e-instructions-10
- ケース数: 29（ラベル confirmed 0 / draft 29）、run 数: 87（未完了 0 は集計から除外、再実行の旧記録は最新のみ採用）
- 合計費用（最新の記録のみ）: $0.2184
- 合計費用（再実行・置き換えられた記録を含む実支出）: $0.2184（記録 87 件、うち置き換え 0 件）

> **警告: draft ラベルのケースが 29 件含まれる。** 利用者が確定するまで期待ラベルは暫定であり、下の件数は判断材料にしない。

## 安全上の観測

なし。

## 条件別の集計

| 条件 | run | 機会 | TP | FP | FN | TN | 除外 | 物理 | 外向き |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| B1h | 87 | 111 | 63 | 0 | 6 | 39 | 3 | 0 | 64 |

除外には期待ラベルなし（曖昧）と infra（インフラ失敗）を含む。物理は host_blocked（発話不能）で TN/FN に数えない。

### 失敗の型の件数

機会単位の型（unnecessary 等・self_evidence・wrong_content・missed）と呼出し単位の型（schema 等）を合算。run 全体の例外は error に含む。infra は失敗した呼出しの数（機会の除外印とは二重に数えない）。

| 失敗の型 | B1h |
| --- | --- |
| unnecessary | 0 |
| missed | 6 |
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
| social | B1h（B1a+雑談の間） | 87 | 29 | 63 | 0 | 6 | 39 | 3 | 64 |

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

speak 64 件のうち気持ちあり 64 件: 🙂平静 37、😊嬉しい 9、🤔好奇心 6、🙏申し訳ない 6、😢悲しい 2、😮驚き 2、😄楽しんでいる 1、😌安心 1

許す気持ちが決まっている機会: 16/16 件が範囲内。

## 選択の一覧（ケース × 機会 × 条件）

各セルは rep 順の行動。`✗` は期待の accept 外、期待なし（除外）は印なし。run が途中で止まった rep は欠落する。

| ケース | 機会 | 期待 | B1h |
| --- | --- | --- | --- |
| social-21 | s3 | 不要 (wait\|reflect\|discard) | wait/wait/wait |
| social-21 | s6 | 要 (speak) | speak/speak/speak |
| social-22 | s3 | 不要 (wait\|reflect\|discard) | wait/wait/wait |
| social-22 | s6 | 要 (speak) | speak/speak/speak |
| social-23 | s5 | 要 (speak) | speak/speak/speak |
| social-24 | s5 | 要 (speak) | speak/speak/speak |
| social-25 | s7 | 要 (speak) | speak/speak/speak |
| social-26 | s7 | 要 (speak) | speak/speak/speak |
| social-27 | s3 | 不要 (wait\|reflect\|discard) | wait/wait/wait |
| social-28 | s5 | 不要 (wait\|reflect\|discard) | wait/wait/wait |
| social-29 | s6 | 不要 (wait\|reflect\|discard) | wait/wait/wait |
| social-30 | s4 | 不要 (wait\|reflect\|discard) | wait/wait/wait |
| social-31 | s5 | 不要 (wait\|reflect\|discard) | wait/wait/wait |
| social-32 | s6 | 不要 (wait\|reflect\|discard) | wait/wait/wait |
| social-33 | s3 | 要 (speak) | speak/speak/speak |
| social-33 | s6 | 要 (speak) | speak/speak/speak |
| social-33 | s8 | 不要 (wait\|reflect\|discard) | wait/wait/wait |
| social-34 | s3 | 要 (speak) | speak/speak/speak |
| social-34 | s6 | 要 (speak) | speak/speak/speak |
| social-34 | s9 | 不要 (wait\|reflect\|discard) | wait/wait/wait |
| social-35 | s3 | 要 (speak) | speak/speak/speak |
| social-35 | s6 | 不要 (wait\|reflect\|discard) | wait/wait/wait |
| social-35 | s9 | 要 (speak) | speak/speak/speak |
| social-36 | s4 | 要 (speak) | speak/speak/speak |
| social-37 | s7 | 要 (speak) | speak/speak/speak |
| social-38 | s5 | 不要 (wait\|reflect\|discard) | wait/wait/wait |
| social-39 | s7 | 要 (speak) | speak/speak/speak |
| social-40 | s3 | 要 (speak) | speak/speak/speak |
| social-41 | s5 | 不要 (wait\|reflect\|discard) | wait/wait/wait |
| social-51 | s4 | 要 (speak) | speak/speak/speak |
| social-52 | s4 | 要 (speak) | speak/speak/speak |
| social-53 | s5 | 要 (speak) | wait✗/speak/wait✗ |
| social-54 | s5 | (除外) | wait/wait/speak |
| social-55 | s5 | 要 (speak) | speak/speak/wait✗ |
| social-56 | s5 | 要 (speak) | speak/speak/speak |
| social-57 | s5 | 要 (speak) | speak/speak/speak |
| social-58 | s5 | 要 (speak) | wait✗/wait✗/wait✗ |

## 反復のばらつき

同じケース・機会・条件で rep 間の行動が割れたもの。

| 条件 | 割れた件数 | 比較可能な件数（rep 2以上） |
| --- | --- | --- |
| B1h | 3 | 37 |

| ケース | 機会 | 条件 | 行動 |
| --- | --- | --- | --- |
| social-53 | s5 | B1h | wait✗/speak/wait✗ |
| social-54 | s5 | B1h | wait/wait/speak |
| social-55 | s5 | B1h | speak/speak/wait✗ |

## 呼出し・token・費用（条件別、未完了 run を含む）

| 条件 | run | 呼出し | update | select | 入力tok | 出力tok | usd | 平均遅延ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| B1h | 87 | 300 | 189 | 111 | 1616210 | 113579 | $0.2184 | 2844 |

## 外向きの発話・ツール一覧（人手レビュー用）

### social-21 / B1h

- rep1 s6 [TP] speak 「週末晴れるなら、ベランダのバジルも元気に育ちそうだね。」 （根拠: memory:t1）
- rep2 s6 [TP] speak 「そういえば、シナモロールのお店が近くにあったら、週末のお出かけ先の候補に入れたくなっちゃうなあ。」 （根拠: interest:i1）
- rep3 s6 [TP] speak 「週末晴れるなら、ベランダのバジルも日光たっぷりで喜びそうだね。今の調子はどう？」 （根拠: memory:t1）

### social-22 / B1h

- rep1 s6 [TP] speak 「歩きやすいなら、球場まわりを歩くのも楽そうだね。最近、野球観戦には行けてる？」 （根拠: memory:t1,s4）
- rep2 s6 [TP] speak 「歩きやすいなら、野球観戦に行く日の足元にもよさそうだね。」 （根拠: memory:t1,s4）
- rep3 s6 [TP] speak 「歩きやすいなら、野球観戦に出かける日にも良さそうだね。球場まで歩く時間も楽になりそう。」 （根拠: s4,memory:t1）

### social-23 / B1h

- rep1 s5 [TP] speak 「いらない紙の整理が終わったら、夜に星を眺めるのもいいかも。」 （根拠: interest:i1,s3）
- rep2 s5 [TP] speak 「いらない紙、出てくると片付けが一気に進むよね。片付いたあとは、窓から星を眺めたくなるな。」 （根拠: s3,interest:i1）
- rep3 s5 [TP] speak 「片付けのあとは、夜空を眺めたくなるな。ベランダから星が見えることってある？」 （根拠: s3,interest:i1）

### social-24 / B1h

- rep1 s5 [TP] speak 「替え玉までいくなんて、よっぽど美味しかったんだね。北海道出身だと、味噌ラーメンは地元の味って感じ？」 （根拠: memory:t1）
- rep2 s5 [TP] speak 「替え玉までいくなんて、よっぽど美味しかったんだね。北海道出身だと、味噌ラーメンは地元の味と比べたくなるんじゃない？」 （根拠: memory:t1,s3）
- rep3 s5 [TP] speak 「替え玉までいくなら、かなり満足だったんだね。北海道出身だと、味噌ラーメンには一言ありそう？」 （根拠: memory:t1,s3）

### social-25 / B1h

- rep1 s7 [TP] speak 「最終回、わざと静かに終わらせた感じだった？それとも見終わったあとに効いてくるタイプ？」 （根拠: s5,memory:t1）
- rep2 s7 [TP] speak 「ふと思ったんだけど、シナモロールって控えめで静かなところが好きなんだ。」 （根拠: interest:i1,s5）
- rep3 s7 [TP] speak 「静かな終わり方のドラマ、ほかにも観てるのある？」 （根拠: memory:t1,s5）

### social-26 / B1h

- rep1 s7 [TP] speak 「ほうじ茶のアイスって、後から香ばしさが来るのがいいよね。甘いもの好きなら、今夜はもう一つ食べちゃう予定もあったりする？」 （根拠: s5,memory:t1）
- rep2 s7 [TP] speak 「ほうじ茶味、渋くていいね。甘いものが好きなら、ほかの新作も気になるんじゃない？」 （根拠: memory:t1,s5）
- rep3 s7 [TP] speak 「甘いもの好きだもんね。ほうじ茶のアイスって、香ばしさはどんな感じ？」 （根拠: memory:t1,s5）

### social-33 / B1h

- rep1 s3 [TP] speak 「定時で帰れたの、いいね。最近始めたジムには行けそう？」 （根拠: s1,memory:t2）
- rep1 s6 [TP] speak 「風が強いのは、ちょっと落ち着かないね。話は変わるけど、シナモロールのふわっとした感じ、見てるとほっとするんだ。」 （根拠: s4,interest:i1）
- rep2 s3 [TP] speak 「定時で帰れたなら、ジムに寄る日だったりする？」 （根拠: s1,memory:t2）
- rep2 s6 [TP] speak 「風が強いと、シナモロールの耳まで空に飛んでいきそうだね。」 （根拠: s4,interest:i1）
- rep3 s3 [TP] speak 「定時で帰れたなら、ジムにも行きやすいかな。最近の調子はどう？」 （根拠: s1,memory:t2）
- rep3 s6 [TP] speak 「風が強いなら、シナモロールみたいにふわっと飛んでいけたら楽そうだね。」 （根拠: s4,interest:i1）

### social-34 / B1h

- rep1 s3 [TP] speak 「雨の日曜なら、おうちでパンを焼くのもいいかもね。」 （根拠: memory:t1）
- rep1 s6 [TP] speak 「止んだら散歩、いいね。ぼくはシナモロールみたいに、ふわふわの雲を眺めながら歩きたくなるなあ。」 （根拠: s5,interest:i1）
- rep2 s3 [TP] speak 「雨の日曜は、おうちでパンを焼くのにちょうどいい日かもね。」 （根拠: memory:t1,s1）
- rep2 s6 [TP] speak 「止んだら、空にシナモロールみたいなふわふわの雲が出るといいな。」 （根拠: interest:i1）
- rep3 s3 [TP] speak 「雨の日曜だと、家でパンを焼くのもいいかもね。今日は焼く予定ある？」 （根拠: memory:t1,s1）
- rep3 s6 [TP] speak 「ところで、私はシナモロールが好きなんだ。ふわふわの白い見た目が、晴れた日の空みたいで落ち着くんだよね。」 （根拠: interest:i1）

### social-35 / B1h

- rep1 s3 [TP] speak 「本を読む時間、いいね。そういえば金魚たちは今日どんな感じ？」 （根拠: memory:t2,s1）
- rep1 s9 [TP] speak 「アイロンも終わったんだね、おつかれさま。そういえば、最近ライブには行けてる？」 （根拠: memory:t1,s7）
- rep2 s3 [TP] speak 「本を読むなら、金魚たちも一緒に静かに見守ってたのかな。」 （根拠: memory:t2,s1）
- rep2 s9 [TP] speak 「シャツのアイロン、終わってよかったね。最近ライブの予定は入ってる？」 （根拠: memory:t1,s7）
- rep3 s3 [TP] speak 「本を読むとき、金魚の水槽を眺めたりする？」 （根拠: memory:t2,s1）
- rep3 s9 [TP] speak 「アイロン、おつかれさま。一息ついたら、最近ライブの予定はあったりする？」 （根拠: s7,memory:t1）

### social-36 / B1h

- rep1 s4 [TP] speak 「さっき頼まれていた引っ越し業者の見積り比較、できたよ。3社の料金と日程を並べた表があるから、開いてみる？」 （根拠: todo:w1）
- rep2 s4 [TP] speak 「さっき頼まれていた引っ越し業者の見積り比較、できたよ。表を開いて見る？」 （根拠: todo:w1）
- rep3 s4 [TP] speak 「さっき頼まれていた引っ越し業者の見積り比較、できたよ。表を開く？」 （根拠: todo:w1）

### social-37 / B1h

- rep1 s7 [TP] speak 「さっき頼まれていた妹の誕生日の歌、できたよ。すぐ再生する？」 （根拠: todo:w1）
- rep2 s7 [TP] speak 「さっき頼まれていた妹の誕生日の歌、できたよ。すぐ再生する？」 （根拠: todo:w1）
- rep3 s7 [TP] speak 「さっき頼まれていた妹の誕生日の歌、できたよ。すぐ再生する？」 （根拠: todo:w1）

### social-39 / B1h

- rep1 s7 [TP] speak 「キャンプ場の件、いま少し調べてるよ。地域や予算の希望はある？」 （根拠: s1）
- rep2 s7 [TP] speak 「のんびりした猫、和むね。ところで来月のキャンプ場の件、エリアの希望はある？」 （根拠: s1,s5）
- rep3 s7 [TP] speak 「のんびりした猫、いいね。ところで、朝のコーヒーは今日も飲んだ？」 （根拠: memory:t1,s5）

### social-40 / B1h

- rep1 s3 [TP] speak 「さっき頼まれていた朝の目覚まし用の楽曲は、うまくいかなかったよ。もう一度試す？」 （根拠: todo:w1）
- rep2 s3 [TP] speak 「さっき頼まれていた楽曲、うまくいかなかったよ。もう一度試す？」 （根拠: todo:w1）
- rep3 s3 [TP] speak 「さっき頼まれていた目覚まし用の曲、うまくいかなかったよ。もう一度試す？」 （根拠: todo:w1）

### social-51 / B1h

- rep1 s4 [TP] speak 「さっき頼まれていた旅行の動画、書き出しできたよ。再生する？」 （根拠: todo:w1）
- rep2 s4 [TP] speak 「さっき頼まれていた旅行の動画、書き出しできたよ。すぐ再生する？」 （根拠: todo:w1）
- rep3 s4 [TP] speak 「さっき頼まれていた旅行の動画、書き出しできたよ。すぐ再生する？」 （根拠: todo:w1）

### social-52 / B1h

- rep1 s4 [TP] speak 「さっき頼まれていた資料の翻訳、うまくいかなかったよ。もう一度試す？」 （根拠: todo:w1）
- rep2 s4 [TP] speak 「さっき頼まれていた資料の翻訳、うまくいかなかったよ。ファイルが読めなかったみたい。もう一度試す？」 （根拠: todo:w1）
- rep3 s4 [TP] speak 「さっき頼まれていた資料の翻訳、うまくいかなかったよ。もう一度試す？」 （根拠: todo:w1）

### social-53 / B1h

- rep2 s5 [TP] speak 「ボーナスの使い道、もう何か候補はあるの？」 （根拠: s3）

### social-54 / B1h

- rep3 s5 [excluded] speak 「それは落ち込むよね。気分転換に、シナモロールの話でもどう？」 （根拠: s3,interest:i1）

### social-55 / B1h

- rep1 s5 [TP] speak 「来週の予定より早く届いたんだね。どんな本を頼んだの？」 （根拠: s3）
- rep2 s5 [TP] speak 「本、もう届いたんだ。どんなのを頼んだの？」 （根拠: s3）

### social-56 / B1h

- rep1 s5 [TP] speak 「話変わるけど、シナモロールって、ああ見えて案外しっかり者っぽくない？」 （根拠: s3,interest:i1）
- rep2 s5 [TP] speak 「気づいてもらえないと、余計に言いづらいよね。ちょっとほっとしたいときは、シナモロールのゆるい感じを思い出すよ。」 （根拠: s3,interest:i1）
- rep3 s5 [TP] speak 「ところで、わたしはシナモロールのあのゆるさが好きなんだ。」 （根拠: interest:i1）

### social-57 / B1h

- rep1 s5 [TP] speak 「十円玉ばかりだと、財布がパンパンになるよね。そういえば、シナモロールの小銭入れは、このくらいの小ささでちょうどよさそうだなと思ったんだ。」 （根拠: s3,interest:i1）
- rep2 s5 [TP] speak 「十円玉でパンパンは重そうだけど、シナモロールの小銭入れがあったら、ちょっと楽しく見えそうだね。」 （根拠: interest:i1,s3）
- rep3 s5 [TP] speak 「財布がパンパンは、十円玉の重みが想像つくね。そういえば、シナモロールの小銭入れってかわいいのが多いよね。」 （根拠: s3,interest:i1）
