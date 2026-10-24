# 評価理論（Appraisal Theory）の計算モデルと感情／気分の持続・減衰

凡例: [理論] = 心理学理論, [実装/シミュレーション] = 計算モデル・人手評価なし, [ユーザ研究] = 人間参加者による評価（N 付記）。
「(未取得)」= 本セッションで本文を取得できず、検索スニペット・二次資料・既知の論文内容に依拠したもの。要原典確認。

## Q1. OCC / Scherer CPM / Lazarus / EMA の評価次元と、喜び・悲しみ・驚き・嫌悪/怒り・困惑への対応

### Takeaway
4理論とも「目標関連性 → 望ましさ（目標適合）→ 予期性/新奇性 → 原因帰属（誰のせいか）→ 対処可能性/制御可能性」という共通コアを持ち、喜び=望ましい事象、悲しみ=望ましくない事象＋制御不能、怒り/嫌悪=望ましくない事象＋他者帰属（＋規範違反）、驚き=予期外、困惑=新奇/複雑＋理解（対処）可能性が低い、と写像できる。軽量エージェントでは EMA 的な少数の変数（relevance, desirability, expectedness, agency, controllability）で十分にカバーできる。

### Cited Findings
- [理論] Scherer の CPM は刺激評価チェック (SEC) を4群（Relevance, Implication, Coping potential, Normative significance）に分け、この順で処理されると提案。Relevance に新奇性(novelty)と内在的快(intrinsic pleasantness)、Implication に原因帰属と目標促進性(goal conduciveness) が含まれる — [Delplanque et al. 2009 (Scherer 共著)](https://www.unige.ch/fapse/e3lab/application/files/4617/7739/3267/2009-Delplanque_Grandjean_Chrea_Coppin_Aymard_Cayeux_LeCalve_Margot_Velazco_Sander__Scherer-Emotion.pdf); [SciTePress 2018 の SEC 表](https://www.scitepress.org/PublishedPapers/2018/68674/68674.pdf)
- [理論/実験] CPM はこの順序が固定と主張し、脳活動・生理・表出の計測で「新奇性→内在的快→目標促進性→対処可能性（制御・力）→道徳的妥当性」の順序が支持されたとプロジェクト報告 (EU PROPEREMO) は述べる — [CORDIS PROPEREMO final report](https://cordis.europa.eu/project/id/230331/reporting/de)
- [理論] 対処可能性 (coping potential) = その事象の帰結に対処・適応できる能力の評価 — [PSU Psych425 教科書 CPM 章](https://psu.pb.unizin.org/psych425/chapter/component-process-model-cpm/)
- [理論/形式化] OCC は感情を「事象の帰結」「エージェントの行為」「対象の側面」に対する価値づけ反応として構造化（このため Dastani らのグループが採用した） — [Lifeboat: Dastani プロフィール](https://lifeboat.com/bios.mehdi.m.dastani.shtml); Adam, Herzig & Longin (2009, Synthese) は独自の様相論理 "Logic of Emotions" で OCC の22感情のうち20を定義（2つは未定義） — [Adam et al. 2009 PDF](https://www.cs.uky.edu/~sgware/reading/papers/adam2009logical.pdf)
- [形式化] Steunebrink（Utrecht, 2010, 指導 Meyer & Dastani）の博士論文 "The Logical Structure of Emotions" が OCC の論理構造を再整理 — [Math Genealogy](https://mathgenealogy.org/id.php?id=251529) (本文未取得)
- [理論/実装] EMA (Marsella & Gratch 2009, Cognitive Systems Research 10(1):70–90) は、単一・自動の評価過程がエージェントの環境解釈（因果的解釈 causal interpretation）に作用し、ダイナミクスは知覚・推論過程が解釈を更新することから生じる、と主張 — [Marsella 抄録ページ](https://www.khoury.northeastern.edu/~marsella/publications/abstracts/MarsellaCSR09-abstract.html); [論文 PDF](https://www.cs.uky.edu/~sgware/reading/papers/marsella2009ema.pdf)
- [理論/実装] EMA の評価変数は relevance, perspective, desirability, likelihood, expectedness, causal attribution（agency / blame・credit）, controllability, changeability。例: 望ましい＋確実 → joy、望ましくない＋確実 → distress、望ましくない＋他者帰属 → anger、望ましくない＋不確実 → fear — [EMA 2009 PDF](https://www.cs.uky.edu/~sgware/reading/papers/marsella2009ema.pdf) (未取得: PDF 本文は本セッションで解析できず、既知の論文内容に基づく)
- [理論] Lazarus 系（Smith & Lazarus 1990）は一次評価（目標関連性・目標適合性）と二次評価（責任帰属、対処可能性、将来見通し）を区別。EMA はこの Lazarus 理論の計算化として位置付けられる — [Marsella, Gratch & Petta 2010 草稿](https://people.ict.usc.edu/gratch/public_html/papers/MarGraPet_Review.pdf) (未取得、草稿は "do not cite verbatim")
- [理論] 困惑 (confusion) は興味 (interest) と同じ「新奇性-複雑性」評価を共有し、「対処可能性（理解可能性）」の評価が逆（低い）とする Silvia (2005) モデル。Silvia の研究1（N=61 学生、視覚芸術評定）で、新奇性-複雑性が興味と困惑の双方を予測し、対処可能性は興味を正・困惑を負に予測 — [Audrin & Coppin 2022 (Swiss Psychology Open, 再現研究)](https://reference-global.com/article/10.5334/spo.35); [Interest and Confusion: Contrasting Theoretical Approaches](https://sonar.unidistance.ch/documents/336002/files/Interest-and-Confusion-Contrasting-Theoretical-Approaches.pdf)
- [ユーザ研究/批判] Audrin & Coppin (2022) の比喩文刺激では、比喩は字義文より有意に興味・困惑を高めず、新奇性・価値・対処可能性は両感情に重要だが複雑性は困惑のみと関連 — Silvia の構造と部分的に食い違う — [Audrin & Coppin 2022](https://reference-global.com/article/10.5334/spo.35)
- [LLM 評価] LLM（GPT 系）に臨床的評価尺度を課すと、評価と対処のダイナミクスは人間と類似するが、理論・データが予測する主要評価次元上で応答が分化しなかった — [Tak & Gratch, arXiv:2310.04450](https://arxiv.org/pdf/2310.04450)
- [LLM 評価] LLM の「自己評価 (self-appraisal)」を測る CoRE ベンチマーク: 15感情カテゴリ×16評価次元、感情あたり約20シナリオ — [arXiv:2508.05880](https://arxiv.org/html/2508.05880v1); 評価次元の内部表現を操作すると出力感情が理論通りの方向に変わる（機構的解釈可能性） — [arXiv:2502.05489](https://arxiv.org/html/2502.05489v2)

### Inferences
- 対象5感情への写像（設計案）:
  - 喜び (joy): goal relevance 高 × desirability 正。期待通りなら小さめ、予期外なら増幅（surprise と合成）。
  - 悲しみ (sadness/distress): desirability 負 × controllability/changeability 低（取り返しがつかない）× 他者非難なし。
  - 嫌悪/苛立ち (dislike/anger): desirability 負 × agency=他者（blame）× 規範違反（CPM の normative significance、OCC の reproach）。「軽い嫌悪」は OCC の dislike（対象の側面への非好意）として、事象でなく対象（話題・物）への反応として別系統にするのが OCC 的。
  - 驚き (surprise): expectedness 低（CPM の novelty）。価値中立で短命。他感情の増幅子として扱える。
  - 困惑 (confusion): novelty/complexity 高 × comprehensibility（認識的 coping potential）低。目標は「理解する」という認識的目標。
- LLM は常識的評価（このイベントは望ましいか、誰のせいか）を言語化するのは得意だが、次元ごとの分化が弱い（Tak & Gratch）ため、次元を明示的にスコア化させる構造化出力が有効と推測される。

### Gaps
- Lazarus の核心的関係テーマ (core relational themes) と Smith & Lazarus (1990) の評価成分表の原典 URL は取得できず。
- OCC 1988 原典（書籍）および Steunebrink et al. の "OCC model revisited" 論文（2009 頃の workshop 論文とされる）の本文は未確認。
- EMA の評価変数→感情規則の正確な表は PDF 解析不能のため未検証（既知内容に依拠）。

## Q2. 計算エージェントでの実装（EMA, FAtiMA, GAMYGDALA, WASABI, ALMA）と評価結果

### Takeaway
古典的実装は「OCC/Lazarus 型の評価規則 → 離散感情（強度・減衰つき）→ PAD 等の次元空間での気分」というパイプラインに収束している。評価は主に (a) 臨床尺度との比較（EMA）、(b) 小規模ユーザ研究での「もっともらしさ/年齢感」等（ALMA, WASABI）、(c) ケーススタディ（GAMYGDALA）で、大規模・統制されたユーザ研究は少ない。

### Cited Findings
- [実装/評価] EMA の評価: Gratch & Marsella "Evaluating a Computational Model of Emotion"（JAAMAS 2005, DOI 10.1007/s10458-005-1081-1）は、人間の感情・対処を測る標準的臨床尺度（Ways of Coping 系、SCPQ）を用いてモデル挙動を人間と比較し、強みと要改良点を特定 — [ICT PDF](https://ict.usc.edu/pubs/Evaluating%20a%20General%20Model%20of%20Emotional%20Appraisal%20and%20Coping.pdf); [Unpaywall DOI](https://unpaywall.org/10.1007%2FS10458-005-1081-1)
- [実装/ユーザ研究] Marsella, Gratch, Wang & Stankovic (ACII 2009) は対処方略（諦め、希望的観測、距離化）の妥当性を検証 — [ACII09 PDF](https://people.ict.usc.edu/~nwang/PDF/ACII09-coping.pdf) (N 未確認)
- [サーベイ] Marsella, Gratch & Petta (2010, Blueprint for Affective Computing, OUP) は、計算モデル化は理論を実装するだけでなく、理論の隠れた前提を露わにし理論構築の枠組みになると論じる — [抄録](https://www.khoury.northeastern.edu/~marsella/publications/abstracts/MarGraPet_Review-abstract.html)
- [実装] FAtiMA: 2005年にいじめを扱う serious game (FearNot!) の自律3Dキャラ用に開発。OCC ベースで desirability, desirability-for-others, praiseworthiness 等を計算し、閾値超えで感情生起（例: 正の desirability が joy の閾値超え → joy）。反応層（感情反応規則・行為傾向）と熟慮層（目標指向の手段-目的推論）の2層 — [AAMAS09 Doctoral PDF](https://ifmas.csc.liv.ac.uk/Proceedings/aamas09/pdf/07_Doctoral/Doct_03.pdf); [FAtiMA Modular 2011](https://gaips.inesc-id.pt/component/gaips/publications/showPublication/3/304); [FAtiMA Modular 2014 Springer](https://www.doi.org/10.1007/978-3-319-12973-0_3)
- [実装] FAtiMA Toolkit (AAMAS 2019 demo) は OCC ベースの感情モデルと明示的対話構造を提供するオープンソース — [AAMAS 2019 PDF](https://ifaamas.csc.liv.ac.uk/Proceedings/aamas2019/pdfs/p2357.pdf)
- [実装] GAMYGDALA (Popescu, Broekens & van Someren, IEEE TAC 5(1):32–44, 2014): 開発者が NPC の目標を設定し、ゲーム事象を目標との関係（目標への寄与・確からしさ）でタグ付けすると、OCC に基づいて感情を導出する「ブラックボックス」型エンジン。単純な事象→感情ルックアップと完全な認知評価モデルの中間。効率的で多数 NPC に対応し心理学的に根拠があると主張 — [TU Delft PDF](https://ii.tudelft.nl/~joostb/files/Popescu_Broekens_Someren_2013.pdf); [TU Delft research page](https://research.tudelft.nl/en/publications/gamygdala-an-emotion-engine-for-games)
- [ケーススタディ] Broekens (2015) は JS 版 + Phaser プラグインを公開し2つの実験ゲームを作成（統制評価ではない） — [broekens 2015 PDF](https://ii.tudelft.nl/~joostb/files/broekens_2015.pdf)
- [実装] WASABI (Becker-Asano & Wachsmuth, JAAMAS 20:32–49, 2010): 一次感情を PAD 空間の連続状態として扱い離散感情に分類、二次感情（経験と期待に基づく推論, 例 hope, fears-confirmed, relief）を上乗せ — [Wikipedia](https://en.wikipedia.org/wiki/WASABI_architecture); [AAMAS 2010 PDF](https://cs.uwaterloo.ca/~jhoey/teaching/cs886-affect/papers/WASABIAAMAS2010.pdf)
- [実装] WASABI のダイナミクス: 正/負の valence は別々に追跡、反対 valence は相殺・同 valence は加算、valence は中立まで着実に減衰、valence は時間とともに mood を同方向に押す。mood は「短期の履歴で形作られる拡散的背景状態」 — [Becker-Asano WASABI overview](https://becker-asano.de/index.php/research/wasabi/61-wasabi-architecture-overview); マニュアルでは emotion-mood-boredom の3軸、emotion→mood の傾き (slope) が大きいほど mood が速く反応、バネ定数様の復元力 — [WASABI manual](https://becker-asano.de/index.php/research/wasabi/78-wasabi-manual?start=3)
- [ユーザ研究] WASABI: Skip-Bo カードゲームで、一次感情に加え二次感情をシミュレートすると、プレイヤーは仮想人間 MAX を有意に「年上」と判断 — [Bielefeld record (IVA 2008)](https://pub.uni-bielefeld.de/record/2609667) (N 未確認)
- [ユーザ研究] Skip-Bo + MAX (ACII 2005): エージェントの負の感情が無いことはストレス・苛立ちを生むと受け取られ、共感的フィードバックは MAX を対等な対戦相手として受け入れることを支える — [BPIW05b abstract](https://www.techfak.uni-bielefeld.de/ags/wbski/veroeffentlichungen/abstracts/BPIW05b.html)
- [実装] ALMA (Gebhard, AAMAS 2005, pp.29–36): 感情（短期）・気分（中期）・性格（長期）の3層。OCC ベース評価で生じた感情を PAD 空間に写像。各感情カテゴリは PAD 上の固定点を持ち、強度は時間とともに減少。感情群から気分を推定し、性格（Big Five）が気分の減衰の仕方を定める — [DFKI publication](https://www.dfki.de/web/forschung/projekte-publikationen/publikation/1782); [W3C Emotion XG メール (Schröder 2008)](https://lists.w3.org/Archives/Public/public-xg-emotion/2008Oct/0017.html); [論文 PDF](https://cs.huji.ac.il/course/2005/aisemin/articles2006/docs/pa1a3_29.pdf)
- [実装] ALMA の気分更新は PAD 空間の中心を基準とし、発生中の感情群の重心を影響源とする pull-push 戦略 — [Scribd 2011 Mates 論文](https://es.scribd.com/document/138423808/2011-Mates)
- [ユーザ研究] Gebhard & Kipp (IVA 2006) は、2人以上のキャラクタが対話するテキスト場面で ALMA 生成の感情・気分のもっともらしさを評価し、ALMA は「真正で信じられる」感情と気分を与えると結論 — [Springer](https://www.springerprofessional.de/are-computer-generated-emotions-and-moods-plausible-to-humans/1232988); [DFKI](https://dfki.de/web/forschung/projekte-publikationen/publikation/1784) (N 未確認。検索で出た N=141 は Elliott の別研究であり混同注意 — [Elliott](https://condor.depaul.edu/elliott/ar/papers/aa97.html))
- [立場] ゲーム用の感情エンジンは心理学的に正しい・正当化できる必要はなく、信じられること (believable) が要件、という立場 — [Smith & Carette, Eludamos](https://septentrio.uit.no/index.php/eludamos/article/view/vol10no1-8); 類似の NPC 向けレビュー — [arXiv:2307.10031](https://arxiv.org/pdf/2307.10031)

### Inferences
- 実装上の共通パターン: (1) 事象を目標との関係でタグ付け（GAMYGDALA が最軽量の好例）、(2) OCC 規則で離散感情＋強度、(3) 強度の時間減衰、(4) 感情→次元空間の気分へ蓄積、(5) 性格が既定気分と戻り速度を決める。LLM エージェントでは (1)(2) を LLM の構造化出力に置き換え、(3)〜(5) を決定的コードで持つ構成が自然。
- 評価の多くは「もっともらしさ」「自然さ」等の主観評定で小規模。感情モデルが会話の有用性・満足度を上げるという強い証拠は古典系には乏しい。

### Gaps
- ALMA の減衰関数の正確な式・既定時間、WASABI の boredom 方程式、各ユーザ研究の N は PDF 解析不能で未確認（原典 PDF の URL は上記）。
- EMA/FAtiMA の大規模ユーザ評価は見つからず。

## Q3. 2023–2026 年の LLM エージェントへの評価理論の適用

### Takeaway
主流は「応答生成の前に、記憶と状況から LLM 自身に感情を評価させる中間ステップ（appraisal prompting / chain-of-emotion）」と「生成エージェントへの感情状態（離散ラベルまたは PAD）の付加＋記憶への感情タグ」。証拠は小規模ユーザ研究（N=30）と LLM-as-judge 中心で、効果はモデル依存・混合的。

### Cited Findings
- [ユーザ研究] Chain-of-Emotion (Croissant et al., PLOS ONE 2024; arXiv 2309.05076): 構成はテキスト記憶＋評価プロンプトによる感情生成→対話生成のみ。評価プロンプトは "Briefly describe how Chibitea feels right now given the situation and their personality." で始まり "Chibitea feels:" で終わる。gpt-3.5-turbo, temperature 0。条件 No-Memory / Memory（全ログ）/ Chain-of-Emotion — [PMC 全文](https://pmc.ncbi.nlm.nih.gov/articles/PMC11086867/); [arXiv](https://arxiv.org/pdf/2309.05076)
  - 実験1 (STEU 感情理解テスト42問、人間なし): No-Memory 24 (0.57), Memory 31 (0.74), 評価プロンプト 35 (0.83)、チャンス 0.20。
  - 実験2 (LIWC 内容分析、出力文 22/24/27): Authenticity が条件で有意差 F=5.10, p=.03、Chain-of-Emotion が最高。
  - 実験3 (ユーザ研究 N=30, 女性10, 19–47歳, 被験者内, 失恋ロールプレイ): 「反応が自然」F=3.65, p=.03（CoE 5.71 vs 4.43/4.89）、「他者の感情に敏感」F=3.31, p=.04、他の EI 項目・温かさ・有能さは有意差なし。Tone は CoE が最低（73.0 vs 84.4/80.5, F=12.28, p<.001）。
  - 著者自身の限界: LLM 出力は人間の情動の正確なシミュレーションではない、評価成分のみモデル化、単一モデル (gpt-3.5)、単一シナリオ、短いゲーム、記憶検索なし。
- [シミュレーション] Regan et al. (arXiv:2402.04232, 2024) "Can Generative Agents Predict Emotion?": 新しい出来事の後に関連記憶を要約して「規範 (norm)」を作り、新事象を規範と比較して反応を判断（評価理論に紐付け）、PANAS で情動を測定。文脈付加で整合性が上がる場合もあるが一貫しない（混合的結果）、人間評価との比較が必要と著者 — [arXiv abs](https://arxiv.org/abs/2402.04232)
- [実装/デモ] Humanoid Agents (Wang, Chiu & Chiu, EMNLP 2023 demo): Generative Agents に System 1 要素（基本欲求: fullness, fun, health, social, energy を0–10、感情、関係の親密度）を追加。感情は Ekman 系7種（angry, sad, afraid, surprise, happy, neutral, disgusted）から選択、既定は neutral。各行動後に欲求・感情の変化を評価し計画を更新。ChatGPT-3.5 使用 — [ACL Anthology](https://aclanthology.org/2023.emnlp-demo.15); [arXiv](https://arxiv.org/pdf/2310.05418)（注: 本タスクの「身体状態（疲労）でない」方針とは異なり、欲求ベース）
- [シミュレーション] Sentipolis (arXiv:2601.18027, 2026, CMU): 感情状態を持たない LLM エージェントの問題を "emotional amnesia" と呼び、連続 PAD ベクトル [−1,1]^3、二重速度ダイナミクス（会話ごとの速い更新＋累積 poignancy>150 で起こる reflection 時の遅い更新、LLM が次元ごとの差分を出力）、記憶への PAD 由来感情タグ付けと感情的に関連する記憶の検索。減衰は半減期式 s(t+Δt)=s(t)·2^(−Δt/T½), T½=120分, Δt=20分。EMA を「評価は速く、推論速度は変わる」根拠として引用 — [arXiv HTML](https://arxiv.org/html/2601.18027v1)
  - 評価: 25エージェント×36ステップ（12模擬時間）、6モデル、LLM ジャッジ3種（人間評価者なし）。Continuity が最大改善、Believability は GPT-5.2 で +35–85% だが GPT-4o-mini で −7–26%、Grok-4.1-fast で Empathy −5.6%。アブレーションなし・人間ベースラインなし — [arXiv HTML](https://arxiv.org/html/2601.18027v1)
- [ベンチマーク] 評価を心の理論 (ToM) ベンチマークとして用い、感情ごとの評価評定が理論予測通り分化するかを検証 — [arXiv:2506.00334](https://arxiv.org/pdf/2506.00334)
- [ユーザ側] 長期の「ユーザの」感情履歴を保存・更新・利用する記憶管理（エージェント自身の気分ではない） — [arXiv:2510.27418](https://arxiv.org/pdf/2510.27418)
- [実務/非査読] OSS「Emotion Engine」は LLM が相互作用を判定し、Python ヘルパーが状態の永続化・減衰・ログ・信頼のゆっくりした更新を行う分業 — [Glama](https://glama.ai/mcp/servers/pioneerjeff-labs/emotion-engine)（査読なし、参考程度）

### Inferences
- 証拠が最も直接的なのは Chain-of-Emotion: 「応答前に一文で感情を評価させる」だけで自然さ・感情理解が改善（N=30, 単一シナリオ, 旧モデル）。軽量エージェントの最小構成として妥当。
- ただし Tone が下がる（より負の言語）という副作用がある。「軽い感情」を狙うなら強度の上限・表出の抑制が必要。
- Sentipolis の「LLM が評価・差分を出し、減衰はコード」で持つ分業は、レイテンシ・一貫性の点で軽量設計に適合（LLM 呼び出しは評価時のみ）。ただし人間評価がなく、小型モデルでは逆効果になりうる点に注意。

### Gaps
- 2023–2026 で、評価理論型の LLM 会話エージェントについて人間参加者による大規模・統制された評価は見つからず（Chain-of-Emotion N=30 が最良）。
- 「appraisal-guided prompting」で次元を明示スコア化させる方式の、自由記述方式との比較研究は未発見。

## Q4. 感情 vs 気分: 時間スケール、減衰関数、気分による評価のバイアス、自然に感じる持続時間

### Takeaway
計算モデルでは「感情=事象起因・短命・指数的（または線形）減衰」「気分=感情の蓄積・低速・性格で決まる既定値へ回帰」の2層が標準。人間の感情エピソード持続は感情種で大きく異なり（驚き・嫌悪は短く、悲しみ・喜びは長い）、重要度と反芻が持続を延ばす。「自然な持続」に関するエージェント向けの直接的なユーザ研究は乏しい。

### Cited Findings
- [実装] ALMA: 感情は事象で生起し PAD 上の固定点を持ち強度が時間減衰、気分は感情群から推定され、性格が気分の減衰を規定（既定気分への回帰） — [W3C メール](https://lists.w3.org/Archives/Public/public-xg-emotion/2008Oct/0017.html); [DFKI](https://www.dfki.de/web/forschung/projekte-publikationen/publikation/1782)
- [実装] WASABI: valence は中立まで減衰し、mood を同方向に押す。同 valence は加算・反対 valence は相殺。emotion→mood の傾きで mood の反応速度を調整、バネ様の復元 — [WASABI overview](https://becker-asano.de/index.php/research/wasabi/61-wasabi-architecture-overview); [WASABI manual](https://becker-asano.de/index.php/research/wasabi/78-wasabi-manual?start=3)
- [実装] Sentipolis: 半減期120分の指数減衰（20分刻み）、速い更新（会話ごと）と遅い更新（reflection）の二重速度 — [arXiv:2601.18027](https://arxiv.org/html/2601.18027v1)
- [人間データ] Verduyn & Lavrijsen (2015, Motivation and Emotion) "Which emotions last longest and why": 233名の学生が最近の感情エピソードを想起し持続を報告。27感情中、悲しみが最長（平均約120時間）、喜び約35時間。恥・驚き・恐れ・嫌悪・退屈・感動・苛立ち・安堵は短い部類（恥は約30分）。持続は反芻の多さと事象の重要度に関連 — [KU Leuven PDF](https://ppw.kuleuven.be/okp/_pdf/Verduyn2015WELLA.pdf); [BPS Research Digest](https://www.bps.org.uk/research-digest/why-sadness-lasts-longer-other-emotions); 報道の「240倍」は Daily Mail の誇張で論文の表現ではない — [PsyPost](https://www.psypost.org/sadness-lasts-longer-emotions/)
- [人間データ] 事象処理（反芻・再評価）と感情体験の持続の関係 — [Maastricht CRIS: The Relation Between Event Processing and the Duration of Emotional Experience](https://cris.maastrichtuniversity.nl/en/publications/the-relation-between-event-processing-and-the-duration-of-emotion/)
- [ユーザ研究] 負の感情を一切見せないエージェントはストレス・苛立ちを生むと受け取られた（Skip-Bo/MAX） — [BPIW05b](https://www.techfak.uni-bielefeld.de/ags/wbski/veroeffentlichungen/abstracts/BPIW05b.html)

### Inferences
- 人間の想起ベースの持続（時間〜日単位）は、反芻を伴う「体験」の長さであり、会話エージェントの表出時間とは別物。会話中の「表出」は数ターン〜数分、気分の余韻はセッション内〜数時間程度に収めるのが軽量・無難（推測。直接のユーザ研究なし）。
- 感情種別に減衰速度を変える根拠は Verduyn にある: 驚き・嫌悪は速く、悲しみ・喜びは遅く。また事象の重要度（goal relevance）が高いほど長く持続させる、は評価次元と自然に接続する。
- 気分→評価のバイアス: ALMA/WASABI とも気分が感情強度・解釈に影響する構造（例: 良い気分では正感情が出やすい）を持つ。軽量実装では「気分の valence を desirability 評価のバイアス項や強度係数に加える」程度で十分と推測。

### Gaps
- ALMA の既定減衰時間（気分の回帰時間など）の具体値、気分が感情強度をどう変える式かは原典未確認。
- 会話エージェントで「感情がどのくらい続くと自然か」を直接操作したユーザ研究は見つからず。

## Q5. 「困惑」は感情として扱われるか（認識的感情）、どう評価されるか

### Takeaway
困惑は「認識的感情 (epistemic / knowledge emotion)」として扱われ、評価理論的には「新奇性・複雑性が高く、理解（対処）可能性が低い」ときに生じる（Silvia）。学習研究では impasse（行き詰まり）で生じ、解決すれば没入へ戻り、未解決が続くと苛立ち→退屈へ移るとされるが、この遷移モデルの再現性は部分的。

### Cited Findings
- [理論/ユーザ研究] D'Mello & Graesser (2012, Learning and Instruction) "Dynamics of affective states during complex learning": 没入/フロー中の学習者が impasse に当たると困惑し、問題解決で平衡を回復すれば没入に戻り、できなければ苛立ち、さらに未解決なら退屈へ。時系列分析で confusion–engagement/flow、boredom–frustration、confusion–frustration の振動を確認 — [EdITLib](https://mail.editlib.org/p/110193)
- [批判] 追試では frustration→confusion の遷移はどの研究でも支持されず、frustration→boredom も1研究で不支持。Karumbaiah らは、原著が自己遷移を除外して遷移確率を計算している方法論差を指摘 — [Baker et al. IEEE TAC affect dynamics PDF](https://learninganalytics.upenn.edu/ryanbaker/AffectDyanmics_IEEETAC_CameraReady.pdf); [ecrhub: confusion & frustration nonlinear dynamics](https://ecrhub.org/publications/exploring-confusion-and-frustration-non-linear-dynamical-systems)
- [ユーザ研究] 困惑は学習に有益な場合があるが長引くと苛立ち・離脱に繋がりうる。困惑・苛立ち・学習の関係は研究間で結論が分かれる (Cloude et al., LAK 2024) — [ICCE 論文](https://library.apsce.net/index.php/ICCE/article/download/3551/3427/4515); [ICCE 論文2](https://library.apsce.net/index.php/ICCE/article/download/3622/3498/4586)
- [理論] 困惑 = 興味と同じ新奇性-複雑性評価 + 低い対処可能性（理解できない）。対処可能性 = 出来事に対処するスキル・知識・資源を持つ見積もり — [Audrin & Coppin 2022](https://reference-global.com/article/10.5334/spo.35)
- [ユーザ研究] 認識的感情の研究で、困惑と退屈は比較的負で、低覚醒・低対処可能性・回避と関連 — [Leiden scholarly publication](https://scholarlypublications.universiteitleiden.nl/access/item%3A3716121/view)
- [理論] "Knowledge emotions"（驚き・興味・困惑・畏敬など）を学習・探索・内省を促す感情群として扱う教科書章 — [Knowledge Emotions (Pressbooks)](https://pressbooks.pub/principalsofpsychf24/?p=104)

### Inferences
- 会話エージェントでの困惑の評価式: 「ユーザ発話/事象が予期外 (expectedness 低) かつ、エージェントがそれを解釈・統合できない（comprehensibility 低、矛盾、情報不足）」。驚きとの違いは、驚きは予期外だけで理解可能、困惑は理解できない点。
- 困惑は「解決すれば消える」性質（D'Mello & Graesser）なので、時間減衰より「解消イベント（説明を得た）でリセット」が自然。長引けば軽い苛立ち/諦めへ移すのは任意（再現性は弱い）。
- 困惑の表出は「質問する」という行為傾向と結びつけると、会話上も有用（明確化要求）。

### Gaps
- LLM エージェントの困惑（認識的感情）を評価理論で明示モデル化した研究は見つからず。
- Silvia (2005) 原典本文は未取得（再現研究経由の要約）。
