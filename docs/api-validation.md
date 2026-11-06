# 共通キーでHaikuとLunaを検証する

`bun run agency`、`bun run eval`、`bun run eval:api`、`bun run eval:initiative`はログインシェルから起動する。`~/.zprofile`のexportを引き継ぎ、`.env`は読まない。キーをプロジェクトへ書き写す必要はない。Anthropicは`CLAUDE_API_KEY`→`ANTHROPIC_API_KEY`、OpenAIは`OPEN_AI_API_KEY`→`OPENAI_API_KEY`の順に読む。空白だけの値は無視する。キーの値をログへ出さない。

## 無料の確認

```sh
bun run eval:api preflight --provider anthropic
bun run eval:api preflight --provider openai
```

`keyConfigured: true`、モデル、schema変換を確認する。API呼び出しは0件。直接`bun eval/api.ts`を起動する場合は、そのシェル自身がキーを継承している必要がある。

## 課金の上限を共通にする

```sh
export AGENCY_API_LEDGER="$PWD/data/api-validation/my-session/usage.jsonl"
export AGENCY_API_LIMIT_USD=9
bun run eval:api smoke --provider anthropic --name my-session --budget-usd 9 --ledger "$AGENCY_API_LEDGER"
bun run eval:api smoke --provider openai --name my-session --budget-usd 9 --ledger "$AGENCY_API_LEDGER"
```

両モデル、背景推論、通常応答、採点、失敗した呼び出しで同じ台帳を使う。上限と価格版は隣のpolicyファイルへ固定する。通信前にモデルの最大入力・出力と余裕を含む金額を確保し、usageで精算する。使用量が不明、取消、通信失敗なら確保額を残す。SDKの自動再試行は無効。runtimeの1回の再試行も別に予約する。未知モデルは無料扱いせず拒否する。単独の`--budget-usd`は既存のコマンド停止目安で、厳密な合計上限には共通台帳が必要。

2026-11-06に、OpenAIのキャッシュ書き込み数の集計を修正した。[公式の計算方法](https://developers.openai.com/api/docs/guides/prompt-caching#how-caching-works)に合わせ、新しい応答は`cache_write_tokens`を使う。報告が欠けた応答や、旧版で値を失った台帳には最大の書き込み料金による追加上限を見込み、未知の費用を0にしない。旧行は変更せず、`legacyCacheWriteUpperUsd`は`reservedUsd`に含める。使用量の金額は請求書照合済みの値ではない。

上限を指定し直すだけでは変更できない。利用者が明示的に認めた範囲内で増額する必要がある場合だけ、`ApiMeter.raiseLimit`で許可の上限・理由、元policyと台帳hashを監査記録へ先行保存し、policyを原子的に置き換える。既存の全usage・不確定予約は保持する。今回の継続検証は、繰り返し明示された合計10 USDの許可に基づき、当初の9 USDの余裕設定から10 USDへ変更した。新しい台帳へ切り替えて費用をリセットしない。

確保の都合で残額を使い切る前に停止することがある。中断後に台帳や予約を消して再開しない。`.lock`が残る場合は全実行プロセスの停止と台帳の末尾を確認し、APIの利用記録で未精算分を照合してから復旧する。正確な請求額の最終確認はprovider側の明細を用いる。

## 同じ条件で比較する

```sh
export AGENCY_SETTINGS="$PWD/config/api-haiku.json"
bun run eval run --name haiku-unseen --split unseen --conditions B0,B1,B2,F --reps 1 --budget-usd 2
bun run eval judge --name haiku-unseen --budget-usd 1
bun run eval score --name haiku-unseen
```

Lunaは`config/api-luna.json`、別のrun名を使う。両設定とも採点役は相手providerにしてある。`AGENCY_API_LEDGER`と`AGENCY_API_LIMIT_USD`を同じ値に保つ。ケース、設定、指示の版が異なるrunは混ぜず、`--resume`の互換検査を使う。失敗・未完了も分母と記録に残す。モデルによる採点は人の有用性評価の代わりにはならない。

`live-b1-f`、`f-fusion`、`action-steps`は同じprovider生成と会計を使う。旧self方式のH4/H10/H11/H13/P3b/sfaultシーンは既定の無料方式を保ち、`AGENCY_EVAL_TRANSPORT=api`を明示した場合だけAPIを使う。これらの呼び出しにも共通台帳と上限を必須とする。各シーンの全条件を両APIで実行済みという意味ではない。

`eval:initiative --transport api --model gpt-6-luna`は、APIで推論しながらEumenesチェックアウトの指示・受付処理を試すホスト結合用。`--eumenes`、カタログ、ホスト依存の準備が必要。既定`codex-cli`方式とは別に記録する。ワーカーは模擬で、外部の仕事は実行しない。

## 自分の利用を測る

CLIの自発発言後に`/feedback useful`（役立った）または`/feedback intrusive`（邪魔だった）を入力すると、最後の介入のIDと本人の評価を保存する。`/feedback missed`は見逃した機会の自己申告。続けて任意のメモも書ける。通常の会話文から評価を推定しない。同じ介入の再評価は集計で最新を採る。

`bun run usage:report`はローカルの`data/chats`を集計し、セッション数、利用日、返信完了時間、評価あり/なしの介入数を表示する。本文とメモは出力しない。ログ無効時は計測も保存されない。セッション数は人数ではなく、無評価は有用だったとはみなさない。既存ログには遅延・有用性を遡って付与しない。

`bun run eval:performance`はモデルを呼ばず、合成観測100/1,000/10,000件のsnapshot/restoreと取消を各100回測る。実会話のTTFT、同時利用者の性能、長期利用の価値は別の測定が必要。

## 保持・復旧・削除

coreの`retentionLimits`は観測件数・1件のUTF-8バイト数・累積バイト数・状態項目数を制限する。既定は10,000件、64KiB/件、16MiB、10,000項目。超過入力は受理前に`ObservationCapacityError`、超過updateは`rejected:retention_capacity`にする。古い根拠を勝手に消したり番号を付け直したりしない。ホストは未受理イベントを保持し、明示的なアーカイブと再構築を行う。明示的な忘却・圧縮と任意のSQLiteアダプターは[忘却と圧縮](memory-lifecycle.md)を参照。無期限の自動圧縮は行わない。

委譲先の使用量は`runtime.recordUsage({id,ticketId,at,inputTokens,outputTokens})`で戻す。receipt IDで再送を排除し、異なる内容の再送は拒否する。完了後の遅いusageは活動を再開しない。入力・出力にcacheとreasoningを二重加算しない。

snapshotは単一writerで保存し、外部実行前に実行台帳と同時確定する。再起動後に不明な実行結果を照合し、同じ操作IDを再利用する。`test/core/recovery.test.ts`は一時SQLiteと別プロセスの強制終了で、このホスト契約を模擬確認する。製品DBの実装を検証したという意味ではない。

会話ログは明示したローカル保存先にだけ残る。不要になった会話・評価trace・派生資料は停止後に対象run単位で削除する。会計台帳は請求照合が終わるまで保持する。実ホストのMemory/World・生成入力manifest・バックアップを含む忘却はホスト側の責任で、coreだけでは完結しない。

旧snapshotで活動と実行IDの結び付けがない場合、活動中のusage返却は明示的に拒否する。ホストで旧実行と使用量を照合してから再開する。現在のsnapshotは結び付けを保存し、同じ時刻の別活動へ遅着usageを加算しない。

P0のケースに通常judgeの基準がない場合は対象0件になる。別の補助監査は`bun run eval:cross-judge --name <run>`で実行できる。生成後の探索的な監査であり、人の較正や原ラベルの成功率とは分ける。

## キャッシュ非使用の予約

2026-11-06のadapter .2では、stateless Anthropic呼び出しに限り、既存の送信内容に合わせて`cacheWrites: disabled`を予約へ記録する。この経路は文字列のsystem/userとschemaを構成し、top-level・blockの`cache_control`を送らない。[Messages APIのキャッシュは明示指定で有効になる](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)。有効な指定を推測で無視する処理ではなく、送信経路自体に指定がないことをSDK試験で確認する契約である。

100万tokenの全コンテキスト、最大出力、20%の余裕は維持する。8400 token出力の予約は0.6252 USD、キャッシュ書き込みを見込む既定は1.2252 USD。過去の予約は元の額のまま残す。通常応答の経路と汎用meterの既定は最大書き込み倍率を見込み、OpenAIへのdisabled指定は拒否する。実使用量では引き続き報告されたcache read/writeを全て精算する。

短い入力の文字数やtoken数の推測で予約を削減していない。新しいCLIの上限回避オプションも追加していない。上限10 USD・旧未確定予約・旧OpenAIの書き込み補正は共通台帳へ保持する。
