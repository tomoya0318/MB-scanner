# ADR-0027: changed-fn rename-only 救済の collision guard (scope-aware rename 不採用)

- **Status**: accepted
- **Date**: 2026-05-18
- **Related**: [ADR-0023](0023-preprocess-placeholder-substitution.md) (D-γ §DROP 可視化緩和の文脈) / PR #22 / `tmp/0036_d-gamma/phase3-roadmap.md` §順 1-b

## コンテキスト

ADR-0023 D-γ §順 1-b で `buildChangedFnCandidate` の param 名一致チェックを緩和し、「本数・順序・pattern shape が一致 + Identifier name のみ差」のとき before fn body を after の param 名で identifier-rename して candidate 化する経路を加えた。brain-2 baseline で 3 candidate が `fn-param-names-mismatch` で DROP されていたので、それを救済する目的。

問題は、identifier rename を **scope-aware ではない文字列ベース** で実装したこと。`renameIdentifiersInStatements` は body 内で「rename 元名」と一致する Identifier を全て書き換える (プロパティ名側 Identifier は除外)。これは body 内に同名の別 binding (catch param / inner fn の var / class の id 等) があると semantic を壊す可能性がある。

例 (現実装が壊すケース):
```js
function outer(x) {                          // x → y rename したい
  try { throw 0; } catch (y) { return y + x; }
}
// 元: catch y = 0, return 0 + 引数
// rename 後 (現実装): function outer(y) { try { throw 0; } catch (y) { return y + y; } }
//   catch y = 0, return 0 + 0 = 0  ← semantic 変わる
```

D-γ §DROP 可視化緩和の目的は「真の candidate 件数を増やす」ことなので、間違った candidate (false-positive) を出すのは本末転倒。安全弁の方針を決める必要がある。

## 選択肢

- **A. collision guard 強化**: body 内に「rename 元 / 先のどちらかと同名の binding」があれば、現状通り `FN_PARAM_NAMES_MISMATCH` marker にデモートする。検出対象 binding 種別を `VariableDeclarator.id` / inner fn (`FunctionDeclaration|FunctionExpression|ArrowFunctionExpression`) の id・params に加え、`CatchClause.param` / `ClassDeclaration.id` / `ClassExpression.id` まで広げる。検出名集合も `nameMap.values()` (= 先名) に加えて `nameMap.keys()` (= 元名) を含める。
- **B. binding 位置を skip**: `renameIdentifiersInStatements` を変更し、binding 位置 (`VariableDeclarator.id` / function/class id / params / catch param 等) の Identifier は書き換えないようにする (= reference 位置だけ書き換え)。
- **C. scope-aware rename (α-conversion)**: 各 identifier 参照について「どのスコープで宣言された binding を指しているか」を追跡し、「outer param へ tied な reference」だけを正確に書き換える。`@babel/traverse` の `Scope` API か自前 scope analyzer を導入。

### 評価

| | A: collision guard 強化 | B: binding 位置 skip | C: scope-aware rename |
|---|---|---|---|
| 実装コスト | 低 (`hasBindingCollision` に case 追加 + test) | 中 (rename 側に skip ロジック + test) | 高 (scope analyzer 一式 + dep 検討) |
| 依存追加 | なし | なし | `@babel/traverse` 検討 or 自前実装 |
| false-positive (semantic 壊す candidate) | ゼロ | **発生** (下記補足) | ゼロ |
| false-negative (本当は safe な fn を諦める) | あり (実害は brain-2 3 件で評価) | あり (binding 含む場合) | ゼロ |
| 他経路への再利用性 | 低 (本 helper 専用) | 低 (本 helper 専用) | 高 (raw-stmt / angular 経路でも再利用可) |
| 将来 (C) への移行コスト | 低 (guard を緩めるだけ) | 中 (rename ロジックも改修) | — |

B の落とし穴: 「binding 位置を skip」だけだと、`var` hoisting で却って壊れる。例: `function outer(x){ var x = 1; return x; }` で `x → y` rename したとき、B では `var x = 1; return y;` になる (binding `var x` の x を skip、reference `return x` の x だけ rewrite)。結果 `var x` は unused 別 binding、`return y` は param y への参照、戻り値 = 引数。一方、元コードは `var x` で param x が 1 に上書きされて戻り値 = 1。**semantic が逆方向に壊れる**。binding 含めて全部 rewrite すれば semantic 保たれる (`var y = 1; return y;` で param y を上書き、戻り値 = 1) ので、A (= 「壊れそうなら諦める」) の方が安全側に倒れる。

## 決定

**A. collision guard 強化** を採用する。

主要な根拠:

- D-γ §順 1-b の目的は救済件数の純増 (false-positive ゼロが前提)。A は false-positive をゼロに保てる
- 実装規模が小さく本 PR (PR #22) に収まる。Phase 3 Round 1 のタイミングを崩さない
- B は表面的な解で `var` hoisting ケースで逆方向の壊れが発生するため不採用
- C は完全解だが scope analyzer 導入が別 PR 規模。preprocess 全体で identifier rewrite を扱う場面が増えたら再検討する
- 救済目標 3 件に対し、catch / class 等の複雑な shadow が混じる可能性は低い (typical な lib fn body は単純な計算式)。false-negative の実害は限定的と判断

採用する具体仕様:

- `hasBindingCollision` の検出対象 binding 種別:
  - `VariableDeclarator.id` (`var/let/const`)
  - `FunctionDeclaration.id` / `FunctionExpression.id`
  - inner fn (`FunctionDeclaration` / `FunctionExpression` / `ArrowFunctionExpression`) の params (`Identifier` / `RestElement(Identifier)` / `AssignmentPattern(Identifier)`)
  - `CatchClause.param` (`Identifier` の場合のみ — `ObjectPattern` 等はそもそも rename-only に該当しない)
  - `ClassDeclaration.id` / `ClassExpression.id`
- 検出名集合: `nameMap.values()` ∪ `nameMap.keys()` (rename 元名・先名どちらと一致しても collision 扱い)
- scope の境界は無視 (block / catch / inner fn の中にあっても全て同列に collision として扱う = 保守側)

## 結果 / 影響

採用によって得られるもの:

- changed-fn 経路で生成される candidate は scope-aware ではない rename を含むが、false-positive ゼロが保証される (collision を検出したら従来通り marker にデモート)
- 実装が本 PR に閉じ、ADR-0023 D-γ §順 1-b の目的 (救済 +3) を Phase 3 Round 1 のタイミングで達成できる
- 将来 (C) に移行する際は、`renameIdentifiersInStatements` 内部を scope-aware に差し替えて `hasBindingCollision` の検出範囲を狭めるだけで段階的に拡張できる

諦めるもの・将来のコスト:

- 本当は rename しても safe だった fn (例: catch (y) があっても closure 越しの参照が無いケース) も marker にデモートされるため、救済件数の上限がスコープ解析の精度に縛られる
- 他経路 (raw-stmt / angular 経路) でも identifier rewrite が要るようになった時、collision guard の case 列挙が複数箇所に分散しがちになる。その時点で (C) への移行を検討する

## トリガー (再検討の条件)

以下の条件のいずれかが成立したらこの ADR を見直す:

- 本 collision guard で `fn-param-names-mismatch` の救済件数が Phase 3 救済目標 (3 件) を割る
- raw-stmt / angular 経路など他 strategy でも identifier rewrite が要るようになり、scope-aware rename の必要性が複数経路で立つ
- `@babel/traverse` を他用途で導入する判断が下り、`Scope` API が手の届く範囲に入る

トリガー発火時は新しい ADR を起票し、本 ADR は `superseded by ADR-NNNN` に書き換える。

## 補足

scope-aware rename を採るときの参考実装:

- `@babel/traverse` の `path.scope.rename(oldName, newName)` が `Scope.rename` API を提供。binding 解析・closure 越しの reference 解決まで内蔵
- 自前で書く場合は `function` / `block` / `catch` / `with` / `class static block` をスコープ境界として scope stack を持ち、各スコープで `var` (function scope) と `let/const/class` (block scope) を区別して binding を declare、reference 側は inner-most な declare を引く

`var` hoisting の不採用根拠 (= B 案の落とし穴) の詳細例は `tmp/0001_param-name-relax/plan.md` §レビュー観点 (Copilot review への応答) を参照。
