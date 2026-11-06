# Eumenes Agency 総合80点に向けた改善実装計画

## 実装状況について

2026-11-06追加: 利用者の後続指示により、現在の目標は将来性と分けた「単体完成度80点超え」である。Memory側レビューを踏まえた次の実装順は[ホスト入力の出典契約と本流互換の仮想結合計画](host-input-provenance-2026-11-06.md)を優先する。最初にAgencyの出典契約、その後にF・独自指示・話題・TODOでの忘却後継続を通す。以下の初期の総合配点・対象範囲は当時の記録として残す。

後続の実装依頼に基づく作業記録は[改善の実装・検証記録](../docs/improvement-progress-2026-11-05.md)、実行手順は[API検証](../docs/api-validation.md)を正本とする。以下の「今回未実装」「今回の作業に含まない」は計画作成時の記述である。条件付き目標と実測点を混同せず、採点のrubricと総合80点という到達基準は変更しない。CI関連の追加・検査・実行履歴の確認は、後続の利用者指示により対象外とする。

作成日: 2026-11-05。対象: `eumenes-agency` 0.1.3、基準コミット `79c0418d3a27ec2f3ae878e74a48c251d4fe6add`。

## 1. 目的と完了の定義

前回レビューの4件の不整合と、技術品質・プロジェクトの可能性の全評価項目に残る課題を改善する。同時に、Claude Haiku APIとOpenAI APIのGPT-6 Lunaを、同じ評価ケース・契約・記録方式で利用できるようにする。

利用者の「トータル80点」という要求に対し、本計画では**総合点＝技術品質50%＋プロジェクトの可能性50%**と定義する。比較を継続できるよう、既存の2つの点数も必ず別々に示す。配点の変更で到達扱いにしない。

完了には次のすべてが必要である。

1. 同一の実装スナップショットに対する両評価が正式評価になる。基準はreview-software-project rubric 1.1.0、technical profileはagent、深度はdeep以上。適用対象の全60項目に根拠を付け、未評価を都合よく除外しない。
2. 丸め前の総合点が80以上で、技術品質・プロジェクトの可能性がそれぞれ75以上になる。片側だけの高得点で、もう片側の重大な不足を埋めない。
3. F01〜F04が修正前に再現し、修正後に回帰・反証確認を通る。未解決のCritical/High、重大な疑い、基準の弱体化、個別会話例への専用分岐が残らない。
4. Haiku・Lunaそれぞれの直接API経路で、状態更新、参加判断、通常応答を含む会話評価、内容・状態の採点を実行できる。利用不能な経路を別モデルやCodex CLIへ黙って切り替えない。
5. 固定試験、API接続試験、未見ケース、独立した人の評価、実利用、負荷・復旧、配布・依存検査について、実施条件と失敗を含む記録が揃う。

全作業を実装しても、需要や継続利用の結果が十分でなければ総合80点には到達しない。仮説が支持されない場合は結果を残し、範囲や方式を見直す。ソース修正だけで利用者の評価や長期の実績を作ったことにはしない。

## 2. 現在地と変更範囲

| 基準値 | 現状 |
| --- | --- |
| 技術品質 | 暫定54.6/100、根拠充足率92.3%、信頼度Medium |
| プロジェクトの可能性 | 総合点保留、根拠充足率51.7%。需要・差別化・継続利用などが未確認 |
| 総合点 | 未算出。片側の正式点がないため、現時点の総合点を推測で埋めない |
| 決定的検証 | 794 pass、24 skip、1 todo、0 fail。部分121件、結合113件も成功 |
| 確定した不整合 | Medium/P1が4件。実ツールを動かさない追加probeで再現 |
| 現行API | `standalone/claude.ts`のMessages API。Lunaのinitiative評価は隣接EumenesのCodex CLI接続 |
| 保存と実行 | RAM coreとsnapshot・revision sink。永続保存、実行、権限、忘却の最終責任はホスト |

Agency内の変更対象は`src/`の既存制御、`standalone/`の推論アダプター・設定・CLI、`eval/`の既存評価器・記録、`scripts/`、試験、配布、設計文書である。追加するOpenAI SDKは開発用依存に置き、配布coreへ含めない。

Eumenes/Pursuit本体のコード変更、製品DBのmigration、認証変更、本番展開、音声機器への配信は別の統合範囲とする。本計画には必要な受入条件と引渡し契約を含めるが、その範囲に失敗を見つけてもAgency作業のついでに修正しない。ホスト変更が必要と分かった時点で、再現証拠・影響・最小差分を示して担当範囲を決める。

今回作成したのは計画書と条件付きの採点計算資料である。追加指示により、共通の環境変数名を既存Haiku経路へ接続する小変更も行った。W1〜W10の本実装、Luna直接API接続、課金API呼出し、利用者募集、他チャットへの送信は今回の作業に含まない。

## 3. 先に再利用する既存機構

編集前に関連するSystemContext、モデルへ渡る資料、利用可能なツールと共通制御を確認する。最初の案は次の再利用とする。

| 要求 | 再利用先 | 最小の拡張 |
| --- | --- | --- |
| 待機中wakeの取消 | `runtime.ts`のepoch・serial・`decide`の投入時検査 | wakeにも同じ世代と入力捕捉を適用 |
| 0予算と使用量 | `ActivityBudget`、call budget、`LlmResult`、`CallOutcome`、共有meter | 初回判定、使用量の帰属、ホスト返却時の計上 |
| 観測の所有権 | ledgerのclone・freeze、snapshotのclone | 公開される入れ子も保護 |
| Haiku/Lunaの選択 | `LlmPort`、`ReplyPort`、`createClaudeLlm`、既存設定・schema | core外のOpenAI adapterと小さな生成関数 |
| API schema | `agencyOutputContract`、元のZod schema、nullable共有処理 | APIごとの表現差をadapter内で処理し、元schemaで再検証 |
| 実験と採点 | replay、scenario、judge/state-judge、trace、caseHash、digest、agreement | provider情報、共通の失敗分類、未見集合、交差採点 |
| 保存・復旧 | snapshot、revision sink、既存ホストの単一writerと配信台帳 | 保存の実装を二重化せず、障害注入と有界化の契約を整える |

意味理解・重要度・関心・意図・話す内容・新旧の根拠の関係はLLMが判断する。コードは契約・認可・容量・時間・会計・永続化の制約を強制する。会話の語句、既知シナリオ名、期待回答に合わせた正規表現・辞書・固定回答を製品へ入れない。providerやエラー種別に応じた分岐は外部API仕様との接続に限定する。

## 4. 実装順と依存関係

| 作業単位 | 内容 | 先行条件 | 完了証拠 | 相対規模 |
| --- | --- | --- | --- | --- |
| W0 | 基準点・再現例・未評価項目を固定 | なし | baseline台帳、ソースhash、再現ログ、評価項目一覧 | S |
| W1 | F01〜F04の制御修正 | W0 | 修正前失敗、修正後成功、反証試験、全体verify | M |
| W2 | 使用量・設定・provider共通契約 | W0、W1の予算契約 | 型と会計fixture、設定互換・digest試験 | M |
| W3 | Haiku/LunaのAPI adapter | W2 | mock HTTP試験、実API smoke、契約捕捉 | M |
| W4 | 全評価入口のAPI化と共通記録 | W2、W3 | 各入口×2providerの接続・再開試験 | M |
| W5 | 保持・飽和・忘却・永続復旧 | W1、W2 | bounded checkpoint、障害注入、再起動・照合 | L |
| W6 | 安全・意味品質・単純方式との比較 | W1、W4、W5 | 未見比較、交差採点、人の監査、停止・注入試験 | L |
| W7 | 性能・費用・会話競合の改善 | W4、W5、代表負荷 | 改善前後の同条件計測、回帰予算 | M〜L |
| W8 | 保守・配布・依存・利用導線 | W1以降、W3の依存確定 | ローカル検証、依存/権利台帳、クリーン導入・更新・復旧。CIは利用者指示で対象外 | M |
| W9 | 需要・継続利用・差別化・体制 | W0から調査、実利用はW6・W8後 | 独立観察、継続利用、比較結果、維持資源 | L＋観察期間 |
| W10 | 同一基準で再評価・残課題判断 | W1〜W9 | 正式な2評価と総合点、残課題0または次計画 | M |

S/M/Lは既存境界の数、公開契約への影響、必要な検証の種類に基づく相対規模であり、所要日数の見積もりではない。人の評価、API費用、本体側の変更権限、独立レビュー担当、維持時間の確保はそれぞれ明示的な依存条件である。

W1→W2→W3→W4を先に成立させる。その後W5・W6・W7・W8の証拠を揃え、W9の実利用を評価する。W10は各段階の途中評価にも使うが、未完了段階の想定内の失敗を不具合として追わない。

変更先と試験の対応は次を起点とする。「新設候補」は実装前に既存機構で代替できないか確認する。

| 作業 | 主な変更先 | 検証・成果物 |
| --- | --- | --- |
| W1 | `src/application/runtime.ts`、`activity-budget.ts`、`src/domains/experience/ledger.ts` | `test/core/agency-consistency.test.ts`、`wake-runtime.test.ts`、`shared-budget.test.ts`、`ledger.test.ts` |
| W2 | `src/contracts/ports.ts`、`runtime.ts`、`src/application/model-call.ts`、`standalone/settings.ts`、新設候補`standalone/usage.ts` | 使用量の正規化・帰属・再送・設定互換・digestの試験 |
| W3 | `standalone/claude.ts`、新設候補`standalone/openai.ts`、`providers.ts`、`package.json`、`bun.lock` | `standalone/test/claude.test.ts`、新設候補`openai.test.ts`、provider contractとsmoke |
| W4 | 第7節に列挙したrunner、`eval/contracts.ts`、`trace.ts`、`replay.ts`、`judge.ts`、`state-judge.ts`、`standalone/cli.ts` | 入口別対応表、provider別の試行・採点manifest、resumeの互換/拒否試験 |
| W5 | `src/application/snapshot.ts`、`runtime.ts`、`revisions.ts`、`projection.ts`、`src/contracts/runtime.ts`、ledger | `snapshot-restore.test.ts`、`revisions.test.ts`、新設候補`retention.test.ts`と別プロセス復旧harness |
| W6 | `eval/cases/`、`scenario.ts`、`judge.ts`、`state-judge.ts`、`label.ts`、`compare.ts`、既存のmemory-poisoning試験 | 開発/検証/最終集合のmanifest、交差採点、人の監査、閾値・失敗記録 |
| W7 | 既存の仮想時計・複数日harness、必要なら新設`eval/performance/`、`eval/budget.ts` | 同条件baseline/改善後のJSON、会話競合・保持・費用の回帰gate |
| W8 | `scripts/verify.ts`、`pack.ts`、境界検査、README、契約文書、必要なLICENSE/NOTICE | ローカル検証、clean consumer、依存/出所台帳、第三者の導入/更新/復旧記録 |
| W9 | 計画と集計は`docs/`、合成評価の公開可能な結果は`eval/results/`、実会話と同意記録は専用の非追跡保存先 | 課題・比較・継続利用・体制・展開の根拠。個人情報をGitへ追加しない |
| W10 | `spec/reviews/`または版付きの評価成果物 | 実スナップショットのreview/score-summary、共通項目比較、総合計算 |

各作業の担当はAgencyの実装担当を起点とする。W5の本体取引境界はホスト担当、W6の独立ラベルとW9の参加者調整・資源確保は別の担当を実施前に明記する。担当未定の作業は完了扱いにしない。

## 5. W0とW1 不整合の修正

### W0 基準と受入条件を固定する

前回の`review.json`、`score-summary.json`、再現probeとnegative controlを、基準コミット・実行条件とともに保全する。着手時のHEADと作業差分が異なる場合は、前回の不整合がまだ存在するか確認し、修正済みの項目を再実装しない。794件は基準記録であり、将来の成功件数を固定するテスト期待値にはしない。

既存の`spec/verification-plan.md`、`host-contract-v1.md`、`host-system-context.md`と本計画の役割を整理する。本計画を今回の作業順・受入条件の正本とし、公開API契約は実装に対応する文書を更新する。過去の実験結果はその時点の記録として保持し、現在の能力として参照しない。

### F01 待機中wakeの世代確認

対象: `src/application/runtime.ts`、`test/core/agency-consistency.test.ts`、`wake-runtime.test.ts`。

`wake`の呼出し時にepochとホスト入力を捕捉し、serialの中へ入った時点で世代を検査する。実行中のupdate/selectの既存検査も維持する。新しい取消方式は作らない。

受入試験は、先行呼出しをlatchで待たせ、wakeを投入し、invalidate・OFF→ON・新入力・speech.startedを挟む組合せとする。古い投入からの追加推論・状態確定・ticketは0、新しい世代の呼出しは正常に動くこと。待機中のhost入力の外部変更にも影響されないこと。`decide`を使う既存negative controlと同じ契約になることを確認する。

### F02 初回0予算

対象: `src/application/activity-budget.ts`、runtimeの設定捕捉、`shared-budget.test.ts`、`wake-runtime.test.ts`。

利用記録がない場合も0利用として上限を検査する。toolCalls・tokens・elapsedMsの0は活動禁止として扱う。負数、NaN、Infinity、不適切な小数などは値の契約に従って入口で拒否し、共有meterと内部meterで揃える。呼出し元が設定を後で変更しても制約は変わらない。

0・上限直前・ちょうど上限・超過を、初回、継続、復元、共有meterで試す。上限を緩めて通す変更をしない。予算切れからの再開は、もともとの活動単位とscope予算の契約に従う。

### F03 活動トークン使用量

対象: `src/contracts/ports.ts`、`contracts/runtime.ts`、`application/model-call.ts`、`activity-budget.ts`、runtime、ホスト使用量の受付契約。

usageの正規化はW2で定める。すべてのAPI呼出しはscopeの呼出回数・使用量・費用へ計上する。活動IDがまだないupdateを、LLMに推測させたりコードで均等分割したりして意図へ割り当てない。選択結果によって活動が確定したselectと、ticket/workRefに束縛されたツール・委譲の使用量を、その活動へ帰属させる。活動へ帰属しないupdateもscope予算から消えない。

ホストからの使用量は`usageId`と実在するticket/workRefに結び付ける。再送は一度だけ計上し、同ID異内容を拒否する。失敗・切断・取消にも利用量が返れば計上する。取得できない場合はunknownとして残し、0消費と断定しない。取消後の遅着usageの会計は状態採用と分離する。

実際に消費したトークンを取り消すことはできない。受信した使用量が上限に達したら次の呼出し・予約を止め、進行中の委譲はホスト契約に従って中断する。厳密な事前上限が必要な委譲には、既存DelegationRequestとホストの上限を使う。新たな活動へ移ってもscopeの累積使用量はリセットしない。

受入試験は複数意図、select前のupdate、通信再試行、修正呼出し、キャッシュ利用、委譲拒否、部分結果、遅着、重複、復元を含む。費用台帳に同じ請求を二重加算せず、scopeと活動それぞれの制約は適用されること。

### F04 観測の入れ子の不変性

対象: `src/domains/experience/ledger.ts`、`ledger.test.ts`、`snapshot-restore.test.ts`、`agency-consistency.test.ts`。

入力のcloneに加えて、返却する観測の`refs`、`speechHandoff`とその配列など、公開される入れ子を不変にする。既存の冪等返却と相性がよい既知フィールドのfreezeを第一案とし、必要なら返却コピーを選ぶ。汎用の不変データフレームワークは追加しない。

元入力、observeの返却、同IDの冪等返却、recordResultの返却、snapshotの入れ子を変更しても内部出所と本文が変わらないこと。元内容の再送が成功し、実際に内容が異なる再送だけが競合になること。

## 6. W2とW3 HaikuとLunaの直接API経路

### 6.1 接続方針

```text
既存の評価入口と会話CLI
  → 設定とproviderを検証する小さな生成関数
  → Anthropic Messages adapter / OpenAI Responses adapter
  → 共通LlmPort・ReplyPort
  → 既存schema・settle・参加検証・予算・trace
```

`src/`は引き続きproviderを選択せず、SDK、秘密、直接ネットワーク、実時計を持たない。新しいエージェント実行器は追加しない。

2026-11-05に確認した公式仕様では、HaikuのClaude APIモデルIDは`claude-haiku-5-5`、Lunaは`gpt-6-luna`である。LunaはResponses APIと構造化出力を利用できる。アカウントでの利用可否は実API smokeで別に確認する。[O1][A1]

### 6.2 設定と互換性

`standalone/settings.ts`をproviderで判別できる設定へ拡張する。背景・通常応答・judgeを個別に指定でき、役割ごとのモデル・provider・推論設定をmanifestへ保存する。

| 共通設定 | Anthropic固有 | OpenAI固有 |
| --- | --- | --- |
| provider、model、timeout、出力上限、設定版 | effort、thinkingHeadroomなど現行で必要な値 | reasoning.effort、reasoning.mode、出力総予算 |

Anthropicの`thinkingHeadroom`をOpenAIへそのまま送らない。Lunaのreasoning effortは指定し、暗黙の既定値を比較条件にしない。最初の比較はstandard/lowを候補とし、正式試行前に固定する。API間の同名effortが同一計算量とは扱わない。[O1][O3]

旧設定は読込境界でAnthropic設定へ明示的に正規化する。新しい設定版とadapter/transport版をdigestへ加え、旧結果と混ぜたresumeは拒否する。生成用digestとjudge用fingerprintの分離は維持し、judge変更で生成をやり直さず、採点結果だけを別版として追加できるようにする。

APIキーは利用者が`.zprofile`へexportしている**`CLAUDE_API_KEY`と`OPEN_AI_API_KEY`を優先して読む**。標準名の`ANTHROPIC_API_KEY`と`OPENAI_API_KEY`も互換名として受け付ける。SDKへ明示したapiKeyが最優先、次に利用者指定名、最後に標準名とする。空白のみの値は未設定とみなす。プロジェクトごとの`.env`作成やキーの複製を要求しない。

読込は`standalone/api-keys.ts`に置き、ログインシェルからプロセスへ継承した環境変数を使う。アプリから`.zprofile`を解析・sourceしたり、キー取得のために毎回シェルを起動したりしない。新しいターミナル、または`source ~/.zprofile`で設定を読み込んだシェルから起動する。既に起動したGUIアプリ等がその環境変数を継承していない場合は、設定済み環境から起動し直す。`.zprofile`と既存`.env`の内容は変更しない。

値を設定JSON、コマンド引数、manifest、traceへ保存しない。片方だけの検証ではもう片方のキーを要求しない。fixture/selfモードでキーやネットワークを要求しない。APIモードとSELF_PORT_DIR等の曖昧な同時指定は拒否する。

この環境変数の解決と、既存Haikuの背景/通常応答/3つの比較runnerの接続は今回の小変更として実施済みである。OpenAI側の解決関数も用意したが、Lunaの直接API adapterへの接続と実通信確認はW3で行う。環境変数の存在確認と、認証・課金が成立するAPI試験を混同しない。

### 6.3 使用量と費用をproviderから切り離す

現行UsageMeterはAnthropicのUsage型とキャッシュ倍率に依存する。provider側で正規化し、共通会計は少なくともprovider、要求モデル、返却モデル、requestId、usageId、入力総数、キャッシュ読込/書込、出力総数、推論トークン内数、成功/拒否/途中終了/取消、計測時点、単価版、推定USDを記録する。

入力総数の定義はキャッシュ分を含めて統一する。OpenAIのcached tokensを入力総数へ二重加算せず、reasoning tokensを出力総数へ再加算しない。Anthropicのinput/cache read/cache creationの集計差はadapterで扱う。providerが返さない値はnull/unknownとし、模擬値の0とは区別する。

単価表はprovider・モデル・コンテキスト長・キャッシュ方式・service tier・確認日で版管理する。未知のモデルや料金条件を0ドルとして継続しない。まず明示エラーで止め、利用者が設定した上限を適用できる既知条件で再開する。単価の高いモデルへ自動fallbackしない。[O4][A1]

既存`withCommandBudget`とspend台帳を再利用する。生成・採点・smoke・再試行を同じ実行予算へ含める。最初は直列実行とし、使用量確定後の超過は最大1進行中呼出しとその上限として明示する。アプリの停止条件とprovider請求額の厳密上限は区別する。並列化する場合は同じ台帳の予約処理を追加し、複数プロセスがそれぞれ満額を使える状態にしない。

### 6.4 Haiku adapter

`standalone/claude.ts`を維持し、共通UsageMeterへの依存へ置き換える。構造化出力は現行`output_config.format`とSDK helperを利用する。既存のnullable共有は、文法サイズの失敗を再現して必要性を確認したうえで、provider schema変換として共通化する。[A2]

元Zod schemaとwire→typed→settleの検証を残す。enum、必須欄、上限を落としてAPIを通さない。Haikuで未対応のtemperature等を比較用に追加しない。[A1]

### 6.5 Luna adapter

新設候補: `standalone/openai.ts`。公式OpenAI JavaScript SDKを実装時点で互換確認し、開発用依存として版を固定する。

背景update/selectとjudgeはResponses APIへ、SystemContextをinstructions、資料をinput、出力契約を厳密なJSON schemaとして渡す。元のSystemContextへ指示や例を自動混合しない。`store: false`を基本とし、評価の継続状態はローカルで管理する。

構造化出力のroot、required、additionalProperties、nullable、unionなどの制限を、実際のupdate/select/judge全schemaで確認する。SDK helperがZod 4.4.3と合わない場合は、意味を保持した公式JSON schema経路を使い、元Zodで受信再検証する。JSON modeへの自動降格や必須項目の削除はしない。[O2]

refusal、incomplete、出力上限到達、無効schema、401/403、429、5xx、timeout、切断、取消を分ける。SDK内の自動retryは背景呼出しでは無効にし、既存callModelの予算付き再試行を使う。要求モデルと返却モデルが異なる場合は、明示したalias/snapshot契約だけを許し、モデル同一性を未確認のまま成功にしない。

通常応答のReplyPortも対応する。ストリームのtext delta、function callのcall_id、引数、tool resultを既存runRespondへ写す。推論モデルが継続に必要とするprovider固有itemは、公式SDKの契約に従い、その応答系列内だけで保持する。会話間で共有せず、推論本文を通常traceへ出さない。ツールの実行可否は従来通りToolPortが担う。

### 6.6 adapterの受入

mock HTTPでは、送信system/data/schema、全ての停止理由、429/5xx、キャンセル前/途中/遅着、usageの有無、キャッシュと推論使用量、モデル不一致、通常応答の複数tool call・上限・endを検証する。

API smokeは各providerについてupdate/select、内容judge、状態judge、通常応答とfixture toolの往復を通す。実モデルと実際のrequest/usageを記録する。キーなし・権限なし・未対応schemaは設定/接続失敗として残し、意味品質の失敗と混ぜない。

## 7. W4 評価入口とCLIの統一

全ての検証を一つの新規runnerへ移植するのではなく、既存入口のモデル生成と記録だけを共通化する。変更候補は`standalone/providers.ts`、`standalone/usage.ts`、`eval/provider-contract.test.ts`で、実装時に既存モジュールへ収まるなら新規ファイルを減らす。

| 入口 | 必要な対応 |
| --- | --- |
| `eval/main.ts run/judge` | background/judgeそれぞれのprovider指定。P0/P1、trace、resume、失敗停止、予算を維持 |
| `eval/live-b1-f/run.ts` | Claude生成・judgeの直接生成を置換。B1/B2/Fとproviderの条件を明示 |
| `eval/f-fusion/run.ts` | F/Fusion比較を両providerで実行。変換とモデルの効果を分ける |
| `eval/action-steps/run.ts` | 段階別比較を両providerで実行。段階とproviderを独立して記録 |
| `eval/initiative/run.ts` | direct APIを追加。既存codex-cliを明示モードで保持。ホストの指示/受付fixture選択と推論providerを分離 |
| `eval/h4.ts`、`p3b.ts`、`h10-scene.ts`、`h11-scene.ts`、`h13-scene.ts`、`sfault-scene.ts` | self/fixture経路を保持したまま、同じscene関数へLlmPortを渡してAPI実行できるようにする |
| `standalone/cli.ts`とlive会話試験 | backgroundと通常応答をprovider生成関数経由にする。対話履歴と実際に表示した発話を維持 |
| memory-poisoning等のopt-in live試験 | providerを選択可能にし、選択経路がskipされたのに合格としない |

上表にない実モデル/self-port入口も、W0で`*.ts`に限定した検索で棚卸しする。歴史的結果ファイルを全文検索してノイズを増やさない。すべての移行対象について対応済み・歴史的再現用・非対象の理由を記録する。

API評価は隣接Eumenesのcheckout、Codexログイン、製品DBなしでも実行可能にする。initiativeの実ホスト受付は明示したhost-fixture laneとして残し、checkoutがない場合はそのlaneだけ未検証とする。ホストの非公開SystemContextをAgencyへ無断複製しない。ローカル評価は明示したAgency指示、ホスト評価は版固定したホスト指示を用い、結果を混合しない。

新設/拡張予定の操作例は次のとおり。**現時点では未実装のCLI契約案**であり、現在実行できるコマンドとして案内しない。

```sh
# 共通設定ファイルを全runnerへ渡せるようにする
bun eval/main.ts preflight --settings config/eval-api.json --provider openai --model gpt-6-luna
bun eval/main.ts smoke --settings config/eval-api.json --provider anthropic --budget-usd <amount>
bun eval/main.ts run --name <new-run> --suite p1e --settings config/eval-api.json --split unseen --conditions B1,B2,F --reps 3 --budget-usd <amount>
bun eval/main.ts judge --name <new-run> --settings config/eval-api.json --judge-provider openai --judge-model gpt-6-luna --budget-usd <amount>
bun eval/initiative/run.ts --transport api --settings config/eval-api.json --provider openai --model gpt-6-luna --reps 2 --budget-usd <amount>
```

`preflight`の既定は通信しない設定・schema・単価・キー存在の検査とする。通信する最小接続確認は明示したsmokeに含める。API呼出しの有無、概算呼出数、生成/採点を含む予算を実行前に表示する。過去のimplicitな課金経路は互換性を記録し、新しいモードでは明示した経路のみを選ぶ。

manifestにはsource commit/dirty hash、caseHash、指示/schema/transport版、provider、endpoint、要求/実測モデル、effort/mode、出力上限、単価版、順序、seedの有無、期待値/ラベル版、judge fingerprintを保存する。resumeキーに必要な識別子を含め、provider違いを同一試行へ上書きしない。

## 8. W5 保持量と永続復旧

現状は全観測をRAMとsnapshotに残す。前回の小測定では256文字の観測10万件でserialized snapshotが約35MBだった。これは本番SLOの失敗を証明する値ではないが、長期間の保持契約を必要とする根拠である。

先にホストの既存会話DBを原文の正本として、coreに必要な活動状態、直近観測、引用・取消・未確定結果のメタデータ、処理cursorだけを保持する契約を定める。新しい全文記憶ストアは追加しない。

観測配列を単純にsliceしてseqを振り直さない。createdSeq/stateSeq、cursor、独立根拠判定、遅着receiptが壊れるため、snapshotの次版では元seqとhigh-water markを保存する。処理済みの除去範囲、保持する根拠、未処理範囲を区別してvalidate/restoreする。旧版読込みと、誤った版・穴・重複の拒否を試験する。

保持の根は開いた意図・候補・活動中/結果不明のattempt・未処理観測・照合待ちreceiptとする。原文はホスト参照へ退避できても、失効・忘却・出所検査に必要な情報は残す。保持量の上限に達して根を安全に減らせない場合は、新規自発活動を抑えてbackpressureを返す。未処理入力や不明な副作用を黙って捨てない。意味的な要約・関心整理を追加するなら既存LLM更新経路で提案させる。

件数・UTF-8 bytes・未処理件数・receipt照合余力・履歴期間の初期値は、代表負荷を計測して凍結する。上限到達、連続busy、戻らない委譲、巨大結果、保持根が多数残る場合に、RAM/DB/queueの増加と最古待ち時間を確認する。

一時SQLiteと別プロセスの最小hostで、保存前、保存transaction途中、commit後/dispatch前、dispatch後/receipt前、receipt保存中を強制停止する。再起動後にpending、予算、cursorを復元し、実行台帳と照合する。旧音声を再生せず、結果不明ツールを自動再実行しない。operationKeyの重複と同ID異入力を確認する。ホスト契約だけでは満たせない箇所があれば本体側の依存として報告する。

忘却は元観測、派生状態、revision履歴、projection、trace/export、古いbackup復元に対して検証する。直接引用されていない生成入力依存もホスト契約で照合し、削除待ちの間は古い候補の公開と実行を止める。全削除を記憶の正しさの代わりにしない。

## 9. W6 安全性と有用性の検証

### 9.1 固定契約と実モデルの意味を別に測る

権限・古いticket・予算・未処理観測の順序・scope・停止・重複・復元は決定的なfixtureで検査する。内容、意図、関心の粒度、自然さ、適切な介入時機はLLM採点と人の評価で検査する。schema合格率、候補形成率、選択到達率、ホスト受付率、実行成功率、配信成功率を別の分母で報告する。

記憶汚染では、文書→ツール結果→保存→想起→再起動の経路、複数の一見無害な資料の組合せ、訂正済み情報の再出現、自分の発話の反復、同一実行の別ID再送を含める。承認必須の実行はコードで0件を維持し、誘導された提案自体の発生と、実行が止まったことを別集計する。

既存A-MemGuard todoは、実モデルで必要性を再現し、出所の提示・既存SystemContext・retrieval/update情報の改善から試す。防御専用の意味分類器や語彙辞書を先に追加しない。別の整合性確認呼出しが必要なら、既存呼出しで失敗する証拠、予算、通常時の有用性への影響を示して最小範囲で追加する。

### 9.2 比較条件と未見集合

主要比較は**B1、B2、F × Haiku、Luna**。同じ観測、時刻、ツール、権限、想起可能資料、出力/活動予算、停止条件を用いる。方式ごとの状態契約は保持する。B0は介入なしの利用体験の対照として使い、B0との比較だけで複雑な状態の必要性を主張しない。Fusionと4段階版は探索用の副比較とする。

既存devを開発用に固定し、新規の検証集合と最終未見集合を別に準備する。初期案は検証24シナリオ、最終40シナリオ×3反復×3方式×2provider＝720試行。これは標本数の案であり、検出したい差とシナリオ内相関から事前に規模を点検する。反復を独立した利用者数と数えない。

題材の言い換えだけでなく、根拠あり/なし/訂正済み、撤回、完了、競合、長履歴、利用者不在、部分結果、主会話への割込み、資料注入を含める。最終未見集合のラベルは実行前に独立担当が固定し、生成モデルに渡さない。途中で結果を見て指示や期待値を変えたら、その集合を開発用へ移し、新しい未見集合を準備する。

### 9.3 採点の独立性

Haiku生成の主要judgeはLuna、Luna生成の主要judgeはHaikuとする。自分の生成を自分で採点する値は診断用に分ける。provider、方式名、反復順をjudgeに見せず、同じ観測と実際の発話/toolInputを渡す。全外向き行動と、層化抽出した待機例を人が監査し、取りこぼしも確認する。

人の採点は開発担当以外を含む2名を基本とする。時機、役立ち方、根拠、本文の完成度、負担、撤回の扱いを事前rubricで判断し、一致率・不一致の種類・解決方法を残す。モデルjudgeの値を人の正解へ無条件に変換しない。

### 9.4 暫定受入閾値と失敗時の判断

以下は研究上の確立値ではなく、本計画の初期受入案である。W0/W6開始前に実用途と測定可能性を確認して凍結し、結果を見て緩めない。

| 指標 | 初期受入案 |
| --- | --- |
| 契約違反による無権限・取消後・古い予約の採用 | 固定試験で0件。実モデルの試行でも試行した攻撃と通常成功率を併記 |
| 撤回/完了後の不適切な再提案 | 最終集合の重大違反0件。単に候補が作れない停止と区別 |
| API/出力契約を満たして最終機会まで到達 | provider・方式別に95%以上。予定全試行を分母とする補助値も必須 |
| 必要機会での有用行動 | 人の監査後80%以上を初期目標。取りこぼしを別分類 |
| 不要な介入 | 5%以下を初期目標。件数とシナリオ単位の区間を併記 |
| 人が役立つと判断した外向き行動 | 80%以上。計画文だけの出力は有用発話に数えない |
| Fを選ぶ追加価値 | 最良の単純方式に対する有用行動の+5ポイント、または同等有用性で費用/負担を20%改善する案を事前選択 |

比較差はシナリオ単位の対応比較と区間で示す。差を実証できなければ「優位未確認」とする。Fが有利でない場合は、既存のB1/B2またはより単純な契約を採用候補にする。必要な状態を削って正しさを失わず、複雑さに見合う実用価値を求める。モデルjudgeの較正不足や標本不足は成功扱いにしない。

## 10. W7 性能と費用

API adapterの差、方式の差、ホスト競合の差を分ける。過去のCodex CLI接続での中央値59.3秒を、直接APIや会話開始の性能と同一視しない。

測定はwarm/cold、通常会話のみ/背景競合、記憶なし/あり、1千/1万/10万相当の入力履歴、保持上限到達前後で行う。通常応答のTTFT、背景update/select、queue待ち、取消から論理復帰、snapshot/restore、RSS、CPU時間、使用トークン、成功した有用行動当たりUSDを記録する。provider側キャッシュの有無と実行順を記録する。

会話への初期増分予算は既存計画を踏襲し、追加foreground LLM=0、背景同時1、会話開始中央値+100ms以内、TTFT中央値の増分が5%または100msの大きい方以内、生成速度の中央値低下5%以内とする。背景用の呼出枠、10分/1分などCLIとlibraryの異なる既定値を混ぜない。取消後の論理復帰はローカルfixtureでp95 100ms以内を初期案とする。

まず各条件10組の対比較で見込みと測定手順を確認する。p95を合否に用いる経路では100回以上を初期案とし、分布とばらつきから件数を再検討する。実APIの遅延目標は接続smoke後、正式比較前に利用目的から固定する。達成できない目標を結果に合わせて下げず、モデル設定・入力量・schema表現・起床機会を既存機構で改善して再測定する。

費用は固定の「安いモデル」という評価にせず、推論、採点、失敗、再試行、キャッシュ、コンテキスト料金を含める。正式matrixの費用はsmokeの実測使用量から見積もり、実行時に明示する。現在の50 USD設定を新しい比較の自動承認額としない。予算不足なら完了数と未実施を保存して停止する。

## 11. W8 保守性 配布 依存 運用

### 構造と変更容易性

runtimeの1,416行を行数目標で分割しない。W1〜W5で実際に変更する責務について、依存方向、状態正本、共通制御の適用漏れを確認する。provider生成、会計、schema表現、復元/保持が独立して変更される箇所だけを切り出す。実験用フラグの有効条件と組合せ表を公開契約・試験へ反映し、無効な組合せは入口で拒否する。

重複した費用計算とprovider生成を整理し、すべての公開非同期入口で取消・予算・入力捕捉が適用されることを一覧と試験で確認する。READMEの古い「未接続」記述と日付別の結果を区別し、現在の対応、実験のみ、未検証を更新する。

### ローカル検証と配布

CIの追加・検査・実行履歴の確認は利用者の追加指示により実施しない。今回追加したworkflowも削除する。実行済みのローカルverify、配布物の消費側検証、実API検証を結果として残す。

意味のある変異検査またはnegative controlで、epoch検査、0予算、参照/版/承認検査、入れ子保護を故意に外すと試験が失敗することを確認する。コード行をなぞるだけの試験を増やさない。

dist-only pack、公開export、型消費側、SHA-256/commit/版manifest、secret/実験資料の非混入を維持する。クリーン環境への導入、旧snapshotからの更新、復旧、削除を実行し、snapshot版とpackage版の互換条件を示す。公開配布しない段階で不要な署名基盤を増設しない。

### 依存と権利情報

実行依存、開発依存、配布物に含む依存を分けて棚卸しする。既知脆弱性の検査はscanner版・照会日・実際の到達経路を残し、警告の件数をそのまま品質点にしない。問題が到達可能なら更新・緩和し、依存更新後に契約試験とpackを再実行する。

MIT宣言、実際のLICENSE、配布に必要なNOTICE、参考実装から取り込んだコードの出所・版・条件を照合する。未確認の著作権者を作らない。必要な判断は所有者へ確認し、未確認のまま権利評価を加点しない。

### 利用と運用

初めて使う開発者が、キー設定、非課金preflight、smoke、実験、判断理由の確認、予算停止からの再開、ログ削除まで実行する受入を行う。パスやエラー本文に秘密が出ないことを確認する。/off、無応答上限、判断理由、mock toolの表示、実際に表示した本文の履歴反映を維持する。

## 12. W9 プロジェクトの可能性を裏付ける作業

コードの完成とは別に、利用者の課題・便益・継続性を確かめる。需要がないことを「説明不足」と決めつけて機能を追加しない。

| 評価軸 | 実施すること | 得たい証拠・判断 |
| --- | --- | --- |
| 課題の価値 | 対象を継続課題のある会話利用者に絞り、実際に再開を忘れた場面と現在の対処を聞く | 作者の仮定から独立した複数の具体例、頻度、時間/機会損失、介入を歓迎する条件 |
| 解決方法 | 合意した課題を通常のやり方とAgencyで扱う | 発話数ではなく解決/再開できた件数、負担、誤認、完了後の停止 |
| 差別化 | B1/B2/Fと、手動メモ・通知・既存ホスト機能を同じ仕事で比較する | どの条件で選ぶか、単純方式で十分な条件、移行に見合う利点 |
| 新規性 | 先行研究とLetta/LangGraph等の現在の機能を一次資料で照合する | 増分的な統合の貢献。記憶/BDI/自発性自体を新発明にしない |
| 導入 | クリーン導入を第三者が実施し、時間・失敗・支援工数を測る | 初回価値までの費用、既存データ移行、設定、サポート負担 |
| 到達と継続 | 動機のある対象へ紹介し、実利用後も使うか観察する | 実際の導入、離脱理由、再訪、数週後の役立ち方。募集数だけで採用扱いにしない |
| 持続的な価値 | 評価コーパス、統合契約、運用知識を維持し、代替への置換も試す | 複製可能でも残る選択理由。データ囲込みや未証明の参入障壁を主張しない |
| 実行力 | 各改善を失敗事例・利用者のフィードバック・受入結果と結び付ける | 実利用の指摘から、修正・再評価・再発防止までの記録 |
| 時機 | 現在の利用者の必要性、API利用条件、費用、統合先の準備を確かめる | 今取り組む理由と、モデル/API変更時の応答手順 |
| 継続体制 | 保守責任、確保できる時間、API費用、秘密管理、引継ぎを決める | 短期のコミット数に依存しない維持・復旧・更新の実績 |
| 展開 | 最初の用途の成立後に、隣接する実課題を1つ試す | 同じcoreで得る便益、追加工数/費用、開始/撤退条件。想像上の用途列挙を点数にしない |

初期の運用案は、探索の聞き取り5〜8名、実利用8〜12名を2つの時期に分けて各2週間以上、継続観察4週間以上とする。人数・期間は実行案で、一般化や有効性の保証ではない。対象ユーザー、参加者、費用、担当時間、利用記録の扱いをW9開始前に確定する。単独利用者だけの場合は個人向け事例として評価し、対象集団の需要・継続性を満たしたことにしない。

初期の実利用受入案は、割り当てた課題での役立つ介入80%以上、不必要な介入5%以下、支援なしの初回完了80%以上、導入時間中央値30分以内、4週後にも本人が価値を理由に利用する割合60%以上とする。分母、信頼区間、対象選択の偏り、離脱、支援工数を併記し、閾値を満たすだけでrubricの4を自動付与しない。

実会話をAPIへ送る前に参加者の同意範囲と保持・削除方針を決める。合成試験と実利用を別の結果として保存する。実利用に移る前は、全て模擬workerまたは許可した読み取りだけとし、送信・購入・削除を試験のために追加しない。

## 13. 80点を裏付ける項目別目標

### 13.1 技術品質の条件付き目標

0〜4のanchorを使う。3は代表的な例外まで確認、4は重要な境界・失敗・反証を強い証拠で検証した状態であり、実装完了だけでは達しない。下表は**必要証拠が得られた場合の仮定**である。

| 軸/重み | 項目順と現状anchor | 目標anchor | 必要な追加証拠 |
| --- | --- | --- | --- |
| architecture / 12 | boundaries=3、flow=2、fit=2 | 4、3、3 | 境界検査・実消費側・変更の局所性、保持/統合の制約との適合 |
| correctness / 15 | contracts=2、edge_cases=1、concurrency=1 | 4、4、4 | F01/F02/F04、全公開入口、境界値、待機列/取消/復元の障害注入とnegative control |
| security / 18 | access=3、input_secrets=2、abuse=2 | 3、3、3 | host権限/秘密境界、保存を介した注入と正常時有用性、複合資料/再起動 |
| reliability / 12 | failure=3、recovery=2、resilience=2 | 3、3、3 | 実保存/dispatch窓の停止、照合、飽和、依存障害からの回復 |
| maintainability / 8 | clarity=2、change=3、debt=2 | 3、3、3 | 実際の複数変更で局所性、実験設定表、文書整合、引継ぎ |
| common_components / 5 | duplication=2、reuse=3、abstraction=2 | 3、3、3 | 両provider/全入口の共通制約と会計の一貫性、実利用のある最小interface |
| testing / 10 | risk_coverage=3、quality=3、automation=2 | 4、4、3 | 重要境界の欠陥検出、変異/反証、人とlive評価の限界管理、ローカルでの再現。CIは対象外 |
| supply_chain / 8 | dependencies=?、build_release=3、license=? | 3、3、3 | 到達性を伴う依存点検、クリーン配布/更新、実際の出所/権利台帳 |
| performance / 7 | budget=1、hot_path=?、measurement=2 | 3、3、3 | F03修正、代表負荷・保持上限・会話競合・費用の回帰計測 |
| operability / 5 | signals=3、lifecycle=2、interaction=2 | 3、3、3 | 第三者の導入/診断/停止/更新/復旧/削除、プライバシーを保つ有用な信号 |

全項目3の場合は75点。上表の6項目を4とする重みは25⅔%で、条件付き目標は`75 + 25⅔ × 0.25 = 81.4166…`、表示は**81.4点**となる。

### 13.2 プロジェクトの可能性の条件付き目標

| 軸/重み | 項目順と目標anchor | 必要な追加証拠 |
| --- | --- | --- |
| problem / 15 | need=4、impact=4、validation=4 | 複数の独立した課題観察、損失と便益のbaseline、反復確認 |
| solution / 15 | mechanism=3、experience=3、outcomes=4 | 代表制約での動作、観察された導入体験、対照に対する反復した実利用成果 |
| differentiation / 10 | alternatives=3、advantage=4、tradeoffs=3 | 同じ仕事と制約で代替を比較し、選択に値する利点を測定 |
| novelty / 5 | prior_art=2、substance=2、verification=2 | 有用な増分的貢献を裏付ける。根拠のない新規性の加点を求めない |
| adoption / 15 | entry=3、reach=3、retention=4 | 実測した導入費用、動機のある利用者への到達、反復した持続利用と便益 |
| defensibility / 5 | assets=3、substitution=3、incentives=3 | 維持される資産、代替後も残る効用、継続投資の実績 |
| execution / 10 | delivery=3、focus=3、feedback=3 | 実利用と結び付く納品、資源管理、改善の循環 |
| timing / 5 | drivers=3、readiness=3、window=3 | 現在の需要・利用可能な環境、実行時期と変化への対応 |
| health / 10 | ownership=3、activity=3、governance=3 | 責任と引継ぎ、適切な更新、意思決定と資源の継続 |
| expansion / 10 | adjacency=3、scalability=3、path=3 | 需要が確認された隣接用途、実測費用、資源と段階条件を備えた展開 |

全項目3の75点から、4を求める6項目の重み28⅓%を加点し、新規性3項目の重み5%を2に留める。条件付き目標は`75 + 28⅓ × 0.25 - 5 × 0.25 = 80.8333…`、表示は**80.8点**となる。

両目標の合算は丸め前で**81.125点、表示81.1点**。これは工程を終えれば必ず得られる予測ではなく、実装・運用・評価の証拠がこのanchorを支持する場合の計算例である。別の項目構成で80点に到達してもよいが、採点理由は実際の証拠から決める。

条件付き台帳と計算結果はローカルの`artifacts/improvement-plan-2026-11-05/`へ保存する。現在評価の台帳は変更せず、ExpectedとRe-evaluatedを分離する。計算にはskillの`score_review.py`を使い、独自の点数加算や集計の手修正をしない。

## 14. 検証手順 中止条件 引渡し

各変更は**部分→結合→通し**の順で進める。決定的な制御の修正は先に失敗例を固定し、API adapterはmock HTTPから実API smokeへ進み、その後に未見matrixを実行する。保持と復旧は一時DB・別プロセスで確認し、最後に許可されたホスト受入へ進む。省略したlaneには理由と、どの主張が未確認になるかを付ける。

通常の全体gateは現行`bun run verify`を起点とする。packの外部消費側、API contract、復旧、負荷、意味評価、人の評価は各作業単位に対応する追加gateとする。新しいコマンド名は実装時にpackage/scriptsと文書へ同時に登録し、存在しないコマンドを成功報告に使わない。

W10ではsource/依存/設定/指示/ケース/採点の版を固定し、検証中に編集しない。前回と共通の評価項目も比較し、未知項目を調べたことだけを品質向上と呼ばない。全60項目の証拠と反証を点検し、rubricの正式点、coverage、confidence、gatesと総合計算を保存する。独立した人または別途許可されたレビュー担当に、重要指摘と4のanchorを再確認してもらう。

同じ目的の3ラウンド、新しい根拠のない同一失敗、検証中の編集、最新計画からの逸脱があれば、次の編集/再実行の前に俯瞰する。増えた証拠、減った残作業、未解決の仮説と次の判断を現在の会話へ短く報告する。正常に進行中の長時間処理は時間だけで止めない。モデル出力を繰り返して成功例だけを採用したり、最終未見集合を再利用して合格を狙ったりしない。

実行予算到達、利用不能なAPI、必要なhost権限/参加者/維持資源の不足、検出力不足、改善仮説の不成立では、差分・完了済み証拠・残作業・再開条件を残す。80点未満なら未達項目を根拠付きで次の計画へ戻し、採点基準を変更しない。

### 完了チェック

- [x] W0: baselineと全評価項目の追跡表を固定した。
- [x] W1: F01〜F04の修正前失敗・修正後成功・negative controlが揃った。
- [ ] W2: provider共通の設定・usage・予算・digestが一貫している。
- [ ] W3: Haiku/Lunaの背景・judge・通常応答が直接APIで動く。
- [ ] W4: 全移行対象の入口が2providerで検証され、self/fixture/host laneが区別される。
- [ ] W5: 保持・飽和・忘却・別プロセス復旧を通した。
- [ ] W6: 未見比較、交差採点、人の監査、注入/撤回の結果が揃った。
- [ ] W7: 代表負荷、会話競合、使用量、費用の予算を満たした。
- [ ] W8: 依存・権利・配布・第三者導入/復旧を確認した（CIは対象外）。
- [ ] W9: 需要、便益、継続利用、代替比較、体制、隣接展開の証拠が揃った。
- [ ] W10: 両評価のcoverage100%、各75点以上、総合80点以上を実スナップショットで確認した。
- [ ] 最終差分に担当外変更、個別例への依存、意味判断を代替する固定分岐、弱めた期待値がない。

## 15. 参照仕様と計画作成時の確認

以下は2026-11-05に本文を確認した一次資料。価格、モデル利用権、SDKの対応は実装/実行時にも再確認する。

- [O1 GPT-6 Luna model](https://developers.openai.com/api/docs/models/gpt-6-luna): モデルID、Responses、構造化出力、reasoning effort。
- [O2 OpenAI Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs): 厳密schema、SDK helper、拒否と不完全応答の扱い。
- [O3 OpenAI Reasoning mode](https://developers.openai.com/api/docs/guides/reasoning#reasoning-mode): modeとeffortの区別。
- [O4 OpenAI API pricing](https://developers.openai.com/api/docs/pricing): provider側の料金条件と確認先。
- [A1 Claude Haiku 5.5 overview](https://platform.claude.com/docs/en/models/haiku-5-5/overview): モデルID、effort、パラメータ、コンテキスト別料金。
- [A2 Claude Structured outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs): Messages APIの出力形式とschema制限。
- 既存契約: [ホスト接続契約](host-contract-v1.md)、[SystemContext](host-system-context.md)、[検証計画](verification-plan.md)、[研究根拠](research-basis.md)。

計画作成時はソースと公式仕様の確認、条件付き採点の計算と文書の点検を行った。追加指示に基づく環境変数名の対応は、疑似キーの部分試験26件、結合試験52件、今回の差分だけを基準コミットへ重ねた隔離コピーの全体verifyで検証した。全体は798 pass、24 skip、1 todo、0 fail。format/lint/型/境界/配布消費側も成功し、検証中に今回の対象ファイルが変わっていないことをhashで確認した。

`.env`を無効にしたログインシェルで、`.zprofile`から両providerのキーを利用できることを真偽値だけで確認した。実キーの値は表示・保存せず、新しいAPI接続やlive評価は実行していない。作業中に検出した担当外のinitiative周辺の変更は保持し、今回の成功件数には混ぜていない。文脈支援は本計画と環境変数対応でcontext_compile 2回、compile_eval 2回（会話全体では各3回）。
