# 長期コンパニオン/アシスタントエージェントの記憶・関心・ペルソナ・話題鮮度（OSS と論文 2023–2026）

調査日: 2026-10-24。表記ルール: 【論文/本文で確認】= 論文 HTML 本文または公式ドキュメントで確認、【abstract のみ】= arXiv abstract ページのみで確認、【README】= GitHub README の主張（ソース未確認）。ソースコードは読んでいない（clone なし）。

## Q1. 記憶システム（Generative Agents / MemoryBank / mem0 / Zep・Graphiti / Letta / LangMem / A-MEM）は何を保存し、どう想起を決め、どう評価されているか

### Takeaway
各方式の構成要素はほぼ同じ。(a) 自然文の小さな記憶単位、(b) 想起スコア＝関連度＋新しさ＋重要度（＋想起回数による強化）、(c) 書き込み時に統合する（ADD/UPDATE/DELETE/NOOP や、矛盾したら無効化）、(d) 会話のホットパス外での反省・統合（reflection / sleep-time / background）。ベンチマーク（LoCoMo, LongMemEval）は「事実 QA の正答率」を測るもので、「雑談が新鮮か」は測っていない。

### Cited Findings
**Generative Agents（Park et al. 2023）【論文本文で確認】**
- memory stream は記憶オブジェクトのリスト。各オブジェクトは自然文の記述、作成時刻、最終アクセス時刻を持つ。観察・反省（reflection）・計画を同じ stream に入れ、まとめて検索する — [arXiv 2304.03442](https://arxiv.org/html/2304.03442)
- 想起スコア = α_recency·recency + α_importance·importance + α_relevance·relevance で、α はすべて 1。各項は [0,1] に min-max 正規化する。recency は「最後に検索された時点」からのゲーム内時間で指数減衰し、係数は 0.995/時間。importance は生成時に LLM が 1–10 で採点する（部屋の掃除=2、好きな人を誘う=8）。relevance はクエリとの埋め込みコサイン類似度 — [arXiv 2304.03442](https://arxiv.org/html/2304.03442)
- reflection は、直近の知覚イベントの importance 合計が 150 を超えたら起動する（実測で 1 日 2–3 回）。手順は、直近 100 件から「答えられる最も顕著な高レベル質問 3 つ」を生成し、それをクエリに検索し、「insight (because of 1, 5, 3)」形式で 5 つの洞察を作る。洞察は根拠記憶へのポインタ付きで stream に保存され、反省の反省という木構造になる — [arXiv 2304.03442](https://arxiv.org/html/2304.03442)
- アブレーション（TrueSkill μ）は、フル構成 29.89 > 反省なし 26.88 > 反省・計画なし 25.64 > 人間クラウドワーカー 22.95 > 記憶・計画・反省なし 21.21。フル構成と記憶なしの差は Cohen's d = 8.16。関係性の応答 453 件中 6 件（1.3%）が幻覚だった — [arXiv 2304.03442](https://arxiv.org/html/2304.03442)

**MemoryBank / SiliconFriend（Zhong et al. 2023）【論文本文で確認】**
- 忘却曲線は R = e^(−t/S)。S（記憶強度）は初出時に 1 で、想起されるたびに +1 される。想起時に t は 0 にリセットされる。著者自身が「探索的で非常に単純化したモデル」と書いている — [arXiv 2305.10250](https://arxiv.org/html/2305.10250)
- 日次でイベント要約を作り、そこから全体要約を作る。同様にユーザーの性格・感情を日次で要約し、そこから「簡潔で一般的な性格要約」（global portrait）を作る — [arXiv 2305.10250](https://arxiv.org/html/2305.10250)
- コードは https://github.com/zhongwanjun/MemoryBank-SiliconFriend 。ライセンスは論文ページに記載がなく、未確認 — [arXiv 2305.10250](https://arxiv.org/html/2305.10250)

**Mem0（Chhikara et al. 2025）【論文本文で確認】**
- 抽出フェーズの入力は、会話要約 S、直近 m 件のメッセージ（m=10）、新しいメッセージペア。更新フェーズでは候補事実ごとに類似記憶 top-s（s=10）を取り、LLM が tool call で ADD（同等なし）/ UPDATE（補完）/ DELETE（矛盾）/ NOOP を選ぶ — [arXiv 2504.19413](https://arxiv.org/html/2504.19413)
- グラフ版 Mem0g は (v_s, r, v_d) のトリプレットを Neo4j に保存する。矛盾した関係は物理削除せず invalid にする（時間推論のため） — [arXiv 2504.19413](https://arxiv.org/html/2504.19413)
- LoCoMo の総合 J は、Full-context 72.90 / Mem0g 68.44 / Mem0 66.88 / Zep 65.99 / LangMem 58.10 / OpenAI 52.90 / A-Mem 48.38。p95 の総レイテンシは Full-context 17.1s、Mem0 1.44s（検索のみ 0.20s）、LangMem 60.4s。平均トークンは Full-context 26k、Mem0 1.8k — [arXiv 2504.19413](https://arxiv.org/html/2504.19413)
- 注意点: これはベンダー自身による比較。Zep は著者側の環境で実行され、取り込み直後の検索は失敗が多かった（非同期グラフ構築のため）。OpenAI ベースラインは全記憶への特権アクセス付き。adversarial カテゴリは除外。「91%」と「92%」のレイテンシ削減の記述も揺れている。精度だけなら Full-context が最良 — [arXiv 2504.19413](https://arxiv.org/html/2504.19413)

**Zep / Graphiti（Rasmussen et al. 2025）【論文本文で確認】**
- 3 層構成。episode 部分グラフ（生メッセージを非可逆変換せず保存）、意味エンティティ部分グラフ（エンティティと事実エッジ）、community 部分グラフ（ラベル伝播でクラスタ化し、要約と名前を付ける） — [arXiv 2501.13956](https://arxiv.org/html/2501.13956)
- bi-temporal モデル。事実が真だった期間 t_valid/t_invalid と、システムへの取り込み時刻 t'_created/t'_expired を分けて持つ。新しいエッジが時間的に重なる既存エッジと矛盾すると、LLM の判定で旧エッジの t_invalid を新エッジの t_valid に設定する — [arXiv 2501.13956](https://arxiv.org/html/2501.13956)
- 検索はコサイン・BM25・n-hop BFS を併用する。リランカーは RRF、MMR、episode 言及頻度、ノード距離、cross-encoder — [arXiv 2501.13956](https://arxiv.org/html/2501.13956)
- LongMemEval_s では gpt-4o で Full-context 60.2%（28.9s, 115k tok）、Zep 71.2%（2.58s, 1.6k tok）。single-session-preference が 20.0% から 56.7% に上がった一方、single-session-assistant は 94.6% から 80.4% に下がった（アシスタント自身の過去発言の想起が弱い） — [arXiv 2501.13956](https://arxiv.org/html/2501.13956)

**Letta（旧 MemGPT）【公式 docs】**
- memory block のフィールドは label / description / value / limit（文字数）/ read_only。「description が、エージェントがそのブロックをどう読み書きするかを決める主な情報」。複数エージェントで共有でき、同時書き込みは last-write-wins — [Letta docs: memory blocks](https://docs.letta.com/guides/agents/memory-blocks)
- 現行 docs では、背景で回るサブエージェントが直近の会話を見直して教訓を統合し、作業を中断せずに記憶を更新する（"Dreaming"、CLI では /sleeptime）。起動条件は一定ステップ数の完了後、またはコンテキスト圧縮時。記憶は git ベースの MemFS に置かれる — [Letta docs: sleeptime](https://docs.letta.com/guides/agents/architectures/sleeptime)

**LangMem（LangChain）【公式 docs】**
- 記憶の種類は semantic（事実）、episodic（成功した対話の状況・推論・なぜうまくいったか）、procedural（振る舞い＝プロンプト規則）の 3 つ。表現形式は collection（個別レコード。既存との調停が必要）と profile（単一文書を上書きする）がある — [LangMem conceptual guide](https://langchain-ai.github.io/langmem/concepts/conceptual_guide/)
- 書き込みのタイミングは 2 通り。hot path（会話中に保存）は「ユーザーが知覚できる遅延を加える」。background（会話終了・非アクティブ時に振り返る）は遅延がなく recall も高い。想起では類似度に加えて重要度と「強度（最近性・使用頻度）」を考慮すべきとしている — [LangMem conceptual guide](https://langchain-ai.github.io/langmem/concepts/conceptual_guide/)

**A-MEM（Xu et al. 2025）【abstract のみ】**
- Zettelkasten 型。新しい記憶を、文脈記述・キーワード・タグ付きのノートにし、類似する既存ノートとリンクする。統合時には既存ノートの文脈記述や属性も更新する（memory evolution） — [arXiv 2502.12110](https://arxiv.org/abs/2502.12110)
- コードは github.com/WujiangXu/A-mem と A-mem-sys。ライセンスは未確認 — [arXiv 2502.12110](https://arxiv.org/abs/2502.12110)
- Mem0 論文の再評価では、A-Mem の LoCoMo J は 48.38 で最下位だった（他社による評価） — [arXiv 2504.19413](https://arxiv.org/html/2504.19413)

**ベンチマーク**
- LoCoMo: ペルソナと時間的イベントグラフに基づく LLM エージェント同士の会話を、人手で検証・修正したもの。平均約 300 ターン・9K トークン、最大 35 セッション。タスクは QA・イベント要約・マルチモーダル対話生成。長文脈 LLM や RAG でも人間に大きく劣る — [arXiv 2402.17753](https://arxiv.org/abs/2402.17753)【abstract のみ】
- LongMemEval（ICLR 2025）: 500 問。能力は情報抽出・複数セッション推論・時間推論・知識更新・棄権（abstention）の 5 つ。商用アシスタントや長文脈 LLM は持続的対話で約 30% 精度が落ちる。改善策は session 分解、事実で拡張したキー、時間を考慮したクエリ拡張 — [arXiv 2410.10813](https://arxiv.org/abs/2410.10813)【abstract のみ】
- REALTALK: 実在の人間同士による 21 日間のメッセージ会話。記憶プローブ質問 728 問 — [arXiv 2502.13270](https://arxiv.org/pdf/2502.13270)【検索スニペット】

### Inferences
- eumenes の「host が長期記憶から話題を渡す」設計は、Generative Agents の 3 項スコアに 1 項足せば強化できる。足すのは「最後に話題として使った時刻」による抑制項（recency の逆向き）。Generative Agents の recency は「最終アクセス」基準なので、そのまま使うと一度話した話題ほど再浮上しやすくなる。話題選択では符号を反転させるべき。
- MemoryBank の S+=1 強化は「覚えておく」ためには正しい。ただし雑談の話題選択にそのまま使うと、同じ話題が繰り返される要因になる。記憶の保持強度と、話題としての新鮮さは別の変数として持つべき。
- 書き込み・統合を hot path から外す（LangMem の background、Letta の Dreaming、Generative Agents の閾値起動 reflection）のは、ユーザーの「返答は即時」原則と整合する。
- Zep の bi-temporal と Mem0 の DELETE/invalid は、メモ（「今は〜している」）が古くなる問題への具体策になる。ノートに valid_from / invalidated_at を持たせれば、古い近況を話題にする事故を防げる。
- Zep の結果を見ると、グラフ記憶は「アシスタント自身が過去に言ったこと」の想起で劣化している。「自分が前に何を言ったか」が重要な反復回避では、自発発話の履歴を別ストアに保つ方が安全。

### Gaps
- MemGPT 原論文（arXiv 2310.08560）の main context / recall / archival の階層と、OS 的な paging の詳細は、このセッションでは未取得。
- ライセンスは未確認（mem0・Graphiti・Letta・LangMem はいずれも寛容ライセンスと記憶しているが、この調査では確認していない）。A-MEM と MemoryBank のライセンスも未確認。
- A-MEM の評価データセットと数値は abstract に記載がない。
- 公式・第三者による、LoCoMo/LongMemEval のスコアの独立再現は見つからなかった（Mem0 と Zep はどちらも自社比較）。

## Q2. 関心の進化・好奇心、オープンドメイン雑談での話題推薦・話題転換

### Takeaway
最も直接に参考になるのは NTT 系の Topic-Initiator（LREC 2026）。ユーザーの関心と既知知識を推定し、外部情報をカテゴリ化し、LLM が関心に合うカテゴリを選び、「ユーザーが未知の情報」を取ってくる。「エージェント自身の関心が経験から育つ」研究は 2026 年に出始めた段階で、実証は弱い。

### Cited Findings
- Topic-Initiator（Matsuo, Otsuka, Nomoto, Nakatsuji, LREC 2026, pp.19–34）: 受け身のチャットボットは会話意欲を下げるという問題意識から、ユーザーの関心に合う新しい話題で自分から会話を始める。PT-RAG は、過去の対話からユーザーの関心と知識を推定し、収集情報をカテゴリに整理し、LLM が関心に合うカテゴリを選び、その中からユーザーの知識にない情報を取得する。自動評価・人手評価の両方で、新しく面白い情報の取得精度と会話意欲が既存法を上回った（効果量は未確認） — [ACL Anthology 2026.lrec-1.2](https://aclanthology.org/2026.lrec-1.2/)【abstract/検索スニペット】
- PIVOT（CyberAgent・東京科学大, 2025）: ユーザーが好む話題で雑談しながら、別の Yes/No 情報を唐突さなく取得するタスク。素の LLM の成功率は GPT-4o 約 12%、Claude 3.5 Sonnet 2%、Gemini 1.5 Pro 0%（人間 12%）。話題と質問の関係 7 種から候補発話を生成し、ファインチューンした唐突さ評価器（F1 88.5）で最も唐突でない候補を選ぶ方式で 40% に上がった（プロンプトのみのベースラインは 16–18%）。データは英語 — [arXiv 2504.07698](https://arxiv.org/html/2504.07698v1)【本文で確認】
- PIVOT の分析では、情報取得後も同じ質問を続けることが唐突さの原因になっていた。そこで「ユーザーの答えが既に予測できるなら取得指示を止め、話題に集中する」仕組みを入れている — [arXiv 2504.07698](https://arxiv.org/html/2504.07698v1)
- Proactive CoT（2023）は、目標計画を推論チェーンに入れるプロンプト。User-oriented Proactive Chatbot（arXiv 2505.12334）は、ユーザー嗜好を学び、ユーザー中心の話題へ誘導する。能動性を LLM-as-judge の critic で評価し、模擬ユーザーとカリキュラム学習する。GauchoChat（Alexa Prize 2023）は、退屈を検知すると話題を切り替える — [arXiv 2305.13626](https://ar5iv.labs.arxiv.org/html/2305.13626); [arXiv 2505.12334](https://www.arxiv.org/pdf/2505.12334); [GauchoChat](https://cdn.amazon.science/80/c9/c241c7c94d09bfca04b4a73a4dc9/gauchochat-towards-proactive-controllable-and-personalized-social-conversation.pdf)【いずれも検索スニペット】
- エージェント側のペルソナ進化: LD-Agent（"Hello Again!", 2024）は、ユーザーとエージェント双方の動的ペルソナをイベント記憶と併せてモデル化する。"Do AI Personas Grow?"（arXiv 2608.06485）は、人生イベント後の性格変化を分析・ベンチマーク化する。Emergi-PersonaOS（arXiv 2609.27417）は、外部記憶や reflection だけでは「持続的なペルソナ内容をいつ改訂すべきか」が決まらないと指摘する — [arXiv 2406.05925](https://arxiv.org/pdf/2406.05925); [arXiv 2608.06485](https://arxiv.org/pdf/2608.06485); [arXiv 2609.27417](https://arxiv.org/pdf/2609.27417)【検索スニペットのみ】
- AutoPal（2024）は、個人コンパニオンがユーザーに自律適応するもの — [arXiv 2406.13960](https://arxiv.org/html/2406.13960v2)【タイトルのみ確認】

### Inferences
- Topic-Initiator の「関心カテゴリ選択 → 未知情報の取得」の 2 段構成は、eumenes の「固定の standing interests ＋ host 提供の話題」に直接対応する。standing interests をカテゴリ、host 話題を候補にして、「ユーザーがまだ聞いていない（既に話した・既知でない）」フィルタを入れるのが自然。
- PIVOT の結果を見ると、素の LLM に「さりげなく話題を出して」と頼んでも唐突になりやすい（成功率 0–12%）。そして「候補を複数生成し、別の評価器で唐突さを判定して選ぶ」方が大きく効く。lull 時の一言でも、「候補生成 → 軽い判定 → 選択」の構造の方が、プロンプト一発より有望。
- 固定関心を経験で育てる仕組み（Emergi/AutoPersonas 系）はまだ実証が弱い。導入するなら、固定関心は read_only の核として残し（Letta の read_only block に相当）、派生関心だけを背景処理で更新する二層構成が安全。

### Gaps
- Topic-Initiator の言語（日本語データか）、具体的な数値、コード公開の有無は未確認（PDF 未取得）。
- BlenderBot 2/3 の長期記憶、Meena の SSA（sensibleness/specificity）、LaMDA の指標の原典は、このセッションでは取得していない（2023 年以前の研究でもある）。
- Character.AI など商用コンパニオンの話題選択に関する公開技術資料は見つからなかった。

## Q3. 長期チャットでの反復・無個性化（blandness）とペルソナドリフト

### Takeaway
ペルソナ・指示の追従は約 8 往復で有意に崩れる。100 往復以上でも劣化が続く。長期の自律運用では、話題の大枠（macro-theme）の反復率が 80% 前後に達しうる。反復は「放置すれば必ず起きる現象」として、明示的に計測・抑制する必要がある。

### Cited Findings
- Li et al. 2024（"Measuring and Controlling Persona Drift"）: 指示を与えた 2 つのチャットボットに self-chat させ、システムプロンプトへの追従の安定性を測った。LLaMA2-chat-70B と GPT-3.5 は約 8 ラウンドで有意にドリフトした。原因の一つは長い対話での attention decay。軽量な緩和策として split-softmax を提案し、2 つのベースラインより良好 — [arXiv 2402.10962](https://arxiv.org/abs/2402.10962)【abstract のみ】
- "Persistent Personas?"（2025）: 100 ラウンド超の対話でペルソナ忠実度が低下し、特に目標指向の会話で顕著だった — [arXiv 2512.12775](https://www.arxiv.org/pdf/2512.12775)【検索スニペット】
- REALTALK（2025）: 異なるペルソナを与えた LLM 同士でも差が小さく、長期的な微妙なペルソナ変化を再現できない。つまり無個性化の証拠 — [arXiv 2502.13270](https://arxiv.org/pdf/2502.13270)【検索スニペット】
- 一貫性指標を報酬にした多ターン RL で、不整合が 55% 以上減った（対象は模擬ユーザー） — [arXiv 2511.00222](https://arxiv.org/abs/2511.00222v1)【検索スニペット】
- AutoPersonas（Mengchen Li, 2026）: 40 日間のストレステストで、8 モデルの macro-theme 反復が 79.0–88.0%。5 日間ローリングの行動カテゴリ反復は 95.2–97.6% で、全モデルが 11 日目までに 90% を超えた。本番の divergence 設定の A/B 試験では macro-theme 反復が 61.8% から 39.4% に下がり、累積テーマ数がほぼ倍になった。ただし緩和策の内部は商業上の理由で非公開。評価スクリプト（action_repetition_eval.py）は ancillary files にある — [arXiv 2607.08252](https://arxiv.org/abs/2607.08252)【abstract で確認】。検索スニペット（[alphaXiv](https://www.alphaxiv.org/abs/2607.08252)）では 36.3% とあり、abstract の 39.4% と食い違う。abstract を優先する。

### Inferences
- 反復の測り方として、AutoPersonas の 2 指標が eval に転用しやすい。(1) 発話を大枠テーマに意味的にクラスタリングした反復率、(2) 直近 N 日のカテゴリ反復率。eumenes の eval で「直近 k 回の自発発話のテーマ重複率」と「累積テーマ数」を追えば、改善が数値で見える。
- 固定ペルソナや standing interests はシステムプロンプトに置くだけでは約 8 往復で効きが落ちる、という知見がある。lull のたびに、ペルソナの核と関心を短く再注入する（毎回、生成直前のコンテキスト末尾近くに置く）ことが attention decay への実務的な対策になる（推論）。
- 「LLM に任せると同じ大テーマに収束する」ことが定量的に示されている。そのため話題選択は LLM の自由生成ではなく、host 側の決定的なスコアリングと最近使用の抑制で行い、LLM は表現だけを担う分業が妥当。

### Gaps
- split-softmax の具体的な数値と仕組みは未取得（HTML 本文を読んでいない）。
- 語彙レベルの反復（同じ言い回し・口癖）を長期コンパニオンで測った研究は見つからなかった。
- 日本語での persona drift の測定研究は見つからなかった。

## Q4. 日本語 OSS（AITuber / VTuber / コンパニオン）の自発発話の実装

### Takeaway
日本語 OSS の自発発話は、「無言タイムアウト → 固定フレーズ／時間帯挨拶／AI 生成フレーズ」という単純な仕組みが中心。長期記憶は RAG か外部サービス（ChatMemory, mem0, Zep）に任せている。話題の鮮度管理や反復抑制を README レベルで明示している例は見つからなかった。

### Cited Findings
- AITuberKit（tegnike）: v2.0.0 から独自ライセンスで、非商用・個人・教育・非営利は無料、商用は別途商用ライセンスが必要。同梱の Live2D モデルは AI への入力・学習・変換が禁止 — [GitHub tegnike/aituber-kit](https://github.com/tegnike/aituber-kit)【README】
- AITuberKit のアイドルモードは「会話が途絶えた際にキャラクターが自動発話」で、フレーズ源は固定フレーズ／時間帯挨拶／AI 生成の 3 種。会話継続モードは「コメントがなくても自発的に発言可能」。長期記憶は「RAG ベースの長期記憶で、過去の会話をコンテキストに活用」。人感検知による挨拶・見送りもある。3 種の選び方（順序・確率・間隔）は README に記載がない — [GitHub tegnike/aituber-kit](https://github.com/tegnike/aituber-kit)【README】、詳細は [docs.aituberkit.com](https://docs.aituberkit.com/)（未取得）
- ChatdollKit（uezo）: Apache-2.0。ウェイクワードまたは発話長で会話を開始する。Conversation Timeout で Idle、Idle Timeout で Sleep に遷移する（デフォルトでは両者に差はない）。指定間隔で現在日時をリクエストに挿入する機能がある（時間帯挨拶向け）が、応答はリクエストが来たときだけ。外部プログラムから Socket/JS 経由で発話をトリガーできる。AITuber 同士の会話にも対応する — [GitHub uezo/ChatdollKit](https://github.com/uezo/ChatdollKit)【README】
- ChatdollKit は「長期記憶の管理機構を持たない」と明記している。ChatMemory（episodic memory）連携で、OnStreamingEnd で履歴を AddHistory し、ChatMemoryTool で LLM が想起する。Knowledge は自動抽出されない。mem0/Zep とも連携できる — [GitHub uezo/ChatdollKit](https://github.com/uezo/ChatdollKit)【README】

### Inferences
- 日本の OSS は「いつ話すか」（タイムアウト・人感・外部トリガー）は充実しているが、「何を話すか（話題選択・重複回避）」は空白に近い。eumenes の host 側話題選択と反復抑制は差別化になる。
- AITuberKit の 3 種フレーズ源（固定／時間帯／生成）は、eumenes の fallback 階層の参考になる。生成に失敗したり候補がなかったりしたら、時間帯の一言や沈黙を選ぶ。
- ChatdollKit の「日時を定期挿入する」方式は軽量で、時間帯や季節に合った一言の根拠になる。

### Gaps
- AITuberKit のアイドルモード・会話継続モードの実際のソース（間隔、フレーズ選択、重複回避の有無）は未確認（clone していない）。
- 他の日本語プロジェクト（例: 日本語 LLM のコンパニオン、ローカル AI VTuber の各種スタック）は、時間の都合で調査していない。
- 日本語固有の評価（あいづち・間の自然さ）と、自発発話の関係を扱う論文は見つからなかった。
