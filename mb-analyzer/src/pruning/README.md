# pruning

構造パターン導出エンジン。`(slow, fast, setup)` トリプルから **ワイルドカード付きの最小構造パターン** を出力する。`engine.prune()` が公開エントリポイント。

## 入出力契約

公開 API は `index.ts` の re-export (`prune` 関数 + 型定義) のみ。型は `mb-analyzer/src/shared/pruning-contracts.ts` で定義され、Python 側 (`mb_scanner/domain/entities/pruning.py`) と JSON シリアライゼーション互換を保つ。

CLI ラッパは `mb-analyzer/src/cli/prune.ts` (`prune` / `prune-batch` サブコマンド) で、本モジュールの `prune()` を JSON でラップして stdin/stdout を中継する薄い層になっている。Python 側 `mb_scanner/adapters/cli/pruning.py` (`mbs prune` / `mbs prune-batch`) が subprocess 経由でこの CLI を起動する。**入出力データの意味論はここ (本 README) を一次ソースとし、CLI 側には CLI 固有の引数 / stderr 規約 / 終了コードのみ書く**方針。

### `PruningInput`

```ts
interface PruningInput {
  id?: string;                // バッチ API での順序追跡用 (省略可)
  slow: string;               // 元コード (検証対象、必須)
  fast: string;               // パッチ後コード (検証対象、必須)
  setup?: string;             // 両側で共通の事前定義コード (省略時 "")
  timeout_ms?: number;        // 1 回の checkEquivalence 上限 (default 5000)
  max_iterations?: number;    // L4 (Hydra 実行) の試行上限 (default 1000)
}
```

`setup` は単数 string (ADR-0004)。文字列長は `MAX_CODE_LENGTH = 10^6` で Python 側が validation。`timeout_ms × max_iterations` が pruning 全体の wall-time 上限になる ([code-map.md §試行回数と budget](../../../ai-guide/code-map.md#試行回数-iterations-と-budget-の関係))。

### `PruningResult`

```ts
interface PruningResult {
  id?: string;                // 入力 id をエコーバック
  verdict: "pruned" | "initial_mismatch" | "error";
  pattern_ast?: unknown;      // Babel AST の JSON シリアライズ
  pattern_code?: string;      // generate(pattern_ast) の出力 (人間可読形)
  placeholders?: Placeholder[];
  iterations?: number;        // 実消費した L4 試行回数
  node_count_before?: number;
  node_count_after?: number;
  effective_timeout_ms?: number;
  error_message?: string | null;
}

interface Placeholder {
  id: string;                 // "$P0", "$P1", ... (3 カテゴリ共通の連番)
  kind: "statement" | "expression" | "identifier";
  original_snippet: string;   // 置換前の slow コード片 (第 2 段階で参照)
}
```

verdict ごとの付与フィールド:

| verdict | 付与されるフィールド | 意味 |
|---|---|---|
| `pruned` | `pattern_ast` / `pattern_code` / `placeholders` / `iterations` / `node_count_*` | pruning 完走、最小パターン確定 |
| `initial_mismatch` | `node_count_before` のみ | 初回検証で slow ≢ fast、pruning を回さず停止 |
| `error` | `error_message` (+ 部分的に `node_count_before`) | parse 失敗 / 等価性検証 error / setup runtime error |

### 3 カテゴリ placeholder の見え方 (ADR-0009)

`placeholders[i].id` は `$P` + 連番、`kind` は 3 種類いずれか。`pattern_code` / `pattern_ast` 上の表現はカテゴリで異なる:

| kind | `pattern_ast` のノード型 | `pattern_code` 上の見た目 | 機械処理での識別 (TS) |
|---|---|---|---|
| `statement` | `ExpressionStatement(Identifier("$Pn"))` | `$Pn;` | `node.type === "ExpressionStatement" && node.expression.type === "Identifier" && /^\$P\d+$/.test(node.expression.name)` |
| `identifier` | `Identifier("$Pn")` | `$Pn` | `node.type === "Identifier" && /^\$P\d+$/.test(node.name)` |
| `expression` | `StringLiteral("$Pn")` | `"$Pn"` | `node.type === "StringLiteral" && /^\$P\d+$/.test(node.value)` |

`placeholders[i].id` は **prune に成功した順** (`$P0`, `$P1`, ...) で採番される。`tryPruneCandidates` は候補を size 降順で試行し、等価性検証に通った 1 候補のみ `placeholders.push(...)` で連番が振られるため、**`pattern_ast` 内の出現順 (DFS 走査順を含む) とは独立** で一致は保証しない。複数の placeholder が同じ id (`$P0`) を持つことはない。

### 元コード衝突の扱い

入力 slow / fast に `/^\$P\d+$/` 形の Identifier が含まれていると、placeholder と AST 上で区別不能になる。`engine.prune()` は parse 直後に walk して該当 Identifier があれば **stderr に warning を出す** が、pruning 動作は変えない (ADR-0009 §元コード衝突):

```
warning: input (slow) contains identifier "$P0" which collides with internal placeholder format. pruning may produce ambiguous results.
```

副作用として、入力中の `$Pn` Identifier は `candidates.ts:isPlaceholderNode` フィルタにより候補から除外される (= pruning では触らない)。判別不能 risk はユーザー責任で許容する設計。

## ファイル index

```
src/pruning/
├── engine.ts            ← 公開 prune + tryPruneCandidates (mutate + revert / savepoint パターン)
├── candidates.ts        ← enumerateCandidates (3 段フィルタ + size 降順)
├── index.ts             ← 公開 re-export
├── rules/               ← pruning が扱う対象と戦略の宣言データ集
│   ├── index.ts            ← barrel
│   ├── whitelist.ts        ← WHITELIST_CATEGORIES (型 → カテゴリ) + PARSER_PLUGINS
│   ├── blacklist.ts        ← BLACKLIST_CATEGORIES (`@babel/types` 文法メタから自動導出)
│   └── replacement.ts      ← REPLACEMENTS (カテゴリ → placeholderKind + buildNode)
└── ast/                 ← Babel AST 汎用 toolbox (pruning 知識ゼロ)
    ├── parser.ts           ← parse / generate / tryGenerateNode (Babel ラッパ)
    ├── walk.ts             ← walkNodes / isNode (VISITOR_KEYS ベースの DFS 走査)
    ├── inspect.ts          ← countNodes / snippetOfNode (read-only AST 検査)
    └── subtrees.ts         ← FastSubtreeSet (top-down subtree hash で fast 所属判定)
```

3 層の役割分担:

| 層 | 中身 | pruning 知識 | 入れ替え可能性 |
|---|---|---|---|
| ルート (engine, candidates) | アルゴリズム本体 | あり | このプロジェクト固有 |
| `rules/` | 宣言データのみ (whitelist / blacklist / replacement) | あり | データ差し替え可能 |
| `ast/` | parser / walk / inspect / subtrees (Babel AST toolbox) | なし | 別プロジェクトに切り出し可能 |

## 依存方向

```
engine.ts
 ├─ candidates.ts ──┬─ rules/whitelist.ts
 │                  ├─ rules/blacklist.ts ── rules/whitelist.ts
 │                  ├─ ast/subtrees.ts ── ast/walk.ts
 │                  └─ ast/walk.ts
 ├─ rules/replacement.ts ── rules/whitelist.ts
 ├─ ast/parser.ts ── rules/whitelist.ts (PARSER_PLUGINS)
 ├─ ast/inspect.ts ── ast/walk.ts
 └─ ../equivalence-checker (上層モジュール)
```

葉ノードは `rules/whitelist.ts` / `ast/parser.ts` / `ast/walk.ts` (Babel のみに依存)。

## 関連 ADR

- [ADR-0001](../../../ai-guide/adr/0001-pruning-ast-traversal.md): AST 走査に `VISITOR_KEYS` 再帰を採用 (`ast/walk.ts`)
- [ADR-0002](../../../ai-guide/adr/0002-babel-topdown-subtree-hash.md): AST 差分判定に Babel + top-down subtree hash を自作 (`ast/subtrees.ts`)
- [ADR-0003](../../../ai-guide/adr/0003-bottom-up-mapping-deferred.md): bottom-up mapping を第 2 段階以降に遅延
- [ADR-0004](../../../ai-guide/adr/0004-pruning-setup-single.md): `PruningInput.setup` を単数 string にする
- [ADR-0005](../../../ai-guide/adr/0005-grammar-derived-blacklist.md): 候補位置 blacklist を文法メタから自動導出 (`rules/blacklist.ts`)
- [ADR-0006](../../../ai-guide/adr/0006-grammar-derived-whitelist.md): 候補型 whitelist を alias 由来で自動導出 (`rules/whitelist.ts`)
- [ADR-0007](../../../ai-guide/adr/0007-in-source-testing-internal-helpers.md): 内部ヘルパとモジュール内共有ヘルパは in-source testing、公開 API は `tests/` ツリーで分離する
- [ADR-0008](../../../ai-guide/adr/0008-mutate-revert-replacement.md): 候補置換を mutate + revert (savepoint パターン) で実装し `cloneAst` を廃止
- [ADR-0009](../../../ai-guide/adr/0009-statement-placeholder-visibility.md): statement カテゴリ placeholder を `ExpressionStatement(Identifier("$Pn"))` 形にして `$Pn;` として可視化 (`rules/replacement.ts`, `candidates.ts`, `engine.ts`)
