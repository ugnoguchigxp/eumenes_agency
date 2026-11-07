# eumenes-agency

会話を主用途とし、会話や結果から自動発話・確認・ツールチェーン利用を発案する、Eumenes向けの独立した研究用ライブラリです。必要な依頼の目的・理由・内容をホストへ渡し、バンドルやサブエージェントの実行はEumenesの既存機構が担当します。

**mockツールチェーンまでの導線は結合成功しました。** `bun run demo:mock-toolchain`で、会話→発案→mockバンドル・サブエージェント→結果→自動発話をAPI費用0で確認できます。[導線の検証結果](docs/mock-toolchain-integration-2026-11-06.md)を参照してください。実モデルの会話品質や正式点とは分けて扱います。

0.1.5では、[Haiku/Lunaによる会話・自発発話・発案の実API検証](docs/native-conversation-validation-2026-11-06.md)を追加しています。Fの会話参加、通常応答との重複抑制、再読枠と実際の送出間隔の提示、出力・能力の契約を改善し、同じ条件で測定しました。ツールチェーンの実行先はmockです。

**責務内の単体完成度は83.3/100で、80点超えの受入条件を満たしました。** examplesの会話モード・両モデルhigh設定で、内容込みの必要時成功はHaiku20/24件、Luna23/24件、不要介入は各0/24件です。技術75.5・行動91.666…・忘却/圧縮90を従来の50/30/20で合算しています。実Memoryとmockツールチェーンを使った合成ケース各1反復の判定で、信頼度はMediumです。他機能の旧評価は参考として保持します。[評価・全条件と残課題](docs/native-conversation-validation-2026-11-06.md)、[保存集計](examples/virtual-eumenes/results/native-conversation-2026-11-06.json)を参照してください。

ローカル検査は949成功・25 skip・1 TODO・0失敗。API累計は過去の不確定予約・補正を含め保守的上限9.16 USDで、10 USD以内でした。CIは行っていません。本体への統合実装と検証範囲は下記の実装記録に分けています。本番運用や実利用の有用性は別途検証します。

Memory側の追加レビューを踏まえ、[ホスト入力の出典契約](spec/host-input-provenance-2026-11-06.md)を追加しました。F・独自指示・話題・TODOで、忘却後も独立した会話を結果受付・保存・再起動まで継続するmock結合試験が通っています。2026-11-07に実ホストへ出典対応を移植し、保存・圧縮・忘却・独立した会話の継続をMemory 0.0.4との結合試験で確認しました。稼働反映後のAPI・Web・Memory正常応答まで確認済みで、実会話の受入は未実施です。

[Eumenes本流への統合実装計画](spec/eumenes-mainline-integration-plan-2026-11-06.md)に、既存Memory 0.0.4・ツールチェーンを使う取り込み順序、全入力の出典と忘却、旧保存の移行、ローカル検証と切り戻しをまとめました。CIは含めません。2026-11-07に本流のコードへ反映し、[本流の実装・検証・移行記録](/Users/y.noguchi/Code/eumenes/spec/agency-integration-2026-11-07.md)に結果をまとめています。同日に利用者の許可を得て既存DB・API・Webへ反映し、正常応答を確認しました。実会話の確認は利用者が行います。

## 常に考え、頼まれなくても動くエージェント（always-on）

2026-11-07から、このプロジェクトの標準の会話は always-on です（[設計](spec/always-on-agency-design-2026-11-07.md)、[実装と検証の記録](docs/always-on-progress-2026-11-07.md)）。利用者が黙っていても考え続け、相手を知るための質問、好みに合わせた黙っての準備（調べる・作る）、準備した結果の共有を自分から行います。「静かにして」と言われたら、その間は話しかけません。

```sh
bun run agency                  # always-on の対話CLI（Haiku、費用は記録のみで上限なし）
bun run agency --interval 60    # 話しかけの最短間隔: 10（既定）/ 60 / 600 秒
bun run eval:always-on          # API 0件: 沈黙中に何回動けるかを旧方式と比較
bun run eval:always-on:api <run-name> [scenario...]  # Haikuで7つのシナリオを仮想時計で再生
```

準備の実行先は `examples/virtual-eumenes/always-on-mock.ts` のmockで、実在の検索やサービスは使いません。ライブラリとしては `createAlwaysOnAgent` を使います。既存の `createAgencyRuntime` と旧CLI（`bun run agency:legacy`）は、過去の評価を再現するために変更せず残しています。

## できること

- ユーザー・ツール・ホストから観測を受け取り、LLMが記憶を更新し、発言やツール利用の候補を選びます。意味や状況の判断はLLM、参照・権限・予算・状態の整合性はコードで扱います。
- 取消・再起動・重複する結果・保持上限を扱い、状態と処理位置をsnapshotに保存します。ツールの実行と発話の配信はホストが担当します。
- 引用とは別に、モデルへ渡した入力への依存を記録します。忘却の計画とjournalで派生状態や古い保存からの復活を防ぎます。処理済みの原観測は、IDと順序を保って退避できます。
- Claude HaikuとOpenAI Lunaの直接APIで、同じケース・指示・採点基準を比較できます。呼び出し前の費用予約と使用量の精算を、両モデルで同じ台帳に記録します。

まだ実利用での有用性・長期運用を確認した製品ではありません。忘却はこのライブラリと任意のstandalone保存内の論理削除で、外部の記憶・会話ログ・providerの保持や物理媒体の消去はホスト側の対応が必要です。圧縮は原文の損失なし退避であり、意味要約で原文を捨てる方式ではありません。

**[examples/virtual-eumenes](examples/virtual-eumenes/README.md)でeumenes_memoryの実公開APIに接続しました。** Memory 0.0.2の配布物を固定し、原観測はMemoryに置き、Agencyの状態・実行票との忘却連動と再起動を検証します。Eumenes本流では、既存のMemory 0.0.4との互換性を別途結合試験で確認しました。独自のstandalone保存例は本番用Memoryに採用しません。小規模なAPI比較の効果と限界は[俯瞰レビュー](docs/agency-review-2026-11-06.md)、責務は[記憶と忘却の境界](docs/memory-lifecycle.md#eumenes_memoryとの境界)を参照してください。本体への統合実装は上記の記録を参照してください。既存DBへの適用・稼働反映は確認済みで、実会話の受入は別段階です。

## ローカルで確認する

BunとTypeScriptを使います。通常の実行時依存はZod、直接APIを試す環境では各providerのSDKも使います。

```sh
bun install --frozen-lockfile
bun run verify
```

`verify`は整形・静的検査・型・ホスト境界・テスト・配布物のローカル検査です。実APIの試験は明示的に実行します。隣にEumenesのチェックアウトがある場合は、既存のホスト接続試験も対象になります。外部ホストの変更で失敗した場合は、このプロジェクト単体の失敗と分けて記録してください。

```sh
bun run eval validate --suite p0e
bun run eval validate --suite p1e
bun run eval:performance
bun run eval:memory-performance
bun run eval:synergy
bun run demo:mock-toolchain
```

性能試験はAPIを使いません。実モデルの待ち時間や本番環境の性能は別途測る必要があります。

## 共通のAPIキーを使う

`~/.zprofile`にexport済みなら、プロジェクトごとの`.env`は不要です。API関連の`bun run`コマンドはログインシェルから設定を読み、`.env`を使わずに起動します。

| provider | 優先する変数 | 互換名 |
| --- | --- | --- |
| Anthropic | `CLAUDE_API_KEY` | `ANTHROPIC_API_KEY` |
| OpenAI | `OPEN_AI_API_KEY` | `OPENAI_API_KEY` |

```sh
bun run eval:api preflight --provider anthropic
bun run eval:api preflight --provider openai
```

ここまではAPI呼び出し0件です。`keyConfigured: true`を確認してから課金試験へ進みます。キーの値はログや結果へ出しません。`bun eval/main.ts`などを直接起動する場合は、そのシェル自身がキーを引き継いでいる必要があります。

## API費用をまとめて制限する

台帳と上限を、対話・評価・採点で共通に指定します。同じ検証を継続するときは台帳を変更・削除しないでください。

```sh
export AGENCY_API_LEDGER="$PWD/data/api-validation/my-session/usage.jsonl"
export AGENCY_API_LIMIT_USD=9
export AGENCY_SETTINGS="$PWD/config/api-haiku.json"
```

この例の9 USDは、新規の検証で10 USD以内に収める余裕を持った設定です。Lunaへ切り替える場合は`AGENCY_SETTINGS`だけを`config/api-luna.json`へ変え、台帳を共有します。使用量が分からない通信失敗は予約を残すため、残額を使い切る前に停止する場合があります。

今回完了した検証は`data/api-validation/improvement-20261105/usage.jsonl`と**10 USD**の上限を使いました。当初の9 USDから、利用者の許可範囲内で監査付き変更を行い、保留・補正込みの累計上限は9.16 USDでした。台帳・不確定な呼び出し・過去のキャッシュ書き込み費用の最大補正は保持しています。上限の環境変数を変えるだけではpolicyは変更できず、既存台帳の削除・作り直しで予算を増やしません。

```sh
# 以下はAPI利用料が発生します
bun run agency --condition B1a --idle-sec 40 --max-unanswered 1 --no-log
bun run eval run --name my-haiku-run --suite p1e --split unseen --conditions B1 --reps 1 --budget-usd 1
bun run eval judge --name my-haiku-run --budget-usd 1
bun run eval score --name my-haiku-run
```

コマンド単体の`--budget-usd`は停止目安です。厳密な累計管理には、上の共通台帳も必要です。`judge`の採点役は設定上、相手providerです。モデルの採点は人による有用性の評価の代わりにはなりません。[API検証・費用・復旧の手順](docs/api-validation.md)に詳しい説明があります。

対話CLIは通常応答後に状態を更新し、静かな間に自発発話を判断します。既定はB1a、10秒の間、返事なし最大3回。上の例は40秒・1回に制限し、会話ログを保存しません。ログを保存する設定では`data/chats/`に記録し、`/feedback useful`・`/feedback intrusive`・`/feedback missed`で本人の評価を残せます。`bun run usage:report`は本文を出さず集計します。計測機能の実装と、実利用での評価実績は分けて扱っています。

## ライブラリとして接続する

`createAgencyRuntime`の`systemContext`に、用途に合う`{ update, select }`の全文または構成関数を必ず渡します。リポジトリの実験用指示を使うときだけ`"experimental"`を明示します。通常応答は`runRespond`へ渡し、観測や参照資料は指示とは別のデータとして扱います。出力契約は`agencyOutputContract`・`replyOutputContract`で確認できます。

主な実験方式は、記憶なしのB0、自由文メモのB1、意図と候補を持つB2、信念・欲求も扱うFです。B1aはメモがなくても選択を呼ぶ比較方式、Dはケースが指定した関連観測を渡す診断です。Dは正解に近い資料の選択を検証側から受け取るため、製品の完成度として採点しません。

0.1.5の接続では次を利用できます。

- `planOnOpportunity`: 新着観測がなくても、機会を資料にして候補を検討します。機会そのものを外部の証拠にはしません。
- `repairUpdates`: 拒否コードを渡し、既存予算内で更新案の修正を1回だけ試します。
- `constrainToolNames`: ホストが提示したツール名を出力schemaに限定します。
- `recordUsage`: 委譲先の実使用量を実行IDへ結び付け、再送や遅着を扱います。
- `WithInput<string>`: 独自SystemContextの本文と追加の入力依存を同時に渡せます。話題・TODO・関心・ツール説明にも`input`を申告できます。不明な依存は完全扱いにせず、忘却後は推論前に停止します。
- `conversationParticipation`: Fで明示したとき、提示された外部観測を根拠に、その場の一言を候補なしで選べます。ツールの発案には意図と候補が必要です。ホストへ渡す公開出力契約にも、有効な会話モードと`conversationEvidenceRefs`の要件が反映されます。会話の役割や口調はホストの指示で定めます。既定は無効です。

モデル向けの`delivered`には採用済み通常応答と自発発話が入り、`outboundWaitMs`は背景処理自身の送出間隔の残りを示します。実際の制限はruntimeでも検査します。通常応答の記録は、音声の再生済みを保証するものではありません。

ホストは単一writerで状態と処理位置を確定し、外部実行前に保存します。復元時には実行台帳・配信記録を照合してください。共有予算器はruntimeの設定と同じか、より厳しい上限にします。直接APIと実行権限は別であり、モデルの提案だけで要承認ツールを実行しません。

忘却・退避・復元の契約と検証用保存例は[忘却と圧縮](docs/memory-lifecycle.md)、ホストの指示やデータの分離は[SystemContext接続仕様](spec/host-system-context.md)を参照してください。Memory公開APIの仮想接続を、本番ホスト・Worldまでの接続済みという意味では使いません。

## 設計と過去の検証

過去の成功件数や比較は、それぞれの当時の版・ケースに対する記録です。現在の品質を証明する数値として合算しません。

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

Eumenes本体を使う`bun run eval:initiative`は別のホスト結合経路です。既定のCodex CLI方式と直接API方式を区別し、隣のチェックアウト・依存関係・指示カタログを準備する必要があります。今回の単体改善では本流接続を実施していません。[Lunaによる初回の記録](eval/results/initiative-luna-20261104/summary.md)も当時の版の結果です。

ライセンスは[MIT](LICENSE)、著作権表記はy.noguchiです。
