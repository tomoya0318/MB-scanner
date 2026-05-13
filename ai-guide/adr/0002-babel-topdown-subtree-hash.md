# ADR-0002: AST 差分判定に Babel + top-down subtree hash を自作する

- **Status**: accepted
- **Date**: 2026-04-23
- **Related**: PR #8, [ADR-0001](0001-pruning-ast-traversal.md), [ADR-0003](0003-bottom-up-mapping-deferred.md)

## コンテキスト

Hydra 式 pruning の第 1 段階は「slow ノード N について、fast に同じサブツリーが存在するか」を判定する差分フィルタ。ground truth の AST 差分アルゴリズムとして GumTree (Falleri+ ASE 2014) があるが、本研究の要件は:

- **入力**: (slow, fast) のソースコードペア (関数単位 / ファイル単位で小さい)
- **出力**: slow の各ノードが fast の部分木として存在するかの boolean
- **速度**: OSS 適用フェーズで数千〜数万ペアを処理するため、1 ペアあたり ms オーダに抑えたい
- **環境**: Python + Node.js (`mb-analyzer`) で完結させたい

## 選択肢

- **A. Babel + top-down subtree hash を自作**: `@babel/types` の VISITOR_KEYS で走査しハッシュ一致で common/diff を判定。GumTree の top-down phase (Falleri+ 2014 §4.1) 相当
- **B. GumTree Docker + 位置ブリッジ**: 既存の Java 実装 (refdiff/gumtree) を Docker で呼び出す。PM25 研究での実績あり
- **C. 既存の npm AST-diff ライブラリ**: `astdiff`, `jsparser` など。多くは star 数一桁で保守されていない

### 評価

| 軸 | A (自作) | B (GumTree Docker) | C (npm 既存) |
|---|---|---|---|
| 実装コスト | ~350 行、1〜1.5 日 | ~580 行 (配管のみ)、2〜2.5 日 | 低 (組み込むだけ) |
| 実行時間 (1 ペア) | ~2ms | ~200〜500ms | 不明 (測定困難) |
| 追加依存 | Babel 系パッケージのみ | Java + Docker | ライブラリ次第 |
| ESTree (ts-eslint 連携) 互換 | 直接互換 | 位置座標のブリッジが必要 | 非互換が多い |
| 保守性 | 自前、仕様は自分で握る | 外部実装の挙動に依存 | 保守停止リスク大 |
| テスト容易性 | 決定論的で単体テスト可能 | Docker 依存で CI が重い | 実装内部が見えにくい |

## 決定

**A (Babel + top-down subtree hash を自作)** を採用。主要な根拠:

- 実行時間が B の 100 倍以上速い (OSS 数千〜数万ペア適用フェーズで効いてくる)
- Java / Docker 依存が不要で CI がシンプルになる
- ts-eslint (ESTree) と直接互換なので下流段階 (パターン → ルール生成) への連携が自然
- top-down phase だけなら決定論的でテストしやすい
- C はそもそも使える成熟品がない

## 結果 / 影響

**得るもの:**
- 軽量 (`@babel/*` だけ) で Python ↔ Node 配管に収まる
- ~2ms/pair で pruning を回せる見込み
- `FastSubtreeSet.has` が単純な API で提供できる

**諦めるもの:**
- GumTree の bottom-up phase (リネーム検出) は別途検討 ([ADR-0003](0003-bottom-up-mapping-deferred.md))
- 論文で "GumTree そのものを使った" とは主張できない (自前実装である旨を明記する必要)

## トリガー (再検討の条件)

- 自前実装の保守負担が大きくなった (コア走査で頻繁にバグを踏む等)
- ESTree 互換の成熟した AST diff ライブラリが登場した
- 処理速度の要件が緩和され、GumTree Docker でも問題なくなった (大規模評価が不要になった等)

## 補足

論文での位置づけは **"Babel AST 上で GumTree top-down phase (Falleri+ 2014 §4.1) を実装"** として §3 に記述する。自作部分が小さく、top-down の定式化自体は既存研究に乗る設計。

参考文献:
- Falleri et al., *Fine-grained and Accurate Source Code Differencing*, ASE 2014. https://hal.science/hal-01053102/
- TOSEM 2024 — GumTree の誤マップ率 20〜36% の報告: https://arxiv.org/html/2403.05939
