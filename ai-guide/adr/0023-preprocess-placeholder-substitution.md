# ADR-0023: preprocess を placeholder substitution + 4 値契約に書き直す (v2)

- **Status**: accepted (2026-05-13 D-α spike success、ADR-0022 を `superseded by 0023` に更新済。設計は spike を経て「body 観測注入」案に修正 = §設計の核を参照)
- **Date**: 2026-05-13
- **Related**: ADR-0022 (v1 = `__HOLE__` 方式、本 ADR が置き換える対象), ADR-0011 (preprocessing Tier 2 構造 — 本 ADR でも継承), ADR-0014 (case-split — co-evolution の扱いを拡張する可能性あり), ADR-0018 (`inconclusive` verdict — placeholder model でも継承), `research/src/research/preprocess_workload_reachability/notes/migration-plan.md` §Phase 2

## コンテキスト

v1 = ADR-0022 で採用した `__HOLE__` 方式は動作しているが、以下の **accidental complexity** が認められる:

1. **lambda-lift** (`pickLiftedDeps` + `liftableNames`): lib 内部の補助関数を `__HOLE__` の引数に昇格。100+ 行の AST 解析ロジック。
2. **`if (globalThis.__HOLE__)` ガード + after body inline fallback**: bootstrap-invocation (lib bootstrap 中に変更関数が呼ばれる Ember.assert / `_.forEach` 等) を吸収するため、本体を 2 経路 (`__HOLE__` 経由 / inline fallback) で書く。
3. **`__OBS` 観測形** (`wrapWorkloadObserved`): 変更関数の戻り値を `__OBS` に記録して return_value oracle に positive evidence を出させる。

ユーザの直感: **「setup に placeholder があって、そこに slow/fast を突っ込めば等価検証できるはず。これがシンプルで説明もしやすく、バグも起きにくい」**。これを placeholder substitution model と呼び、v1 の `__HOLE__` 方式の 3 仕掛けを **1 仕掛け (観測 hook のみ)** に減らす設計。

Phase 5 で残った `makePromise` ×9 件の equiv error は `__HOLE__` 経由で sandbox 内 Promise harness 経路に入る副作用の可能性が示唆されており、placeholder model なら自然に解消される見込み。

## 選択肢

- **A. v1 (`__HOLE__` 方式) のまま続行**: 3 仕掛けを保持。`makePromise` 系は別途 fix。
- **B. placeholder substitution + 4 値契約 (= 本 ADR の提案、v2)**: `setup` に `$BODY$` プレースホルダ、`workload` に観測 hook + f1 body、`slow`/`fast` に before/after body の statement 列のみ。executor は **既存の 2 引数 (setup, body) API に展開** (= setup = `substituteBody(originalSetup, slow/fast)`, body = `workload`) → 既存の 2 回 runInContext + snapshot 機構 (argument_mutation oracle 用) を再利用。
- **C. hybrid (= placeholder + AMD 内ローカル系だけ `__HOLE__` 維持)**: 大半は B、AMD 内ローカル変更だけ A の経路。

### 評価

| 軸 | A (現状維持) | B (placeholder) | C (hybrid) |
|----|------------|----------------|----------|
| lambda-lift の要否 | ✗ 必要 | ✓ 不要 (closure で見える) | △ AMD 系のみ必要 |
| bootstrap-invocation の扱い | ✗ ガード + inline fallback で観測点を捨てる | ✓ 観測点として活用 | △ 経路で扱いが分かれる |
| equiv-checker 入力契約 | ✓ 既存 `{setup, slow, fast}` のまま | ✗ 4 値契約 `{setup, workload, slow, fast}` に拡張 (Python paired) | ✗ 同様 |
| 実装の認知コスト | ✗ 3 仕掛け、`function-hole.ts` 200 行 | ✓ 1 仕掛け、~50 行 | ✗ 両経路が並走 |
| `makePromise` ×9 件の error | ✗ 別 fix が要る | ✓ harness 経路を経由しないので自然に解消の可能性大 | △ |
| AMD 内ローカル系 (Ember 5547 等) の捕捉 | ✓ `__HOLE__` でモジュール内に hook | ⚠ 外から `_s.foo = ...` 経路で見えるもののみ。AMD 内ローカル変数は捕捉不能の可能性 | ✓ |
| spike での実証 | 済 (Phase 5) | 未 (D-α で確認) | 未 |

### 4 値契約の具体形 (= body 観測注入)

D-α spike で「workload 側に observe hook を外置きする」案を試したが、変更関数が lib 内 IIFE のローカル名 (`_s.startsWith` 等) で bootstrap 後の global からは別エイリアス (`_.str.startsWith`) でしか到達できず、外置き上書きが ReferenceError or 別オブジェクト代入になる限界が判明。代わりに **body 内部に観測ラッパを注入** する形を採用。これで参照名解決が不要、外側スコープから自然に見える内部依存 (= 外側関数の引数や宣言) を引数化する必要がなく、bootstrap-invocation 経路も観測点として活用可能。

#### 各値の役割

| フィールド | 役割 | 中身 |
|----------|------|-----|
| `setup` | sandbox で `workload` を実行する前に context を整える文字列。executor の `setup` 引数に渡す | `libs` + `preWorkload` の連結。詳細は [`ai-guide/code-map.md`](../code-map.md) §setup 構築規約 §changed-fn の setup 構成 |
| `workload` | sandbox の completion value を返す式。executor の `body` 引数に渡す | dataset の workload 関数 body を `$BODY$` 経由で観測した結果を返す IIFE |
| `slow` / `fast` | 変更関数本体 (before / after) の statement 列を、戻り値を観測配列 `__OBS__` に push して返すように包んだ断片。`setup` の `$BODY$` プレースホルダに差し込まれる | (`$BODY$` に差し込まれる statement 列。`placeholder.ts` の `wrapBodyObserved` 出力) |

#### sandbox 実行イメージ (= 全体像)

`setup` には変更関数本体が `$BODY$` プレースホルダになった lib + workload 前置文が入る:

```js
// setup (= libs + preWorkload、$BODY$ プレースホルダ含む)
//   libs:
!function (root, String) {
  'use strict';
  var slice = [].slice;
  function makeString(x) { return x == null ? '' : '' + x; }
  var _s = {
    startsWith: function (str, starts, position) {
      $BODY$   // ← slow / fast を sandbox 投入前にテキスト置換で差し込む
    },
    /* ... */
  };
  root._ = root._ || {}; root._.str = _s;
}(this, String);
//   preWorkload:
/* workload 関数を実行する前に必要な top-level 文 (例: var map = {}; ...) */
```

`slow` (および `fast`) は次のような形で `$BODY$` に差し込まれる:

```js
// $BODY$ に差し込まれる observed body — placeholder.ts の wrapBodyObserved 出力
let __OBS_R__ = (function () {
  starts = String(starts);
  position = position == null ? 0 : Math.min(position < 0 ? 0 : +position || 0, str.length);
  return makeString(str).slice(position, starts.length + position) == starts;
}).call(this);
__OBS__.push((function () {
  try { return JSON.stringify(__OBS_R__); } catch (e) { return "<unserializable>"; }
})());
return __OBS_R__;
```

`workload` は dataset の workload 関数 body を観測ラップした completion 値返却 IIFE:

```js
// workload (= dataset の workload 関数 body 観測ラップ、completion value 化)
(function () {
  __OBS__ = [];
  for (var i = 0; i <= 100000; i++) {
    _.str.startsWith('image.gif', 'image');   // bootstrap 後のエイリアスで呼ばれる
  }
  return JSON.stringify(__OBS__);
})()
```

`__OBS__` は **executor に渡す setup 引数の最先頭** に `let __OBS__ = [];` で宣言される (= `declareObservationGlobal` helper、sandbox top-level の lexical binding として `wrapBodyObserved` / `wrapObservedWorkload` の closure から参照される)。top-level `let` の特性で `globalThis.__OBS__` 経由のアクセスは不可 = scope を跨いだ誤参照を仕様レベルで防ぐ。

#### executor に渡す形 (= 既存 2 引数 API への展開)

4 値契約を slow 用 / fast 用の **2 つの 2 引数呼び出し** に展開:

```ts
// slow 評価:
//   順序: `let __OBS__ = [];` 宣言 → dep prelude → setup ($BODY$ 差し込み済) → workload
//   (__OBS__ 宣言を最先頭にして dep prelude より前に置く = TDZ 安全)
const slowSetup = declareObservationGlobal(substituteBody(setup, slow));
await executeSandboxed({ setup: slowSetup, body: workload, timeout_ms });

// fast 評価 (= 別 sandbox):
const fastSetup = declareObservationGlobal(substituteBody(setup, fast));
await executeSandboxed({ setup: fastSetup, body: workload, timeout_ms });
```

`executeSandboxed` は内部で `setup` 引数と `body` 引数を順に sandbox で実行し、間で setup state を snapshot して argument_mutation oracle 用に取る (= 既存実装、`equivalence-checker/common/sandbox/executors/{vm,jsdom}.ts`)。executor 側は無改修で placeholder model に対応する。

#### 設計のポイント

- 外側スコープから自然に見える内部依存 (例: 上記 `makeString`) は **`$BODY$` 周囲のスコープに居る関数本体 (= 元の場所) で実行される** ので、引数化して取り出す必要がない (= v1 `__HOLE__` 方式の lambda-lift が不要)
- bootstrap-invocation 中も body は元の場所で走るが、`workload` IIFE 先頭の `__OBS__ = []` reset で bootstrap 中の観測値は捨て、純粋な workload 観測だけを残す (= v1 の bootstrap ガードが不要)
- 観測 hook を外置きしないので、変更関数の **外側からの参照名** (lib IIFE 内ローカル名 / 外部エイリアス / AMD モジュール内ローカル名 等) のいずれであっても観測が成立する

旧契約 (= `workload` フィールドなし、placeholder model でない candidate_kind) は **後方互換**: そのまま既存 executor の (setup, body) に直接渡る。placeholder 経路との差は呼び出し側 (`changed-fn.ts`) で setup を `substituteBody(setup, slow/fast)` に展開するかどうかだけで、executor 側は無改修。

### 命名規則 (magic 識別子の役割分離)

`mb-analyzer/` 内で「ツール側 (preprocess / pruning / sandbox) が触る identifier」は **役割で記法を分ける** (= 案 A、見た目で「置換マーカー / 実行時変数」が即判別できる):

- **置換マーカー** (preprocess / pruning): **`$` 系**
  - preprocess: `$BODY$` (single, textual replace、AST に載らない、`setup.replace('$BODY$', body)` で sandbox 投入前に消える)
  - pruning: `$P0`, `$P1`, ... (AST identifier、連番で複数共存、ADR-0009 §単一ソース、`pruning/common/rules/replacement.ts` の `PLACEHOLDER_NAME_PATTERN = /^\$P\d+$/`)
- **sandbox 実行時の internal 変数**: **`__NAME__`** (両端 underscore で囲む)
  - 本 ADR では `__OBS__` (戻り値観測配列) / `__OBS_R__` (1 回の呼び出し戻り値の一時保持)
  - `__OBS__` は setup 最先頭の `let __OBS__ = [];` (= `declareObservationGlobal` helper) で宣言・初期化され、`wrapBodyObserved` / `wrapObservedWorkload` の closure 経由で参照される (= `globalThis.` プレフィックスは不要)
  - `__OBS_R__` は `wrapBodyObserved` 出力の `let __OBS_R__` で 1 関数 body 内に閉じる

検討した代替: 案 B (全部 `$X$` で揃える = `$OBS$`) / 案 C (全部 `__X__` で揃える = `__BODY__` / `__P0__`)。いずれも見た目は揃うが、「置換マーカー (= ツールが処理して消える) と実行時変数 (= sandbox に残る) を見た目で混同」する誤読リスク + pruning の `$P0..$Pn` 単一ソース (ADR-0009) を動かす広範変更コストで不採用。

architecture 側の常駐参照は `ai-guide/architecture/mb-analyzer.md` §コーディング規約 §Magic 識別子の命名規則。

## 決定

**B (placeholder substitution + 4 値契約)** を採用する。設計の核は spike を経て「body 観測注入」案に修正済。

主要な根拠:
- v1 で蓄積した複雑度の解消 (3 仕掛け → 1 仕掛け、`function-hole.ts` 200+ 行 → `placeholder.ts` 約 80 行)
- `makePromise` 系 error の解消可能性
- bootstrap-invocation の挙動差を観測点として活用可能 (= body 観測注入なら bootstrap でも同じ body が走る、workload IIFE で `__OBS__ = []` reset で捨てるか活かすか調整可能)
- AMD/IIFE 内ローカル名 (`_s.startsWith` 等) も access name resolution 不要で観測できる
- 「placeholder に突っ込む」という説明 1 行で完結する設計

## 結果 / 影響

### D-α spike (実施: 2026-05-13、`mb-analyzer/tests/preprocessing/spike-placeholder.test.ts`)

`spike-placeholder.test.ts` (新規、git untracked、D-β 完了後に削除) で 12 issue (v1 spike v2 と同じセット) を in-process で実行。詳細は `research/research/preprocess_workload_reachability/notes/spike-v3.log` を参照。

**結果 (14 tests 全件緑、success 判定)**:

| カテゴリ | 件数 | 結果 |
|---------|-----|------|
| サニティ (synthetic) | 2 | ✓ ✓ (operator precedence / closure dep) |
| クリーンケース | 4 | ✓ 347_1 / ✓ 347_2 / ✓ 1222 / ✓ 367 (全件「中身のある equal」) |
| 軽い系 | 2 | ✓ 1223 / △ 248 (両側 same TypeError = jQuery+jsdom 限界、placeholder 起因ではない) |
| Ember (fn unit なし) | 2 | ✓ 4263 / ✓ 9991 (DROP 正解、`composePlaceholderCandidate = null`) |
| Ember (bootstrap-invocation 込み) | 4 | ✓ 3174 / ✓ 4329_1 / △ 4158 (jQuery 版互換) / △ 5547 (合成 workload 設計ミス) |

特筆: **Ember 3174 / 4329_1 で v1 では argument_mutation oracle が error だったが、placeholder model では `[null,null,null]` 両側一致で equal verdict 相当** = v1 で残った 9 件の error が一部解消する可能性。

### 撤退条件への到達

D-α spike で 1.5 日 (= 想定の 1.5 倍) を超えても (success) 判定が得られない場合は撤退、本 ADR は `rejected`、というルールだったが、約 1.5 時間で success 判定に到達 (= 撤退条件は当てはまらず)。

### D-β 本実装 (2.5-3.5 日、spike success 後)

- `mb-analyzer/src/contracts/{preprocessing,equivalence,pruning}-contracts.ts` に `workload?: string` 追加
- `mb_scanner/domain/entities/{preprocessing,equivalence,pruning}.py` paired-change
- `mb-analyzer/src/preprocessing/selakovic/assemble/changed-fn.ts` 書き直し (4 値出力)
- `mb-analyzer/src/preprocessing/common/function-hole.ts` 大幅縮減 or `placeholder.ts` 新規 + 旧削除
- `mb-analyzer/src/equivalence-checker/common/sandbox/executors/{jsdom,vm}.ts` は **無改修** (= 2 引数 API のまま)。呼び出し側 (`changed-fn.ts` / `pipeline.ts`) が 4 値契約を 2 引数に展開してから渡す
- 既存 `selakovic.test.ts` の changed-fn assertion 書き直し

### D-γ 全件再走 + DROP 可視化 (1 日)

- `pipeline.ts:appendChangedFnCandidates` の 5 経路 (parse-fail / empty-diff / no-fn-unit / change-not-exercised / builder-null) を `excluded` レコードで吐く
- brain-2 で 97 issue 再走、v1 と v2 の数字を `research/src/research/preprocess_workload_reachability/reports/comparison.md` に並べる
- 達成目標: `server (17) + fallback (1) を除く 79 issue` で `body or changed-fn` ≥ 1 件 (現状 v1 では 43/79)

### 派生: Angular wrapper 対応 (+2 日、別 TODO #8)

D-γ の後 or 並行で、angular controller wrapper の preprocess 経路に placeholder model を拡張する。26 issue が救える見込み。

## 関連メモ

- `research/src/research/preprocess_workload_reachability/notes/migration-plan.md`: 移行ロードマップ全体
- `research/src/research/preprocess_workload_reachability/notes/v1-notes.md`: v1 の Phase 5 結果と v2 検討に至った経緯
- `research/src/research/preprocess_workload_reachability/notes/refactoring-todo.md`: v2 完了後の整備タスク (CLI 改良 / mise tasks / research/ 整備)
