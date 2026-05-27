# ADR-0028: pruning 差分フィルタで差分サブツリー内のリテラルを保護する

- **Status**: accepted
- **Date**: 2026-05-27
- **Related**: [ADR-0002](0002-babel-topdown-subtree-hash.md) (subtree-hash 差分フィルタ) / [ADR-0009](0009-statement-placeholder-visibility.md) (placeholder 可視化) / `research/research/pruning/notes/spike-literal-impact.md` (spike 実測) / `research/research/pruning/notes/result.md`

## コンテキスト

pruning の差分フィルタ (`mb-analyzer/src/pruning/common/candidates.ts` の `isCandidate`) は、
`SubtreeSet` で「fast に同型サブツリーが存在する共通ノードのみ」を wildcard 候補にし、差分ノードは
パターンの本質として必須扱いにする (研究計画 §第 1 段階)。

この共通判定は **subtree hash の集合メンバーシップ**で行うため、リテラルが**値で衝突**しやすい。
具体例 (Angular issue_5457, `key.substr(0, 2) !== '$$'` → `charAt` 2 回): 最適化の本質である
開始位置リテラル `0` が、fast 側の無関係な `charAt(0)` の `0` とハッシュ一致し「共通」と誤判定され、
wildcard 化されていた。`0` は load-bearing (開始位置が変われば substr↔charAt の等価性は崩れる) なのに
パターンから消えてしまう。

一方、`for (i = 0; i < 100000; i++)` の観測ハーネスのループ回数 `100000` のようなリテラルは
共通サブツリー (slow/fast 同一の harness) 内にあり、wildcard 化が**正しい** (パターンを特定回数に
固定してはいけない)。形 (shape) を抽出する目的で、前者を保護しつつ後者は一般化したい。

## 選択肢

- **A. リテラルを一切抽象化しない (blanket)**: 全リテラルを mandatory 扱いにし候補から外す。
- **B. 差分サブツリー内のリテラルのみ保護**: リテラルは「親ノードも共通」の時だけ wildcard 候補にする
  (= 差分ノード内のリテラルは値が衝突しても保護)。
- **C. 差分フィルタに 1:1 位置マッチング (本来の GumTree) を導入**: hash 集合判定をやめ、位置を考慮した
  対応付けにする根本解。

### 評価

| | A blanket | B 差分内のみ保護 | C 1:1 マッチング |
|---|---|---|---|
| load-bearing リテラル保護 | ○ | ○ | ○ |
| incidental リテラル一般化 (harness 回数) | **×** 固定してしまう | ○ | ○ |
| 実装局所性 | ○ | ○ (`isCandidate` のみ) | **×** 差分フィルタ全面改修 |
| 繰り返し式の衝突 (P2 型) も解決 | × | × | ○ |

spike 実測 (50 pruned candidate, `MB_PRUNE_PROTECT_DIFF_LITERALS=1`):
- B は等価判定不変 (pruned 50 / error 33)、node 数不変、リテラル placeholder 68→10、
  5457 で `0`/`2` が skeleton に定着しつつ `key` は wildcard 維持、4263 の harness 回数 `100000` は wildcard 維持。
- A は 4263 の `100000` 等を skeleton に固定 → 過度に具体的なパターン (spike で確認)。

## 決定

**B (差分サブツリー内のリテラルのみ保護)** を採用する。`isCandidate` で、ノード型がリテラル
(Numeric/String/Boolean/Null/BigInt/RegExp Literal) の場合に限り「親も共通ノード (`diff.has(parent)`)」を
追加条件とする。

主要な根拠:
- load-bearing リテラル (差分内) の保護と incidental リテラル (共通 harness 内) の一般化を、構造的文脈
  (親が共通か) で正しく弁別できる。spike で両ケースの正しい挙動を実測。
- 実装が `isCandidate` 1 箇所に閉じ、preprocessing 側の共有 `findChangedNodes` には波及しない。
- リテラルの essentiality (どのリテラルが前提条件か) の最終判定は後段の C4 (値の出自) に委ねる分業と整合。
  pruning は「load-bearing なリテラルを skeleton に残して材料を渡す」ところまでを担う。

## 結果 / 影響

採用によって得られるもの:
- 差分内リテラルが skeleton に残り、形検出の strict 率が改善 (10 パターン検証で 5/8 → 6/8、P5 `substr(0,2)` が ❌→✅)。
- 後段 C4 が load-bearing リテラルを skeleton から直接読める (placeholder を辿らずに済む)。
- wrap は 50/50 で 100% 維持 (リテラルが skeleton に移っても変更領域の捕捉は不変)。

諦めるもの・**既知の限界** (本 ADR では扱わない 2 件、いずれも「slow 側の構文形」だけでは捉えられず
before↔after の差分 (tree-diff/wrap 系) でしか救えない):

1. **繰り返し同型式の部分変更による衝突 (P2 型)**: 同じ式が複数回現れ一部だけ変更されると、変更された
   インスタンスが**未変更の生き残りとハッシュ一致**し「共通」と誤判定され wildcard される。
   例: EJS issue_136b は `str.substr(i, 1)` が 6 回出現し 5 回が `str[i]` に変更、1 回未変更で残存。
   差分フィルタは「fast のどこかに同型があれば共通」と見るため、変更された 5 個も残存 1 個と衝突して
   全部 wildcard 化され、骨格から消える。本 ADR のリテラル保護 (葉のみ) では式レベルの衝突は直らない。
   根因は差分フィルタが 1:1 対応を省略している点 ([ADR-0002](0002-babel-topdown-subtree-hash.md))。
   → 選択肢 C の領域。

2. **挿入型最適化 (fast が slow を完全にラップ)**: fast が slow を部分集合として丸ごと含み、変更が
   fast 側への純粋な追加であるケースでは、slow 側に差分ノードが 1 つも無いため全ノードが共通扱いで
   wildcard され、パターンが汎用的な制御構造の殻に退化する。
   例: Chalk issue_27a は fast = `arguments.length===1 ? arguments[0]+'' : (slowの式)` で slow を温存。
   slow 由来パターンは `var x = ?; if(?) return ?; ?` となり、「single-arg fast-path を足す」という
   最適化本体 (fast 側のみに存在) を表現できない。pruning のバグではなく「slow 側からパターンを抽出する」
   アプローチの構造的限界。

## トリガー (再検討の条件)

以下のいずれかが成立したらこの ADR を見直す:

- 繰り返し同型式の部分変更 (P2 型) が dataset 全体で無視できない頻度と判明 → 選択肢 C (1:1 位置マッチング)
  を別 ADR で起票。
- 挿入型最適化を「変更パターン」として表現する要件が出た → slow 単体でなく before↔after の差分を
  パターン化する方式 (tree-diff/wrap) を別 ADR で検討。
- リテラル保護が真に generalizable なリテラルまで過保護にしてパターンが冗長化する事例が出た。

トリガー発火時は新しい ADR を起票し、本 ADR は `superseded by ADR-NNNN` に書き換える。

## 補足

- 実装は `candidates.ts` の `isCandidate` に既定で組み込み済み (試験フラグ
  `MB_PRUNE_PROTECT_DIFF_LITERALS` は撤去)。環境変数なしの通常 `prune-batch` で本ルールが効く
  (issue_5457 で `substr(0, 2)` が骨格保持を確認)。canonical な `prune-results.jsonl` も本ルール適用済。
- 検証スクリプト・実測ログは `research/research/pruning/code/` (spike_literal_impact, compare_litfix,
  match_regex, match_ast) を参照。
</content>
