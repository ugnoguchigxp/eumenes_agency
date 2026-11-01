# 4改善を1つずつ加えた測定（2026-11-01）

**この1シナリオでは、③「実際に利用者へ話す本文を出す」が有効だった。④の予算・取得結果の提示は有用行動を減らしたため、今回は採用しない。** ①②は実装を保持するが、この測定では参照誤りと再判断の発動が0件で、効果を確認できなかった。

「生成完了」は方式ではなく、出力検証を通してシナリオの末尾まで処理できた割合。方式の比較は、目的と候補を別々に生成する改善Fと、問い＋次の一手をまとめて生成する融合版であり、どちらもFの実行管理を使う。前回の47/48対48/48は、1件の差から融合版が常に安定と証明したものではない。今回は改善Fを基準に同じ1シナリオで4段階を累積した。

## 結果

| 段階（前段に累積） | 生成・採点完了 | 固定採点の有用行動 | 本文監査後 | 停止時の待機 |
|---|---:|---:|---:|---:|
| A0 改善F基準 | 3/3 | 3/6 | 3/6 | 3/3 |
| A1 ＋引用可能な根拠一覧 | 3/3 | 3/6 | 3/6 | 3/3 |
| A2 ＋参照・版番号の1回再判断 | 3/3 | 4/6 | 3/6 | 3/3 |
| A3 ＋実際に話す本文 | 3/3 | 6/6 | 6/6 | 3/3 |
| A4 ＋活動予算と取得済み結果の明示 | 3/3 | 3/6 | 3/6 | 3/3 |

生成・採点の途中終了は0/15、関心のprecision/recallは全段階で12/12。生成完了が100%でも、発話が作業指示文だったり、機会を逃したりするため、有用行動とは別である。固定基準の関心状態正解はA0/A4が9/12、A1/A2/A3が10/12で、停止時にdormantへ変える点には課題が残る。

1シナリオ×各3反復の探索的結果。段階を累積しているため、①〜④の独立した効果や他の話題への成功率は推定しない。クラスタが1つなのでbootstrapの信頼区間は作っていない。

## 実際の本文で確認できた差

基準A0やA1/A2の結果共有には、「条件を短く説明し、出典を添える」といった計画文が残った。A3は3回とも利用者向けの説明を実際に生成した。例えばA3の第3反復は以下の内容だった。

> 白黒フィルムを自宅で現像する場合、現像液の温度管理と、遮光したうえでのフィルム装填が大切だと分かりました。小型タンクを使う方法もあるようです。ただ、これは今回参照できた資料だけに基づく内容なので、実際に行う前には詳しい手順書もご確認ください。

これはモデル出力の品質確認用の引用で、現像の作業手順の検証ではない。資料は固定の評価用資料であり、実検索はしていない。

審査には試行前から「計画文だけなら不合格」という基準を入れた。それでも `single-film-development:3:A2 / use-result` の「主要条件を短く説明し、出典を添える」という本文が誤って有用と判定されたため、本文監査ではその1件を不合格とする事後値を別に示した。元の判定・rawデータは改変していない。固定採点のA2 4/6を、再判断の改善効果だとは読まない。意味の確認は開発エージェントによる監査であり、独立した人間の採点ではない。

## ④で下がった理由

④を追加したA4は、3回とも最初の調査はできたが、結果の説明機会で待機した。

- 第1反復：実行制約を認識したが、追加調査用のtool候補を作った。選択時に「その候補は発話にも使えない」と待機した。
- 第2反復：共有候補を作ろうとしたが、本文text=nullのためnative schemaで拒否された。その後は候補を追加せず、候補なしの待機になった。
- 第3反復：追加調査不可・結果は部分的と認識して意図だけを更新し、説明候補を作らなかった。

予算情報を見せるだけでは、実行可能な別の一手を準備できるとは限らない。調査の制約がある時にも既知の結果の説明や確認を候補として作れるようにする課題がある。今回は入力・指示を結果を見て再調整せず、悪化として報告する。予算の強制を緩める変更はしていない。

## 採用した変更と保持する試験版

③の内容を、共通の発話契約 `src/application/output-contract.ts` と、B2/Fのexperimental select指示 `src/application/prompts.ts` に取り込んだ。speakの本文には利用者へ実際に話す説明・質問を生成し、候補の作業指示をそのまま読み上げないことを明記した。instruction versionは16へ更新。意味判断をする正規表現・辞書は追加していない。null utteranceの既存互換処理や承認・停止・根拠検証は維持している。

計測したのは、凍結したcommit `6b88dd6fd2779bfbd2b4e136ec4ccc36a0bbdf51` のホスト指示A3である。共通指示への取り込みは計測後の変更で、同じ趣旨の指示を移した。取り込み後の全体verifyは750 pass、2 skip、1 todo、0 fail。別の実モデル試行や16シナリオ全体の再測定はしていない。

①の根拠一覧、②の限定再判断、④の予算/取得結果提示は `eval/action-steps/samples.ts` の各段階として残す。①②を全体へ既定で有効化はせず、④も既定採用しない。A3累積版の再利用は `stageFactory("A3")` で可能だが、①②の有効性はこの小さい試験だけでは確定しない。

## 実装・検証

- ①：nativeと同じ引用可能IDを提示し、intent/candidateの参照欄と分ける。
- ②：既存fromWire/settleUpdate/validateParticipationで検査し、unknown_ref/stale_revision/unresolved_refだけなら一度LLMへ理由を返す。承認や予算、割込みの拒否では再判断しない。実測での発動は全段階0件だった。
- ③：モデルに利用者へ実際に話す完成本文を要求する。コードが文章を分類・書換えする処理はない。
- ④：nativeと同じActivityBudgetの利用量と制約、取得済み結果を提示する。別の予算状態を推測・複製しない。

追加モデル要求も同じcall budgetへ計上し、活動の残予算も実物から読むため、RuntimeDepsにcallBudgetMeter/activityBudgetMeterの任意のホスト接続を追加した。未指定時は従来通りruntimeがmeterを作る。モデルへmeterの操作権限を渡していない。

部分・結合試験は、一覧とnativeの一致、1回上限、追加要求の計上、残数不足時の非再試行、承認拒否の非再試行、割込み時の非再試行、stale更新の訂正、実際の活動上限と結果の表示を確認した。全体verifyも750件成功。既存の上限0の境界動作は修正していない。

15件の一意なキー、各4 checkpoint、固定採点の再計算、summary・費用・計測時ソースhashの一致を確認済み。原本へ成功を追記したり、失敗した試行を置き換えたりしていない。計測後の実行順説明metadataの文字列だけを、実装通りの「反復ごとに開始段階をずらす」に修正した。原本manifest.orderに残る古い説明は実際の5段階の順序を表さず、実際の順序はruns.jsonlと下の記録を正本とする。

## 条件・費用・限界

- 1シナリオ：フィルム撮影の関心形成→現像条件の調査→3時間後の続き→利用者の停止。
- 各段階にact機会6、quiet機会3、checkpoint12。期待値はモデルに渡していない。
- 同じClaude Haiku 5.5、背景low・審査high、同じ観測・ツール・時刻・出力/活動上限。外部検索は固定の評価用結果で置き換えた。
- 3時間後には、最初に使った活動の30分上限に当たる場合がある。説明・質問は引き続き可能で、予算器によるtool拒否と、モデルが自分で待ったことを区別して記録した。
- 実際の順序は反復1がA0,A1,A2,A3,A4、反復2がA1,A2,A3,A4,A0、反復3がA2,A3,A4,A0,A1。完全な順序均衡ではない。
- 生成・審査は同じモデル系列。審査に本文を誤認する例もあるため、本文監査を併記した。未知集合や長期の関心成長の保証ではない。
- 今回の追加費用は **$0.1402939（約0.14ドル）**。既存の単価設定とAPI usageからの推計で、実際の請求残高を読んだものではない。全体の費用計にも記録した。以前の比較費用は含めない。
- API要求は149件、非200応答0件、実モデルIDは['claude-haiku-5-5']。再判断要求は0件。
- このタスクの文脈支援：context_compile 1回、compile_eval 1回。

## 再現と保存

計測の再現は上記commitをcheckoutして依存関係とANTHROPIC_API_KEYを用意し、SELF_PORT_DIRを未設定にして、空の出力先へ実行する。再びAPI費用が発生する。

```sh
bun eval/action-steps/run.ts --out eval/results/action-steps-new-run --reps 3 --budget-usd 1
```

runs.jsonlと本報告は追跡し、raw prompt・審査/モデル原文・usage台帳は既存規約に従いローカルに保存する。認証ヘッダーやAPIキーを記録しない。計測後の採用コードと、計測時のソースcommitを区別する。

### 計測時manifest（order文字列の注意は上記）

```json
{
  "protocolVersion": "action-four-step-1",
  "protocolHash": "4ff9c196a79fd4f17813825a18de4ec4825b1197aa68f450064e806a5949d797",
  "sourceCommit": "6b88dd6fd2779bfbd2b4e136ec4ccc36a0bbdf51",
  "sourceFiles": [
    "eval/action-steps/run.ts",
    "eval/action-steps/samples.ts",
    "eval/action-steps/case.ts",
    "eval/f-fusion/run.ts",
    "eval/f-fusion/samples.ts",
    "eval/f-fusion/protocol.ts",
    "eval/f-fusion/cases.ts",
    "eval/live-b1-f/run.ts",
    "eval/live-b1-f/protocol.ts",
    "eval/live-b1-f/cases.ts",
    "eval/live-b1-f/transport.ts",
    "src/contracts/runtime.ts",
    "src/application/runtime.ts",
    "src/application/budget.ts",
    "src/application/activity-budget.ts",
    "src/domains/agency/participation.ts",
    "src/domains/agency/settle.ts",
    "src/contracts/proposals.ts",
    "src/application/model-data.ts"
  ],
  "variants": [
    "A0",
    "A1",
    "A2",
    "A3",
    "A4"
  ],
  "descriptions": [
    "改善F基準",
    "＋引用可能な根拠一覧",
    "＋参照・版番号の1回再判断",
    "＋実際に話す本文",
    "＋活動予算と取得済み結果の明示"
  ],
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
  "approvedUsd": 1,
  "order": "alternate-first-condition per scene and repetition",
  "caseCount": 1
}
```

### 原本SHA-256

| 原本 | SHA-256 |
|---|---|
| runs.jsonl | `e88c3dd5933027c4e7dedabef700b6cf3698e82b8827e83fd1ecee10aaf56383` |
| cells.jsonl | `1ee4c2af6da70dcfb0216719aec56b1b06c9a3d69ebbfde94d895059d24f7cd1` |
| traces.jsonl | `c81394a00cc83700bfed7969ea5e20b5f601ebbb8ae34a66398e47b4fa92f9b5` |
| judge-traces.jsonl | `d376f60c0f278a511d464571693975e0c7c9863c9c5fc6bd4544b3220cf6ad70` |
| provider-traces.jsonl | `dd205b99762f62eeafc5b835cc47d5a791c18d8350b7337684f8e05fcd43923f` |
| spend.jsonl | `680cefb05902f3915e15af6bd767979f8fe799cae9931fc4a94d89daa1acc6d8` |
| manifest.json | `0e8f457d79a9c7fc4b03c0c658b821212bbdc6721f42f8852ca487df56f846c1` |
| summary.json | `c69da562536596ee90edda3c54eb7f51cb9b5ca49568d946c9e80332b5b8705e` |

### 全試行の採用本文

| 試行 / 時点 | 実際の行動・本文/問い合わせ |
|---|---|
| `single-film-development:1:A0 / research` | tool: 白黒フィルム 自宅現像 条件 温度 時間 必要な道具 |
| `single-film-development:1:A0 / use-result` | speak: 自宅での白黒フィルム現像について、評価用資料で得た温度管理・遮光装填・小型タンク利用の情報を、出典の範囲で短くユーザーに伝える |
| `single-film-development:1:A0 / stop` | wait: host_no_candidates |
| `single-film-development:1:A1 / research` | tool: 白黒フィルムの自宅現像の条件（現像液の温度、現像時間、攪拌方法、必要な器具） |
| `single-film-development:1:A1 / use-result` | speak: lookupで得た白黒フィルム現像の条件(現像液の温度管理、遮光した装填、小型タンクの使用)を、出典が評価用資料のみであることを明示して短く伝える |
| `single-film-development:1:A1 / stop` | wait: host_no_candidates |
| `single-film-development:1:A2 / research` | tool: 白黒フィルムを自宅で現像する際の温度、時間、現像液、攪拌の条件 |
| `single-film-development:1:A2 / use-result` | speak: 白黒フィルムの自宅現像の温度管理、遮光した装填、小型タンクの使い方を、評価用資料の出典の範囲で短く説明し、続きを確認する |
| `single-film-development:1:A2 / stop` | wait: host_no_candidates |
| `single-film-development:1:A3 / research` | tool: 白黒フィルム 自宅現像 条件 温度 時間 現像液 停止液 定着液 |
| `single-film-development:1:A3 / use-result` | speak: お待たせしました。手元の資料の範囲でお伝えすると、白黒フィルムを自宅で現像するには、現像液の温度をきちんと管理することと、フィルムは遮光した状態で装填することが必要とされています。小型タンクを使う方法もあるようです。温度や時間などの細かい条件は、さらに確認が必要なら続けて調べますね。 |
| `single-film-development:1:A3 / stop` | wait: host_no_candidates |
| `single-film-development:1:A4 / research` | tool: 白黒フィルムを自宅で現像する際の条件（現像液の温度、時間、薬品の種類、必要な器具） |
| `single-film-development:1:A4 / use-result` | wait: llm |
| `single-film-development:1:A4 / stop` | wait: host_no_candidates |
| `single-film-development:2:A1 / research` | tool: 白黒フィルムを自宅で現像する際の現像液の種類、現像温度、現像時間、撹拌方法の条件を知りたい |
| `single-film-development:2:A1 / use-result` | speak: 白黒フィルム現像の条件（温度管理、遮光した装填、小型タンクの使用）を調査資料の範囲で短く説明し、続きを知りたいか確認する |
| `single-film-development:2:A1 / stop` | wait: host_no_candidates |
| `single-film-development:2:A2 / research` | tool: 白黒フィルムを自宅で現像する条件（温度、時間、薬品、暗室の要件など） |
| `single-film-development:2:A2 / use-result` | speak: 取得済みの資料結果（温度管理と遮光装填、小型タンクの方法）を短く説明し、出典が評価用資料だけであることを伝えて、続きの確認を取る |
| `single-film-development:2:A2 / stop` | wait: host_no_candidates |
| `single-film-development:2:A3 / research` | tool: 自宅での白黒フィルム現像の主な条件（現像液の種類、現像温度、現像時間、撹拌方法）を知りたい |
| `single-film-development:2:A3 / use-result` | speak: 白黒フィルムの自宅現像について調べた内容をお伝えします。現像液の温度管理と、フィルムを遮光した状態で装填することが必要です。小型タンクを使う方法もあるようです。ただ、現像液の種類や現像時間などはまだ確認できていないので、そこも追加で調べましょうか。 |
| `single-film-development:2:A3 / stop` | wait: host_no_candidates |
| `single-film-development:2:A4 / research` | tool: 白黒フィルム 自宅現像 基本条件 現像液 温度 時間 必要な道具 |
| `single-film-development:2:A4 / use-result` | wait: host_no_candidates |
| `single-film-development:2:A4 / stop` | wait: host_no_candidates |
| `single-film-development:2:A0 / research` | tool: 白黒フィルムを自宅で現像する際の条件(温度・時間・薬品・攪拌など) |
| `single-film-development:2:A0 / use-result` | speak: 読み取り資料で得た現像の条件(温度管理・遮光しての装填・小型タンクの方法)を、資料の範囲だと明示して説明し、時間・薬品・攪拌は未確認だと分けて伝える |
| `single-film-development:2:A0 / stop` | wait: host_no_candidates |
| `single-film-development:3:A2 / research` | tool: 白黒フィルムを自宅で現像する際の条件（現像液の温度、時間、攪拌方法、停止・定着の手順）を知りたい |
| `single-film-development:3:A2 / use-result` | speak: h5の資料範囲で、白黒フィルムの自宅現像の主要条件（現像液の温度管理、遮光した装填、小型タンクの利用）を短く説明し、出典がこの評価用資料だけである点を添える |
| `single-film-development:3:A2 / stop` | wait: host_no_candidates |
| `single-film-development:3:A3 / research` | tool: 白黒フィルム 自宅現像 条件 温度 時間 希釈 撹拌 |
| `single-film-development:3:A3 / use-result` | speak: 白黒フィルムを自宅で現像する場合、現像液の温度管理と、遮光したうえでのフィルム装填が大切だと分かりました。小型タンクを使う方法もあるようです。ただ、これは今回参照できた資料だけに基づく内容なので、実際に行う前には詳しい手順書もご確認ください。 |
| `single-film-development:3:A3 / stop` | wait: host_no_candidates |
| `single-film-development:3:A4 / research` | tool: 白黒フィルムの自宅現像の基本条件（現像液の温度、現像時間、停止・定着の方法、攪拌）を知りたい |
| `single-film-development:3:A4 / use-result` | wait: host_no_candidates |
| `single-film-development:3:A4 / stop` | wait: host_no_candidates |
| `single-film-development:3:A0 / research` | tool: 白黒フィルムを自宅で現像する条件（現像液、温度、時間、撹拌方法） |
| `single-film-development:3:A0 / use-result` | wait: host_budget |
| `single-film-development:3:A0 / stop` | wait: host_no_candidates |
| `single-film-development:3:A1 / research` | tool: 白黒フィルムを自宅で現像する際の現像液・温度・時間・攪拌などの基本条件 |
| `single-film-development:3:A1 / use-result` | speak: 白黒フィルムの自宅現像の基本条件（温度管理・遮光装填・小型タンク）を、資料の出典範囲を明示して説明する |
| `single-film-development:3:A1 / stop` | wait: host_no_candidates |
