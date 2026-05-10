# ADR (Architecture Decision Records)

「なぜ A を選び B を選ばなかったか」を記録する。ai-guide 4 軸のうち **Decisions** を担う (他軸との住み分けは [`doc-strategy/index.md`](../doc-strategy/index.md) を参照)。

## 住み分け

| 書きたい内容 | 置き場所 |
|---|---|
| 必ず守ってほしいルール (契約) | `architecture/` |
| 手順 / 検証方法 | `quality-check/` |
| 実装の意味論・データフロー | `code-map.md` |
| 設計判断の採用理由と却下した選択肢 | **`adr/` ← ここ** |
| 日付軸のマイルストーン | `TODO.md` |

**矛盾したときは architecture/ が正** (契約が優先)。ADR は採用判断の根拠を残すだけで、契約自体は architecture/ 側に反映する。

## 判断基準: ADR に書くか、普通のコメントで済ますか

| 基準 | ADR | コード comment |
|---|---|---|
| 却下した選択肢がある | ✓ | — |
| 将来条件が変われば覆る可能性がある | ✓ | — |
| 複数ファイルをまたぐ判断 | ✓ | — |
| その関数 / ファイル限定の自明な工夫 | — | ✓ |
| 関数の使い方 (契約) | — | JSDoc |

迷ったら: **「読み手が *変える* か、*使う* か」**。変えるなら ADR、使うなら JSDoc。

## ファイル命名

`NNNN-<short-slug>.md` (連番 4 桁 + 英小文字ケバブ)。例: `0001-pruning-ast-traversal.md`

連番は **merge 順** で採番する。同時期に複数 ADR を書いている場合、先に merge された方が若い番号を取る。競合したら renumber。

## ステータス

| Status | 意味 |
|---|---|
| `proposed` | 提案中、まだ採用されていない |
| `accepted` | 採用済み (現行の判断) |
| `deprecated` | 古い判断。コード上はまだ残っているが新規コードには適用しない |
| `superseded by ADR-NNNN` | 新しい ADR に置き換えられた |

ステータス変更時は旧 ADR の先頭行を書き換えるだけで、本文は履歴として残す。

## コード側からの参照

ソースコードで ADR を指すときは **1 行のポインタ** に絞る:

```ts
// 判断: ai-guide/adr/0001-pruning-ast-traversal.md
export function collectSubtreeHashes(file: File): Set<string> { ... }
```

`// 判断: ...` という prefix で検索可能にしておくと、ADR との交差参照が追いやすい。JSDoc には **採用理由や却下した選択肢の話を書かない** (コード comment は「この関数を使う人」向けの情報に絞る)。

## テンプレート

新規 ADR 作成時は [`TEMPLATE.md`](TEMPLATE.md) をコピーする。

## 索引

<!-- 連番順に追記。ステータスが変わったら書き換える -->

| # | タイトル | ステータス | 対象領域 |
|---|---|---|---|
| [0001](0001-pruning-ast-traversal.md) | pruning の AST 走査に VISITOR_KEYS 再帰を採用 | accepted | `mb-analyzer/src/pruning/` |
| [0002](0002-babel-topdown-subtree-hash.md) | AST 差分判定に Babel + top-down subtree hash を自作 | accepted | `mb-analyzer/src/pruning/` |
| [0003](0003-bottom-up-mapping-deferred.md) | bottom-up mapping を第 2 段階以降に遅延 | accepted | `mb-analyzer/src/pruning/` |
| [0004](0004-pruning-setup-single.md) | PruningInput.setup を単数 string にする | accepted | `mb-analyzer/src/contracts/pruning-contracts.ts`, `mb_scanner/domain/entities/pruning.py` |
| [0005](0005-grammar-derived-blacklist.md) | pruning 候補 blacklist を `@babel/types` の文法メタデータから自動導出する | accepted | `mb-analyzer/src/pruning/rules/blacklist.ts` |
| [0006](0006-grammar-derived-whitelist.md) | pruning 候補 whitelist を `@babel/types` の文法 alias から自動導出する | accepted | `mb-analyzer/src/pruning/rules/whitelist.ts` |
| [0007](0007-in-source-testing-internal-helpers.md) | 内部ヘルパとモジュール内共有ヘルパは in-source testing、公開 API は `tests/` ツリーで分離する | accepted | `mb-analyzer/` |
| [0008](0008-mutate-revert-replacement.md) | 候補置換を mutate + revert (savepoint パターン) で実装し cloneAst を廃止 | accepted | `mb-analyzer/src/pruning/engine.ts` |
| [0009](0009-statement-placeholder-visibility.md) | statement カテゴリ placeholder を `ExpressionStatement(Identifier("$Pn"))` 形にして `$Pn;` として可視化 | accepted | `mb-analyzer/src/pruning/{rules/replacement.ts,candidates.ts,engine.ts}` |
| [0010](0010-preprocessing-enclosure-3-tier.md) | Selakovic 前処理器の enclosure 候補型に 3 段優先順位 (関数 / Block / Top-level statement) を採用 | accepted | `mb-analyzer/src/preprocessing/common/enclosure.ts` |
| [0011](0011-preprocessing-tier-structure.md) | preprocess を Tier 1 (汎用 AST diff) + Tier 2 (Selakovic adapter = 段1 役割分解: `<lib>_*.js` ペア dir scan + `f1`/`test` body 抽出 + 計測ハーネス除去 / 段2 作用点ルーティング A·B·A+B) の二層に分ける | accepted (Phase 1.0 スパイクで実証) | `mb-analyzer/src/preprocessing/{common,selakovic}/` |
| [0012](0012-equivalence-checker-execution-environment.md) | 等価検証の実行環境を jsdom+vm 主軸 + Playwright fallback にする (Phase 1.0 で前提実証: AngularJS 665KB の jsdom load 込みで代表 7 件動作 / fallback は 97 件実走で 0 発火 → 扱いを Phase 2b で決定) | proposed (実行主軸は検証済 / accepted は Playwright fallback の扱いを書き込んだ時点 — `tmp/phase2b-adr-assumption-audit.md` §C-1) | `mb-analyzer/src/equivalence-checker/sandbox/` |
| [0013](0013-equivalence-operational-definition.md) | 「意味論的等価」= 計算結果 + 観測可能な副作用 + workload↔SUT の interaction trace (C6); timing/反復回数/stack/同期後の非同期タスクは非観測 | proposed (定義は確定 / accepted は C6 の汎用 Proxy wrap spike 完了時 — 監査 §B-3/§D-3) | `mb-analyzer/src/equivalence-checker/` |
| [0014](0014-case-split-for-both-changed.md) | inline+lib 両方変化した issue は identifier 交差判定で independent なら 2 candidate に分割する (件数は Phase 2a で再カウント) | accepted (Phase 1.0 で実証) | `mb-analyzer/src/preprocessing/selakovic/index.ts` |
| [0015](0015-equivalence-checker-layering-and-dom-oracle.md) | equivalence-checker を common (dataset 非依存) + selakovic adapter に二層化し、DOM oracle (C2) と interaction-trace oracle (C6) を common 側 primitive として実装する + adapter config | proposed (構造は確定 / accepted は C6 spike 完了時 — 監査 §D-3) | `mb-analyzer/src/equivalence-checker/` |
| [0016](0016-equivalence-sandbox-sut-dependency-resolution.md) | 等価検証 sandbox の SUT module 依存解決を vendor 方式にする (stub/install は使わない) + require shim の二段解決 | proposed (方式は確定 / accepted はレビュー合意時 — 4 lib の dep tree 列挙 chore は前提ではない) | `mb-analyzer/src/equivalence-checker/sandbox/` |
| [0017](0017-equivalence-sandbox-pre-execution-transforms.md) | 等価検証 sandbox の実行前 transform = 非決定性 API の固定 + iteration-cap (loop bound の AST clamp、preprocess には焼き込まず `{N\|null}` で parameterize) | proposed (accepted はレビュー合意時 — 検証 phase 不要) | `mb-analyzer/src/equivalence-checker/sandbox/stabilizer.ts` |
