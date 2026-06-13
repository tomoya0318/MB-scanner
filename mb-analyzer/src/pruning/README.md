# pruning

構造パターン導出エンジン。`(before, after, setup)` トリプルから **ワイルドカード付きの最小構造パターン** を出力する。公開エントリポイントは `index.ts` の `prune`（= `selakovic/pruner.ts` → `common/engine.ts`）。

`preprocessing/` / `equivalence-checker/` と対称の二層構成（ESLint `import/no-restricted-paths` で機械強制）:

- **`common/`** — dataset 非依存の pruning アルゴリズム本体。候補列挙（AST 差分フィルタ）と iterate&revert ループ。「この before 変種はまだ等価か」を判定するための等価検証関数を **DI（`PruneDeps`）で受け取る** だけで、`equivalence-checker/` を直接知らない。`common/` は `pruning/selakovic` も `equivalence-checker` も import しない。
- **`selakovic/`** — dataset adapter。`equivalence-checker` の `checkEquivalence` を bind して `common/engine.prune()` に注入する薄い層。等価検証の実行環境（`environment` / `module_base_dir` / `mount_html`）といった dataset 固有の事情はこの層が `checkEquivalence` への呼び出しに閉じ込める。

「主軸（pruning など）は論文 / dataset 非依存」というルールを構造で担保するための分割: `common/` がアルゴリズム、`selakovic/` が dataset の事情を closure に閉じ込める層。`equivalence-checker/common ↔ selakovic` と完全に対称。

## 入出力契約

公開 API は `index.ts` の re-export (`prune` 関数 + 型定義) のみ — 内部構成 (`common/` / `selakovic/`) は外に出さない。型は `mb-analyzer/src/contracts/pruning-contracts.ts` で定義され、Python 側 (`mb_scanner/domain/entities/pruning.py`) と JSON シリアライゼーション互換を保つ (変更は paired-change)。

CLI ラッパは `mb-analyzer/src/cli/prune.ts` (`runPrune` / `runPruneBatch`、`src/cli/index.ts` が `prune` / `prune-batch` サブコマンドにマップ) で、本モジュールの `prune()` を JSON でラップして stdin/stdout を中継する薄い層。Python 側 `mb_scanner/adapters/cli/pruning.py` (`mbs prune` / `mbs prune-batch`) が subprocess 経由でこの CLI を起動する。**入出力データの意味論はここ (本 README) を一次ソースとし、CLI 側には CLI 固有の引数 / stderr 規約 / 終了コードのみ書く**方針。

### `PruningInput`

```ts
interface PruningInput {
  id?: string;                // バッチ API での順序追跡用 (省略可)
  before: string;               // 元コード (検証対象、必須)
  after: string;               // パッチ後コード (検証対象、必須)
  setup?: string;             // 両側で共通の事前定義コード (省略時 "")
  timeout_ms?: number;        // 1 回の checkEquivalence 上限 (default 5000)
  max_iterations?: number;    // L4 (Hydra 実行) の試行上限 (default 1000)
}
```

`setup` は単数 string (ADR-0004)。文字列長は `MAX_CODE_LENGTH = 10^6` で Python 側が validation。`timeout_ms × max_iterations` が pruning 全体の wall-time 上限になる (ADR-0008 §試行回数と budget)。

### `PruningResult`

```ts
interface PruningResult {
  id?: string;                // 入力 id をエコーバック
  verdict: "pruned" | "initial_mismatch" | "error";
  pattern_ast?: unknown;      // Babel AST の JSON シリアライズ
  pattern_code?: string;      // generate(pattern_ast) の出力 (人間可読形)
  placeholders?: Placeholder[];
  iterations?: number;        // 実消費した L4 試行回数
  node_count_initial?: number;
  node_count_pruned?: number;
  effective_timeout_ms?: number;
  error_message?: string | null;
}

interface Placeholder {
  id: string;                 // "$P0", "$P1", ... (3 カテゴリ共通の連番)
  kind: "statement" | "expression" | "identifier";
  original_snippet: string;   // 置換前の before コード片 (第 2 段階で参照)
}
```

verdict ごとの付与フィールド:

| verdict | 付与されるフィールド | 意味 |
|---|---|---|
| `pruned` | `pattern_ast` / `pattern_code` / `placeholders` / `iterations` / `node_count_*` | pruning 完走、最小パターン確定 |
| `initial_mismatch` | `node_count_initial` のみ | 初回検証で before ≢ after、pruning を回さず停止 |
| `error` | `error_message` (+ 部分的に `node_count_initial`) | parse 失敗 / 等価性検証 error / setup runtime error |

### 3 カテゴリ placeholder の見え方 (ADR-0009)

`placeholders[i].id` は `$P` + 連番、`kind` は 3 種類いずれか。`pattern_code` / `pattern_ast` 上の表現はカテゴリで異なる:

| kind | `pattern_ast` のノード型 | `pattern_code` 上の見た目 | 機械処理での識別 (TS) |
|---|---|---|---|
| `statement` | `ExpressionStatement(Identifier("$Pn"))` | `$Pn;` | `node.type === "ExpressionStatement" && node.expression.type === "Identifier" && /^\$P\d+$/.test(node.expression.name)` |
| `identifier` | `Identifier("$Pn")` | `$Pn` | `node.type === "Identifier" && /^\$P\d+$/.test(node.name)` |
| `expression` | `StringLiteral("$Pn")` | `"$Pn"` | `node.type === "StringLiteral" && /^\$P\d+$/.test(node.value)` |

`placeholders[i].id` は **prune に成功した順** (`$P0`, `$P1`, ...) で採番される。`tryPruneCandidates` は候補を size 降順で試行し、等価性検証に通った 1 候補のみ `placeholders.push(...)` で連番が振られるため、**`pattern_ast` 内の出現順 (DFS 走査順を含む) とは独立** で一致は保証しない。複数の placeholder が同じ id (`$P0`) を持つことはない。

### 元コード衝突の扱い

入力 before / after に `/^\$P\d+$/` 形の Identifier が含まれていると、placeholder と AST 上で区別不能になる。`prune()` は parse 直後に walk して該当 Identifier があれば **stderr に warning を出す** が、pruning 動作は変えない (ADR-0009 §元コード衝突):

```
warning: input (before) contains identifier "$P0" which collides with internal placeholder format. pruning may produce ambiguous results.
```

副作用として、入力中の `$Pn` Identifier は `common/candidates.ts:isPlaceholderNode` フィルタにより候補から除外される (= pruning では触らない)。判別不能 risk はユーザー責任で許容する設計。

## ファイル index

```
src/pruning/
├── index.ts                ← 公開 re-export (selakovic/ を re-export = dataset エントリ + 型再export)
├── selakovic/              ← Tier 2: dataset adapter — equivalence-checker を bind して common/ に注入
│   ├── index.ts                ← barrel (selakovic/pruner を re-export)
│   └── pruner.ts               ← checkEquivalence を common/engine.prune に注入する薄い adapter
└── common/                 ← Tier 1: dataset 非依存の pruning アルゴリズム本体 + 宣言データ
    ├── engine.ts               ← prune(input, deps) + tryPruneCandidates (mutate + revert / savepoint パターン)。等価検証は deps.checkEquivalence で注入
    ├── candidates.ts           ← enumerateCandidates (4 段フィルタ + size 降順)
    ├── rules/                  ← pruning が扱う対象と戦略の宣言データ集
    │   ├── index.ts                ← barrel
    │   ├── whitelist.ts            ← WHITELIST_CATEGORIES (型 → カテゴリ) + PARSER_PLUGINS
    │   ├── blacklist.ts            ← BLACKLIST_CATEGORIES (`@babel/types` 文法メタから自動導出)
    │   └── replacement.ts          ← REPLACEMENTS (カテゴリ → placeholderKind + buildNode) + PLACEHOLDER_NAME_PATTERN
    └── ast/
        └── parser.ts            ← `src/ast/parser` の汎用 parse に `common/rules/whitelist.ts:PARSER_PLUGINS` を渡す薄ラッパ (pruning 固有はこれだけ; +generate/tryGenerateNode を再export)
```

AST toolbox 本体は **`src/ast/`** に集約 (機能間で共有、pruning 知識ゼロ — リネーム前は `pruning/ast/` 配下にあった):

| `src/ast/` | 役割 |
|---|---|
| `parser.ts` | parse / generate / tryGenerateNode (Babel ラッパ) |
| `walk.ts` | walkNodes / isNode (VISITOR_KEYS ベースの DFS 走査) |
| `inspect.ts` | countNodes / nodeSize / snippetOfNode (read-only AST 検査) |
| `subtree-hash.ts` | `SubtreeSet` (top-down subtree hash で after 所属判定) + `canonicalHash` |

層の役割分担:

| 層 | 中身 | dataset 知識 | 入れ替え可能性 |
|---|---|---|---|
| `selakovic/` (Tier 2) | checkEquivalence を bind して common に注入 | あり (実行環境・oracle routing hint を closure に閉じ込める) | dataset 固有 |
| `common/{engine,candidates}` (Tier 1) | アルゴリズム本体。等価検証は DI で受ける | なし | 別 dataset の adapter からも再利用可 |
| `common/rules/` | 宣言データのみ (whitelist / blacklist / replacement) | なし (文法だけで決まる) | データ差し替え可能 |
| `common/ast/parser.ts` | whitelist-aware parse の薄ラッパ | plugin 構成のみ | — |
| `src/ast/` (共有) | parser / walk / inspect / subtree-hash (Babel AST toolbox) | なし | 別プロジェクトに切り出し可能 |
| `../contracts/pruning-contracts` | Python と互換の JSON 型・列挙 (末端層) | なし | 触れない |

## 依存方向

```
selakovic/index.ts (barrel = dataset エントリ)
 └─ selakovic/pruner.ts
     ├─ ../../equivalence-checker (checkEquivalence — bind する対象。selakovic/ だけが import 可)
     └─ common/engine.ts ── prune(input, { checkEquivalence })
         ├─ common/candidates.ts ──┬─ common/rules/whitelist.ts
         │                         ├─ common/rules/blacklist.ts ── common/rules/whitelist.ts
         │                         ├─ common/rules/replacement.ts (PLACEHOLDER_NAME_PATTERN)
         │                         ├─ ../../ast/subtree-hash.ts ── ../../ast/walk.ts
         │                         ├─ ../../ast/walk.ts
         │                         └─ ../../ast/inspect.ts ── ../../ast/walk.ts
         ├─ common/rules/replacement.ts ── common/rules/whitelist.ts
         ├─ common/ast/parser.ts ── ../../../ast/parser.ts + common/rules/whitelist.ts (PARSER_PLUGINS)
         ├─ ../../ast/{inspect,subtree-hash,walk}.ts
         └─ ../../contracts/{equivalence-contracts (Verdict 型), pruning-contracts}
```

`pruning/common` は `ast/` と `contracts/` (+ `@babel/*`) しか import せず、`equivalence-checker/` / `preprocessing/` / `pruning/selakovic` は import 禁止 (eslint `import/no-restricted-paths`)。`pruning/selakovic` のみが `equivalence-checker` を import する。CLI (`cli/prune.ts`) は composition root として barrel (`pruning/index.ts`) を import する。

## 関連 ADR

- [ADR-0001](../../../ai-guide/adr/0001-pruning-ast-traversal.md): AST 走査に `VISITOR_KEYS` 再帰を採用 (`src/ast/walk.ts`)
- [ADR-0002](../../../ai-guide/adr/0002-babel-topdown-subtree-hash.md): AST 差分判定に Babel + top-down subtree hash を自作 (`src/ast/subtree-hash.ts`)
- [ADR-0003](../../../ai-guide/adr/0003-bottom-up-mapping-deferred.md): bottom-up mapping を第 2 段階以降に遅延
- [ADR-0004](../../../ai-guide/adr/0004-pruning-setup-single.md): `PruningInput.setup` を単数 string にする
- [ADR-0005](../../../ai-guide/adr/0005-grammar-derived-blacklist.md): 候補位置 blacklist を文法メタから自動導出 (`common/rules/blacklist.ts`)
- [ADR-0006](../../../ai-guide/adr/0006-grammar-derived-whitelist.md): 候補型 whitelist を alias 由来で自動導出 (`common/rules/whitelist.ts`)
- [ADR-0007](../../../ai-guide/adr/0007-in-source-testing-internal-helpers.md): 内部ヘルパとモジュール内共有ヘルパは in-source testing、公開 API は `tests/` ツリーで分離する
- [ADR-0008](../../../ai-guide/adr/0008-mutate-revert-replacement.md): 候補置換を mutate + revert (savepoint パターン) で実装し `cloneAst` を廃止
- [ADR-0009](../../../ai-guide/adr/0009-statement-placeholder-visibility.md): statement カテゴリ placeholder を `ExpressionStatement(Identifier("$Pn"))` 形にして `$Pn;` として可視化 (`common/rules/replacement.ts`, `common/candidates.ts`, `common/engine.ts`)
