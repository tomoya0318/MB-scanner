# ADR-0007: 内部ヘルパとモジュール内共有ヘルパは in-source testing、公開 API は `tests/` ツリーで分離する

- **Status**: accepted
- **Date**: 2026-04-30
- **Related**: ADR-0005 (grammar-derived blacklist), ADR-0006 (grammar-derived whitelist), `mb-analyzer/src/pruning/candidates.ts`, `ai-guide/quality-check/mb-analyzer.md`, `ai-guide/quality-check/mb-scanner.md`

## コンテキスト

第 1 段階 pruning エンジン (ADR-0005 / ADR-0006) を実装する過程で、`enumerateCandidates` 内の `walkAst` (AST DFS) と `isCandidate` (3 段フィルタ判定) を関数外に抽出した。両者は `enumerateCandidates` の internal helper であり外部から呼ばれないが、

- `isCandidate` は ADR-0005 / ADR-0006 が定義する **whitelist + blacklist + diff** の 3 段判定を集約しており、論文中で「3 段で正しく弾けている」と主張する根拠
- `walkAst` は AST 走査の不変条件 (parent/parentKey/listIndex の正しい引き回し、配列子と単一子の振り分け) を担う

この 2 点に対して **「考慮事項を整理した」audit trail としてのテスト** を残したい一方で、export して `tests/pruning/ast/` ツリーに直接 unit test を置くのは以下の点で不適切:

1. 外部 API 表面を汚す (引数 5 個の predicate を export する積極的な理由が無い)
2. integration test (`tests/pruning/candidates.test.ts`) と被りが多く、`tests/` ツリーに二段階の "ほぼ同じテスト" が並ぶ
3. 一方、テスト不在のままにすると論文執筆時に「この内部不変条件は本当に成立するか」を遡って確認するコストが残る

vitest には `import.meta.vitest` を介した **in-source testing** 機構があり、本番ビルド時に DCE で削除しつつ、テスト実行時のみ `if` ブロック内が有効化できる。これを「内部ヘルパ専用」のテスト配置として採用するかを決める必要がある。

## 選択肢

- **A. 現状維持 (内部ヘルパは integration test 経由でのみ間接検証)**: 何もしない
- **B. 内部ヘルパを export して `tests/` ツリーで unit test**: 引数を増やして公開し、別ファイルで検証
- **C. in-source testing を採用 (内部ヘルパは同一ファイル末尾、公開 API は `tests/` ツリー)**: 配置を「export 有無」で機械的に振り分ける

### 評価

| 軸 | A (現状維持) | B (export + tests/) | C (in-source + tests/ 並立) |
|---|---|---|---|
| 内部不変条件の audit trail | ❌ 無い | ✅ ある | ✅ ある |
| 公開 API 表面 | ✅ 最小 | ❌ 増える (predicate 等が露出) | ✅ 最小 |
| テストと実装の collocation | ❌ なし | ❌ 別ツリー | ✅ 同一ファイル |
| 論文執筆時の遡及コスト | ❌ 大 | △ 中 (別ファイル参照) | ✅ 小 (ファイル末尾で完結) |
| 二重規範回避 | ✅ なし | ✅ なし | △ 規約で機械化 |
| 設定コスト | ✅ 0 | ✅ 0 | △ 中 (vitest / tsconfig / build.mjs) |
| 本番バンドルへの混入リスク | ✅ なし | ✅ なし | △ 設定不備時に発生 (mitigation あり) |

A は「考慮事項を整理した証跡が無い」点で論文 validity に直接影響する。整理コストが peer review で全部こちらに跳ね返るのは避ける。

B は collocation を捨てており、内部ヘルパを「公開する」意思決定が **テスト都合** によるものになる。これは API 設計の判断軸を歪める (テストのために公開する関数が増えると、「これも公開してよいのか」の判断が将来的に毎回発生)。

C は設定コストを払う代わりに、**「export 有無」で配置先が機械的に決まる** という規約に落とせる。研究コードの性質 (paper = artifact、test = audit trail) と相性が良い。

## 決定

**C (in-source testing + `tests/` ツリーの並立)** を採用する。

主要な根拠:

1. **API 設計とテスト都合の分離**: 関数を export するかどうかは「外部から使う必要があるか」だけで決まる。テスト都合で公開判断が歪まない
2. **論文 audit trail の collocation**: 内部ヘルパの不変条件テストが実装と同一ファイルで読めるため、reviewer / 自分が「この実装で何を保証しているか」を 1 ファイルで追える。第 1 段階の "最小構造パターン導出" claim (ADR-0006) を支える証跡として機能する
3. **規約の機械化**: 「export 済み = `tests/`、export していない = in-source」と物理的可視性で振り分けられるため、判断の人為性が排除される
4. **DCE による本番安全性**: `define: { "import.meta.vitest": "undefined" }` を vitest と esbuild 両方に設定することで、本番バンドル (`dist/cli.js`) からは静的に削除される

### 規約

| 区分 | 配置 | 例 |
|---|---|---|
| 公開 API (モジュールの `index.ts` から re-export される) | `tests/...test.ts` | `prune` (`pruning/index.ts`) 等 |
| モジュール内共有ヘルパ (ファイルから export はあるが `index.ts` に乗らない) | 同一ファイル末尾の `if (import.meta.vitest)` ブロック | `enumerateCandidates` / `parse` / `FastSubtreeSet` / `walkNodes` / `WHITELIST_CATEGORIES` / `BLACKLIST_CATEGORIES` / `replacementFor` / `countNodes` / `snippetOfNode` 等 |
| 単一ファイル内ヘルパ (export なし) | 同一ファイル末尾の `if (import.meta.vitest)` ブロック | `isCandidate` (`pruning/candidates.ts`) 等 |

判断ルールは **モジュールの `index.ts` (public barrel) に乗るかどうか** のみに依存させる。export 自体の有無では判断しない: モジュール内の他ファイルから使うために export しているが外部公開していないシンボル (= モジュール内共有ヘルパ) は in-source 配置で扱う。「ロジックの複雑度」「テスト規模」も判断軸に入れない (主観で揺れ、二重規範を生む)。

### in-source test ブロックの書式

```ts
// 実装本体
function isCandidate(...) { ... }

if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;
  describe("isCandidate (in-source)", () => {
    it("...", () => { ... });
  });
}
```

- ファイル末尾に置く (実装より下)
- `describe` 名にサフィックス `(in-source)` を付け、`tests/` ツリーのテストと出力上で区別する
- import は `import.meta.vitest` から destructure (vitest が test 実行時のみ提供)
- 実装で必要な型定義を `export` する必要は無い (同一ファイル内なので参照可能)

### 検証コスト方針

- **integration test (`tests/`) と被るケースは省略**: 「3 段の連携が動く」レベルは integration が担う。in-source は **個々の不変条件 / 病的入力 / 境界** に絞る
- **fast-check 系の property test は in-source に置かない**: 不変条件の探索・境界 shrink は `tests/property/` の責務 (重量度ではなくテスト**形態**で振り分け、ADR §決定の「ロジックの複雑度・テスト規模で判断軸を増やさない」原則と整合)。in-source は「単発 assertion で完結する不変条件」に限定

## 結果 / 影響

**得るもの:**

- 内部ヘルパの audit trail が実装と collocation され、論文執筆時に「考慮した境界」が即座に参照可能
- 公開 API 表面が増えない (テスト都合の export 圧力を排除)
- 規約 (`index.ts` に乗るか) で配置が機械的に決まり、レビュー時の「これ tests/ に出すべき?」議論が不要
- `tests/` ツリーは「外部仕様 = 公開 API の振る舞い」を表すドキュメントとして純度が上がる

**諦めるもの・将来のコスト:**

- vitest / tsconfig / build.mjs の **設定 3 点更新** (一度きりだが、外部から既存設定に追従する必要がある)
- ソースファイルが test ブロック分だけ長くなる (mitigation: ファイル末尾統一で実装冒頭の見通しは保つ)
- `import.meta.vitest` の型補完のために `vitest/importMeta` を `tsconfig.types` に追加。production の型空間に test 用シンボルが見える (実害は無いが意識する必要)
- `define` 設定不備時に本番バンドルへ test コードが混入するリスク (CI で `node dist/cli.js --version` 等の sanity check を行うか、bundle サイズの snapshot を取るかで検出)
- in-source test 不採用言語 (Python `mb_scanner/`) との非対称性。**本 ADR は TypeScript 側 (`mb-analyzer/`) のみに適用** し、Python 側は `tests/` ツリーのみで継続する (pytest にも `doctest` 等の類似機構はあるが、規約の二重化を避けるため本 ADR では扱わない)

## トリガー (再検討の条件)

以下のいずれかが成立したら本 ADR を見直す:

- **vitest API 変更**: `import.meta.vitest` の入口が変わる、または `includeSource` の意味論が変わる
- **本番バンドルへの混入**: `dist/cli.js` に in-source テスト由来のシンボルが残ったことが CI / レビューで検出される
- **in-source 採用範囲の拡大**: 内部ヘルパが多数化し、in-source ブロックが実装本体より長くなるファイルが恒常的に発生 → `tests/` への退避も検討
- **build/test 設定の三重管理コスト**: vitest / esbuild / tsconfig の `define` 同期に頻繁に齟齬が生じる
- **Python 側にも同様の規約を持ち込みたい要請**: doctest / 同一ファイル test の採用判断が必要になった場合は別 ADR を起票

トリガー発火時は新しい ADR を起票し、本 ADR は `superseded by ADR-NNNN` に書き換える。

## 補足

- `tests/property/` (fast-check) と in-source の責務は明確に分離する: in-source は **単発 assertion**、property は **不変条件 + 境界探索**。
- `mb-analyzer/vitest.config.ts` の `projects` 配列のうち `unit` プロジェクトに `includeSource` を追加する (property / integration には不要)。これにより `pnpm vitest --project unit` で in-source テストが拾われる。
- production ビルド (`build.mjs`) と vitest 双方で **vitest 公式推奨** の `define: { "import.meta.vitest": "undefined" }` を設定する。
- ただし esbuild は `define` だけでは `if (...) { ... }` ブロックを削除しない (esbuild issue [#1955](https://github.com/evanw/esbuild/issues/1955), [#2063](https://github.com/evanw/esbuild/issues/2063))。`build.mjs` には **`minifySyntax: true` を追加** して DCE を起動する。`minifyWhitespace` / `minifyIdentifiers` は採用しない (bundle 可読性を維持し、デバッグ容易性を犠牲にしない)。
- vitest 側 (`vitest.config.ts`) は `define` のみで十分 (test 実行時は vitest 自身が `import.meta.vitest` を truthy にし、本ブロックがアクティブになる)。
