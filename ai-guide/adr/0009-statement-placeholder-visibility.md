# ADR-0009: statement カテゴリ placeholder の可視化 (`$Pn;` 形)

- **Status**: accepted
- **Date**: 2026-05-01
- **Related**: [`ADR-0006`](0006-grammar-derived-whitelist.md), [`ADR-0008`](0008-mutate-revert-replacement.md), [`code-map.md` §置換操作の粒度](../code-map.md#置換操作の粒度-3-カテゴリ統一のワイルドカード化)

## コンテキスト

第 1 段階 pruning は 3 カテゴリ (statement / expression / identifier) でノードを置換する。当初の置換戦略 (PR #2 までで確定) は次の通り:

| カテゴリ | 置換先 AST | `pattern_code` 上の見た目 | 機械処理での kind 判定 |
|---|---|---|---|
| identifier | `Identifier("$Pn")` | `$Pn` (引用符なし) | `node.type === "Identifier"` (binding 位置の文法制約と併用) |
| expression | `StringLiteral("$Pn")` | `"$Pn"` (引用符付き) | `node.type === "StringLiteral"` (一発判定) |
| **statement** | **`EmptyStatement`** | **`;`** | **判定不能** (元コード由来の `;` と同型) |

statement 置換だけが「人間可読性も機械処理も両方弱い」状態。`pattern_code` 上の `;` は元コード由来 (`for (;;)` の `;;` 等) と pruning 由来が区別不能で、`pattern_ast` 上でも `EmptyStatement` ノードは同型。`placeholders` メタデータと AST 走査順を突合しないと特定できず、第 2 段階 (C1〜C4 抽出器) の実装負担が増える。

PR #3 (CLI 化) の試作中にこの可視化問題が顕在化し、第 2 段階に進む前に統一形を決め直すことになった。

## 選択肢

- **A. 全面プレフィックス案**: 3 カテゴリを `VAR_n` / `EXPR_n` / `STMT_n` のような名前空間付き Identifier / StringLiteral に統一し、AST マッチを名前正規表現で行う
- **B. statement のみ Expression 化案**: statement 置換先を `ExpressionStatement(Identifier("$Pn"))` に変更、expression / identifier は現状維持
- **C. 現状維持 + メタデータ強化案**: AST はそのまま、`placeholders` 配列に `start_offset` / `end_offset` を追加して位置突合できるようにする
- **D. LabeledStatement 案**: `pn: ;` のように label 付き empty statement にして、label 名で識別

### 評価

| 観点 | A (全面プレフィックス) | B (statement のみ) | C (メタデータ強化) | D (LabeledStatement) |
|---|---|---|---|---|
| `pattern_code` 上の可視性 | ○ (全カテゴリ統一表記) | ○ (`$Pn;` で識別可) | × (`;` のまま) | ○ (`pn: ;`) |
| 機械処理での kind 判定 | △ (型判定 → 名前正規表現に劣化) | ○ (型 + 名前の 2 段判定) | × (位置突合が必要) | △ (`LabeledStatement` の label 抽出が必要) |
| `FastSubtreeSet` hash の安定性 | × (同 prefix 同連番だと衝突しうる) | ○ (識別性 unchanged) | ○ | △ (label のみ違う形が増え hash 種類が増える) |
| `break/continue label` との衝突 | ○ (Identifier / StringLiteral だけ) | ○ | ○ | × (JS の label 名前空間と重なる) |
| 既存契約 (`PruningInput` / `PruningResult`) への影響 | ○ (kind ラベルのみ) | ○ (kind ラベルのみ) | × (新フィールド追加 → 互換性 break) | ○ |
| 第 2 段階抽出器の実装負担 | △ (型 → 名前正規表現に変えるだけ大きい) | ○ (型ベース判定が拡張可能) | × (位置突合が必要) | △ |

機械処理の identifier / expression は **型 1 段判定** (現状) が最も筋が良く、これを崩す A は不採用。C は契約を壊し、D は JS の label 名前空間と衝突するため不採用。**B (statement のみ Expression 化)** が「expression / identifier の機械処理ファースト性を維持しつつ statement の可視化問題だけ解消」する最小変更。

## 決定

**B** を採用する。statement カテゴリの置換先を `ExpressionStatement(Identifier("$Pn"))` に変更し、`pattern_code` 上で `$Pn;` として可視化、`pattern_ast` でも 2 段の型判定で識別可能にする。expression / identifier の現状方式 (StringLiteral / Identifier) は機械処理ファースト設計として維持。

`placeholders` 配列のメタデータ構造 (`{id, kind, original_snippet}`) は不変。`PruningInput` / `PruningResult` のスキーマも不変。**Python 側 (`mb_scanner/domain/entities/pruning.py`) との JSON 契約は破らない**。

## 結果 / 影響

採用によって得られるもの:

- **可視化**: `pattern_code` 上で statement placeholder が `$Pn;` として一目で分かる。第 2 段階デバッグ時のログ可読性が大きく上がる
- **機械処理**: 第 2 段階抽出器 (C1〜C4) は `node.type === "ExpressionStatement" && node.expression.type === "Identifier" && /^\$P\d+$/.test(node.expression.name)` の 2 段判定で statement placeholder を特定できる。`placeholders` 配列との突合に頼らなくてよい
- **3 カテゴリの統一感**: 全カテゴリで「`$Pn` 命名 + 文法的に valid な AST ノード」になり、design の対称性が増す

諦めるもの・将来のコスト:

- **円形再帰の risk**: 新置換先 `ExpressionStatement(Identifier("$Pn"))` は **statement カテゴリ自身**なので、次反復で再候補化されると pruning ループが破綻する (placeholder を別 placeholder に置き換える)。これを防ぐため `candidates.ts:isPlaceholderNode` で `Identifier($Pn)` と `ExpressionStatement(Identifier($Pn))` の 2 形を 1 段目フィルタで除外する。drift 防止のため `PLACEHOLDER_NAME_PATTERN = /^\$P\d+$/` を `replacement.ts` で 1 箇所定義し `candidates.ts` から再利用する
- **元コード衝突の判別不能性**: ユーザーコードに `$P0` という Identifier があれば、AST 上は pruning 由来 placeholder と区別不能になる。`engine.prune()` は parse 直後に walk して該当 Identifier があれば stderr に warning を出すが、pruning 動作は変えない (誤判定 risk はユーザー責任で許容)
- **既存テスト fixture の更新**: `pattern_code` 期待値を持つ test fixture (PR #3 の CLI integration test 等、本 PR の merge 後に rebase 予定) で `;` を `$P0;` 形に書き換える必要がある。本 PR では engine 側 in-source / `tests/pruning/engine.test.ts` で完結するが、並行 PR との rebase 計画 (TODO.md) で吸収

## トリガー (再検討の条件)

以下の条件のいずれかが成立したらこの ADR を見直す:

- **第 2 段階抽出器が `pattern_code` 文字列ベースのマッチに依存し始めた**: 文字列上での `$Pn` regex 抽出に統一する案 (A 全面プレフィックス) のメリットが上回る
- **JS 以外の言語 (TS / Python 等) を pruning 対象に追加**: 言語ごとに `ExpressionStatement(Identifier(...))` 相当の表現が定義可能か検討が必要。新言語で同等の構文が組めない場合、カテゴリ別に置換戦略を分岐させる必要が出る
- **`PLACEHOLDER_NAME_PATTERN` の名前規則を変える要件**: 現状 `/^\$P\d+$/` で 1 箇所定義しているが、`__PLACEHOLDER_n__` 等の別形式に変える場合は `replacement.ts:sanitizeIdentifier` と `candidates.ts:isPlaceholderNode` を paired-change

## 補足: 再候補化防止フィルタの実装位置

`candidates.ts:isCandidate` の入口に置く:

```ts
function isCandidate(node, parent, parentKey, blacklist, diff): boolean {
  if (isPlaceholderNode(node)) return false; // 1 段目: ADR-0009
  // ... 既存の whitelist / blacklist / diff フィルタ
}

function isPlaceholderNode(node): boolean {
  if (node.type === "Identifier") {
    return PLACEHOLDER_NAME_PATTERN.test(node.name);
  }
  if (node.type === "ExpressionStatement") {
    const expr = node.expression;
    if (expr.type === "Identifier") {
      return PLACEHOLDER_NAME_PATTERN.test(expr.name);
    }
  }
  return false;
}
```

`Identifier($Pn)` の判定が両形 (statement の inner と identifier カテゴリの単独) の placeholder を兼ねて除外することで、外側 `ExpressionStatement` フィルタとの組み合わせで「statement 全体 / 内側 Identifier / 単独 Identifier」の 3 経路すべてを 1 段で塞ぐ。
