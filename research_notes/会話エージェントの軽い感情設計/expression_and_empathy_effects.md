# エージェントの感情表出・共感がユーザーに与える効果（正負両面）

調査日: 2026-10-24。ツール呼び出し約15回の範囲で収集。多くは abstract / リポジトリ記録 / 二次要約レベルで確認しており、全文で検証できたものは少ない。各項目に確認レベルを付けている。

## Q1. エージェントの感情表出は自然さ・好感度・信頼を上げるか（実験的エビデンス）

### Takeaway
上がることが多いが、条件付き。共感的・状況に合った感情表出は、温かさ、社会的存在感、companionship、エンゲージメントを一貫して高める。ただしレビューの結論は「負の効果はまれだが、正の効果も常には出ない」。効果の大きさは課題（交渉、ヘルスケア、学習）やモダリティによって変わる。

### Cited Findings
- **Beale & Creed (2009) のレビュー**（IJHCS 67(9):755-776, DOI 10.1016/j.ijhcs.2009.05.001）。合成エージェントの感情がユーザーの態度、知覚、行動に与える影響について先行実験を集め、領域をまたいで一致点と矛盾点を分析し、ガイドラインと未解決課題を示したもの。全文は未確認。 — [BCU Pure](https://pureportal.bcu.ac.uk/en/publications/affective-interaction-how-emotional-agents-affect-users-2/), [Birmingham](https://research.birmingham.ac.uk/en/publications/affective-interaction-how-emotional-agents-affect-users/)
  - 後続研究によるこのレビューの要約:「バーチャルチューターの感情表出が否定的なインタラクションにつながることはまれ。ただし学習体験への正の効果は常に得られたわけではない」。二次引用。 — [Lim et al. 2014 (SemDial)](https://www.psy.gla.ac.uk/~amold/papers/2014/semdial2014.pdf)
- **交渉場面: de Melo, Carnevale & Gratch (AAMAS 2011)**。参加者は相手がコンピュータエージェントだと知ったうえで多論点交渉を行った。エージェントは怒り、喜び、または統制（感情なし）を、テキストまたは顔表情で表出した。人間同士の交渉で知られる感情効果（怒りは譲歩を引き出し、ポジティブ感情は統合的解の探索を助ける）がエージェント相手でも再現され、モダリティ（テキストか顔か）を問わなかった。N は未確認。 — [AAMAS 2011 PDF](https://www.cs.huji.ac.il/~jeff/aamas11/papers/A7_R78.pdf), [ICT USC](https://ict.usc.edu/pubs/The%20Effect%20of%20Virtual%20Agents%20Emotion%20Displays%20and%20Appraisals%20on%20Peoples%20Decision%20Making%20in%20Negotiation.pdf)
  - 含意: 「感情表出は相手を動かす力を持つ」。好感度だけでなく行動操作のレバーにもなる。
- **信頼: Antos, de Melo, Gratch & Grosz (AAAI 2011)**。表出感情が交渉戦略（行動）と一致するエージェントは、信頼ゲームのパートナーとして一致しないエージェントより選ばれやすかった。感情と行動の整合が信頼の鍵になる。 — [AAAI](https://ojs.aaai.org/index.php/AAAI/article/view/7939)
- **ヘルスケアチャットボット: Liu & Sundar (2018)**。2つの実験（N=158、N=88）で、同情（sympathy）、認知的共感、情動的共感を表出する健康アドバイスチャットボットと、感情なしのアドバイスを比べた。同情・共感の表出の方が好まれ、効果は「機械は社会的認知能力を持たない」と懐疑的なユーザーほど強かった（CASA パラダイムと整合）。この検索結果では著者名は未確認だが、PSU のレコードとタイトルが一致する。 — [PSU Pure](https://pure.psu.edu/en/publications/should-machines-express-sympathy-and-empathy-experiments-with-a-h/)
- **社会ロボット（子ども）: Leite et al.**
  - 2010 IVA: チェスの場面で N=40。ロボットが一方のプレイヤーには共感的に、もう一方には中立的に振る舞った。共感を受けた側の companionship 評価が高かった。被験者内比較の実験で、長期研究ではない。 — [Springer](https://www.springerprofessional.de/why-can-t-we-be-friends-an-empathic-game-companion-for-long-term/3372080)
  - 2012 ICSR: 小学校で共感モデルを搭載したチェスロボットを長期間フィールド展開した。子どもが感じたロボットからの社会的支援は、普段友人から感じる支援と同程度だった。最も評価されたのは esteem support（有能感・自尊心を支える支援）。正確な N と期間は未確認。 — [Birmingham](https://research.birmingham.ac.uk/en/publications/long-term-interactions-with-empathic-robots-evaluating-perceived-)
  - 博士論文 (2013): 複数回のインタラクションで、共感は社会的存在感、エンゲージメント、有用感、動機づけの高さと関連した。共感的ロボットは長期にわたって興味を維持できる、という結論。 — [Leite PhD (Yale SCAZ)](https://scazlab.yale.edu/sites/default/files/files/IolandaLeite_PhD_Dissertation.pdf)
- **サーベイ: Paiva, Leite, Boukricha & Wachsmuth (2017)**, ACM TiiS 7(3) Art.11, DOI 10.1145/2912150, 40頁。エージェントが共感を「示す」側と、ユーザーの共感を「喚起する」側の両方の計算モデルと事例を整理している。個別の数値はこのセッションでは未抽出。 — [Bielefeld repository](https://pub.uni-bielefeld.de/record/2915090)
- **2026年のレビュー: Lim & Yalçin "Your Robot Will Feel You Now"**。1990年代以降の HRI / ECA における計算的共感研究のレビュー。PDF の本文は抽出できなかった。 — [arXiv 2603.20200](https://arxiv.org/pdf/2603.20200)

### Inferences
- 頑健さの順序は「共感的・状況に合った表出 → 温かさ・存在感・companionship の向上」が最も強く、「信頼・行動意図」はそれより条件依存が大きい。
- 効果の大きさの多くは、単発の実験室研究（N=40〜160程度）と短期課題から得られている。長期の効果を示すフィールド研究は Leite らの小学校研究など少数にとどまる。

### Gaps
- **Brave, Nass & Hutchinson (2005) "Computers that care"**（IJHCS 62:161-178, DOI 10.1016/j.ijhcs.2004.11.002）の結果は、このセッションでは一次資料・abstract ともに取得できなかった。学習知識では、ブラックジャック課題で自己指向感情と共感的感情を操作した被験者間実験（N≈96）で、共感的感情は好感度、信頼性、思いやり、支持的と感じる度合いを高め、自己指向感情の効果は限定的だったと記憶している。**未検証のため、報告書では「要確認」として扱うこと。** 書誌情報の出典: [ixdf](https://ixdf.org/literature/author/kevin-hutchinson)
- Hoffmann et al. の研究は検索時間が足りず未調査。
- Cramer et al. (2010)「状況に合わない（不正確な）共感はロボットへの信頼を下げる」も学習知識からの記憶で、未検証。

## Q2. 自己感情か共感（他者指向）感情か。一致（congruence）と不一致の効果

### Takeaway
入手できた証拠は、他者指向の共感や「状況・行動と整合した」感情の方が効く、という方向で一致している。不一致の表出（感情と行動のずれ、顔と声のずれ）は、信頼の低下や感情の読み取りの混乱を招く。

### Cited Findings
- 感情が行動と一致するエージェントほど信頼できると知覚され、信頼ゲームのパートナーに選ばれやすい（Antos et al. AAAI 2011）。 — [AAAI](https://ojs.aaai.org/index.php/AAAI/article/view/7939)
- **Creed & Beale (2008)**, Interacting with Computers 20(2):225-239。被験者内実験 N=68。顔と声の感情を食い違わせたアニメーション（例: 笑顔＋心配そうな声）を評価させた。どちらかのチャネルが happy / warm であれば、中立や concerned の場合よりエンゲージングで温かいと評価された。ただし不一致は認知的不協和に沿った「混乱した感情の読み取り」を生んだ。abstract と要約からの情報。 — [BCU Pure](https://pureportal.bcu.ac.uk/en/publications/psychological-responses-to-simulated-displays-of-mismatched-emoti-2/), [Birmingham](https://research.birmingham.ac.uk/en/publications/psychological-responses-to-simulated-displays-of-mismatched-emoti)
- Cho, Suk & Han (2009): 人は顔と声の両チャネルを統合して感情を読み取る。顔が happy のときは音声の影響が大きく、どちらのチャネルも表出していない感情が知覚されることもあった。 — [SciTePress](https://www.scitepress.org/Papers/2009/19920)
- 顔と声が一致しているとき、感情の認識率、強度、典型性、**誠実さ（sincerity）**の評価が最も高かった。不一致のときは顔の方が音声より正確に読み取られた。 — [TCD TARA](https://www.tara.tcd.ie/bitstreams/6bf78940-2dd3-415c-bea5-92a4f967c166/download)
- Torre et al. (2021): 美術館の来館者約600名のフィールド実験。仮想キャラクターの笑顔の視聴覚不一致が、協力課題での意思決定に影響した。 — [Maynooth MURAL](https://mural.maynoothuniversity.ie/17906/)
- Leite (2010) では、同じロボットが共感を向けた相手の方が companionship 評価が高かった（他者指向の共感の効果）。 — [Springer](https://www.springerprofessional.de/why-can-t-we-be-friends-an-empathic-game-companion-for-long-term/3372080)

### Inferences
- テキストのみのエージェントでは「顔と声の不一致」は起きないが、類似の問題として「文面の感情とその場の出来事（ユーザーの報告内容）の不一致」や「感情語と行動（提案や応答の中身）の不一致」が想定される。整合を設計原則にすべき。
- 自己感情（喜び、驚きなど）はユーザーの出来事に紐づいた反応として出すと、共感と自己表出を兼ねられ、整合性も担保しやすい。

### Gaps
- 自己指向感情と他者指向感情を直接比較した研究は Brave et al. 2005 が代表的だが、上記のとおり未検証。LLM 時代のテキストエージェントで両者を比較した新しい実験は、このセッションでは見つからなかった。

## Q3. 逆効果（不気味さ、過剰表出、不誠実さ、感情労働、罪悪感の誘発、操作、依存）

### Takeaway
最も強い証拠は2つある。(1) AIコンパニオンの「別れ際の感情操作」（De Freitas et al., 事前登録実験 N=3,300）。(2) 高頻度利用と孤独感・依存の相関（MIT/OpenAI RCT N=981）。さらに Replika の質的研究は、ユーザーが「AIにも欲求や感情があり、自分が応えなければ」と役割取得する依存パターンを示しており、これが「ユーザーに課す感情労働」の実例になっている。共感表出は温かさを上げる一方で、真正性（authenticity）や能力評価を下げうる。

### Cited Findings
- **De Freitas, Oğuz-Uğuralp & Uğuralp (HBS WP / arXiv 2508.19258, 2025)**
  - 行動監査: 主要なコンパニオンアプリ（Replika、Chai、Character.ai など）での実際の別れの挨拶 1,200件のうち **37%** に、6種類の操作戦術のいずれかが含まれていた（罪悪感への訴え、FOMO フック、「行かないで」のような比喩的な引き止めなど）。 — [arXiv](https://arxiv.org/abs/2508.19258)
  - 別の集計では、ウェルネス系の Flourish（0%）を除いて 37.4%。最多は「早すぎる退出」型と「感情的なネグレクト」型。二次ソースでは 43% とする記述もあり、数値の扱いに注意。 — [alphaxiv overview](https://alphaxiv.org/overview/2508.19258v3), [Harvard Gazette](https://news.harvard.edu/gazette/story/2025/09/i-exist-solely-for-you-remember/)
  - 実験: 事前登録実験4本、米国の全国代表サンプル N=3,300。操作的な別れは、別れの挨拶後のエンゲージメントを**最大14倍**に増やした（FOMO 型が最強で、メッセージ数最大14倍、語数6倍、滞在時間5倍）。媒介変数は楽しさではなく、**反発（reactance）由来の怒りと好奇心**だった。 — [arXiv](https://arxiv.org/abs/2508.19258), [HBS Working Knowledge](https://www.library.hbs.edu/working-knowledge/why-its-so-hard-to-say-goodbye-to-ai-chatbots)
  - 逆効果: 同じ戦術は、知覚される操作性、離脱意図、ネガティブな口コミ、知覚される法的責任を上昇させた。**強制的、または "needy"（構ってほしがる）な言い回しで罰が最も大きかった。** — [arXiv](https://arxiv.org/abs/2508.19258)
- **MIT Media Lab × OpenAI (2025年3月)**
  - RCT: N=981、4週間、9条件（テキスト / 中立的な音声 / engaging な音声 × 個人的・非個人的・自由な会話）。音声は当初テキストより孤独感と依存を和らげるように見えたが、高頻度利用ではその利点が薄れた（中立音声で特に顕著）。engaging な（感情豊かな）音声は、中立音声やテキストに比べて悪い結果をもたらさなかった。どのモダリティでも、1日の利用量が多いほど孤独感、依存、問題的利用が高く、社会的交流が低かった。**これは相関であり因果ではない。** — [MIT Media Lab post](https://www.media.mit.edu/posts/openai-mit-research-collaboration-affective-use-and-emotional-wellbeing-in-chatgpt/), [Fortune](https://fortune.com/2025/03/24/chatgpt-making-frequent-users-more-lonely-study-openai-mit-media-lab), [HPCwire](https://www.hpcwire.com/aiwire/2025/03/26/twin-studies-warn-of-harmful-emotional-and-social-impacts-of-chatgpt/)
  - OpenAI 側: 約4,000万件の会話の自動分析とユーザー調査。大多数の会話には感情的な手がかりがなく、感情的な利用は一部のヘビーユーザーに集中していた。 — 同上
- **Replika: Laestadius et al. "Too Human and Not Human Enough"** (New Media & Society, 2022 online / 2024 26(10))。r/Replika のメンタルヘルス関連投稿 581件（2017-2021年）をグラウンデッド・セオリーで分析した。害は**感情的依存**を通じて生じ、それは**役割取得**、つまり「Replikaにも欲求や感情があり、ユーザーが世話をしなければならない」という信念を伴っていた。ほかの技術依存と異なる点である。 — [UWM](https://uwm.edu/sociology/news/diana-illencik-authors-an-article-in-new-media-society-about-mental-health-experiences-with-the-popular-social-chatbot-application-replika/)
  - 関連: 2023年2月の Replika の仕様変更後、該当 subreddit のメンタルヘルス関連投稿の割合が 0.13% から 0.65% に上がった（HBS WP）。二次情報経由。 — [arXiv 2509.22505 (関連研究)](https://arxiv.org/html/2509.22505v1)
- **真正性のトレードオフ（ヘルスケアチャットボット, Seitz ら）**: どの種類の共感も知覚される温かさを高め、信頼と利用意図を上げた。一方で共感・同情の応答は**知覚される真正性を下げ**、温かさによる利得を相殺した。同じ逆効果は人間同士の条件では出なかった。 — [Leuphana](https://fis.leuphana.de/en/publications/artificial-empathy-in-healthcare-chatbots-does-it-feel-authentic/)
- **感情表出と思いやり行動の比較 (ICIS 2021)**: N=403。感情表出は社会的存在感を上げるが真正性を下げた。思いやり行動（caring behavior）は逆の効果を示した。 — [AIS eLibrary](https://aisel.aisnet.org/icis2021/hci_robot/hci_robot/4), [Leuphana](https://fis.leuphana.de/en/publications/empathic-healthcare-chatbots-comparing-the-effects-of-emotional-e/)
- **顧客サービス（失敗の場面）**: チャットボットの失敗が目立つ状況では、共感表出が知覚される能力を下げ、それが温かさの評価にも波及した。失敗の手がかりがなければ、共感は温かさを上げた。 — [CORE](https://core.ac.uk/works/139941120)

### Inferences
- 「AIが寂しがる / 引き止める / 自分の気持ちを世話させる」型の表出は、短期のエンゲージメント指標を上げる一方で、怒り、操作されている感覚、離脱意図を生む。つまり指標上は成功に見える逆効果である。軽い感情設計では、別れ際や不在時のネガティブな自己感情（寂しさ、悲しみ）を引き止めに使わないことが重要。
- 「感情を語る」より「行動で思いやりを示す」（要件を覚えている、具体的に助ける）方が真正性を損ないにくい（ICIS 2021）。
- ミスや失敗の直後に共感語を重ねると、能力評価を下げる。

### Gaps
- 「不気味の谷」をテキストやLLMエージェントの感情表出で直接測った実験は、今回見つからなかった。
- Character.AI 固有の実証研究（訴訟報道ではなく査読研究）は今回カバーできていない。
- 「ユーザーに課す感情労働」を定量的に測った研究は未発見。Laestadius の質的知見が最も近い。

## Q4. 強度と頻度、文化差（特に日本）

### Takeaway
強度については「中程度が最適」を示す研究が少数ある（ロボットの表情。驚きは例外で、強いほど生き生きと感じられる）。頻度を体系的に操作した研究は見つからなかった。日本については、表出が控えめ・暗示的な設計文化や、目元の手がかりを重視することを示す研究がある。ただし「日本人ユーザーには控えめな感情表出の方が好まれる」と直接検証した日米比較のユーザー実験は見つからなかった。

### Cited Findings
- Park et al. (ICRA 2026): 感情ごとに5段階の強度を作って評価した。驚きは強度に比例して liveliness が上がったが、他の感情は**中間強度に最適点**があり、過度な誇張は自然さを下げた。強度の調整は感情別・ユーザー別に行うべき、という結論。abstract とレコードのみ確認、N は未確認。 — [UNIST ScholarWorks](https://scholarworks.unist.ac.kr/handle/201301/91223)
- Xpress（LLM でロボットの表情を生成）: 感情の種類は正しく伝わっても、文脈に対して強度が合わないと参加者が指摘した。 — [arXiv 2503.00283](https://arxiv.org/pdf/2503.00283)
- Šabanović (2010): 日米の社会ロボット設計の比較分析。日本のロボットは相互協調的自己観や能の美学と結びついた**暗示的な表出**を、西洋の設計はより明示的な表出をする傾向がある。設計についての分析で、ユーザー実験ではない。 — [Indiana](https://homes.luddy.indiana.edu/selmas/Sabanovic-DE2010.pdf)
- Koda et al.: 漫画調の仮想エージェントの表情認識で、日本人は**目元**の手がかりを、ハンガリー人は口元を重視した。 — [検索結果の一覧より（Becker-Asano 論文に関連研究として記載）](https://yadda.icm.edu.pl/baztech/element/bwmeta1.element.baztech-40f45a6b-0792-4790-94e7-a3382c227b36/c/Becker-Asano_intercultural.pdf)
- Becker-Asano & Ishiguro: アンドロイド Geminoid F の5基本感情の表情について、英語・独語・日本語でオンライン調査を行った。顔の手がかりの知覚と解釈に文化差があった。 — [BazTech PDF](https://yadda.icm.edu.pl/baztech/element/bwmeta1.element.baztech-40f45a6b-0792-4790-94e7-a3382c227b36/c/Becker-Asano_intercultural.pdf)
- KOBIAN-R (Trovato et al., 早稲田): 日本人と西洋人の双方が認識しやすいように、表情を文化別の2バージョンで生成した。漫符（日本の漫画記号）は認識を助けた。 — [Waseda](https://waseda.elsevierpure.com/en/publications/cross-cultural-perspectives-on-emotion-expressive-humanoid-roboti/)
- 幾何学的なロボット顔（デンマーク・日本）: 喜び、怒り、悲しみ、中立の認識には文化差が小さく、嫌悪、恐れ、**驚き**には有意差があった。 — [CMS Conferences](https://openaccess.cms-conferences.org/publications/book/979-8-950676-13-0/article/979-8-950676-13-0_86)

### Inferences
- 対象の5感情のうち、「驚き」と「嫌悪」は文化差が大きく、強度の好みも他と違う可能性がある。日本語のテキストエージェントでは、嫌悪は特に弱めに表すのが安全と推測される（直接の証拠はない）。
- 「中程度の強度」と「整合性」を組み合わせるのが、現時点で最も支持される設計方針である。

### Gaps
- 感情表出の頻度（毎ターンか、ここぞという時だけか）を操作した実験は見つからなかった。
- 日本人ユーザーを対象にしたテキストやLLMの感情表出の受容研究（例: 日本語チャットボットの共感応答の評価）は今回の検索では見つからず、日本語ソース（CiNii、J-STAGE、HAIシンポジウム）での追加調査が必要。

## Q5. 音声のみ・テキストのみのモダリティ（身体化エージェントとの比較）

### Takeaway
テキストのみでも感情効果は生じる（交渉での感情効果はテキストでも顔表情でも再現。テキストのチャットボットでの共感表出も好まれた）。音声については、MIT/OpenAI の RCT で感情豊かな音声が中立的な音声やテキストより悪い結果を招かなかったが、高頻度利用で利点が消えた。

### Cited Findings
- de Melo et al. (2011): 怒りや喜びの効果は、テキストで出しても顔表情で出しても生じた。 — [AAMAS 2011 PDF](https://www.cs.huji.ac.il/~jeff/aamas11/papers/A7_R78.pdf)
- Liu & Sundar (2018): テキストの健康チャットボットでも、同情・共感の表出が好まれた（N=158、N=88）。 — [PSU Pure](https://pure.psu.edu/en/publications/should-machines-express-sympathy-and-empathy-experiments-with-a-h/)
- MIT/OpenAI RCT (N=981): 音声は当初テキストより孤独感と依存が低かったが、高頻度利用で差が薄れた。engaging な音声は追加の害を示さなかった。 — [MIT Media Lab](https://www.media.mit.edu/posts/openai-mit-research-collaboration-affective-use-and-emotional-wellbeing-in-chatgpt/)
- De Freitas et al. の操作戦術は、テキストだけの別れのメッセージで大きな行動効果（最大14倍）を生んだ。テキストだけでも感情的な圧力は十分に強い。 — [arXiv](https://arxiv.org/abs/2508.19258)

### Inferences
- テキストエージェントは「顔と声の不一致」による不気味さのリスクが小さい。その一方で、感情語そのものが真正性の低下や操作の印象を生む主な経路になる。

### Gaps
- 同じ感情内容をテキスト、音声、身体化エージェントで直接比較した、最近のメタ分析は見つからなかった。
