# equivalence-checker

`(setup, slow, fast)` トリプルを sandbox 実行し、出力を複数の直交軸 (oracle) で観測して
**`equal` / `not_equal` / `error`** verdict を返す。`checkEquivalence()` が公開エントリポイント
(ルート `index.ts` 経由)。

二層構成 (preprocessing と対称、ESLint `import/no-restricted-paths` で機械強制):

- **`common/`** — dataset 非依存。`f1`/`init`/`test`/`mark` も framework 名 (angular/jQuery/...) も
  知らない。各機能は `opts`/config/spec として外から渡される。`common/` は `equivalence-checker/selakovic`
  / `preprocessing` を import できない。
- **`selakovic/`** — dataset 依存 adapter。Selakovic の計測プロトコルと使用 framework を知り、
  `common/` の primitive に渡す config (oracle 選択 / 包む対象 / 正規化値) を構成してオーケストレーションする。

## ファイル index

```
src/equivalence-checker/
├── common/
│   ├── sandbox/                       (setup, slow, fast) を実行して ExecutionCapture ×2 を作る
│   │   ├── transforms/
│   │   │   └── non-determinism.ts       Math.random / Date / timer / performance.now の凍結 (ADR-0012)
│   │   ├── executors/
│   │   │   ├── vm.ts                     素 node:vm context (DOM 不要 / pruning も使う)。host 逃げ道遮断もここ
│   │   │   └── jsdom.ts                  jsdom window/document context + require shim (相対 / bare-dep via createRequire)
│   │   ├── capture/
│   │   │   ├── types.ts                  ExecutionCapture / ExceptionCapture / ArgumentSnapshot / TraceEntry / ConsoleCall
│   │   │   ├── snapshot.ts               snapshotValue / captureException / normalizeSetup / setup・new-global snapshot / isTimeoutError
│   │   │   └── console-hook.ts           console.* の呼出列を記録する instrumentation (C3 の取得側)
│   │   └── index.ts                     sandbox 層の barrel
│   ├── comparison/                     2 つの ExecutionCapture を比較 → Verdict
│   │   ├── oracles/                      channel ごとの比較器 (各 (slow, fast, opts?) → OracleObservation の純関数)
│   │   │   ├── return-value.ts           C1: 戻り値 deep equal
│   │   │   ├── argument-mutation.ts      C4: setup 由来 object/array の pre/post snapshot 差分
│   │   │   ├── exception.ts              C5: 例外 ctor + message
│   │   │   ├── external-observation.ts   C3 console 呼出列 + C4 新規 global key
│   │   │   └── index.ts                  oracle barrel
│   │   ├── verdict.ts                    OracleObservation[] → Verdict の合成優先順位ロジック (ADR-0013)
│   │   └── index.ts                      comparison barrel (oracles + verdict)
│   └── serializer.ts                   canonical 値 → 文字列 (sandbox/capture と comparison/oracles の共通 util)
├── selakovic/
│   ├── checker.ts                      checkEquivalence(EquivalenceInput) のオーケストレーション
│   └── index.ts                        adapter barrel
├── index.ts                            package barrel: selakovic の checkEquivalence + common/verdict + contract 型
└── README.md
```

## 依存方向

```
selakovic/checker.ts ─ common/comparison ─ common/comparison/oracles ─ common/sandbox/capture (ExecutionCapture)
                     └ common/sandbox ─ executors/{vm,jsdom} ─ capture/{snapshot,console-hook,types} ─ serializer
                                       └ transforms/non-determinism
                     └ ../contracts/equivalence-contracts (型のみ、両端の leaf)
```

葉ノードは `common/serializer.ts` (依存なし) と `common/sandbox/transforms/non-determinism.ts` (`node:vm` のみ)。
oracle 層が触れる唯一の sandbox 型は `ExecutionCapture` (`common/sandbox/capture/types.ts`)。

> Phase 2b で進行中の拡張 (記録 Proxy / iteration-cap / C2 DOM-mutation / C6 interaction-trace oracle /
> server vm globals / mount_html) は plan `tmp/0006_phase2b-equivalence-checker/plan.md` 参照。
