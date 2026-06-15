# pruning

> 生成物 — 手編集禁止 (ADR-0029)。再生成: `/generate-approach-spec mb-analyzer/src/pruning`
> 生成時コミット: `d122da9` (2026-06-13)

構造パターン導出エンジン。`(before, after, setup)` トリプルを入力に、等価性を保ったまま before を縮約し、**ワイルドカード (placeholder) 付きの最小構造パターン** を出力する。公開エントリは `index.ts` の `prune` (`index.ts:2`) で、実体は `selakovic/pruner.ts` → `common/engine.ts`。

二層構成 (`equivalence-checker/` と対称、ESLint `import/no-restricted-paths` で機械強制):

- **`common/`** — dataset 非依存のアルゴリズム本体。「この before 変種はまだ等価か」の判定関数を DI (`PruneDeps`, `engine.ts:36-38`) で受け取るだけで、`equivalence-checker/` を直接 import しない。
- **`selakovic/`** — dataset adapter。`equivalence-checker` の `checkEquivalence` を bind して `common/engine.prune` に注入する薄い層 (`pruner.ts:31-36`)。

## ファイル index

| file | 役割 | 主な依存 |
|---|---|---|
| `index.ts` | 公開 barrel。`selakovic/` の `prune` + 契約型を re-export (`index.ts:2-9`) | `selakovic/`, `../contracts/pruning-contracts` |
| `selakovic/index.ts` | dataset adapter の barrel (`selakovic/index.ts:2`) | `selakovic/pruner` |
| `selakovic/pruner.ts` | `checkEquivalence` を `common/engine.prune` に注入する adapter。等価検証コンテキストを closure に閉じ込める (`pruner.ts:15-21`) | `../../equivalence-checker`, `common/engine` |
| `common/engine.ts` | pruning ループ本体。初回等価性検証 → 候補列挙 → mutate + revert (savepoint) → budget 打ち切り (`engine.ts:74-175`) | `common/candidates`, `common/rules/replacement`, `common/ast/parser`, `../../ast/{inspect,subtree-hash,walk}`, 両 contracts |
| `common/candidates.ts` | 候補列挙 `enumerateCandidates` (`candidates.ts:47-70`)。5 段フィルタ + size 降順ソート | `common/rules/{whitelist,blacklist,replacement}`, `../../ast/{inspect,subtree-hash,walk}` |
| `common/rules/index.ts` | rules/ の barrel (`rules/index.ts:1-4`) | whitelist / blacklist / replacement |
| `common/rules/whitelist.ts` | 候補にできるノード型のカテゴリ表 `WHITELIST_CATEGORIES` を `@babel/types` の alias から自動導出 (`whitelist.ts:107-130`, ADR-0006) + `PARSER_PLUGINS` (`whitelist.ts:30`, 素 JS = 空配列) | `@babel/types` |
| `common/rules/blacklist.ts` | 候補位置の除外表 `BLACKLIST_CATEGORIES` を `@babel/types` の文法メタデータ (NODE_FIELDS / union shapes) から自動導出 (`blacklist.ts:99-162`, ADR-0005) | `@babel/types`, `common/rules/whitelist` |
| `common/rules/replacement.ts` | カテゴリ → placeholder 置換の対応表 `REPLACEMENTS` (`replacement.ts:32-49`) と placeholder 命名規則 `PLACEHOLDER_NAME_PATTERN = /^\$P\d+$/` (`replacement.ts:16`, ADR-0009) | `@babel/types`, `../../../contracts/pruning-contracts`, `common/rules/whitelist` |
| `common/ast/parser.ts` | `src/ast/parser` の汎用 parse に `PARSER_PLUGINS` を渡す薄ラッパ (`parser.ts:13-15`)。pruning 固有の AST コードはこれだけで、toolbox 本体は `src/ast/` に集約 | `../../../ast/parser`, `common/rules/whitelist` |

## 依存方向

```
cli/prune.ts (composition root)
 └─ pruning/index.ts ── selakovic/index.ts
     └─ selakovic/pruner.ts
         ├─ ../../equivalence-checker   ← import できるのは selakovic/ だけ (eslint で機械禁止)
         └─ common/engine.ts  prune(input, { checkEquivalence })
             ├─ common/candidates.ts ──┬─ common/rules/whitelist.ts
             │                         ├─ common/rules/blacklist.ts ── whitelist.ts
             │                         └─ common/rules/replacement.ts ── whitelist.ts
             ├─ common/rules/replacement.ts
             ├─ common/ast/parser.ts ── ../../ast/parser.ts (+ whitelist.ts の PARSER_PLUGINS)
             ├─ ../../ast/{walk,inspect,subtree-hash}.ts
             └─ ../../contracts/{pruning-contracts, equivalence-contracts (Verdict)}
```

`pruning/common` は `pruning/selakovic` / `equivalence-checker` を import 禁止 (eslint.config の DEPENDENCY_ZONES、`pruner.ts:29` のコメント参照)。dataset 固有の事情 (実行環境など) は `selakovic/` が closure に閉じ込め、`common/` は知らない (`engine.ts:19-25`)。

## 入出力契約

型は `../contracts/pruning-contracts.ts` で定義し、Python 側 `mb_scanner/domain/entities/pruning.py` と JSON シリアライゼーション互換 (snake_case / 列挙文字列) を paired-change で維持する (`pruning-contracts.ts:1-6`)。CLI ラッパは [`../cli/README.md`](../cli/README.md) 参照。

### `PruningInput` (`pruning-contracts.ts:34-58`)

| フィールド | 意味 |
|---|---|
| `id?` | バッチでの順序追跡用。結果にエコーバック (`engine.ts:77`) |
| `before` / `after` | 縮約対象 / 等価性の基準コード |
| `setup?` | 両側共通の事前定義コード。単数 string (ADR-0004)。省略時 `""` (`engine.ts:197`) |
| `timeout_ms?` | `checkEquivalence` 1 回あたりの上限。default 5_000 (`engine.ts:186`) |
| `max_iterations?` | 等価検証の試行回数上限。default 1_000 (`engine.ts:187`) |
| `environment?` / `module_base_dir?` / `mount_html?` | 後段の等価検証にそのまま渡す実行コンテキスト。`common/` は解釈せず `selakovic/` が closure に積む (`pruner.ts:15-22`) |
| `workload?` | ADR-0023 D-β の 4 値契約フィールド (changed-fn 経路のみ非 null)。`environment` 等と同様に `selakovic/` が後段の等価検証へ pass-through する (`pruner.ts:15-22`) |

budget の関係: `total_budget_ms = timeout_ms × max_iterations` (`engine.ts:193-204`)。ループは「iterations が `max_iterations` 未満」かつ「経過 wall-time が `total_budget_ms` 未満」の間だけ回る (`engine.ts:139-140`)。`iterations` は `checkEquivalence` を実際に呼んだ回数で消費される (`engine.ts:261`)。

### `PruningResult` (`pruning-contracts.ts:60-71`)

| フィールド | 意味 |
|---|---|
| `id?` | 入力 `id` のエコーバック (`pruning-contracts.ts:61`) |
| `verdict` | 下表の 3 値 |
| `pattern_ast` / `pattern_code` | 縮約後 AST (JSON) とその generate 出力 (`engine.ts:162-173`) |
| `placeholders` | 置換ごとの `{id, kind, original_snippet}` (`pruning-contracts.ts:22-26`)。`id` は prune 成功順の `$P0, $P1, ...` (`engine.ts:246`) |
| `iterations` | 消費した等価検証の試行回数 |
| `node_count_initial` / `node_count_pruned` | 縮約前 / 後の AST ノード数 (`engine.ts:98`, `engine.ts:163`) |
| `effective_timeout_ms` | 実際に適用された 1 回あたり timeout (`engine.ts:78`) |
| `error_message` | verdict=error 時の理由 |

### verdict (`pruning-contracts.ts:8-12`)

| verdict | 意味 |
|---|---|
| `pruned` | pruning 完走 (budget 切れ・候補枯渇含む)。`pattern_*` / `placeholders` / `iterations` / `node_count_*` を付与 (`engine.ts:165-174`) |
| `initial_mismatch` | 初回検証で before ≢ after — pruning 前提が崩れているため回さず停止 (`engine.ts:121-127`) |
| `error` | parse 失敗 (`engine.ts:89-96`) または初回等価検証が `error` (`engine.ts:113-120`) |

縮約継続の判定は ADR-0018 の 4 値 verdict のうち `equal` **と** `inconclusive` を「縮約可」とみなす (`engine.ts:64-66`): `inconclusive` の保守的区別は等価検証アーティファクト用で、pruning は「観測可能な差が無い」を基準にする。

### placeholder の見え方 (ADR-0009)

カテゴリ別の置換先 (`replacement.ts:32-49`):

| kind | AST 上の形 | コード上の見た目 |
|---|---|---|
| `statement` | `ExpressionStatement(Identifier("$Pn"))` | `$Pn;` |
| `identifier` | `Identifier("$Pn")` | `$Pn` |
| `expression` | `StringLiteral("$Pn")` | `"$Pn"` |

入力コードに `/^\$P\d+$/` 形の Identifier があると placeholder と判別不能になるため、`prune` は parse 直後に stderr へ warning を出す (動作は変えない、`engine.ts:100-104`, `engine.ts:298-310`)。該当ノードは候補列挙で除外される副作用がある (`candidates.ts:152-163`)。

### 候補フィルタ (5 段, `candidates.ts:13-25`)

1. placeholder ノード自身の除外 (ADR-0009)
2. 型 whitelist (`WHITELIST_CATEGORIES`, ADR-0006)
3. 親子 blacklist — 親 field validator が置換後の型を受理しない位置を除外 (ADR-0005)
4. `SubtreeSet.has` — after に同型が存在する「共通ノード」のみ候補。差分ノードはパターンの本質として必須扱い (ADR-0002)
5. 差分内リテラル保護 — リテラル (符号付き等の単項式リテラル含む、`candidates.ts:101-105`) は「親も共通ノード」の時だけ候補 (`candidates.ts:135`, ADR-0028)

候補はサイズ降順で試行 (`candidates.ts:67`)。置換は親キーの mutate → 等価判定 → 失敗時 finally で必ず revert (savepoint パターン、`engine.ts:229-289`, ADR-0008)。

## 関連 ADR

- ADR-0001: pruning の AST 走査に VISITOR_KEYS 再帰を採用 (`src/ast/walk.ts` に実装)
- ADR-0002: AST 差分判定に Babel + top-down subtree hash を自作 (`src/ast/subtree-hash.ts` に実装)
- ADR-0003: bottom-up mapping を第 2 段階以降に遅延
- ADR-0004: PruningInput.setup を単数 string にする
- ADR-0005: pruning 候補 blacklist を `@babel/types` の文法メタデータから自動導出する
- ADR-0006: pruning 候補 whitelist を `@babel/types` の文法 alias から自動導出する
- ADR-0007: 内部ヘルパとモジュール内共有ヘルパは in-source testing、公開 API は `tests/` ツリーで分離する
- ADR-0008: 候補置換を mutate + revert (savepoint パターン) で実装し cloneAst を廃止
- ADR-0009: statement カテゴリ placeholder を `ExpressionStatement(Identifier("$Pn"))` 形にして `$Pn;` として可視化
- ADR-0018: 等価判定の保守化 — `inconclusive` verdict を追加し、`equal` は positive-evidence oracle があるときだけ
- ADR-0028: pruning 差分フィルタで差分サブツリー内のリテラルを保護
