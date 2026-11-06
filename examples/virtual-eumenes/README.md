# 仮想Eumenes adapter

Eumenes本体のソースやDBを使わず、Agencyと実際の`eumenes-memory`公開APIを接続する検証用ホストです。`adapter.ts`が観測・更新・選択・模擬配信の結果・忘却をつなぎ、`memory-bridge.ts`がホスト所有のtransactionとjournalを扱います。独自の意味記憶・検索・要約は実装していません。

会話からエージェントが調査を発案する[完全なmock導線](../../docs/mock-toolchain-integration-2026-11-06.md)もあります。

```sh
bun run demo:mock-toolchain
```

F・Eumenesの指示資産・実Memoryを使い、モデルの判断と実行先だけをmockにします。`mock-toolchain.ts`が能力revisionと入力を照合してmockバンドル・サブエージェントへ渡し、返った結果からAgencyが会話を続けます。実ツール・外部サービス・有料APIは呼びません。Agencyの担当は発案と受渡しで、実行基盤はこの例のホスト側に置いています。

`scene.ts`は無料の台本試験と実API検証で同じ配線を使います。0.1.5ではFの`conversationParticipation`を有効にし、コピーした本流指示を基準として、仮想ホストの会話用指示を別に版管理しています。指示assetの元ファイルは改変していません。

Haiku/Lunaで同じ合成ケースを測る入口は`native.ts`です。実行先はmockのままで、判断は実モデルが行います。[検証方法と結果](../../docs/native-conversation-validation-2026-11-06.md)を参照してください。

```sh
# API料金が発生します。既存の累計台帳と上記の設定を指定して実行します。
bun run eval:conversation:api generate my-conversation-run development
# 生成時と同じ設定の llm.judge で、相手providerが内容を点検します。
bun run eval:conversation:api judge my-conversation-run development configured-01
```

この入口は今回の継続検証の台帳パスと承認済みpolicyを要求し、既存台帳がない場合やrun名の再利用は拒否します。現在のpolicyは10 USDです。採点タグを付けると過去の採点を残したまま別ファイルへ記録し、同じタグの上書きも拒否します。`validation`は別の48件ですが、開封後の再比較を新しい未見試行とは呼びません。調査後の会話には固定の利用者の問い掛けがあり、通常応答モデル自体や質問なしの自動完了通知の評価と混同しません。

Eumenes採用のMemory 0.0.2 / schema 8配布物を`vendor/manifest.json`のSHA-256で固定しています。rootの開発用依存であり、Agency coreの配布物には含めません。MemoryはMITで、ライセンスは固定tgz内にあります。

```sh
bun install --frozen-lockfile
bun --no-env-file test examples/virtual-eumenes
bun run eval:synergy
```

ここまではAPIを呼びません。測定結果は既定で`artifacts/memory-synergy-2026-11-06/structural-metrics.json`へ出ます。既存測定を保存する場合は、`bun --no-env-file examples/virtual-eumenes/measure.ts <出力ディレクトリ>`で場所を分けてください。

原観測本文はMemory Recordsだけに保存します。ホストcheckpointにはAgency状態、原観測ID・版・順序、全入力依存を保存します。古い本文の読み戻しは既存`ObservationArchive`へ接続します。Memoryの1依存物32参照という上限に合わせ、checkpointの依存登録を機械的に分割します。登録拒否・保存失敗・削除確認の失敗は成功として返しません。

Memoryのforget journalをDB外へ先行保存・fsyncし、公開forget/reconcile API、変更フィード、外部削除確認を使います。Agencyの派生観測もMemory Recordsとして削除し、候補・実行票の除去は既存Agency coreへ渡します。本文欠損は復旧エラーとし、忘却の成功へ読み替えません。古いDB復元後はfeedを全再同期します。

小規模な実API比較は課金されます。`~/.zprofile`のexport済みキーを既存の起動機構で使い、プロジェクトの`.env`は不要です。

```sh
export AGENCY_API_LEDGER="$PWD/data/api-validation/improvement-20261105/usage.jsonl"
export AGENCY_API_LIMIT_USD=10
export AGENCY_SETTINGS="$PWD/config/api-haiku.json"
bun run eval:synergy:api my-haiku-pair
# Lunaでは設定だけ変え、同じ累計台帳を使う
export AGENCY_SETTINGS="$PWD/config/api-luna.json"
bun run eval:synergy:api my-luna-pair
```

この継続検証では上記の台帳を固定し、以前の不確定費用も含めた10ドル制限を守ります。既存run名での上書きは拒否し、各runのmanifest・合成入力・trace・結果を保存します。4ケース×接続あり/なし×1反復で、両条件の違いはarchive portの有無です。既知の参照IDと一般的なメモを試験側で与えるため、想起する資料の発見・実利用・正式な単体完成度を証明する試験ではありません。

一時ディレクトリと合成データを使ってください。本番DBや既存のホストDBは対象外です。仮想ホストは単一writer、固定の利用者・会話scope、模擬配信に限定します。既定の保存比較は実験用SystemContext、mock導線は固定したEumenesの独自指示と合成personaを使います。実Eumenesの想起・curation・scheduler・World・音声・外部副作用・複数writerの運用は再現していません。外部への配信やツール実行を行う前に、ホスト側で永続化と権限の再検証が必要です。

`standalone/checkpoint-store.ts`は旧来の独立した保存試験用です。このadapterや本番のMemoryとして採用しません。Agency固有の状態の失効・参照整合性を保つcoreの関数は継続利用します。

測定結果・見つかったAgencyの問題・Memoryへの帰属判断は[俯瞰レビュー](../../docs/agency-review-2026-11-06.md)に記録しています。

[2026-11-06の測定要約](results/2026-11-06.json)には固定配布物・比較結果・費用・検査件数を保存しています。Agencyはこのcheckoutのソースへ接続する例で、配布済みAgency tgzを使う本番adapterの検証は別途必要です。
