# 会話からmockツールチェーンまでの結合結果

2026-11-06。**今回指定された「examplesでmockツールチェーンまで導線をつなぐ」成功条件を満たした。** 実際のAgency FとMemory公開APIを使い、モデル判断と実行先だけをmockにして確認した。既存の配点による単体80点の再認定や、実モデルの会話品質の合格とは分ける。

## 担当範囲

Agencyの主用途は会話である。会話・Memory・返ってきた結果から「いま何を言うか」「待つか」「何を確かめると会話が進むか」を発案し、必要なら既存ツールチェーンに依頼する内容・理由・受入条件をホストへ渡す。通常応答を重ねず、自動発話とエージェント主導の発案を扱う。

Eumenes側の`agency/research.ts`、`agency/delivery.ts`、`dialogue/service/agency-state.ts`を参照した。依頼の能力revisionをホストがcatalog・現在性・権限と照合し、実行側へ渡す境界になっている。バンドルの起動、サブエージェント、実ツール、実行の予算・再試行・進行管理はEumenesの責務。Agencyに別のexecutorやタスク管理基盤を追加しない。

## 実装した導線

`bun run demo:mock-toolchain`を実行すると、次の実際の呼び出し経路をJSONで出力する。

1. 合成のユーザー発話を観測し、Memory RecordsとAgency checkpointへ保存。
2. 注入した模擬モデルがFのintent/candidate案を返し、既存schema・状態・参照・権限検査を通す。
3. Agencyが`delegate`のticketを作り、既存`delegationRequest`で目的・問い・理由・受入条件をホストへ渡す。
4. mockホストが現在のticket、全入力の追跡、Memoryの可用性、能力revisionと権限を確認。
5. mockツールチェーンがmockバンドルを起動し、mockサブエージェントの`run`を実際に呼ぶ。
6. 結果を`work.returned`として観測し、receiptとともにMemory/checkpointへ保存してから受付完了にする。
7. 次のAgency判断へ返った資料を渡し、会話の続きを発話ticketとして作成・模擬配信する。

出力の段階は`agency.idea → toolchain.accepted → bundle.started → subagent.started → subagent.returned → result.accepted → agency.speech`。単に成功ログを並べる試験にせず、サブエージェントへ渡った実引数・呼び出し回数・返った原文・次のモデル入力・配信結果を検査した。サブエージェント呼び出しを省く変異も試験で検出した。

実装は`examples/virtual-eumenes/mock-toolchain.ts`、シナリオは`mock-scenario.ts`、起動口は`mock-demo.ts`。Fの独自SystemContextには、Eumenesの背景・更新・選択・発話・出力契約の指示資産をhash付きfixtureとして固定した。人格は合成の固定設定、感情は無効。実Eumenesの送信境界や実行サーバーそのものを再現したという意味ではない。

## 必要になった出典契約

独自指示が常に依存不明になる問題を回避フラグで迂回せず、既存InputContextへ接続した。Agency 0.1.4 / host-rules-22で以下を追加した。

- SystemContextに`WithInput<string> { value, input }`を指定できる。構成関数も本文と追加依存を同時に返せる。
- HostTopic、HostTodo、StandingInterest、ToolCapabilityに任意の`input`を持てる。実際に提示した値の依存を合成し、metadataをモデル資料から除く。
- 未申告の旧入力は不明のまま保持する。忘却履歴がある場合、不完全・忘却済みの依存をLLM/ticket前に拒否する。receipt側の検査も維持する。
- 本文と宣言を同じ論理呼び出しで固定し、予算付き通信再試行でも再取得しない。
- 仮想ホストの忘却・終了時には進行中の推論signalもabortし、忘却前の入力を通信再試行へ回さない。

純粋な固定規則は`input: { sources: [], complete: true }`を明示できる。設定やMemory等の追加資料を使う場合、その全出典を申告する。引用したIDだけから完全性を推測しない。実ホストのSourceRef・State itemの版・アクセスとの完全な対応付けは、引き続き[出典契約計画](../spec/host-input-provenance-2026-11-06.md)の後続作業である。

## 検証結果

| 検証 | 結果 |
| --- | --- |
| mock正常循環 | 発案→ツールチェーン→バンドル→サブエージェント→結果→発話が成功 |
| 二重依頼・二重結果受付 | 同じ仕事を二重起動せず、結果観測を重ねない |
| 未知の能力・要承認の能力 | サブエージェントを起動せず、失敗receiptで仕事のslotを解放 |
| mock実行の失敗 | 失敗として保持し、成功にしない |
| 実行中の忘却・遅着結果 | mockのpayloadを破棄・失効し、結果を再投入しない |
| Memory起点の削除 | runtimeを経由しない削除でも、依頼直前の再読で古い出典を拒否 |
| 独立した会話の継続 | F・独自指示・話題・TODOで、忘却後と再起動後の結果受付まで成功 |
| ホスト入力の部分試験 | 7成功。未引用の出典、非表示資料、不明なselect、通信再試行の固定を確認 |
| 部分＋仮想結合 | 28成功・0失敗、3ファイル |
| ローカル通し検査 | 924成功・25 skip・1 todo・0失敗、950試験・76ファイル |
| 保護を外した反証 | 入力依存ガードの省略、サブエージェント呼出しの省略をともに検出 |

25 skipは明示実行する課金試験等、1 todoは複数の記憶の組合せ攻撃への未実装検査であり、合格件数へ含めない。通し検査には整形・静的検査・型・境界・配布物の消費側検査も含む。CIは実施していない。

## 限界と残作業

mockシナリオは模擬モデルへ判断を順番に注入する。ユーザーの語句で発案・分類する製品処理は追加していないが、この結果から実モデルの発案率・会話の自然さを主張しない。mockの途中の仕事はプロセス再起動から実行再開するworkerではなく、実Eumenesの実行基盤の代替ではない。実バンドル・外部サービス・本物のサブエージェントは起動していない。

後続には、実ホストの完全な出典対応、訂正・停止・期限切れの非破壊の再検証、R02の根拠重複、R03の任務の整合、実モデルでの会話・発案の評価が残る。会話と適切な依頼の発案・受渡しを評価し、サブエージェントの成果物品質をAgencyの能力として採点しない。既存の忘却・取消・参照整合の回帰は維持する。

今回の追加API費用は0 USD。従来の未確定5予約を含む保守的な累計上限は約7.08 USDのまま。台帳・Memory本体・Eumenes本流は変更せず、commit/push・他チャット送信もしていない。実行ログと修正前の失敗は`artifacts/mock-toolchain-2026-11-06/`、版管理する結果は[検証要約](../examples/virtual-eumenes/results/mock-toolchain-2026-11-06.json)へ保存する。
