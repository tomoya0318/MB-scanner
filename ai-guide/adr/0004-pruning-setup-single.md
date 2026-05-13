# ADR-0004: PruningInput.setup を単数 string にする

- **Status**: accepted
- **Date**: 2026-04-23
- **Related**: PR #8, `mb-analyzer/src/contracts/pruning-contracts.ts`, `mb_scanner/domain/entities/pruning.py`

## コンテキスト

pruning の入力として、slow / fast を実行する前の初期化コード (`setup`) をどう表現するかの判断。既存の `EquivalenceInput.setup` は `string` (単数) として定義されている (例: `"const arr = [10, 20, 30];"`)。

pruning では「差分フィルタで共通ノード判定がエッジケースで誤作動する」シナリオがある。例: `hasOwnProperty` チェックは特定の setup (prototype chain あり) でしか意味を持たない。setup を複数用意して fuzzing 的に検証すれば偽共通を減らせる。

## 選択肢

- **A. 単数 `setup: string`**: 1 ペアあたり setup は 1 つ。EquivalenceInput と対称
- **B. 複数 `setups: string[]`**: 1 ペアに対し複数の setup を順に試す
- **C. `{ setup: string | string[] }` のユニオン**: 互換のため両方受け付ける

### 評価

| 軸 | A (単数) | B (複数) | C (ユニオン) |
|---|---|---|---|
| 既存 EquivalenceInput との対称性 | ✓ | ✗ | ✗ |
| 差分フィルタで取りこぼすケース | あり (エッジケース) | 減らせる | 減らせる |
| API 複雑度 | 低 | 中 | 高 (どちらを送るか判断要) |
| 第 2 段階との責務分離 | 明瞭 | 混在 | 混在 |
| 実装コスト | 最小 | バッチ展開が必要 | 両対応 |

## 決定

**A (単数 `setup: string`)** を採用。主要な根拠:

- 差分フィルタ単体で全てのエッジケースを救おうとせず、**差分フィルタ + 第 2 段階 C1〜C4** の二段構造で補償する設計
- 複数 setup による系統的な検証は第 2 段階の C1〜C4 軸設定と自然に重なる (C1: 値の範囲、C2: 型、C3: エイリアス、C4: 例外)
- 既存 `EquivalenceInput` と同じ shape にすることで Python ↔ Node 契約の認知コストを下げる
- TypeScript 側は `setup?: string` (optional + 空文字デフォルト相当)、Python 側は `setup: str = Field(default="")` で symmetric

## 結果 / 影響

**得るもの:**
- シンプルな API、`EquivalenceInput` precedent との一貫性
- 第 2 段階の軸設定とスコープが分離される

**諦めるもの:**
- 差分フィルタ単体で「共通ノードに edge case が潜むケース」は救えない (第 2 段階で補償する前提)

## トリガー (複数 setup に拡張する条件)

以下のいずれかが成立したら ADR を見直す:

- Selakovic 10 パターン integration (PR #4) で「共通ノード edge case」が多数派と実測 (推定では少数派)
- 第 2 段階 C1〜C4 で fuzzing 的に複数 setup を扱う必要があるとわかった
- OSS 適用フェーズで偽共通 (false common) によるパターン誤導出が問題化

拡張時は `setups: string[]` を追加し、`setup: string` を deprecate する (後方互換は数バージョン残す) 段階的な移行を取る。

## 補足

- 「差分フィルタで取りこぼすケース」の具体例: `if (obj.hasOwnProperty(key))` チェックは prototype chain 上にキーがある場合に意味を持つが、setup で prototype chain を構築していないと `hasOwnProperty` を削除しても slow ≡ fast になり、`hasOwnProperty` が common と判定されてしまう
- この誤判定は AST 差分の本質的限界ではなく **実行パス上の条件判定** の問題なので、第 2 段階の C 軸で扱うのが筋
