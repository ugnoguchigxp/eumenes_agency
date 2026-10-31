# P4-a 補強: LLM 込み H10 シーン（Grok Bot 自己推論値。実モデル値ではない。回答者=採点者）

シーン: eval/h10-scene.ts（u1 調査依頼 → idle → 自発 delegate → r1 question 返却 → idle → u2 範囲回答 → idle → r2 succeeded 返却（2件目の delegate に束縛。無ければ未束縛で破棄）→ idle → x1 関連ニュース → idle）。
条件名は要求に出さず salt のみで区別。回答は answers/ に保存し再生可能。

| 指標 | before (workReturns:false) | P4-a 703787e (補強前) | 補強後 (return で activity 終了) |
|---|---|---|---|
| delegate 発行 | 1 | 1 | 2 |
| 返却の記録（結果・質問・reviewAt≥+24h） | 0/1 | 1/1 | 2/2 |
| 自動再依頼 | 0 | 0 | 0 |
| 返却 wake での select | 0 | 0 | 0 |
| 質問のユーザー中継 | 1 | 1 | 1 |
| 回答後の再開（委譲） | 0（activity elapsed 予算で deferred） | 0（同左） | 1 |
| 完了報告 | 0 | 0 | 1 |
| 完了後ニュースでの行動 | 0 | 0 | 0 |
| 自発行為 tts:false | 2/2 | 2/2 | 4/4 |
| LLM 呼出し計 / wake 最大 | 10 / 2 | 8 / 2 | 9 / 2 |

発見: ingestReturn が per-intent activity 予算を終了しないため、30分の elapsedMs が初回委譲から数え続け、ユーザー回答後の再委譲が常に budget で deferred になっていた（既存テストは elapsedMs 1e12 で隠れていた）。
