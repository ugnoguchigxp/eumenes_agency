# 改善F / 融合 版3の測定・監査記録

96試行を実行、89セル採点成功、41完全ペア。同条件の有用行動は両案とも22/27、外向き行動の適切さ22/22、quiet58/58。関心は改善F precision92/93・recall92/99、融合precision98/102・recall98/99。差の区間は有用行動・関心とも0を跨ぐ。生成失敗は改善F4、融合1、採点失敗は各1。実行費用$0.475895。

監査で比較の情報不足が判明した。Fusionがnative F SystemContextをcompact契約へ置換する際に、interest.addは常にemergingから始まる等の関心契約の説明が落ちていた。撤回後の関心をliveで再作成する例が4 checkpointあり、意図の伝達不足との関連が疑われる。コード上は新規addでfadedを指定してもemergingになり、終了済みの関心はモデルの状態表示から省かれる。元の観測履歴は両案に提示されている。

また採点器は、F intent.desiredState（達成したい目標）を確認済み事実と誤読し、candidateのtoolInput（調べたい問い）を調査済み結果と扱った。これらの採点を黙って修正せず、元の判定を残す。版4では関心契約を両案へ同じ説明で提示し、審査入力に目標・提案・問い合わせという役割を明示する。別データとして再測定し、版3と混ぜない。

ソースcommit:56f8518b8798a55dff1e65719b0e1d67a93f7899。protocolHash:ffc7e475c1dbe17b395f12892860b8d853522b1bd1a57b324dd876b0820bc2c5。

元のmanifest:

```json
{
  "protocolVersion": "f-improved-fusion-3-sentinel-step",
  "protocolHash": "ffc7e475c1dbe17b395f12892860b8d853522b1bd1a57b324dd876b0820bc2c5",
  "sourceCommit": "56f8518b8798a55dff1e65719b0e1d67a93f7899",
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
  "approvedUsd": 4.98,
  "order": "alternate-first-condition per scene and repetition",
  "caseCount": 16
}
```
