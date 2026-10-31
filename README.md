# eumenes-agency

Eumenes が経験から関心・欲求・意図を持ち、発言や行動の機会を選ぶ仕組みを、本体と独立して検証するサブプロジェクト。名前は仮称。

**2026-10-21 時点: P0-E（単一の未解決事項の再開・抑制）を実装・実行した。指示の改訂で再現率は大きく上がったが、B1/B2/F の差はケース集合で順位が入れ替わる程度だった（[検証結果](spec/results.md)）。次は経験との因果・前提変化・並行する事項を測る [P1-E](spec/p1e-experiment.md)、その後に閉ループ会話の P2-E。永続化・製品接続は未着手。**

使い方: `bun run verify`（format / lint / 型 / 境界 / テスト）、`bun eval/main.ts validate [--suite p0e|p1e]`、`bun eval/main.ts run --name <run> [--suite p1e] [--conditions B1,B2,D] [--case <id>] [--reps 3] [--budget-usd n]`、`bun eval/main.ts score --name <run>`、`bun eval/main.ts judge --name <run> [--limit N] [--budget-usd n]`（内容と状態の判定器）、`bun eval/main.ts label-export --suite p1e --split dev --n 12 --out <file.md>` と `agreement --sheet <file.md>`（人手ラベルの一致率）、`judge-export --name <run> --n 30 --out <file.md>` と `judge-agreement --sheet <file.md>`（判定器の較正）、`bun eval/main.ts trace --name <run> --case <id> [--condition B2] [--rep 1] [--prompt]`（モデル呼び出しと最終状態の確認。`traces.jsonl` はローカルのみ）、`bun run agency [-- --condition B1a --idle-sec 40 --max-unanswered 1 --no-log]`（対話。黙っていると AI から話しかける。既定 B1a、会話記録は `data/chats/`）。設定は `config/experiment.json`、費用の記録は `data/spend.jsonl`。

- [計画と設計](plan.md): 最小循環、状態、処理、段階的な取り込み。
- [P0-E 実験仕様](spec/p0e-experiment.md): 最初の比較実験。B0/B1/B2/F、Claude Haiku 5.5、費用上限、判断方法、実施の記録と逸脱。
- [検証結果](spec/results.md): P0-E の各回の結果と読み取り。
- [P1-E 実験仕様](spec/p1e-experiment.md): 経験との因果・前提変化・自己増幅・並行する事項・履歴の長さ。状態の軌跡の採点。
- [人格研究の選定メモ](spec/persona-research-selection.md): 取り込む価値のある研究10項目と試し方。
- [既存実装の調査](spec/source-audit.md): Eumenes / Pursuit / Memory / World の再利用先と制約。
- [類似 OSS の参照](spec/oss-reference-2026-10-22.md): LocalAIVtuber2・Anima・AICO・Shikigami・ThoughtField をソースで確かめた結果と、評価対象（実験条件 X1・X2、試験シナリオ S1–S9）。
- [雑談の間の実験](spec/social-lull-experiment.md): 記憶の話題・関心から話しかける振る舞い（hostTopics）を、取りこぼし・誤発話・内容で測る計画。
- [ホスト所有のSystemContext](spec/host-system-context.md): 用途別の全文指定、動的な構成関数、出力契約、0.1系への移行とEumenesの接続変更。
- [2026-10-31 全体レビューと修正](spec/review-2026-10-31.md): 無効化・取消・出力検証・状態の隔離・結果ID・予算の整合、0.1.1の検証結果と限界。
- [ホスト接続契約案](spec/host-contract-v1.md): 推論・保存・発話・ツール・忘却の境界。
- [検証計画](spec/verification-plan.md): 固定試験、実モデル評価、遅延・負荷の比較、採用条件。
- [研究根拠と適用限界](spec/research-basis.md): 一次資料12件、参考実装、設計判断との対応、代替案。
- [2026-10-21 レビュー](spec/review-2026-10-21.md): 評価、修正点、次レビューで決めること。

ライブラリ利用時は`RuntimeDeps.systemContext`に`{ update, select }`（全文または構成関数）を必ず渡す。旧実験の指示を使う場合だけ`"experimental"`を明示する。通常応答は`runRespond`の先頭に非空のsystemを1件渡し、観測・履歴・参照資料は別メッセージに置く。出力形式の説明は`agencyOutputContract`と`replyOutputContract`で確認でき、指示へ自動追加されない。

技術は Bun、TypeScript、SQLite、Zod。検証用の LLM は Claude API の Claude Haiku 5.5（`@anthropic-ai/sdk`、key は standalone の `.env`。値はログ・結果・配布物に含めない）。Pursuit と同じ独立実験構成にし、取り込み時はビルド済み JS・型宣言を版付き tgz にする。Memory と World は公開 API に接続し、Pursuit は採用した行動を遂行する接続先として後から選べる。

研究対象は、自分の経験・理解・関心と次の行動がつながるかである。発言回数が増えたことだけでは成功としない。合成音声の取得と、実際に聞き手に届いたことも分ける。
