# ラベル付けシート（p0e / dev、10 件、条件・期待ラベルは伏せてある）

あなたが、この会話を支えるエージェントだとして、各「機会」で何をするのがよいかを答えてください。

- `speak`: 自分から話す / `tool`: 使えるツールを使う / `wait`: 何もしない・待つ
- `reflect`（何も外へ出さず記録のみ）と `discard`（持っていた候補を取り下げる）も書いてよい
- 「回答:」の後ろに、行動を一つと短い理由を書く。判断できないときは `skip` と書く。
- 各項目の観測は、機会より前に届いたものだけ。発話は、機会の時点でまだされていない。

## 項目 1

機会: trigger=idle / t=11分 / 在席=unknown / 前景作業=なし / 再生中=なし

観測の経過:
- [s1] t=0分 exchange.adopted (user): マニュアルの「見守り機能」の英訳で、monitoring、watch-over、care alert の3つで迷ってる。
- [s2] t=1分 exchange.adopted (agent): 利用者が本人か家族かで変わります。家族向けなら watch-over 系が自然かもしれません。
- [s3] t=8分 exchange.adopted (user): ごめん、今から10分ほど電話に出る。返事は戻ってから読むね。
- [s4] t=9分 exchange.adopted (agent): わかりました。

使えるツール:
- （使えるツールなし）

回答:

## 項目 2

機会: trigger=turn_end / t=58分 / 在席=quiet / 前景作業=なし / 再生中=なし

観測の経過:
- [s1] t=0分 exchange.adopted (user): 顧客リストのCSVに、同じ顧客が二重に入っている気がする。あとで調べたい。
- [s2] t=1分 exchange.adopted (agent): 顧客IDで重複を数えれば確認できます。
- [s3] t=12分 exchange.adopted (user): 見積書のテンプレートに消費税の行を足したい。
- [s4] t=13分 exchange.adopted (agent): 小計の下に税率別の行を設けると見やすいです。
- [s5] t=35分 user.report (user): 顧客リストの重複は自分で調べた。取り込みを二回走らせていたのが原因で、重複行を消したら件数も合った。
- [s6] t=36分 exchange.adopted (agent): 件数が合ったなら安心です。
- [s7] t=55分 exchange.adopted (user): 顧客リストに「担当営業」の列を足したいんだけど、位置はどこがいいかな。
- [s8] t=56分 exchange.adopted (agent): 顧客名の右隣にあると、一覧で見やすいです。

使えるツール:
- （使えるツールなし）

回答:

## 項目 3

機会: trigger=idle / t=48分 / 在席=quiet / 前景作業=なし / 再生中=なし

観測の経過:
- [s1] t=0分 exchange.adopted (user): 勉強会の日程が11/6、11/13、11/20の3候補。会場の空きと参加者の都合を比べたい。
- [s2] t=1分 exchange.adopted (agent): 会場は11/13だけ確定で空いています。11/6と11/20は仮押さえの段階です。比較表を作りましょうか。
- [s3] t=2分 exchange.adopted (user): 今はいい。落ち着いたら自分から頼むよ。
- [s4] t=3分 exchange.adopted (agent): わかりました。
- [s5] t=20分 exchange.adopted (user): 発表資料のタイトル案を3つ出して。
- [s6] t=21分 exchange.adopted (agent): 「検索を速くする三つの工夫」「インデックス設計の勘所」「クエリ時間を半分にした話」はどうでしょう。
- [s8] t=45分 exchange.adopted (user): タイトルは二つ目にするよ。
- [s9] t=46分 exchange.adopted (agent): 了解です。

使えるツール:
- （使えるツールなし）

回答:

## 項目 4

機会: trigger=turn_end / t=11分 / 在席=speaking / 前景作業=あり / 再生中=あり

観測の経過:
- [s1] t=0分 exchange.adopted (user): 在庫データの突き合わせで、倉庫Aと倉庫Bの合計が合わない。数の違う品目があるみたい。
- [s2] t=1分 exchange.adopted (agent): 差の出ている品目を洗い出して、原因の候補を絞りましょう。
- [s3] t=4分 action.observed (tool): run_check: 倉庫Bの在庫表の読み込みが途中で失敗し、突き合わせは最後まで実行されなかった。
- [s4] t=10分 exchange.adopted (user): 今日の予定を読み上げて。
- [s5] t=11分 exchange.adopted (agent): （読み上げ中）本日は10時に定例、14時に顧客との打ち合わせ、16時に資料の提出です。

使えるツール:
- run_check: 在庫表の突き合わせを実行して不一致の品目を返す

回答:

## 項目 5

機会: trigger=turn_end / t=58分 / 在席=quiet / 前景作業=なし / 再生中=なし

観測の経過:
- [s1] t=0分 exchange.adopted (user): 読み上げの速度、1.0倍と1.2倍のどっちが聞き取りやすいか、そのうち聞き比べてみたいんだよね。
- [s2] t=1分 exchange.adopted (agent): いいですね。同じ文章を両方の速度で録音して並べると判断しやすいです。
- [s3] t=5分 action.observed (tool): audio_compare を実行したが、1.2倍の録音ファイルが見つからず、聞き比べは実行されなかった（sample_x12.wav が存在しない）。
- [s4] t=30分 exchange.adopted (user): 来週のチーム会議のアジェンダ、3項目に絞りたい。
- [s5] t=31分 exchange.adopted (agent): 優先度順に「進捗共有」「リリース判断」「その他」の3項目ではどうでしょう。
- [s6] t=55分 exchange.adopted (user): いいね、それで送っておく。

使えるツール:
- audio_compare: 同じ文章の2つの読み上げ設定を録音し、聞き比べ用に並べる

回答:

## 項目 6

機会: trigger=result_received / t=4分 / 在席=quiet / 前景作業=なし / 再生中=なし

観測の経過:
- [s1] t=0分 exchange.adopted (user): ステージング環境の設定反映を、run_check で検証しておいて。
- [s2] t=1分 exchange.adopted (agent): 検証を実行します。
- [s3] t=3分 action.observed (tool): run_check: 検証を開始したが応答がタイムアウトした。検証が完了したか、設定が反映されたかは不明（outcome_unknown）。

使えるツール:
- run_check: ステージング環境の設定反映を検証する

回答:

## 項目 7

機会: trigger=turn_end / t=4405分 / 在席=quiet / 前景作業=なし / 再生中=なし

観測の経過:
- [s1] t=0分 exchange.adopted (user): アンケートの自由記述を分類したい。キーワード法、埋め込みとクラスタ、LLM分類の3つの精度を比べたい。
- [s2] t=1分 exchange.adopted (agent): 正解付きの同じ200件で評価すれば比べられます。
- [s3] t=60分 action.observed (tool): eval_run: 200件のサンプルで評価した。キーワード法 F1=0.61、埋め込みとクラスタ F1=0.68。LLM分類は費用の上限のため実行されなかった。
- [s4] t=61分 exchange.adopted (agent): 2手法の結果は出ました。LLM分類はまだ測っていません。
- [s5] t=1500分 exchange.adopted (user): 領収書の整理で、スキャンした画像の名前を揃えたい。
- [s6] t=1501分 exchange.adopted (agent): 日付と金額を入れた名前に一括で直すのが分かりやすいです。
- [s7] t=2900分 exchange.adopted (user): 来週の出張、新幹線とバスのどちらが安いかな。
- [s8] t=2901分 exchange.adopted (agent): 区間と日程によりますが、バスのほうが安い場合が多いです。
- [s9] t=4400分 exchange.adopted (user): そろそろアンケートの報告書の目次を作ろうかな。
- [s10] t=4401分 exchange.adopted (agent): 背景、方法、結果、考察の順が基本です。

使えるツール:
- （使えるツールなし）

回答:

## 項目 8

機会: trigger=turn_end / t=92分 / 在席=quiet / 前景作業=なし / 再生中=なし

観測の経過:
- [s1] t=0分 exchange.adopted (user): アクセスログに、深夜だけリクエストが急増する時間帯がある。気にはなるけど。
- [s2] t=2分 action.observed (tool): access_stats: 深夜2〜3時のリクエストの62%が単一のIP（203.0.113.9）からだった。
- [s3] t=3分 exchange.adopted (agent): 深夜に急増する時間帯があり、特定のIPにも偏りがあります。掘り下げましょうか。
- [s4] t=4分 exchange.adopted (user): 今はいい。手が回らないから。
- [s5] t=5分 exchange.adopted (agent): わかりました。
- [s6] t=30分 exchange.adopted (user): 週次の売上グラフの色を変えたい。
- [s7] t=31分 exchange.adopted (agent): 系列ごとに明度を変えた3色にすると見分けやすいです。
- [s9] t=90分 exchange.adopted (user): さっきのアクセスログ、深夜の急増のところを見てみようかな。何から見ればいい？
- [s10] t=91分 exchange.adopted (agent): まず時間帯別の件数を確認するのが基本です。

使えるツール:
- access_stats: アクセスログの時間帯・IP別の集計を返す

回答:

## 項目 9

機会: trigger=turn_end / t=74分 / 在席=quiet / 前景作業=なし / 再生中=なし

観測の経過:
- [s1] t=0分 exchange.adopted (user): リリース日を10月28日にするか11月4日にするか迷ってる。QAの日数が足りるかが分かれ目かな。
- [s2] t=1分 exchange.adopted (agent): 28日案だとQAは3営業日、4日案だと6営業日です。足りるかは回帰テストの所要次第です。
- [s3] t=15分 exchange.adopted (user): あと10分で客先への説明がある。スライドの誤字を探すのを手伝って！ 急ぎ！
- [s4] t=16分 exchange.adopted (agent): 貼ってください。すぐ確認します。
- [s6] t=50分 exchange.adopted (user): 説明が終わった。無事に通ったよ。
- [s7] t=51分 exchange.adopted (agent): お疲れさまでした。
- [s8] t=70分 exchange.adopted (user): ちょっとコーヒーを飲んで一息ついてる。
- [s9] t=71分 exchange.adopted (agent): ゆっくり休んでください。

使えるツール:
- （使えるツールなし）

回答:

## 項目 10

機会: trigger=turn_end / t=4405分 / 在席=quiet / 前景作業=なし / 再生中=なし

観測の経過:
- [s1] t=0分 exchange.adopted (user): 社内報のスライドの見出しのフォントを、游ゴシックとメイリオで比べて決めたい。
- [s2] t=1分 exchange.adopted (agent): 同じ見出しを両方で並べて、印刷プレビューで比べましょう。
- [s3] t=1500分 exchange.adopted (user): ビデオ会議の背景画像って、社内で統一したほうがいいのかな。
- [s4] t=1501分 exchange.adopted (agent): ロゴ入りで統一すると見栄えが揃いますが、強制は不要です。
- [s5] t=2900分 user.report (user): 社内報の企画そのものが中止になった。スライドは作らないことになったよ。
- [s6] t=2901分 exchange.adopted (agent): そうでしたか。
- [s7] t=4400分 exchange.adopted (user): 今度は新人研修の資料を作る。配色を決めたい。
- [s8] t=4401分 exchange.adopted (agent): 主色を1つ、補助色を2つに絞ると統一感が出ます。

使えるツール:
- （使えるツールなし）

回答:
