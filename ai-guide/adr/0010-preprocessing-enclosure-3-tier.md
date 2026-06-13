# ADR-0010: Selakovic 前処理器の enclosure 候補型に 3 段優先順位を採用

- **Status**: accepted
- **Date**: 2026-05-05
- **Related**: PR #4, `mb-analyzer/src/preprocessing/common/enclosure.ts`, `mb-analyzer/src/preprocessing/selakovic/index.ts`, `tmp/0004_hydra-pruning-integration/plan.md` §Phase 4.2

## コンテキスト

Selakovic 前処理器の `findMinimalEnclosure` は AST diff の changed_nodes を内包する最小の構文単位を返す。当初実装は **2 段優先順位**:

1. Function/Method 系 (FunctionDeclaration / FunctionExpression / Arrow / ClassMethod / ObjectMethod)
2. BlockStatement

Selakovic 全 97 件の実測でこの 2 段では 41/97 (42%) しか抽出できず、特に **ライブラリ全面 refactor** ケース (例: EJS 136a の `var parse = function(...) { ...大量変更... }`、Backbone の model 系全面書き換え) で `module-wide-change` として除外されることが多発した。

原因分析: changed_nodes が「関数 body 全体に散在」するパターンでは、LCA が Function/Method/Block の **外** (= VariableDeclaration や ExpressionStatement レベル) に上昇してしまい、2 段優先順位では救えない。これは Selakovic の典型的な **library 全面修正** パターンで、論文側でも「PR 単位の最適化」として扱われている。

抽出母集団を最大化することは事前分析の数値主張に直結する (Selakovic 論文との 1:1 対応で 100 件近くを評価できるか、半分しか評価できないかは threats to validity の重さに影響する)。

## 選択肢

- **A. 2 段のまま、除外を threats に honest に記録**: 抽出 42%、threats で「大規模 refactor はスコープ外」と明記
- **B. 改良 3 = 3 段優先順位**: 段 3 として top-level statement 系 (VariableDeclaration / FunctionDeclaration / ClassDeclaration / ExpressionStatement) を追加。LCA が Function/Block より外に出ても top-level statement 全体を 1 candidate として救済
- **C. 改良 1 = 関数単位 LCA グループ化**: 各 changed_node を「自分を内包する最も内側の Function」でグループ化し、各 Function ごとに enclosure を作る。複数関数にまたがる変更を独立 candidate に分解
- **D. 関数 body 内部の 2 次 LCA**: Function に到達したら、その Function 内部で再度 LCA を取って細粒度 enclosure を抽出

### 評価

| 軸 | A (現状維持) | B (改良 3) | C (改良 1) | D (内部 2 次 LCA) |
|---|---|---|---|---|
| 抽出率 | 42% | **99%** (実測) | ~70% 推定 | ~50% 推定 |
| 論文非依存性 | 完全維持 | 維持 (構造的ルールのみ) | 維持 | 維持 |
| 実装複雑度 | 0 | 小 (ループ追加 1 つ) | 中 (グルーピング + 複数 enclosure) | 中 |
| Selakovic との対応関係 | PR の半分が拾えず比較不可 | PR とほぼ 1:1 で比較可能 | 同上 | 関数粒度なので Selakovic より細かい |
| slow/fast サイズ | 小 | 大 (top-level statement 全体) | 中 | 小 |
| 後段 pruning コスト | 低 | 高 (候補列挙が広い) | 中 | 低 |

## 決定

**B (改良 3 = 3 段優先順位) を採用**。主要な根拠:

1. **抽出母集団の最大化**: 99% の抽出率により Selakovic 論文 (97 件) とほぼ 1:1 で比較可能になる。事前分析の数値主張で「全 PR を評価した」と書ける
2. **論文非依存性の維持**: 候補型の追加は ECMAScript 文法レベルの一般概念のみ (VariableDeclaration / FunctionDeclaration / ClassDeclaration / ExpressionStatement)。Selakovic Table 4 / precondition には依存せず、threats to validity への記述は「LCA が Function/Block の外に出る場合、top-level statement 単位で抽出する」という構造的ルールで完結する
3. **実装複雑度が最小**: 既存の `findMinimalEnclosure` に 3 つ目のループを追加するだけ
4. **後段の問題は別レイヤーで吸収可能**: slow/fast 肥大化による pruning コスト増は `max_iterations` / timeout の調整で対応できる。抽出器の責務を超えた問題は別 PR で扱う

### 3 段優先順位の構成

```
段 1: 関数/メソッド系 (FunctionDeclaration / FunctionExpression / Arrow / ClassMethod / ObjectMethod)
段 2: BlockStatement
段 3 (改良 3): VariableDeclaration / FunctionDeclaration / ClassDeclaration / ExpressionStatement
```

LCA から root に向かって走査し、最初に見つかった候補型を採用。Module/File に到達したら次の段にフォールバック。

### setup 構築規約 (案 D の確定)

各 candidate の setup は **「自分以外の全 top-level statement (matched + 他 unmatched) の before 版を index 順に結合」** とする (案 D)。これにより:

1. 両側 (slow/fast) の setup が完全同一 → 関数間依存があっても等価判定が破綻しない
2. 「他の最適化対象は最適化前の状態を環境として固定」というメンタルモデル
3. 1 PR に複数最適化が同居する場合、各最適化を独立した抽出単位として並列評価できる

## 結果 / 影響

**得るもの:**

- Selakovic 97 件中 96 件 (99.0%) で抽出成功。事前分析の数値主張を最大化できる
- enclosure 抽出が「関数 body の中の局所変更」と「関数全体の refactor」の両方を扱える
- 論文の「PR 単位の最適化」という前提と整合する抽出単位を提供する

**諦めるもの:**

- slow/fast に top-level statement 全体が入るケース (49 件) では サイズが 50KB+ になりうる。後段 pruning の `max_iterations` / timeout 調整が必要
- 段 3 採用時の enclosure_type は VariableDeclaration / ExpressionStatement となり、関数 body だけを抽出する段 1 より粒度が粗い。これは threats to validity に「大規模 refactor は粒度の粗い抽出単位で扱う」と honest に明記する

## トリガー (3 段優先順位を見直す条件)

以下のいずれかが成立したら ADR を見直す:

- 後段 (Phase 4.3 等価検証 / Phase 4.4 pruning) で **段 3 採用ケースの 30% 以上が `error` / `not_equal`** に終わるとき → 段 3 の採用条件を絞る (例: top-level statement のサイズ上限を設ける)
- クラスタリング評価 (Phase 4.5) で「段 3 採用ケースが過抽象化されて誤クラスタリング」が観測されるとき → 段 3 を別カテゴリで集計する
- OSS 適用フェーズで段 3 採用が precision を著しく低下させるとき

## 更新 (2026-06-13): 適用範囲は fallback 経路のみ

ADR-0011 の二層化 (2026-05 以降) で、Tier 2 (Selakovic adapter) が `f1` / `test()` 規約ベースの役割分解で candidate を組み立てるようになったため、本 ADR の `findMinimalEnclosure` 3 段優先順位は **Tier 2 が「①にも②にも実質差なし」または規約外フォーマットと判定した issue の fallback 経路 (Tier 1 素の top-level statement AST diff) でのみ使われる**。実物では稀 (Phase 2a の 97 issue では fallback 経由抽出は 0)。判断自体は fallback 経路の仕様として現役。
