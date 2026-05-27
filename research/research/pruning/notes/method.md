# pruning 結果検証: 手法

対象スナップショット: main @ `17bb101` (順 3-2 server strategy merge 後)。
入力 jsonl は `research/research/preprocess_workload_reachability/code/` の確定結果を参照
(`extracted` / `equiv-input` / `equiv-results` / `prune-input` / `prune-results`)。

検証したいこと (precondition = いつ適用してよいかは対象外、**形 (shape) のみ**):

1. **段階別の脱落**: 論文 10 最適化パターンの各 issue が pipeline のどこで落ちるか
2. **形の抽出可否**: pruned `pattern_code` に各パターンの before-shape が残っているかを、
   静的手法 (regex / AST tree-match) で検出できるか

## 1. 段階分析 (`stage_funnel.py`)

各 issue を 4 ステージで追跡し、最初に脱落した段を判定する。

| ステージ | ファイル | 通過条件 | 脱落理由の出所 |
|---------|---------|---------|------|
| 前処理後 | extracted.jsonl | issue が抽出され candidate ≥1 | `issue_excluded` / `candidate_excluded` |
| 射影後 | equiv-input.jsonl | candidate が small-candidate として残る | build_equiv_input の reachability/小ささ判定 |
| 等価判定後 | equiv-results.jsonl | issue verdict == `equal` | not_equal / error は pruning に進まない |
| pruning 後 | prune-results.jsonl | candidate が `pruned` | pruning error / initial_mismatch |

issue 単位 verdict は equal>not_equal>inconclusive>error の優先で集約。

## 2. 形検出 (`match_regex.py` = Backend A, `match_ast.mjs` = Backend B)

### パターン → issue 対応と before-shape 定義

`pattern_map.py` に集約 (10 パターン、Description.md ベースで対応 issue を列挙)。
各パターンの **before 側の形**を 2 表現で定義:

- **regex** (`pattern_map.PATTERNS[n]["regex"]`): 例 P8 `%\s*2\b`、P9 `\.reduce\s*\(`、
  P1 `for\s*\(...in\b`
- **AST セレクタ** (`match_ast.mjs` の `MATCHERS[n]`): 例 P8 `BinaryExpression(op='%', right=Numeric 2)`、
  P9 `CallExpression(callee.property='reduce')`、P1 `ForInStatement`

### strict / loose の2粒度

pattern_code は placeholder (`$P1` 等) でオペランドが抽象化される。形がどこに残るかで2粒度:

- **strict (骨格)**: 生 `pattern_code` だけにマッチ = pruning が形を**構造として保持**
- **loose (骨格∪フル展開∪各スニペット)**: skeleton に加え、placeholder を戻したフル展開コードと
  各 placeholder の `original_snippet` のいずれかにマッチ = pruning が**保持した断片のどこかに形がある**

loose を 3 系統 OR にする理由:
- フル展開は naive な文字列置換で連結が崩れ **parse 不能**になることがある (例 EJS 136b の `};else if`)。
  AST はその場合パースできず取り逃すため、**valid 断片である placeholder スニペット**で救済する。
- 形が skeleton と複数 placeholder に**分割**される場合 (例 P5 `substr(0,2)` の `0`/`2` が別 placeholder)、
  スニペット単体では復元できずフル展開でのみ拾えるため、フル展開も含める。

### バックエンドの違い (設計)

- **regex (Backend A)**: テキストに直接マッチ。parse 不要で頑健だが、文字列リテラル内のコードや
  壊れたコードにも当たりうる (精度は劣る)。
- **AST (Backend B)**: `@babel/parser` (mb-analyzer と同じ) でパースし visitor で判定。
  `$P\d+` は parse 前に正規識別子へ退避。文字列内・コメント内の誤検出を排し、入れ子・引数値などの
  構造条件を厳密に書けるが、**parse 可能な入力が前提**。

## 注意・限界

- パターンあたり issue は 1〜6 件と小さく、「静的検出できるかの存在証明」と位置づける (統計的主張はしない)
- P4 (`.html('')`) と P7 (`toString.call`) は pruned `pattern_code` が無く、形検証は不可
  (段階分析で落ちどころを示す)
- 入力 jsonl は再走で上書きされうる。本結果は `17bb101` 時点のスナップショット
</content>
