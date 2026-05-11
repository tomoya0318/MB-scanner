# mb-analyzer (TypeScript 側) テストガイド

TypeScript 側コードベース `mb-analyzer/` のテスト詳細。共通原則は [`index.md`](index.md) を参照。

---

## フレームワーク

- **テストランナー**: `vitest` (`tests/**/*.test.ts` を自動検出、`projects` で層別分離)
- **Property-based testing**: `fast-check` (oracle 不変条件・境界探索に使用)
- **環境**: `node` (vm モジュール等を使うため jsdom は不要)
- **型テスト**: `expectTypeOf` で型レベル検証を行える

### テスト層 (`vitest` projects)

`vitest.config.ts` で 3 プロジェクトに分離し、`--project <name>` で個別実行可能:

| project | 役割 | testTimeout | 典型パス |
|---|---|---|---|
| `unit` | 各モジュール単体・CLI E2E・**in-source test** (ADR-0007) | 既定 (5s) | `tests/{cli,equivalence-checker,pruning,preprocessing,contracts}/**/*.test.ts` + `src/**/*.ts` 内 `if (import.meta.vitest)` |
| `property` | fast-check による invariant / 境界探索 | 60s | `tests/property/**/*.test.ts` |
| `integration` | 外部データセットを使った end-to-end 検証 | 30s | `tests/integration/**/*.test.ts` |

- `pnpm vitest --project unit` は高速なので pre-commit に組み込みやすい
- `property` / `integration` は sandbox 実行を多数走らせるため CI 中心

---

## 配置規約: 公開 API は `tests/`、内部ヘルパ・モジュール内共有は in-source (ADR-0007)

| 区分 | 配置 | 例 |
|---|---|---|
| **公開 API** (モジュールの `index.ts` から re-export される) | `tests/...test.ts` | `prune` のテスト → `tests/pruning/engine.test.ts` |
| **モジュール内共有ヘルパ** (ファイルから export はあるが `index.ts` に乗らない) | 同一 `src/` ファイル末尾の `if (import.meta.vitest)` ブロック | `enumerateCandidates` / `WHITELIST_CATEGORIES` / `BLACKLIST_CATEGORIES` / `replacementFor` → `src/pruning/{candidates, rules/whitelist, rules/blacklist, rules/replacement}.ts` 内; `parse` (whitelist-aware ラッパ) → `src/pruning/ast/parser.ts` 内; 共有 AST toolbox の `SubtreeSet` / `walkNodes` / `countNodes` / `snippetOfNode` → `src/ast/{subtree-hash, walk, inspect}.ts` 内 |
| **単一ファイル内ヘルパ** (export なし) | 同一 `src/` ファイル末尾の `if (import.meta.vitest)` ブロック | `isCandidate` のテスト → `src/pruning/candidates.ts` 内 |

判断ルールは **モジュールの `index.ts` に乗るかどうか** だけ。export 自体の有無では判断しない (モジュール内共有のための export は public API ではない)。複雑度や規模で振り分けない (主観で揺れて二重規範化する)。詳細根拠は [ADR-0007](../adr/0007-in-source-testing-internal-helpers.md)。

### in-source test の書式

```ts
// 実装本体
function isCandidate(...) { ... }

// ファイル末尾
if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;
  describe("isCandidate (in-source)", () => {
    it("...", () => { ... });
  });
}
```

- ファイル末尾に集約 (実装より下)
- `describe` 名にサフィックス `(in-source)` を付け、`tests/` 側のテストと出力上で区別
- `import.meta.vitest` から destructure (vitest は test 実行時のみ truthy にする)
- 同一ファイル内なので、export していないシンボルにも直接アクセス可能

### 何を in-source に書くか

- **書く**: 純関数の真理値テーブル境界 / 早期 return ガード / VISITOR_KEYS 未登録型のような病的入力。**単発 assertion で完結**するもの
- **書かない**: integration test (`tests/`) と被るケース、property 系 (fast-check は `tests/property/`)、parser を経由した複合シナリオ

### 設定 (一度きり)

- `vitest.config.ts`: `unit` project に `includeSource: ["src/**/*.ts"]`、トップレベルに `define: { "import.meta.vitest": "undefined" }`
- `tsconfig.json`: `"types": ["node", "vitest/importMeta"]`
- `build.mjs`: esbuild にも `define: { "import.meta.vitest": "undefined" }` を渡し、**`minifySyntax: true` を併用** する。esbuild は `define` だけでは `if (...) { ... }` を DCE しないので (esbuild issue #1955 / #2063)、`minifySyntax` で初めて静的削除が走る。`minifyWhitespace` / `minifyIdentifiers` は採用せず、bundle 可読性は維持。

これらを揃えていない状態で in-source test を書くと、本番 `dist/cli.js` に test コードが混入する (実行時は `import.meta.vitest === undefined` で実害は無いが、bundle サイズが膨らむ)。設定変更はまとめて行う。

---

## ディレクトリ構成と命名

`mb-analyzer/tests/` 以下を `src/` 構造とミラーした形で配置する（依存方向ゾーンと一致）。

```
tests/
├── fixtures/                     # [テスト対象外] 2 箇所以上で共有するデータ・builder・lifecycle fixture
│   └── *.ts
├── contracts/                    # [unit] 末端層の型定義テスト (src/contracts/ のミラー)
│   ├── equivalence-contracts.test.ts
│   ├── pruning-contracts.test.ts
│   └── preprocessing-contracts.test.ts
├── equivalence-checker/          # [unit] src/equivalence-checker/ 構造をミラー
│   ├── common/comparison/oracles/*.test.ts   # C1/C4/C5/C3+C4/C2/C6 の 6 oracle
│   ├── common/comparison/verdict.test.ts
│   ├── common/sandbox/{executors,capture,transforms}/*.test.ts
│   ├── common/serializer.test.ts
│   └── selakovic/{checker,oracle-routing}.test.ts
├── preprocessing/                # [unit] 公開 API preprocess() のみ (内部ヘルパは in-source: ADR-0007)
│   └── selakovic.test.ts
├── pruning/                      # [unit] 公開 API のみ (内部ヘルパは in-source: ADR-0007)
│   └── engine.test.ts            # prune の振る舞い
├── cli/                          # [unit] stdin/stdout E2E
│   └── {check-equivalence,prune,preprocess-selakovic}*.test.ts
├── property/                     # [property] fast-check 群
│   ├── oracles/*.property.test.ts   # oracle の代数的性質
│   ├── pruning/*.property.test.ts   # subtree hash 等の不変条件
│   └── checker/*.property.test.ts   # 変換パターンの境界探索
└── integration/                  # [integration] 外部データセット由来
    └── selakovic-2016.test.ts
```

- **ファイル名**:
  - unit: `{対象ファイル名}.test.ts` で対象と 1:1 対応
  - property: `{対象}.property.test.ts` サフィックスで分類 (`tests/property/` 配下)
  - integration: データセット名やシナリオ名 (`selakovic-2016.test.ts` 等)
- **テスト名**: `describe` は対象シンボル、`it` は「〜すると…する」の形で条件と期待結果を含める（`it("3 トリプルを順序保持で処理し id をエコーバックする", ...)` のように**仕様として読めること**を優先）

---

## テストファイル冒頭コメント

テストファイルには原則として冒頭に JSDoc ブロックを置き、「何を・どの観点で・何を判定基準として」検証するのかを記述する。テスト単体を読めば対象モジュールの仕様骨子を把握できる状態を目指す。

### フォーマット

```ts
/**
 * 対象: {テスト対象モジュール or 関数 / ID があれば併記}
 * 観点: {このテストが検証する側面を 1 行で}
 * 判定事項:
 *   - {条件 or ケース} → {期待結果}
 *   - {条件 or ケース} → {期待結果}
 */
```

- 判定事項は「分岐 → verdict」の表形式でも「満たすべき性質の列挙」でも良い（対象に合わせる）
- `describe` / `it` 名が自己説明的なときでも、**全体像と分岐の網羅性**を一望するために冒頭コメントは書く

### 書く / 書かない情報

- **書く**: 対象モジュールの役割、検証する観点、ケース・分岐の網羅リスト（エラー系・not_applicable 系など「テストしない条件」も含める）
- **書かない**:
  - 同階層・他ファイルの列挙 — `ls` で分かる情報は重複
  - 実装詳細（内部関数名・変数名）— プロダクトコードに任せる
  - テスト環境・共通パターン — 本ガイドに集約する

### 典型例

`tests/equivalence-checker/common/comparison/oracles/*.test.ts` は 6 種の oracle (C1/C4/C5/C3+C4/C2/C6) が同階層に並列で存在し「どんな oracle があり、各々は何を見ているか」を忘れやすい。冒頭コメントを仕様カタログとして機能させる好例。

### 意図とトレードオフ

プロダクトコードの JSDoc と内容が一部重複するが、**テスト側から読み始めて仕様を把握できる状態**を優先する。判定事項は仕様そのもので、仕様変更時はテストも必ず同時更新されるため、二重管理の同期コストは実用上低い。

---

## 共有 fixture と builder

テスト間で再利用するデータ / builder / lifecycle fixture は **`tests/fixtures/`** に集約する。

### 何を fixture に寄せるか

- **移動の目安**: 同じヘルパ・データ・builder が **2 箇所以上のテストで参照され始めたら `tests/fixtures/` への移動を検討**する。コピペが 3 箇所目に生える前に寄せる。
- **対象**: 静的データ (JSON・定数)・pure factory / builder 関数・共通 fast-check arbitrary・`test.extend` ベースの lifecycle fixture。
- **対象外**: 単一テストファイル内だけで閉じるローカル helper (移動すると間接参照が増えて読みにくくなる)。テスト固有の期待値・固定 literal (「このテストの仕様そのもの」なのでテストファイルに残す)。property テストのうち、特定テストだけに必要な狭い分布の arbitrary もテストファイル内に残す (sampling 意図が oracle 仕様と結びついている場合は自己完結性を優先)。

### 配置ルール

- **配置先**: `tests/fixtures/{対象}.ts` (対象ドメイン型 / 用途ごとに 1 ファイル)
- **import**: 各テストから相対 path で import
- **vitest 実行対象外**: `*.test.ts` サフィックスを付けないのでコレクト対象にならない (`vitest.config.ts` の include pattern と噛み合う)
- **中身の列挙はガイドに書かない**: ファイルを開けば分かる情報はガイドに書かず drift を防ぐ

### ディレクトリ名を `fixtures/` にしている理由

| 却下した候補 | 却下理由 |
|---|---|
| `tests/shared/` | `src/contracts/` のミラー (末端層の型テスト) と役割がぶつかる |
| `tests/__fixtures__/` | Jest 由来の double-underscore 慣習は本 repo で採用していない |
| `tests/factories/` | 関数 builder に寄せた命名としては正確だが、vitest 公式が `test.extend` の生成物を "fixture" と呼ぶため、将来 lifecycle fixture を追加した際に `fixtures/` / `factories/` が並立してしまう |

vitest 公式用語に寄せ、**静的データ・pure factory・`test.extend` ベースの lifecycle fixture を同一ディレクトリに共存**させる方針とする。pure factory の場合はファイル冒頭の JSDoc で「lifecycle なしの builder である」ことを明示し、`test.extend` 型の fixture と混同されないようにする。

### builder の signature 方針

- pure factory は **`overrides: Partial<T> = {}` の 1 引数** で統一する (positional で個別フィールドを受けない)
- 理由: call 側で「何を変えているか」が自明になり、fast-check の `fc.record({...}).map(factory)` 経路と signature が揃う
- 新規フィールドが `T` に増えたとき、neutral 初期値に 1 行足すだけで済み、破壊的変更が call 側に波及しない

---

## カバレッジ基準

| ゾーン | 基準 | 理由 |
|---|---|---|
| `src/contracts/` | **100%** | Python 側との JSON 契約の末端層。ここの漏れは両言語の仕様ずれにつながる |
| `src/equivalence-checker/common/comparison/oracles/` | **100%** | 各 oracle が仕様の判定ロジックそのもの。未到達分岐は誤判定と等価 |
| `src/equivalence-checker/common/comparison/verdict.ts` | **100%** | 全 oracle 結果の合成ロジック (`deriveOverallVerdict` / `deriveVerdictReason`)。優先順位分岐を全て網羅 |
| `src/equivalence-checker/common/sandbox/` | 主要パス + エラー分岐 | `vm.runInContext` の例外、タイムアウト、シリアライズ失敗、jsdom の require shim 分岐は必須。ホスト環境差分が出る部分は妥協可 |
| `src/equivalence-checker/selakovic/` | 主要パス | `checker.ts` の各 oracle 呼び出しとエラー集約 / `oracle-routing.ts` の環境別集合 |
| `src/cli/` | **stdin/stdout 契約 + バリデーション分岐を優先、OS レベル異常系は除外** | composition root なのでロジックは薄いが、`parseInput` / `parseBatchLine` は Python ↔ Node 契約の境界。`timeout_ms` 必須化のような**防御分岐**はテストがないと機能しない。`readStdin` 失敗等 OS レベルの分岐は稀かつモック困難なので除外可 |

**数値そのものを目標にしない**（[`index.md`](index.md) 共通原則）。`--coverage` の未到達行表示を見て、異常系・境界系が埋まっているかを確認する。

### 計測コマンド

```bash
mise run test-analyzer-cov
# 内部で pnpm --prefix mb-analyzer run test:cov (= vitest run --coverage) を実行
```

初回のみ `pnpm --prefix mb-analyzer install` で `@vitest/coverage-v8` が必要。

---

## モック化の指針

### モックすべき対象

- **`process.stdout.write` / `process.stdin`**: CLI E2E テストでは stdout をスパイしてキャプチャする（`tests/cli/check-equivalence-batch.test.ts` の `installStdoutSpy` / `feedStdin` パターンを踏襲）
- **`vm.runInContext` の副作用源**: Date、Math.random、timer、performance.now は `common/sandbox/transforms/non-determinism.ts` 経由で決定的に制御する（モックではなくサンドボックス固有のカスタムコンテキスト）
- **subprocess 呼び出し**: Node 側のテストでは subprocess を起こさず、関数呼び出しレベルでテスト

### モックしてはいけない対象

- **`vm` モジュール本体**: サンドボックス実行は実機で検証する（モックすると仕様が検証されない）
- **`shared/{equivalence,pruning}-contracts.ts` の型定義**: そのまま使う
- **oracle 同士**: oracle の合成は `checker.test.ts` / `verdict.test.ts` で実機を使って検証する

### 実装方法

- **基本ツール**: `vitest` 標準の `vi.fn()` / `vi.spyOn()` / `vi.mock()`
- **stdin/stdout スパイ**: 既存の手書きパターン（`process.stdout.write` を差し替え、`afterEach` で元に戻す）を再利用
- **型テスト**: `expectTypeOf<T>().toEqualTypeOf<U>()` で Python ↔ TS の型一致を検証（`tests/shared/{equivalence,pruning}-contracts.test.ts` 参照）

### CLI E2E のパターン

```typescript
describe("runCheckEquivalenceBatch", () => {
  let spy: WritableSpy;
  let restoreStdin: () => void = () => {};

  beforeEach(() => { spy = installStdoutSpy(); });
  afterEach(() => {
    restoreStdout(spy);
    restoreStdin();
  });

  it("...", async () => {
    restoreStdin = feedStdin(payload);
    await runCheckEquivalenceBatch({...});
    const results = parseOutput(spy.writes);
    // assertions
  });
});
```

stdin/stdout を本物のまま使い、subprocess 起動のコストを避けつつ stateless な契約を検証できる。

---

## Property-based testing (`fast-check`)

`tests/property/` 配下では `fast-check` を使って、ランダム入力に対する **不変条件** と **変換パターンの境界** を検証する。固定値ベースのテストでは見落としやすいエッジケースを自動で掘り当てる用途。

### 使う場面

1. **Oracle の代数的性質**: `checkReturnValue` / `checkException` など oracle 関数が **反射律** (自己比較は never `not_equal`) / **対称律** (slow/fast 入れ替えで verdict 不変) を満たすか
2. **変換パターンの境界探索**: Selakovic 等価変換の「どの入力空間で equal / not_equal が分かれるか」を生きた仕様として pin する (例: `x % 2` vs `x & 1` の非負整数 vs 負の奇数 vs 負の偶数)

### 使わない場面

- **Selakovic integration テスト**: ground truth が固定なのでランダム化すると検証意図がぼやける。`tests/integration/` では固定値を使う
- **ロジック薄い adapter / CLI**: 入力空間が広くないため fast-check のコストが見合わない

### 実装パターン

```ts
import * as fc from "fast-check";

describe("checkReturnValue (property)", () => {
  it("反射律: 自分自身との比較で not_equal は発生しない", () => {
    fc.assert(
      fc.property(arbitraryCapture, (cap) => {
        return checkReturnValue(cap, cap).verdict !== "not_equal";
      }),
      { numRuns: 200 },
    );
  });
});
```

- **sync な oracle 関数**: `fc.property` + `fc.assert`
- **async な checker 本体**: `fc.asyncProperty` + `await fc.assert(...)`
- **numRuns**: unit レベル (oracle) は 100〜200、sandbox 呼び出しが絡むものは 30〜50 に抑える
- **arbitrary の組み立て**: `ExecutionCapture` のような domain 型は `fc.record({...}).map(capture)` で組み立てる (`tests/fixtures/capture.ts` の共通 builder を import して再利用)
- **shrink を活かす**: `.filter(...)` は使いすぎると shrink が効きにくくなるので、生成側で絞り込むか後段で `fc.pre(...)` を使う

### 反例を記録する

fast-check が反例を掘り当てた場合、ランダム性で消えないように **固定値のテストケース** (`tests/integration/` or `checker.test.ts`) にも追記する。property テスト単体では再現性が seed 依存になるため、反例の重要性を明示する意味でも二重化する価値がある。

---

## 品質チェックコマンド (TypeScript 単体)

```bash
pnpm --prefix mb-analyzer run test              # vitest 全プロジェクト
pnpm --prefix mb-analyzer exec vitest --project unit         # 高速 (pre-commit 向き)
pnpm --prefix mb-analyzer exec vitest --project property     # fast-check 系のみ
pnpm --prefix mb-analyzer exec vitest --project integration  # データセット再現のみ
pnpm --prefix mb-analyzer run test -- --watch   # watch モード
pnpm --prefix mb-analyzer run test:cov          # カバレッジ付き (= mise run test-analyzer-cov)
mise run lint-analyzer                          # ESLint (依存方向検査込み)
mise run typecheck-analyzer                     # tsc --noEmit
mise run build-analyzer                         # esbuild で dist/cli.js をビルド
```

作業完了時は `mise run check` で両言語まとめて検証する（[`index.md`](index.md) 参照）。

---

## デバッグのヒント

- `describe.only` / `it.only` で特定テストに絞る（**コミット前に必ず戻す**）
- サンドボックス実行の中身を確認したいときは `console.log` を `common/sandbox/transforms/non-determinism.ts` の decoupling 対象にせず一時的に通す
- vitest の `--reporter=verbose` で全テスト名と所要時間を確認
- `--bail` で最初の失敗で停止（fail-fast デバッグ）
