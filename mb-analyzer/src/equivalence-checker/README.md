# equivalence-checker

> 生成物 — 手編集禁止 (ADR-0029)。再生成: `/generate-approach-spec mb-analyzer/src/equivalence-checker`
> 生成時コミット: `d122da9` (2026-06-13)

## 役割

`(setup, before, after)` を sandbox で 2 回実行し、観測結果 (`ExecutionCapture`) を最大 6 本のオラクルで比較して
**`equal` / `not_equal` / `inconclusive` / `error`** の 4 値 verdict に畳む (`equivalence-contracts.ts:8-19`)。
公開エントリは `checkEquivalence(input: EquivalenceInput): Promise<EquivalenceCheckResult>` で、ルート barrel
(`index.ts:1-10`) が selakovic adapter の実装と verdict 合成ヘルパ (`deriveOverallVerdict` / `deriveVerdictReason` /
`VERDICT_REASON`)・契約型を re-export する。CLI ラッパは [`../cli/README.md`](../cli/README.md) を参照。

## 二層構造 (ADR-0015)

- **`common/`** — dataset 非依存の primitive。「2 つの実行 capture を取得して比較する」だけで、
  Selakovic の計測プロトコルも framework 名も知らない。dataset 知識が要る「決め」(正規化規則・閾値) は
  すべて `opts` / profile として外から受け取る (例: `ExceptionProfile` — `exception.ts:5-13`、
  `DomNormalizeProfile` — `dom-mutation.ts:16-29`)。
- **`selakovic/`** — Selakovic dataset 用 adapter。オーケストレーション (`checker.ts:64-131`)、
  環境ごとの oracle 選択 (`oracle-routing.ts:30-32`)、dataset 固有の正規化「値」の集約 (`profiles.ts:1-7` —
  framework/dataset 固有の string literal は `common/` には置かずここに集約)。

依存は `selakovic/` → `common/` の一方向のみ (ESLint `import/no-restricted-paths` で機械強制)。

## ファイル index

| file | 役割 | 主な依存 |
|---|---|---|
| `index.ts` | package barrel — `checkEquivalence` + verdict ヘルパ + 契約型の re-export (`index.ts:1-10`) | `selakovic/`, `common/comparison/verdict`, `contracts/` |
| `common/serializer.ts` | 値 → canonical 文字列 (NaN/-0/BigInt/Map/Set/DOM ノードを区別、キー sort、循環は `SerializationError` — `serializer.ts:1-11`) | なし (葉) |
| `common/comparison/verdict.ts` | `OracleObservation[]` → 全体 verdict の合成 + `verdict_reason` 分類 (`verdict.ts:61-104`) | `contracts/` |
| `common/comparison/oracles/return-value.ts` | C1: `return_value` / `return_is_undefined` の完全一致比較 (`return-value.ts:13-57`) | `capture/types`, `capture/snapshot` |
| `common/comparison/oracles/argument-mutation.ts` | C4: setup 由来 object/array の `arg_snapshots` pre/post 差分 (`argument-mutation.ts:21-63`) | `capture/types`, `capture/snapshot` |
| `common/comparison/oracles/exception.ts` | C5: `exception` の ctor + (正規化後) message 比較 (`exception.ts:24-69`) | `capture/types` |
| `common/comparison/oracles/external-observation.ts` | C3+C4: `console_log` 呼出列 + `new_globals` key 集合の diff (`external-observation.ts:20-89`) | `serializer`, `capture/types` |
| `common/comparison/oracles/dom-mutation.ts` | C2: `dom_html` を profile で正規化して文字列比較。両側 `dom_changed === false` なら N/A (`dom-mutation.ts:37-89`) | `jsdom`, `capture/types` |
| `common/comparison/oracles/interaction-trace.ts` | C6: `interaction_trace` (workload→SUT 呼び出し列) の比較 (`interaction-trace.ts:21-47`) | `capture/types` |
| `common/comparison/{index,oracles/index}.ts` | comparison 層 / oracle 群の barrel | — |
| `common/sandbox/executors/vm.ts` | 素 `node:vm` context での実行。非決定性遮断 + `process`/`require`/`eval`/`Function` を undefined にして host への逃げ道を遮断 (`vm.ts:44-51`) | `capture/*`, `errors`, `transforms/non-determinism` |
| `common/sandbox/executors/jsdom.ts` | jsdom window/document context での実行。require shim・server Node グローバル・`mount_html`・`dom_changed` 判定・記録 Proxy 注入 (`jsdom.ts:116-181`) | `jsdom`, `capture/*`, `errors`, `transforms/non-determinism` |
| `common/sandbox/capture/types.ts` | `ExecutionCapture` ほか観測結果型。oracle 層が触れる唯一の sandbox 型 (`types.ts:1-4`) | なし |
| `common/sandbox/capture/snapshot.ts` | 両 executor 共有の観測ヘルパ — `snapshotValue` / cross-realm `captureException` / `normalizeSetup` / setup・new-global snapshot (`snapshot.ts:1-8`) | `serializer` |
| `common/sandbox/capture/console-hook.ts` | `console.*` 呼出列の記録 (C3 の取得側)。vm 用フック生成 + jsdom console 上書き (`console-hook.ts:12-30`) | `capture/types` |
| `common/sandbox/capture/recording-proxy.ts` | 汎用記録 Proxy (C6 の取得側)。境界オブジェクトを `get`/`set`/`apply`/`construct` トラップで包み `TraceEntry[]` を蓄積 (`recording-proxy.ts:282-411`) | `capture/types` |
| `common/sandbox/transforms/non-determinism.ts` | `Math.random`/`Date`/timer/`performance.now` の凍結・遮断 (`non-determinism.ts:50-74`) | `node:vm` (葉) |
| `common/sandbox/transforms/iteration-cap.ts` | 計測ループ (`for(...;<n>;..)` / `Array(n)`) のリテラル上限を clamp する実行前 AST pass (`iteration-cap.ts:25-70`) | `src/ast/{parser,walk}` |
| `common/sandbox/errors.ts` | `SandboxSetupError` — setup phase の throw を型分離 (cross-realm 制約のため host 側で生成 — `errors.ts:1-13`) | なし |
| `common/sandbox/index.ts` | sandbox 層の barrel | — |
| `selakovic/checker.ts` | `checkEquivalence` の実装 — 入力 2 系統の分岐 / 環境分岐 / oracle 配線 / outer catch (`checker.ts:64-131`) | `codegen/placeholder`, `contracts/`, `common/comparison`, `common/sandbox`, `oracle-routing`, `profiles` |
| `selakovic/oracle-routing.ts` | 環境 (vm/jsdom) ごとに走らせる oracle 集合と評価順 (`oracle-routing.ts:14-32`) | `contracts/` |
| `selakovic/profiles.ts` | Selakovic 固有の正規化「値」(DOM 正規化 / global ignore / message 正規化 / interaction-trace ignore / iteration-cap 閾値 / 重量級 jsdom 推奨 timeout `HEAVY_JSDOM_TIMEOUT_MS` — `profiles.ts:94`) | `common/` の型のみ |
| `selakovic/index.ts` | adapter barrel | — |

契約定義はモジュール外の `../contracts/equivalence-contracts.ts` (Python 側
`mb_scanner/domain/entities/equivalence.py` と paired-change — `equivalence-contracts.ts:1-6`)。

## 依存方向

```
index.ts ─ selakovic/checker.ts ─ selakovic/{oracle-routing, profiles}
                                ├ codegen/placeholder (substituteBody / declareObservationGlobal — checker.ts:1)
                                ├ common/comparison ─ oracles/* ─ sandbox/capture/{types,snapshot}
                                │                   └ verdict.ts
                                └ common/sandbox ─ executors/{vm,jsdom} ─ capture/* ─ serializer.ts
                                                 └ transforms/{non-determinism, iteration-cap ─ src/ast/*}
contracts/equivalence-contracts.ts (型 + 列挙定数のみ、全層から参照される leaf)
```

- `common/` は `selakovic/` を import しない (一方向 DI、ADR-0015)。
- oracle は `(before, after, profile?) → OracleObservation` の純関数で、sandbox 側とは
  `ExecutionCapture` 型 (`types.ts:50-61`) と `UNSERIALIZABLE_MARKER` 定数 (`snapshot.ts:12`) で結合する。
- 記録 Proxy の global 名 `__recorder` (`recording-proxy.ts:27`) は runnable を組み立てる
  `preprocessing/selakovic/assemble/*` 側がハードコードで参照する (依存方向の都合で import 不可 —
  `recording-proxy.ts:21-26`)。変更時は両方を揃える。

## 契約要約

### `EquivalenceInput` (`equivalence-contracts.ts:63-89`)

| field | 意味 |
|---|---|
| `id?` | バッチでの順序追跡用エコーバック |
| `setup?` | 両側共通の事前定義コード。placeholder 経路では `$BODY$` を含む穴あきテンプレート |
| `before` / `after` | 比較する 2 つの body (placeholder 経路では body 断片、direct 経路では top-level program) |
| `timeout_ms?` | 1 実行あたりの上限。省略時 5000 (`checker.ts:40`) |
| `environment?` | `"vm"` (既定) / `"jsdom"` (`equivalence-contracts.ts:57-61`) |
| `module_base_dir?` | jsdom 環境で相対 `require('./x')` を解決する基準ディレクトリ (`equivalence-contracts.ts:71-72`) |
| `mount_html?` | jsdom 環境で `<body>` に mount する HTML (`equivalence-contracts.ts:73-74`) |
| `workload?` | placeholder substitution + 4 値契約 (ADR-0023) の workload。非 null なら placeholder 経路 (`equivalence-contracts.ts:75-88`) |

入力は `workload` の有無で 2 系統に分岐する (`checker.ts:68-87`):

- **placeholder substitution** (`workload != null`): `substituteBody(setup, body)` で `$BODY$` を before/after の
  body 断片で差し替え、`declareObservationGlobal` で setup 先頭に `let __OBS__ = [];` を prepend し、
  `input.workload` を executor の workload に渡す (`checker.ts:75-82`)。
- **direct executable** (`workload == null`): before/after がそのまま executor の workload に流れる
  (`checker.ts:83-87`)。

### `EquivalenceCheckResult` (`equivalence-contracts.ts:99-114`)

| field | 意味 |
|---|---|
| `id?` | 入力 `id` のエコーバック (`equivalence-contracts.ts:100`。セットするのは checker でなく CLI 層) |
| `verdict` | `equal` / `not_equal` / `inconclusive` / `error` |
| `observations` | 走らせた各 oracle の `OracleObservation` (`oracle` / `verdict` / `before_value` / `after_value` / `detail` — `equivalence-contracts.ts:91-97`) |
| `verdict_reason?` | `inconclusive` の理由分類または `error` の crash 分類 (下記)。`equal` / `not_equal` では `null` |
| `error_message?` | `error` 時の例外メッセージ (cross-realm 対応の抽出 — `checker.ts:155-166`) |
| `effective_timeout_ms?` | 実際に適用した timeout |

### 6 オラクル

各 oracle の verdict は `equal` / `not_equal` / `not_applicable` / `error` の 4 値
(`equivalence-contracts.ts:22-27`)。観測チャネルが空なら oracle 自身が `not_applicable` を返す。

| oracle | 観測対象 (`ExecutionCapture` のフィールド) | 要点 |
|---|---|---|
| `return_value` (C1) | `return_value` / `return_is_undefined` | serialize 済み文字列の完全一致。片側でも例外なら N/A (C5 に委譲)、両側 undefined も N/A (`return-value.ts:19-24`) |
| `argument_mutation` (C4) | `arg_snapshots` (setup 由来 object/array の pre/post) | シリアライズ不能 key は比較から除外し、残り 0 件なら N/A (`argument-mutation.ts:31-37`、ADR-0018 2026-05-12 更新) |
| `exception` (C5) | `exception` (ctor + message) | 両側正常終了は N/A。`normalizeMessagePatterns` で `_before`/`_after` の配置 artifact を除去してから比較 (`exception.ts:32-43`) |
| `external_observation` (C3+C4) | `console_log` + `new_globals` | console 列 (method + args + 順序) の一致 ∧ 新規 global key 集合の一致。`ignoreNewGlobalPatterns` 適用後に両側空なら N/A (`external-observation.ts:26-37`) |
| `dom_mutation` (C2) | `dom_html` / `dom_changed` | profile で正規化 (属性/class/コメント/空白/属性順) した HTML の文字列比較。両側 `dom_html` 無し (vm 環境) または両側 `dom_changed === false` なら N/A (`dom-mutation.ts:46-64`) |
| `interaction_trace` (C6) | `interaction_trace` (記録 Proxy が取った workload→SUT 呼び出し列) | `path`/`op`/`args`/`result`/`thrown` (`types.ts:32-38`) を要素ごとに比較。両側空なら N/A (`interaction-trace.ts:30-32`) |

### verdict 合成 (`verdict.ts:61-85`、ADR-0018)

1. いずれかの oracle が `not_equal` → **`not_equal`** (`verdict.ts:64`)
2. いずれかの oracle が `error` → **`error`** (`verdict.ts:65`)
3. 全 oracle が `not_applicable` → **`inconclusive`** (`verdict.ts:67-68`)
4. positive-evidence oracle (= `{return_value, argument_mutation, interaction_trace, dom_mutation}` —
   `verdict.ts:20-25`) がすべて N/A → **`inconclusive`** (`verdict.ts:70-73`)
5. `exception = equal` (両側同じく throw) かつ唯一の positive evidence が `dom_mutation` のみ →
   **`inconclusive`** (bootstrap 由来 DOM 変化の誤格上げ防止 — `verdict.ts:75-82`)
6. それ以外 → **`equal`** (`verdict.ts:84`)

`verdict_reason` (`verdict.ts:34-45`):

| verdict | `verdict_reason` |
|---|---|
| `inconclusive` | `"no-observable-channel"` (全 N/A) / `"both-sides-threw"` (`exception = equal`) / `"no-positive-evidence"` (それ以外) — `deriveVerdictReason` が導出 (`verdict.ts:91-104`) |
| `error` | `"setup-failure"` (setup phase の throw = `SandboxSetupError`) / `"executor-error"` (workload 段階以降の crash・serialize 失敗) — checker の outer catch が直接セット (`checker.ts:112-130`) |
| `equal` / `not_equal` | `null` |

### 実行環境の使い分け (ADR-0012)

- **`vm`** (既定): 素の `node:vm` context。非決定 API stub (`nonDeterministicGlobals()` —
  `non-determinism.ts:50-63`) + `process`/`require`/`eval`/`Function` の遮断 (`vm.ts:47-50`)。
  DOM 不要な純粋計算向けで pruning も使う (`vm.ts:33`)。oracle は
  `return_value` / `argument_mutation` / `exception` / `external_observation` の 4 本
  (`oracle-routing.ts:14-19`)。
- **`jsdom`**: jsdom の window/document を持つ VM context (`runScripts: "outside-only"` +
  `getInternalVMContext()` — `jsdom.ts:117-122`)。browser ライブラリ (AngularJS / jQuery 等) と
  server `test_case` 向け。追加で:
  - グローバル `require` 注入 — 相対パスは `module_base_dir` 起点で同 context eval、bare npm dep は
    dataset fork の `node_modules` (ADR-0016 の lockfile-vendored) から `createRequire` で解決
    (`jsdom.ts:221-284`)。`/node_modules/<dep>` hardcode パスの bare fallback あり (`jsdom.ts:255-269`)
  - server SUT 用の最小 Node グローバル (`process`/`Buffer`/`global`/`setImmediate`) 注入
    (`jsdom.ts:184-214`、ADR-0025)
  - `mount_html` の `<body>` mount (`<script>` 除去 — `jsdom.ts:64-74`)
  - 初期 mount HTML との比較で `dom_changed` を判定 (`jsdom.ts:137-166`)
  - 記録 Proxy を `globalThis.__recorder` として注入 (`jsdom.ts:131-134`、checker は jsdom 経路で常に
    `recordInteractions: true` — `checker.ts:92`)
  - workload に iteration-cap を適用 (`checker.ts:70`、閾値は `profiles.ts:88` の
    `{ threshold: 100, cap: 5 }` — ADR-0017)

  oracle は 4 本 + `dom_mutation` + `interaction_trace` の 6 本 (`oracle-routing.ts:21-28`)。評価順は
  report の可読性のためだけで、verdict 合成は順序非依存 (`oracle-routing.ts:10`)。

両環境とも setup phase の throw は `SandboxSetupError` で型分離して outer に投げ (`vm.ts:64-74` /
`jsdom.ts:82-89`)、workload phase の例外は throw せず `capture.exception` に詰めて exception oracle で
観測する (`vm.ts:82-108`)。

## 関連 ADR

- ADR-0012: 等価検証の実行環境を jsdom+vm 主軸 + Playwright fallback にする
- ADR-0013: 「意味論的等価」の operational definition — 計算結果 + 観測可能な副作用 + workload↔SUT の interaction trace
- ADR-0015: equivalence-checker を common (dataset 非依存) + selakovic adapter に二層化し、DOM oracle (C2) と interaction-trace oracle (C6) を common 側の primitive として実装する
- ADR-0016: Selakovic dataset が同梱していない npm dep を、fork に lockfile で宣言して解決する
- ADR-0017: 等価検証 sandbox の実行前 transform — 非決定性 API の固定 + iteration-cap (loop bound の AST clamp)
- ADR-0018: 等価判定の保守化 — `inconclusive` verdict と positive-evidence ルール
- ADR-0023: preprocess を placeholder substitution + 4 値契約に書き直す (checker の入力 2 系統の根拠)
- ADR-0024: preprocess contract を base / adapter 分離 + issue 階層化に再設計する (oracle 選択 = `environment` 1 軸の裁定)
- ADR-0025: server SUT を CommonJS-respecting holed lib + node:vm 直 eval で扱う (Revised: executor は jsdom)
- ADR-0007: 内部ヘルパとモジュール内共有ヘルパは in-source testing (各ファイル末尾の `import.meta.vitest` ブロック)
