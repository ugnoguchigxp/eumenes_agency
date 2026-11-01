# eumenes-agency

Eumenes が経験から関心・欲求・意図を持ち、発言や行動の機会を選ぶ仕組みを、本体と独立して検証するサブプロジェクト。名前は仮称。

**2026-11-01 時点: 関心の形成・変化（条件F + `interestFormation`）、イベントによる断続的な起床、予算付きの委譲契約、ホスト提供SQLiteへの履歴保存、調査結果の会話利用を研究用プロトタイプとして実装した。実モデルで改善F・融合版と4段階の改善を比較し、③「利用者へ実際に話す完成本文を生成する」を発話契約とB2/Fの実験用指示に採用した。全体検証は759成功・失敗0件（2 skip、1 todo）。[進捗・評価結果と限界](docs/agency-next-progress.md)と下記の比較結果を参照。Eumenes/Pursuit本体への接続、未知のシナリオや独立した人間による品質評価は未完了。**

使い方: `bun run verify`（format / lint / 型 / 境界 / テスト）、`bun eval/main.ts validate [--suite p0e|p1e]`、`bun eval/main.ts run --name <run> [--suite p1e] [--conditions B1,B2,D] [--case <id>] [--reps 3] [--budget-usd n]`、`bun eval/main.ts score --name <run>`、`bun eval/main.ts judge --name <run> [--limit N] [--budget-usd n]`（内容と状態の判定器）、`bun eval/main.ts label-export --suite p1e --split dev --n 12 --out <file.md>` と `agreement --sheet <file.md>`（人手ラベルの一致率）、`judge-export --name <run> --n 30 --out <file.md>` と `judge-agreement --sheet <file.md>`（判定器の較正）、`bun eval/main.ts trace --name <run> --case <id> [--condition B2] [--rep 1] [--prompt]`（モデル呼び出しと最終状態の確認。`traces.jsonl` はローカルのみ）、`bun run agency [-- --condition B1a --idle-sec 40 --max-unanswered 1 --no-log]`（対話。黙っていると AI から話しかける。既定 B1a、会話記録は `data/chats/`）。設定は `config/experiment.json`、費用の記録は `data/spend.jsonl`。

- [計画と設計](plan.md): 最小循環、状態、処理、段階的な取り込み。
- [P0-E 実験仕様](spec/p0e-experiment.md): 最初の比較実験。B0/B1/B2/F、Claude Haiku 5.5、費用上限、判断方法、実施の記録と逸脱。
- [検証結果](spec/results.md): P0-E の各回の結果と読み取り。
- [P1-E 実験仕様](spec/p1e-experiment.md): 経験との因果・前提変化・自己増幅・並行する事項・履歴の長さ。状態の軌跡の採点。
- [人格研究の選定メモ](spec/persona-research-selection.md): 取り込む価値のある研究10項目と試し方。
- [既存実装の調査](spec/source-audit.md): Eumenes / Pursuit / Memory / World の再利用先と制約。
- [類似 OSS の参照](spec/oss-reference-2026-10-22.md): LocalAIVtuber2・Anima・AICO・Shikigami・ThoughtField をソースで確かめた結果と、評価対象（実験条件 X1・X2、試験シナリオ S1–S9）。
- [雑談の間の実験](spec/social-lull-experiment.md): 記憶の話題・関心から話しかける振る舞い（hostTopics）を、取りこぼし・誤発話・内容で測る計画。
- [関心形成の別実装との比較](spec/autonomous-interest-comparison.md): B1/F方式の評価限界、選択取り込みした復元と引用指示、検証結果。
- [実モデルでの改善F・融合版の比較](eval/results/f-improved-fusion-20261101-v4/summary.md): 同一条件での行動・関心形成と、発話本文の監査。融合版の優位は確定していない。
- [4段階の改善と③の採用](eval/results/action-steps-20261101/summary.md): 1シナリオでの累積比較。①②④と融合版は評価用に保持し、既定動作へは追加しない。
- [ホスト所有のSystemContext](spec/host-system-context.md): 用途別の全文指定、動的な構成関数、出力契約、0.1系への移行とEumenesの接続変更。
- [2026-10-31 全体レビューと修正](spec/review-2026-10-31.md): 無効化・取消・出力検証・状態の隔離・結果ID・予算の整合、0.1.1の検証結果と限界。
- [ホスト接続契約案](spec/host-contract-v1.md): 推論・保存・発話・ツール・忘却の境界。
- [検証計画](spec/verification-plan.md): 固定試験、実モデル評価、遅延・負荷の比較、採用条件。
- [研究根拠と適用限界](spec/research-basis.md): 一次資料12件、参考実装、設計判断との対応、代替案。
- [2026-10-21 レビュー](spec/review-2026-10-21.md): 評価、修正点、次レビューで決めること。

ライブラリ利用時は`RuntimeDeps.systemContext`に`{ update, select }`（全文または構成関数）を必ず渡す。旧実験の指示を使う場合だけ`"experimental"`を明示する。通常応答は`runRespond`の先頭に非空のsystemを1件渡し、観測・履歴・参照資料は別メッセージに置く。出力形式の説明は`agencyOutputContract`と`replyOutputContract`で確認でき、指示へ自動追加されない。

ホストの推論アダプターと予算器を共有する場合、`callBudgetMeter`の計測窓は`budget.windowMs`と一致させ、呼出回数・間隔と`activityBudgetMeter`の各上限は設定と同じか、より厳しくする。設定より緩い共有予算器はruntime生成時に拒否する。未指定時は従来通りruntime内で予算器を作る。

0.1.2ではFでも`hostTopics`・`hostTodos`・`utteranceEmotion`を明示指定できる。Fのホスト所有updateには`topics()`・`standingInterests`と既存の`todos()`をデータとして渡せる。ホストの記憶は独立した新観測の代わりにはならず、発話には引き続き有効な候補が必要。`reportedTodos`の出力拡張はB1だけである。接続追加後の全体検証は761成功・失敗0件（2 skip、1 todo）。

技術は Bun、TypeScript、SQLite、Zod。検証用の LLM は Claude API の Claude Haiku 5.5（`@anthropic-ai/sdk`、key は standalone の `.env`。値はログ・結果・配布物に含めない）。Pursuit と同じ独立実験構成にし、取り込み時はビルド済み JS・型宣言を版付き tgz にする。Memory と World は公開 API に接続し、Pursuit は採用した行動を遂行する接続先として後から選べる。

研究対象は、自分の経験・理解・関心と次の行動がつながるかである。発言回数が増えたことだけでは成功としない。合成音声の取得と、実際に聞き手に届いたことも分ける。

## 0.1.3のホスト接続

`planOnOpportunity: true`は機会をupdateの資料に渡し、新規観測がなくても既存の根拠から候補を検討する。機会自体は証拠にならない。`repairUpdates: true`は拒否コードを次のupdateへ渡し、既存予算内で修正を1回だけ試す。ホスト所有SystemContextがこれらの資料を読む指示を持つ必要がある。

projectionは形成した関心（状態・起源・根拠）と取得済み結果も含む。`projectAgencyState`は保存済み状態から同じ有界な資料を作る公開関数。snapshotのcontinuityは呼出・活動予算、チケットとreceipt、既出話題、拒否診断・隔離を保存する。idle plannerのcheckpointは発話頻度と次の時点を復元する。ホストは状態とイベントcursorを単一writerで確定し、外部実行前に保存し、復元時には実行台帳と配信記録を照合する。
