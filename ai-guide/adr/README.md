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
