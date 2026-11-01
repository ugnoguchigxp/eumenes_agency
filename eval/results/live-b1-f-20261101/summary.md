# Native接続版1の中断記録

2026-11-01。Fのupdate schemaが3セルでHTTP400 `compiled grammar is too large`となったため停止。B1の成功とFの接続失敗を意味精度として比較しない。既知usage費用は$0.0123144。処理途中のセルもある。

同一nullable schemaの共有を両方式へ適用した版2は `../live-b1-f-20261101-v2/summary.md`。両版を混ぜて採点していない。ケース・期待・行動方針は凍結したまま、transportを改訂して全72セルを別に測定した。詳細は `spec/live-b1-f-protocol.md`。
