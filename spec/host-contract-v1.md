# ホスト接続契約 v1 案

2026-10-21、レビュー改訂。**考案段階・未実装**。今回は調査と設計までとし、実装は別途依頼・設計合意を得てから進める。公開名は実装時に型へ固定し、意味の変更は版を上げる。本書はEumenesの既存契約に追加接続する案であり、既存exportの説明ではない。未出荷のv1案を更新したもので、稼働契約を変更していない。

## 1. 入出力

入力は `HostObservation`、`Opportunity`、`CapabilitiesSnapshot`、`PolicySnapshot`、有界な `MemoryView` / `WorldView`。ホストが取得・検証し、LLMの返答からホスト入力を合成しない。

| 型 | 主要field |
| --- | --- |
| Scope | principal、agentId、scopeKey、conversationId? |
| HostObservation | eventId、scope内のeventSeq、scope、kind、actor、occurredAt、receivedAt、SourceRef[]、causationId/rootEventId、action/result/delivery ref? |
| SourceRef | namespace、kind、id、representation?、revision、digest、range?。Memoryと構造的に対応 |
| Opportunity | id、scope、trigger、contextRevision、instructionRevision、sessionGeneration、presenceRevision、now、presence(speaking/quiet/unknown)、foregroundBusy、playerBusy、reference refs |
| CapabilitiesSnapshot | revision、公開ツール定義の参照・入力schema・副作用・制約・利用可否。credentialなし |
| PolicySnapshot | revision、featureEpoch、enabled、grant refs、残予算、頻度制限、許可媒体。LLMは変更不可 |
| MemoryView / WorldView | 許可された資料の抜粋、出所と版、範囲とcoverage、missing/blocked、usage receipt。全件でないことを明示 |

イベント種別は契約上の出来事（exchange.adopted、action.observed、delivery.observed、source.changed、input.changed、speech.started、opportunity.opened、capacity.pressure、review.due等）とする。自由文からイベント種別を正規表現で作らない。元イベントのpayloadは観測資料であり命令ではない。

出力は `UpdateProposal` と `ParticipationProposal`、採否の `DecisionRecord`、通常応答用の `AgencyProjection`、予約した `ActionTicket`。LLMは観測・receipt・権限の書込み操作を返せない。

- UpdateProposal: 基準state revision、提示された根拠refs、belief/interest/preference/desire/goal/state/candidateの追加・改訂・終端案、projection用の選択refsと順序、通常応答との照合結果（どの応答のどの部分でどの候補を伝えたか。照合は別呼出しにせずこの提案に含める）。各操作はローカルIDまたはexpectedRevision付き既存IDを指す。最小構成で未採用の概念への操作は返させない。ops空のno_changeを正常に受理する。
- ParticipationProposal: opportunityId、候補IDとrevision、speak/tool/reflect/wait/discard、関連する根拠、簡潔な理由、意味上の条件の評価、任意の完了検証案。waitはcandidateRef不要、reflectは提示された根拠refsで指定できる。外向きspeak/toolとdiscardには既存候補の参照が必要。候補を新規作成する場合は先にUpdateProposalとして検証する。
- ActionTicket: candidateId/revision、opportunityId、stateRevision、contextRevision、instructionRevision、sessionGeneration、presenceRevision、policyRevision、featureEpoch、grant/capability revision、source receipts、expiresAt、operationKey。ホストだけが発行する。
- AgencyProjection: version、選択した項目と出所、確認状態、未伝達候補、非表示件数、token予算。安定した人格設定やユーザー指示の代わりにはしない。

## 2. 公開操作案

| 公開操作 | 実行場所・責務 |
| --- | --- |
| `recordObservationInTransaction(db, input)` | 同期。scopeと出所を検証しイベントIDで冪等受領。元観測の成功/失敗はホストが決める |
| `prepareInTransaction(db, eventBatch, hostSnapshot)` | 同期。出典、revision、忘却epoch、grantを固定し、boundedなPreparedStepを返す |
| `infer(prepared, modelPort, signal)` | transaction外。構造化出力を一回要求し、未信頼の更新案を返す。保存・発話・ツール実行はしない |
| `settleInTransaction(db, prepared, proposal, current)` | 同期。形式と参照・現在性・状態遷移・予算を再検証。依存グループ単位で確定または全rollback |
| `projectInTransaction(db, access, budget)` | 同期。有効な計算済み状態だけを返す。LLMを呼ばない |
| `prepareOpportunityInTransaction(db, opportunity)` | 同期。期限切れ等を除外し、意味判断に必要な有界候補を提示。物理的に不可能ならhold |
| `select(preparedOpportunity, modelPort, signal)` | transaction外。関連性・衝突・有用性をLLMが判定。待機も選択可 |
| `reserveInTransaction(db, prepared, participation, current)` | 同期。採用直前に再検証し、排他的なActionTicketと外向きdispatch待ちを保存 |
| `recordActionResultInTransaction(db, ticket, hostReceipt)` | 同期。実行結果、部分配信、失敗、取消、結果不明を保存。問題解決を自動申告しない |
| `invalidateInTransaction(db, change)` | 同期。入力・設定・根拠・権限の変更でticketと派生projectionを失効 |
| `recoverInTransaction(db, hostReceipts)` | 同期。再起動の照合結果に基づき回復。照合不能な副作用を自動再実行しない |
| `forgetInTransaction(db, roots)` | 同期。依存閉包の本文・候補・projectionを除去し、receipt確認前に再利用を禁止 |

prepareとreserveで外部ネットワークを呼ばない。新しい入力で機会が失効した場合、長期状態を失わず機会の再評価へ戻す。形式エラーの更新を一部だけ黙って保存しない。

no_changeでも当該処理単位の採用記録は残すが、意味状態のrevisionは増やさない。参照依存グループを確定するときは、既存項目と新規ローカルIDの依存を含めて検査する。項目の意味上の根拠と、生成に使った全入力の依存は別に保持する。全入力依存は忘却・再検討の対象を広めに取るためであり、全入力が主張を支持したという意味ではない。

## 3. 保存

coreへ貸す `AgencyDb` は query/statement の構造的型。接続を開閉せず、PRAGMA、BEGIN/COMMIT、migration適用をしない。ホストが `write(syncCallback)` と `readSnapshot(syncCallback)` を提供する。製品では既存の単一writerを使い、Memory・World・Agencyを跨ぐ保存も同じtransactionで公開操作を呼ぶ。

表名は `agency_` prefix。最小の所有領域は observationとsource依存、可変状態と履歴、候補と実行、処理単位/cursor/outbox。具体的table数は実装時に最小化する。scope外参照、破損したJSON、schema版の不一致を拒否する。

migrationは追記のみ、id/sql/checksum/schemaVersionを公開。参照同一性はID/revision/digest。再送キーはeventId、unitId、candidateId/revision等の構造化IDに由来し、文章の正規化から作らない。

予約とdispatch待ちは同じtransactionで保存。ホストがcommit後にdispatchし、receiptを戻す。commit直後の停止ではdispatch待ちを復元する。speakは再起動後に古い音声を再生しない。toolはoperationKeyで状態照会してから回復し、照会不能ならoutcome_unknownにする。exactly-onceを外部サービスまで保証したことにしない。

## 4. 注入port

| port | standalone | Eumenes統合 |
| --- | --- | --- |
| ModelPort | 固定Providerと、Claude API を `@anthropic-ai/sdk` で直接呼ぶ実モデルadapterを明示選択。初期routeは Claude Haiku 5.5（実験設定で指定、[P0-E §3](p0e-experiment.md)）。主会話と背景は別インスタンス | inferenceの構造化control、保存済みrouteとcatalog/claim。model名の固定なし |
| RuntimePort | イベント駆動、単一背景task、仮想時計/AbortSignal | queue handlerのprepare/execute/settle、foregroundBusy/onActivity、単一writer |
| MemoryPort | 一時DBの公開Records/ExternalDependent/feed/forget API | memory domainが所有する公開操作。製品DBをstandaloneから直接開かない |
| WorldPort | 一時DBのreadWorldSnapshot/validateWorldUsage等 | world domainの公開操作。receiptとforget/restore/policy版を再検証 |
| ActionPort | 有限の安全なfixture道具、内部整理、待機、テキスト配信 | 登録tool-runtimeとdialogue/voice。権限・確認・取消・receiptは既存のもの |
| PresencePort | speaking/quiet/unknownの明示イベント | VAD・現在player・session generationを順序付きで接続。不明なら自発発話を保留 |
| Clock/Id/Telemetry | 注入値、構造化イベント | ホストの時計/ID/Pino・相関ID |

portの未接続・blockedは空の成功として扱わない。Memoryが無効・利用不可ならその資料を参照した更新を拒否し、通常会話は継続する。Worldが無効なら新規のWorld参照を行わず、以前のWorld根拠に依存した候補の実行も再検証が通るまで保留する。

## 5. Memory / Worldとの依存と忘却

Memory ExternalDependent はproviderRefを `eumenes-agency` とし、externalIdをscope＋項目ID＋revision＋依存分割番号から作る。Memoryの登録上限に従い、黙った切捨てはしない。登録失敗時はAgency保存もrollback。sourceキーの正規化はMemory/ホスト公開契約に合わせ、独自のID変換を増やさない。

World assertionだけを根拠にした場合も、そのusage receiptとWorldの変化/忘却を追う。可能な根拠についてはMemoryのsource/state依存も登録する。Worldの依存閉包をMemoryの外部依存だけで追えると仮定しない。standalone adapterでWorldの変更とMemoryの変更の両方を検証する。

生成時の全input manifestと項目ごとの引用refsを分ける。忘却は、直接引用されなかったが生成に使用した入力にも届かせる。新revisionが増えても古いrevisionの依存を失わないよう登録し、履歴本文もforgetの対象にする。削除待ちや古いbackup復元中はgateを閉じ、journal照合が完了するまでprojection・候補実行を止める。

訂正・版変更・反証を受けたら、根拠→解釈→意図→候補→projectionの依存閉包を先に使用保留にする。新しい版への張替えで旧解釈をそのまま有効にしない。LLMが訂正の影響を再評価し、現行refsでsettleした項目だけを戻す。訂正は旧版を履歴として保持し、忘却は履歴本文も除去する。既存の外部依存登録だけで訂正の意味伝播が済むとは仮定しない。

自分の発言・要約・解釈がMemoryへ戻っても、causationと元のrefsを引き継ぎ、独立観測へ格上げしない。新しい裏付けがないまま、再読回数による確信強化を更新指示で禁止し、live試験で検出する。コードは由来と版付きの生成依存の循環を検査し、証拠の意味的な独立性を語句で判定しない。関連・競合の相互参照は生成依存の循環とは別である。

フラグOFFでも根拠失効・forget・復旧の保護処理は続ける。OFFは推論・projection・新規dispatchを止め、既存goalや根拠を消す操作にはしない。ONへ戻しただけでは旧ticketを復活させない。

## 6. 発話・ツールの採用

通常応答を優先し、speech-startや新しい入力を受けたらホストがまずfenceを進め、その後controllerをabortする。AbortSignalだけに遅着防止を委ねない。ticketはreserve時、文章/結果採用時、再生開始と区間投入時に検証する。

発話の配信状態は `prepared / started / partial / delivered / interrupted / unknown`。画面表示と音声配信を別媒体で記録。再生ackは配信の技術的確認であり、聞き手が内容を理解した保証ではない。共有目標に理解確認が必要なら、その確認も完了条件に入れる。

ツールは現在のcatalog定義、入力schema、scope、grant、確認条件に従う。LLMのapproved=trueや過去の承認をgrantにしない。特に実製品の自発originは未接続なので、P1〜P4ではfake host/許可された実験用読み取り操作までとする。外部送信・購入・削除を新設しない。

通常応答と自発発言は同じ配信観測へ接続し、responseId・媒体・区間・receiptを持つ。通常応答が採用されたらcontextRevisionを進め、競合する古いticketを失効させる。背景の照合提案は応答後の UpdateProposal の中で「どの応答のどの部分で候補を伝えたか」を返し、ホストは実在する配信済み範囲に限定して受理する。文面が同義かはLLM評価のまま残す。照合前は当該意図の候補を再dispatchしない。表示のみ、部分音声、理解確認なしを完全達成にしない。

P5の文章生成は、通常依頼か、有効な自発ticketに基づく発言かをホストの入力型で区別する。自発モードの固定指示は候補の表現だけを許し、新しいツール権限やユーザー指示を生成しない。現行のCURRENT_REQUESTを正本とする通常会話指示への接続は未実装であり、独立した統合検証項目とする。

## 7. 設定とログ

standaloneの保存設定にenabled、budget、frequency、projectionBudgetを持つ。Eumenes採用時はsettings domainのschema/永続化/変更epochに加える。既定OFF、変更時はfeatureEpochを進める。既存のsettings・grantをLLMのstate updateから変更できない。

ログはevent名、trigger/eventId、runId/jobId/requestId、scopeの安全な識別子、参照IDとrevision、状態遷移、候補ID、結果code、hold/executeの理由code、件数、時間、token、再試行・取消回数。例: `agency.observation_received`, `agency.update_applied`, `agency.proposal_rejected`, `agency.candidate_held`, `agency.action_reserved`, `agency.action_observed`。

意味判断の短い理由は検証可能な構造化決定として台帳に持ち、JSONLには既定で理由codeと参照IDだけを出す。会話本文、設定、認証情報、Provider生応答、長い思考過程をログに残さない。公開診断の欠落をエラー本文のコピーで埋めない。

## 8. 意図・候補・試行の遷移

意図は望む状態と、完了/再開/再検討/撤回条件、reviewAfter（必須、ホストが上限を検査）、競合refs、次に必要な観測を持つ。全項目を最初から別tableにする必要はない。本節が状態名・遷移・理由codeの唯一の正本であり、plan.md は本節を参照するだけにする。状態と正本は次のように分ける。

| 対象 | 状態・遷移 | 採用条件 |
| --- | --- | --- |
| 意図 | proposed→adopted→completed。proposed/adoptedからheld/abandoned、held→adopted。外部の根拠があれば proposed・held からも completed（保留中や採用前に解決した場合）。作成時の状態は proposed / adopted / held（held で作った意図の候補は adopted になるまで提示しない） | 意味判断はLLM。権限・現在性はホスト。実行中かどうかは意図の状態に持たず、候補・試行から導く。完了は条件に合う検証根拠、終端からの再発は新ID |
| 候補 | pending↔held、pending/held→reserved→executing、executing→held（試行が failed/interrupted/outcome_unknown のときホストreceiptで）、executing→closed（試行 succeeded）、pending/held/reserved→closed | heldはholdReason必須（下記）。closedReasonはfulfilled/expired/superseded/dismissed/goal_terminal。全予約は一つのlive試行を指す |
| 試行 | not_started→running→succeeded/failed/interrupted/outcome_unknown | ホストreceiptのみ。開始前取消はinterrupted＋started=false。生成失敗とツール失敗はstageで区別 |
| 配信 | prepared→started→partial→delivered、またはinterrupted/unknown | 媒体ごと。text表示とaudio再生を分離。partialをdeliveredへ自動昇格しない |

holdReason は次の5つ。理由ごとに held を抜ける条件が違うため、一つの held に混ぜない。

| holdReason | 設定者 | 抜ける条件 |
| --- | --- | --- |
| blocked_physical | ホスト（speaking/foregroundBusy/playerBusy/presence不明） | 次の機会で物理条件が解け、LLMが再評価する |
| deferred | LLMの参加判断（wait） | 候補の意味上の適用条件を次の機会でLLMが再評価する |
| awaiting_reconcile | ホスト（通常応答の採用直後） | 応答後のupdateで照合が確定する |
| after_failure | ホスト（試行が failed/interrupted） | LLMの再評価と、現行の権限・根拠・予算・外部仕様上の再試行可否 |
| awaiting_outcome | ホスト（試行が outcome_unknown） | 照会で確定したreceipt。それまで同一作用の新しい予約をしない |

結果不明は成功・失敗と区別した照合待ち。照会で確定したreceiptを得た場合のみ試行を確定し、結果の履歴を残す。失敗・中断・結果不明の候補はheldへ戻すが、自動で再実行しない。結果不明の操作が残る間は同一作用の新しい試行を予約しない。LLMによる別の名前付けでこの制限を回避できると仮定せず、ホストの操作対象とoperationKeyの契約も照合する。

既知の失敗から再試行する場合は、LLMの再評価、現行の権限・根拠・予算、外部仕様上の再試行可否が必要。attemptIdを新しくし、operationKeyの再利用可否は外部操作の冪等契約に従う。succeededは候補の実行が成功したことを示すだけで、意図のcompletedとは独立。完了済み候補の言い換え再作成も意味評価に含める。

TTLは候補の実行可能期間、reviewAfterは意図を再検討する時点とする。reviewAfter到達を達成・撤回に変換しない。再評価できるまで保留できる。終端意図が持つ未実行候補を閉じても、開始済み操作のreceipt照合は完了まで続ける。

## 9. 容量、選択、処理待ち

初期容量案はscopeごとに未処理観測128、開いた意図16、開いた候補32、最小構成で分離する場合のbelief/desire等は合計64。数値は文献の推奨値ではなく負荷試験の初期設定である。本文bytes、履歴保持量、結果照合用の保存余力もP1開始時に設定し、未設定で無制限の保存を始めない。

1. eventSeqはホストがscope内で割り当てる受領順、occurredAtは出来事の時点として別に保持する。遅着・同一時刻・重複を区別し、eventId再送で本文が異なれば競合として拒否する。
2. 満杯の観測は受領成功にしない。`backpressured` と継続位置を返し、ホスト側の耐久キューに残す。再送できない入力源では欠落とcoverageを明記し、全経験を保持したと主張しない。取消・forget・権限失効はこの推論待ちキューを経由せず即時保護する。
3. 処理済みcursorは確定した連続範囲だけ進める。no_changeは処理済み、不正提案・取消・未処理の穴は未処理のまま。後続の採用済みunitは個別記録し再採用を避ける。同じ失敗を繰り返すunitは隔離し、通常会話を止めず、欠落と再開条件を可視化する。
4. コードによる集約は同一イベントIDの再送や、明示された上位revisionとの置換関係に限定する。訂正・結果・拒否を最新の雑談で上書きしない。内容の重要性や要約はLLMが提案する。
5. 推論入力は固定したtoken予算内で、未処理の古い観測からページを渡し、ID順等の安定順で同点を解く。意図/候補の再検討は背景で選ばれたfocusに加え、未評価項目を順番に提示する枠を持つ。これは閲覧機会の公平性であり、発話優先度のコード判定ではない。非表示数、最終評価時点、最古の未処理時間を記録する。
6. 容量不足では新しい状態の追加を拒否し、既存の完了・撤回・忘却・結果照合を優先する。圧縮で残す意味はLLMが提案し、元の依存は失わない。DB空き容量や保存失敗でreceiptを耐久化できない場合は新規dispatchを止め、通常会話へ縮退する。保存済みの未確定結果を消して容量を空けない。
7. 既存の観測/結果に起因する有限のupdate→select→生成は許す。自己状態の変更だけで新しいrootイベントや無限のreflectを作らない。例外はホストが発行する二つのイベントで、`capacity.pressure`（開いた意図または候補が容量の80%に到達）と `review.due`（reviewAfter到達）。どちらも同一の対象・revisionについて一回だけ発行し、背景予算を消費する。これがないと、古い意図が容量を埋めたまま整理の契機がなく、新しい関心を受け入れられなくなる。
8. 背景の枠は1つで、実行順をホストが決める。LLMを使わない保護処理は即時。機会より前に受領した未処理観測のupdateをselectより先に行う。両方を賄う予算がなければselectを見送りwaitとする。selectの開始時に入力したstate revisionは、reserveで再検証する。試行予算はrootとscopeの両方へ課す。結果受領を理由に予算をリセットしない。
9. foreground競合や予算切れでは待機と欠落を区別する。再開は次の有効な機会か明示操作とし、常時pollingはしない。静かな機会が来ない間の自発性は保証しない。負荷試験で実用上再開できなければ、容量を増やす前に集約と実行頻度の設計を見直す。

長期履歴の保持期間・上限・圧縮手順は実験設定として版管理する。一般ログと異なり、評価に必要な合成入力・出力は専用の評価データとして保存できる。実会話を保存する場合は利用者の許可範囲、保持期間、削除対象を先に定め、forgetをmanifest・派生評価資料にも伝播する。

## 10. 通常の返答（2026-10-25 追記）

agency は自発発話に加えて、利用者の発言への返答も受け持つ（Eumenes の `spec/agency-conversation-agent-design-2026-10-25.md`）。公開名は次のとおり。詳細と仕事（TODO）の照合は [todo-design.md §10](todo-design.md)。

| 公開名 | 内容 |
| --- | --- |
| `respondSystem(options)` | 返答の system の文。`interests`（`StandingInterest[]`）・`spoken`・`emotion`・`projection`（`AgencyProjection`）・`opening`（先に話しかけた内容）。ツールの定義は含まない |
| `runRespond(input)` | 返答の1回。`ReplyPort.complete` を呼び、tool 呼出しを `ToolPort.call` で順に実行して続ける。上限（既定4回）の後はツールなしで最後の呼出し。`end: true` で終わる。感情が有効なら先頭の絵文字をストリームから除いて返す。戻り値 `{ text, emotion?, ended, calls }` |
| `ReplyPort` / `ToolPort` / `ToolDefinition` / `ReplyMessage` | ホストが渡す口（OpenAI の chat 形式）。Provider の選択は package の外 |
| `createMockToolPort()` | 試験・CLI 用。Eumenes と同名の `find_toolchain`・`delegate`・`work`・`memory`、TODO を `HostTodo[]` で公開し、`complete`・`ask`・`archive` で試験から動かす |
| `AgencyRuntime.takeReportedTodos()` / `RuntimeDeps.todos` | 通常の返答が伝えた完了済みの仕事の照合（hostTodos のみ） |

## 11. 記憶汚染への対策（2026-10-27 追記）

信念の確定（`settle-beliefs.ts`）と、資料の描画（`quote.ts`・`prompts.ts`・`respond-system.ts`・`projection.ts`）の規則。

| 規則 | 内容 | 却下コード |
| --- | --- | --- |
| high の根拠 | 新規作成と high のまま active な信念の本文書き換えには今回の処理対象バッチ内の独立した観測が要る（後続の参考観測は含めない）。agent 以外かつツール以外の観測1件、または別々のツール呼出しの結果2件。同じ `causationId` の結果は1件と数え、`causationId` のない結果だけでは別々の呼出しの裏付けとしない（観測にツール名・クエリがないため、同じクエリの別呼出しは区別しない） | `missing_evidence` |
| 訂正後の作り直し | retracted / disputed / superseded の信念が根拠にした自分の出力（agent・配信記録）は、今回の新着の独立した観測（その信念の根拠に入っていないもの）を一緒に挙げない限り、信念の新規作成・active な信念の本文書き換えの根拠にできない。全操作を適用した確定前の状態と更新前・更新途中の訂正記録を使い、再利用される根拠を持つ信念ごとに検証する（操作順で回避できない）。他の信念の訂正にも同じ新着の観測を使ったことだけで、その観測を除外しない | `retracted_evidence_reuse` |
| 同じ内容の繰り返し | 同一内容・言い換えの判断はLLMに委ねる。更新用プロンプトに取り消した・置き換えた信念（最終更新の `updatedSeq` 順に最近5件。旧スナップショットは `createdSeq`、同順は保存順の末尾を優先）を示し、後の自分の発言や言い換えだけを根拠に作り直さないよう指示する。文字列の正規化・記号除去による同一性の判定はしない | プロンプトで指示 |
| disputed の再有効化 | disputed → active には、今回の処理対象バッチ内の独立した観測（その信念の根拠に入っていないもの）が要る | `disputed_reactivation` |

自分の出力だけを根拠にした medium / low の信念は、これまでどおり作れる（V4 の方針。誤りは会話での訂正で正す）。

描画: 観測・メモ・信念・記憶の話題・周辺情報・関心・仕事の題名／質問／結果／次の操作・用事の期限表示・ツールの説明・参照資料とそのメタデータ・先に話しかけた内容など、外から来た本文はすべて `quote()` を通す。JSON の文字列にし、改行、`<`、`>`、U+2028、U+2029 をエスケープする。本文で見出し・行・タグ（`</参照資料>` など）を偽装できない。

`ProjectionItem` は、信念について省略可能な `status`（状態）・`confidence`（確信度）・`evidence`（根拠の観測 id）・`provenance`（出所の内訳。例 `user×1, self×1`）を持つ。返答の参照資料には `確信度=medium / 根拠: o1, o2（user×1, self×1）` のようにデータとして出す。`buildProjection(condition, state, maxItems, observations?)` は、観測が渡されたときだけ `provenance` を付ける（runtime は ledger の全観測を渡す）。

返答には `status` も渡し、`disputed` は疑義のある記録として扱うよう指示する。ツール結果の観測には `causationId` をデータとして表示し、LLMも確定処理と同じ呼出しの区別を使えるようにする。

既存信念を `disputed` / `retracted` / `superseded` に訂正する操作は、追加した本文書き換えの検証で妨げない。
