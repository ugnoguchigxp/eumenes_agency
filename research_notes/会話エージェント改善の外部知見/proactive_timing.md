# 能動発話のタイミングと是非（Proactive speech: when and whether to speak）

対象: 日本語音声アシスタントのバックグラウンド "agency" が、ターン終了時と無音時（約20秒の間、以降40秒・80秒へバックオフ）に「短い一言」「バックグラウンド作業の完了報告」「待つ」のどれにするかを決める設計。
証拠の種別ラベル: [User study N=..], [Field study], [Benchmark], [Survey], [Secondary/unverified], [Opinion]。

## Q1. 能動的・混合主導の対話: 何がタイミングを決め、何が割り込みコストを下げるか

### Takeaway
最近の研究で一番効いているのは「頻度と間合い」です。提案の中身が同じでも、頻度を上げただけで好まれ方が大きく下がります（90% から 47%）。発話するかどうかは「次に誰が話すか」を予測するより、言いたいことごとの動機スコア（関連性・情報ギャップ・緊急度など）と、沈黙時間に応じて上がる係数をしきい値で判定するほうが、自然さの評価が高く出ています。

### Cited Findings
- **Inner Thoughts（Liu, Fang, Shi, Wu, Igarashi, Chen; arXiv 2501.00383, 2025）**: AI が表に出ない「内なる思考」を常に生成し、思考ごとの内発的動機で話すかどうかを決める。次話者予測は使わない — [arXiv](https://arxiv.org/html/2501.00383v2)
  - 思考サイクルのトリガーは新しい発話（on_new_message）と **10秒の無音**（on_pause）— [arXiv](https://arxiv.org/html/2501.00383v2)
  - 動機スコア: LLM が各思考を1–5で評価する。基準は relevance, information gap, expected impact, urgency, coherence, originality, balance, dynamics。先に「話すべき理由／話さない理由」を上位2つずつ挙げさせ、上位5トークンの確率で加重和を取る。これに **沈黙係数 1.02^(t−τ)** を掛けるので、相手が黙っている時間が長いほど話しやすくなる — [arXiv](https://arxiv.org/html/2501.00383v2)
  - 参加ルール: ターンが空いていれば最上位の思考が imThreshold 以上のときに発話し、届かなければ確率 system1Prob で軽い System1 思考を出す。他者にターンが割り当てられているときは interruptThreshold 以上でしか割り込まない — [arXiv](https://arxiv.org/html/2501.00383v2)
  - [User study N=24, formative] 3人組の Slack 会話を分析。人が発話する動機の言及数は relevance 77, information gap 33, balance 33, coherence 30, dynamics 30, expected impact 23, originality 16, urgency 14 — [arXiv](https://arxiv.org/html/2501.00383v2)
  - [Simulation + 人間評価 10名] 次話者予測ベースライン（fine-tuned GPT-3.5）と比べ、turn appropriateness で有意に優位（Mann-Whitney U=577, p=2.4e-6）。会話単位で82%が Inner Thoughts 側を選んだ — [arXiv](https://arxiv.org/html/2501.00383v2)
  - [User study N=12, 6ペア] 参加スタイルの好みは Active Contributor 6票、Non-stop Chatter 4票、Selective Participant 2票。Selective Participant は7名が最下位とした。少なすぎる発話も不評だった — [arXiv](https://arxiv.org/html/2501.00383v2)
- **Need Help? Designing Proactive AI Assistants for Programming（Chen, Zhu, Zhao, Mozannar, Sontag, Talwalkar; CHI 2025）** [User study N=65, ランダム化] — [arXiv](https://arxiv.org/html/2410.04596v2), [MSR](https://www.microsoft.com/en-us/research/publication/need-help-designing-proactive-ai-assistants-for-programming/)
  - タイミング規則: ユーザーがコードを書いている間やチャット中は提案を出さない。アイドル5秒後に出し、間隔は **最低20秒**。エラー発生時のデバッグ提案だけは即時に出す — [arXiv](https://arxiv.org/html/2410.04596v2)
  - Persistent 条件（5秒間隔、提案3件→5件）: 生産性は+11.6%と依然向上したが、能動支援を好んだ人は **47%** に下がった（Suggest 条件は90%、p=0.005）。"distracting" "annoying" という声が出た — [arXiv](https://arxiv.org/html/2410.04596v2)
  - 受容と拒否は75件中69件が受容。brainstorming と潜在バグの指摘はよく受け入れられ、効率化・モジュール化の提案は拒否が多かった（拒否6件中5件）— [arXiv](https://arxiv.org/html/2410.04596v2)
  - 参加者からの要望: 頻度を調整したい、オンとオフを切り替えたい、問題がなければ「問題なし」と短く言ってほしい — [arXiv](https://arxiv.org/html/2410.04596v2)
- **Codellaborator / "Assistance or Disruption?"（Pu ほか, arXiv 2502.18658, 2025）**: 割り込み管理研究に基づくタイミング機能を持つプログラミング支援。文脈に応じたタイミングが設計上の要点だと結論している — [arXiv](https://arxiv.org/pdf/2502.18658)（検索スニペットのみ。本文の数値は未確認）
- **Proactive Agent / ProactiveBench（Lu ほか, ICLR 2025）** [Benchmark]: 実際の活動ログ（キーボード・マウス・クリップボード・ブラウザ）から 6,790 イベントを作成。人手の受容／拒否ラベルで報酬モデルを学習し、fine-tuned モデルの「能動的に助けを出すべきか」の F1 は 66.47% — [arXiv](https://arxiv.org/abs/2410.12361v3), [ICLR](https://proceedings.iclr.cc/paper_files/paper/2025/hash/75c37811e830bf029584b1c6fac17726-Abstract-Conference.html)。誤報（不要な支援提案）とタイミングが未解決という指摘は非公式メモ由来 [Secondary] — [scrapbox](https://scrapbox.io/nishio-en/Proactive_Agent:_Shifting_LLM_Agents_from_Reactive_Responses_to_Active_Assistance)
- **サーベイ** [Survey]: Deng, Liao, Lei, Yang, Lam, Chua "Proactive Conversational AI: A Comprehensive Survey"（ACM TOIS 43(3), 2025）— [SMU](https://ink.library.smu.edu.sg/sis_research/10225)。前身は IJCAI 2023 "A Survey on Proactive Dialogue Systems" — [arXiv](https://arxiv.org/abs/2305.02750v2)。いずれも主眼は目標誘導・明確化質問・非協力的対話で、発話タイミングの扱いは薄い（要旨からの判断で本文未読）。
- **Human-first pacing（"Would the User Act If We Waited?", NeurIPS 2026 掲載ページ）**: 能動的な AI は少し待ってユーザーが先に動く余地を残すべきだと主張。タイミングが良く邪魔にならない介入でも、ユーザーが自分でしたはずの行動を先取りしてしまうことがある — [NeurIPS](https://neurips.cc/virtual/2026/162434)（ページ要旨のみ）
- [Secondary/unverified] Com-Peer（感情的ピアサポート）では、介入の受容の分散の40%をタイミングが説明し、同じ提案でも適切な瞬間には受容率がずっと高かったと引用されている — 検索要約経由（[arXiv 2602.00880](https://arxiv.org/pdf/2602.00880) 周辺）。原典は未確認。

### Inferences
- 現行の「20秒の間で判定し、40秒・80秒へバックオフ」は、Chen らの「アイドル後、最低20秒間隔」とほぼ同じ発想です。違いはエラー即時提示にあたる区別がないことで、「完了報告（ユーザーが待っている情報）」は緊急度が高いので次のターン境界で即時に出し、「雑談的な一言」は高いしきい値と長い間隔にする、と種別ごとに分けるのが筋だと考えます。
- Inner Thoughts の 1.02^(t−τ) は沈黙が延びるほど話しやすくする方向です。バックオフ（沈黙が続くほど話しにくくする）とは逆向きなので、どちらの仮定（相手は話題を待っている／相手は放っておいてほしい）を採るかを明示する必要があります。Inner Thoughts は多人数のテキストチャットなので、音声1対1の家庭環境にはバックオフ側が合う可能性が高いです（推論）。
- 「話すべき理由／話さない理由」を先に列挙させてから採点する手法は、LLM の判定にそのまま移植できます。

### Gaps
- 音声1対1の日本語アシスタントで、無音何秒後の発話が最適かを直接測った研究は見つかりませんでした。
- Codellaborator 本文の定量結果と Deng らのサーベイ本文は未読です。

## Q2. 割り込みコストと注意: HCI の証拠と能動的音声アシスタントへの受け止め

### Takeaway
割り込みはタスクの区切り（breakpoint）で行うと、苛立ちと反応時間が下がります。能動的スマートスピーカーで「話しかけてよいか」を決める主な要因は、忙しさ・気分・ながら作業・他者の在室です。緊急・重要な用件なら歓迎されますが、社会的な場面への割り込みと主導権の喪失は嫌われます。

### Cited Findings
- **Cha ほか "Hello there! Is now a good time to talk?"（KAIST, IMWUT 2020）** [Field study N=40, 1週間, 回答3,572件]: 寮でスマートスピーカーが「今話しても良い？」と尋ね、はい／いいえを収集した。好機を決める主因は個人要因（忙しさ・気分・ながら作業の衝突）と生活要因（移動・他者の在室）で、文脈に応じた能動会話管理を提案している — [PDF](https://ic.kaist.ac.kr/files/papers/cha2020hello.pdf)
- **Wei, Dingler, Kostakos "Understanding User Perceptions of Proactive Smart Speakers"（IMWUT 2021）** [Field study N=13, 3週間]: Google Home を改造して能動的に話しかけさせた。応答するかどうかを ML で予測した精度は71.6%。退屈や気分などの自己報告が、話しかけられてよいかの知覚と有意に相関した — [Unimelb](https://findanexpert.unimelb.edu.au/scholarlywork/1625368-understanding-user-perceptions-of-proactive-smart-speakers), [Crossref](https://api.crossref.org/works/10.1145%2F3494965)
- **Zargham ほか "The Proactivity Dilemma"（CUI 2022）** [Interview study N=15, ストーリーボード]: 緊急・重要な用件では能動的な支援に利点を感じる一方、多人数の場での社会的活動への干渉、主導権の喪失、侵襲性を懸念した — [UCL](https://discovery-pp.ucl.ac.uk/id/eprint/10152524), [dblp](https://dblp.dagstuhl.de/db/conf/cui/cui2022.html)
- **Reicherts ほか "May I Interrupt? Diverging Opinions on Proactive Smart Speakers"（CUI 2021）** [Online survey]: 能動的スマートスピーカーのシナリオは意外に好意的に評価されたが、プライバシー・主導権・社会的活動への干渉の懸念があり、意見は分かれた — [CORE](https://core.ac.uk/works/149526959)
- **Iqbal & Bailey（CHI 2008）** [Lab study]: 通知を breakpoint まで遅らせると、即時配信より苛立ちと反応時間が下がった。breakpoint の検出は可能だが、粒度（大きい区切りか小さい区切りか）の判別は難しい — [PDF](https://www.interruptions.net/literature/Iqbal-CHI08.pdf)。割り込みコストは breakpoint の粒度で変わり、大きい区切りほど低い — [Illinois](https://ideals.illinois.edu/items/83111)。サブタスク境界では心的負荷（瞳孔径で測定）が下がる — [TOCHI08](https://interruptions.net/literature/Bailey-TOCHI08.pdf)
- **Mehrotra ほか "My Phone and Me"（CHI 2016）** [Field study N=20, 通知10,372件, ESM回答474件]: 反応時間と知覚される妨害度は、提示方法・アラート種別・送り手との関係・作業の種類／完了度／複雑さで変わる。中身が重要でも妨害になりうる。性格特性の影響も大きい — [UCL](https://discovery.ucl.ac.uk/id/eprint/1502364/), [survey arXiv 1711.10171](https://arxiv.org/pdf/1711.10171)
- **Edwards ほか "Eliciting Spoken Interruptions to Inform Proactive Speech Agent Design"（arXiv 2106.02077）**: 人は用件が緊急なほど早く割り込む。後続研究では、緊急度とタスク難度に適応する音声エージェントと静的なエージェントを比較している — [arXiv](https://arxiv.org/pdf/2106.02077), [Oulu](https://oulurepo.oulu.fi/handle/10024/53981)（スニペットのみ）
- [Opinion] 声のエージェントは「ちょっといい？」のような access ritual（話しかける前置き）で丁寧に始めるべきだという提案 — [ADAPT](https://www.adaptcentre.ie/news-and-events/be-proactive-the-future-of-voice-assistants/)

### Inferences
- ターン終了時は、会話の中では最も自然な breakpoint です。完了報告はここに載せると割り込みコストが最小になります。一方、無音20秒の時点でユーザーが別の作業を始めている可能性があり、それはタスク中の割り込みになりえます。
- 「他者の在室」は Cha と Zargham の両方で強い負の要因です。マイクで複数話者や対人会話を検知したら能動発話を止める、というのは低コストで効く規則候補です。
- 雑談的な一言には重要性の裏付けがなく、Mehrotra の「重要でも妨害になる」を踏まえると、最もしきい値を高くすべき種別です。

### Gaps
- 日本の家庭でスマートスピーカーの能動発話を扱ったフィールド研究は見つかりませんでした。
- Wei ほかで予測に効いた特徴量の詳細は本文未読です。

## Q3. 会話の沈黙と間の規範（日本語と英語、相づち）

### Takeaway
ターン交替の間（ギャップ）はどの言語でも短く、最頻値は200ms未満です。日本語は英語と同じく最も速い部類（中央値約0ms）です。「日本人は沈黙に寛容（8.2秒対4.6秒）」という通説は出典が弱く、反証もあります。日本語の相づちは英語の2〜3倍と多く、聞き手が話の進行を支える役割が大きいです。

### Cited Findings
- **Stivers ほか（PNAS 2009, 10言語）**: どの言語も重なりを避け、ターン間の沈黙を最小化する。典型的なギャップは200ms未満で、言語差は全体平均から±250msの範囲に収まる — [MPI](https://forms.mpi.nl/node/50939), [EMCA wiki](https://emcawiki.net/Stivers-etal2009)
  - 極性疑問への応答オフセットの中央値は英語・日本語が0ms、デンマーク語などが+300ms、全体の中央値は+100ms [Secondary] — [Language Log](https://languagelog.ldc.upenn.edu/nll/?p=7997)。「日本語の平均7ms」は二次情報で、原典の表では未確認 — [National Geographic](https://www.nationalgeographic.com/science/article/pregnant-pauses-and-rapid-fire-how-do-different-cultures-take-turns-to-talk)
- **沈黙への耐性**: オランダ語・英語の会話では、沈黙が約4秒続くと人は落ち着かなくなるという Groningen の研究 [Secondary] — [glossophilia](https://glossophilia.org/2017/07/pregnant-pauses-in-different-languages/)。日本のビジネス会議では8.2秒、米国では4.6秒という数値は広く流布しているが、原典を確認できなかった [Secondary/unverified] — 同上
  - 反証: 日英の大学生（日本20名、英国15名）の1対1チュートリアルでは、耐えられる沈黙の長さに有意差がなかった [User study N=35] — [Springer](https://link.springer.com/article/10.1007/s12564-017-9503-8)
- **相づち**: Maynard 系の研究では、日本語の相づちは米語の約2倍とも約3倍ともされ、出典間で倍率が一致しない — [Cambridge (White)](https://core-cms.cambridgecore.org/core/journals/language-in-society/article/backchannels-across-cultures-a-study-of-americans-and-japanese1/B26AC3C44C237B9A380A5494EA5693ED), [kougei repo](https://kougei.repo.nii.ac.jp/records/781)。Clancy ほか（1996）では日本語が最多で英語が僅差で続き、日本語は発話の途中に相づちを入れることが多い — [kougei repo](https://kougei.repo.nii.ac.jp/records/781)。日本語は聞き手の反応が会話運営で果たす役割が大きい（Otsuka）— 同上

### Inferences
- 応答側のターン交替は数百ms単位の現象で、20秒の無音とは別の層です。20秒は「会話が途切れて各自の活動に戻った」状態とみなすのが妥当で、そこでの発話は会話の続きではなく新しい会話の開始です。前置き（「そういえば」「ちなみに」）や access ritual が要るのはこのためです。
- 日本語では相づちによる聞き手シグナルが多いので、ユーザーの「うん」「へえ」程度の短い反応を拒否と取るのは早計です。逆に、相づちがない（反応ゼロ）ことのほうが強い負のシグナルになりうると考えます。
- 4秒前後で居心地の悪さが出るという知見から、10秒前後の沈黙での発話（Inner Thoughts の on_pause）はチャットでは自然でも、音声で同席しているときは「会話の続き」として受け取られやすいはずです。20秒以上で話しかけるなら、新しい話題として切り出すべきです。

### Gaps
- 日本語の自由会話における「長い間（数秒〜数十秒）」の分布や、話題再開までの時間の統計は見つかりませんでした。
- 日本語音声対話システムの相づち生成研究（例: 京大 ERICA）は今回調べていません。

## Q4. ユーザーの反応（無視・短い返答）から頻度を学習する方法と、その効果

### Takeaway
反応の予測精度は場面ごとに約70%と中程度です。少数のフィードバックで個人に合わせるには、母集団の事前分布に個人の受容・無視を足していく方式が有望です（LLM ペルソナの事前学習とオンデバイス適応で N=34 の満足度が上がった）。通知分野では「送る／黙る」を行動とする強化学習やバンディットが実用化されていますが、効果の大きさは控えめです。

### Cited Findings
- **"After Talking with 1,000 Personas"（arXiv 2602.04000, 2026）**: LLM ペルソナ1,000体との模擬対話で、タイミング・自律性・伝え方の嗜好の共通パターンを事前に学ぶ。その後、簡単なフィードバックを使い activation steering でオンデバイスに個人適応する。RLHF と同程度の性能。[User study N=34] 複数セッションで満足度・信頼・快適さが上がった。タイミングが悪かったり押し付けがましかったりすると、信頼が下がり能動機能が無効化されるという動機づけも述べている — [arXiv](https://arxiv.org/abs/2602.04000)（要旨のみ）
- **"Sensing What Surveys Miss"（arXiv 2602.00880）** [User study N=32, within]: 皮膚電気活動とマウスの動きを入力に、個人ごとの分類器としきい値のルール適応で LLM 介入のタイミングを決める。タイミングが合った条件では正答率が21%上がり、偽陰性率が50.9%から22.9%に下がった — [arXiv](https://arxiv.org/abs/2602.00880)
- **Wei ほか**: 能動スピーカーへの応答可否を予測した精度は71.6% — [Unimelb](https://findanexpert.unimelb.edu.au/scholarlywork/1625368-understanding-user-perceptions-of-proactive-smart-speakers)。KAIST の車載音声の好機予測は精度0.74 — [KAIST](https://dspace.kaist.ac.kr/handle/10203/274971)
- **Nurture（NSF 公開論文）**: 通知を「送る／黙る」の行動とし、通知へのユーザーの反応を報酬とする強化学習として定式化 — [NSF PAR](https://par.nsf.gov/servlets/purl/10111008)
- **Duolingo（Yancey & Settles, KDD 2020）** [Production A/B]: sleeping, recovering bandit（同じ選択肢を使うと新鮮さが落ち、時間とともに回復する）でリマインダーを最適化し、DAU が0.5%、新規ユーザー定着が2%上がった — [PDF](https://research.Duolingo.com/papers/yancey.kdd20.pdf)
- **オフライン強化学習による通知最適化（LinkedIn, arXiv 2202.03867）**: 時間の制約がない通知は配信時刻の最適化で効果を伸ばせる — [arXiv](https://arxiv.org/pdf/2202.03867)。遅れて届く報酬はオフライン評価を誤らせるという注意 — [arXiv 2608.11560](https://arxiv.org/pdf/2608.11560)
- **PrefMiner（Mehrotra ほか）**: 通知の受容と拒否から、ユーザーが理解できる規則（どの種類をいつ止めるか）をマイニングする — [PDF](https://research.birmingham.ac.uk/files/29201286/PrefMiner_Mining_User_s_Preferences_for_Intelligent_Mobile_Notification_Managemen.pdf)。位置と通知タイトルから受容を精度91%で予測したという報告がある [Survey 引用] — [arXiv 1711.10171](https://arxiv.org/pdf/1711.10171)
- **Need Help?** の設計指針に「受容／拒否フィードバックから学ぶ」「ユーザーが頻度を調整できる」が含まれる — [arXiv](https://arxiv.org/html/2410.04596v2)

### Inferences
- 実装案: 発話種別（一言・完了報告）× 文脈（時間帯・直前の会話量・在室者推定）ごとに Beta 事前分布を持たせ、反応を報酬にして Thompson sampling で「話す／待つ」を選びます。報酬の割り当ては、無視なら0、短い相づちなら弱い正、話題に乗ってくれば強い正、「うるさい」「今いい」なら強い負とします。Duolingo の recovering の考え方を入れ、同じ種別を続けて出したら一時的に価値を下げます。
- 予測精度が約70%しかないので、モデルの確信が低いときは待つ側に倒し、報告はターン終了時に回すほうが安全です。「話して外す」コストは「待ちすぎる」コストより大きいという非対称性は、Persistent 条件で好まれ方が90%から47%に下がった結果に表れています。
- 頻度の明示的な調整（「最近話しかけすぎ？」に答えて変える、あるいは音声コマンド）は、複数の研究で参加者が求めていました。

### Gaps
- 音声アシスタントの能動発話そのものにバンディットや強化学習を適用し、ユーザー評価まで報告した研究は見つかりませんでした。
- 1,000ペルソナ論文の反応から報酬への具体的な割り当ては、本文未読のため不明です。
- 日本語ユーザーの短い返答（「うん」「そう」）が肯定なのか、話を打ち切りたいシグナルなのかを判別した研究は見つかりませんでした。
