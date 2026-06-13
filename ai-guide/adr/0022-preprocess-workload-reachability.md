# ADR-0022: preprocess を workload-reachability driven な changed-fn 候補に再設計 (v1 = `__HOLE__` 方式)

- **Status**: superseded by ADR-0023 (2026-05-13 D-α spike success で 0023 が accepted に昇格)
- **Date**: 2026-05-13
- **Related**: ADR-0011 (preprocessing Tier 2 構造 — 本 ADR の changed-fn 候補が新 candidate_kind として乗る), ADR-0014 (case-split for both-changed — co-evolution の 1 candidate 化判定はそのまま継承), ADR-0016 (fork lockfile = `<script src>` CDN dep の vendoring), ADR-0018 (等価検証 verdict 保守化 — `inconclusive` を本 ADR の vacuous equal 対策として利用), `mb-analyzer/src/preprocessing/common/{change-units,reachability,function-hole}.ts`, `mb-analyzer/src/preprocessing/selakovic/assemble/changed-fn.ts`, `mb-analyzer/src/preprocessing/selakovic/pipeline.ts:appendChangedFnCandidates`, `research/src/research/preprocess_workload_reachability/notes/v1-{plan,notes,prompt-history}.md`

## コンテキスト

0019 (lib-embedded) と 0021 (lib-enclosure) の preprocess は **candidate のサイズが大きすぎて pruning が事実上効かない**問題があった:

- **0019 lib-embedded**: lib 全文 + 変更点を 1 candidate に embedded → **数万〜十数万ノード**。pruning は 1 iter 数秒 × 数百 iter で OOM 必至。
- **0021 lib-enclosure**: 変更点を 1 enclosure で包む → 27〜779 ノード。pruning は走るが、enclosure の「切り方」が意味論を保たないケース多発 (Phase 5 で「切り方が悪い」と判明)。

ユーザの思想: **「pruning が削るべき対象は変更関数の本体だけ」**。lib 全文を candidate に含めるのではなく、**workload (`f1` body / `test()` body) が呼ぶ変更関数だけを抜き出して小候補にする**。これが workload-reachability driven な候補選別 (差分 → 変更関数の特定 → workload で exercise されるものに絞る) という発想。

## 選択肢

- **A. lib 全文 + 変更関数本体を `__HOLE__` で差し替える (v1 採用)**: lib の中で変更関数の body だけ `if (globalThis.__HOLE__) { return __HOLE__.call(this, <内部依存>, <args>); } <after body inline fallback>` に置換。slow/fast で `globalThis.__HOLE__` を別関数として定義し、戻り値を `__OBS` に記録。lambda-lift で lib 内部の補助関数を `__HOLE__` の引数に昇格。
- **B. 変更関数のソースを slow にそのまま入れる (= 再定義 / naive)**: setup に lib 全文、slow に `_s.startsWith = function(...) {...}` の再定義を置く。
- **C. placeholder substitution + 4 値契約 (= v2 案、ADR-0023)**: setup template の `$BODY$` プレースホルダに slow/fast body を埋め込んで実行する。

### 評価

| 軸 | A (`__HOLE__`) | B (naive 再定義) | C (placeholder) |
|----|---------------|------------------|----------------|
| lib 内部の補助関数依存 (`makeString` 等) | ✓ lambda-lift で引数化 | ✗ closure 不在で `ReferenceError` | ✓ closure 経由で自然に解決 |
| bootstrap-invocation (`Ember.assert` 等) | ✓ `if (__HOLE__)` ガード + inline fallback | ✗ bootstrap 中の挙動差を観測点として取れない | ✓ bootstrap 中も差し替え版が走り観測点に化ける |
| equiv-checker 入力契約への影響 | △ 既存 `{setup, slow, fast}` のまま | ✓ 既存契約のまま | ✗ 4 値契約 `{setup, workload, slow, fast}` に拡張 |
| 実装の認知コスト | △ 3 仕掛けの組み合わせ (lambda-lift + guard + `__OBS`) | ✓ シンプル (が動かない) | ✓ 仕掛けは観測 hook のみ |
| spike での実証 | ✓ Phase 0.5 spike v2 (12 issue) + Phase 5 全件 (97 issue) | ✗ Phase 0.5 spike v1 で fail 確認 | spike 未実施 (D-α で確認予定) |

## 決定

**A (`__HOLE__` 方式)** を v1 として採用する。

主要な根拠:
- spike v1 (naive 再定義) で **大半の lib (underscore.string / Ember / jQuery / AngularJS) が ReferenceError で死ぬ**ことが確認された (notes.md `Phase 0.5 spike v2 が判明` 節)
- lambda-lift で内部依存を引数化することで lib closure の壁を越えられる (spike v2 で 4/4 クリーンケース成立)
- 「観測する形」(`__OBS.push(JSON.stringify(__r))`) で return_value oracle が positive evidence を出せる (pruning が over-prune できない)
- `if (__HOLE__)` ガード + after body inline fallback で bootstrap-invocation (Ember 3174 `Ember.assert` / Underscore 1223 `_.forEach` 等) を吸収

v1 と呼ぶ理由は、C (placeholder substitution) が **理論的にはよりシンプル**で v2 候補として残っているため。本 ADR は v1 の意思決定を記録し、v2 の検討は ADR-0023 で扱う。

## 結果 / 影響

### 採用によって得られたもの

- candidate サイズ: **数万ノード (0019) → 27〜779 (0021) → 75 (v1 median)** に縮小
- pruning: 19/26 candidates が pruned、median 削減率 0.174、絶対 after サイズ **median ≈ 62 ノード** (= 75 × (1 - 0.174))
- 0019/0021/v1 の絶対サイズ比較: **数万 / 数十〜数百 / 62** → 桁違いに小さい最終パターン
- Phase 5 (全件再走、97 issue、2026-05-13): extracted 143 candidates (changed-fn 35 + body 11 + lib 11 + single 86)、equiv 26 equal / 6 not_equal / 14 error、prune 19 pruned / 7 error
- 詳細数値: `research/src/research/preprocess_workload_reachability/notes/v1-notes.md` §Phase 5

### 採用によって生じた副作用

- **3 仕掛けの組み合わせで accidental に複雑** (lambda-lift / `if (__HOLE__)` ガード / observe wrapper)、`function-hole.ts` 200 行
- **AMD 内ローカル**(Ember 5547 `metaFor` 等) の自由変数収集が `define(...)` callback body まで lexical chain を辿る必要 (= 実装複雑度)
- equiv error 14 件の内訳: Ember 4158 ×3 (jquery 1.7 override 未投入、fork PR で fix 可) + `makePromise` ×9 (clientServer の Node-module スタイル lib を `__HOLE__` 経由で eval すると sandbox 内 Promise harness 経路に入って fail) + sandbox kill ×1 → **`makePromise` 系 9 件は `__HOLE__` 方式起因の可能性大**
- prune error 7 件: Ember big-setup の OOM/leak (別 TODO #2、`prune` のメモリリーク修正待ち)

### 計測対象スコープ

- v1 の changed-fn 生成対象 = aspect=lib (84 issue) + aspect=lib+workload independent (11 issue) = **79 issue** (server 17 + fallback 1 + workload-only 0 + co-evolution 1 を除く)
- うち 32 issue で changed-fn ≥ 1 を生成 (60%、Angular wrapper 26 issue は v1 では skip = 別 TODO #8 で対応予定)
- 達成率: 32 / 53 = **60%** (Angular 除く)、Angular 26 + 不明 21 が残課題

## v2 への引き継ぎ (ADR-0023)

v1 の accidental complexity を解消し、placeholder substitution + 4 値契約に置き換える設計を **ADR-0023** に proposed として起票している。D-α spike で実証後、accepted に昇格し本 ADR を `superseded by 0023` にステータス変更予定。

v2 で **保持される資産** (v1 の遺産として):
- `mb-analyzer/src/preprocessing/common/change-units.ts` (findChangeUnits)
- `mb-analyzer/src/preprocessing/common/reachability.ts` (workload-reachability call graph)
- `mb-analyzer/src/preprocessing/selakovic/io/script-deps.ts` (dep-vendoring)
- `mb-analyzer/src/equivalence-checker/common/comparison/oracles/argument-mutation.ts` の unserializable fix
- `mb-analyzer/src/contracts/preprocessing-contracts.ts` の `CANDIDATE_KIND.CHANGED_FN` / `EXCLUSION_REASON.CHANGE_NOT_EXERCISED` (= v2 でも同じ kind を維持)
- `data/selakovic-2016-issues` submodule の fork pointer (= `be15a06`、jquery 1.7 swap + 各 issue の vendored dep)

v2 で **置き換え対象**:
- `mb-analyzer/src/preprocessing/common/function-hole.ts` (lambda-lift / `__HOLE__` 系、大幅縮減 or 削除)
- `mb-analyzer/src/preprocessing/selakovic/assemble/changed-fn.ts` (4 値契約に書き直し)
- 既存 `selakovic.test.ts` の changed-fn 関連 assertion

## 関連メモ

- `research/src/research/preprocess_workload_reachability/notes/v1-plan.md`: v1 の実装計画 (Phase 0-5)
- `research/src/research/preprocess_workload_reachability/notes/v1-notes.md`: Phase 0.5 spike / Phase 5 全件結果の詳細
- `research/src/research/preprocess_workload_reachability/notes/spike-v1.log` / `spike-v2.log`: brain-2 サーバでの実走ログ
- `research/src/research/preprocess_workload_reachability/notes/migration-plan.md`: v1 → v2 の移行ロードマップ
- `research/src/research/preprocess_workload_reachability/notes/refactoring-todo.md`: v2 完了後の整備タスク (CLI 改良 / mise tasks / research/ 整備)

### 2026-05-15 更新 (ADR-0024 で changed-fn を boolean 化)

`candidate_kind: changed-fn` は ADR-0024 で廃止し、changed_fn 抽出由来かどうかは `is_workload_reachable: bool` (candidate level、`SelakovicCandidateMeta`) で表現する形に再構成する。本 ADR の workload-reachability ロジック (`change-units.ts` / `reachability.ts`) と「workload が exercise する変更関数だけを候補に絞る」設計自体は不変。`change-not-exercised` enum 値は `SelakovicExclusionReason` (adapter 拡張) に移動。詳細は ADR-0024 §決定 を参照。
