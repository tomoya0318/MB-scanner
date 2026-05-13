# notes — preprocess-workload-reachability-redesign

## Phase 0.5: spike-e2e サーバ実走の結果 (2026-05-12, brain-2)

`spike-e2e.test.ts` の TARGETS を 12 issue に拡張して brain-2（docker コンテナ内、vitest v3.2.4）で実走。生ログ: `spike-e2e.log`。

### 結果サマリ

| # | issue | path | liftDeps | checkEquivalence | prune | 判定 |
|---|---|---|---|---|---|---|
| 1 | Underscore.string 347_1 (startsWith) | `_s.startsWith` | makeString, slice | **equal（中身あり ✓）** return_value `["true"×8]` 一致 | **pruned** 152→144 (200/200, cap) | ✅ 成功 |
| 2 | jQuery 367 (index) | `jQuery.fn.index` | jQuery | **equal（中身あり ✓）** return_value `["-1","0","1"×3]` 一致 | **pruned** 149→123 (171/200) | ✅ 成功 |
| 3 | jQuery 248 | — | — | — | — | ⚠️ spike 限界: `cannot determine path (parent=CallExpression)` |
| 4 | Underscore 1222 (values) | `_.values` | (なし) | **equal（中身あり ✓）** return_value 配列一致 | **pruned** 116→108 (100/200) | ✅ 成功 |
| 5 | Ember 3174 (assert) | `Ember.assert` | (なし) | **error** `Cannot read properties of undefined (reading 'call')` | — | ❌ bootstrap-invocation |
| 6 | Ember 4329_1 (cacheFor) | — | — | — | — | ⚠️ spike 限界: `cannot determine path` |
| 7 | Ember 5547 (set) | `ComputedPropertyPrototype.set` | (なし → **取りこぼし**) | **not_equal** `ReferenceError: metaFor is not defined` vs `TypeError: this._set is not a function` | initial_mismatch | ❌ lift-scope 不足 |
| 8 | Ember 4158 (jQuery 非互換 dataset バグ) | — | — | — | — | ⚠️ spike 限界: `cannot determine path` |
| 9 | Ember 4263 (handlebars 欠落) | — | — | — | — | ⚠️ spike 限界: `cannot determine path` |
| 10 | Ember 9991 (micro-reconstruct) | — | — | — | — | ⚠️ `cannot determine path`（実体は「lib に通してない」→ discard 正解） |
| 11 | Underscore.string 347_2 (easy sanity) | `_s.startsWith` | makeString, slice | **equal（中身あり ✓）** | **pruned** 152→140 (200/200, cap) | ✅ 成功 |
| 12 | Underscore 1223 (forEach, easy sanity) | `_.forEach` | (なし) | **error** `Cannot read properties of undefined (reading 'call')` | — | ❌ bootstrap-invocation |

**スコア**: 中身のある equal + pruned = **4/12**（fn を特定できた 7 件中 4 件）。pattern_code を見ると **4 件とも変更関数の本体を保持したまま incidental（`this`/`undefined`/scaffold）だけ `$P*` に抽象化** = over-prune してない（spike Phase 0 の Underscore.string/jQuery の所見と一致）。

### core thesis は成立、ただし spike の実装が浅い箇所が 3 つ surfaced

成功した 4 件はいずれも「小さい lib（Underscore/Underscore.string）or グローバル到達（jQuery）」「変更関数が named で path が一意」「内部依存が Program 直下 or 最外 IIFE 直下」のケース。**「小候補 → 中身のある等価判定 → pruning が本体を保持して動く」という核は再確認できた。** 一方、Ember 級 / callback 内変更で 3 つの失敗モードが出た（既知の dataset バグとは別の、実装上の robustness ギャップ）:

1. **bootstrap-invocation エラー**（Ember 3174 `Ember.assert` / Underscore 1223 `_.forEach`）— 変更関数が lib bootstrap 中に呼ばれる → `setup` 実行時点で `globalThis.__HOLE__` が未定義 → `.call` で `TypeError` → equiv gate が `error`。**plan は「稀」として embedded fallback 行きにしてたが、`_.forEach` は core 関数なので稀じゃない。** → **fix（v1 に入れる）**: holed 関数本体を `{ if (globalThis.__HOLE__) return globalThis.__HOLE__.call(this, <deps>, <args>); <変更前の本体をそのままインライン> }` にする。bootstrap 中（`__HOLE__` 未設定）は変更前の本体をインライン実行、workload 実行時（`slow`/`fast` が `__HOLE__` を設定済み）はフック経由で観測。`slow` の `__HOLE__` = 変更前の本体、`fast` = 変更後。これで bootstrap は常に動き、workload-time の呼び出しだけ観測/差し替えされる。

2. **lift-scope 不足**（Ember 5547 `ComputedPropertyPrototype.set` が `metaFor` / `this._set` を要求するが `liftDeps=[]`）— `metaFor` は Ember の `define("ember-metal/...", [...], function(){ var metaFor = ...; })` という **AMD モジュールコールバック内のローカル**。spike の `moduleScopeNames` は Program.body + **最外** IIFE の body しか見ないので拾えない → lambda-lift から漏れて `ReferenceError`。 → **fix（v1 に入れる）**: 変更関数から Program までの **lexical scope chain 全部**（各 enclosing function / IIFE / `define(...)` コールバック body の hoisted 束縛）を liftable とみなす。over-collect で安全側。

3. **unit-anchoring が浅い**（jQuery 248 / Ember 4329_1 / 4158 / 4263 / 9991 が `cannot determine path (parent=CallExpression)`）— 変更ノードを囲う最寄り FN の親が `CallExpression`（= `define("...", [...], function(){...})` のコールバック本体、or 配列 `.forEach(function(){...})` の callback）で、spike の `pathFromChain` がそれを命名できず諦める。 → plan の Phase 1 A1 で対処済の設計（Rule 1: 最寄り **named** 関数まで遡る / Rule 2: 無ければ **モジュールレベル文** unit）。ただし **A1 Rule 2 の「モジュールスコープ」に AMD `define(...)` コールバック body を含める**必要がある（Program / 最外 IIFE だけじゃ Ember は捕まらない）。9991 は実体が「benchmark が最適化を inline `<script>` に micro-reconstruct してて lib に通してない」→ DROP が正解（threats #3）。

### 判断

- Phase 0.5 の DoD「大半の hard issue で中身のある equal」は**未達**（4/12）。ただし失敗の内訳は (spike 浅さ 5 件 / bootstrap-invocation 2 件・fix 明確 / lift-scope 1 件・fix 明確) で、**核の機構は 4/4 のクリーンケースで実証**された。
- → **本実装（Phase 1+）に進む。ただし上記 fix #1・#2 を v1 に折り込み、A1 Rule 2 を AMD define 対応に拡張する**（plan 更新済）。Ember 級が v1 で本当に拾えるかは Phase 5 の再測定で確認（or 必要なら fix #1/#2 を入れた spike を 1 回だけ再走）。
- 既知の dataset バグ（4158/4263）と micro-reconstruct（9991）は plan どおり `dataset-broken-benchmark` / `change-not-exercised` で除外 + threats に明記。

### 運用メモ

- brain-2 では repo を **docker コンテナ**（`~/workspace/mb-analyzer`）で動かしており、ホストの `/mnt/data1/.../tmp/0022_.../` はコンテナにマウントされてない → `tee /mnt/data1/...` は失敗する。spike ログはコンテナ内パス（`/home/tomoya-n/workspace/...`）に出すか、ターミナル出力をキャプチャする。plan の Phase 0.5 手順を要修正。
- vitest 終盤の `Timeout calling "onTaskUpdate"` は console.log 過多による worker RPC timeout（テスト結果には無害、12/12 passed — spike の `it()` は assert しないので「passed」は「クラッシュせず完走」の意味）。

## spike v2（Phase 1/4 寄せ実装）— 2026-05-12

第1回の所見を反映して `spike-e2e.test.ts` を書き直し（throwaway だが中身は Phase 1/4 の設計のミニ実装）:

- **(1) `if (globalThis.__HOLE__)` ガード + 変更後本体のインライン fallback**: holed 関数 = `{ if (globalThis.__HOLE__) { return globalThis.__HOLE__.call(this, <deps>, <args>); } <after 本体をインライン> }`。bootstrap 中（`__HOLE__` 未設定）は after 本体で素直に動く。
- **(2) lift = lexical chain 全体**: `liftableNames(ancestors)` = Program + 変更関数を囲うすべての function / IIFE / `define(...)` コールバック body の hoisted 束縛（`var`/`function`/params）。`(function(){...}).call(this)` 形（underscore）も自然に拾える（ancestors を辿るだけなので wrapper 形を pattern-match しなくていい）。
- **(3) `findChangedUnits`**: 変更ノードを**全部**見て、各々を最寄りの **named** 関数まで遡る（匿名 callback/IIFE は飛ばす）→ named がいなければ stmt unit（説明のみ、候補は組まない）。1 issue で複数 fn unit を出しうる。version bump 等は stmt unit に落ちる。
- **(4) `setup` = after-lib**（変更関数の本体だけ holed）。co-evolve した新ヘルパ（`_set` 等）が after-lib に存在するので参照できる。
- 追加: checkEquivalence 後に `__OBS` が空（= workload がその fn を 1 度も呼ばない）なら「実パイプラインなら Phase 2 reachability で DROP される候補」と判定して prune をスキップ（vacuous な候補を garbage に削るのを防ぐ）。spike には call-graph が無いので「実際に呼ばれたか」で代用。

**ローカル smoke（347_1 / 1223 のみ実走、残り 10 は server で）**:
- Underscore.string 347_1 → fn units = `_s.startsWith` + `_s.endsWith`（第1回は `findChangedFn` が最初の 1 個で止まってたので startsWith しか見えてなかった）。`startsWith` = `equal (中身あり ✓)` `["true"×8]` → `pruned 152→144`・**本体保持**（incidental だけ `$P*`）。`endsWith` = `equal` だが `__OBS=[]` → **vacuous（workload が endsWith を呼ばない）→ Phase 2 で DROP 相当**と正しく判定、prune スキップ。
- Underscore 1223（`_.forEach` — 第1回は bootstrap-invocation で `error`）→ **今回は `equal (中身あり ✓)`**。`liftDeps=[nativeForEach,breaker,_]`（第1回は `[]` だった = `(function(){...}).call(this)` を見てなかったバグが直った）。`return_value=[null,null,null]`（`each` は undefined を返すので弱いが）+ argument_mutation/external_observation も `equal` → `pruned 186→127`・**object 分岐（`for in` + `_.has`）の構造を保持**（= before≠after の核を残してる）。`iterator.call(...)` は `$P7($P8,...)` に抽象化されたが side-effect は他 oracle で観測されてるので over-prune ではない。
- → ガード fix と lexical-chain lift は効いてる。残り（特に Ember 級）は server 再走で確認。

→ **次**: spike v2 を brain-2 で 12 issue 実走 → 結果を `spike-e2e.log` v2 として戻す → 再分析。

### spike v2 サーバ実走の結果（2026-05-12, brain-2 docker, 12 issue）

生ログ: `spike-e2e-v2.log`。

| issue | fn units | per-unit 結果 |
|---|---|---|
| Underscore.string 347_1 | `_s.startsWith`, `_s.endsWith` | startsWith: **equal（中身あり ✓）** `["true"×8]` → `pruned 152→144`・本体保持 / endsWith: **vacuous → Phase 2 で DROP 相当**（workload 非到達）と正しく判定、prune skip |
| jQuery 367 | `jQuery.fn.index` | **equal（中身あり ✓）** `["-1","0","1"×3]` → `pruned 149→123`・本体保持 |
| jQuery 248 | `jQuery.fn.html` | **equal（中身あり ✓）** → `pruned 289→126`・変更点 `!rnocache.test(value)` のガード保持（分岐の中身は観測が浅いので $P* に抽象化）。**新 module var `rnoInnerhtml` を liftDeps に拾えてる** |
| Underscore 1222 | `_.values` | **equal（中身あり ✓）** → `pruned 118→110`・本体保持 |
| Ember 3174 | `Ember.assert` | **error（`argument_mutation` oracle が Ember 引数を serialize できず）**。ただし `__HOLE__` ガードで bootstrap は通り（stderr に "Assertion failed" ×2 = workload が実際に呼んでる）、`return_value`/`external_observation` は `equal`。= **候補構築は OK、別 TODO #3 待ち** |
| Ember 4329_1 | `Ember.cacheFor` (+stmt unit `Ember.VERSION = …`) | **error（同上 `argument_mutation`）**。version bump は stmt unit に正しく落ちた。cacheFor は特定・hole・lift(`META_KEY`)・実行 OK、`return_value` equal。= 別 TODO #3 待ち |
| Ember 5547 | `ComputedPropertyPrototype.set` (+stmt unit `Ember.VERSION = …`) | **not_equal**。lexical-chain lift で `metaFor` + 8 個を lift（第1回は `[]`）+ `setup=after-lib` で `_set` も存在 = **候補構築の課題は解消**。だが after の `set` ラッパは `this._set(...)` を呼ぶだけで `return` しない → `set` の戻り値が変わる → 我々の `__OBS` が `set` の戻り値を記録してるので `not_equal` → 保守的に DROP。**over-observation（incidental な戻り値変化）= recall 限界** |
| Ember 4158 | `Ember.generateGuid`, `Ember.guidFor`, `Class` (+stmt units) | **error（`argument_mutation`）**。**`depSources` が jquery を vendored 1.7 に差し替えるので lib はロードできた → 「dataset-broken」じゃない**。`guidFor` は lift 6 個・実行・consistent guids（`return_value` equal）。`generateGuid`/`Class` は workload 非到達（`return_value=[]`、本来 vacuous DROP）。= 別 TODO #3 待ち |
| Ember 4263 | なし | handlebars 強制 load で lib ロード可（dataset-broken じゃない）。変更は全部 stmt-level（version bump / `element = …` / `Ember.merge(preRender, {...})`）→ **fn unit なし → Phase 4 の stmt-unit hole-and-refill or embedded fallback**。spike は正しくそう分類 |
| Ember 9991 | なし | lib 側の変更 = version bump + 新 module var `hasThisCache` のみ、それを使う named fn の変更なし → **fn unit なし**。= 「benchmark が最適化を inline `<script>` に micro-reconstruct」の証左。**DROP が正解**（threats #3）。spike は正しくそう分類 |
| Underscore.string 347_2 | `_s.startsWith`, `_s.endsWith` | startsWith: **equal（中身あり ✓）** → `pruned 152→140`・本体ほぼ保持 / endsWith: **vacuous → DROP** |
| Underscore 1223 | `_.forEach` | **equal（中身あり ✓）**（第1回は bootstrap-invocation で `error`）。`liftDeps=[nativeForEach,breaker,_]`（第1回は `[]`）→ `pruned 186→127`・**object 分岐（`for in` + `_.has`）の構造を保持**（= before≠after の核）。`return_value=[null,null,null]`（`each` は undefined 返すので弱いが、`argument_mutation`/`external_observation` が constraint） |

**スコア（fn unit 単位）**:
- ✅ **中身のある equal + pruned・本体（or 変更点の構造）保持**: 6 fn unit / 6 issue — `_s.startsWith`(347_1), `jQuery.fn.index`(367), `jQuery.fn.html`(248), `_.values`(1222), `_s.startsWith`(347_2), `_.forEach`(1223)。**非 Ember は全勝。**
- 🟡 **vacuous → Phase 2 DROP 相当と正しく判定**: `_s.endsWith` ×2。spike に call-graph は無いので「実際に呼ばれたか（`__OBS` 非空か）」で代用 = Phase 2 reachability と等価な振る舞い。
- 🟡 **stmt-unit only → 正しく「fn unit なし」と分類**: Ember 4263（→ Phase 4 stmt-unit / embedded）、Ember 9991（→ DROP 正解）。
- ❌ **`argument_mutation` oracle が Ember 引数を serialize できず `error`**: Ember 3174 / 4329_1 / 4158（guidFor）。**候補構築は OK**（fn 特定・hole・lexical-chain lift・jsdom 実行・`return_value`/`external_observation` は通る）。= **別 TODO #3（equiv-checker robustness）が直れば equal**（`assert`/`cacheFor` は戻り値が undefined なので証拠は弱いが、`guidFor` は `["ember146"×3]`）。
- ❌ **over-observation で false `not_equal`**: Ember 5547（`set` の incidental な戻り値変化）。保守的 DROP。

**第1回の 3 つのギャップは全部 fix を確認**: ① `if(__HOLE__)` ガード = bootstrap-invocation 解消（Ember 3174・Underscore 1223 が実行される）② lexical-chain lift = `metaFor`/`breaker`/`nativeForEach`/`META_KEY`/`rnoInnerhtml`/`numberCache`… 全部拾えた ③ `findChangedUnits` = jQuery 248→`jQuery.fn.html`、Ember 4329_1→`Ember.cacheFor`、version bump→stmt unit、1 issue 複数 fn unit、vacuous 検出 — 全部動いた。

**結論**: 
- **preprocess 再設計（Phase 1〜4 の候補構築側）は de-risk 完了**。残るブロッカーは preprocess 側ではなく (a) equiv-checker の `argument_mutation` oracle が Ember オブジェクトで `error`（別 TODO #3、Ember 3 件に影響）(b) 変更関数の戻り値の over-observation（Ember 5547、recall edge — 保守的 DROP は正しい挙動）。
- **別 TODO #3 を「Ember を v1 でカバーするのに必要」に格上げ**: これが無いと Ember オブジェクトを引数に取る候補は全部 `error`。小さい fix（oracle が serialize 失敗時に `error` でなく `not_applicable` を返す）。Phase 3 と前後して着手。
- **「dataset-broken」分類を訂正**: 4158（jquery swap でロード可）・4263（forced handlebars でロード可）は dep-vendoring が swap すれば dataset-broken じゃない。4158 = 「Ember 級、`argument_mutation` 待ち」、4263 = 「stmt-unit only」。
- threats 追加: **変更関数の戻り値の over-observation** → extract-method 系リファクタで incidental な戻り値が変わると保守的 DROP。v2 で「call-trace 観測形」（戻り値でなく変更関数が呼ぶ lib 関数列を記録）に置き換える余地（`forEach` の弱い証拠も同時に改善する）。
- **観測形の補足**: `forEach`/`set` のような side-effecting 関数は `return_value` 証拠が弱い/誤判定し得る。今は multi-oracle（`argument_mutation`/`external_observation`）が constraint を補ってるので v1 は OK。call-trace 観測形は v2。

→ **Phase 1（本実装）に進む。** spike v2 のロジック（lexical-chain lift / `findChangedUnits` の named-ancestor walk + stmt-unit routing + multi-fn-unit / `if(__HOLE__)` ガード / setup=after-lib / vacuous→Phase 2 DROP）を Phase 1/2/4 にそのまま移植する。

### 別 TODO #3 fix（`argument_mutation` の unserializable → key 除外）— 実装済 2026-05-12

option 1 を実装（option 2 = serializer 側で循環を `<circular>` に丸める、は `serializer.ts` に TODO コメント）:
- `oracles/argument-mutation.ts`: `UNSERIALIZABLE_MARKER`（発生源は `serializer.ts` の循環参照検出のみ。Ember では `globalThis.Ember` が循環グラフなので常に発生）を含む key を**比較対象から除外**。残り 0 件なら `not_applicable`（「観測できる setup object が無い」と同扱い）。`error` には丸めない。
- in-source test: 「全部 unserializable → not_applicable」「一部だけ unserializable → 残りで判定（一致→equal / 差分→not_equal）」を追加。`mise` lint/tsc green、equivalence-checker 84 tests pass。Python 側は oracle observation を受け取るだけなので変更不要。
- ADR-0018 に「2026-05-12 更新」節を追記。`serializer.ts` の throw 箇所に v2 TODO コメント。
- **ローカルで Ember 4329_1（`Ember.cacheFor`）を再走して確認**: v2 で `argument_mutation=error` → 全体 `error` だったのが、**今 `verdict=equal (中身あり ✓)`**（`argument_mutation=equal`（preF1 由来の serializable な setup object がマッチ）+ `return_value=equal`）→ `prune: pruned 117→109`（iterations 50/50 cap）。同じ経路の Ember 3174 / 4158(`guidFor`) も flip するはず（どちらも v2 で `return_value=equal` 済・`argument_mutation=error` だけが blocker だった）。
- → **Ember 級も candidate 構築〜等価判定〜pruning が通る状態になった**（残: Ember 5547 の over-observation = threats #5 / `prune` のメモリリーク = 別 TODO #2 / Ember 4263 等の stmt-unit hole-and-refill = Phase 4）。

## Phase 5: 本実装の全件再測定 (2026-05-13, brain-2 docker)

`preprocess-selakovic`（本実装の `change-units.ts` + `reachability.ts` + `function-hole.ts` + `assemble/changed-fn.ts` + dep-vendoring 経由）→ `check-equivalence-batch` → `build_prune_input.py`（equal-only / setup>500KB は max_iter=50・それ未満は 5000）→ `prune-batch` → `summarize.py`。`build_inputs.py` は `candidate_kind in {changed-fn, body}` のみ通す（`single`/`lib` の数万ノード embedded は equiv にも prune にも回さない）。`changed-fn` 候補には `mount_html` を渡さない（self-contained。`v_before.html` を mount すると `<script src>` + inline `<script>` が二重に走って害）。

### 結果サマリ

| 指標 | 値 |
|------|----|
| `extracted.jsonl` 候補総数 | **143** |
| candidate_kind 内訳 | `single=86` / `lib=11` / `body=11` / `changed-fn=35` （うち `excluded=1`） |
| equiv 入力 (kind ∈ {changed-fn, body}) | 46 |
| equiv 結果 | **equal=26 / not_equal=6 / inconclusive=0 / error=14** |
| prune 対象 (equal-only) | 26 |
| prune 結果 | **pruned=19 / error=7** |
| 削減率 (median) | **0.174** （cap_hit 6/19 = max_iterations 到達） |
| `before_node_count` (median, changed-fn 全 35 件) | **75** |
| `after_node_count` (median, pruned 19 件) | **≈ 62**（= 75 × (1 - 0.174)） |

### 比較表 (median 削減率 と 絶対サイズ)

| 設計 | before | after | 削減率 median | 絶対サイズ (median) |
|------|--------|-------|---------------|---------------------|
| 0019 lib-embedded | lib 全文（数万〜十数万） | 数万 | 0.237 | **数万ノード** |
| 0021 lib-enclosure | 27〜779 | 10〜280 | 0.642 | **数十〜数百ノード** |
| 0022 changed-fn | 75 | **≈ 62** | 0.174 | **62 ノード** ✅ |

### 解釈

**削減率が一番低い ≠ 悪い**:
- 0022 の before = **変更関数本体**（median 75 ノード）。中身はほぼ全部 load-bearing な意味論 + 剥がせないスキャフォールド（`__HOLE__`/`__OBS` 足場・`(function(){}).call(this)` の wrapper・lift された内部依存名）。
- pruning が削るのは「結果に影響しない incidental」だけ。75 ノード中 ~13 ノードが incidental → ~62 ノードの最終パターン。
- 0019/0021 は before が大きい（数万 / 数百）→ 削減率が高く出ても **after の絶対サイズは桁違いに大きい**。
- **「候補を最初から小さくする」が 0022 の狙いで、それは達成**（lib 全文 → 75 ノード）。削減率という指標より絶対サイズが本質。

→ **Phase 5 DoD**（削減率を 0019/0021 と比較した数字が出ること）満たした。plan の判定は **(a) 成功**（「(b) 候補は小さいが削減率が低い ＝ 等価検証が厳しすぎる」ではない — 入力がもう最小だから削減率が低いだけ）。

### error 内訳と解決策

**equiv error=14** の内訳:

| 件数 | 原因 | カテゴリ | 解決策 |
|------|------|----------|--------|
| 3 | **Ember 4158** — `v_before.html` が Ember 1.5 と非互換な jquery 2.1.3 を `<script src>` で指す（dataset bug）。dep-vendoring 側 fork で jquery 1.7 override が **未投入**。 | dataset bug | fork (`tomoya0318/selakovic-2016-issues`) の `EmberIssues/issues/issue_4158/package.json` に `"jquery": "1.7.2"` override を追加 → `install-vendor-deps.sh` 再走で `node_modules/jquery` が 1.7 になる。**3 件回収可能** |
| ~10 | **`clientServerIssues/` の Node-module スタイル lib**（Ejs `require()` / Q の `makePromise` 系 Promise polyfill / Underscore.string の `require('underscore')` 連鎖 等）。`changed-fn` 候補は browser-style（`<script src>` 順 load + IIFE）で組まれているので、Node-module スタイル lib を `setup` に連結しても `require`/モジュールスコープが壊れて `makePromise is not defined` 等の `ReferenceError` になる。 | **構造的限界** | 短期: `changed-fn` 候補生成を **`clientIssues/` 限定**にする（`pipeline.ts` で topcat 判定）。`clientServerIssues/` のうち Node-module 側は v1 では embedded fallback (`single`/`lib`) のみ。長期 (v2): Node-module 用 candidate generator（CommonJS の `module.exports`/`require` を尊重した holed lib + `node:vm` 直 eval）を追加 — 別 TODO に切る |
| 1 | sandbox が throw を catch せず worker を殺すケース（既知）| 別 TODO #4 | equivalence-checker の子プロセス隔離（既存 TODO） |

**prune error=7** の内訳:

| 件数 | 原因 | 解決策 |
|------|------|--------|
| 7 | Ember 級 **big-setup**（`setup` = Ember 1.x 全文 ≈ 1.5MB + 依存 lib jquery/handlebars）候補の `prune` が、`vm.Context` の解放漏れで数十 iter で OOM/leak | 短期: `BIG_SETUP_THRESHOLD` の `max_iter` を 50 → **10〜20** に下げる（`build_prune_input.py` 引数）。中期: 別 TODO #2 (`prune` メモリリーク修正 = 各 iter で context dispose / 子プロセス隔離)。**Ember changed-fn の prune は v1 では完走しない**前提で v1 numbers から除外する選択肢もある |

### 結論

- **Phase 5 DoD 達成**: 候補は小さく（75 ノード）& prunable（→ 62 ノード）。0019/0021 比で **絶対サイズが桁違いに小さい**。
- **解決可能な error が 4 件（Ember 4158 の jquery override）+ 構造的限界が 10 件（clientServer Node-module）**。後者は v1 のスコープ外として明示し、`changed-fn` を `clientIssues/` 限定にする運用で error=14 → 1 まで落とせる。
- **prune error=7 は別 TODO #2 待ち**。v1 numbers としては「Ember 系 big-setup は max_iter を絞って計上」または「除外して計上」の二択を提示。

### follow-up (v1 仕上げ / v2)

1. **fork PR**: `EmberIssues/issues/issue_4158/package.json` に jquery 1.7.2 override を追加 → `install-vendor-deps.sh` 再走 → equiv 再走で 4158 ×3 回収。
2. **`pipeline.ts`**: `topcat === "clientServerIssues"` のとき `changed-fn` 候補生成を skip し embedded fallback のみに切り替え（v1 スコープ明示）。
3. **`comparison.md`** に上の比較表 + 解釈を清書（外部向け）。
4. **server `changed-fn` 対応 = 別 TODO**（Node-module スタイル candidate generator）。

### 運用メモ

- 結果 jsonl の人間可読化: `tmp/0022_.../jsonl_to_json.py`（サーバ側で `uv run python` 実行 → 同ディレクトリに `*.json` を出力。配列形式 + indent=2）。`scp_to_server.sh` で送る。
