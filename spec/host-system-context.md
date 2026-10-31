# ホスト所有のSystemContext

2026-10-31。**利用者が本案に合意し、Agency側を実装。検証結果は末尾に記録する。** 対象はAgencyのみ。Eumenesは参照調査に限り、変更しない。

## 1. 目的と完了条件

通常応答・背景状態更新・参加判断のシステム指示をホストが全体指定する。ホスト指定時は、その文字列だけを変更せず渡す。人格、話し方、感情の選び方、ツールを使う時機、発話・報告の優先順位をAgencyが加えない。他のメッセージにも移さない。

既存の状態モデル、短期記憶、参加判断の方式、実行権限・予算・取消・revision検証は変更しない。新しい依存ライブラリ、保存領域、プロンプト管理基盤は追加しない。既存portと呼び出し機構を再利用する。

完了には、全製品経路と再試行の入力捕捉試験、既存検証、公開API・移行手順の説明が必要。Agency単体の合格とEumenesへの接続・実モデル確認を区別する。

## 2. 調査結果

既存のplan.md、host-contract-v1.md、eumenes-integration-spike.md、verification-plan.md、todo/emotion/errand/self-research-design.md、公開export・実装・試験・standalone/evalを確認した。初期の契約案には未実装部分が多いため、現行コードを実際の接続契約と区別する。

| 経路・部品 | 現行の組み立てと問題 | 対応案 |
| --- | --- | --- |
| `runtime.ts` → `model-call.ts` → `LlmPort.complete`（update） | `systemPrompt("update", condition, options)`が固定の役割・保存対象・自己出力・状態遷移・仕事の照合方針とwire説明を結合 | ホストのupdate全文へ置換。実行契約の説明は別の公開部品にする |
| 同（select） | 固定参加方針に関心・雑談・仕事報告・質問・用事・感情・自発調査・配信文体を追加 | ホストのselect全文へ置換。各設定から指示を自動追加しない |
| `prompts.ts` のupdate/select本文 | 終端項目の「再提案しない」、dueの整理指示、「迷うならwait」「idleならspeak」、質問・報告の優先などがuser入力にも存在 | ホスト構成では、中立な構造化データに置換。判断方針は本文へ残さない |
| 同、データの並び | TODOを用事→質問→完了→進行中、話題を未使用・最終利用順にソート | ホスト構成では優先順位を付けず、提示対象の配列順と時刻・状態をデータとして渡す。既存の可視性・有界化は維持 |
| `respond-system.ts` / `styles.ts` | base、persona、spokenReplyStyle、emotionRules、toolRules。projection/openingもsystem内に置く | 自動使用しない。既存名の関数・文体定数は明示選択する実験用部品として残し、その性質をAPI文書に明記 |
| `runRespond` → `ReplyPort.complete` | ホストのmessagesを受け取る。通常は指示追加なし。ただしsystemの有無・多重化を未検証 | 先頭に非空のsystemが正確に1件あることを検証。文字列はそのまま。動的な組み立ては既存messagesで可能 |
| `respond.ts` のツール上限 | tool結果に「これまでの結果で答えること」を自動挿入 | 未実行・上限到達という結果データだけに変更。toolsを空にする上限制御は維持 |
| `model-call.ts` の通信再試行 | retryableな通信失敗を予算内で1回再試行。同一specを再使用し、補正プロンプトなし | この機構を維持。ホストのSystemContextは最初の試行前に1回解決し、再試行でも同じ文字列を使用 |
| 出力不正・照合 | `fromWire`、settle、participation検証で却下。形式修復をLLMへ要求する経路はない | 検証・却下を維持。固定の修復指示を新設しない |
| `standalone/claude.ts` | 構造化呼び出しはsystem/prompt/schemaをSDKへ渡す。通常応答はsystem群を連結。背景SDKの再試行0、通常応答は2 | 新しい通常応答入口のsystem一意性を試験し、単一systemが同値でSDKへ届くことを確認 |
| `standalone/cli.ts` | 通常応答はrespondSystemに仕事一覧を足してsystem化。背景はruntimeの既定プロンプト | 実験構成を明示選択。履歴・projection・opening・仕事一覧はsystem外のデータに分離 |
| `eval/diagnostic.ts` | 診断条件Dが固定select指示を明示使用。runtime経由ではない | 実験用経路として明示維持 |
| `eval/judge.ts` / `state-judge.ts` | 評価専用モデルの固定採点指示。製品の判断・応答には呼ばれない | 評価者の指示として維持。EumenesのSystemContextへ流入しないことを区別 |
| trace/budget/state-checkのportラッパー | requestを転送・記録する。指示の追加なし | 既存の転送機構を維持 |

`src/`の実際のモデル呼び出し入口は`model-call.ts`と`respond.ts`の2箇所。前者はruntimeのupdate/selectが使用する。reflectは選択結果であり別LLM呼び出しではない。review.due/capacity.pressureもupdate経路を通る。

## 3. 公開API

### 背景推論

`RuntimeDeps.systemContext`を必須にする。値は以下のいずれかとする。

```ts
type SystemContextSource<T> = string | ((input: T) => string);

type BackgroundSystemContext = {
  readonly update: SystemContextSource<UpdateSystemContextInput>;
  readonly select: SystemContextSource<SelectSystemContextInput>;
};

// RuntimeDepsに追加
// readonly systemContext: BackgroundSystemContext | "experimental";
```

- オブジェクト指定時はホスト所有。文字列は前後の空白・改行も含めて無加工で渡す。trimは空白だけの設定を検出するためだけに使う。
- provider関数は呼び出しごとに同期実行する。既存の`todos()`と同じ注入方式を使う。ホストが非同期に取得する資料は、呼び出し前にホスト側で取得し、closure等で参照する。
- providerに渡すものは、その呼び出しに提示する有界なデータの独立したsnapshot（状態、観測、新着ID、時刻、機会、候補、配信履歴、関心・話題・仕事、実行制限）と出力契約。用途別の型を公開し、runtimeの可変状態そのものを渡さない。データは既存の入力から作り、新しい状態モデルを導入しない。
- runtime生成時に両用途の設定の存在・型・静的文字列を検証する。providerの空白・非文字列戻り値・例外も、対象LLMの呼び出しと予算消費の前に`SystemContextConfigurationError`として明示する。通常のLLM失敗やquarantineへ変換しない。
- providerはupdate後の新しい状態を見てselectを構成できる。selectのprovider自体の不正は、そのselectを呼ばずに失敗する（先行して成功したupdateまで遡って未実行とはしない）。
- 設定はruntimeごとに保持し、解決結果を共有キャッシュしない。同じ論理呼び出しの通信再試行ではproviderを再評価せず、最初の文字列とデータを固定する。
- `"experimental"`だけが既存の固定プロンプトを使用する。未指定・不正なホスト設定から戻る経路は作らない。B0も構成を明示するが、従来どおりモデルを呼ばない。

### 通常応答

既存の`runRespond({ messages, ... })`を再利用する。新たなプロンプト合成APIは追加しない。

- 最初のメッセージが非空のsystemで、その後にsystemがないことを、最初のモデル呼び出し前に検証する。欠落・多重化は同じ設定エラーにする。
- system文字列を追加・削除・連結・整形しない。ツール反復でも同一のsystemを保持する。
- 入力メッセージは呼び出し内へsnapshotし、ホスト側の配列・オブジェクト変更や他の応答によって指示が混ざらないようにする。
- `emotion`は既存の出力解釈スイッチとして維持し、感情の選び方・先頭形式の説明を自動挿入しない。
- ホストは、その時点で必要な全文をsystemとして組み立てる。観測・履歴・projection・仕事・ツール結果はsystem以外へ渡す。

### 公開出力契約

既存の`wireUpdateSchema`、`participationSchema`、`participationEmotionSchema`、`fromWire`と検証機構を再利用する。`agencyOutputContract`を公開し、用途・condition・有効な出力拡張に対応するschemaと説明を取得できるようにする。

説明の対象は、操作名、field、null/空配列、localId/既存ID/revision/根拠ref、状態遷移、条件ごとの出力形、拒否される実行、感情の値・受信形式等。保存する話題・発話時機・文体・感情の選び方・仕事の優先順位は含めない。現在wire説明に混ざっている「ユーザーが保留を頼んだ事項」等の意味判断も除く。

schemaは引き続きportへ渡し、受信後に強制検証する。説明文はproviderへ公開するが、SystemContextやuser本文へ自動追加しない。ホストが読み、必要な部分の採用と配置を決める。契約説明の不採用によって実行制約が緩まることはない。

## 4. データと指示の境界

ホスト構成の背景promptは、既存の有界入力を中立なJSONへシリアライズしたものだけにする。観測・状態・tools・limits・due・機会・仕事等をfieldで区別し、Set/Mapは配列へ変換する。文体指定、行動の優先、締めの依頼文、命令を含む見出しは出力しない。動的な本文に命令風の文字列があっても、JSONの値のまま保持し、systemやroleへ変換しない。

参照IDと提示範囲は現行検証と対応させ、権限に必要なfilter、候補の期限・状態、用事の提示窓、件数の上限は維持する。データの提示を利用して独自の意味優先順位は付けない。ツールのdescriptionはホスト提供の公開定義として扱う。

実験構成では既存のプロンプトと比較条件を維持する。通常応答の実験用helperを選ぶ場合も、その関数を呼んだことが明示選択になる。helperのprojection/openingオプションはデータをsystemへ置く従来の例となるため、移行で廃止し、standaloneもデータ側へ移す。変更後は同じ意味評価結果を保証せず、実モデル再評価が別途必要。

## 5. 互換性への影響と移行例

`RuntimeDeps.systemContext`の必須化は破壊的変更。CLI、eval、既存テストの実験利用箇所へ`systemContext: "experimental"`を追加する。配布packageの版を上げ、packの公開export・消費側の型検証も更新する。旧配布物をEumenesが採用している間は新APIは使えない。

`runRespond`の型の入口は維持するが、system欠落・多重化を許していた呼び出しはエラーになる。`respondSystem`のprojection/opening指定は、system外へ移す必要がある。既存のparts・文体定数は実験用と明記し、Eumenesの移行では使用をやめる。

以下は公開型に対応するAPI利用例（`hostInstructions`はホスト自身の構成処理）。

```ts
const runtime = createAgencyRuntime({
  condition: "B1",
  llm,
  tools,
  systemContext: {
    update: input => hostInstructions.update(input),
    select: input => hostInstructions.select(input),
  },
  hostTopics: true,
  hostTodos: true,
  todos: () => currentTodos,
});

await runRespond({
  messages: [
    { role: "system", content: hostInstructions.respond(currentState) },
    ...historyAndReferenceData,
  ],
  chat, tools: replyTools, emotion: false, signal, onDelta,
});
```

ホストが用意するものは、update/select/respondの指示全文、使用する出力契約の理解、既存port・tools・状態/観測/機会等の入力。人格や感情を無効化するためにAgencyの部品を上書きする操作は不要になる。動的関数はAgencyが提示するsnapshotと、ホスト自身の現在設定から全文を構成できる。

## 6. Eumenes側で必要な接続変更（今回の実装対象外）

参照先は`/Users/y.noguchi/Code/eumenes`の現行実装。調査時点の内容であり、この依頼では変更・検証しない。

1. `api/application/agency/host.ts:newRuntime`へ、EumenesのSystemContext資産から構成したupdate/select全文またはproviderを渡す。`utteranceStyle`へ追加する現方式を置き換える。`hostTopics`/`hostTodos`/`utteranceEmotion`はデータ提示と出力契約の設定として維持できる。
2. 同`conversationAgent.system`は現在`respondSystemParts`を返し、`dialogue/service/context-system.ts:systemText`がEumenes資産と結合している。Agencyのparts・TTS定数の参照をやめ、Eumenesを正本とする全文/部品へ変更する。必要な感情の受信形式は公開契約から確認する。
3. `api/application/agency/llm-port.ts`は現在、会話prefixがある場合に`request.system + request.prompt`を`deps.task`へ渡す。新契約ではホスト指定の用途別systemを唯一のsystemとして渡し、promptはデータとして別に保持する必要がある。会話の既存systemを残してTaskへ指示を追加する方式では、用途別全文置換を保証できない。
4. `executeControl`の`instructions`、会話prefix/session再利用、下流のprovider・エラー回復による組み立ても、Eumenesの最終送信境界で捕捉試験する。用途やsystemが違う呼び出し間で旧指示を保持しないことを確認する。
5. 新しい版のtgz、manifest、依存ロックを更新し、Agency接続と利用側dialogue/inferenceの検証を行う。これを終えるまではEumenes接続完了とは報告しない。

## 7. 実装順・検証計画

合意に基づき、次の依存順で実施する。

1. **部分:** 公開出力契約と中立データ型・serializer、SystemContextの検証/解決を追加。契約説明に判断方針が混ざらないことを差分で点検する。
2. **結合:** runtimeのupdate/selectへ注入し、明示的な実験構成を既存利用側へ指定。fake LlmPortの直前入力を保存し、B1/B2/F、通常update・due・pressure・decide内update/selectを検証する。
3. **結合:** runRespondのsystem検証とsnapshot、tool上限結果のデータ化、実験helper/CLIの参照データ分離。fake ReplyPortとSDK clientでツール反復・上限・再試行時の入力を確認する。
4. **通し:** ホスト構成で観測→更新→選択→予約→receipt、通常応答のツール反復を通す。既存実験の回帰試験と`bun run verify`、packの空の消費側検査を実行する。
5. **最終点検:** 担当外の差分がないこと、語句・個別シナリオの分岐が増えていないこと、指示をuser側へ移していないことを確認。API・移行例・固定指示の残存箇所・実モデル確認の有無を報告する。

| 入力捕捉試験 | 合格条件 |
| --- | --- |
| 用途別全文・改行・前後の空白 | `request.system`または単一system.contentがホスト文字列と厳密一致 |
| 動的構成 | 呼び出し時の提示snapshotがproviderへ届き、次の呼び出しで新しい設定・状態が反映される |
| 通信再試行 | update/selectの再試行でも全文・データが同一、provider再評価やAgencyの修復指示なし。予算は各試行で計上 |
| 通常応答のツール反復・上限 | systemが全反復で同一。未実行tool結果に応答方針なし。上限超過を実行しない |
| ホスト/呼び出し間の分離 | 異なるruntime/応答の同時・交互呼び出し、入力オブジェクトの変更で指示が混ざらない |
| 設定の欠落・不正 | 未指定、片方欠落、空白、provider不正、respondのsystem欠落/多重化で該当LLM呼び出し0。設定エラーとして識別可能 |
| データの信頼境界 | 命令風の観測・履歴・tool結果・仕事・話題がsystemへ入らず、JSON値または元の非system roleを維持。Agencyの固定判断文なし |
| 既存の制約 | schema/ID/revision拒否、要承認tool拒否、予算・期限・presence・取消・epochによる古い選択結果の不採用、receipt検証が既存試験どおり |
| 実験構成 | 明示選択時だけ旧指示を使う。ホスト設定失敗時に実験側を呼ばない |

2026-10-31の変更前ベースライン: `bun run verify`成功（format、lint、型、境界、576件中573 pass / 2 skip / 1 todo / 0 fail）。実モデル呼び出し・サーバー起動・Eumenes変更は実施していない。モデルが任意のホスト指示へ従うこと自体は入力捕捉試験では証明できない。

## 8. 現在の残作業

- [x] 全モデル入口・固定部品・データ側の方針・再試行・公開APIの調査。
- [x] Eumenes接続箇所の参照調査、互換性と移行案、変更前verify。
- [x] 本案の合意。
- [x] 公開契約・注入・データ分離・呼び出し側の明示選択を実装。
- [x] 部分→結合→通し検証、差分点検、最終報告。
- [ ] Eumenes接続（別途依頼が必要）。

## 9. 実装した公開契約と移行の補足

packageは`0.1.0`へ更新。`RuntimeDeps.systemContext`、`BackgroundSystemContext`、`SystemContextSource<T>`、`UpdateSystemContextInput` / `SelectSystemContextInput`、`UpdateModelData` / `SelectModelData` / `ModelStateData`、`SystemContextConfigurationError`を公開した。providerの引数は`{ data, outputContract }`で、`data`はJSONとしてLLMへ渡すものの独立したコピー。ホストは設定とこのsnapshotから全文を構成する。providerからdataを変更しても、呼び出し用に先に確定したJSONと実際の状態・検証入力は変更されない。

`agencyOutputContract("update" | "select", { condition, hostTodos?, utteranceEmotion? })`は用途別のschemaとdescriptionを返す。B0には推論契約がない。通常応答の受信形式は`replyOutputContract.description`で公開した。これらの説明文をAgencyがメッセージへ加えることはない。schema、`fromWire`とsettle/participation/receipt検証は従来のまま実行する。

`respondSystem`から`projection` / `opening`オプションを削除した。必要な場合は`respondReferenceData({ projection, opening })`でエスケープ済み資料を作り、user等のデータメッセージに配置する。これは参照資料の整形だけを行い、発話判断や人格の指示を含まない。独自のJSON等で資料を渡してもよい。信頼境界をLLMへ説明する文は、ホスト自身のSystemContextに置く。

```ts
const data = respondReferenceData({
  projection: runtime.projection(7),
  opening: recentOpeningUtterances,
});
const messages: ReplyMessage[] = [
  { role: "system", content: hostReplySystemContext },
  ...(data ? [{ role: "user" as const, content: data }] : []),
  ...conversationHistory,
];
```

`respondSystem` / `respondSystemParts` / 文体定数は明示利用する実験用指示として残る。通常応答の実験helperは、参照資料を別メッセージへ出す構成に対応し、従来は資料の有無で追加していた参照資料の注意書きを常に含む。背景の旧固定指示は`systemContext: "experimental"`指定時だけ使う。evalの診断条件Dと採点モデルの固定指示も評価専用として残る。ホスト構成の製品経路で自動追加する固定判断指示はない。ツール上限の未実行結果は`{"executed":false,"reason":"tool_call_limit"}`というデータであり、応答方針を含まない。

CLIと既存の実験/評価/回帰試験は旧構成を明示選択するよう移行した。通常応答の参照資料テストは、エスケープ・出所・確信度・訂正状態の検査を保ち、注意書きは実験用system、観測本文はデータ側にあることを検査する構成へ移行した。入力捕捉試験の追加先は`test/core/system-context.test.ts`、SDK境界は`standalone/test/claude.test.ts`。pack検査は配布物の公開宣言だけで利用例を型確認し、必須設定の省略と旧データオプションが型エラーになることも確認する。

## 10. 検証結果（2026-10-31）

| 段階 | 実施と結果 |
| --- | --- |
| 部分 | `system-context.test.ts`の契約・設定・有界データ試験: 3成功 |
| 結合 | SystemContext、runtime、通常応答、参照資料の回帰、SDK、packの9ファイル: 207成功・1 skip・1 todo・失敗0 |
| 通し・送信境界 | ホスト構成での予約→receipt→完了、通常応答のツール反復、SDKの最終送信を含む2ファイル: 40成功・失敗0 |
| 既存全体手順 | `bun run verify`: format、lint、型、依存境界が成功。595件中592 pass / 2 skip / 1 todo / 0 fail。変更前から成功試験が19件増え、skip/todoは同じ |
| 評価データ | `bun eval/main.ts validate --suite p0e`（dev 24件）、`--suite p1e`（dev 88件）が成功。実モデルによる意味評価ではない |
| 配布 | `bun run pack`成功。JS公開export、宣言ファイル、外部消費側の型確認、配布内容検査が成功 |

配布物は`artifacts/pack/eumenes-agency-0.1.0-bf34e9de9e6f.tgz`。SHA-256は`5a5a08cbe057777b4e9f0d172abcdd5d438389a8e55d1375fa294cca86052a4f`、対応するmanifestは同ディレクトリ。未コミットの作業ツリーから生成したためmanifestの`dirty`はtrue。Eumenesのvendor・設定・コードには反映していない。

差分点検: domainのsettle・権限・予算・取消・receipt検証や状態モデルの変更なし。新しい分岐は明示構成、用途、既存の構造的なcondition/出力契約によるものだけで、個別発話やシナリオの判別は追加していない。Markdownは既存formatter設定の対象外であり、文書は目視と差分で確認した。

**Agency単体の対応・決定的試験・配布物確認は完了。Eumenesへの接続は未実施。実モデルを呼び出す試験、実会話、音声実機確認は未実施。** 任意のホスト指示への意味的な追従や、プロンプト変更後の自然さは本試験の保証に含まない。Eumenes接続時は§6の変更と下流の入力捕捉が必要。

## 11. 後続の全体レビュー

同日、利用者の追加依頼でAgency全体を横断レビューし、初回の入力捕捉試験だけでは捉えていなかった6種類の不整合を修正した。詳細は[全体レビューと修正](review-2026-10-31.md)。最新版は`0.1.1`、`HOST_RULES_VERSION`は`host-rules-6`。最終のverifyは606成功・2 skip・1 todo・失敗0。上の0.1.0と592成功は初回対応時点の記録であり、最新の配布manifestは0.1.1を指す。

公開した追加契約は`budgetConfigSchema`、`limitsSchema`、`replyResultSchema`、`ReplyOutputError`。OFFとinvalidateは更新・待機中の機会にも適用し、OFF中のprojectionを止める。背景推論と通常応答は共通の取消処理を使い、背景出力をcoreでも再検証する。ホスト所有SystemContextの契約、データとの分離、Eumenes側を変更しない範囲は維持した。
