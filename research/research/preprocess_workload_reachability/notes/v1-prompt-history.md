# プロンプト履歴

## 初回指示 (2026-05-12)

### ユーザーからの指示

> 先ほどまでで提案してくれたplanを起こして

（"先ほどまで" = 同セッション内で、tmp/0021 の lib-enclosure 実走結果を踏まえて
「pruning 前処理を workload-reachability で変更関数を絞る 4 段ワークフローに再設計する」案を、
複数の spike（findChangedNodes の出力確認 / static reachability / dynamic coverage / CDN 依存）を回しながら詰めた議論。その合意内容を plan.md に起こす。）

### 実施内容

- 作業ディレクトリ `tmp/0022_preprocess-workload-reachability-redesign/` を作成
- plan.md に再設計の 4 段ワークフロー + 別 TODO + threats-to-validity を記載
- ※ コード変更はユーザー承認後に着手

---

## フィードバック 1 (2026-05-12)

### ユーザーからのフィードバック

> この処理で大半のソースコードを落とすことができるが，runableを継続してるかどうかってどの時点で判別してる？
> （→「lib は落とさず setup に丸ごと残す / 小さいのは slow・fast / runnability は equiv gate が初回判別」を説明）
> これがいけそうかってspikeで全部検証してるよね？
> （→「Phase 1-2 は検証済、Phase 3-5（特に Phase 4 の hole-and-refill）は未検証の外挿」と回答）
> spikeしてからplan修正でいこうか / その前にさっきのplan修正案だけしといた方がいいと思った

### 実施内容

- plan.md 修正:
  - Phase 0 を「end-to-end spike（Phase 3+4+5 をミニチュアで検証）= de-risking ゲート」に拡張（2-3 issue で `fn-enclosure` 候補を構築 → `checkEquivalence` → `prune` → load/hole 呼び出し/equal/収束/クラッシュなし/sensible パターン を確認）
  - Phase 4 に「候補の構造」注記追加（lib は `setup` に丸ごと残す / 小さいのは `slow`/`fast` / pruning の win = iteration 少 + クラッシュ耐性、per-iter は lib bootstrap のまま / runnability は equiv gate が初回判別）
  - 「## 検証状況（spike で確認済 / 未検証）」セクション追加
- 次: Phase 0 の end-to-end spike を回す → 結果で plan を再修正 → 本実装の承認をもらう

---

## フィードバック 2 (2026-05-12)

### ユーザーからのフィードバック

> （Phase 0 end-to-end spike を「まず naive（穴+グローバルフックだけ）→ ダメなら lambda-lift」で回す承認 → 回した結果を踏まえての議論。「結局どういう方法がいい？」「別途必要なものも plan に入れる？」）

### 実施内容

- **end-to-end spike を回した（`spike-e2e.test.ts`、削除済）**: Underscore.string 347_1 / jQuery 367 で。結果:
  - naive（引数化なし）: 変更関数本体が `slow`/`fast` で定義されると ライブラリ内部スコープ（`makeString` 等）が見えない → `ReferenceError` → vacuous `equal`。**不可。**
  - lambda-lift（内部依存を引数化）＋ 観測する形（変更関数の戻り値を記録して serialize して返す）: **中身のある `equal`**（`return_value` oracle が positive evidence）。`prune` も `pruned`・クラッシュなし・変更関数本体を保持したまま incidental だけ抽象化（over-prune してない）。
  - 既知問題（別 TODO 化）: `prune` のメモリリーク（数百 iter で OOM）/ equiv の `argument_mutation` oracle が Ember globals で `error` / パターンに足場ノイズ。
- **plan.md を更新**: Phase 0 を ✅ 完了に / 検証状況の表を ✅ に / 設計判断 D1 を「lambda-lift」確定に / Phase 4 を「lambda-lift + 観測する形」に書き換え / 別 TODO に「`prune` メモリリーク」「`argument_mutation` robustness」「パターンから足場を剥がす後処理」を追加。
- 次: 本実装の承認をもらう（承認後 Phase 1 から着手）。

---

## フィードバック 3 (2026-05-12)

### ユーザーからのフィードバック

> これの計画フェーズ中です。以下の検証フェーズがplanに入っていない。適切なフェーズで，全件確認した方がいい箇所でサーバ上で実行したいので，適切なフェーズで実行するように以下の設定を書き込みたい
> （→ `mise run sync:brain2` + `rsync -av tmp/vendor/ brain-2:.../tmp/vendor/` → サーバ側で `pnpm install`（初回）→ `cd mb-analyzer && pnpm vitest run tests/preprocessing/spike-e2e.test.ts 2>&1 | tee .../tmp/0022_.../spike-e2e.log` → `rsync -av brain-2:.../tmp/0022_.../ tmp/0022_.../` で戻す。注: 各 issue で console.log（path / liftDeps / deps / verdict / prune結果 / pattern_code）/ prune のメモリリークで OOM → maxIter 控えめ（Underscore.string・jQuery 200、Ember 30〜50）or `NODE_OPTIONS=--max-old-space-size=8192` / Ember 系は jquery 2.1.3→vendored 1.7 差し替え + handlebars 強制 load（spike の depSources がやってる）/ 対象 issue・maxIter は `spike-e2e.test.ts` 冒頭の TARGETS を編集 → 再 sync → 再実行 という具体手順を提示）

### 実施内容

- plan.md に **Phase 0.5: spike-e2e を 0021 hard issue 群全体でサーバ実走（de-risking の最終ゲート）** を Phase 0 と Phase 1 の間に追加。ユーザー提示のサーバ実行手順（sync:brain2 / tmp/vendor 別送 / pnpm install / vitest run + tee / 結果 rsync 戻し）と注記（OOM・maxIter・Ember dataset バグ回避・TARGETS 編集ループ）をそのまま転記。`mkdir -p tmp/0022_...` を追加（tee の出力先確保）。
- 「検証状況」表に「lambda-lift + 観測する形が hard issue 群全体で成立するか」行を ⏳（Phase 0.5 で確認）で追加。end-to-end spike の完了サマリ行に「2 issue だけ → Phase 0.5 で全件サーバ実走をゲートにする」と補足。
- 次: 本実装の承認をもらう。承認後は Phase 0.5（サーバ実走）→ 結果次第で Phase 1 着手 or plan 再修正。

---

## フィードバック 4 (2026-05-12)

### ユーザーからのフィードバック

> サーバ上で実行するなら，hard issue群だけでなく全てに対して確認する方がいい？それともそれはやり過ぎ？
> （→「やり過ぎ寄り。再設計が変えるのは `aspect: A` だけ（`aspect: B` は組み立て不変）/ hard 群が最も多様で過酷なサンプル / spike は使い捨ての手配線インフラ（per-issue maxIter チューニング）/ 全件本番計測は Phase 5 の仕事。折衷案 = hard 群 + easy `aspect: A` を 2〜3 件だけ」と回答）
> そうしよう
> あと，tmp/vendorって何が入ったファイルだったけ？
> （→ `<host>/<path>` 階層で curl 済の CDN 依存 4 ファイル（~360K）: ajax.googleapis.com の jquery 1.7 / 1.11.3 / 2.1.3 の min.js、cdnjs の handlebars.js 1.1.0。dataset の `v_*.html` の `<script src>` を解決するための vendored ファイルと説明）

### 実施内容

- plan.md の Phase 0.5 の対象スコープを「hard issue 群」→「**hard issue 群 + easy `aspect: A` を 2〜3 件**（サニティチェック）、`aspect: B` は対象外、全件本番計測は Phase 5」に修正。判定基準にも「easy `aspect: A` で壊れる＝設計が hard ケースに過剰適合のサイン」を追記。

---

## フィードバック 5 (2026-05-12)

### ユーザーからのフィードバック

> 承認するので Phase 0.5 から進めて
> （→ TARGETS を 12 issue に拡張 / brain-2 へ sync の手順をまとめて提示 → ユーザーが docker コンテナ内で `pnpm vitest run spike-e2e.test.ts` を実行 → `tee /mnt/data1/...` はコンテナ未マウントで失敗、ターミナル出力を貼り付け → 「ローカルに戻した」）

### 実施内容

- `spike-e2e.test.ts` の `TARGETS` を 7 → 12 issue に拡張（hard 7 + 既知特殊ケース Ember 4158/4263/9991 + easy sanity Underscore.string 347_2 / Underscore 1223）
- brain-2 の環境を調査: 48 コア / 376 GB RAM、ただし node/pnpm は非インタラクティブ ssh の PATH に無い（実体は docker コンテナ `~/workspace/mb-analyzer`）→ ユーザーに実行手順を渡してそちらで実走してもらった
- spike 実走（12 issue, 101s, brain-2 docker）。**結果**: 核（小候補 → 中身のある `equal` → pruning が本体保持）は 4/4 のクリーンケースで成立（Underscore.string 347_1/347_2・jQuery 367・Underscore 1222）。失敗 8 件 = ① bootstrap-invocation で `__HOLE__` 未定義 error（Ember 3174・Underscore 1223 — core 関数なので「稀」じゃない）② AMD `define` 内ローカルが lift-scope から漏れる（Ember 5547）③ `pathFromChain` が浅く `cannot determine path`（jQuery 248・Ember 4329_1/4158/4263/9991）。
- 反映: `spike-e2e.log`（生ログ）・`notes.md`（分析表 + 判断）を作成。plan.md を更新 — D1 に「`if (globalThis.__HOLE__)` ガード + 変更前本体インライン fallback」「lift-scope を lexical chain 全体に」、A1 を「named は祖先パス上のどこか / モジュールスコープに AMD `define` コールバック body を含める」、Phase 4 のヘルパ仕様、検証状況の表、Phase 0.5 を `[x]` に。
- 判断: **本実装（Phase 1+）に進む。①② の fix を v1 に折り込み済**。Ember 級が v1 で拾えるかは Phase 5 の再測定で確認（必要なら fix 入り spike を 1 回再走）。

---

## フィードバック 6 (2026-05-12)

### ユーザーからのフィードバック

> spike再送で（= 失敗理由の詳細説明 → 「spike の実装をやり直した方がいい気がした」→ 修正 (1)〜(4) を入れた spike を書き直して brain-2 で再走する方向）

### 実施内容

- 第1回の失敗 8 件を dataset の中身まで見て分析（8/8 が「spike が approach の簡略版だった」せい、approach 否定じゃない）。詳細を `notes.md`「spike v2」節に。
- `spike-e2e.test.ts` を **Phase 1/4 寄せ実装に書き直し**: (1) `if (globalThis.__HOLE__)` ガード + after 本体インライン fallback (2) lift = 変更関数を囲う lexical chain 全体（`(function(){...}).call(this)` も `define(...)` も ancestors を辿るだけで拾う） (3) `findChangedUnits` = 変更ノード全部 → 最寄り **named** 関数（匿名 IIFE/callback は飛ばす）→ named 無ければ stmt unit（候補は組まずログのみ）、1 issue で複数 fn unit 可 (4) `setup` = after-lib（co-evolve した新ヘルパが居る）+ `__OBS` 空 → 「Phase 2 で DROP 相当」と判定して prune スキップ。
- ローカル smoke（347_1 / 1223 のみ）: 347_1 = `startsWith` ✅ 本体保持・`endsWith` は vacuous と正しく判定 / 1223 = `_.forEach` が第1回 `error` → **今回 `equal (中身あり ✓)`**・`pruned`・object 分岐の構造保持。`liftDeps=[nativeForEach,breaker,_]`（第1回は `[]` だったバグ修正を確認）。`mise` lint/tsc green。
- 次: ユーザーが brain-2 で spike v2 を 12 issue 再走 → 結果（log か貼り付け）を戻す → 再分析。

---

## フィードバック 7 (2026-05-12)

### ユーザーからのフィードバック

> （brain-2 docker で spike v2 を 12 issue 実走したターミナル出力を貼り付け）

### 実施内容

- spike v2 の結果を分析。生ログ → `spike-e2e-v2.log`、分析表 → `notes.md`「spike v2 サーバ実走の結果」節。**結論: preprocess 再設計（候補構築側）は de-risk 完了**:
  - 第1回の 3 ギャップは全部 fix を確認: ① `if(__HOLE__)` ガード = bootstrap-invocation 解消（Ember 3174・Underscore 1223 が実行される）② lexical-chain lift = `metaFor`/`breaker`/`nativeForEach`/`META_KEY`/`rnoInnerhtml`/… 全部拾えた ③ `findChangedUnits` = jQuery 248→`jQuery.fn.html`、Ember 4329_1→`Ember.cacheFor`、version bump→stmt unit、1 issue 複数 fn unit、vacuous 検出 — 全部動いた。
  - 非 Ember 6/6 fn unit が「中身のある equal + pruned + 本体/変更点保持」（347_1/347_2 startsWith・367 index・248 html・1222 values・1223 forEach）。`endsWith`×2 は vacuous → Phase 2 DROP 相当と正しく判定。Ember 4263/9991 は「fn unit なし」と正しく分類。
  - 残るブロッカーは preprocess 側じゃない: (a) equiv-checker の `argument_mutation` oracle が Ember オブジェクト引数で `error`（Ember 3174/4329_1/4158 — 候補構築は OK、`return_value`/`external_observation` は通る）→ **別 TODO #3 を「Ember 用に v1 で必要」に格上げ** (b) Ember 5547 = `set` の incidental な戻り値変化を over-observe して false `not_equal` → 保守的 DROP（threats #5 に追加。v2 で call-trace 観測形に置き換える余地）。
  - plan.md 更新: Phase 0.5 を `[x]` 完了に / 別 TODO #3 を v1-必要に格上げ / threats を更新（#4 dataset の `<script src>` ミスは dep-vendoring が swap/補完すれば動く＝「dataset-broken で除外」じゃなく実装事項、#5 over-observation 追加）。
- 次: 別 TODO #3（`argument_mutation` oracle robustness）を先に片付けるか相談 → ユーザー「1で実装し、todo コメントとして 2 を書いとくのがアンパイ？」→ そのとおり実装。

---

## フィードバック 8 (2026-05-12)

### ユーザーからのフィードバック

> orcleのfixってどういうもの？日本語で教えて / serializeValueって何 / Siriアライズできない状況っていうのがいまいちピンときていない / 1で実装し，todoコメントとして2を書いとくのがアンパイ？

### 実施内容

- `serializeValue` = 値→決定的文字列。throw する（= `<<unserializable>>` マーカ）のは循環参照のときだけ。Ember のオブジェクトは循環だらけ（`ComputedProperty ↔ meta ↔ owner` 等）なので `globalThis.Ember` を snapshot しようとすると詰まる → `argument_mutation` oracle が `error` → 候補全体が `error`、を説明。
- **別 TODO #3 を option 1 で実装**:
  - `mb-analyzer/src/equivalence-checker/common/comparison/oracles/argument-mutation.ts`: `UNSERIALIZABLE_MARKER` を含む key を比較対象から除外、残り 0 件なら `not_applicable`（`error` に丸めない）。in-source test 追加（全 unserializable→N/A、一部だけ→残りで判定）。
  - `mb-analyzer/src/equivalence-checker/common/serializer.ts`: 循環参照の throw 箇所に option 2（throw でなく `<circular>` sentinel、要 maxDepth デフォルト）の TODO コメント。
  - `ai-guide/adr/0018-equivalence-verdict-conservative.md`: 「2026-05-12 更新」節を追記。
  - 検証: `mise` lint/tsc green、equivalence-checker 84 tests pass。ローカルで Ember 4329_1（`Ember.cacheFor`）を spike で再走 → v2 の `error` → **`verdict=equal (中身あり ✓)` + `prune: pruned 117→109`** に flip するのを確認。同経路の 3174/4158(`guidFor`) も flip するはず。
- → **Ember 級も candidate 構築〜等価判定〜pruning が通る状態に**。次: Phase 1 本実装（現状 green 確認 → `common/` の変更 unit 切り分けヘルパ、spike v2 の `findChangedUnits`/`liftableNames` を移植）。

---

## フィードバック 9 (2026-05-12)

### ユーザーからのフィードバック

> Phase 1進めて

### 実施内容

- green check: `mise run lint-analyzer typecheck-analyzer` OK / `test-analyzer` は **`spike-e2e.test.ts` が suite に乗ると重くて落ちる**ことが判明 → spike を削除（Phase 0.5 完了済、ロジックは下記に移植）→ 470 tests pass。`uv run pytest tests/domain/entities/test_preprocessing.py` 11 pass。
- **`mb-analyzer/src/preprocessing/common/change-units.ts` を新設**（spike v2 の `findChangedUnits`/`pathFromChain` を本実装に移植・整理）:
  - `findChangeUnits(libBeforeSrc, libAfterSrc): { beforeAst, afterAst, units: ChangeUnit[], unanchored, empty }`
  - `FnChangeUnit`（`name`/`beforeFn`/`beforeFnAncestors`/`afterFn`/`afterFnAncestors`/`changedNodes`）と `StmtChangeUnit`（`stmt`/`bindings`/`desc`/`changedNodes`）。`functionBindingName` で命名、匿名 callback/IIFE/`define(...)` は飛ばして上の named 関数まで遡る。after-AST の同名関数を索引（rename/削除なら null）。
  - in-source test 8 件。`mise` lint/tsc/test green。
- `tests/preprocessing/spike-e2e.test.ts` を削除（中身は notes.md + spike-e2e{,-v2}.log + change-units.ts に残ってる）。
- 「`findMinimalEnclosure`/`splitAtEnclosure` の lib-enclosure 経路を `pipeline.ts` から撤去」は **Phase 2 冒頭に移動**（`aspect: A` ブランチの組み替え + `selakovic.test.ts` 書き換えとセットでやらないとテストが壊れるため）。plan.md 更新済。
- 次: Phase 2（reachability + pipeline 組み替え + contracts）— ユーザー承認待ち。

---

## フィードバック 10 (2026-05-12)

### ユーザーからのフィードバック

> 1. 2aだけ先やる / 2. fn-enclousureのcandidate_kind名って言ってるけど，candidate_kind名が何かと，他に何があるかまず教えてほしい

### 実施内容

- **Phase 2a 実装**: `mb-analyzer/src/preprocessing/common/reachability.ts` を新設（spike v2 の call-graph ロジックを移植）。`buildCallGraph(libAst, workloadRoots)` / `callersOf(graph, target)` / `isReachedByAnyWorkload(graph, target)` / `lastSegment(name)`。名前は member-access 末端で over-approx（KEEP 寄り）。`change-units.ts` から `FN_TYPES`/`functionBindingName` を export して再利用。in-source test 7 件。`mise` lint/tsc/test green（477 tests）。
- `candidate_kind` の説明（下記の回答）。Phase 2b の contracts 変更で新値の名前を決める（`fn-enclosure` 仮）。
- 次: Phase 2b（`pipeline.ts` の `aspect: A` 組み替え + contracts + `selakovic.test.ts` 書き換え）— candidate_kind 名を決めてから着手。

---

## フィードバック 11 (2026-05-12)

### ユーザーからのフィードバック

> single の具体例を教えて / 作用点 A/B を LIB/benchmark みたいな単語にした方がいい？ → benchmark より workload の方が拡張性ある？ → changed-fnにして，lib-enclosureは削除でplanファイルを修正し，実装に着手しよう

### 実施内容

- 質問への回答: `single` の具体例（`aspect: B` のベンチ自体最適化 / `aspect: A` の embedded `#0` / `aspect: A+B` co-evolution / `fallback` / server 全部）、`candidate_kind` の説明（現 4 値の詳細日本語解説）、`aspect` リネーム提案（`workload` 採用）。
- 決定: `candidate_kind` 新値 = **`changed-fn`**、`lib-enclosure` は**削除**、`aspect` を `A`→`"lib"` / `B`→`"workload"` / `A+B`→`"lib+workload"` にリネーム。plan.md の B1 + Phase 2 セクションを更新（`fn-enclosure`→`changed-fn`、`buildFnEnclosureCandidate`→`buildChangedFnCandidate`、2b-i / 2b-ii 分割）。
- **Phase 2b-i 実装**: contracts（`preprocessing-contracts.ts` + `preprocessing.py`）の `ASPECT` リネーム + `CANDIDATE_KIND` から `lib-enclosure` 削除・`changed-fn` 追加 + `EXCLUSION_REASON` に `change-not-exercised`。波及: `route/aspect.ts` / `pipeline.ts`（`buildLibEnclosureCandidate`/`pushLibEnclosure` 削除、`changed-fn` 追加箇所に TODO）/ `assemble/client.ts`（`buildLibEnclosureCandidate` + 専用ヘルパ削除、未使用 import 整理）/ `selakovic.test.ts`（lib-enclosure 表明削除、aspect リネーム、冗長な IIFE-buried テスト削除）/ `tests/contracts/preprocessing-contracts.test.ts`（新値 + `ASPECT`/`CANDIDATE_KIND` の strictEqual・型チェック追加）/ `tests/domain/entities/test_preprocessing.py` / contract-test の `aspect: "A"` リテラル → `"lib"`。ADR-0011 / ADR-0014 に「2026-05-12 更新」節を追記。`mise` lint/tsc/test（480 tests）/ `uv run pytest tests/domain`（77 pass）/ build 全 green。
- 次: Phase 2b-ii（`common/function-hole.ts` の lambda-lift + 観測形 / `assemble/client.ts:buildChangedFnCandidate` / `pipeline.ts` で `buildCallGraph`/`findChangeUnits`/`isReachedByAnyWorkload` を配線して `changed-fn` 候補を出す / `selakovic.test.ts` に `changed-fn` 表明を再追加）— spike v2 の setup/slow/fast 組み立てロジックを移植。

---

## フィードバック 12 (2026-05-12)

### ユーザーからのフィードバック

> Phase 2b-ii進めて

### 実施内容

- `mb-analyzer/src/preprocessing/common/function-hole.ts`（新設、dataset 非依存）: spike v2 の lambda-lift + 穴あけ + 観測する形ロジックを移植。`freeIdentifierNames` / `liftableNames`（lexical chain 全体の hoist 束縛）/ `pickLiftedDeps` / `holeLibSource`（変更関数 body を `{ if (globalThis.__HOLE__) { return __HOLE__.call(this,<deps>,<args>); } <after 本体インライン> }` に置換）/ `buildHoleFunction`（`__HOLE__` 関数式 = 本体実行 → 戻り値を `__OBS` に記録）/ `wrapWorkloadObserved` / `functionBlockBody` / `paramNames` / `countSubtreeNodes`。in-source test 7 件。
- `mb-analyzer/src/preprocessing/selakovic/assemble/changed-fn.ts`（新設）: `buildChangedFnCandidate(unit: FnChangeUnit, libAfterSrc, f1Decomposition, depLibSources)`。`setup` = (依存 lib…) + lib(after、穴あき) + preF1 / `slow`/`fast` = `__HOLE__` に before/after 本体 + 観測する形の workload / `candidate_kind="changed-fn"` / node count は変更関数本体のサイズ。`afterFn===null` / arrow body / param 名不一致 / angular wrapper f1 → `null`。in-source test 3 件。
- `pipeline.ts`: `appendChangedFnCandidates` を追加し `aspect: lib`（と `lib+workload` independent の lib 側）で呼ぶ — `findChangeUnits` → fn unit 抽出 → `buildCallGraph(beforeAst, [{name:"f1", body:[...preF1,...f1Body]}])` → `isReachedByAnyWorkload` で KEEP → `buildChangedFnCandidate` で `#1+` を push。`.map` で `changed-fn` は builder の node count を尊重。
- `selakovic.test.ts`: 「f1 が変更 lib 関数を呼ぶ → embedded `#0` + changed-fn `#1`」テスト追加、「f1 が lib を呼ばない → embedded のみ（reachability で DROP）」を明示。
- `mise` lint/tsc/test（491 tests）/ `uv run pytest tests/domain`（77 pass）/ build / check-arch 全 green。plan.md（2b-ii ✅、残: server 対応 / DROP の集計出力 / aspect workload の観測形化 を要相談に）/ prompt.md 反映。
- → **Phase 2 完了**（client `aspect: lib` の changed-fn 候補生成が動く状態）。次: Phase 3（dep-vendoring の正式化 + `<script src>` 順 load + equiv gate を equal-only に）— or 先に server 対応を v1 に入れるか相談。

---

## フィードバック 13 (2026-05-12)

### ユーザーからのフィードバック

> dep-vendoring を別タスクにしてるけど先やった方がいい？ → submodule の事情を確認 → 「vendor」の混同を整理（ADR-0016 の server npm dep ≠ 0022 の client `<script src>` dep）→ 方針 (A)（①の仕組みを②に拡張）採用 → 別 clone で作業する前提でタスクを洗い出して → `dep-vendoring-tasks.md` 作成 → M2 だけ先やっておこうか

### 実施内容

- `<script src>` を全 client/clientServer の `v_before.html` から洗い出し（vendor 対象 = jquery@{2.1.3, 1.11.3, 1.7.x} / handlebars@1.1.0 / underscore@1.8.3、jstat・`<lib>_before.js`・`execute.js`/`JSXTransformer.js` は skip）。
- `tmp/0022_.../dep-vendoring-tasks.md` を作成 — フォーク側タスク T1〜T6（per-issue 版洗い出し → ADR-0016 レイアウトで配置 → `package.json`+`pnpm-lock.yaml` 追加 → `install-vendor-deps.sh` 更新 → `MODIFICATIONS.md` 更新 → commit/merge/push）と MB-scanner 側タスク M1〜M5（submodule bump → `<script src>` 解決ヘルパ → CLI 入力配線 → ADR-0016/dataset doc 更新 → テスト）+ M6（brain-2 で `install-vendor-deps.sh`）。
- **M2 を先行実装**: `mb-analyzer/src/preprocessing/selakovic/io/script-deps.ts` 新設 — `classifyScriptSrcs`（純関数、`<script src>` を harness / patched-lib / cdn-dep / local-other に分類）+ `resolveScriptDepSources`（issueDir から祖先方向に `node_modules/<pkg>/...` を解決して読む、issue 単位が category 単位より優先 → 4158 の jquery 1.7 override が効く）。`selakovic/index.ts` に export。in-source test 7 件。`mise` lint/tsc/test green（498 tests）。⚠️ `PKG_FILE_CANDIDATES` のパスは推測込み（handlebars 1.x のレイアウト等）→ M6 で実 `node_modules/` を見たら調整。
- 次: ユーザーが別 clone で T1〜T6 → merge → M1（submodule bump）→ M3〜M5（CLI 配線 / ADR 更新 / テスト）。

---

## フィードバック 14 (2026-05-12)

### ユーザーからのフィードバック

> build_prune_input.py を equal-only に戻して

### 実施内容

- `tmp/0021_preprocess-pruning-candidate/build_prune_input.py` の `PRUNE_VERDICTS` を `{"equal", "inconclusive"}` → `{"equal"}` に（C2 — `inconclusive` は弱い equal で巨大候補が混ざるので様子見）。docstring/コメントも更新（「当面 equal-only」「changed-fn 系は slow が小さいので大 cap のまま」）。`py_compile` OK。
- plan.md: Phase 3 の該当 bullet を `[x]` に、別 TODO #6 を「✅ 済」に。Phase 5 用の 0022 版 `build_prune_input.py` は equal-only + `candidate_kind in {changed-fn, body}` フィルタで別途作る（Phase 5 で）。
- 次: ユーザーの T1〜T6（dep-vendoring フォーク側）待ち。

---

## フィードバック 15 (2026-05-12)

### ユーザーからのフィードバック

> fork のものに向け先変更って今やるのはどう？ → やった / dep-vendoring (a) コミットして → した / fork の master ブランチにマージした

### 実施内容

- submodule の `origin` を上流 → フォーク (`tomoya0318/selakovic-2016-issues`) に修正（`.git/config` のローカル変更、commit 不要）。fork 到達確認済。
- `tmp/0021_.../build_prune_input.py` を equal-only に（`PRUNE_VERDICTS = {"equal"}`）— Phase 3 の独立部分。commit `05a4481` の前に scratch なので非コミット。
- M2 = `<script src>` 解決ヘルパ（`io/script-deps.ts`）を commit `05a4481`。
- ユーザーが fork PR #2 (`vendor-client-script-src-deps` = `8f64b91`) を fork master に merge → fork master = `be15a06`。client-issue 用の vendor location 追加（AngularIssues=jquery@1.11.3 / EmberIssues=jquery@2.1.3+handlebars@1.1.0 (issue_3174/3288 は jquery@1.7.2 override) / ReactIssues=jquery@1.7.2 / BackboneIssues=underscore@1.8.3+jquery@2.1.3 / Ejs・Moment・NodeLruCache・Underscore.string・Underscore=jquery@2.1.3 / Q=jquery@1.7.2）+ `install-vendor-deps.sh`/`MODIFICATIONS.md` 更新。
- **M1 + M3 + M4 + M5 を実装 → commit `8e6a52c`**:
  - M1: submodule を `be15a06` に checkout → 親 repo の gitlink bump
  - M3: `SelakovicPreprocessInput`（client）に `dep_lib_sources?: readonly string[]` 追加、`pipeline.ts` が全候補の `setup` 先頭に dep を連結（changed-fn / embedded / fallback 共通。`buildChangedFnCandidate` から `depLibSources` 引数は削除 — pipeline が一括連結する）、CLI (`cli/preprocess-selakovic.ts`) が `resolveScriptDepSources` で解決して `dep_lib_sources` を詰める（解決漏れは stderr に）
  - M4: ADR-0016 に「2026-05-12 更新 (本 ADR の仕組みを client `<script src>` CDN dep にも適用 — 0022 Phase 3)」節
  - M5: `selakovic.test.ts` に「dep_lib_sources は全候補の setup 先頭に連結される」テスト追加
  - `mise` lint/tsc/test green（499 tests）/ `uv run pytest tests/domain`（77）/ build OK
- → **Phase 3 = M6（あなたが brain-2 で `install-vendor-deps.sh`）以外完了**。次: M6 → Phase 5（再測定）。dataset doc / code-map の更新は task 末の ai-guide 反映で。

---

## フィードバック 16 (2026-05-13)

### ユーザーからのフィードバック (一連の議論)

Phase 5 まとめ作業中の質問・議論・方針転換:

1. **Phase 5 数字の解釈**: pruned=19 / error=7、削減率 median 0.174、cap-hit 6/19。0019/0021 と比較した数字を notes.md に書いてほしい。error の原因と解決策の提示。jsonl を json に変換してほしい。

2. **`changed-fn` / `body` 絞り込みの根拠を確認**:
   - 「unit として出した変更差分が workload で呼ばれているかを計測 → そこから filter した結果 35 件」で合っているか？
   - 35 件は少なすぎないか？
   - co-evolution / fallback がなぜ対象外なのか不明

3. **「server 以外で body+changed-fn を取れる」を成功条件に**: server 17 + fallback 1 を除く 79 issue で全部 body or changed-fn を取れるようにしたい。Angular wrapper 対応 (別 TODO #8) も spike D の射程に含めてよい。

4. **`__HOLE__` 方式が過度に複雑では？**: placeholder substitution の方がシンプルで説明しやすく、バグも起きにくいのでは。「setup に placeholder があってそこに slow/fast を突っ込めば等価検証できる」が直感。これが lambda-lift だと思っていた (実は別物)。

5. **setup と workload を分けるべき**: 4 値契約 `{setup, workload, slow, fast}` で。

6. **大幅な仕様変更のため、しっかりロードマップを組む + tmp/ 整理 + HEAD からやり直しも候補**:
   - 現ブランチを v1 として merge してから v2 fresh start (= 選択肢 A)
   - feature/hydra-pruning は実は「役目を終えた統合ブランチ」(PR #2/4/8/9/11 集約済) と判明 → 削除予定
   - 3 PR 分割で main を整理 (= シナリオ β-1): equiv-checker refactor / pruning split / preprocess v1

### 実施内容 (このセッション分)

#### Phase 5 まとめ
- `tmp/0022_/notes.md` に「Phase 5: 本実装の全件再測定」セクション追加 (143 candidate / equiv 26 equal 6 not_equal 0 inconclusive 14 error / prune 19 pruned 7 error / median 削減率 0.174 / before 75 → after ≈62 ノード)。0019/0021/0022 比較表 + 解釈 (「削減率が低い ≠ 悪い、絶対サイズが本質」) + error 内訳 + 解決策 + follow-up。candidate_kind 内訳を `single=86` に訂正 (excluded=1 を分離)。
- `tmp/0022_/jsonl_to_json.py` 新規作成: 5 jsonl → json + error subset 抽出。
- ローカルで変換実行 (extracted=143 / equiv-input=46 / equiv-results=46 + errors=14 / prune-input=26 / prune-results=26 + errors=6) 確認。

#### changed-fn コメント残存 fix
- `extracted.json` の changed-fn 35 件中 slow に `//` を含むもの **18 件 / fast に 15 件** を発見。
- `mb-analyzer/src/ast/parser.ts` の `generate()` / `tryGenerateNode()` に `GenerateOptions { comments?: boolean }` 追加。
- `mb-analyzer/src/preprocessing/common/setup-cleanup.ts` の `statementsToCode` が `{ comments: false }` を渡すよう修正 (File.comments=[] だけだと Node に attach された leadingComments/trailingComments は @babel/generator が依然出力するため明示が必要)。
- `assemble/changed-fn.ts` の in-source test に「コメント除去」ケース 1 件追加 (changed-fn 4 tests pass、parser.ts 12 tests pass、preprocessing 全体 19 ファイル 114 tests pass)。
- commit `a6b43b6` 起票。
- 再走後の検証: `slow に // が残るもの 0/35`、`fast に // が残るもの 0/35` を確認。

#### `changed-fn` / `body` 絞り込みの根拠説明
- `pipeline.ts:96-114` を読み直して、candidate_kind が aspect 分岐の結果 (`lib`/`workload`/`lib+workload independent`/`lib+workload co-evolution`/`fallback`) でどう決まるかを整理。
- `single` = embedded baseline、`lib`/`body` = lib+workload independent の分割、`changed-fn` = workload-reachable な変更関数の小候補。
- `build_inputs.py` の `{changed-fn, body}` 絞り込みは「lib 全文を setup に含まない軽い候補」だけを equiv/prune に流す運用方針。

#### 35 件の内訳分析
- 97 issue → 設計上対象 = 79 issue (server 17 / co-evolution 1 / fallback 1 / workload-only 0 を除く)、うち Angular wrapper 26 は v2 持ち越し。
- 達成率: 53 issue 中 32 issue (60%) で changed-fn ≥ 1 を生成。
- 残り 21 issue (Angular 以外で changed-fn 0) は **DROP 理由が現状の出力から見えない** = 案 D「DROP 可視化」が必要。

#### co-evolution / fallback の正確な定義
- co-evolution = `aspect=lib+workload` で `isIndependent` false (body の参照 identifier と lib 変更関数名が交差) → ADR-0014「迷ったら 1 candidate」採用、現状 combined のみ
- fallback = `routeAspect` の `libHasRealChange=false && bodyHasRealChange=false` → lib にも body にも意味論変化なし → 研究的に measure する意味なし
- **真の対象外は server + fallback の 18 issue だけ**。co-evolution は寧ろ changed-fn の理想ターゲット (= body が lib 変更関数を直接呼ぶ = workload-reachable signal が最も明確)、追加実装で取り込める。

#### placeholder substitution への設計変更合意
- `__HOLE__` 方式は **3 仕掛け (lambda-lift / `if (__HOLE__)` ガード + after body inline fallback / `__OBS` 観測形)** が積み重なっており accidental に複雑。
- placeholder substitution に切り替えると lambda-lift 不要 (closure 経由) / bootstrap guard 不要 (bootstrap 中も差し替え版が走り観測点に化ける) / 仕掛けは観測形のみに減る。
- 4 値契約 `{setup, workload, slow, fast}` でユーザの「workload と setup を分けるべき」を反映。executor は `setup.replace('$BODY$', body) + ';\n' + workload` の 1 回 runInContext。旧形式 (= `workload` フィールドなし) は後方互換で 2 回 runInContext のまま。

#### v1 → v2 ロードマップ起票
- `tmp/0022_/migration-plan.md` 新規 (Phase 1 整理 = 3 PR 分割で main へ + Phase 2 v2 fresh start)。
  - PR-1: feat/equivalence-checker-refactor (22 commits = `dbddd3a..7ca0037` + 雑多 4)
  - PR-2: refactor/pruning-common-selakovic-split-only (1 commit = `fa18f18`)
  - PR-3: feat/preprocess-workload-reachability-v1 (6 commits、`__HOLE__` 方式 v1) + tmp 整理 + ADR-0022 起票 + research/research/preprocess_workload_reachability/ 立ち上げ
  - feature/hydra-pruning は削除予定 (`abb05b8` は main 取り込み merge のみで実害なし)
  - Phase 2 = D-α spike (1 日) → D-β 本実装切り替え (2.5-3.5 日) → D-γ DROP 可視化 + 全件再走 (1 日) → 派生 Angular (+ 2 日)
  - 合計 6.5-9.5 日 (Angular 込み 8.5-11.5 日)。撤退条件 (D-α が partial / fail なら hybrid or v1 維持) と保持資産・置き換え対象の切り分けを記載。
- `tmp/0022_/refactoring-todo.md` 新規 (案 B/C を deferred TODO 化、v2 完了後に着手)。
  - A: dataset デフォルト定数化 (0.2 日)
  - B-b1: preprocess 出力に `module_base_dir`/`mount_html` 詰める (0.5 日)
  - B-b2: `check-equivalence-batch --kinds` (0.3 日)
  - B-b3: `prune-batch --from-equiv-results` (0.7 日)
  - C-1: `mise run convert-jsonl` (jq) (0.1 日)
  - C-2: research/ 整備 (0.5 日)
  - C-3: `_common.py` (0.3 日)
  - 合計 2.6 日。A と C-1 は v2 と並行可。

#### 次のステップ
- ユーザに migration-plan.md / refactoring-todo.md の review を依頼。
- 承認後、Phase 1 PR-1 の実作業 (cherry-pick + テスト + PR 作成) に着手。
