# mb-analyzer (TypeScript 側) アーキテクチャ

TypeScript 側コードベース `mb-analyzer/` のアーキテクチャ詳細。共通概念と Python ↔ Node 契約は [`index.md`](index.md) を参照。

---

## 位置づけ

等価性検証器・Pruning・同値分割テスト・ts-eslint ルール生成など、AST 解析とサンドボックス実行を担う薄い CLI です。Python 側から `dist/cli.js` に対して stdin/stdout の JSON で呼び出されます。

- Python ↔ Node 通信は stateless な subprocess ベース (長寿命プロセス / IPC は使わない)
- バッチ API では Python 側が並列化 (`ThreadPoolExecutor`) を担当し、TS 側は逐次処理

---

## 実装の意味論リファレンス

観測軸 (before/after × pre/post)、オラクルの責務分担、`not_applicable` / `error` の合成ロジックなど **実装の意味論詳細** は本文書では扱いません (オラクル・verdict の定義は ADR-0013 / ADR-0015 / ADR-0018、モジュール構成は skill 生成の in-tree README — 判断: [ADR-0029](../adr/0029-generated-reference-docs.md))。本文書 (architecture) は依存方向ゾーンや Python ↔ Node 契約など **守るべき契約** に絞り、意味論の変更で肥大化させない方針です。

---

## 依存方向ゾーン (ESLint `import/no-restricted-paths` で機械強制)

```
contracts/                ──→ (何も import しない)  // Python ↔ TS JSON 契約
ast/                      ──→ (何も import しない)  // Babel AST 操作の汎用基盤
codegen/                  ──→ ast のみ (in-source test の valid JS 検証用、例外)  // string-level コード組み立て (ADR-0023)
preprocessing/common/     ──→ ast, codegen, contracts のみ   // ドメイン非依存の前処理コア
preprocessing/selakovic/  ──→ preprocessing/common, ast, codegen, contracts
equivalence-checker/      ──→ ast, codegen, contracts のみ
pruning/                  ──→ ast, codegen, contracts, equivalence-checker (preprocessing は import 禁止)
equivalence-class-test/   ──→ 上記すべて (将来追加予定)
eslint-rule-codegen/      ──→ 上記すべて (将来追加予定)
cli/                      ──→ 全機能 (composition root)
```

- **`contracts/`**: 末端層。他機能を import 禁止。Python 側 Pydantic モデルと JSON 互換な型定義のみ置く
- **`ast/`**: 末端層。Babel AST 操作の汎用ユーティリティ (parse/walk/subtree-hash/inspect)。pruning と preprocessing で共有
- **`codegen/`**: 末端層。AST 非依存の string-level コード組み立て (ADR-0023 placeholder substitution model の 5 helper)。preprocessing / equivalence-checker / pruning から参照される。in-source test の valid JS 検証のため codegen → ast のみ例外的に許容
- **`preprocessing/common/`**: ドメイン非依存の前処理コア (AST diff, minimal enclosure, setup 構築) = ADR-0011 の **Tier 1**。`preprocessing/selakovic/` を import 禁止
- **`preprocessing/selakovic/`**: Selakovic データセット固有のドメイン処理 = ADR-0011 の **Tier 2** (段1 役割分解: `<lib>_*.js` dir scan + `f1`/`test()` body 抽出 + 計測ハーネス除去 / 段2 作用点ルーティング A·B·A+B + ADR-0014 case split / レイアウト判定 / HTML inline `<script>` 抽出 / Angular controller-wrapper 再構成)
- **各機能パッケージ**: 自身より右側の機能を import 禁止。横依存を避ける
- **`cli/`**: composition root。stdin/stdout と subprocess 契約を担当し、ビジネスロジックは持たない

ゾーン定義は `mb-analyzer/eslint.config.js` の `DEPENDENCY_ZONES` にあり、`mise run lint-analyzer` で自動検証されます。

---

## ディレクトリ構造

```text
mb-analyzer/                  # === TypeScript CLI (現行実装) ===
├── src/
│   ├── ast/                  # 末端層: Babel AST 操作の汎用ユーティリティ
│   │   ├── parser.ts         # parse(plugins?) / generate / tryGenerateNode
│   │   ├── walk.ts           # walkNodes / VisitContext (祖先パス付き)
│   │   ├── subtree-hash.ts   # canonicalHash / SubtreeSet (top-down 同型判定)
│   │   └── inspect.ts        # countNodes / nodeSize / snippetOfNode
│   ├── codegen/              # 末端層: ADR-0023 placeholder substitution model の 5 helper
│   │   └── placeholder.ts    # declareObservationGlobal / replaceFunctionBody / replaceFunctionBodyWithObserver / wrapObservedWorkload / substituteBody
│   ├── contracts/            # 末端層: Python ↔ TS の JSON 契約のみ
│   │   ├── equivalence-contracts.ts    # Python `equivalence.py` と JSON 互換
│   │   ├── pruning-contracts.ts        # Python `pruning.py` と JSON 互換
│   │   └── preprocessing-contracts.ts  # Python `preprocessing.py` と JSON 互換
│   ├── equivalence-checker/  # 等価性検証器（pruning/ 等を import 禁止; common→selakovic 一方向 DI を ESLint 強制）
│   │   ├── common/           # dataset 非依存 (ADR-0015)
│   │   │   ├── sandbox/      # (setup,before,after) を実行して ExecutionCapture を作る
│   │   │   │   ├── executors/{vm,jsdom}.ts        # vm = 素 node:vm / jsdom = window+document+require shim
│   │   │   │   ├── capture/{types,snapshot,console-hook,recording-proxy}.ts  # capture 型 + 値/例外/global snapshot + console hook + 記録 Proxy(C6)
│   │   │   │   └── transforms/{non-determinism,iteration-cap}.ts  # Date/Math.random/timer 凍結 (ADR-0012) + 計測ループ clamp (ADR-0017)
│   │   │   ├── comparison/   # ExecutionCapture ×2 → Verdict
│   │   │   │   ├── oracles/{return-value,argument-mutation,exception,external-observation,dom-mutation,interaction-trace}.ts  # C1/C4/C5/C3+C4/C2/C6
│   │   │   │   └── verdict.ts # deriveOverallVerdict / deriveVerdictReason / VERDICT_REASON (ADR-0013 / ADR-0018)
│   │   │   └── serializer.ts # host-realm 用 canonical 値 → 文字列
│   │   └── selakovic/        # dataset 依存 adapter (ADR-0015)
│   │       ├── checker.ts    # checkEquivalence() 本体 (environment で vm / jsdom を振り分け — ADR-0012)
│   │       ├── oracle-routing.ts # 環境ごとの oracle 集合 + 評価順
│   │       └── profiles.ts   # Selakovic 固有の正規化「値」(DOM/exception/external/interaction profile + iteration-cap)
│   ├── preprocessing/        # データセット前処理 (1 issue → (setup, before, after, workload) 抽出)
│   │   ├── common/           # Tier 1 (ADR-0011): ast-diff / enclosure / setup-cleanup
│   │   └── selakovic/        # Tier 2 (ADR-0011): io/{layout,lib-pair} (FS I/O) →
│   │                         #   decompose/{inline-script,f1,test-case} (段1) →
│   │                         #   route/{aspect,lib-diff,case-split} (段2) →
│   │                         #   assemble/ (strategies/{changed-fn,changed-stmt,fallback,server-changed-fn} ×
│   │                         #     wrappers/{angular,top-level,server} + recorder-hooks (C6 hooks)) /
│   │                         #   pipeline.ts (段1·段2 統括) / index.ts (薄い barrel)
│   ├── pruning/              # 第 1 段階 pruning エンジン (AST toolbox 本体は src/ast/ に集約)
│   │   ├── ast/parser.ts     # src/ast/parser を PARSER_PLUGINS で注入する薄ラッパー (ADR-0006)
│   │   ├── candidates.ts / engine.ts / index.ts
│   │   └── rules/            # whitelist / blacklist / replacement
│   └── cli/                  # composition root (全機能を import 可能)
│       ├── index.ts          # サブコマンドディスパッチ + 大量出力 stdout flush 待ち
│       ├── check-equivalence.ts
│       ├── prune.ts
│       └── preprocess-selakovic.ts
├── tests/                    # vitest (`tests/{cli,equivalence-checker,pruning,contracts,preprocessing}/**` + property + integration)
│   ├── cli/
│   ├── equivalence-checker/  # common/comparison/verdict + common/sandbox/executors/{vm,jsdom} + selakovic/checker のみ
│   │                         #   (oracle 6 本 / routeOracles / serializer / recording-proxy / transforms は各 src の in-source — ADR-0007)
│   ├── preprocessing/        # selakovic.test.ts (公開 API preprocess() のみ; モジュール内ヘルパは各 src ファイルの in-source — ADR-0007)
│   ├── pruning/              # engine.test.ts (モジュール内ヘルパ candidates / rules / ast/parser は各 src ファイルの in-source)
│   ├── property/
│   ├── integration/          # selakovic-2016.test.ts
│   └── contracts/
├── dist/cli.js               # esbuild バンドル成果物 (mise run build-analyzer で生成)
├── eslint.config.js          # `import/no-restricted-paths` で依存方向を機械強制
├── tsconfig.json             # strict + noUncheckedIndexedAccess 有効
└── vitest.config.ts

mb-analyzer-legacy/           # [DEPRECATED] 旧 pnpm workspace monorepo
# 認知コストを抑えつつ復元可能なように単純リネーム退避。新機能は追加しない
```

---

## サブコマンドと CLI 契約

`mb-analyzer/dist/cli.js <subcommand>` で呼び出し、stdin から入力、stdout に結果を書く。

### `check-equivalence` (単発)

- 入力: stdin に 1 JSON オブジェクト (`EquivalenceInput`)
- 出力: stdout に 1 JSON オブジェクト (`EquivalenceCheckResult`)
- 終了コード: `equal=0 / not_equal=1 / inconclusive=2 / error=3` (ADR-0018)

### `check-equivalence-batch` (バッチ)

- 入力: stdin に JSONL (1 行 1 `EquivalenceInput`、`id` / `timeout_ms` は **必須**)
- 出力: stdout に JSONL (各行に `id` エコーバック + `effective_timeout_ms`)
- 終了コード: 正常完了 0 / I/O 失敗 (stdin 不正等) 2
- バッチ内は **逐次 `for...of await`** (並列化は Python 側 `ThreadPoolExecutor` の責務)
- 1 行のエラーは他行に波及しない (`{id, verdict:"error", error_message}` を即時出力)

---

## Python ↔ Node の型互換

- **フィールド命名**: snake_case (`timeout_ms`, `effective_timeout_ms`, `before_value` 等)
- **列挙値文字列**: Python `Verdict.EQUAL.value == "equal"` と TS `VERDICT.EQUAL === "equal"` を完全一致
- **スキーマ互換性**: 結果は `extra="ignore"` なので TS が新フィールドを足しても Python 側は壊れない

詳細は [`index.md`](index.md) の「Python ↔ Node の JSON 契約」参照。

## Preprocess の主要フィールドの意味

`mb-analyzer/src/contracts/preprocessing-contracts.ts` の `PreprocessingIssueResult.candidates[]` の主要フィールド:

- **`setup`**: equivalence-checker の sandbox executor (`vm.ts` / `jsdom.ts`) の `setup` 引数に渡される文字列。sandbox で workload を実行する前に context を整える generic な「準備コード」。placeholder-substitution 系経路では `$BODY$` プレースホルダを 1 個含む。構成の詳細は [ADR-0023](../adr/0023-preprocess-placeholder-substitution.md) §各値の役割。
- **`before` / `after`**: 等価検証で比較する 2 セットの本体コード (パッチ前 / 後)。組み立て経路ごとに「embedded 全文」「変更関数本体のみ」など中身が変わる。
- **`workload`** (optional): placeholder-substitution 系経路 (changed-fn / changed-stmt / server-changed-fn) のみ non-null。`before` / `after` と分離された観測駆動コードで、executor の workload 引数に渡される。詳細 [ADR-0023](../adr/0023-preprocess-placeholder-substitution.md) §設計の核。

---

## 新機能の追加ガイド

新機能は新 `mb-analyzer/` 側に実装すること (`mb-analyzer-legacy/` は DEPRECATED)。

### 1. 新しい oracle の追加

1. `mb-analyzer/src/equivalence-checker/common/comparison/oracles/` に新 oracle を作成 (`check*(before, after, profile?): OracleObservation` を export) し `oracles/index.ts` に re-export
2. `mb_scanner/domain/entities/equivalence.py` の `Oracle` 列挙値に対応する文字列を追加 (Python ↔ TS で完全一致; TS 側は `contracts/equivalence-contracts.ts` の `ORACLE`)
3. `selakovic/oracle-routing.ts` の環境別 oracle 集合 + `selakovic/checker.ts` の `runOracle` switch に追加。dataset 固有の正規化値は `selakovic/profiles.ts` に置いて `common/` に直書きしない
4. positive evidence にするか / verdict 合成への影響を `common/comparison/verdict.ts` と `use_cases/equivalence_verification.py` (`derive_overall_verdict` / `derive_verdict_reason`、両者ミラー) で見直し
5. テスト追加: oracle 関数の単発判定は新 oracle ファイル末尾の `if (import.meta.vitest)` ブロックに (ADR-0007)、合成への影響は `tests/equivalence-checker/common/comparison/verdict.test.ts` と Python 側 use case テストに

### 2. サンドボックス環境のカスタマイズ

- **実行前 transform の追加** (非決定性凍結 / iteration-cap 系): `mb-analyzer/src/equivalence-checker/common/sandbox/transforms/` に追加 (ADR-0017)。dataset 固有の閾値は `selakovic/profiles.ts` 経由で渡す
- **executor への統合**: `common/sandbox/executors/{vm,jsdom}.ts` で transform を body に適用してから実行

### 3. バッチ API の拡張

- Node 側は 1 バッチ 1 subprocess でトリプルを逐次処理する設計 (Python 側 `ThreadPoolExecutor` で並列化)
- JSONL 入出力で `id` をエコーバックし、Python ↔ Node の順序暗黙依存を避ける
- `effective_timeout_ms` を結果に含め、Python→Node の timeout_ms 受け渡し乖離を自動検出する
- CLI 層で `timeout_ms` の優先順位 (JSONL 行 > CLI `--timeout-ms` > Pydantic default) を明示的に解決する

### 4. 新機能パッケージの追加 (Pruning / 同値分割テスト / ルール生成)

1. `mb-analyzer/src/<feature-name>/` に新ディレクトリを作成
2. `eslint.config.js` の `DEPENDENCY_ZONES` に新ゾーンを追加し、依存方向を機械強制する
3. CLI ハンドラを `mb-analyzer/src/cli/<feature>.ts` に追加、`cli/index.ts` の `SUBCOMMANDS` に登録
4. Python 側は `mb_scanner/adapters/gateways/` に新 Gateway、`domain/ports/` に新 Protocol、`use_cases/` に新 Use Case を追加

---

## コーディング規約 (TypeScript 側)

### 型定義の原則

- **`any` 型禁止**: `@typescript-eslint/no-explicit-any` で制約
- **`unknown` → 型ガード** で段階的に narrow する
- **`noUncheckedIndexedAccess: true`**: 配列/マップの要素アクセスは `T | undefined` として扱う
- **外部入力 (stdin JSON) のパース**: `unknown` として受け取り、手書きの型ガードで `EquivalenceInput` に narrow する (`contracts/equivalence-contracts.ts` の Pydantic 互換型に変換)
- **ESM インポートは相対パス + 拡張子なし** (`import { foo } from "./bar"` 形式)
- **`import type` の強制**: `@typescript-eslint/consistent-type-imports` で型専用 import を使い分ける

### JSDoc とコメント

共通原則は [`index.md` の「コメントとドキュメントの層分離」](index.md#コメントとドキュメントの層分離) 参照。TS 側の具体化:

- **`/** */` JSDoc**: 関数・クラスの **契約** に絞る。不変条件 / 前提 / 失敗条件が中心で、採用理由・却下した選択肢は ADR へ
- **JSDoc タグ** (`@param` / `@returns` / `@throws`): 使うなら統一。一部だけタグ付ける混在は避ける。自由記述の散文だけで十分なことも多い
- **`//` 前置コメント**: 自明でない局所的な工夫の 1〜2 行説明に使う。シグネチャから読める内容は書かない
- **section divider** (例: `// --- 内部ヘルパ ---`) は避ける。export 有無と関数名で区切りは伝わる
- **export for testing の理由説明を JSDoc に書かない**: 参照元 (`tests/`) を見れば自明で冗長
- **ADR 参照**: `// 判断: ai-guide/adr/NNNN-xxx.md` 1 行に絞る

### Magic 識別子の命名規則

`mb-analyzer/` 内で「ツール側 (preprocess / pruning / sandbox) が触る identifier」は **役割で記法を分ける** (= 識別子の見た目から「置換マーカー / 実行時変数」が即判別できる):

- **置換マーカー** (preprocess / pruning): **`$` 系**
  - preprocess: `$BODY$` (single, textual replace、AST に載らない、`setup.replace('$BODY$', body)` で sandbox 投入前に消える — `codegen/placeholder.ts`)
  - pruning: `$P0`, `$P1`, ... (AST identifier、連番で複数共存 — `pruning/common/rules/replacement.ts` の `PLACEHOLDER_NAME_PATTERN = /^\$P\d+$/` が単一ソース、ADR-0009)
- **sandbox 実行時の internal 変数**: **`__NAME__`** (両端 underscore)
  - 例: `__OBS__` (戻り値観測配列) / `__OBS_R__` (1 回の呼び出し戻り値の一時保持)
  - `__OBS__` は setup の最先頭で `let __OBS__ = [];` として宣言・初期化 (`placeholder.ts` の `declareObservationGlobal` helper)。sandbox top-level の lexical binding なので `replaceFunctionBodyWithObserver` で setup 側に inline 化された観測 IIFE / `wrapObservedWorkload` から closure 経由で参照される (= `globalThis.__OBS__` 経由のアクセスは top-level `let` の特性上**不可**、これは scope を跨いだ誤参照を仕様レベルで防ぐ意図)

新しく magic 識別子を導入するときは、置換マーカーなら `$` 系、sandbox に残る実行時変数なら `__` 系で命名する。詳細・案 B/C を不採用にした理由は [ADR-0023](../adr/0023-preprocess-placeholder-substitution.md) §命名規則 を参照。

### 静的解析ツール

- **Linter**: ESLint (`mise run lint-analyzer`)
  - `@typescript-eslint/recommended-type-checked`
  - `import/no-restricted-paths` (依存方向の機械強制)
  - `@typescript-eslint/consistent-type-imports`
- **Type Checker**: `tsc --noEmit` (`mise run typecheck-analyzer`)
- **Test**: vitest (`mise run test-analyzer`)
- **Build**: esbuild 単一バンドル (`mise run build-analyzer` → `dist/cli.js`)

### ビルドとバンドル

- 本体は単一の ESM バンドル (`dist/cli.js`)。Python 側から `node dist/cli.js <subcommand>` で呼び出せる状態を常に維持する
- `mise run build-analyzer` はキャッシュ判定込み (`Already up to date` で早期 return)
- Python 側の integration test は `dist/cli.js` の存在確認 + 不在なら `pytest.skip` でフォールバック

---

## テスト配置ポリシー

- `mb-analyzer/tests/` 配下を vitest の `tests/**/*.test.ts` で自動検出する
- テストディレクトリ構造は `src/` とミラー: `src/cli/check-equivalence.ts` → `tests/cli/check-equivalence-batch.test.ts` のように対応させる
- in-source / `tests/` の振り分けは ADR-0007 のルール (モジュールの `index.ts` に乗るか) — oracle / `routeOracles` / serializer / 各 transform 等の内部ヘルパは各 src ファイル末尾の `if (import.meta.vitest)` に置く。詳細は [`quality-check/mb-analyzer.md`](../quality-check/mb-analyzer.md)
- サンドボックス実行の E2E (stdin/stdout 含む) は `tests/cli/` に置く
- `tests/equivalence-checker/` に置くのは公開 API (`checkEquivalence`)、verdict 合成 (`deriveOverallVerdict` / `deriveVerdictReason` — 論文 audit trail として外仕様化)、および real vm/jsdom/FS を叩く executor (`vm` / `jsdom`) — 後者は in-source に置くと実装本体が肥大するため `tests/` 側に残す
- Python 側 integration test (`tests/adapters/gateways/equivalence/test_selakovic_fixtures.py`) と役割分担: TS 側テストは型レベル・単体の責務、言語をまたぐ subprocess 契約は Python 側で実機確認
