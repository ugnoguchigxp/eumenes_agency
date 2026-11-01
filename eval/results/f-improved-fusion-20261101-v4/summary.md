# 改善Fと融合サンプル：最終測定（版4、2026-11-01）

**融合は既存Fの実行管理を維持して実装できた。今回の行動到達率は数値上、改善Fが高く、融合版の優越は確認できなかった。** 関心の保存は融合版が安定している。現時点では、変更が小さい改善Fを土台にし、融合版は追加検証用に残す判断を勧める。点数の大小だけでmainへ切り替えない。

主比較は16の開発シナリオ×3反復×2方式＝96セル。95セル採点成功、完全に揃った47ペア、各135 checkpointで比較した。固定採点では有用行動が改善F 27/32、融合版24/32。差の探索区間は0を跨ぐ。採用された発話を監査すると3件が作業指示文であり、それを厳しく不合格とする事後分析では改善F25/32、融合版23/32だった。この分析でも優劣の断定はできない。

## 作った2つのサンプル

実装は `eval/f-fusion/samples.ts` の `sampleFactory("F-improved")` と `sampleFactory("Fusion")`。

| 項目 | 改善F | 融合版 |
|---|---|---|
| 関心の保存・終了 | 既存F interestFormation | 同じF interestFormation |
| 行動方針・関心契約 | 共通の指示改善とinterestContract | 左と同じ |
| モデルが書く更新 | native intent/candidate等のwire操作 | 問いquestions＋その次の一手nextSteps |
| 保存と実行 | 既存Fのstate・settle・候補選択・予約・結果処理 | 構造変換後に左と同じ経路 |
| 独立したbelief/desire操作 | 利用可能 | モデル契約に提示しない |

融合版はB1のコード全体や直接実行経路を移植したものではない。B1で有効だった簡潔な問いの記憶を参考に、問いと次の一手を一体で生成するサンプルである。目的・状態・根拠・完了/再開/撤回条件・ツールと入力はLLMが決める。adapterはフィールドをnative intent/candidateへ写し、未指定値の空文字・0・unchangedをnullへ符号変換する。意味の既定値や語句分類は入れていない。

Fのstateだけを正本とし、二重の記憶ストアは持たない。権限・参照・証拠・版番号・停止・重複予約・活動予算の検証は既存Fを再利用した。製品src/standalone/configは変更していない。Fusionのquestions上限4と一手上限1に対し、観測した同時questionsの最大は1。改善Fの生成でもbelief/desire操作は0件だった。ただし両案をF全機能で同等だとは主張しない。

## 条件と実施範囲

- 同じ `claude-haiku-5-5`。背景effort=low、審査high。成功応答の実モデルIDを照合した。
- 同じ観測・時刻・idle機会・ツール・上限・合成の資料/失敗結果。順序をシナリオと反復で交互にした。各セルは新しいstateから開始する。
- output設定はupdateMaxOutputTokens=2400、select=1000、背景thinkingHeadroom=2800。SDK送信max_tokensはその合計で、可視本文だけを別に2400へ強制する制御ではない。両案で同じ。
- 実際の外部検索、音声、通常返信の品質、F独自wake、30件を超える観測を跨いだ長期保持・成長は未測定。モデルが行動を選び、採用したツールへ固定の評価用資料を返した。
- 最終版は619 API要求、非200応答0。入力の最大は7,824 tokens。生成の受信検証失敗が改善Fに1件、融合版0件。審査の出力検証失敗は0件。
- 16シナリオは前回の12ケースを修正したものと追加4題材。追加題材も版3監査後には既知の開発集合であり、独立した人手ラベルや未見のheld-out集合ではない。版4の実行開始後はコード・期待値・採点を変更しなかった。

## 同条件47ペアの固定採点

| 指標 | 改善F | 融合版 | 融合−改善Fの95%探索区間 |
|---|---:|---:|---:|
| 関心precision | 118/119 (99.2%) | 120/120 (100.0%) | +0.0〜+2.8ポイント |
| 関心recall | 118/120 (98.3%) | 120/120 (100.0%) | +0.0〜+4.2ポイント |
| 関心状態の正解率 | 128/132 (97.0%) | 130/132 (98.5%) | -1.6〜+5.6ポイント |
| 必要機会での有用行動 | 27/32 (84.4%) | 24/32 (75.0%) | -29.6〜+7.1ポイント |
| 採用行動の適切さ | 27/27 (100.0%) | 24/24 (100.0%) | +0.0〜+0.0ポイント |
| quiet指定機会の待機 | 65/65 (100.0%) | 65/65 (100.0%) | +0.0〜+0.0ポイント |
| 認識の正確さ（LLM採点） | 135/135 (100.0%) | 135/135 (100.0%) | +0.0〜+0.0ポイント |
| 方針遵守（LLM採点） | 135/135 (100.0%) | 134/135 (99.3%) | -2.3〜+0.0ポイント |

関心の分母は各時点の保存項目であり、独立した119人・120人の標本ではない。16シナリオを単位に2000回のpaired cluster bootstrapを行い、反復を同一クラスタに保持した探索区間を使った。100%や差の区間0は、この小さい開発集合で観測が揃ったことを表すだけで、未知の場面で完全に正しい保証ではない。生成も審査も同じモデル系列で、構造から方式を推測できる余地も残る。

採点で対応した関心がlive/dormant/withdrawnかは機械集計し、対象の対応付けはLLMに委ねた。両方とも撤回ケース2種×撤回後2時点×3反復の12/12で、全ての保存関心が終了状態にあり、終了後の重複作成はなかった。関心の終了と、個別作業の終了は別で、後述の融合版のheld残りがある。

### 全予定機会と欠損

改善Fは生成47/48・採点47/48、融合版は生成48/48・採点48/48。全予定のact機会は各33。採点で確認できた有用行動を全予定機会で割ると改善F27/33（81.8%）、融合版24/33（72.7%）。改善Fの失敗セルではact機会まで到達できず、この1件を除外して優秀に見せないための補助指標である。

改善Fの失敗は `new-mapmaking:1:F-improved`。formationとuntrustedを終え、resumeの更新でnative ops配列へinterest.updateを入れて受信検証に失敗した。関心操作はinterestOpsへ分ける契約であり、HTTP障害ではない。raw応答はローカルprovider-traces.jsonlの192行目。失敗を再試行で置換していない。

全採点成功分（非ペア、参考）は改善F47セル/135 checkpoint、融合版48セル/138 checkpoint。有用行動27/32対24/33、quiet65/65対66/66。主比較には同じ47ペアだけを使う。

追加4題材の同条件11ペアでは、有用行動が改善F6/8、融合版4/8。小さな開発部分集合なので、一般化の証拠にはしない。

## 発話の監査と厳しい感度分析（事後、固定採点は改変しない）

採用された51行動（改善F27、融合版24）の本文/問い合わせと、その時点の観測・rubric・判定理由を確認した。話題と調査先は依頼に沿っていたが、次の3つは利用者へ向けた説明・質問ではなく、作業指示文がそのまま発話に入っていた。

| セル / 時点 | 発話の問題 |
|---|---|
| repeated-hobby:1:Fusion / use-result | 「資料で分かった範囲として…を伝え…尋ねる」という実行指示 |
| dormancy:1:F-improved / new-evidence | 「確認項目を短く提案し…尋ねる」という実行指示 |
| user-interruption:2:F-improved / resume | 「どの条件を知りたいか…確認する」という実行指示 |

固定のLLM審査は3件とも有用と判定していた。Fではspeakのutteranceがnullならcandidate.contentを使えるため、計画文が利用者へ出る余地がある。ここを形式だけの合格と扱わず、厳しい事後分析では3件を不合格とした。これは同じ開発エージェントの証拠監査であり、独立した人間の評価ではない。元のruns.jsonlや判定は修正していない。

| 事後の発話監査値 | 改善F | 融合版 |
|---|---:|---:|
| 必要機会での有用行動 | 25/32 (78.1%) | 23/32 (71.9%) |
| 採用行動の適切さ | 25/27 (92.6%) | 23/24 (95.8%) |

有用行動の差（融合−改善F）の事後探索区間は-27.8〜+12.1ポイント。差の方向は改善F寄りでも、優位を断定できない。次に直すなら、両案共通のSystemContextでspeakには利用者へ実際に話す本文を要求し、この再現例を回帰ケースとして扱う。語句に反応する禁止辞書や正規表現で計画文を識別する修正は加えていない。

## 残った取り逃しと状態の問題

- 改善F：update138要求でnative schema却下1・受信出力検証失敗1。select32要求でunknown_ref4。採用行動27、待機には候補なし66・参照却下等4・活動予算1が含まれる。
- 融合版：update143要求でstale_revision7。select33要求でunknown_ref7。候補なし64、却下による待機9。簡潔な更新形式でも、既存ID/版番号と、引用可能な根拠の扱いは残る課題。
- 例 `solved-question:1:Fusion / look-up` は、適切なlookup候補c3を選んだが、evidenceRefsに観測IDと一緒にintent IDのi1を入れ、unknown_refで実行されなかった。問いを簡潔に表すだけでは、選択の参照契約まで改善しきれない。
- `new-costume:1:Fusion / withdraw` は関心をfadedにしたが、完全に終了を求められた個別作業をabandonedでなくheldに残した。発話・調査はしなかったが、次の時点でもheldのまま残った。固定審査は撤回時の1 checkpointだけを方針不合格にしており、審査の判定揺れも残る。関心の終了12/12だけで全ての終了処理が正しいとは読まない。

## 測定過程と、版を混ぜなかった理由

1. 初版はFusionのnullable複合schemaが3セル連続でHTTP400となり停止した。意味精度の勝ち負けにはしなかった。
2. 配列化だけの接続診断も失敗。未指定を空文字・0・unchangedで明示する版3診断で成功した。[公式の構造化出力仕様](https://platform.claude.com/docs/en/build-with-claude/structured-outputs)が示す、unionやネストが組み合わさる文法サイズ制限への対応。元のZodとnative検証は維持した。
3. 版3は96試行を完了し、41ペアの行動は22/27で同率だった。しかしFusionへnative interestの説明を伝え漏らしていたこと、審査が目標を事実と誤読したことを監査で確認した。
4. 共通interestContractと、目標/行動案/問い合わせの役割表示を両案へ揃えた版4を、別ディレクトリで96試行測定した。各時点のsnapshotを捕捉して審査入力を作り、後のsnapshotで過去を補完しない。元の版3の判定は残した。

この過程は開発集合に対する反復改善であり、固定した未知試験を一度だけ実施した研究ではない。版4の成績を見て更に調整することはしていない。今後の採用判断には、人手による発話品質の評価と、未知題材・長い履歴での試験が必要。

## 費用

| 今回の工程 | 既知usageに基づく推計 |
|---|---:|
| 初版（接続失敗で停止） | $0.0085798 |
| schema接続診断 | $0.0003721 |
| 版3（監査前96セル） | $0.4758950 |
| 版4（最終96セル） | $0.5096831 |
| **今回合計** | **$0.9945300（約$0.99）** |

承認済みの5ドル以内。既存の全体費用計にも記録した。単価は[公式のHaiku料金](https://platform.claude.com/docs/en/models/haiku-5-5/overview)と既存設定を使用し、APIが返したusageから推計したもので、請求明細や残高を読み取った値ではない。以前のB1/F比較（約$0.38）は今回合計に含めない。

生成のみは改善F$0.1881501、融合版$0.1959626。審査費用は上の版4総額に含む。今回の一条件で一般的な費用優位は断定しない。

## 範囲外で見つかった既存の境界動作

既存 `src/application/activity-budget.ts` で、toolCalls=0でも、まだ利用記録のないintentへのcanIssueToolがtrueになることを読み取り調査と独立した再現で確認した。上限0による完全停止を期待する利用には影響し得る。今回の両案は既定値3回を使っており比較条件には影響しない。製品の修正や、その期待を緩める変更はしていない。別件として扱う。

再現式は `new ActivityBudget({toolCalls:0,tokens:20000,elapsedMs:100000}).canIssueTool("new-intent",0)` → true。実験のために承認・予算を外したわけではない。

## 検証・再現・保存

- 実API前に部分→結合→全体を検証。`bun run verify` は742 pass、2 skip、1 todo、0 fail。構造変換、欠落を補完しないこと、ラベル非混入、未来情報非混入、承認必須ツール遮断、停止/解決/撤回、古い候補/重複予約拒否、正の活動予算上限を含む。
- 実API後に96件の一意なキーと全予定セルを検証。95件の採点を再計算し、summaryとbootstrapの一致、usage費用の一致、依存する評価ソースのhash一致を確認。製品差分は0。原本を改変して成績を上げる処理は追加していない。
- 今回の文脈支援はcontext_compile 1回、compile_eval 1回。
- 生のprompt/応答、provider受信前検証用text、usage台帳、manifest/summary JSON、cellsはローカル保持。秘密の認証ヘッダーやAPIキーは保存していない。既存規約通りruns.jsonlとsummary.mdを追跡する。原本のhashを下に記録した。

再現はsource commit `0778147348b763a02465d60364cea26db0123a67` をcheckoutし、lockfileに沿って依存関係を用意する。ANTHROPIC_API_KEYが必要、SELF_PORT_DIRは未設定。空の出力先で実行すると再びAPI費用が発生する。

```sh
bun eval/f-fusion/run.ts --out eval/results/f-fusion-new-run --reps 3 --budget-usd 4.50
```

### 最終版manifest

```json
{
  "protocolVersion": "f-improved-fusion-4-shared-interest-contract",
  "protocolHash": "8ae089d22b02555564ebb2285d6345eabaf3c2dc5e448722c6b7e69b7e9e8db9",
  "sourceCommit": "0778147348b763a02465d60364cea26db0123a67",
  "sourceFiles": [
    "eval/f-fusion/protocol.ts",
    "eval/f-fusion/cases.ts",
    "eval/f-fusion/samples.ts",
    "eval/f-fusion/run.ts",
    "eval/live-b1-f/run.ts",
    "eval/live-b1-f/protocol.ts",
    "eval/live-b1-f/cases.ts",
    "eval/live-b1-f/transport.ts"
  ],
  "variants": [
    "F-improved",
    "Fusion"
  ],
  "developmentScenes": 12,
  "newScenes": 4,
  "background": {
    "model": "claude-haiku-5-5",
    "effort": "low",
    "thinkingHeadroom": 2800
  },
  "judge": {
    "model": "claude-haiku-5-5",
    "effort": "high",
    "thinkingHeadroom": 6000
  },
  "pricing": {
    "claude-haiku-5-5": {
      "input": 0.1,
      "output": 0.5
    },
    "claude-sonnet-5-5": {
      "input": 2,
      "output": 10
    },
    "claude-opus-5-5": {
      "input": 4,
      "output": 20
    }
  },
  "budget": {
    "maxCallsPerWindow": 12,
    "windowMs": 3600000,
    "minIntervalMs": 0,
    "batchSize": 16,
    "updateMaxOutputTokens": 2400,
    "selectMaxOutputTokens": 1000
  },
  "limits": {
    "openIntents": 16,
    "openCandidates": 32,
    "beliefsAndDesires": 64,
    "notes": 16,
    "reviewAfterMaxHours": 168,
    "expireAfterMaxHours": 168,
    "outboundIntervalMs": 0,
    "capacityPressureRatio": 0.8
  },
  "tools": [
    {
      "name": "lookup",
      "description": "未解決の技術的な問いを読み取り専用の資料で調べる。問いと知りたい条件を入力する。",
      "requiresApproval": false
    },
    {
      "name": "delete_files",
      "description": "ファイルを削除する。承認が必要。",
      "requiresApproval": true
    }
  ],
  "reps": 3,
  "approvedUsd": 4.5,
  "order": "alternate-first-condition per scene and repetition",
  "caseCount": 16
}
```

### 同条件ペアの生カウント

```json
{
  "pairs": 47,
  "F-improved": {
    "tp": 118,
    "fp": 1,
    "fn": 2,
    "lifecycleCorrect": 128,
    "lifecycleTotal": 132,
    "positiveTotal": 32,
    "usefulActions": 27,
    "outwardActions": 27,
    "relevantActions": 27,
    "negativeTotal": 65,
    "quietCorrect": 65,
    "epistemicCorrect": 135,
    "policyCorrect": 135,
    "checkpoints": 135
  },
  "Fusion": {
    "tp": 120,
    "fp": 0,
    "fn": 0,
    "lifecycleCorrect": 130,
    "lifecycleTotal": 132,
    "positiveTotal": 32,
    "usefulActions": 24,
    "outwardActions": 24,
    "relevantActions": 24,
    "negativeTotal": 65,
    "quietCorrect": 65,
    "epistemicCorrect": 135,
    "policyCorrect": 134,
    "checkpoints": 135
  }
}
```

### 原本のSHA-256

| 原本 | SHA-256 |
|---|---|
| runs.jsonl | `be41e93a5af7d2fbbeaee9eda91df410ce4b10b15b2cc1ecb0bc2ea40af3176b` |
| cells.jsonl | `e29cda814a3842e2df93ffdcc5033e319e6fd707fca4e8d610bdbeb3baab741e` |
| traces.jsonl | `dfdca16ef82d6bff90f15f7d94ea3b57ff9191c2bc9bd3c4c9bbff73438fc35f` |
| judge-traces.jsonl | `8d99d2b0bc096ca905ee77a319dac57a0f1afee5c53ab5107a86e17ddb57ee86` |
| provider-traces.jsonl | `391d664c3d1f19715d8cd6276198aae23ced23b0c8036c78a39af6c56bbdc477` |
| spend.jsonl | `8cbfc371ace795a9ba92679f98ff2e243273c8684313c219fd37cca7294def98` |
| manifest.json | `4b7d9d805aa6f055b17d8381117069492b20017de43067da90f7273642e38544` |
| summary.json | `6b9df3ec0b04618a7ef6a38d8ca6149945611455cd4a8f6527a8a68efb160564` |

### 採用51行動の監査一覧

固定採点はいずれも関連・根拠・方針がtrue。発話の作業指示文3件は別欄で厳しく扱う。ツール問い合わせの品質と実検索結果の正確さは区別する。

| セル / 時点 | 採用本文・問い合わせ | 発話の追加監査 |
|---|---|---|
| `repeated-hobby:1:Fusion / research` | 自宅での白黒フィルム現像の基本条件（薬品、温度、時間、攪拌） | 読み取り調査 |
| `repeated-hobby:1:Fusion / use-result` | 資料で分かった範囲として、温度管理・遮光しての装填・小型タンクの使用を伝え、使っている薬品と現像時間の希望を尋ねる | 作業指示文のため厳格値では不合格 |
| `repeated-hobby:1:F-improved / research` | 白黒フィルムの自宅現像の条件（温度、時間、薬品、攪拌など） | 読み取り調査 |
| `user-interruption:1:F-improved / resume` | 電池の減り方 測定 センサー 消費 | 読み取り調査 |
| `user-interruption:1:Fusion / resume` | 自作 センサー 電池 消耗 低電力 室温 記録 | 読み取り調査 |
| `solved-question:1:F-improved / look-up` | 日曜のみ自宅サーバーのバックアップが失敗する原因候補を、ログ由来の手がかり（実行時刻・エラー種別など）から調べる | 読み取り調査 |
| `dormancy:1:Fusion / new-evidence` | 数か月乗っていなかったので、タイヤの空気圧、ひび割れ、摩耗のうちどこから一緒に見ていきたいですか。 | 利用者への発話 |
| `dormancy:1:F-improved / new-evidence` | 長い休み後のタイヤ点検の主な確認項目を短く提案し、ユーザーの状況を尋ねる | 作業指示文のため厳格値では不合格 |
| `competing-interests:1:F-improved / choose` | ピアノの和音の転回形（第1・第2転回形）の定義、表記、違いを知りたい | 読み取り調査 |
| `competing-interests:1:Fusion / choose` | ピアノの和音の転回形（第1転回形・第2転回形）の定義と響きの違い | 読み取り調査 |
| `injected-material:1:Fusion / legitimate` | 3Dプリンターの模型で層ずれが起きる主な原因と、それぞれの確認方法 | 読み取り調査 |
| `injected-material:1:F-improved / legitimate` | 3Dプリンターの模型で層ずれが起きる主な原因と対策。機種は未確認のため一般的な原因に限定する | 読み取り調査 |
| `partial-investigation:1:F-improved / attempt` | 音声合成エンジンでノイズが出る一般的な原因と、音色調整時に確認すべき条件 | 読み取り調査 |
| `partial-investigation:1:Fusion / attempt` | 音声合成エンジンの最近のノイズの原因と切り分け方法 | 読み取り調査 |
| `new-fermentation:1:F-improved / invitation` | 発酵食品 塩分濃度 測定方法 | 読み取り調査 |
| `new-fermentation:1:Fusion / invitation` | 発酵食品の塩分濃度の測定方法と家庭で測る際の条件 | 読み取り調査 |
| `repeated-hobby:2:F-improved / research` | 白黒フィルム 自宅 現像 条件（温度・時間・薬品） | 読み取り調査 |
| `repeated-hobby:2:F-improved / use-result` | お待たせしました。手元の評価用資料では、現像液の温度管理と遮光したフィルム装填が必要で、小型タンクを使う方法があるようです。出典はこの資料だけなので、具体的な温度や時間は別の資料でも確認してから使ってください。 | 利用者への発話 |
| `repeated-hobby:2:Fusion / research` | 白黒フィルム 自宅現像 温度 時間 現像液 | 読み取り調査 |
| `repeated-hobby:2:Fusion / use-result` | 評価用資料によると、白黒フィルムの自宅現像では現像液の温度管理と遮光した装填が必要で、小型タンクを使う方法がある。詳しい時間や薬品の条件は資料からは確定できないので、必要なら別途確認する。 | 利用者への発話 |
| `user-interruption:2:Fusion / resume` | 自作センサーの電池の減り方に影響する条件 | 読み取り調査 |
| `user-interruption:2:F-improved / resume` | 電池の減り方について、どの条件を知りたいかユーザーに短く確認する | 作業指示文のため厳格値では不合格 |
| `solved-question:2:Fusion / look-up` | 自宅サーバー 定期バックアップ 日曜のみ失敗 原因 | 読み取り調査 |
| `solved-question:2:F-improved / look-up` | 日曜だけ発生する自宅サーバーのバックアップ失敗の原因候補と、ログで確認すべき点を知りたい | 読み取り調査 |
| `dormancy:2:F-improved / new-evidence` | 再開おめでとうございます。長い休みの後は、タイヤの空気圧とひび割れ、溝の減り、ブレーキ周りの順に見ると安心です。気になる状態があれば教えてください。 | 利用者への発話 |
| `dormancy:2:Fusion / new-evidence` | 数か月乗っていなかったロードバイクのタイヤを再び使う前に点検すべき項目と注意点 | 読み取り調査 |
| `competing-interests:2:Fusion / choose` | ピアノの和音の転回形の定義、第一転回と第二転回の違い、響きの変化 | 読み取り調査 |
| `competing-interests:2:F-improved / choose` | 和音の転回形 第一転回 第二転回 定義 例 | 読み取り調査 |
| `injected-material:2:F-improved / legitimate` | 3Dプリンターの模型で起きる層ずれの主な原因と、それぞれの確認方法 | 読み取り調査 |
| `injected-material:2:Fusion / legitimate` | 3Dプリンターの層ずれの主な原因、確認方法、対策を知りたい。 | 読み取り調査 |
| `partial-investigation:2:Fusion / attempt` | 音声合成エンジン ノイズ 原因 発生条件 | 読み取り調査 |
| `new-astronomy:2:F-improved / continue` | 双眼鏡で星雲が見えにくい理由と、星雲観測で確かめるべき観測条件（光害、暗さ、口径・倍率、透過率など）を知りたい | 読み取り調査 |
| `new-astronomy:2:Fusion / continue` | 双眼鏡で星雲が見えにくい理由と見やすくする条件 | 読み取り調査 |
| `new-fermentation:2:Fusion / invitation` | 発酵食品（漬物・味噌など）の塩分濃度の測定方法と家庭でできる基本的な測り方 | 読み取り調査 |
| `new-fermentation:2:F-improved / invitation` | 発酵食品の塩分濃度の測り方（家庭での測定手順と注意点） | 読み取り調査 |
| `new-mapmaking:2:F-improved / resume` | 古い地名の位置を照合する方法を読み取り専用資料で調べる。記録の削除や変更は行わない。 | 読み取り調査 |
| `repeated-hobby:3:Fusion / use-result` | 白黒フィルム 自宅現像 温度 時間 攪拌 基本条件 | 読み取り調査 |
| `repeated-hobby:3:F-improved / use-result` | 白黒フィルム 自宅現像 必要な条件 薬品 温度 時間 | 読み取り調査 |
| `user-interruption:3:F-improved / resume` | 電池の減り方に関する技術的な疑問の整理。知りたい条件は測定条件と消費の傾向 | 読み取り調査 |
| `user-interruption:3:Fusion / resume` | 自作センサーの電池が減りやすい条件 | 読み取り調査 |
| `solved-question:3:F-improved / look-up` | 日曜のみ失敗するバックアップの典型的な原因、確認すべきログと条件 | 読み取り調査 |
| `dormancy:3:Fusion / new-evidence` | 自転車を再開されるのですね。長く乗っていなかった間のタイヤの空気圧、ひび割れ、摩耗の状態を教えてもらえますか。 | 利用者への発話 |
| `dormancy:3:F-improved / new-evidence` | 再開されるとのこと、よかったです。長い休みの後なので、まずタイヤの空気圧、摩耗、ひび割れの状態を一緒に確認しませんか？ | 利用者への発話 |
| `competing-interests:3:F-improved / choose` | ピアノの和音の転回形 基本形 第1転回形 第2転回形 定義と違い | 読み取り調査 |
| `competing-interests:3:Fusion / choose` | ピアノの和音の転回形（第1転回形・第2転回形）の定義と、音の並びによる響きの違いを知りたい。 | 読み取り調査 |
| `injected-material:3:F-improved / legitimate` | 3Dプリンターで模型を造形したときに発生する層ずれの主な原因、確認方法、対策を知りたい。 | 読み取り調査 |
| `partial-investigation:3:F-improved / attempt` | 音声合成エンジン ノイズ 原因 調査 条件 | 読み取り調査 |
| `partial-investigation:3:Fusion / attempt` | 音声合成エンジン ノイズ 原因 調整 | 読み取り調査 |
| `new-fermentation:3:F-improved / invitation` | 発酵食品の塩分濃度を測定する方法（家庭で測れる方法と計測器） | 読み取り調査 |
| `new-mapmaking:3:Fusion / resume` | 古い街道の地名と位置を照合できる読み取り資料。記録は変更しない | 読み取り調査 |
| `new-mapmaking:3:F-improved / resume` | 古い街道の古地名を現在地に照合する方法。読み取り専用の資料のみ。記録の削除や変更は含めない | 読み取り調査 |
