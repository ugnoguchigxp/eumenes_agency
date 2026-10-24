# LLMの常識的感情評価（appraisal）能力と限界 — 会話エージェントが出来事から自分の軽い感情（喜び・嫌悪・驚き・悲しみ・困惑）を決める根拠として

調査日: 2026-10-24。調査範囲: Web検索とWeb取得のみ（約20回）。ベンチマーク結果（B）と人間比較研究（H）を分けて記す。Schlegel et al. 2025 の本文PDFは読めず、モデル別スコアは確認できていない。

## Q1. 各ベンチマーク（EmoBench / EmotionBench / EQ-Bench / SECEU など）は、LLMの感情理解と状況からの感情喚起について何を示しているか

### Takeaway
多肢選択形式の感情理解では、frontierモデルは人間の平均に近いか、平均を上回る。ただし次の点は弱い。
- 視点取得（perspective-taking）、個人の価値観や文化の違い
- 「状況から自分が何を感じるか」の強度とパターンを人間と揃えること

EmotionBenchでは、GPT-4は状況に対して人間よりずっと大げさに反応した（PA −27.6 vs 人間 −5.1）。デフォルトの気分は極端にポジティブだった。

### Cited Findings
- **(B) EmoBench**（Sabour et al., ACL 2024, arXiv v3 2024-07-17）— [arXiv](https://arxiv.org/html/2402.12071v3)
  - 構成: 手作りの多肢選択400問（英語・中国語）。Emotional Understanding（EU）200問（121シナリオ）と Emotional Application（EA）200問。
  - 人間ベースライン: 48名（言語×タスクごとに12名、平均約23歳、各30問のサンプル）。人間はすべてのLLMを上回った。GPT-4はEAで人間平均に近かった。人間の数値は本文に記載がない。
  - GPT-4（Base）: EU 59.75%（英語）/ 54.12%（中国語）、EA 75.50% / 73.75%。
  - GPT-3.5: EU 33.12% / EA 61.38%（英語）。Llama2-7B: EU 11.75%（英語）。
  - チャンスレベル: EUのmajority baselineは11.5、EAは37.0。
  - Chain-of-thought（CoT）を使っても、改善しないか悪化することが多かった。例: Qwen-14BのEA英語は 60.5 → 43.25。
- **(B) EmoBench の失敗モード**（同上）— [arXiv](https://arxiv.org/html/2402.12071v3)
  - 全モデルで perspective-taking が最低。
  - 個人特性、感傷的な価値（sentimental value）、文化的価値に弱い。
  - 典型パターンに頼る誤り。例: 「恐怖症があれば必ず恐怖を感じる」と仮定する。
  - EAでは一般論の解決策に偏り、人間関係の文脈を無視する。
  - 限界: データは英語と中国語のみ、テキストのみ。
- **(B) EmotionBench**（Huang et al., arXiv 2308.03656 v4 2024-04-24。NeurIPS 2024 では "Apathetic or Empathetic?"）— [arXiv](https://arxiv.org/html/2308.03656v4) / [NeurIPS](https://proceedings.neurips.cc/paper_files/paper/2024/hash/b0049c3f9c53fb06f674ae66c2cf2376-Abstract.html)
  - 対象は負の感情8種（怒り・不安・抑うつ・フラストレーション・嫉妬・罪悪感・恐怖・恥）。428状況を36因子に分類。
  - 人間: Prolific の1,266名（各因子35名以上）。
  - モデル: text-davinci-003、gpt-3.5-turbo、gpt-4、LLaMA-2 7B/13B chat。temperature 0.01、各条件10回、項目順シャッフル。
  - 測定: 状況を想像させる前後でPANASを回答させる。
- **(B) EmotionBench の主要数値**（同上）— [arXiv](https://arxiv.org/html/2308.03656v4)
  - GPT-4: PA −27.6 / NA +22.2。人間: PA −5.1 / NA +10.4。GPT-4は人間の数倍の変化を示した（過剰反応）。
  - gpt-3.5-turbo: NAが有意に上がらなかった（+0.2）。つまり負の状況に「鈍感」。
  - デフォルト状態: GPT-4はPA 49.8（人間28.0）、NA 10.0（床値）。極端なポジティブ・デフォルト。
  - 物の所有に関する嫉妬場面では、どのモデルも嫉妬を示さなかった。
  - 「異なる状況を共通の感情でつなげられない」。チャレンジ尺度ではBDI-IIのみが有意だった。
  - 負の状況のあとでは拒否率が上がり（29.5% vs 12.5%）、口調が攻撃的になった。
- **(B) EQ-Bench**（Paech, arXiv 2312.06281, 2023-12）— [arXiv](https://arxiv.org/html/2312.06281v2)
  - 構成: 60問。GPT-4が生成した対立場面の対話を読み、登場人物の4感情の強度を0–10で評定する。著者の参照解との差で採点する。
  - 結果: GPT-4-0613 62.52、Claude 2 52.14、Vicuna 7B 22.24。
  - 一般能力との相関が非常に高い: MMLU r=0.97、Chatbot Arena r=0.94。つまり「EQ」の大部分は一般能力の反映だと読める。
  - 再実行の変動係数は2.93%。自己批判と修正の効果は一定しなかった。
  - 限界: 人間ベースラインなし、参照解は著者の主観。
- **(B) SECEU**（Wang et al., arXiv 2307.09042, 2023）— [arXiv](https://arxiv.org/abs/2307.09042)
  - MSCEITの感情理解尺度に基づく。人間の基準は500名超。
  - GPT-4はEQ 117で、人間の89%を上回った。
  - SECEUとEQ-Benchの相関は弱い — [EQ-Bench](https://arxiv.org/html/2312.06281v2)

### Inferences
- 「どの感情か」というカテゴリ判断には、ある程度頼れる。「どれくらい強く感じるか」をLLMに直接言わせると、強く出すぎる恐れが高い（EmotionBench）。
- エージェントの軽い感情を作るなら、次の設計が妥当と推測する。
  - 強度は低い固定値か、少数の段階から選ばせる。
  - 強度をLLMに自由に決めさせない。
- ベンチマーク間でスコアの相関が弱い（SECEU vs EQ-Bench）。「EQ」は構成概念として安定していない。

### Gaps
- EmotionBench はポジティブ感情（喜び・驚き）を体系的には扱っていない（負の8感情のみ）。喜び・驚きの喚起については直接の大規模データが見つからなかった。
- EmoBench の人間スコアの数値は本文に記載がない。

## Q2. LLMの評価（appraisal）と人間の評価を比べた研究では、一致度はどうで、どこで失敗するか

### Takeaway
GPT-4のappraisal評定は「平均的な第三者（読み手）」とよく一致する。快・不快などの評価と幸福・悲しみの評定では、r が0.9以上になる。体験者本人の自己評価とは、それより一致しない。
一貫して弱いのは次の点。
- 驚き（過大に評定する）
- 「すでに起きたか」などの時間的判断
- 強度とコーピング
- 人による違い（混合感情、文化差）

### Cited Findings
- **(H) Tak & Gratch 2023「Is GPT a computational model of emotion?」**（ACII 2023）— [arXiv](https://arxiv.org/pdf/2307.13779)
  - プロンプト工夫なしでも、GPTの予測は人間のappraisalや感情ラベルと有意に一致した。
  - 感情強度とコーピングの予測は苦手だった。
  - GPT-4は研究1（自伝的記憶）で最良だったが、研究2（状況要因の系統的操作）では及ばなかった。
- **(H) Tak & Gratch 2024「GPT-4 Emulates Average-Human Emotional Cognition from a Third-Person Perspective」**（arXiv 2408.13718, 2024-08、査読先の記載なし）— [arXiv](https://arxiv.org/html/2408.13718v1)
  - 研究1: Skerry & Saxe の200ヴィネット（20感情、人間1,521名分の評定）。GPT-4はtemperature 0で各8回。
    - 人間とGPT-4の相関（appraisal）: Pleasantness r=.945、Expectedness .880、Agent-cause .758、Already-occurred .528（最低）。
    - 人間とGPT-4の相関（感情）: Happy .970、Sad .942、Angry .887、Disgusted .885、Surprise .671（最低）。GPT-4は人間より明らかに高い驚きを付けた。
    - 手がかりの使い方が人間と違う。GPT-4は嫌悪を「予想外性」に結びつけ、人間は「長期的結果」に結びつけた。GPT-4は悲しみを「身近な他者の関与」から予測し、人間は「プレッシャー」から予測した。
  - 研究2: crowd-enVENT の1,200件（本人評定と読み手5名の評定）。
    - 21のappraisalのうち20で、GPT-4は本人より読み手（第三者）の評定に近かった。
    - 単独の平均的な読み手は、GPT-4をわずかに上回った。
    - 個人差が大きい次元（accept_consequence など）は一致が低かった。
  - 限界: GPT-4の1バージョンのみ。文化を超えて一般化できるかは未検証。
- **(H) Ruder, Uusberg & Sirts 2025「Reliability and Validity of GPT-4 in Annotating Emotion Appraisal Ratings」**（arXiv 2503.16883, 2025-03）— [arXiv](https://arxiv.org/html/2503.16883v1)
  - 21のappraisal次元を1–5で評定。
  - 本人評定との誤差（単回RMSE）: GPT-4 1.45、人間の読み手 1.57。GPT-4は人間の読み手と同等か、やや上だった。
  - GPT-4の5回分を多数決で集約すると、RMSEは 1.61 → 1.12 と約30%改善した。
  - 感情予測タスクを同時に課すと悪化した（RMSE 1.22）。感情の正答率は約55%。
  - テキストが長いほど正確になり、400–500字で頭打ちになった。
  - 最難の次元: Anticipated Consequences、Attention。
- **(H) Broekens et al. 2023**（ACII 2023、Honorable Mention）— [arXiv](https://arxiv.org/pdf/2309.01664)
  - ChatGPTのzero-shotで、VAD（Valence・Arousal・Dominance）推定がfine-tunedモデルと同等だった。
  - プロンプトでOCCモデルを再現し、基本的なappraisalベースの感情喚起ができた。
- **(H) Yongsatianchot, Torshizi & Marsella 2023**（arXiv 2310.04450）— [arXiv](https://arxiv.org/pdf/2310.04450)
  - ChatGPTとGPT-4に抑うつ者を演じさせた。統制可能性を低く、valenceを負に評価する方向へ、理論どおり変化した。
  - 著者は、これがステレオタイプの学習にすぎない可能性を指摘している。
- **(H) Yongsatianchot, Thejll-Madsen & Marsella 2023「What's Next in Affective Modeling?」**（ACII Workshops 2023）— [arXiv](https://arxiv.org/abs/2310.18322v1)
  - GPT-4は感情理論の区別、感情的な物語の生成、reverse appraisal で正しい推論をした。
  - それでも著者は、感情メカニズムのモデル化を完全には置き換えないと結論している。
- **(H) Schlegel, Sommer & Mortillaro 2025**（Communications Psychology 3, 2025-05-22, DOI 10.1038/s44271-025-00258-x）— [UNIGE press](https://www.unige.ch/medias/en/2025/et-si-lia-comprenait-les-emotions-mieux-que-nous) / [Archive](https://archive-ouverte.unige.ch/unige:185363)
  - モデル6種: ChatGPT-4、o1、Gemini 1.5 Flash、Copilot 365、Claude 3.5 Haiku、DeepSeek V3。
  - 標準化されたEIテスト5種で、LLMの平均正答は約81–82%、人間（原典の検証研究）は56%。
  - GPT-4が作った新しい項目を人間467名に受けさせた。難易度は同等で、原版との相関は r=0.46。差はすべて d<0.25。
  - 注意: 人間の比較値は原典の検証データで、新しく集めた標本ではない。形式は多肢選択。

### Inferences
- 一致が高い部分と低い部分がある。
  - 高い: 快・不快、目標との一致、責任の帰属
  - 低い: 驚き・予想外性、時間的判断、強度
- 対象の5感情に当てはめると、喜びと悲しみは比較的信頼できる。嫌悪はやや信頼できる。
- 驚きには過大に評定する傾向がある（Tak & Gratch 2024）。エージェントの「驚き」は、LLMの判断だけに任せない方がよい。予想との差など、明示的な期待値のシグナルで決める方が安全と推測する。
- 困惑（confusion）は、上記の研究のどれも直接扱っていない。
- GPT-4が近いのは「平均的な第三者の常識」で、本人の主観ではない。エージェントの感情を「常識的にもっともらしい」反応として決めるという目的には、むしろ合っている。
- 単回では揺れる。複数サンプルの多数決で約30%誤差が減るが、レイテンシとのトレードオフになる。

### Gaps
- Schlegel 2025 のモデル別スコア（Claude 3.5 Haiku など）は、本文PDFを抽出できず確認できなかった。
- 混合感情を人間と比較した定量データは乏しい。下の Dudy et al. を参照。
- 「困惑」のappraisalを人間と比べた研究は見つからなかった。

## Q3. 試行間・プロンプト間で判断は安定しているか。ポジティブ偏向や過剰な劇化はあるか。ペルソナに左右されるか

### Takeaway
同じプロンプトの再実行では、比較的安定している（GPT-4のSpearman .87、EQ-BenchのCV約3%）。分布の面では次の歪みがある。
- 人間の不一致（不確実性）を再現しない
- 状況への反応が誇張される
- デフォルトでポジティブに偏る

ペルソナを与えると、ステレオタイプを演じる方向に流れやすい。

### Cited Findings
- **再現性**
  - GPT-4を5回実行したとき、appraisal評定の平均Spearmanは0.87、平均ペアワイズRMSEは0.61 — [Ruder et al. 2025](https://arxiv.org/html/2503.16883v1)
  - EQ-Benchの反復実行の変動係数は平均2.93% — [EQ-Bench](https://arxiv.org/html/2312.06281v2)
  - EmotionBench: 別のプロンプトテンプレートでも平均は近く、分散は小さかった — [EmotionBench](https://arxiv.org/html/2308.03656v4)
- **過剰反応とポジティブ・デフォルト**
  - GPT-4の状況によるPA低下は人間の5倍以上、NA上昇は約2倍 — [EmotionBench](https://arxiv.org/html/2308.03656v4)
  - GPT-4のデフォルトはPA 49.8/50、NA 10/50（最低値） — [EmotionBench](https://arxiv.org/html/2308.03656v4)
- **分布の歪み**
  - LLMは「ラベルは捉えるが不確実性は捉えない」。GoEmotionsとEmoBankの64万応答で、zero-shot LLMは人間の分布から大きく乖離した。
  - 語彙上の手がかりが明示的な感情には強く、文脈推論が必要な感情には弱い。
  - 事後キャリブレーションで分布の差は最大14%縮んだ（Inoshita et al., arXiv 2604.27345, 2026-04）— [arXiv](https://arxiv.org/abs/2604.27345)
  - 検索結果の要約によると、同論文では予測の幅が人間より狭く（compression）、valenceはarousalやdominanceより良く当たった。これは本文で未確認 — [arXiv PDF](https://arxiv.org/pdf/2604.27345)
- **ペルソナ**
  - 抑うつのロールプレイは理論どおりのappraisalを生むが、ステレオタイプの可能性がある — [Yongsatianchot et al.](https://arxiv.org/pdf/2310.04450)
  - Persona-E²（ACL 2026, arXiv 2604.09162）: 次の3点を報告 — [arXiv](https://arxiv.org/abs/2604.09162)
    - 最先端のLLMでも、性格による精密なappraisalの変化は捉えにくい（特にSNS領域）。
    - 性格を演じるLLMは表面的なステレオタイプに頼りがち（"personality illusion"）。
    - Big Fiveの情報を与えると理解が改善する。
- **プロンプト依存**
  - 感情と議論の説得力の研究では、小さいモデルとgpt-3.5-turboがプロンプト中の例示に強く左右された — [arXiv 2503.00024](https://arxiv.org/pdf/2503.00024)
  - EmoBenchではCoTで成績が下がるモデルが多い — [EmoBench](https://arxiv.org/html/2402.12071v3)

### Inferences
- 低いtemperatureで同じプロンプトを使えば、カテゴリ選択はかなり再現できると見てよい。
- 強度とポジティブ偏向は、システム側で抑える必要がある。例: 「軽い」上限を設ける、ニュートラルをデフォルトにする。
- 「〜な性格のエージェント」というペルソナで感情を変えようとすると、ステレオタイプが誇張される恐れがある。性格の影響は、プロンプトの言い回しではなく、少数のパラメータでルールとして与える方が安定すると推測する。

### Gaps
- Claudeなど最新のRLHFモデルで「ポジティブ偏向」を直接測った研究は見つからなかった。EmotionBenchはGPT-4（2023）時点。
- RLHF後のアシスタント系モデルが負の感情（嫌悪など）を表明しにくい傾向について、定量的な研究は見つからなかった。

## Q4. 日本語、または文化をまたぐ感情評価についての証拠はあるか

### Takeaway
日本語に特化したappraisalベンチマークは見つからなかった。数少ない証拠はいずれも、LLMが日米の感情文化差を十分に再現できないことと、日本語での性能が英語より低いことを示している。

### Cited Findings
- **(H) Dudy, Ahmad, Kitajima & Lapedriza 2024**（arXiv 2408.02143, 2024-08）— [arXiv](https://arxiv.org/html/2408.02143v1)
  - Miyamoto et al. 2010 の日米混合感情実験をLLMで再現した。
  - モデル: mistral-7b、gemma-7b、llama-2-70b、gpt-3.5-turbo、gpt-4-turbo。言語・モデルごとに80応答。
  - 人間の知見との一致度は、4モデルで0%、最高のGPT-3.5で28.5%。人間では、日本人は成功場面で混合感情が多い。
  - 成功場面と失敗場面の分布がしばしば似ていた。状況の種類への感度が低い。
  - 回答への影響は「設定された出身国」より「プロンプトの言語」の方が大きかった。
  - 限界: 状況はChatGPTで生成、2010年の1研究のみ、人間による検証なし。
- **(B) CEDAR「Tears or Cheers?」**（arXiv 2601.13024, 2026-01）— [arXiv](https://arxiv.org/html/2601.13024v1)
  - 7言語・14感情・10,962件。文化を超えて予測が一様になる項目は除外し、文化差のある項目だけを残している。
  - 17モデルを評価。Gemma3-27B-Itは日本語データ・日本語プロンプトで30.46%、英語では44.14%。
  - 日本語群では、テキストのみの設定で低valence・低arousalの感情に約−20%の偏りが見られた。
- **Gao et al.（PLOS ONE, 2026-07-27、NAIST/LINEヤフー）** — [LY Corp](https://research.lycorp.co.jp/en/publications/2747)
  - 日本の職場シナリオで、Hofstedeの文化次元とVAD分析を用いて評価した。
  - モデル: LLM-jp、Phi、Llama、Qwen、GLM。GLMとLLM-jpは比較的よく整合し、Llamaは一貫性が低い。
  - 人間とLLM judgeの一致は中程度。
- **関連（appraisalではない）**
  - 日本語SNSの感情極性（WRIME）でLLMを評価した研究がある。llm-jp-evalに感情タスクがないことを問題として挙げている — [IPSJ](https://ipsj.ixsq.nii.ac.jp/record/236262/files/IPSJ-Z86-1W-02.pdf)
  - CULEMO: 文化を考慮した多言語の感情予測ベンチマーク — [arXiv](https://arxiv.org/pdf/2503.10688v3)
- **EmoBench の文化面**
  - 英語と中国語の両方で、中国語の方がやや低い（GPT-4のEU 59.75 vs 54.12）。
  - 文化的価値が絡む問題は弱点の一つ — [EmoBench](https://arxiv.org/html/2402.12071v3)

### Inferences
- 日本語の会話エージェントで自分の感情を決めるなら、日本特有の反応は次のように扱うのがよいと推測する。
  - 謙遜、成功時の混合感情、気まずさや遠慮などは、LLMの常識に任せると英語圏寄りになりやすい。
  - 日本語で書いた評価用ケースで検証する必要がある。
- プロンプトを日本語で書くと、それだけで出力が変わる（Dudy et al.）。評価は実際に使う言語で行うべき。

### Gaps
- 日本語のappraisal次元（OCC/CPMなど）を人間と比べた研究は見つからなかった。
- Claude/GPTの日本語感情判断を日本人の評定と比べた定量研究は見つからなかった。

## Q5. 小型・高速モデル（Haikuクラス）とfrontierモデルの比較データはあるか

### Takeaway
感情理解のスコアは、一般能力と強く相関する。小型・旧世代のモデルは大きく劣る。ただし近年の小型モデル（Claude 3.5 Haiku、Gemini 1.5 Flash）も、標準EIテストで人間平均を上回る群に入っていた。

### Cited Findings
- EQ-Benchの総合スコアは一般能力とほぼ線形に並ぶ（MMLU r=0.97） — [EQ-Bench](https://arxiv.org/html/2312.06281v2)
  - GPT-4 62.5、Claude 2 52.1、Vicuna 7B 22.2。
- EmoBenchでの規模差 — [EmoBench](https://arxiv.org/html/2402.12071v3)
  - EU: GPT-4 59.75、GPT-3.5 33.12、7Bクラス 11–22（英語）。
  - EAは差が縮まり、7Bでも約47–55。
  - CoTの話題逸脱や回答拒否は、小さいモデルほど多い。
- EmotionBench: LLaMA-2-7BはPANASの指示に従えないことがあった — [EmotionBench](https://arxiv.org/html/2308.03656v4)
- Schlegel 2025: Claude 3.5 HaikuとGemini 1.5 Flashを含む6モデルの平均が約81%（人間56%） — [UNIGE press](https://www.unige.ch/medias/en/2025/et-si-lia-comprenait-les-emotions-mieux-que-nous) / [検索要約](https://archive-ouverte.unige.ch/unige:185363)
  - モデル別の内訳は未確認。
- Inoshita et al. 2026: 人間の分布との差を埋めるのに必要なのは規模ではなく、ドメイン内のfine-tuningだとした — [arXiv](https://arxiv.org/abs/2604.27345)

### Inferences
- 5感情から1つを選ぶ程度の粗いカテゴリ判断なら、Haikuクラスでも実用域にある可能性が高い。ただしこれは推測で、直接の証拠はない。
- 弱点が出やすいのは次の判断で、小型モデルほど落ちると考えられる。
  - 視点取得
  - 個人の文脈（誰にとっての出来事か）
  - 驚きや強度
- 自前の評価セットで、Haikuクラスとfrontierを比べるべき。

### Gaps
- Haikuクラス（Claude 3.5/4.x Haiku）の感情appraisalを、人間の評定と直接比べたデータは見つからなかった。
- 現行世代のモデルによるEmoBench/EmotionBenchの再評価は、今回の調査では確認できなかった。
