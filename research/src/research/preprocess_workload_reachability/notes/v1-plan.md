# 実行プラン: preprocess-workload-reachability-redesign

作成日: 2026-05-12
関連: `tmp/0020_pruning-common-selakovic-split/`（PruningInput 拡張、commit 済）/ `tmp/0021_preprocess-pruning-candidate/`（lib-enclosure candidate を実装・実走 → 「切り方が悪い」と判明、本タスクの直接の出発点。notes.md / comparison.md / spike 群がそこにある）

## 概要

`aspect: A`（patch が `<lib>_*.js` の中）の candidate の「切り方」を再設計する。現状（0021 まで）は lib 全文を slow/fast に丸ごと埋める（embedded、数万〜数十万ノード）か、`findChangedNodes → findMinimalEnclosure → splitAtEnclosure` で「全変更を 1 個の enclosure で包む」（lib-enclosure）。後者は変更が IIFE 内の複数の兄弟関数に散ると LCA = IIFE body → enclosing function = IIFE 自身（Ember で 89768 ノード）になり、UMD-IIFE では `splitAtEnclosure` が IIFE 全体を返して諦める。

新方式: **workload（client = `v_*.html` の inline `<script>` の `f1` body、server = `test_case_*.js` の `test()` body）が実際に exercise する変更関数だけを候補に絞り、それ以外（version-bump ノイズ、workload が触らない別最適化）は破棄する** 4 段ワークフロー。

```
[Phase 1] diff: findChangedNodes(libBefore, libAfter) → 変更ノード → 変更ノードを「それを含む unit」ごとに切り分け
   （unit = 最寄りの named 関数 / 無ければモジュールレベル文 / どちらにも anchor できなければ unanchored で drop）。unit ごとに 1 候補（の元）に
   ↓
[Phase 2] 候補選別（change-driven）: 各変更 unit について「それを exercise する workload を探す」
   = backward call-graph 閉包 ∩ 利用可能 workload 集合（データセットでは {f1}、一般 PR では repo の test suite）。
   覆われた変更だけ KEEP（その workload が witness）、覆われないものは DROP。KEEP ごとに 1 candidate。
   ※ f1 を「事前に与えられたもの」として forward で reachable を出す方がデータセットでは安いが、それはせず
     change-driven で組む（一般 PR では f1 相当が不明で「探す」ステップが要る）。escalation: dynamic coverage（後回し可）。
   ↓
[Phase 3] equiv gate: <lib>_*.js を before/after で swap して workload を実行 → 観測比較。
   not_equal → discard（behavior-changing = 最適化じゃない）。equal → pruning へ。
   （前提: dep-vendoring。CDN 依存 jquery/handlebars をローカルに + executor が <script src> 順 load）
   ↓
[Phase 4] pruning（engine 不変）: 候補関数を runnable 化（lambda-lift = 変更関数が使うライブラリ内部の
   補助関数・変数を引数化して取り出す + 観測する形 = 戻り値を記録して返す）→ pruning が「fast と等価なまま
   slow を最小化」→ 最小パターン抽出。
```

## 目的

1. `aspect: A` の candidate のサイズを「lib 全体（数万〜十数万ノード）」→「workload が叩く 1〜数個の小関数（数十〜数百ノード）」に落とす（spike で 11 issue 中 8〜9 で 50×〜3000× 削減を確認、UMD-IIFE で諦めてた issue も回収）。
2. これにより pruning が実用速度で回り、巨大変種クラッシュ（0019/0021 で踏んでた SIGABRT）も起きにくくなる。
3. 「workload が exercise しない変更は破棄」を原理として組み込む（version-bump ノイズが特別扱いなしで落ちる。これは実行ベース等価検証の必然 — 実行できないものは検証できない。recall トレードオフだが原理的に正しい）。
4. 「workload」を `f1` だけでなく test にも一般化できる設計にする（将来、変更をカバーするテストを持つ任意 PR に拡張可能）。本タスクは Selakovic dataset 範囲で実装する。

## 調査結果（既存コード touchpoint）

| ファイル | 役割 | 本タスクでの扱い |
|---|---|---|
| `mb-analyzer/src/preprocessing/common/ast-diff.ts` (`findChangedNodes`) | top-down subtree-hash diff。コメント/整形は無視済（`canonicalHash` が `leadingComments` 等を除外） | **そのまま再利用** |
| `mb-analyzer/src/preprocessing/common/enclosure.ts` (`findMinimalEnclosure`) | 全変更を 1 enclosure で包む | **lib-enclosure での役割を廃止**（Phase 1 の「変更ノードを unit 単位に切り分ける」処理に置換）。fallback（`extractFromScripts`）での使用は残す |
| `mb-analyzer/src/preprocessing/common/setup-cleanup.ts` (`splitAtEnclosure` / `statementsToCode` / `statementToCode` / `containsNode`) | enclosure を含む Program 直下文で分割 | `splitAtEnclosure` の lib-enclosure での役割を廃止（fallback で残す）。`statementsToCode` 等は流用。**新規 hole 化ヘルパをここに追加** |
| `mb-analyzer/src/preprocessing/selakovic/decompose/f1.ts` (`extractF1` / `F1Decomposition`) | inline script から `f1` を `f1Body` / `preF1Statements` / `harnessStatements` / `wrapperKind` / `angular` info に分解 | **そのまま再利用**（workload の seed 抽出元） |
| `mb-analyzer/src/preprocessing/selakovic/decompose/test-case.ts` (`extractTest` / `TestDecomposition`) | server の `test_case_*.js` から `test()` body を分解 | **そのまま再利用**（server workload の seed） |
| `mb-analyzer/src/preprocessing/selakovic/assemble/client.ts` (`buildClientLibCandidate` / `buildClientBodyCandidate` / `buildClientCombinedCandidate` / `buildLibEnclosureCandidate` / private: `flatRunnable` / `clientRecorderHook` / `f1BodyWrapped`) | `(setup, slow, fast)` 組み立て | `buildClientLibCandidate`（embedded）は equiv/fallback 用に残す。`buildLibEnclosureCandidate`（0021 で追加）は **書き直し or 置換**（→ Phase 2/4 の新ロジック）。`buildClientBodyCandidate`（aspect B / A+B body 側）は概ねそのまま（もう小さい） |
| `mb-analyzer/src/preprocessing/selakovic/assemble/angular.ts` (`buildAngularRunnable`) | Angular controller-wrapper の runnable 組み立て | angular 系の dynamic-coverage / 関数本体 split は **Phase 4 以降に回す**（static reachability は angular でも動く） |
| `mb-analyzer/src/preprocessing/selakovic/assemble/recorder-hooks.ts` | C6 recorder hook の runnable 内コード生成 | 新 runnable でも流用（既存どおり） |
| `mb-analyzer/src/preprocessing/selakovic/pipeline.ts` (`preprocessClient` / `preprocessServer`) | 1 issue → `PreprocessingResult[]`。`aspect: A` で `buildClientLibCandidate` + `pushLibEnclosure` | **`aspect: A`（と A+B independent）ブランチを組み替え**（embedded `#0` + workload-reachable な変更関数ごとに `#1+`） |
| `mb-analyzer/src/contracts/preprocessing-contracts.ts` (`CANDIDATE_KIND` / `PreprocessingResult` / `EXCLUSION_REASON`) | TS↔Python JSON 契約 | `CANDIDATE_KIND` に新値 + `EXCLUSION_REASON` に新値（paired-change: `mb_scanner/domain/entities/preprocessing.py` + `tests/domain/entities/test_preprocessing.py`） |
| `mb-analyzer/src/pruning/common/engine.ts` (`prune`) | `(setup, slow, fast)` → 最小パターン | **不変・既存そのまま** |
| `mb-analyzer/src/pruning/common/candidates.ts` (`enumerateCandidates`) | 削除候補列挙（fast と共通な subtree、サイズ降順） | **不変** |
| `mb-analyzer/src/equivalence-checker/common/sandbox/executors/jsdom.ts` (`executeInJsdom`) | jsdom + vm context で `(setup, body)` 実行。`module_base_dir` で server require 解決 | **`<script src>` 順 load プラミングを追加**（or 候補の `setup` に依存 lib のソースを連結 — C1）。dep-vendoring 前提 |
| `mb-analyzer/src/ast/{walk,inspect,subtree-hash,parser}.ts` | `walkNodes` / `countNodes` / `SubtreeSet` / `parse` / `generate` | 流用。新規 `common/reachability.ts` がこれらを使う |
| `data/selakovic-2016-issues/` | dataset。`v_*.html` の `<script src>` に CDN URL（jquery 2.1.3 等、handlebars 1.1.0）。dataset には実体ファイルなし | dep-vendoring の対象。`tmp/vendor/<host>/<path>` に curl 済（jquery 1.7/1.11.3/2.1.3, handlebars 1.1.0）→ production 用に正式化 |

**0021 で確立した「切り方」の問題**: `findMinimalEnclosure` は「変更全部を 1 個の enclosure で包む」ので、変更が IIFE 内の複数の兄弟関数に散ると（version-bump で `Ember.VERSION = '...'` の代入や declarator 並び替え等が別モジュールに散る）LCA = IIFE body → そこから上に向かって最初の関数 = IIFE 自身（90k ノード）。UMD-IIFE では `splitAtEnclosure` が IIFE 全体を返す → `before_node_count` が 30k〜150k → equiv で error / pruning が cap 張り付き or クラッシュ。**diff（`findChangedNodes`）自体は正確**（コメント/整形は無視済、ノイズは「incidental な *コード* 変更」= `Ember.VERSION='...'` の代入や declarator 並び替え）。

**spike で確認した数字（`tmp/0021_.../` の spike 群、本タスク開始時には削除済）**:
- static name-reachability + 「最寄り named 関数」: 11 hard issue（emitted 32k〜153k or UMD-IIFE で諦めた）中 ~8〜9 で huge → tiny（候補 27〜779 ノード、50×〜3000× 削減）。UMD-IIFE で諦めてた issue も回収。
- dynamic coverage（CDN 依存 jquery/handlebars を `<script src>` 順 load した上で）: 動いた 9/13 で static と一致（dynamic ≈ static）→ static を primary でよい。
- miss / 特殊ケース: Ember 9991 / 4263 = benchmark が最適化を inline `<script>` に micro-reconstruct してて lib に通してない（→ 「workload が lib 変更を測ってない」→ discard が正解）。Ember 4158 = `v_before.html` が Ember 1.5 と非互換な jQuery 2.1.3 をペア（本物のブラウザでも assert で死ぬ）。Ember 4263 = handlebars の `<script src>` 欠落。Angular 7759_3 = `f1` の angular 内部関数呼び出しが bootstrap なしで resolve しない（static は名前ベースなので OK、dynamic は `buildAngularRunnable` が要る）。

## 検証状況（spike で確認済 / 未検証）

| 項目 | 状況 |
|---|---|
| Phase 1（`findChangedNodes` の精度）| ✅ 検証済（Ember 5 ノード/jQuery 11 ノード、全部本物。ノイズは incidental な*コード*変更） |
| Phase 2（static name-reachability + nearest-named-fn → 小候補）| ✅ 検証済（11+2 hard issue で ~8-11/13 が小候補 27-779 ノード、UMD-IIFE 回収。dynamic ≈ static） |
| dep-loading の修正（vendored jquery/handlebars を `<script src>` 順 load → Ember の "Could not find module jquery" が消える）| ✅ 検証済 |
| dataset バグ（Ember 4158 jQuery 非互換 / 4263 handlebars 欠落）| ✅ 確認済（ワークアラウンドで load する） |
| 9991/4263 が benchmark に lib 変更を通してない（micro-reconstruct 型）| ✅ 確認済（`v_before.html` を読んで） |
| **Phase 4（変更関数を runnable 化する機構）** | ✅ **検証済 (2026-05-12 の end-to-end spike)**。「naive（穴+グローバルフックだけ）」は不可（変更関数の本体が `slow`/`fast` で定義されるとライブラリ内部スコープが見えない → 内部依存を使う関数は vacuous `equal`）。「**lambda-lift（変更関数が使うライブラリ内部の補助関数・変数を引数化して取り出す）＋ 観測する形（変更関数の戻り値を記録して serialize して返す）**」で **中身のある `equal`**（`return_value` oracle が positive evidence）を確認（Underscore.string `startsWith` → `["true",×8]`、jQuery `index` → `["-1","0","1",×3]`、いずれも slow/fast 一致）。pruning も両方 `pruned`・クラッシュなし・**変更関数の本体を保持したまま incidental だけ抽象化（over-prune してない）**。→ Phase 4 = lambda-lift + 観測する形（詳細は下記） |
| Phase 3（新候補構造で equiv gate が `equal` を返すか）| ✅ 検証済（上記 spike で `equal`） |
| Phase 5（pruning が候補で実際に動く/クラッシュしない）| ✅ 検証済（上記 spike で `pruned`・クラッシュなし。ただし `prune` を数百 iteration 回すとメモリリークで OOM — 別 TODO で修正）。0021 hard issue 全体での削減率は本実装後に再測定（Phase 5） |
| **lambda-lift + 観測する形が 0021 hard issue 群全体で成立するか** | 🟡 **Phase 0.5 で 12 issue サーバ実走済 (2026-05-12)**。クリーンケース 4/4（Underscore.string 347_1/347_2・jQuery 367・Underscore 1222）で「中身のある `equal` + pruned + 本体保持」を確認 = 核は OK。Ember 級 / callback 内変更で 3 つの robustness ギャップ surfaced（① bootstrap-invocation → `__HOLE__` 未定義 error ② AMD `define` 内ローカルが lift-scope から漏れる ③ `pathFromChain` が浅い）。①② は fix 明確 → v1 に折り込む（下記）。③ は Phase 1 A1 Rule 1/2 で対処（Rule 2 を AMD define 対応に拡張）。詳細は `tmp/0022_.../notes.md`・`spike-e2e.log` |
| server issues（`test_case` workload、`require` ベース lib）| ❌ 未検証（spike は全部 client。同じロジックのはず）→ v1 で server まで含めるか要相談 |

→ **end-to-end spike（2026-05-12）完了**: 「core thesis（小候補 → 中身のある等価判定 → pruning が変更関数本体を保持したまま動く）」を Underscore.string 347_1 と jQuery 367 で実証。lambda-lift と「観測する形」の両方が必要なことも確認。残る既知問題（`prune` のメモリリーク、equiv の `argument_mutation` oracle robustness、パターンから足場を剥がす後処理）は別 TODO に。
→ **Phase 0.5（12 issue でサーバ実走、2026-05-12）完了**: 核は再確認できたが、`__HOLE__` 定義のタイミング（bootstrap-invocation）と lift-scope の深さ（AMD `define` 内ローカル）を v1 設計に反映する必要が出た（D1 / Phase 4 / A1 Rule 2 を更新済）。本実装（Phase 1+）に進める状態。

## 設計判断（議論で合意済）

- **A1（変更の unit の決め方）**: 変更ノードから祖先を辿る → 最初に当たる **named 関数**（`function f`/`var f = function`/`X.f = function`/`{f: function}`/ObjectMethod 等、binding から名前が取れるもの）= unit。**「named」は祖先パス上のどこか**（最寄りの FN がたまたま anonymous = 配列 `.forEach(function(){...})` の callback や `define("...",[...],function(){...})` の AMD コールバック本体 なら、それを飛ばしてさらに上の named 関数まで遡る）。`if` 文等は unit にならない（その `if` を囲ってる named 関数が unit。`if` が relevant になるのは Phase 4 の pruning で「変わった `if` だけ」に削る時）。named 関数が祖先パスに無い → unit = **「モジュールレベルの文」**＝ Program / 最外 IIFE-body / **AMD `define(...)` コールバック body** の *直接の子* の statement（`var X = ...;` / `Lib.foo = ...;` / 内側 IIFE 直下の文 / top-level `if` 等。小さい。IIFE 全体・ファイル全体にはならない）。Ember は実体が全部 `define(...)` 内なので、AMD コールバック body を「モジュールスコープ」に含めないと unit が捕まらない（Phase 0.5 で確認: `pathFromChain` が浅いと 5/12 が `cannot determine path`）。どちらにも anchor できない（理論上、実質起きない）→ unanchored で drop（カウント）。
- **候補選別の向き（change-driven。**重要 — `f1` を「事前に与えられたもの」として forward で reachable を出すのではなく、「変更ごとに、それを exercise する workload を探す」backward で組む**）**: 実 PR にこのアプローチを適用するとき `f1`（= 変更を exercise する workload）は事前に分かっておらず「探す」必要がある。なので**変更 unit を起点に「それを（推移的に）呼ぶ／参照する側」をたどり、利用可能な workload 集合のうちその中に入るものがあるか**を見る。データセットでは workload 集合は `{f1}`（issue ごとに 1 個、データセットが与える）、一般の PR では repo の test suite（→ test-impact 解析 ＝ 同じ backward 閉包を test 集合と交差）。データセットだけ見れば forward（`reachable(f1)` を 1 回計算して交差）の方が安いが、それはせず change-driven で組む（一般化のため＋「workload を探す」が明示的ステップになる）。
  - 関数 unit → 変更関数 `g` の **backward call-graph 閉包**（`g` を推移的に呼ぶ関数・workload root の集合）を計算し、その中に利用可能な workload があれば KEEP（その workload が `g` の候補の witness）。なければ DROP（カウント — threats）。例: `Ember.guidFor` を呼ぶ workload `f1` が `callers*(generateGuid)` に入る → `generateGuid` KEEP。
  - モジュールレベル文 unit → その文が *定義する binding/property* を、上で KEEP された（= workload-reachable な）関数のどれか（+ workload 自身）が参照するか（`Ember.VERSION = '...'` → どの reachable 関数も `.VERSION` を読まない → DROP / `var slice = [].slice;` → reachable 関数が `slice` を参照 → KEEP）
  - 実体は: 一度 call-graph を構築（各関数の call site → 名前で resolve した callee へのエッジ。workload root は `f1`/`test()` body の call site）→ 各変更 unit から backward にたどる + 名前参照スキャン。over-approximation（同名メソッドで膨らむ等 — KEEP 寄り = 安全側）。
- **B1 candidate_kind**（2026-05-12 確定）: 新設 **`changed-fn`**（「lib から切り出した workload-reachable な変更関数を lambda-lift + 観測形にした候補」）。`lib-enclosure`（0021 の「全変更を 1 enclosure」前提）は **削除**（0021 の `extracted.jsonl` は Phase 5 で作り直すので互換不要）。あわせて **`aspect` をリネーム**（`A`→`"lib"` / `B`→`"workload"` / `A+B`→`"lib+workload"` / `fallback` 不変。TS const キーは `ASPECT.LIB` / `ASPECT.WORKLOAD` / `ASPECT.BOTH` / `ASPECT.FALLBACK`）— `A`/`B` が opaque で、0022 で「workload」を term of art にしたので揃える。`EXCLUSION_REASON` に `CHANGE_NOT_EXERCISED = "change-not-exercised"` 追加（`DATASET_BROKEN_BENCHMARK` は本物の壊れ dataset が出たら追加、今は不要 — dep-vendoring が 4158/4263 を救う）。contracts は paired-change（TS `preprocessing-contracts.ts` + Python `preprocessing.py` + `tests/domain/entities/test_preprocessing.py`）。
- **B2 embedded candidate を出し続けるか**: 出す（`#0` = 既存 `buildClientLibCandidate`、equiv の安定性が小候補で悪い時のフォールバック / dataset-broken の手がかり）。pruning には `changed-fn` だけ流す（`build_prune_input.py` 相当のフィルタ）。
- **B3 co-evolve する複数変更関数（`guidFor`↔`generateGuid`）**: 当面 **別々の candidate**。Phase 4 の関数本体 split を「複数 hole」対応にして 1 candidate にまとめるのは後回し（規則の本質が見えやすくなる利点はあるが）。
- **B4 dynamic coverage**: v1 は static のみで出す。dynamic escalation は v2 で別途（置き場所が課題 — preprocess は equiv-checker の jsdom executor を import 不可なので `common/` に置くか別 CLI ステップか、を v2 で決める）。
- **C1 依存 lib のロード方法**: 候補の `setup` に依存 lib のソースを HTML 順で連結する（executor を触らずに済む。`setup` 肥大は jQuery 2.x で +84KB だが pruning は `setup` を削らないので害は小）。executor 側でやる案より優先。
- **C2 gate**: 当面 `verdict == equal` のみ（pruning の `isEquivalentEnoughForPruning` は `inconclusive` も含むが、候補が小さくなったので含めても安全。当面 equal-only から様子見）。
- **D1 変更関数の runnable 化の実現**（spike で確定 + Phase 0.5 で精緻化）: **lambda-lift**。変更関数が使うライブラリ内部の補助関数・変数（自由変数のうちモジュールスコープで束縛されてるもの）を引数化して取り出す。ライブラリ本体は `setup` に丸ごと（無変更）入れ、変更関数の本体を以下に置き換える（このフック呼び出しは変更関数の元の場所に書くので `<内部依存>` はそこから見える → 値を外へ転送）:
  ```js
  { if (globalThis.__HOLE__) { return globalThis.__HOLE__.call(this, <内部依存>, <元の引数>); }
    <変更前の本体をそのままインライン> }
  ```
  `slow`/`fast` の `__HOLE__` は `(<内部依存>, <元の引数>)` を受け取る形で変更前/後の本体（+ 観測する形）。「naive（引数化なし）」だと内部依存を使う関数で `ReferenceError` → vacuous `equal` になるので不可（spike で確認）。global 到達可能な関数（`jQuery` 等）では引数化不要だが害なし。
  - **`if (globalThis.__HOLE__)` ガード + 変更前本体のインライン fallback が必須**（Phase 0.5 で確認）: 変更関数が lib bootstrap 中に呼ばれる（`Ember.assert`、underscore の `_.each`/`_.forEach` 等。**「稀」ではない — core 関数で普通に起きる**）と、`setup` 実行時点では `slow`/`fast` がまだ走ってない＝`globalThis.__HOLE__` が未定義 → `.call(undefined)` で `TypeError` → equiv gate が `error`。ガードを噛ませると bootstrap 中は変更前の本体をインライン実行（`slow`/`fast` どちらでも同一＝bootstrap は consistent）、workload 実行時（`slow`/`fast` が `__HOLE__` を設定済み）だけフック経由で観測/差し替え。変更の効果が *bootstrap 時点で* 観測に effく稀なケース（`var X = <module-init expr>` 系）はこのガードでは吸収できない → embedded fallback（下記「モジュールレベル文 unit」）。
  - **lift-scope は lexical chain 全体**（Phase 0.5 で確認）: 「モジュールスコープで束縛されてるもの」= Program.body だけでなく、変更関数を囲う **すべての enclosing function / IIFE / AMD `define(...)` コールバック body** の hoisted 束縛（`var`/`function`/コールバック引数名）。Ember の `metaFor` 等は `define("ember-metal/meta",[...],function(){ var metaFor = ...; })` 内ローカルなので、最外 IIFE だけ見てると漏れて `ReferenceError`（spike: Ember 5547 が `liftDeps=[]` で not_equal）。over-collect（性質キー等も拾う）で安全側。なお `this.<内部メソッド>`（Ember `this._set` 等）は識別子じゃないので lift では拾えない → そのケースは equiv gate で `error`/`not_equal` → discard（v1 では割り切る。深追いは v2）。
- **観測する形（必須、spike で確認）**: ベンチマークが結果を捨てる（Selakovic のベンチマークは perf 用）と等価検証が「観測チャンネルなし」→ `inconclusive` → pruning が何でも削って garbage に。なので変更関数の戻り値を記録して、ベンチマークの最後に記録一覧を serialize して返す（`slow`/`fast` = `globalThis.__HOLE__ = function(<deps>, <args>){ var __r = (function(){<本体>}).call(this); globalThis.__OBS.push(JSON.stringify(__r)); return __r; }; ＋ (function(){ globalThis.__OBS = []; <f1 body>; return JSON.stringify(globalThis.__OBS); })()`）。これで `return_value` oracle が positive evidence を出す → pruning が over-prune できなくなる（過剰削減＝結果が変わる＝`not_equal`＝reject）。
- **モジュールレベル文 unit の Phase 4 の落とし穴**: 変更の効果が *workload 実行時* に観測される文（モジュールレベルの `function` 定義、`var x = require('./impl')` で workload が `x` を workload 中に使う等）→ 同様に hole-and-refill できる。変更が *モジュール初期化時に評価され closure に焼き込まれる `var X = <expr>;`*（`var slice = ...`, `var GUID_KEY = ...`）→ hole-and-refill 不可（`var X = __HOLE__;` を setup で走らせると setup 時点で `__HOLE__` 未定義 → 壊れる）→ **embedded fallback**（lib 全文の before/after を slow/fast に。稀。多くは観測的に同一の perf tweak だが観測に効くものもある）。note して測定。

## 実装計画

> v1 = 「static reachability + 関数本体 split（`__HOLE__` 方式 or それが不要なら簡易方式）+ dep-vendoring + equiv gate + pruning」で 0021 の hard issue で削減率を再測定するまで。dynamic-coverage escalation / angular 対応 / co-evolve まとめ / モジュールレベル文の embedded fallback 詳細 は v2 以降。

### Phase 0: ベースライン確認 + end-to-end spike ✅ 完了 (2026-05-12)

- [ ] 現状 green 確認: `mise run lint-analyzer typecheck-analyzer test-analyzer`、`uv run pytest tests/domain/entities/test_preprocessing.py`、`mise run build-analyzer`（本実装着手時に再確認）
- [x] `tmp/vendor/` に CDN ファイルを curl 済（jquery 1.7/1.11.3/2.1.3, handlebars 1.1.0）。本実装時に不足分を全 `v_*.html` から洗い出して追加 + manifest 化
- [x] **end-to-end spike**: Underscore.string 347_1（`_s.startsWith`）と jQuery 367（`jQuery.fn.index`）で「変更関数を取り出した小候補 → `checkEquivalence` → `prune`」を実証（`tmp/0022_.../spike-e2e.test.ts`、削除済）。**結果**:
  - **naive（穴+グローバルフックだけ、引数化なし）は不可** — 変更関数の本体が `slow`/`fast` で定義されるとライブラリ内部スコープ（`makeString` 等）が見えない → `ReferenceError` → slow も fast も同じエラーで vacuous `equal`。
  - **lambda-lift（変更関数が使うライブラリ内部の補助関数・変数を引数化して取り出す）＋ 観測する形（変更関数の戻り値を記録して serialize して返す）は OK** — Underscore.string `startsWith` → `["true",×8]`、jQuery `index` → `["-1","0","1",×3]`、いずれも slow/fast 一致で **`return_value` oracle が positive evidence → 中身のある `equal`**。`prune` も両方 `pruned`・クラッシュなし・**変更関数の本体を保持したまま incidental だけ抽象化（over-prune してない）**。
  - 既知問題: `prune` を数百 iteration 回すとメモリリークで OOM（spike は 80 iter に下げて回避）/ Ember 3174 は equiv の `argument_mutation` oracle が Ember の globals を serialize できず `error`（candidate-construction じゃなく equiv-checker の robustness 問題）/ パターンに `__HOLE__`/`__OBS` の足場ノイズが付く → いずれも別 TODO。
- [x] **D1 確定**: 関数本体の取り出しは **lambda-lift**（簡易な「再定義」は不可と判明）。「naive vs lifted」の比較は上記 spike で兼ねた。

### Phase 0.5: spike-e2e を 0021 hard issue 群全体でサーバ実走（de-risking の最終ゲート）

> Phase 0 のローカル spike は Underscore.string 347_1 / jQuery 367 の 2 issue だけ。lambda-lift + 観測する形が **0021 の hard issue 群（`aspect: A` のうち emit が huge or UMD-IIFE で諦めた ~11-13 issue）全体**で「中身のある `equal` / pruning が変更関数本体を保持して動く / クラッシュなし」を満たすかは未確認。ローカルだと `prune` のメモリリーク（数百 iter で OOM）で全件は回しきれない → RAM の大きい **brain-2** で `NODE_OPTIONS=--max-old-space-size=...` 付きで回す。**本実装（Phase 1+）に進む前のゲート**。
>
> **対象スコープ = hard issue 群 + 「easy な `aspect: A`」を 2〜3 件**（emit が小さく UMD-IIFE でも諦めてない `aspect: A`。「hard では通るが trivial で壊れる＝設計が hard ケースに過剰適合」を安く検出するためのサニティチェック）。`aspect: B`（body 側変更）は組み立てロジック不変なので **対象外**。全 issue の本番計測（正式な dep-vendoring + 本物の `buildChangedFnCandidate`）は Phase 5 の仕事なので spike では先取りしない。
>
> `spike-e2e.test.ts`（git untracked、冒頭の `TARGETS` で対象 issue / 各 `maxIter` を制御）は **このフェーズ完了までは消さない**。`spike-e2e.test.ts` の `depSources` は Ember 系の `<script src>` jquery 2.1.3 → vendored 1.7 差し替え + handlebars 強制 load（Ember 1.5 が jquery 2.1 を assert で拒否する dataset バグ回避）を既にやっている。

- [x] 対象を広げる: `spike-e2e.test.ts` の `TARGETS` を 12 issue に拡張（hard 群 7 + 既知特殊ケース Ember 4158/4263/9991 + easy sanity Underscore.string 347_2 / Underscore 1223）
- [x] **同期 + サーバ実行**: `mise run sync:brain2` → `rsync tmp/vendor/` → brain-2（実体は **docker コンテナ** `~/workspace/mb-analyzer`）で `NODE_OPTIONS="--max-old-space-size=8192" pnpm vitest run tests/preprocessing/spike-e2e.test.ts`。⚠️ ホストの `/mnt/data1/.../tmp/0022_/` はコンテナにマウントされてないので `tee /mnt/data1/...` は失敗 → ターミナル出力をキャプチャ。生ログ→ `tmp/0022_.../spike-e2e.log`
- [x] 第1回判定 → `tmp/0022_.../notes.md`。**核（小候補 → 中身のある `equal` → pruning が本体保持）は 4/4 のクリーンケースで成立（Underscore.string 347_1/347_2・jQuery 367・Underscore 1222）**。失敗 8 件 = ① bootstrap-invocation で `__HOLE__` 未定義 error（Ember 3174 `Ember.assert` / Underscore 1223 `_.forEach` — core 関数なので「稀」じゃない）② AMD `define` 内ローカルが lift-scope から漏れる（Ember 5547 `metaFor`/`this._set` → not_equal）③ `pathFromChain` が浅く `cannot determine path`（jQuery 248 / Ember 4329_1/4158/4263/9991 — 9991 は実体「lib に通してない」→ discard 正解）。8/8 が「spike が approach の簡略版だった」せいで approach 自体の否定じゃない → **D1 / Phase 4 / A1 Rule 2 に fix を折り込み済**
- [x] **spike v2（Phase 1/4 寄せ実装）に書き直し**: (1) `if (globalThis.__HOLE__)` ガード + after 本体インライン fallback (2) lift = lexical chain 全体（`(function(){...}).call(this)` / `define(...)` も自然に拾う） (3) `findChangedUnits` = 変更ノード全部 → 最寄り named 関数（匿名飛ばす）→ named 無ければ stmt unit（候補組まない）、1 issue で複数 fn unit 可、version bump は stmt unit に落ちる (4) `setup` = after-lib（co-evolve した新ヘルパが居る） + `__OBS` 空 → 「Phase 2 で DROP 相当」と判定して prune スキップ。ローカル smoke: 347_1（`startsWith` ✅ 本体保持 / `endsWith` は vacuous と正しく判定）・1223（`_.forEach` ← 第1回 error → **今回 `equal (中身あり ✓)`**・`pruned`・object 分岐の構造保持）。lint/tsc green
- [x] **spike v2 を brain-2 で 12 issue 再走**（2026-05-12、`spike-e2e-v2.log`）。**preprocess 再設計（候補構築側）は de-risk 完了**: 第1回の 3 ギャップ（① bootstrap-invocation ② lift-scope ③ unit-anchoring）は全部 fix を確認。非 Ember 6/6 fn unit が「中身のある equal + pruned + 本体/変更点保持」。`endsWith`×2 は vacuous → Phase 2 DROP 相当と正しく判定。Ember 4263/9991 は「fn unit なし」と正しく分類（→ stmt-unit / DROP）。**残るブロッカーは preprocess 側じゃない**: (a) equiv-checker の `argument_mutation` oracle が Ember オブジェクト引数を serialize できず `error`（Ember 3174/4329_1/4158 — 候補構築自体は OK、`return_value`/`external_observation` は通る → 別 TODO #3 を「Ember 用に v1 で必要」に格上げ）(b) Ember 5547 = `set` の incidental な戻り値変化を over-observe して false `not_equal` → 保守的 DROP（recall edge、threats に追加）。詳細は `notes.md`。→ **Phase 1 本実装に進む**（spike v2 のロジックを Phase 1/2/4 に移植）

### Phase 1: 変更点の特定 + 変更を unit 単位に切り分け（`common/` に新ヘルパ）

> unit = 最寄りの named 関数（A1 Rule 1）/ 無ければモジュールレベル文（A1 Rule 2）/ どちらにも anchor できなければ unanchored で drop。「named 関数だけ」じゃなく「unit」（関数 or モジュールレベル文）に切り分ける点に注意。

- [x] **`common/change-units.ts` を新設** (spike v2 の `findChangedUnits`/`pathFromChain` を移植・整理): `findChangeUnits(libBeforeSrc, libAfterSrc): { beforeAst, afterAst, units: ChangeUnit[], unanchored, empty }`。
  - `parse` → `findChangedNodes`（既存）→ 変更ノード。空なら `empty: true`
  - 各変更ノードを祖先パスをたどって **最寄りの named 関数**（`functionBindingName` で `function f`/`var f=`/`X.f=`/`{f:}`/ObjectMethod/`X.extend({f:})` を命名、匿名 callback/IIFE/`define(...)` は飛ばす）に anchor → `FnChangeUnit`（`name` で集約、`beforeFn`/`beforeFnAncestors`/`afterFn`/`afterFnAncestors`/`changedNodes`。after は同 name の関数を索引、rename/削除なら null）。named が居なければ「ブロック直下の文」に anchor → `StmtChangeUnit`（`stmt`/`bindings`/`desc`/`changedNodes`）。どちらも無理なら `unanchored++`（理論上ほぼ 0）
  - in-source test 8 件（変更ゼロ→empty / named 関数内→その関数だけ / 1 関数複数変更→集約 / 複数関数→別 unit / 匿名 callback→上の named まで遡る / モジュールレベル→stmt unit / `X.f=`・`{f:}` 命名 / fn unit に afterFn 付く）。`mise` lint/tsc/test green（全 470 tests pass）
- [x] **spike `tests/preprocessing/spike-e2e.test.ts` を削除**（Phase 0.5 完了・ロジックは `change-units.ts` 等に移植済。test-analyzer の suite に乗ると重くて落ちてた）
- [ ] ~~`findMinimalEnclosure` / `splitAtEnclosure` の lib-enclosure 経路を撤去~~ → **Phase 2 冒頭に移動**（`pipeline.ts:preprocessClient` の `aspect: A` ブランチの組み替えと一体。lib-enclosure 経路だけ先に撤去すると `aspect: A` が embedded のみになって `selakovic.test.ts` が壊れる＝Phase 2 のテスト書き換えとセットでやる）。`change-units.ts` の export 整理は済（`findChangeUnits` + 型）

### Phase 2: 変更ごとに「それを exercise する workload を探す」で候補選別（change-driven。`pipeline.ts` + `assemble/` + `common/`）

> v1 のサブフェーズ: **2a = `common/reachability.ts`**[完了] → **2b-i = contracts リネーム/掃除**[完了] → **2b-ii = `changed-fn` 候補生成**[完了]

- [x] **Phase 2b-i — contracts リネーム + lib-enclosure 削除 + 波及**:
  - `preprocessing-contracts.ts` + `preprocessing.py`: `ASPECT` を `LIB="lib"` / `WORKLOAD="workload"` / `BOTH="lib+workload"` / `FALLBACK="fallback"` に（const キー `BODY`→`WORKLOAD`、値も全部リネーム）。`CANDIDATE_KIND` から `LIB_ENCLOSURE` 削除・`CHANGED_FN="changed-fn"` 追加。`EXCLUSION_REASON` に `CHANGE_NOT_EXERCISED="change-not-exercised"`。JSDoc/docstring 更新
  - 波及: `route/aspect.ts`（`ASPECT.BODY`→`WORKLOAD`、JSDoc/in-source test）/ `pipeline.ts`（`pushLibEnclosure`+`buildLibEnclosureCandidate` import 削除・`aspect===ASPECT.LIB` は embedded のみ・`ASPECT.BODY`→`WORKLOAD`・`.map` 簡略化、`changed-fn` 追加箇所に TODO コメント）/ `assemble/client.ts`（`buildLibEnclosureCandidate`+`matchAfterSlowStatement`+`countSubtreeNodes`+`WRAPPER_NODE_BUDGET` 削除、未使用 import 整理、コメント更新）
  - テスト: `selakovic.test.ts`（lib-enclosure 表明削除 → `aspect: lib` は embedded `#0` のみ、A+B independent は `#0`/`#1` の 2 個、`作用点 A/B/A+B`→`lib/workload/lib+workload`、IIFE-buried テストは module-wide と冗長なので削除）/ `tests/contracts/preprocessing-contracts.test.ts`（`EXCLUSION_REASON` に新値、`ASPECT`/`CANDIDATE_KIND` の strictEqual + 型チェックを追加）/ `tests/domain/entities/test_preprocessing.py` / contract-test の `aspect: "A"` リテラル（equivalence/pruning contracts test + Python pruning/equivalence entity test）→ `"lib"`
  - docs: ADR-0011 / ADR-0014 に「2026-05-12 更新（作用点ラベルのリネーム + 0022 の lib narrowing 再設計）」節を追記。`code-map.md` / dataset doc / README の更新は task 末の ai-guide 反映で
  - `mise run lint-analyzer typecheck-analyzer test-analyzer`（480 tests）/ `uv run pytest tests/domain`（77 pass）/ `mise run build-analyzer` 全 green

- [x] **Phase 2a — `mb-analyzer/src/preprocessing/common/reachability.ts` を新設**（spike v2 の call-graph ロジックを移植）:
  - `buildCallGraph(libAst, workloadRoots: {name, body}[]): CallGraph`（`refs: name → 参照名集合` / `fnNames` / `workloadNodes`）。lib の全 named 関数（`change-units.ts` の `functionBindingName`/`FN_TYPES` を import 再利用）+ 各 workload root をスキャン。名前は member-access の末端（`x.foo` → `foo`）で over-approx（KEEP 寄り = 安全側）。エッジ = body 内で参照される識別子 / メンバ名（call site だけでなく `.foo` の読みも — stmt unit の binding を「reachable な関数が参照するか」で見るため）
  - `callersOf(graph, target): Set<string>`（target を推移的に参照するノード名の集合、reverse BFS）/ `isReachedByAnyWorkload(graph, target): boolean`（= callersOf に workload ノードが入るか）/ `lastSegment(name)`（`"a.b.c"` → `"c"`）
  - データセットは workload = `[{name:"f1", body:[...preF1Statements, ...f1Body]}]`（server は `[{name:"test", body:[...testBody]}]`）。一般 PR は repo の test suite を複数 root として渡せば test-impact 解析になる（同じグラフ再利用）
  - in-source test 7 件（末端正規化 / 直接呼び出し → reachable / 推移呼び出し → reachable / 未参照 → not / reachable 関数が読む binding → reachable・誰も読まない binding → not（version-bump DROP）/ 複数 workload root / callersOf）。`mise` lint/tsc/test green（477 tests）

- [x] **Phase 2b-ii — `changed-fn` 候補生成**:
  - `mb-analyzer/src/preprocessing/common/function-hole.ts`（新設、dataset 非依存）: `freeIdentifierNames` / `liftableNames`（lexical chain 全体の hoist 束縛）/ `pickLiftedDeps`（= `(freeVars(before)∪freeVars(after)) ∩ liftable − params`）/ `holeLibSource`（lib(after) の変更関数 body を `{ if (globalThis.__HOLE__) { return __HOLE__.call(this,<deps>,<args>); } <after 本体インライン> }` に置換）/ `buildHoleFunction`（`__HOLE__` 関数式 = 本体実行 → 戻り値を `__OBS` に記録 → 返す）/ `wrapWorkloadObserved`（workload を `(function(){__OBS=[]; <body>; return JSON.stringify(__OBS);})()` で包む）/ `functionBlockBody` / `paramNames` / `countSubtreeNodes`。in-source test 7 件
  - `mb-analyzer/src/preprocessing/selakovic/assemble/changed-fn.ts`（新設）: `buildChangedFnCandidate(unit: FnChangeUnit, libAfterSrc, f1Decomposition, depLibSources): PreprocessingResult | null`。`setup` = (依存 lib…) + lib(after、穴あき) + preF1 / `slow`/`fast` = `globalThis.__HOLE__ = <before/after 本体の hole 関数>;` + 観測する形の workload / `enclosure_type = afterFn.type` / `candidate_kind = "changed-fn"` / node count は変更関数本体のサイズ。`afterFn===null` / arrow body / param 名不一致 / angular wrapper f1 → `null`。in-source test 3 件
  - `pipeline.ts`: `appendChangedFnCandidates(candidates, libSourceBefore, libSourceAfter, f1Before)` を追加し、`aspect: lib` ブランチ（と `aspect: lib+workload` independent の lib 側）で呼ぶ。中身 = `findChangeUnits` → fn unit（`afterFn !== null`）を抽出 → `buildCallGraph(beforeAst, [{name:"f1", body:[...preF1, ...f1Body]}])` → `isReachedByAnyWorkload(graph, unit.name)` で KEEP → `buildChangedFnCandidate` で `#1+` を push。fn unit なし / lib parse 失敗 / angular wrapper → embedded のみ。`.map` で `changed-fn` は builder の node count を尊重（一括上書き対象外）
  - `selakovic.test.ts`: 「f1 が変更 lib 関数を呼ぶ → embedded `#0` + changed-fn `#1`（lambda-lift で内部依存を引数化、setup に穴あき lib、slow/fast に `__HOLE__`+観測+workload、node count は変更関数本体サイズ）」テスト追加。「f1 が lib を呼ばない → embedded のみ（changed-fn は reachability で DROP）」を明示
  - `mise run lint-analyzer typecheck-analyzer test-analyzer`（491 tests）/ `uv run pytest tests/domain`（77 pass）/ `mise run build-analyzer` / `mise run check-arch` 全 green

- [ ] **残（v1 内 / 要相談）**:
  - server（`preprocessServer`）も同様に `changed-fn` を出すか — workload = `test()` body、lib = `<lib>_*.js` の named 関数。embedded server runnable は残す。今は client だけ。v1 で server まで広げるか相談
  - DROP した fn unit（`change-not-exercised`）/ unanchored を `excluded` result として吐いて集計するか — 今は黙って skip（embedded `#0` がカバー、`build_prune_input.py` の `candidate_kind in {changed-fn, body}` フィルタで pruning から外れる）。Phase 5 の集計で要るなら追加
  - `buildClientBodyCandidate`（aspect: workload）の `f1BodyWrapped` を「観測する形」にするか（aspect workload でも結果を捨てるベンチなら同じ inconclusive 問題） — 要検討

### Phase 3: 等価検証ゲート + dep-vendoring（別 TODO と連動）

- [x] **dep-vendoring**（方針 = ADR-0016 の仕組みを client `<script src>` dep にも適用。詳細・タスク内訳は `tmp/0022_.../dep-vendoring-tasks.md`）:
  - fork（`tomoya0318/selakovic-2016-issues`）PR #2（`be15a06`）で client-issue 用の vendor location（`package.json` + `pnpm-lock.yaml`）を追加 — jquery@{2.1.3, 1.11.3, 1.7.2} / handlebars@1.1.0 / underscore@1.8.3 を category 単位で（issue_3174/3288 は jquery 1.7.2 を issue 単位 override）。`scripts/install-vendor-deps.sh` / `MODIFICATIONS.md` 更新。MB-scanner 側で submodule pointer を `be15a06` に bump（commit `8e6a52c`）
  - `mb-analyzer/src/preprocessing/selakovic/io/script-deps.ts`（commit `05a4481`）: `classifyScriptSrcs`（`<script src>` を harness / patched-lib / cdn-dep / local-other に分類）+ `resolveScriptDepSources`（cdn-dep を issueDir から祖先方向に最寄りの `node_modules/<pkg>/<候補>` で解決して読む — issue 単位が category 単位より優先 → issue_3174/3288 の jquery 1.7.2 override が効く）。`<lib>_*.js` の swap は preprocess が `lib_*_files` で扱うので resolver は skip / harness（`execute.js`/`jstat`/`JSXTransformer`）も skip
  - 候補の `setup` 先頭に dep ソースを連結（C1）— `pipeline.ts` が `dep_lib_sources` を全候補（changed-fn / embedded / fallback）の `setup` に一括連結。CLI が `resolveScriptDepSources` で解決して `dep_lib_sources` に詰める（解決漏れは stderr に）。executor 不変
  - ⚠️ Ember 4158（`v_before.html` が Ember 1.5 と非互換な jquery 2.1.3 を `<script src>`）は issue 単位 override 未投入 → category の jquery 2.1.3 が解決され Ember bootstrap が assert で落ちる → equiv gate で `error` → discard（recall 限界、dataset bug。必要なら後で issue_4158 に jquery 1.7.x override を入れて救済可）。4263（handlebars 欠落）は EmberIssues category の handlebars@1.1.0 で自動補完される
  - 残: **M6 = brain-2 で `data/selakovic-2016-issues/scripts/install-vendor-deps.sh` を回して `node_modules/` 再生成**（ユーザー）。`io/script-deps.ts` の `PKG_FILE_CANDIDATES`（npm パッケージ内の `.js` 本体の位置）は推測込み → M6 で実 layout を見て調整
- [x] equiv gate 自体は既存（`mbs check-equivalence-batch` → verdict でフィルタ）。`build_prune_input.py`（0021 のやつ = `tmp/0021_preprocess-pruning-candidate/build_prune_input.py`）を **`verdict == equal` のみ**に戻した（C2。`PRUNE_VERDICTS = {"equal"}` + docstring 更新）。Phase 5 用の 0022 版は equal-only + `candidate_kind in {changed-fn, body}` フィルタで別途作る
- [x] `<lib>_*.js` の before/after swap が candidate 組み立て側で済む形（embedded は `buildClientLibCandidate` が before/after を slow/fast に、`changed-fn` は `buildChangedFnCandidate` が `__HOLE__` に before/after を割って setup の holed-lib は after で固定）。`<script src>` の `<lib>_before.js` 自体は resolver が skip（dep じゃなく SUT）

### Phase 4: pruning 向け runnable 組み立て（lambda-lift + 観測する形、`assemble/` + `common/`）

**候補の構造（spike で実証、Phase 0.5 で精緻化）**: `setup` には **patched lib を丸ごと残す**（変更関数の本体だけ `{ if (globalThis.__HOLE__) { return globalThis.__HOLE__.call(this, <内部依存>, <元の引数>); } <変更前の本体をインライン> }` に置換）+ 依存 lib（vendored jquery/handlebars 等）+ preF1。`<内部依存>` = 変更関数が使うライブラリ内部の補助関数・変数（lambda-lift。lexical chain 全体の hoisted 束縛 ∩ 本体の自由変数。フック呼び出しは変更関数の元の場所に書くのでそこから見える → 値を外へ転送）。ガード + インライン fallback により lib bootstrap 中（`__HOLE__` 未設定）は変更前の本体で素直に動く。preprocess が「落とす」のは計測ハーネス（`execute(f1,n)`/`jStat`/`$.ajax`）とハーネス専用 dep だけ。**「小さい」のは `slow`/`fast`**（= 変更関数の本体 + workload）で、これが pruning が削る対象。`setup`（lib 全文 + dep）は大きいまま。
- `slow` = `globalThis.__HOLE__ = function(<内部依存>, <元の引数>){ var __r = (function(){ <変更前の本体> }).call(this); globalThis.__OBS.push(JSON.stringify(__r)); return __r; }; ＋ (function(){ globalThis.__OBS = []; <f1 body>; return JSON.stringify(globalThis.__OBS); })()`。`fast` = 同じく `__HOLE__` に変更後の本体。`setup` の holed lib に `if (globalThis.__HOLE__)` ガードが入ってるので、`slow`/`fast` が `__HOLE__` を設定した後の呼び出しだけ観測される。
- **観測する形が必須**（spike で確認）: ベンチマークが結果を捨てる → 等価検証が「観測チャンネルなし」→ `inconclusive` → pruning が over-prune。変更関数の戻り値を記録して serialize して返すと `return_value` oracle が positive evidence を出す → pruning が「結果が変わる削減は `not_equal`」で reject できる → over-prune しない（spike: Underscore.string/jQuery とも変更関数本体を保持したまま incidental だけ抽象化）。
- pruning の win: (a) **iteration が少ない**（`slowAst` が小さい）(b) **クラッシュしにくい**（pruning は `slow` = 変更関数本体しか mutate しない。lib bootstrap は `setup` で不変 → 壊れた本体は `f1()` 呼び出し時に *同期* throw → sandbox が catch → `verdict=error` → `continue`、worker を殺さない）。per-iteration は lib bootstrap のまま（`setup` 毎回走る）— ここを速くするには v2 で `setup` を「変更関数の依存閉包」だけに絞る（v1 は lib 丸ごとで simple & correct）。
- **runnability の判別時点**: preprocess は候補を *構築* するだけ（純 AST、実行しない）。実行検証は **equiv gate が初回**（dep 欠落 / lambda-lift が壊れてる / module-init が変更関数を呼ぶ 等 → `verdict=error`/`not_equal`/`inconclusive` → pruning に行かず discard）。pruning も初回 equiv check で再確認 + 各 iteration で「この削減で runnable/等価が壊れないか」を equiv check（壊す削減は reject）。
- module-init が変更関数を呼ぶケース（`Ember.assert`、underscore の `_.each` 等 — **普通に起きる**、Phase 0.5 で確認）→ holed 本体の `if (globalThis.__HOLE__)` ガード + 変更前本体インライン fallback で吸収（D1 参照）。変更の効果が *bootstrap 時点で* 観測に effくケース（`var X = <module-init expr>` 系）だけ embedded fallback。

- [ ] `common/` に lambda-lift ヘルパ（`common/function-hole.ts` 等）:
  - 変更関数の自由変数のうち**モジュールスコープで束縛されてるもの**（= ライブラリ内部の補助関数・変数）を求める。「モジュールスコープ」= Program 直下 + **変更関数を囲うすべての enclosing function / IIFE / AMD `define(...)` コールバック body** の hoisted 束縛（`var`/`function`/コールバック引数名）。∩ 関数本体の自由変数。over-collect（性質キー等も拾うが ∩ で落ちる）で安全側。Phase 0.5 で「最外 IIFE だけだと Ember の `define(...)` 内ローカル（`metaFor` 等）が漏れて `ReferenceError`」を確認したのでこの拡張が必須
  - lib ソースを transform: 変更関数の本体（の `{...}` span）を `{ if (globalThis.__HOLE__) { return globalThis.__HOLE__.call(this, <内部依存>, <元の引数>); } <変更前の本体をそのままインライン> }` に置換（文字列スプライス or AST mutate + generate）。ガード + インライン fallback は bootstrap-invocation（`__HOLE__` 未設定時の呼び出し）対策で必須（D1 参照）
  - in-source test（小さい合成 lib で「内部依存が引数に来る / 置換後の lib が parse できる」）
- [ ] `assemble/client.ts` に `buildChangedFnCandidate(libBefore, libAfter, unit, f1Decomposition, depLibSources)`:
  - `setup` = 「依存 lib のソースを HTML 順で連結」+「lib（before、変更関数を上記 transform）」+「preF1（ループ上限はそのまま — pruning の等価検証で使うので reduce はしない。ただし時間が問題なら `--timeout-ms` で対処）」
  - `slow`/`fast` = 上記の `__HOLE__` バインド（before/後の本体、内部依存を引数で受け取る形）+ 観測する形の workload
  - `enclosure_type` = unit のノード型 / `candidate_kind = "fn-enclosure"` / `before_node_count` = before 本体のノード数 / `after_node_count` = after / `environment = "jsdom"`
  - モジュールレベル文 unit の場合: 効果が workload 実行時に観測されるなら同様の hole-and-refill（文を hole 化、before/after を slow/fast に）。closure に焼き込まれる `var X = <module-init expr>` なら embedded fallback（note して exclude or embedded-only）
  - angular wrapper の f1 の場合: v1 では runnable 組み立ては embedded or skip（static reachability の判定は出す）→ v2 で `buildAngularRunnable` を hole 対応に
  - in-source test
- [ ] pruning エンジン（`pruning/common/engine.ts`）は **不変**。`buildClientBodyCandidate`（aspect B / A+B body 側）も概ねそのまま（もう小さい）。ただし observability のため `buildClientBodyCandidate` の `f1BodyWrapped` も「観測する形」（f1 の戻り値 or `__OBS` を返す）にするか要検討（aspect B でも結果を捨てるベンチマークなら同じ問題）

### Phase 5: 再測定（0021 の hard issue で削減率を比較）

- [ ] `tmp/0022_.../` を作業場に。新方式で preprocess → `extracted.jsonl`。`changed-fn` 候補の件数 / `before_node_count`（変更関数 body のサイズ）の分布 / unanchored で drop した件数 / dataset-broken で除外した件数 を集計
- [ ] `candidate_kind in {"fn-enclosure", "body"}` だけを対象に equiv-input を組む（dep-vendoring 適用） → `check-equivalence-batch` → `verdict==equal` で gate → `prune-batch`（`max_iterations` は適度に大きく、`--batch-size 1`）
- [ ] 削減率を集計（`1 - node_count_after/node_count_before` の median/分布、`iterations` がキャップに張り付いてないか、enclosure_type 別）。0021（lib-embedded、median 0.237）/ 0021 の lib-enclosure（median 0.642 だがキャップ張り付き）と比較表を `tmp/0022_.../comparison.md` に。`notes.md` に所感
- [ ] 結果次第の判断: (a) 削減率が上がり収束する → 成功、v2（dynamic escalation / angular / co-evolve まとめ / server）へ or 分析フェーズへ。(b) 候補は小さいが削減率が低い → 等価検証（C6 oracle 等）が厳しすぎる別問題。(c) hole-and-refill が壊れるケースが多い → 関数本体 split の設計を見直し

### Phase 6: 仕上げ

- [ ] `tmp/0022_.../{plan.md,prompt.md,notes.md,comparison.md}` 更新
- [ ] `ai-guide` 反映: `code-map.md` の Selakovic 前処理章を新方式に書き換え（diff → workload-reachability で変更関数選別 → equiv gate → 関数本体 split → pruning）/ `mb-analyzer/src/preprocessing/README.md` 更新 / ADR-0014（A+B split）に補足 or 新 ADR（workload-reachability ベースの候補選別）
- [ ] threats-to-validity を `ai-guide` の該当箇所に明記（下記「懸念事項・リスク」参照）
- [ ] commit / PR（dep-vendoring の vendored ファイルをどう管理するか — repo に commit するか .gitignore して manifest+取得スクリプトにするか — を決める）

## 別 TODO（本タスクと連動するが独立して進めうるもの）

1. **dep-vendoring + executor の `<script src>` 順 load** — Phase 3 の一部として着手するが、production 用の正式化（vendored ファイルの置き場所・manifest・取得スクリプト）は別途。Ember 級 lib の equiv-check が今 `Could not find module jquery` で死んでる（0021 でも詰まってた）のを直す。
2. **`prune` のメモリリーク修正** — `prune` を数百 iteration 回すと vm context が解放されず OOM（spike も Ember 系の prune も踏んだ）。修正＝各 iteration で context を dispose / 子プロセスで隔離して reap。**Phase 5 で多めの `max_iterations` で回すために実質必要**（当面は `max_iterations` 控えめ + `--batch-size 1` で凌ぐ）。
3. ~~**equivalence-checker の `argument_mutation` oracle の robustness**~~ ✅ **実装済 2026-05-12**（option 1）— `UNSERIALIZABLE_MARKER`（発生源は `serializer.ts` の循環参照検出のみ。Ember は `globalThis.Ember` が循環グラフ）を含む key を比較対象から除外、残り 0 件なら `not_applicable`（`error` に丸めない）。`oracles/argument-mutation.ts` + in-source test + ADR-0018「2026-05-12 更新」節。ローカルで Ember 4329_1 が `error` → `equal (中身あり)` + `pruned` に flip するのを確認。option 2（serializer で循環を `<circular>` に丸める = key 除外も不要になる）は `serializer.ts` に TODO コメントで残した（v2、要 maxDepth デフォルト）。
4. **equivalence-checker の sandbox 堅牢性（throw で worker を殺さない）** — 1 回の `checkEquivalence` の async throw / OOM が worker を殺さず `verdict=error` を返すように（子プロセス隔離 or uncaughtException ハンドラ）。0019/0021 で SIGABRT を踏んでた。候補が小さくなれば踏みにくくなるが根本治療は別タスク。#2 と一緒に「equiv-checker を子プロセス隔離する」で両方解決できるかも。
5. **抽出パターンから足場（`__HOLE__`/`__OBS` ラッパー、workload IIFE）を剥がす後処理** — cosmetic。pruning の出力（`pattern_code`）から、変更関数本体に当たる部分だけを取り出す。
6. ~~**`build_prune_input.py` を equal-only に戻す**~~ ✅ 済（2026-05-12、`tmp/0021_.../build_prune_input.py` の `PRUNE_VERDICTS = {"equal"}`）。
7. **dynamic-coverage escalation の実装**（Phase 2 v2）— lib を instrument して jsdom で `<script src>` 順 load → workload 実行 → 実行関数の集合 → `changed ∩ それ`。置き場所（`common/` か別 CLI ステップか）を決める。static が KEEP 0 or 候補がデカすぎる時のみ発動。`tmp/vendor/` の vendored ファイルを共用。
8. **angular の `buildAngularRunnable` を lambda-lift 対応に**（Phase 4 v2）— angular controller-wrapper の f1 で変更関数を取り出せるように。

## 懸念事項・リスク（threats-to-validity）

1. **test-input-bounded soundness**（既知、current.md の「Unsound pruning → 実行ベースではテスト入力のみ保証」）— workload（`f1`）が exercise する入力でしか等価性を保証できない。複数 witness（test suite）で緩和できるが本タスクでは `f1` 1 個。
2. **static reachability の over-approximation** — call-graph closure が同名メソッド（`apply`/`call`/`forEach` 等）で膨らむ（KEEP 寄り = 安全側）。indirect call（`new this.constructor()` 等）で under-approx し得る → その変更が DROP される可能性（→ dynamic escalation が拾う、or 「workload が測ってない」として discard でも実用上 OK な場合が多い）。angular 内部関数は名前ベースなら頑健（実際に callable かに依らず KEEP できる）。
3. **「benchmark が lib 変更を inline `<script>` に micro-reconstruct してて lib に通してない」型**（Ember 9991 / 4263 で確認）— lib-side の workload-reachability では拾えない（→ discard が正解）。inline-script diff からなら拾える（preprocess routing 次第。aspect: A だと inline は「fixed@before」扱いなので今は見ない）or anti-unify-without-execution / workload 合成（future work）。**recall の限界。明記する。**
4. **dataset の `<script src>` ミス**（Ember 4158 = `v_before.html` が Ember 1.5 と非互換な jQuery 2.1.3 をペア / Ember 4263 = handlebars の `<script src>` 欠落）— **dep-vendoring が swap/補完すれば動く**（4158 = jQuery 1.7〜1.10 に差し替え / 4263 = handlebars を常時 load。spike v2 で確認済 — 両方 lib はロードできた）。なので「dataset-broken-benchmark で除外」じゃなく「dep 解決ヘルパが swap/補完する known workaround」として扱う（threats じゃなく実装事項）。本物の dataset-broken（dep をどう足しても動かない）が出たら初めて除外。
5. **変更関数の戻り値の over-observation**（spike v2 で Ember 5547 で確認）— 「観測する形」が変更関数の戻り値を `__OBS` に記録するので、extract-method 系リファクタ（`set` を `set`+`_set` に分割し、ラッパ `set` が `this._set(...)` を呼ぶだけで `return` しなくなる → `set` の戻り値が "セット値" → undefined）で `not_equal` になる。Ember の public API（`Ember.set()`）は `desc.set()` の戻り値を見ないので実害なしの incidental 差だが、我々は over-observe してる → 保守的に DROP（recall 限界）。**v2 で「call-trace 観測形」（戻り値でなく、変更関数が呼ぶ lib 関数の列を記録）に置き換える余地** — これは `forEach`/`each` のような side-effecting 関数で `return_value` 証拠が弱い（`[null,null,null]`）問題も同時に改善する。v1 は現状の return-value + multi-oracle（`argument_mutation`/`external_observation` が constraint を補う）で進める。
6. **モジュールレベル文 unit の hole-and-refill 不可ケース**（closure に焼き込まれる `var X = <module-init expr>`）— embedded fallback（大きい → pruning が苦戦し得る）。稀。測定して頻度を見る。
7. **dynamic-coverage の置き場所**（preprocess は equiv-checker の jsdom executor を import 不可 = ESLint 依存方向）— v2 で決める。`common/` に共有モジュールを切るか、別 CLI ステップ（preprocess と equiv の間に `mbs probe-coverage`）か。
8. **dep-vendoring の再現性 / CDN リンク切れ** — 2016 年の CDN URL（jquery/handlebars/jstat）。googleapis/cdnjs は historical version を保持してるので入手は容易だが、念のため sha256 manifest でピン留め + repo に vendoring するか .gitignore + 取得スクリプトにするかを決める。
9. **「論文非依存」ルール** — pruning 本体（`pruning/common/`）は触らない（不変）。本タスクは preprocess 側（`selakovic/` + `common/` の前処理ヘルパ）の変更なので dataset 依存 OK（`f1` 規約等を積極利用）。

## 備考

- 本タスクは 0021 の継続（0021 で lib-enclosure を実装・実走 → 「切り方が悪い」と判明）。0021 の `notes.md` / `comparison.md` / `build_*.py` / `summarize.py` / vendored CDN ファイル（`tmp/vendor/`）は Phase 5 の再測定で流用する。
- 設計は同セッション内の議論で詰めた（複数 spike を回しながら）。spike 用テストファイルは都度削除済（`tmp/vendor/` は保持）。
- 「workload」の抽象は `f1` ∪ test ∪ 任意の実行可能体 — 将来「変更をカバーするテストを持つ任意 PR」に一般化できる設計にしておく（マイニングは workload 付き変更例から、適用（パターン → ESLint ルール）は workload 不要、の非対称は維持）。本タスクは Selakovic dataset 範囲で実装。
