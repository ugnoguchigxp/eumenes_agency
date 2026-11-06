# 忘却と圧縮

この機能はAgency内の観測・派生状態・revision履歴を対象とする。意味の要約や忘れる対象の解釈はLLMまたはホストが行い、coreには確定した参照IDを渡す。Eumenes本流、外部のMemory/World、会話ログ、評価trace、既存バックアップそのものは変更しない。ホストが毎回渡すSystemContext・話題・TODO・personaも、ホスト側で先に忘却する。元の内容を再び渡せば再提示されるため、coreの保存データだけを消して完結したとは扱わない。

## eumenes_memoryとの境界

2026-11-06に`examples/virtual-eumenes`でMemoryの公開APIへ接続した。Eumenes採用のpackage 0.0.2 / schema 8配布物をSHA-256 `3070b7dd6e4a4db945300407851b6678d65af35fb8badfe5df93c33d037e6706`で固定している。Agency coreは保存に依存しないまま、仮想ホストから公開APIを呼ぶ。standaloneのCheckpointStoreは独立した旧検証用保存例であり、本番用Memoryへ採用しない。

| 責務 | 既存APIと接続方針 |
| --- | --- |
| 原観測の保管・読み出し | eumenes-memory/sqliteのcaptureRecord / readRecordを再利用できる。既存のMemory資料が正本なら二重に取り込まず、Agency観測IDとの対応をホストが持つ |
| 再生成可能な資料の保持期限 | retainRecord / useRetainedRecord / evictRetainedRecordsがある。原観測や依存中の根拠を、再生成可能なキャッシュとみなして捨てない |
| 忘却と古いDBの復元 | planForget / applyForget / reconcileForgetJournal / getForgetReceiptがある。Memoryを含む接続では既存journalを正本にし、Agencyのsnapshot復元にも忘却を再適用する接続が必要 |
| Agencyの派生物 | registerExternalDependents、listMemoryChanges、recordExternalDeletionを接続し、完了確認まで扱う。Agency側の全入力依存から登録し、同じexternalIdの置換で古いrevisionの依存を失わないようにする |
| 意図・候補・実行票の失効 | Agency固有の状態・権限・未処理順序のためcoreに残す。Memoryの忘却受付だけを、実行票や配信内容の削除完了とみなさない |

Memoryのuser Stateのsubject:selfは利用者を表し、agent自身の意図やB1メモをそのまま保存する場所ではない。Agencyの意味判断は引き続きLLMが行う。非引用のモデル入力、依存が不完全な旧状態、外部副作用の実行票には、Agency側の追跡と停止が必要である。

仮想接続では原文をRecordsに置き、観測ID・版・SourceKeyを対応付け、checkpointと依存登録を同一transactionで確定する。Memory側のjournalをDB外へ先行保存し、忘却通知からAgencyの派生状態・実行票と派生観測の原文を除去してから外部削除を確認する。版固定、scope、32参照上限、再起動、非引用入力、古いDB復元、保存失敗、削除途中の復旧、原文欠損と忘却の区別を一時DBで確認した。[adapterの使い方](../examples/virtual-eumenes/README.md)と[測定・俯瞰レビュー](agency-review-2026-11-06.md)に条件を記録している。実Eumenesの想起・curation・本番DB・Worldまでの接続は未検証。以前の内部90点を、その接続品質の証明へ流用しない。

## 入力への依存と引用

`snapshot.provenance`はモデルが引用した根拠とは別の記録。update/selectに提示した観測と配信、保持状態の入力依存を、変化した項目へ伝播する。提示された状態に絞り、モデルに見せていない過去の実行まで別の仕事の依存に混ぜない。依存が不明なデータは保守的に扱うため、忘却の範囲が広くなる場合はある。引用した観測だけから派生内容を判断しない。

B1のメモが引用する原観測は、直近30件から外れていても既存ledger/archiveから最大16参照まで読み戻す。現在表示するメモの参照だけを対象とし、B1では見せない意図の参照は混ぜない。忘却journalの照合を通した読み出しを使い、読み戻した観測もモデルへの入力依存へ含める。意味上どの経験を使うかはLLMが選び、この参照解決自体は語句による検索・分類をしない。

ホストが生成した情報は、`runtime.observe(observation, {sources, complete})`で入力元を渡す。`sources`は観測・外部参照ID、`complete`は全入力が把握できているかを表す。既知の観測に連なる依存は展開する。ユーザーの直接入力以外で指定がない場合、旧状態、独自SystemContextやホストの話題・TODOに記録外の情報が含まれうる場合は、不完全な依存として扱う。忘却時は不完全な派生データも除去する。`recordResult(receipt, context)`も全入力を渡せる。指定しなければ、別モデルによる発話の書き直しやツール内部の入力が不明として扱う。選択時の入力だけで実際の配信本文まで追跡できたとはみなさない。journalがある場合、入力が不明な新しい観測・結果は受理せず、ホストに全入力の明示を求める。完全であると偽って申告したホストの入力までは検証できない。

0.1.4では独自SystemContextを`WithInput<string> {value,input}`として渡せる。話題・TODO・関心・ツール説明の`input`も受け取り、実際に提示した全資料の依存を合成する。管理metadataはモデル資料から除き、忘却後の不明・忘却済み入力はLLM/ticketより前に拒否する。未申告の旧入力を自動で完全にしない。[mock結合](mock-toolchain-integration-2026-11-06.md)ではFと独自指示・話題・TODOで、独立した会話が忘却後・再起動後も続くことを確認した。Memory State itemや実ホストの完全な出典対応、非破壊の訂正・失効は後続の検証範囲である。

revisionは既存の`agency`種別の補助項目`inputs:<kind>:<id>`へ依存を保存する。既存テーブルの列追加は不要。通常項目の`evidence`は全入力依存も含むが、項目本文内の引用は元のまま。`stateFromRevisions`の戻り値を丸ごとrestoreへ渡すと、依存とrevision番号も復元できる。旧履歴で入力依存が分からない場合、`redactRevisions`は忘却時に保守的に本文を消す。

## ホスト側の保存手順

coreの`prepareForgetting(snapshot, refs)`と`prepareCompaction(snapshot, keepRecent)`は保存計画を返す純粋関数。計画を作っただけでは永続化されない。ホストは外向き処理を止めて旧runtimeをinvalidateし、最新checkpointを保存してから、計画と必要な履歴変更を一括確定する。確定後に新runtimeへ切り替え、旧runtimeからの結果を採用しない。

このリポジトリにはBun用の任意アダプター`standalone/checkpoint-store.ts`を用意した。coreの配布物にはSQLite依存を入れない。

```ts
const store = new CheckpointStore("agency.sqlite");
let generation = store.load()?.generation ?? 0;
// bufferedRowsはRevisionSink.appendが受け取った未保存のbatch。
generation = store.save(runtime.snapshot(), generation, bufferedRows);
// 成功後にのみbufferedRowsを空にし、外部への実行・配信を許可する。
generation = store.compact(generation, 64);
generation = store.forget(["observation-id"], generation);
const saved = store.load()!;
const restored = {
  ...saved.checkpoint,
  revs: stateFromRevisions(store.rows())?.revs ?? new Map(),
};
// createAgencyRuntime({..., restore: restored, archive: store,
//   forgottenRefs: store.journal()}) で再構築する。
```

`save`はcheckpointとrevision batchを同一transactionで保存する。同じrevisionの異なる内容を拒否する。`compact`は退避原文とcheckpoint、`forget`はjournal・履歴の消去・archiveの削除・checkpointを一括確定する。世代番号が古いwriterは保存できない。保存が失敗したら未保存batchを保持し、外部処理を進めない。

journalは旧checkpointより優先する。旧backupを読み戻しても、journalを適用したデータだけがモデルへ渡る。journalを消して旧backupを直接restoreすれば、この保証は失われる。機密本文を含む旧backupやSQLiteの空き領域・WALなどの物理消去は、利用する保存媒体の運用で扱う。これは媒体の安全消去の実装ではない。

## 保たれるものと上限

圧縮は未処理観測、直近の観測、状態の引用元、最後のユーザー入力、直近の配信記録を保持する。退避した原文は`ObservationArchive.get(id)`で元のIDとseqのまま取得できる。再送の一致検査にも使う。`compactedThrough`を超える欠番はrestoreで拒否し、次の採番をやり直さない。意味の要約で原文を置き換えない。

忘却された未処理入力は本文のない枠として残し、他の未処理入力まで処理済みにしない。忘却IDとその派生観測IDは再投入を拒否する。実行中の票・配信結果・派生項目も除去し、未追跡の診断や話題履歴は保守的に消す。

観測と状態の既存上限に加え、入力依存metadataも`totalObservationBytes`で制限する。上限に達したupdateは処理済みにせず停止する。閉じた状態・実行receipt・使用量の重複防止情報を無条件に削除しないため、全データの無期限保持を保証するものではない。archiveとjournalの保存容量はホストが管理する。CLIの全会話履歴を自動で消すコマンドは、この機能には含まれない。

## ローカル検証

`bun test test/core/memory-lifecycle.test.ts`は非引用入力、参照の連鎖、旧履歴、再投入、backup復元、未処理の保持、archiveの冪等性、保存失敗、強制終了、複数プロセスの競合を検査する。`bun run eval:memory-performance`はAPIを呼ばず、32メモ・1,000観測の更新と選択、および圧縮を各100回測る。ローカル処理p95 50ms、metadata 1MiBを検査する。ネットワーク遅延や実利用の有用性は別の評価である。CIは追加していない。
