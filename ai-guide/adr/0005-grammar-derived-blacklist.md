# ADR-0005: pruning 候補 blacklist を `@babel/types` の文法メタデータから自動導出する

- **Status**: accepted
- **Date**: 2026-04-24
- **Related**: PR (feature/hydra-pruning-engine), `mb-analyzer/src/pruning/rules/blacklist.ts`, `mb-analyzer/src/pruning/candidates.ts`, ADR-0001

## コンテキスト

第 1 段階 pruning の候補フィルタ L1 (親子位置 blacklist) をどう実装するかの判断 (`ai-guide/code-map.md` §Pruning エンジン)。L1 は **親 field validator が置換後の型を受理しない位置** — 例えば `ForInStatement.left` は LVal 位置なので `StringLiteral("$P0")` による Expression 置換は文法的に不正 — を候補から除外することで、L2〜L4 の試行コストを削減するのが役割。

pruning engine 初期実装 (PR #8) では、この L1 blacklist を Selakovic 2016 の 10 パターンで出現する構文を見ながら親 × 子位置を Map で直接列挙する形で書き下していた。ただし以下 3 つの懸念が merge 後レビューで顕在化した:

- **Dataset leak**: Selakovic dataset を見ながら絞ったので、評価データの情報が methodology 側に漏れている (論文 validity threat)。reviewer に "does your blacklist encode dataset knowledge?" と問われたら defensive な回答になる
- **漏れのリスク**: destructuring LVal (`RestElement.argument`, `ArrayPattern.elements`, `ObjectPattern.properties`) 等、Selakovic パターン外の「文法上 Expression を受理しない位置」が列挙漏れになり、本来不要な候補が L2〜L4 まで到達して試行コストを払う
- **保守性**: Babel の新構文追加 (新 TypeScript 構文など) があると手動で追記が必要

本 ADR は上記を踏まえて L1 blacklist の実装戦略を決め直す。

## 選択肢

- **A. 手書き列挙を継続**: 親 × 子位置の Map を手で列挙し、Selakovic パターン外の位置は必要になったら逐次追記
- **B. 文法メタデータから自動導出**: `NODE_FIELDS[parent][key].validate` の introspection (`oneOfNodeTypes` / `chainOf` / `NODE_UNION_SHAPES__PRIVATE`) から起動時に 1 回だけ blacklist を計算する
- **C. L1 blacklist を持たない**: 候補フィルタは whitelist (`WHITELIST_CATEGORIES`) + diff + L3 round-trip 検証のみに任せ、静的除外を諦める

### 評価

| 軸 | A (手書き) | B (文法由来) | C (削除) |
|---|---|---|---|
| Dataset leak (論文 validity) | ❌ あり | ✅ なし | ✅ なし |
| 第 1 段階の「消しすぎない」原則 | ✅ | ✅ | ❌ (L3/L4 偶発通過で過剰 wildcard 化) |
| 第 3 段階 ablation の解釈 | — | clean | 複雑 (余剰 wildcard 分が混入) |
| 網羅性 (destructuring LVal 等) | 漏れあり | ✅ 自動網羅 | 不要 |
| 保守性 (Babel 追随) | 手動 | 自動 | 不要 |
| 論文主張の強さ | 弱 (defensive) | **強 (Babel 文法由来)** | 中 (layer で担保) |
| 実装コスト | 最小 | 中 | 小 |

C 案は第 1 段階の "消しすぎない" 原則を壊す: L3 round-trip は文法的に不正な置換しか弾けず、意味論的に不適切な置換 (LVal 位置を Expression wildcard で置換したが L4 で偶発的に等価判定されてしまうケース) が残る。結果として第 1 段階で過剰 wildcard 化が起き、第 3 段階 ablation が「precision 補正分」と「本来必要だった構造を戻す分」の二重構造になって解釈しづらくなる (`ai-guide/current-research.md` §Unsoundness の緩和 の二段構造を尊重)。

### 方式 B の内部選択肢: 許容型集合の抽出方法

方式 B の実装には更に 2 通りの技術選択がある:

- **B-A. 型 introspection**: `validate.oneOfNodeTypes` / `chainOf` / `unionShape` の property を直接読む。純粋関数
- **B-B. dry-run**: サンプルノードを差し込み `validator(parent, key, probe)` を実行して try/catch で判定

当初案は production で B-A + B-B を cross-check する構成だったが、以下の理由で **production は B-A のみ、B-B は test-only の cross-check ヘルパに限定** に変更した:

- `pnpm-lock.yaml` で `@babel/types` バージョンが完全 pin されているため、CI で B-A と B-B の一致が検証できれば production も正しいと保証される
- runtime self-check が catch できる独自シナリオが存在しない (純粋関数なので非決定性なし、`dist/cli.js` に bundle 配布するのでユーザー側 Babel 差し込みも発生しない)
- production コードから dry-run 検証ロジックを排除でき (純粋な型 introspection のみ)、検証ロジックは test の責務に一元化できる

## 決定

**B (文法由来の自動導出) を採用。production は B-A (型 introspection)、CI test で B-B (dry-run) と cross-check** を行う。

主要な根拠:

1. **Dataset leak の解消**: 「`NODE_FIELDS[type][key].validate.oneOfNodeTypes` に置換後カテゴリ対応 alias (Statement / Expression) が含まれるか」の 1 文で methodology を説明できる。Selakovic dataset に依存しない
2. **「第 1 段階は recall 上限、第 3 段階が precision 補正」の二段構造を尊重**: 文法上受理されない位置のみを原理除外するので消しすぎない (C 案が持つ問題を回避) かつ第 3 段階 ablation が純粋な precision 改善として解釈可能
3. **網羅性が向上**: destructuring LVal / `PrivateName` 等も原理的にカバーされる
4. **Diagnosability**: 生成 Map を snapshot test で diff できる。B-B との cross-check で Babel 内部 API の形式変化を CI 検出

### 実装アーキテクチャ

- `mb-analyzer/src/pruning/rules/blacklist.ts`: `BLACKLIST_CATEGORIES` が module load 時に 1 回だけ構築される定数として 3 カテゴリ (statement / identifier / expression) 別に `Map<parentType, Map<key, ExcludeRule>>` を保持する (whitelist の `WHITELIST_CATEGORIES` と対称)
- `ExcludeRule = true | { discriminator, value }`: `true` は無条件除外、object は親の特定フィールド値 (例 `{ discriminator: "computed", value: [false] }`) のときに限り除外
- `candidates.ts` の `isCandidate` は候補ノードの `WHITELIST_CATEGORIES` カテゴリで該当カテゴリの blacklist を参照し、`ExcludeRule` を評価する

### カテゴリ別の alias 要件

| 候補カテゴリ | 置換後ノード | 許容に必要な alias |
|---|---|---|
| statement | `EmptyStatement` | `Statement` |
| identifier | `Identifier($VAR)` | `Expression` (※) |
| expression | `StringLiteral($Pn)` | `Expression` |

※ identifier 候補の alias 要件を `Expression` にするのは、`Identifier` が LVal / FunctionParameter / PatternLike など binding 系 alias にも属しているため。binding 位置 (`FunctionDeclaration.id`, `LabeledStatement.label`, `VariableDeclarator.id` 等) は文法上 Identifier を受理するが、wildcard 化すると参照関係を壊すので L1 で除外したい。「`Expression` alias を持つか」が「自由な式スロットか binding スロットか」の grammar-level な proxy になる。

## 結果 / 影響

**得るもの:**

- 論文中で "blacklist is mechanically derived from Babel grammar, no dataset-specific knowledge" と defensive に答えられる
- destructuring LVal / `RestElement.argument` / `PrivateName` 等も自動除外され、試行コストが減る
- Babel バージョン更新で新構文が入っても blacklist が自動追従
- 第 3 段階 ablation study が clean な precision 改善として解釈できる

**諦めるもの・将来のコスト:**

- `NODE_FIELDS[type][key].validate.oneOfNodeTypes` / `NODE_UNION_SHAPES__PRIVATE` は `.d.ts` 型定義に含まれず semi-public。Babel 8 や大規模改修で property 名が変わるリスクあり。対策は test-only の dry-run cross-check で merge 前に検出する (`pnpm-lock.yaml` で Babel を pin しているので、CI 通過 = production 正しさが保証される)
- 最悪ケースでは `rules/blacklist.ts` の `extractAllowedTypes` 実装を新バージョンに追従させる必要が生じる

### 唯一の意図的な除外判定差

本方式では `UpdateExpression.argument` (例: `i++`) は除外しない。文法上は `Expression` を受理するため。直感的には「LVal 必須」だが、それは意味論的制約であって文法制約ではない。

この意味論的誤 prune は L4 等価性検証で弾かれるため、全体の正確性は担保される。この差分により **L1 は文法レベル / L4 は意味論レベル** と層が clean に分離されるので設計として望ましい。テストで本挙動を pin する (`tests/pruning/candidates.test.ts`)。

### 方式 B-B (dry-run) cross-check の対象外 (採択時の記録)

採択時 (2026-04-24) は CI で cross-check test を持つ構成だった。当該テストは以下の親型を skip していた:

- `File`: `comments` / `tokens` が素の `assertEach` 形式 (chainOf 非使用) で、非配列 probe を渡すと validator が早期 return する。B-B では accept 扱いになるが B-A は introspection で blacklist する
- `BindExpression` (stage-1 experimental): 非 8_BREAKING モードでは validate が no-op `() => {}` + `oneOfNodeTypes` property の組み合わせで、B-B では常に accept / B-A は blacklist
- `OptionalMemberExpression` / `OptionalCallExpression`: property validator が `node.computed` を参照する手動 discriminator 実装で `NODE_UNION_SHAPES__PRIVATE` を持たないため両者で挙動が乖離

これらは候補 enumerate の主要経路ではない / experimental なので、cross-check の目的 (Babel introspection API の形式変化を CI で検出) は他の主要位置で達成できると判断していた。

→ cross-check 自体を削除 (2026-04-30)。詳細は「補足: 2026-04-30 cross-check (B-B) 削除」。

## トリガー (再検討の条件)

以下のいずれかが成立したら本 ADR を見直す:

- dependabot / 手動の `@babel/types` バージョン更新 PR で `src/pruning/rules/blacklist.ts` 末尾 in-source の主要位置 pin が fail する (API 形式変化)
- 自動導出 blacklist の挙動が OSS 適用フェーズで false negative / false positive を有意に生む
- Babel 8 へ移行し非 8_BREAKING モード前提のコードが使えなくなる
- `NODE_UNION_SHAPES__PRIVATE` が削除された or 名前が変わった

トリガー発火時は新しい ADR を起票し、本 ADR は `superseded by ADR-NNNN` に書き換える。

## 補足

- production と test の責務分離は `feedback_doc_routing` skill (quality-check) の原則と揃う (実装検証は test、production は最小シンプルに)
- `@babel/types` の validator 内 `expandedTypes` は `definitions/index.js` 読み込み時に遅延初期化されるため、`import * as t from "@babel/types"` するだけで introspection が正しく機能する

## 補足: 2026-04-30 cross-check (B-B) 削除

採択後の状況変化により、test 側の B-B (dry-run) 独立実装と cross-check を削除した。Status は `accepted` のまま (採択判断の本筋 = 文法由来自動導出 は依然として有効)。

**変質した動機**:

- 採択時点では production = B-A、test = B-B + cross-check という非対称構成を採用 (production を最小に保ち、検証ロジックは test に一元化)
- 採択後 production も B-A による introspection で動的化されたため、cross-check の差別化要素 (採択時点における production 静的 vs test 動的) が失われた。両者とも文法由来動的の場合、独立実装による cross-check の検証価値は限定的

**カバレッジの再検討**:

- in-source の主要位置 pin (`src/pruning/rules/blacklist.ts` 末尾の `BLACKLIST_CATEGORIES (in-source) — 方式 A snapshot`) で `ForInStatement.left` / `AssignmentExpression.left` / `UpdateExpression.argument` (意図的 diff) / `MemberExpression.property` の discriminator 構造 / binding 位置 / destructuring 位置を pin。Babel API 形式変化の主要シナリオはここで検出可能
- cross-check が独自に検出するシナリオは「新規型 + 新形式 validator の同時導入」のみで、極めて稀
- `pnpm-lock.yaml` での Babel pin + dependabot/手動更新 PR の CI で snapshot fail として現れる。不安なら Babel バージョンを戻すロールバック運用で実用上は十分

**本文の影響を受ける節** (採択時の記述として保存。最新版は本補足):

- §「方式 B の内部選択肢: 許容型集合の抽出方法」末尾の「production は B-A のみ、B-B は test-only の cross-check ヘルパに限定」 → 現在は B-B 独立実装も削除
- §決定の「production は B-A (型 introspection)、CI test で B-B (dry-run) と cross-check」 → 現在は in-source の主要位置 pin が test 側の責務を担う
- §結果 / 影響の「対策は test-only の dry-run cross-check で merge 前に検出する」 → 現在は in-source pin
- §「方式 B-B (dry-run) cross-check の対象外」全体 → 採択時記録として保存。現在は cross-check 自体が無いので skip 一覧も無効
