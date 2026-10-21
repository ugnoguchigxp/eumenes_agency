# eumenes-agency

Eumenes が経験から関心・欲求・意図を持ち、発言や行動の機会を選ぶ仕組みを、本体と独立して検証するサブプロジェクト。名前は仮称。

**2026-10-21 時点: P0-E 実験の実装は完了し、決定的な検証（`bun run verify`）が通る。実 API では動作確認（3ケース×4条件×1回）だけを行った。開発ケース24件のラベルは draft で、P0-E 本番の実行、P1 以降、製品への接続は未実施。**

使い方: `bun run verify`（format / lint / 型 / 境界 / テスト）、`bun eval/main.ts validate`、`bun eval/main.ts run --name <run> [--case <id>] [--reps 3]`、`bun eval/main.ts score --name <run>`、`bun standalone/cli.ts [--condition B2]`（対話）。設定は `config/experiment.json`、費用の記録は `data/spend.jsonl`。 まず指示＋想起、最小の意図・候補台帳、分離した状態を小さく比較し、必要な構造だけを実装する計画。実装を依頼された段階で、Eumenes の AGENTS.md に従い設計への合意を確認する。

- [計画と設計](plan.md): 最小循環、状態、処理、段階的な取り込み。
- [P0-E 実験仕様](spec/p0e-experiment.md): 最初に実装する比較実験。B0/B1/B2/F、Claude Haiku 5.5、費用上限、判断方法。
- [既存実装の調査](spec/source-audit.md): Eumenes / Pursuit / Memory / World の再利用先と制約。
- [ホスト接続契約案](spec/host-contract-v1.md): 推論・保存・発話・ツール・忘却の境界。
- [検証計画](spec/verification-plan.md): 固定試験、実モデル評価、遅延・負荷の比較、採用条件。
- [研究根拠と適用限界](spec/research-basis.md): 一次資料12件、参考実装、設計判断との対応、代替案。
- [2026-10-21 レビュー](spec/review-2026-10-21.md): 評価、修正点、次レビューで決めること。

技術は Bun、TypeScript、SQLite、Zod。検証用の LLM は Claude API の Claude Haiku 5.5（`@anthropic-ai/sdk`、key は standalone の `.env`。値はログ・結果・配布物に含めない）。Pursuit と同じ独立実験構成にし、取り込み時はビルド済み JS・型宣言を版付き tgz にする。Memory と World は公開 API に接続し、Pursuit は採用した行動を遂行する接続先として後から選べる。

研究対象は、自分の経験・理解・関心と次の行動がつながるかである。発言回数が増えたことだけでは成功としない。合成音声の取得と、実際に聞き手に届いたことも分ける。
