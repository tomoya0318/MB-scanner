# equivalence-checker

`(setup, slow, fast)` トリプルを sandbox 実行し、出力を複数の直交軸 (oracle) で観測して
**`equal` / `not_equal` / `error` / `inconclusive`** verdict を返す。`checkEquivalence()` が公開エントリポイント
(ルート `index.ts` 経由)。

二層構成 (preprocessing と対称、ESLint `import/no-restricted-paths` で機械強制):

- **`common/`** — dataset 非依存。`f1`/`init`/`test`/`mark` も framework 名 (angular/jQuery/...) も
  知らない。各機能は `opts`/config/profile として外から渡される。`common/` は `equivalence-checker/selakovic`
  / `preprocessing` を import できない。
- **`selakovic/`** — dataset 依存 adapter。Selakovic の計測プロトコルと使用 framework を知り、
  `common/` の primitive に渡す config (oracle 選択・評価順 / 正規化プロファイル / iteration-cap 値) を構成して
  オーケストレーションする。

## ファイル index

```
src/equivalence-checker/
├── common/
│   ├── sandbox/                       (setup, slow, fast) を実行して ExecutionCapture ×2 を作る
│   │   ├── transforms/
│   │   │   ├── non-determinism.ts        Math.random / Date / timer / performance.now の凍結 (ADR-0012)
│   │   │   └── iteration-cap.ts          計測ループ (for(...;<n>;..) / Array(n)) の上限を縮める実行前 AST pass (ADR-0017)
│   │   ├── executors/
│   │   │   ├── vm.ts                     素 node:vm context (DOM 不要 / pruning も使う)。host 逃げ道遮断もここ
│   │   │   └── jsdom.ts                  jsdom window/document context + require shim (相対 / `.../node_modules/<dep>` → bare fallback ADR-0016 / bare-dep via createRequire) + dom_changed 判定 + 記録 Proxy 注入
│   │   ├── capture/
│   │   │   ├── types.ts                  ExecutionCapture (return_value / exception / arg_snapshots / console_log / new_globals / timed_out / dom_html / dom_changed / interaction_trace) ほか
│   │   │   ├── snapshot.ts               snapshotValue / captureException (cross-realm Error の duck typing) / normalizeSetup / setup・new-global snapshot / isTimeoutError
│   │   │   ├── console-hook.ts           console.* の呼出列を記録する instrumentation (C3 の取得側)
│   │   │   └── recording-proxy.ts        汎用記録 Proxy (C6 interaction-trace の取得側)。境界オブジェクトを get/set/apply/construct トラップで包み TraceEntry[] を蓄積。runnable 側が globalThis.__recorder 経由で wrap
│   │   └── index.ts                     sandbox 層の barrel
│   ├── comparison/                     2 つの ExecutionCapture を比較 → OracleObservation[] → Verdict
│   │   ├── oracles/                      channel ごとの比較器 (各 (slow, fast, profile?) → OracleObservation の純関数)
│   │   │   ├── return-value.ts           C1: 戻り値 deep equal (片側 exception なら N/A — C5 に委譲)
│   │   │   ├── argument-mutation.ts      C4: setup 由来 object/array の pre/post snapshot 差分
│   │   │   ├── exception.ts              C5: 例外 ctor + message (ExceptionProfile で message 正規化)
│   │   │   ├── external-observation.ts   C3 console 呼出列 + C4 新規 global key (ExternalObservationProfile で global ignore patterns)
│   │   │   ├── dom-mutation.ts           C2: jsdom 実行後 dom_html を DomNormalizeProfile で正規化して比較。両側 dom_changed===false なら N/A
│   │   │   ├── interaction-trace.ts      C6: interaction_trace 列を InteractionTraceProfile でフィルタして比較。両側空なら N/A
│   │   │   └── index.ts                  oracle barrel (+ Profile 型)
│   │   ├── verdict.ts                    OracleObservation[] → Verdict の合成 (deriveOverallVerdict) + inconclusive 理由分類 (deriveVerdictReason) + VERDICT_REASON 定数 (ADR-0013 / ADR-0018)
│   │   └── index.ts                      comparison barrel (oracles + verdict)
│   └── serializer.ts                   canonical 値 → 文字列 (sandbox/capture と comparison/oracles の host-realm 共通 util)
├── selakovic/
│   ├── checker.ts                      checkEquivalence(EquivalenceInput) のオーケストレーション (環境分岐 / oracle 配線 / outer catch で error_message)
│   ├── oracle-routing.ts               環境 (vm / jsdom) ごとに走らせる oracle 集合と評価順を返す
│   ├── profiles.ts                     Selakovic 固有の正規化「値」(DomNormalizeProfile / ExceptionProfile / ExternalObservationProfile / InteractionTraceProfile / IterationCapOptions)
│   └── index.ts                        adapter barrel
├── index.ts                            package barrel: selakovic の checkEquivalence + common/verdict (deriveOverallVerdict / deriveVerdictReason / VERDICT_REASON) + contract 型
└── README.md
```

> 記録 Proxy で workload が叩く境界オブジェクトを *何で* wrap するかは runnable 側 (`src/preprocessing/selakovic/assemble/recorder-hooks.ts`) が `globalThis.__recorder` を見て組み立てる — equivalence-checker 側は Proxy 実装 (`recording-proxy.ts`) を提供して `__recorder` を注入するだけ。

## 依存方向

```
selakovic/checker.ts ─ selakovic/{oracle-routing, profiles}
                     └ common/comparison ─ common/comparison/oracles ─ common/sandbox/capture (ExecutionCapture)
                     └ common/comparison/verdict
                     └ common/sandbox ─ executors/{vm,jsdom} ─ capture/{snapshot,console-hook,recording-proxy,types} ─ serializer
                                       └ transforms/{non-determinism,iteration-cap}
                     └ src/ast/* (parser / walk — iteration-cap が使う)
                     └ src/contracts/equivalence-contracts (型のみ、両端の leaf)
```

葉ノードは `common/serializer.ts` (依存なし) と `common/sandbox/transforms/non-determinism.ts` (`node:vm` のみ)。
oracle 層が触れる唯一の sandbox 型は `ExecutionCapture` (`common/sandbox/capture/types.ts`)。`selakovic/` の
framework/dataset 固有の string literal は `profiles.ts` にだけ現れる (`common/` のソースには置かない — ESLint zone + grep)。

## 関連 ADR

- [ADR-0012](../../../ai-guide/adr/0012-equivalence-checker-execution-environment.md): 実行環境 = jsdom + vm 主軸 / 非決定性遮断 (Playwright は将来)
- [ADR-0013](../../../ai-guide/adr/0013-equivalence-operational-definition.md): 等価性の operational 定義 (どの channel を等価の根拠にするか) + verdict 合成順序
- [ADR-0015](../../../ai-guide/adr/0015-equivalence-checker-layering-and-dom-oracle.md): `common`/`selakovic` 二層化 + C2 DOM oracle + C6 interaction-trace の設計
- [ADR-0016](../../../ai-guide/adr/0016-equivalence-sandbox-sut-dependency-resolution.md): SUT lib の npm dep を fork の lockfile で宣言 → `createRequire` で解決 (jsdom executor の `.../node_modules/<dep>` → bare fallback はその補足)
- [ADR-0017](../../../ai-guide/adr/0017-equivalence-sandbox-pre-execution-transforms.md): 実行前 transform (iteration-cap / 非決定性凍結) を sandbox に置く
- [ADR-0018](../../../ai-guide/adr/0018-equivalence-verdict-conservative.md): verdict 保守化 — `inconclusive` 導入 + positive-evidence ルール (C1/C4/C6/C2)、`dom_changed` で C2 を positive 格上げ (Phase C-2)
