# ADR-0023: preprocess を placeholder substitution + 4 値契約に書き直す (v2)

- **Status**: proposed (D-α spike で実証後 accepted に昇格、本 ADR が accepted になったら ADR-0022 を `superseded by 0023` に変更)
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
- **B. placeholder substitution + 4 値契約 (= 本 ADR の提案、v2)**: `setup` に `$BODY$` プレースホルダ、`workload` に観測 hook + f1 body、`slow`/`fast` に before/after body の statement 列のみ。executor は `setup.replace('$BODY$', body) + ';\n' + workload` で 1 回 runInContext。
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

### 4 値契約の具体形

```javascript
// setup (= lib + dep + preF1、$BODY$ プレースホルダ含む)
(function (root, factory) { factory(root._s = {}); }(this, function (s) {
  var slice = [].slice;
  function makeString(x) { return x == null ? '' : '' + x; }
  s.startsWith = function (str, starts, position) {
    $BODY$   // ← slow body / fast body をテキスト置換で差し込む
  };
}));
/* preF1 */

// workload (= 観測 hook + f1 body、slow/fast 共通、IIFE で completion value 化)
(function () {
  globalThis.__OBS = [];
  var __original = _s.startsWith;
  _s.startsWith = function () {
    var __r = __original.apply(this, arguments);
    try { globalThis.__OBS.push(JSON.stringify(__r)); }
    catch (e) { globalThis.__OBS.push("<unserializable>"); }
    return __r;
  };
  for (var i = 0; i <= 100000; i++) {
    _s.startsWith('image.gif', 'image');
  }
  return JSON.stringify(globalThis.__OBS);
})()

// slow (= before body の statement 列のみ、$BODY$ に差し込まれる)
starts = String(starts);
position = position == null ? 0 : Math.min(position < 0 ? 0 : +position || 0, str.length);
return makeString(str).slice(position, starts.length + position) == starts;

// fast (= after body)
// ... 同 ===

// executor (jsdom / vm 共通)
const finalProgram = options.setup.replace('$BODY$', options.body) + ';\n' + options.workload;
vm.runInContext(finalProgram, context, { timeout: ... });
```

`makeString` は lib IIFE の closure で見えるので **lambda-lift 不要**。lib bootstrap 中も差し替え版が走るので **`if (__HOLE__)` ガード不要** (= bootstrap 中の挙動差も observe hook が拾える)。

旧契約 (= `workload` フィールドなし) は **後方互換**: 現状の 2 回 runInContext モデルで動かす (lib-embedded `single`/`lib`/`body` / fallback 用)。

## 決定

**B (placeholder substitution + 4 値契約)** を採用する (proposed → D-α spike で実証後 accepted)。

主要な根拠:
- v1 で蓄積した複雑度の解消 (3 仕掛け → 1 仕掛け、コード半減)
- `makePromise` 系 error の解消可能性
- bootstrap-invocation の挙動差を観測点として活用
- 「placeholder に突っ込む」という説明 1 行で完結する設計

## 結果 / 影響

### D-α spike (1 日、`mb-analyzer/tests/preprocessing/spike-placeholder.test.ts`)

`spike-placeholder.test.ts` (新規、git untracked、実証完了後に削除) で 12 issue (v1 spike v2 と同じセット) を in-process で実行 → 「中身のある equal + pruning が変更関数本体を保持」を検証。

判定基準:
- (success) クリーンケース 4 件 (US 347_1/347_2 / jQuery 367 / Underscore 1222) で v1 と同等以上の動作 → 本実装に進む
- (partial) クリーンケース OK、Ember 級が AMD 内ローカル問題で詰む → hybrid (C) を検討
- (fail) クリーンケースでも observe `[]` のまま / signature 違いで bootstrap が壊れる → 撤退、v1 維持

### 撤退条件

D-α spike で 1.5 日 (= 想定の 1.5 倍) を超えても (success) 判定が得られない場合は撤退し、v1 のまま研究を閉じる。本 ADR は `rejected` に変更。

### D-β 本実装 (2.5-3.5 日、spike success 後)

- `mb-analyzer/src/contracts/{preprocessing,equivalence,pruning}-contracts.ts` に `workload?: string` 追加
- `mb_scanner/domain/entities/{preprocessing,equivalence,pruning}.py` paired-change
- `mb-analyzer/src/preprocessing/selakovic/assemble/changed-fn.ts` 書き直し (4 値出力)
- `mb-analyzer/src/preprocessing/common/function-hole.ts` 大幅縮減 or `placeholder.ts` 新規 + 旧削除
- `mb-analyzer/src/equivalence-checker/common/sandbox/executors/{jsdom,vm}.ts` 修正 (`workload !== undefined` で 1 回 runInContext、旧形式は 2 回 runInContext 維持で後方互換)
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
