# mb-analyzer (TypeScript 側) アーキテクチャ

TypeScript 側コードベース `mb-analyzer/` のアーキテクチャ詳細。共通概念と Python ↔ Node 契約は [`index.md`](index.md) を参照。

---

## 位置づけ

等価性検証器・Pruning・同値分割テスト・ts-eslint ルール生成など、AST 解析とサンドボックス実行を担う薄い CLI です。Python 側から `dist/cli.js` に対して stdin/stdout の JSON で呼び出されます。

- Python ↔ Node 通信は stateless な subprocess ベース (長寿命プロセス / IPC は使わない)
- バッチ API では Python 側が並列化 (`ThreadPoolExecutor`) を担当し、TS 側は逐次処理

---

## 実装の意味論リファレンス

観測軸 (slow/fast × pre/post)、4 オラクルの責務分担、`not_applicable` / `error` の合成ロジックなど **実装の意味論詳細** は [`../code-map.md`](../code-map.md) に集約しています。本文書 (architecture) は依存方向ゾーンや Python ↔ Node 契約など **守るべき契約** に絞り、意味論の変更で肥大化させない方針です。

---

## 依存方向ゾーン (ESLint `import/no-restricted-paths` で機械強制)

```
contracts/                ──→ (何も import しない)  // Python ↔ TS JSON 契約
ast/                      ──→ (何も import しない)  // Babel AST 操作の汎用基盤
preprocessing/common/     ──→ ast, contracts のみ   // ドメイン非依存の前処理コア
preprocessing/selakovic/  ──→ preprocessing/common, ast, contracts
equivalence-checker/      ──→ ast, contracts のみ
pruning/                  ──→ ast, contracts, equivalence-checker (preprocessing は import 禁止)
equivalence-class-test/   ──→ 上記すべて (将来追加予定)
eslint-rule-codegen/      ──→ 上記すべて (将来追加予定)
cli/                      ──→ 全機能 (composition root)
```

- **`contracts/`**: 末端層。他機能を import 禁止。Python 側 Pydantic モデルと JSON 互換な型定義のみ置く
- **`ast/`**: 末端層。Babel AST 操作の汎用ユーティリティ (parse/walk/subtree-hash/inspect)。pruning と preprocessing で共有
- **`preprocessing/common/`**: ドメイン非依存の前処理コア (AST diff, minimal enclosure, setup 構築)。`preprocessing/selakovic/` を import 禁止
- **`preprocessing/selakovic/`**: Selakovic データセット固有のドメイン処理 (HTML パース、レイアウト判定、ライブラリ結合)
- **各機能パッケージ**: 自身より右側の機能を import 禁止。横依存を避ける
- **`cli/`**: composition root。stdin/stdout と subprocess 契約を担当し、ビジネスロジックは持たない

ゾーン定義は `mb-analyzer/eslint.config.js` の `DEPENDENCY_ZONES` にあり、`mise run lint-analyzer` で自動検証されます。

---

## ディレクトリ構造

```text
mb-analyzer/                  # === TypeScript CLI (現行実装) ===
├── src/
│   ├── shared/               # 末端層: 型定義のみ（他機能を import 禁止）
│   │   ├── equivalence-contracts.ts # Python `equivalence.py` と JSON 互換 (VERDICT / Oracle / EquivalenceInput / Result)
│   │   └── pruning-contracts.ts     # Python `pruning.py` と JSON 互換 (PRUNING_VERDICT / PlaceholderKind / PruningInput / Result)
│   ├── equivalence-checker/  # 等価性検証器（pruning/ 等を import 禁止）
│   │   ├── checker.ts        # checkEquivalence() 本体
│   │   ├── verdict.ts        # 全体 verdict 判定ロジック (deriveOverallVerdict)
│   │   ├── oracles/          # 4 oracle
│   │   │   ├── return-value.ts
│   │   │   ├── argument-mutation.ts
│   │   │   ├── exception.ts
│   │   │   └── external-observation.ts
│   │   └── sandbox/          # vm.Script ベースのサンドボックス
│   │       ├── stabilizer.ts # Date / Math.random / console の decoupling
│   │       ├── executor.ts   # runInContext で slow / fast を実行
│   │       └── serializer.ts # 副作用を含む値を文字列化
│   └── cli/                  # composition root (全機能を import 可能)
│       ├── index.ts          # サブコマンドディスパッチ
│       └── check-equivalence.ts  # check-equivalence + check-equivalence-batch ハンドラ
├── tests/                    # vitest (`tests/**/*.test.ts` を自動検出)
│   ├── cli/
│   ├── equivalence-checker/
│   └── shared/
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
- 終了コード: `equal=0 / not_equal=1 / error=2`

### `check-equivalence-batch` (バッチ)

- 入力: stdin に JSONL (1 行 1 `EquivalenceInput`、`id` / `timeout_ms` は **必須**)
- 出力: stdout に JSONL (各行に `id` エコーバック + `effective_timeout_ms`)
- 終了コード: 正常完了 0 / I/O 失敗 (stdin 不正等) 2
- バッチ内は **逐次 `for...of await`** (並列化は Python 側 `ThreadPoolExecutor` の責務)
- 1 行のエラーは他行に波及しない (`{id, verdict:"error", error_message}` を即時出力)

---

## Python ↔ Node の型互換

- **フィールド命名**: snake_case (`timeout_ms`, `effective_timeout_ms`, `slow_value` 等)
- **列挙値文字列**: Python `Verdict.EQUAL.value == "equal"` と TS `VERDICT.EQUAL === "equal"` を完全一致
- **スキーマ互換性**: 結果は `extra="ignore"` なので TS が新フィールドを足しても Python 側は壊れない

詳細は [`index.md`](index.md) の「Python ↔ Node の JSON 契約」参照。

---

## 新機能の追加ガイド

新機能は新 `mb-analyzer/` 側に実装すること (`mb-analyzer-legacy/` は DEPRECATED)。

### 1. 新しい oracle の追加

1. `mb-analyzer/src/equivalence-checker/oracles/` に新 oracle を作成 (`check*(slow, fast): OracleObservation` を export)
2. `equivalence-checker/checker.ts` の observations リストに追加
3. `mb_scanner/domain/entities/equivalence.py` の `Oracle` 列挙値に対応する文字列を追加 (Python ↔ TS で完全一致)
4. `verdict.ts` / `use_cases/equivalence_verification.py` の `derive_overall_verdict` 優先順位を見直し
5. テスト追加 (`mb-analyzer/tests/equivalence-checker/oracles/*.test.ts` と Python 側 use case テスト)

### 2. サンドボックス環境のカスタマイズ

- **安定化処理の追加**: `mb-analyzer/src/equivalence-checker/sandbox/stabilizer.ts` に新しい固定化ロジックを追加 (Date, Math.random, console などの decoupling)
- **サンドボックスへの統合**: 同階層の `executor.ts` で安定化処理を適用

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
- **外部入力 (stdin JSON) のパース**: `unknown` として受け取り、手書きの型ガードで `EquivalenceInput` に narrow する (`shared/equivalence-contracts.ts` の Pydantic 互換型に変換)
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
- サンドボックス実行の E2E (stdin/stdout 含む) は `tests/cli/` に置く
- oracle / verdict 等の純粋ロジックは `tests/equivalence-checker/` に置く
- Python 側 integration test (`tests/adapters/gateways/equivalence/test_selakovic_fixtures.py`) と役割分担: TS 側テストは型レベル・単体の責務、言語をまたぐ subprocess 契約は Python 側で実機確認
