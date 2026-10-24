# 音声会話エージェントの即応性とターンテイキング（終話検出・遅延予算・全二重・応答ペーシング）

前提: 日本語音声アシスタント（ASR → LLM [Claude Haiku 級] → TTS [VOICEVOX 系、速度/ピッチ/抑揚可変]）＋ 能動発話を決める背景エージェント（追加 LLM 1–2 回）。
凡例: **[BENCH]** 公開ベンチマーク／論文の自動評価、**[USER N=…]** 人を対象とした評価、**[VENDOR]** ベンダー自己申告・ブログ、**[3rd]** 二次情報（未確認）。

---

## Q1. 終話検出（End-of-turn / turn detection）: LiveKit, Pipecat Smart Turn, VAP, semantic endpointing

### Takeaway
日本語対応で今すぐ組み込めるのは (a) 音声入力型の Pipecat Smart Turn v3（8MB、CPU 12–95ms、日本語正解率 96.8%、BSD-2）と (b) LiveKit のターン検出器（テキスト版は日本語 TPR 99.3%/TNR 88.8%、現行は音声版 v1/v1-mini）。いずれも「VAD で無音を検出 → 小モデルで"言い終わったか"を判定 → 動的に待ち時間を変える」構成で、固定無音タイムアウト（〜0.5–0.8s）より早く・誤割り込み少なく返答できる。VAP は日本語で学習済み・CPU 実時間動作するが、2話者ステレオ前提の研究系実装。

### Cited Findings
**LiveKit turn detector**
- 現行は音声ベースの `v1`（LiveKit Inference 上で提供、最高精度）と CPU ローカル実行の軽量 `v1-mini`（無料）。旧テキスト版 multilingual（Qwen2.5-0.5B-Instruct ベース、要 STT）は deprecated・SDK 2.0 で削除予定 [VENDOR] — [LiveKit docs: Turn detector](https://docs.livekit.io/agents/logic/turns/turn-detector.md)
- 音声版の対応 14 言語に日本語を含む。STT なし（realtime モデル使用時）は英語閾値がデフォルトになる [VENDOR] — [LiveKit docs](https://docs.livekit.io/agents/logic/turns/turn-detector.md)
- テキスト版の日本語: TPR 99.3%（言い終わりを正しく検出）、TNR 88.8%（まだ続くことを正しく検出）。英語は TPR 99.3%/TNR 87.0%。音声版の言語別数値はドキュメントになく eot-bench を参照とある [VENDOR] — [LiveKit docs](https://docs.livekit.io/agents/logic/turns/turn-detector.md)
- テキスト版の推論は CPU で約 50–160ms/ターン、ディスク約 396MB、RAM <500MB [VENDOR] — [LiveKit docs](https://docs.livekit.io/agents/logic/turns/turn-detector.md)。PyPI 掲載文では "~25ms" と別の数値 [VENDOR, 不一致] — [livekit-plugins-turn-detector](https://simple-repository.app.cern.ch/project/livekit-plugins-turn-detector)
- エンドポイント遅延のデフォルト: 標準 `min_delay` 0.5s / `max_delay` 3.0s、音声検出器使用時 0.3s / 2.5s。動的モードは EMA（alpha=0.9）で遅延を適応。音声検出器は VAD 必須で `min_silence_duration ≥ 0.25s`（Silero 既定 0.55s）。約 1 秒応答がなければターン確定。`unlikely_threshold` は言語別 dict 指定可（低いほど早取り）。v1 失敗時は v1-mini にフォールバック [VENDOR] — [LiveKit docs](https://docs.livekit.io/agents/logic/turns/turn-detector.md)
- テキスト版 v0.4.1-intl は v0.3.0 比で誤割り込み（TPR 99.3% 固定時の FPR）を相対 39.23% 削減（18.66%→11.34%）。**日本語は 19.70%→11.20%（相対 43.15% 改善）**。Qwen2.5-7B 教師から 0.5B 生徒へ蒸留、コールセンター記録＋合成対話で学習、プロンプトから電話番号等の入力形式を推定して待つ。応答遅延の増加なしと主張 [VENDOR/BENCH] — [LiveKit blog](https://livekit.com/blog/improved-end-of-turn-model-cuts-voice-ai-interruptions-39)

**Pipecat Smart Turn**
- v3: Whisper Tiny エンコーダ＋線形分類器、約 8M パラメータ、int8 で 8MB（v2 の wav2vec2 版 約 400MB から約 50 分の 1）。入力は最大 8 秒 16kHz モノラル、現ターン全体を渡す（短い場合は先頭ゼロ埋め）[VENDOR] — [Daily blog: Smart Turn v3](https://www.daily.co/blog/announcing-smart-turn-v3-with-cpu-inference-in-just-12ms/), [GitHub pipecat-ai/smart-turn](https://github.com/pipecat-ai/smart-turn)
- レイテンシ（前処理込み）: AWS c7a.2xlarge 12.6ms、c8g.2xlarge 15.2ms、t3.2xlarge 33.8ms、c8g.medium 59.8ms、t3.medium 94.8ms、T4 GPU 6.6ms。CPU 前処理は約 3ms [VENDOR] — [Daily blog](https://www.daily.co/blog/announcing-smart-turn-v3-with-cpu-inference-in-just-12ms/)
- **日本語: 正解率 96.76%、偽陽性 2.04%、偽陰性 1.20%（テスト 834 サンプル）**。全 23 言語で 81.27%（ベトナム語）〜97.10%（トルコ語）、中国語 88.57% [VENDOR/BENCH] — [Daily blog](https://www.daily.co/blog/announcing-smart-turn-v3-with-cpu-inference-in-just-12ms/)
- 動作: VAD（Silero 等）が無音を検出 → ターン全録音で Smart Turn 推論。推論完了前にユーザーが話し始めたら全ターンで再推論。ライセンス BSD-2-Clause [VENDOR] — [GitHub](https://github.com/pipecat-ai/smart-turn)
- v3.1 は人間音声データ追加で精度向上（数値なし）、v3.2 も日本語を含む [VENDOR] — [Daily blog v3.1](https://www.daily.co/blog/improved-accuracy-in-smart-turn-v3-1/), [HF Smart-Turn-v3.2-ONNX](https://huggingface.co/soniqo/Smart-Turn-v3.2-ONNX)

**VAP（Voice Activity Projection）**
- 多言語 VAP（英・中・日）: 単一言語モデルは他言語に転移しにくいが、3 言語同時学習モデルは各単一言語モデルと同等。言語識別を内部的に学習、ピッチ感度分析、CPC と多言語 wav2vec2.0（MMS）エンコーダ比較 [BENCH] — [Inoue et al., LREC-COLING 2024, arXiv:2403.06487](https://arxiv.org/abs/2403.06487v3)
- 実時間 VAP: ステレオ対話音声から将来の発話活動を予測（CPC＋self-attention＋cross-attention Transformer）、CPU 上で実時間・精度低下わずか [BENCH] — [Inoue et al. 2024, arXiv:2401.04868](https://arxiv.org/abs/2401.04868v1)。日本語旅行代理店タスク対話 約 92.5 時間で学習、Xeon Gold 6128 で測定 [3rd] — [The Moonlight review](https://www.themoonlight.io/en/review/real-time-and-continuous-turn-taking-prediction-using-voice-activity-projection)。コード: github.com/inokoj/VAP-Realtime（同 arXiv 記載）

### Inferences
- 本プロジェクトの構成（ASR は別、TTS は VOICEVOX）なら、**音声側は Smart Turn v3（CPU, 〜15–60ms）を VAD 無音 200–300ms 時点で走らせ、"未完了" 判定なら最大 1.5–2.5s まで待つ**という二段構えが最小コストで採用しやすい。LiveKit を使わないなら LiveKit 音声版はロックイン気味。
- テキスト側の意味的終話判定（"〜で、" "えーと" で終わる等）は ASR 部分結果に対し Haiku を毎回呼ぶより、ルール＋小モデルで十分。LiveKit テキスト版の日本語 TNR 88.8% は「言いかけの約 1 割で割り込む」ことを意味するので、音声特徴（Smart Turn）と AND/OR 併用が妥当。
- 日本語は文末形式（「〜ます」「〜よね」「〜けど」）が明示的で、テキスト判定が効きやすい言語と推測（直接のソースなし）。

### Gaps
- LiveKit 音声版 v1/v1-mini の日本語 TPR/TNR・推論時間は公開ドキュメントで確認できず（eot-bench 参照とのみ）。
- Smart Turn v3.1/3.2 の日本語別数値、推奨 VAD stop_secs は未確認。
- 日本語の semantic endpointing をユーザー評価（体感遅延・誤割り込み）した独立研究は見つからなかった。

---

## Q2. 全二重音声モデル（Moshi, J-Moshi 等）: 相槌・重なり・割り込みから学べること、日本語で使えるか

### Takeaway
Moshi は理論 160ms/実測約 200ms の応答遅延で全二重対話を実現し、話者交替を明示せず自他 2 ストリームを並列モデル化する。日本語版 J-Moshi（名大 東中研、Interspeech 2025）は公開済みだが、人手評価で自然さ 2.67/5（正解音声 4.46）と品質は研究段階、非商用ライセンス。実運用ではカスケード構成を維持し、全二重モデルの「並列ストリーム」「重なり許容」の考え方を相槌・割り込み制御に借りるのが現実的。

### Cited Findings
- Moshi: 理論遅延 160ms、実測 200ms。ユーザー音声と自分の音声を並列ストリームでモデル化し、明示的な話者ターンを撤廃。ターン分割型パイプラインは重なり・割り込み・間投詞を無視すると批判 [BENCH] — [Défossez et al., arXiv:2410.00037](https://arxiv.org/html/2410.00037v1)
- "Inner Monologue": 時刻同期したテキストトークンを音声トークンの前置として予測し、言語品質を大きく改善、ストリーミング ASR/TTS にも転用可能 [BENCH] — [arXiv:2410.00037](https://arxiv.org/html/2410.00037v1)
- Mimi コーデック 12.5Hz・1.1kbps・80ms フレーム遅延 [3rd] — [sourcepulse summary](https://www.sourcepulse.org/projects/995078)。PyTorch 版は 24GB VRAM GPU 必要 [3rd] — 同上。論文は CC BY-NC-SA 4.0 — [arXiv v2](https://arxiv.org/html/2410.00037v2)
- J-Moshi: Moshi を日本語化。事前学習 J-CHAT 約 69,000 時間（うち約 60,000 時間を 1 エポック）、ステレオ対話 344 時間（学習 320 時間）で微調整、J-Moshi-ext は多ストリーム TTS 合成 602 時間を追加（計 946 時間）[BENCH] — [Ohashi et al., arXiv:2506.02979](https://arxiv.org/html/2506.02979v1)
- 人手評価 [USER: 各モデル 50 サンプル、クラウドワーカー 125 名×10 サンプル、5 段階]: 自然さ／有意味さ = dGSLM 2.44/1.76、J-Moshi 2.67/2.19、J-Moshi-ext 2.66/2.30、再合成 3.90/3.92、正解 4.46/4.45 — [arXiv:2506.02979](https://arxiv.org/html/2506.02979v1)
- 1 分あたりターンテイキング統計: ポーズ J-Moshi 6.3s vs 人間 3.5s、ギャップ 4.5s vs 4.0s、**オーバーラップ 5.0s vs 人間 8.1s**（重なりが人間より少ない）。相槌統計・応答遅延は未報告。Mimi は日本語未適応、テキストトークンの 88% が PAD、合成データ WER 24.6% を課題に挙げる — [arXiv:2506.02979](https://arxiv.org/html/2506.02979v1)
- 公開: nu-dialogue/j-moshi, j-moshi-ext（HF、CC BY-NC 4.0）、コード・サンプルは nu-dialogue.github.io/j-moshi — [arXiv abs](https://arxiv.org/abs/2506.02979v1), [HF commit page](https://huggingface.co/nu-dialogue/j-moshi/commit/7858a6af6eafc64bf8a7713b89a1bf851841112c)
- 日本語全二重学習用データとして DuplexChat（ポッドキャスト由来、英語 282,634 時間・日本語 132,723 時間の話者分離データ）が 2026 年に公開（データ資源でありモデルではない）[BENCH] — [DuplexChat, alphaXiv 2607.04941](https://www.alphaxiv.org/abs/2607.04941)

### Inferences
- 日本語の人間会話では 1 分あたり約 8 秒が重なり（J-Moshi 論文の正解データ）であり、「相手が話している間は黙る」半二重設計は日本語らしさを損なう。**ユーザー発話中に相槌だけは出す（TTS 本応答とは別チャネル・低音量・短尺）**のが全二重の利点を部分的に取り込む方法。
- Claude Haiku 級の推論力・ツール利用を捨てて J-Moshi に置換するのは品質（自然さ 2.7/5）とライセンス（NC）の両面で不適。
- Inner Monologue の発想は「テキストを先に確定しながら音声化する」＝カスケードでの節単位ストリーミングと同型。

### Gaps
- J-Moshi の応答遅延・割り込み応答の定量値は論文に記載なし。
- NTT・CyberAgent・llm-jp 等の日本語全二重モデル公開は本調査の検索では見つからなかった（存在しないとは断定できない）。
- Moshi の相槌・バージイン挙動の定量分析は取得できず。

---

## Q3. 遅延予算: 自然と感じる応答遅延と短縮テクニック（節単位ストリーミング、先読み、フィラー、プロンプトキャッシュ）

### Takeaway
人間同士の交替ギャップは中央値約 200ms（日本語は特に短いとの報告）だが、ユーザー研究で示される音声エージェントの許容域はそれより緩く、約 2 秒を超えると不自然、4 秒超で明確に耐えがたい。実務目標は「発話終了→最初の音」500–800ms（ベンダー経験則）。最大の効き目は (1) 終話判定の短縮、(2) LLM 最初の節で TTS 開始（文単位でなく節単位）、(3) プロンプトキャッシュによる TTFT 短縮、(4) 自然なフィラー／相槌で待ちを埋める（記号的な待機表示は効果なし）。

### Cited Findings
**人間の基準**
- 10 言語の質疑応答で、重なり回避と沈黙最小化は普遍的、平均ギャップの言語差は横断平均から ±250ms 以内 [BENCH: 会話コーパス分析] — [Stivers et al. 2009, PNAS](https://forms.mpi.nl/node/50939)。中央値約 200ms とする要約 — [Agora blog](https://agora.io/en/blog/the-impact-of-latency-in-speech-driven-conversational-ai-applications)
- 日本語話者が最速で平均ギャップ 7ms、日本語話者には 36ms が「時間通り」、デンマーク語話者には 200ms [3rd: 一般誌報道、論文表で未確認] — [National Geographic](https://www.nationalgeographic.com/science/phenomena/2009/06/19/pregnant-pauses-and-rapid-fire-how-do-different-cultures-take-turns-to-talk/)

**ユーザー研究**
- CUI 2025（UCF）: 応答開始を人為的に遅延させると知覚応答時間と各種印象が有意に悪化、4 秒超で耐えがたい。自然な会話フィラーは影響を一部緩和、人工的な待機インジケータは有意な効果なし。関連研究として 2 秒超から不自然との指摘を引用 [USER, N は PDF 取得失敗で未確認] — [Maslych et al., CUI 2025 PDF](https://www.eecs.ucf.edu/isuelab/publications/pubs/maslychmCUI25.pdf)（検索スニペット経由）。同グループの VR パイロット研究（遅延 1.5/4.0/6.5s × フィラー無/人工/自然）[3rd] — [arXiv:2501.00168](https://arxiv.org/abs/2501.00168), [Plaksha slide](https://ds4101.plaksha.edu.in/Monsoon%202025/PDFs/Abhinav.pdf)
- VR 研究 [USER N=24, 被験者内]: 会話＋身振りのマルチモーダルフィラーがアイドル動作や記号的進捗表示より知覚応答時間・存在感・人間らしさ・自然さを改善、多数が選好。記号的表示は改善せず — [arXiv:2508.11781](https://web3.arxiv.org/pdf/2508.11781)
- 会話フィラーは 8 秒遅延の知覚待ち時間を短縮、32 秒ではマイクロタスクが有効 [USER] — [AAAI 2021 paper](https://cdn.aaai.org/ojs/18935/18935-64-22701-1-2-20211004.pdf)
- 単発の短いフィラーは長い待ちの冒頭しか埋めず、汎用フィラーの反復は進捗情報を与えない。動的に音声で「考えを口に出す」方式で長い推論中も知覚遅延を低く保つ [BENCH] — [Spoken Language Models that Think Aloud, arXiv:2609.26488](https://arxiv.org/pdf/2609.26488)
- 直列 LLM パイプラインは人間のターンタイミング期待に反する。質問の途中で応答準備を始める根拠として、GPT-4 が途中で切れた質問の欠落語を 60% 超で推定 [BENCH] — [arXiv:2404.16053](https://arxiv.org/html/2404.16053v1)

**ベンダー経験則（統制研究ではない）**
- 総予算 800ms、1,500ms 超で壊れている印象 [VENDOR] — [twig blog](https://www.twig.so/blog/voice-ai-agents-latency-budget-800ms)。500ms を実用的な「自然」目標、1 秒超で破綻 [VENDOR] — [Simba](https://simbavoice.ai/resources/latency-in-voice-ai-why-sub-500ms-matters)。中央値よりテール遅延が体験を壊す — [Parloa](https://www.parloa.com/labs/insights/the-latency-paradox/)
- バージイン・ターンテイキング設計ガイド [VENDOR] — [Picovoice guide](https://picovoice.ai/guide/voice-agents/voice-ux-latency-turn-taking/)

**パイプライン計測・ストリーミング**
- Pipecat は TTFB、TTFA（TTFB＋先頭無音パディング）、text aggregation（LLM 最初のトークン→最初の完全な文まで）を計測。ログ例: Anthropic LLM TTFB 約 0.84s、Cartesia 文集約 約 0.21s、Cartesia TTFB 約 0.17s [VENDOR, 例示] — [Pipecat metrics docs](https://docs.pipecat.ai/pipecat/fundamentals/metrics)
- `UserBotLatencyObserver` の `on_latency_breakdown`（0.0.104）でターンごとにサービス別 TTFB・文集約・ユーザーターン長・関数呼び出し遅延を出力 — [pipecat-ai 0.0.104 release](https://newreleases.io/project/pypi/pipecat-ai/release/0.0.104)
- 文単位集約に加えベンダー側バッファ（例: Sarvam 50 文字）が二重バッファになる、クライアント STT 設定で 500ms 音声を保持する例 — [Sarvam Pipecat production guide](https://docs.sarvam.ai/api/integration/pipecat-production-guide)。トークン単位ストリーミングへの切替推奨 — [Pipecat TTS docs](https://docs.pipecat.ai/pipecat/learn/text-to-speech)

**プロンプトキャッシュ**
- Anthropic: 長いプロンプトでコスト最大 90%・レイテンシ最大 85% 削減（Claude 3.5 Sonnet、キャッシュ後に 100–200 トークンの動的指示、中央値）。10 万トークンキャッシュの例で 11.5s→2.4s（79% 減）。キャッシュ書き込みは基本単価 +25%、読み出しは 10% [VENDOR] — [Anthropic: Prompt caching](https://www.anthropic.com/news/prompt-caching)
- 主要 3 社の長時間エージェントタスクでのキャッシュ独立評価。最小トークン閾値（1,024–4,096）と TTL（5 分–24 時間）がプロバイダで異なる [BENCH] — [Don't Break the Cache, arXiv:2601.06007](https://www.alphaxiv.org/abs/2601.06007.md)

### Inferences
- **予算案（発話終了→最初の音）**: VAD 無音 200–300ms ＋ 終話モデル 15–60ms ＋ ASR 確定 50–150ms ＋ Haiku TTFT（キャッシュ有）300–600ms ＋ 最初の節の生成 100–200ms ＋ VOICEVOX 最初の節合成 100–300ms ≈ 0.8–1.6s。800ms を切るには「終話確定前から LLM を投機的に開始（ASR 部分結果で走らせ、追加発話があれば破棄）」か「即時相槌/フィラーで最初の音を 300ms 以内に出す」が必要（推論、数値は各ソースからの組み立てで実測ではない）。
- VOICEVOX はストリーミング合成ではなく文/アクセント句単位合成なので、LLM 出力を「、」「。」等の節境界で区切り、最初の節は短く（10–20 字）するのが効く。Pipecat の文集約 0.21s の例のように、句読点待ちのコストは無視できない。
- 背景エージェントの追加 LLM 1–2 回は**応答のクリティカルパスから外す**（応答生成と並列、または応答後に実行）。能動発話の判断は次の沈黙機会まで遅れても体感遅延に影響しない。
- システムプロンプト・ペルソナ・ツール定義を先頭に固定しキャッシュ境界を置く。会話ごとに変わる情報（時刻・状態）は末尾へ。Haiku の最小キャッシュ長（モデルにより 1,024–4,096 トークン級）を満たすか要確認。
- 人工的な「考え中」音・表示より、自然な日本語フィラー（「えっと」「そうですね」）の方が効果があるというエビデンスは VR/アバター研究中心で、音声のみの環境への一般化は慎重に。

### Gaps
- CUI 2025 論文の N・遅延条件の正確な値は PDF 取得失敗（証明書エラー）で未確認。
- 日本語音声アシスタントでの許容遅延を測ったユーザー研究は見つからなかった（日本語話者はギャップが短いという報告は二次情報）。
- 投機的応答生成（ASR 部分結果からの先行 LLM 呼び出し）の効果を測った査読研究は本調査で未取得。
- VOICEVOX の文長別合成時間の公開ベンチは未調査。

---

## Q4. 日本語音声対話の相槌（あいづち）生成: 自然さ向上のエビデンス

### Takeaway
京大 河原研・井上らは VAP を微調整した相槌予測（タイミング＋種類[継続「うん」/評価「へー」]）を日本語で CPU 実時間（RTF 0.16–0.23）で実現しているが、そのモデル単体のユーザー評価は未実施。ユーザー評価としては、相槌等を生成する ERICA 傾聴システムが高齢者との対話で WoZ（人間操作）と同等の傾聴スコアを得たこと、規範的タイミングに挿入した相槌が有意に自然と評価されたこと（LREC 2014）がある。単調な同一相槌の反復は不自然とされ、形式・韻律の変化が要点。

### Cited Findings
- "Yeah, Un, Oh"（NAACL 2025）: 日本語のみ。事前学習 約 35 時間（面接・初対面会話）、ERICA 傾聴 WoZ 109 セッション（各 7–8 分）で微調整。継続型 10,081 件・評価型 3,506 件、正例はフレームの約 10% [BENCH] — [Inoue et al., arXiv:2410.15929](https://arxiv.org/html/2410.15929v1), [ACL Anthology](https://aclanthology.org/2025.naacl-long.367)
- 結果（フレーム単位 F1）: タイミング 42.85（ベースライン 36.37、ランダム 13.76）、継続型 38.11（34.13）、評価型 31.76（19.74）。i7-11700 CPU・10Hz で RTF 0.157–0.229。文脈 5 秒が最適、継続型は 1 秒文脈でも F1 35.25。強度平坦化で −2.6〜−3.0 と、ピッチより強度に依存。**ユーザー評価は未実施（今後の課題と明記）**。CG エージェントに統合済み、インタフェース非依存モジュール [BENCH] — [arXiv:2410.15929](https://arxiv.org/html/2410.15929v1)
- ERICA 傾聴システム（相槌を含む聞き手応答を生成）: 高齢者との対話実験で WoZ 条件と「話しやすい」「真剣に聞いている」「話に集中」「積極的に聞いている」等の基本傾聴スキルで同等スコア [USER, N 未確認] — [Kyoto Univ. repository, JSAI 2021, DOI 10.1527/tjsai.36-5_h-l51](https://repository.kulib.kyoto-u.ac.jp/dspace/handle/2433/269039)
- ERICA 傾聴（SIGDIAL 2020）: 連続予測によりユーザー発話中に相槌を出せる。相槌形式はコーパス分布から選択 — [SIGDIAL 2020](https://preview.aclanthology.org/fix_video/2020.sigdial-1.15.pdf)
- 規範的相槌タイミングコーパス（89 名がキー押下で適切な相槌位置を指示）。知覚テストで BRP（相槌関連位置）に挿入した相槌は元条件より 7 段階自然さが有意に高い [USER N=89（コーパス収集）] — [Noguchi, Katagiri, Den, LREC 2014](https://aclanthology.org/L14-1563/)
- 多くのシステムは同じ相槌パターンを繰り返し単調。二値分類器群で複数形式（と非生成）を予測 — [Kawahara et al., Interspeech 2016](https://www.cs.utep.edu/nigel/abstracts/kawahara-bc16.html)
- 相槌韻律は先行発話に同調（カウンセリング対話）。相関は応答型トークンで大きく、ピッチより強度特徴で大きい — [Kawahara et al., IWSDS 2015](https://www.uni-ulm.de/fileadmin/website_uni_ulm/iui.iwsds.2015/iwsds2015_submission_21.pdf)
- 日本語相槌の F0 は直前発話のパワーと高相関 — [Ochi, Inoue, Lala, Kawahara, Interspeech 2024](https://papers.cool/venue/ochi24@interspeech_2024@ISCA)
- 自律 vs 遠隔操作 ERICA でユーザーの発話長・話速・フィラー・相槌・笑い等に有意差（ユーザー行動から自律システムを検出可能）[USER] — [arXiv:2410.03147](https://arxiv.org/html/2410.03147v1)
- 英語だが、合成フィードバック応答（"mhm" "ah"）の自然さ・伝達機能を評価 — [Figueroa et al., SIGDIAL 2024](https://aclanthology.org/2024.sigdial-1.46)
- 初期例: 決定木による相槌タイミング＋F0 変化で雑談的会話 — [Nishimura et al., Interspeech 2007](https://www.isca-archive.org/interspeech_2007/nishimura07_interspeech.pdf)

### Inferences
- 実装案: ユーザー発話中は VAD の短い休止（〜200–400ms）＋ ASR 部分結果のテキスト手がかり（「〜て」「〜けど」「〜んですよ」）で継続型（「うん」「はい」）を、話題の意外性・感情語で評価型（「へー」「おお」）を出す。VOICEVOX は事前合成した相槌音声を数種×韻律違いでキャッシュし、直前発話の音量に合わせて大きさ/ピッチを選ぶ（Ochi 2024・IWSDS 2015 の知見に沿う）。
- 同一相槌の連続を禁止しローテーションする（Kawahara 2016）。頻度は正例フレーム約 10%（Inoue 2025 データ）が上限目安と推測。
- 相槌そのものが「最初の音」を早めるので Q3 の遅延予算対策を兼ねる。ただし本応答前の相槌＋フィラーの重ねすぎは冗長。

### Gaps
- 日本語の自律相槌生成をオン/オフ比較し自然さを測った最近（2023–2026）のユーザー研究で N・効果量まで確認できたものはない（ERICA 2021 は WoZ 比較で、相槌単独アブレーションではない）。
- VAP 相槌予測の Inoue らによるユーザー実験結果は、本調査時点で未取得。
- TTS 合成相槌（VOICEVOX 等）の自然さ評価は見つからなかった。
