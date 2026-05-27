# Spike: リテラル抽象化ルールの影響測定 (2026-05-27)

`main @ 17bb101` の 50 pruned 結果を静的測定 (`code/spike_literal_impact.mjs`)。本体は未変更。

## 問い

5457 で load-bearing なリテラル `0` (= `substr(0,2)` の開始位置) が wildcard 化されていた。
対策として「pruning はリテラルを抽象化しない」案を検討するため影響を測る。

## 測定結果

- placeholder **598 個中 68 個 (11%) がリテラル**。blanket 案ではこれらが skeleton に戻る
- **node 数は不変** (リテラル ↔ `$Pn` はどちらも 1 ノード) → パターンは膨れない
- 影響 candidate: 19/50

## 決定的発見: リテラルは 2 種類混在

| issue | slow (抜粋) | リテラル | 種別 |
|-------|------|------|------|
| 5457 | `key.substr(0, 2) !== '$$'` | `0`, `2` | **load-bearing** (最適化本体) |
| 9991 | `for(i<500000){ 'this.foo.bar'.indexOf('this.') }` | `'this.'` | load-bearing |
| 9991 | 同上 | `500000` | **incidental** (観測ハーネスのループ回数) |
| 4263 | `for(i<100000){ elementInDocument(childDiv) }` | `100000`, `0` | incidental (ループ回数) |

→ **blanket「リテラル不抽象化」は incidental な harness 定数 (100000/500000) を skeleton に固定**し、
「ちょうど 100000 回ループ」という過度に具体的なパターンを生む。pruning が wildcard していたのは正しい挙動。

## 結論: 区別は構造的文脈 (差分サブツリー内か)

| リテラル | 親ノード | fast に同型 | 望ましい扱い |
|------|------|------|------|
| `0` / `2` (substr) | `substr(...)` | なし (差分) | 保護 (skeleton) |
| `'this.'` (indexOf) | `indexOf(...)` | なし (差分) | 保護 |
| `100000` (for-test) | `i < 100000` | あり (共通 harness) | wildcard 維持 |

→ blanket は不適。**「リテラルは親も共通ノードの時だけ pruning 候補にする」ルール** (= 差分サブツリー内の
リテラルを保護) が load-bearing 保護と incidental wildcard を両立する。値の衝突 (`'this.'` が
fast の `lastIndexOf('this.')` にも在る) も構造文脈で正しく捌ける。

## 試作の本走結果 (2026-05-27, `MB_PRUNE_PROTECT_DIFF_LITERALS=1`)

`candidates.ts:isCandidate` に「リテラルは親も共通ノードの時だけ候補」ルールを env フラグ付きで試作
(デフォルト OFF)、`prune-input.jsonl` 84 件を再走 (`code/prune-results-litfix.jsonl`)。比較は
`code/compare_litfix.mjs`。

| 指標 | baseline | litfix | 評価 |
|------|---|---|---|
| verdict | pruned 50 / error 33 / initial_mismatch 1 | **同一** | 等価判定を壊さない |
| リテラル placeholder (pruned 内) | 68 | **10** (58 個が skeleton へ) | 狙い通り |
| pruned candidate の placeholder 合計 | 598 | 540 | リテラル分だけ減 |
| node_count_after | — | **全件不変** | パターン膨張なし |

狙い 2 ケースが両方正しく動作:
- **5457 (load-bearing)**: `0` が placeholder から skeleton へ → `$P4.substr(0, 2) !== '$$'`。
  `key`/`src`/`dst` は identifier wildcard のまま (= `$VAR.substr(0, 2)`)
- **4263 (incidental)**: `100000` は placeholder のまま (親 `i < 100000` が共通 harness)。ループ回数を固定せず一般化維持

残った 10 リテラル placeholder は全て親が共通 (incidental: harness 定数等) で、保持すべきものだけが skeleton へ。
副次効果: 形検出の strict 率向上 (5457 の `substr(0,2)` が骨格に出る → P5 が strict 検出可能に)。

→ **「親共通リテラル」ルールは妥当と確認。**

## canonical 昇格 (2026-05-27)

litfix 結果を pipeline の canonical `preprocess_workload_reachability/code/prune-results.jsonl` に昇格 (84 行)。
旧 baseline (リテラル抽象化あり) は `research/research/pruning/code/prune-results-baseline.jsonl` に退避。

**更新 (2026-05-27, ADR-0028 採用)**: 試験フラグ `MB_PRUNE_PROTECT_DIFF_LITERALS` は撤去し、
リテラル保護を `candidates.ts` の既定挙動にした。環境変数なしの通常 `prune-batch` で本ルールが効く
(issue_5457 で `substr(0, 2)` が骨格保持を確認済)。canonical `prune-results.jsonl` と整合し、再現性の
暫定状態は解消。

### 未反映の下流分析
`tmp/0048_full-rerun-17bb101/` の wrap 分析・形検出マトリクスは**旧 baseline の prune-results** に基づく。
新 canonical では strict 検出率が上がる見込み (差分内リテラルが skeleton に出る) だが未再計算。必要なら再走。
</content>
