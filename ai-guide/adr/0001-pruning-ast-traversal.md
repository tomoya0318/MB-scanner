# ADR-0001: pruning の AST 走査に VISITOR_KEYS 再帰を採用する

- **Status**: accepted
- **Date**: 2026-04-23
- **Related**: PR #8 (`feat/hydra-pruning-diff`), [ADR-0002](0002-babel-topdown-subtree-hash.md)

## コンテキスト

Hydra 式 pruning で (slow, fast) AST の全サブツリーを走査する必要がある。Babel AST を走査する選択肢は以下:

- `@babel/traverse` を使う (Babel 標準)
- `@babel/types` の `VISITOR_KEYS` を直接使い、自分で再帰する

判断時点で `@babel/traverse` が提供する機能 (NodePath、enter/exit フック、scope 解析、parent 追跡) のうち、pruning で必要なのは子ノード列挙だけ。

## 選択肢

- **A. `@babel/traverse`**: Babel 標準。NodePath / enter/exit / parent 追跡 / scope 解析を提供。エコシステム標準で広く使われる。
- **B. `VISITOR_KEYS` で自前再帰**: 50 行程度の薄い再帰。子ノードの列挙だけに特化。依存追加なし (`@babel/types` は他でも使う)。

### 評価

| 軸 | A (@babel/traverse) | B (VISITOR_KEYS 自前再帰) |
|---|---|---|
| 必要な機能 | 大半が未使用 | 必要十分 |
| 実装行数 | ほぼゼロ (ライブラリ呼び出しのみ) | ~50 行 |
| 依存の追加 | `@babel/traverse` 追加 | 不要 |
| 実行コスト | NodePath 構築のオーバーヘッド (定性) | 関数呼び出しだけ |
| 親ノード / scope への参照 | 可能 | 不可 (必要になった時点で破綻) |

## 決定

**B (VISITOR_KEYS で自前再帰)** を採用。主要な根拠:

- pruning で必要なのは「子を辿る」だけで、NodePath の機能はどれも使わない
- 追加依存を避け、`@babel/types` 単体で完結させる
- 実装が短いので保守負担も小さい

## 結果 / 影響

**得るもの:**
- 依存が最小 (`@babel/types` のみで AST 走査と hash 計算が完結)
- NodePath の構築コストを払わない

**諦めるもの:**
- enter/exit フック、親ノード参照、scope 解析が必要になった場合に自分で実装する必要がある
- Babel の traverse API に慣れた人が読むと独自実装に見える

## トリガー (A に切り替える条件)

以下のいずれかが成立したら本 ADR を見直す:

- pruning エンジン本体で enter/exit フックや NodePath.parent への参照が必要になった
- scope 解析 (例: 変数がどのスコープで宣言されたか) を使った候補除外が必要になった
- 実測で自前再帰がボトルネックと判明した (ベンチマーク必要)

トリガー発火時は新しい ADR を起票し、本 ADR を `superseded by ADR-NNNN` に書き換える。

## 補足

- 本判断時点でパフォーマンス比較の実測は行っていない。「NodePath 構築がオーバーヘッド」は定性的推測であり、必要性が出てから計測する。
- `canonicalHash` も同じく VISITOR_KEYS を使っているので、`collectSubtreeHashes` と走査方式を揃えることで実装の一貫性が取れる。
