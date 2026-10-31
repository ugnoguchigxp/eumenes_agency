# P4-c / H12 版の履歴（LLM なし、台本の提案。採点は決定的）

流れ: u1 将棋の角換わりを学びたい → 意図・候補・関心(emerging) → 発話・受領 → u2 深掘り（意図 completed、関心 active）→ u3 休む（dormant）→ 再起動 → 表だけから復元 → u4 再開（active）→ u1 を忘却。
ホスト代役: eval/h12-db.ts（bun:sqlite、`agency_item_revisions` 1表のみ。PK(scope,item_kind,item_id,revision)）。

| 指標 | before（開いた項目のスナップショット） | after（版の追記表） |
|---|---|---|
| 再起動後の項目一致 | 1/4 | 4/4（ルート情報も一致） |
| 関心の変化の再構成 | dormant のみ（失敗） | emerging→active→dormant→active（成功） |
| 復元時の重複行 | — | 0 |
| 復元後に続けて更新 | — | 成功（版番号が連続、PK 衝突なし） |
| 行に会話原文 | — | 0 |
| 忘却後に本文が残る行・項目 | （履歴なし） | 0（3項目を墨消し） |
