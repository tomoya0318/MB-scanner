# preprocessing

データセットの 1 issue (before/after パッチペア) を、等価検証・pruning が食える **`(setup, slow, fast)` candidate** に変換するパイプラインの最前段。[ADR-0011](../../../ai-guide/adr/0011-preprocessing-tier-structure.md) の二層構成:

- **`common/`** = Tier 1 — dataset 非依存の AST primitive (subtree diff / minimal enclosure / setup 分割)。
- **`selakovic/`** = Tier 2 — Selakovic 2016 dataset 固有の adapter。`selakovic.preprocess()` が公開エントリポイント。

論文非依存性の境界をコード構造で明文化するための分割: 主軸 (pruning など) は Selakovic 論文 §6/§7 に依存しないが、preprocess / 等価検証は dataset 規約 (`f1` / `init`/`setupTest`/`test` / `execute(f1,n)` / `mark` / `<lib>_*.js`) を積極利用してよい (Tier 2 = その依存を閉じ込める層)。

## 入出力契約

公開 API は `selakovic/index.ts` の re-export (`preprocess` / `detectLayout` / `loadLibPair` / `extractInlineScripts` + 型) のみ — 内部構成 (`io/` → `decompose/` → `route/` → `assemble/` → `pipeline.ts`) は外に出さない。Tier 1 (`common/`) は barrel を持たず Tier 2 から個別 import される (dataset 非依存 AST primitive 層、eslint で `common` → `selakovic` の逆 import 禁止)。

`PreprocessingInput` / `PreprocessingResult` は `mb-analyzer/src/contracts/preprocessing-contracts.ts` で定義され、Python 側 (`mb_scanner/domain/entities/preprocessing.py`) と JSON シリアライゼーション互換を保つ (列挙値の文字列・フィールド名 snake_case を両言語で厳密に揃える。変更は paired-change)。CLI ラッパは `mb-analyzer/src/cli/preprocess-selakovic.ts` (`preprocess-selakovic` / `preprocess-selakovic-batch` サブコマンド) で、issue ディレクトリのファイル I/O とレイアウト判定をして純関数 `preprocess()` を呼び、結果を **常に JSONL** で stdout に出す薄い層。Python 側 `mb_scanner/adapters/cli/preprocessing.py` (`mbs preprocess-selakovic[-batch]`) が subprocess 経由で起動し、batch は Python 側 `ThreadPoolExecutor` で並列化 (Node 側 1 subprocess = 逐次)。**入出力データの意味論はここ (本 README) と [code-map.md §Selakovic 前処理器](../../../ai-guide/code-map.md#selakovic-前処理器) を一次ソースとし、CLI 側には CLI 固有の引数 / stderr 規約 / 終了コードのみ書く**方針。

### `PreprocessingInput`

```ts
interface PreprocessingInput {
  id?: string;          // バッチ API での順序追跡用 (省略可)
  issue_dir: string;    // issue ディレクトリの絶対パス (CLI 側がここからファイルを読む)
}
```

ファイル I/O は CLI に閉じ込め、純関数 `preprocess()` には文字列内容のみを渡す (CLI が `detectLayout` でレイアウト判定 → `v_*.html` / `test_case_*.js` を読む / `loadLibPair` で `<lib>_before/after` を読む → `SelakovicPreprocessInput` を組む)。

### `PreprocessingResult` (1 件 = 1 candidate)

```ts
interface PreprocessingResult {
  id?: string;                  // 入力 id をエコーバック (複数 candidate なら "<id>#0", "<id>#1", ...)
  layout: "client" | "server" | "unknown";
  setup?: string;               // 両側共通の事前定義コード (excluded のとき undefined)
  slow?: string;                // before 側 candidate (検証対象)
  fast?: string;                // after  側 candidate
  enclosure_type?: string;      // 収束した構文単位 ("f1-body" / "lib-file" / "angular-controller-wrapper" /
                                //   "server-test-case" / AST ノード型名 "FunctionDeclaration" 等) — threats 集計用
  before_node_count?: number;
  after_node_count?: number;
  aspect?: "A" | "B" | "A+B" | "fallback";          // 作用点ルーティングの結果 (ADR-0011 §段2)
  candidate_kind?: "lib" | "body" | "single";        // A+B split (ADR-0014) における役割
  environment?: "vm" | "jsdom";                      // 後段 equivalence-checker への実行環境 hint
  excluded?: ExclusionReason;   // 抽出不成立のとき (下記表)
  excluded_detail?: string;     // 人間可読な理由
}
```

### 1 入力 → N 結果モデル

同一 PR に独立した最適化が複数同居しうる (例: socket.io 573 = `encodePacket` の case 順入替 + `decodePacket` の if/else→switch 書換が同一 commit) ため、`preprocess()` の戻り値は `PreprocessingResult[]`:

| candidate 数 | 出力 | id 規則 |
|---|---|---|
| 0 (整形差分のみ / enclosure 不成立) | 1 件 (`excluded` 設定) | `<input.id>` (suffix なし) |
| 1 | 1 件 (抽出成功) | `<input.id>` (suffix なし) |
| N (≥ 2) | N 件 (各 candidate 独立) | `<input.id>#0`, `<input.id>#1`, ... |
| 構造的失敗 (parse-error 等) | 1 件 (`excluded`) | `<input.id>` |

Python 側 Gateway は **prefix-match で id 突き合わせ** (`<batch_key>` または `<batch_key>#X` の全行を集める)。

### `aspect` / `candidate_kind` / `environment` (ADR-0011 §段2 / ADR-0014)

- **`aspect`**: 真 patch がどこにあるか。`A` = `<lib>_*.js` のみ変化 / `B` = ベンチマーク関数 body (`f1.body` / `test()` body) のみ変化 / `A+B` = 両方 / `fallback` = どちらにも実コード差なし or 規約外フォーマット (= Tier 1 素の top-level diff に委ねた)。
- **`candidate_kind`**: `A+B` を identifier 交差判定で分割したときの役割 (`lib` = lib varies / body fixed@before、`body` = body varies / lib fixed@before)。それ以外 (`A` / `B` / `A+B` co-evolution / `fallback`) は `single`。
- **`environment`**: preprocess が後段 equivalence-checker に渡す実行環境 hint (`vm` = 純粋計算 / `jsdom` = browser ライブラリ・server `test_case` で `require` 解決・DOM が要る)。値は `equivalence-contracts.ts` の `EXECUTION_ENVIRONMENT` と一致。

### `excluded` — 抽出不成立の理由 (`ExclusionReason`)

`fallback` 経路 (Tier 1 素の diff) でのみ発生する (Tier 2 は `f1`/`test` が規約外なら exclude せず fallback に回す)。集計で内訳を取り、各々を threats to validity に「データセット / 抽出器の限界」として明示する方針:

| reason | 意味 |
|---|---|
| `parse-error` | Babel parser が SyntaxError (例: inline `<script>` が JSX を含む) |
| `no-changed-nodes` | 全 top-level statement が AST hash で matched (整形差分のみ、意味論変更なし) |
| `module-wide-change` | unmatched 残るが 3 段すべての enclosure 候補型 (関数/Block/top-level statement) に到達できない (設計上ほぼ起きない) |
| `multi-file-change` | server 系で意味論変更が複数 .js ファイルにまたがる (保守的に除外) |
| `no-enclosure-candidate` | enclosure 候補型が見つからない |
| `layout-unknown` | `v_*.html` も `<lib>_*` も無く client / server と判定できない |
| `missing-files` | 期待するファイル (`v_*.html` / `<lib>_*` 等) が欠落 / ファイル I/O 失敗 |

## ファイル index

```
src/preprocessing/
├── common/              ← Tier 1 (ADR-0011): dataset 非依存の AST primitive。selakovic から個別 import
│   ├── ast-diff.ts          ← findChangedNodes (GumTree top-down 流の subtree mapping で「最深 unmapped」)
│   ├── enclosure.ts         ← findMinimalEnclosure (changed_nodes を内包する最小 syntactic 単位、3 段優先順位 — ADR-0010)
│   └── setup-cleanup.ts     ← splitAtEnclosure / statementsToCode / statementToCode (enclosure を含む top-level statement で AST を分割)
└── selakovic/           ← Tier 2 (ADR-0011): Selakovic 2016 dataset 固有の adapter
    ├── index.ts             ← 薄い barrel (preprocess / SelakovicPreprocessInput / detectLayout / DetectedLayout / loadLibPair / LibPair / extractInlineScripts)
    ├── pipeline.ts          ← preprocess / preprocessClient / preprocessServer + glue。io → decompose → route → assemble を統括
    ├── io/                  ← FS I/O 層 (CLI から呼ぶ。selakovic で fs を import するのはここだけ)
    │   ├── layout.ts            ← detectLayout (物理ファイル構造から client/server/unknown 判定 + ファイルパス収集)
    │   └── lib-pair.ts          ← loadLibPair (<lib>_before/after を dir scan で読んで Record<path, source> に)
    ├── decompose/           ← 段1 役割分解: 片側 (before|after) の source → 構造化ピース (pure)
    │   ├── inline-script.ts     ← extractInlineScripts (v_*.html から inline <script> を抽出)
    │   ├── f1.ts                ← extractF1 (inline <script> から f1 を特定 → body / preF1 / 計測ハーネス に分解。top-level / Angular controller-wrapper の 2 種)
    │   └── test-case.ts         ← extractTest (test_case_*.js から init/setupTest/test を特定 → test() body を切り出し)
    ├── route/               ← 段2 作用点ルーティング: before×after のピースを比較して分類 (pure)
    │   ├── aspect.ts            ← routeAspect (lib 変化×body 変化 → A/B/A+B/fallback) + statementsChanged (body の AST diff が空でないか)
    │   ├── lib-diff.ts          ← diffLibPair (行ベース multiset 差分で license/version/整形 noise を除いて実コード行が残るか + 近傍関数名を近似)
    │   └── case-split.ts        ← isIndependent (ADR-0014: body の参照 identifier ∩ lib 変更関数名が空なら independent → 2 candidate)
    └── assemble/            ← (setup, slow, fast) を組み立てる (pure)
        ├── angular.ts           ← buildAngularRunnable (Angular controller-wrapper: lib load → module/controller 再構成 → f1() 1 回実行 → 観測値 return の自己完結 IIFE)
        ├── client.ts            ← buildClient{Lib,Body,Combined}Candidate (top-level f1 の作用点別組み立て。body は `(function(){ ... })()` で包む)
        ├── server.ts            ← buildServerRunnable (test_case_*.js を module/exports/require 込みで包んで init()/setupTest()/test() を実行)
        └── fallback.ts          ← extractFromScripts / extractFromServerFiles (Tier 1 素の top-level diff = 規約外 issue の安全弁。assemble の degenerate 版)
```

層の役割分担:

| 層 | 中身 | dataset 知識 | 入れ替え可能性 |
|---|---|---|---|
| `common/` (Tier 1) | AST diff / enclosure / setup 分割 (Babel と `ast/` toolbox のみに依存) | なし | 別 dataset の adapter からも再利用可 |
| `selakovic/` (Tier 2) | Selakovic 規約 (`f1`/`test`/`<lib>_*`/計測ハーネス) を知る adapter。`io → decompose → route → assemble` の 4 層 + `pipeline.ts` 統括 + `index.ts` barrel | あり | dataset 固有 |
| `../contracts/preprocessing-contracts` | Python と互換の JSON 型・列挙 (末端層) | なし | 触れない |

モジュール内共有ヘルパ (`extractF1` / `extractTest` / `diffLibPair` / `routeAspect` / `isIndependent` / runnable builder 等 — barrel に出していない) のテストは各ファイル末尾の in-source testing (`if (import.meta.vitest)`)、公開 API `preprocess()` の振る舞いテストは `tests/preprocessing/selakovic.test.ts` — [ADR-0007](../../../ai-guide/adr/0007-in-source-testing-internal-helpers.md)。

## 抽出パイプライン (Tier 2 段1 / 段2 — ADR-0011)

`preprocess(input: SelakovicPreprocessInput)` (`pipeline.ts`) は CLI が読んだファイル内容 (inline `<script>` / `test_case_*.js` / `<lib>_before/after` の map) を受け取り 4 層を順に通す:

1. **段1 (役割分解 + 計測ハーネス除去)** — `decompose/`: ① `<lib>_before/after` ペア (CLI が `io/lib-pair.ts` で dir scan 済) + ② ベンチマーク関数 body ペア (client: `f1` body / server: `test()` body)。`var a = execute(f1, n)` 以降 / `$.ajax({mark,mean})` / `init`/`setupTest` 等の計測ハーネスは setup に回すか破棄。**body 内のループ反復回数 (`for (i<50000)`) は書き換えない** — 復元可能性のため、反復縮小は等価検証側の transform に委ねる (ADR-0013)。
2. **段2 (作用点ルーティング)** — `route/`: ①② の実コード差で **A** (lib のみ) / **B** (body のみ) / **A+B** (両方) / **fallback** に振り分け。A/B → candidate 1 個。A+B → ADR-0014 の identifier 交差判定で independent なら 2 candidate (`lib` / `body`)、co-evolution の疑いなら 1 candidate。fallback → `assemble/fallback.ts` の Tier 1 素の top-level diff。
3. **組み立て** — `assemble/`: 作用点 × wrapper kind で `(setup, slow, fast)` を作る (Angular controller-wrapper / top-level f1 / server test_case / fallback)。

詳細 (enclosure の 3 段優先順位 / setup 構築規約 / レイアウト判定 / 除外理由の意味論) は [code-map.md §Selakovic 前処理器](../../../ai-guide/code-map.md#selakovic-前処理器)。

## 依存方向

```
selakovic/index.ts (barrel)
 └─ selakovic/pipeline.ts
     ├─ decompose/{inline-script,f1,test-case}.ts ── ../../ast/{parser,walk}
     ├─ route/{aspect,lib-diff,case-split}.ts ──┬── ../../common/ast-diff ── ../../ast/{subtree-hash,walk}
     │                                          └── ../../ast/walk
     ├─ assemble/{angular,client,server}.ts ──── ../../common/setup-cleanup ── ../../ast/{parser,walk}
     ├─ assemble/fallback.ts ──── ../../common/{ast-diff,enclosure,setup-cleanup} + ../../ast/{parser,inspect,subtree-hash}
     ├─ io/{layout,lib-pair}.ts ── node:fs / node:path  (CLI から直接呼ぶ I/O 層)
     └─ ../../ast/{parser,inspect} + ../../contracts/preprocessing-contracts (末端層)
```

`preprocessing/` は `ast/` と `contracts/` (+ `io/` の node builtins) しか import せず、`equivalence-checker/` / `pruning/` 等の他機能は import 禁止 (eslint `import/no-restricted-paths`)。Tier 1 `common/` は Tier 2 `selakovic/` を import してはならない (`@angular/common` 流のドメイン非依存層、こちらも eslint で機械強制)。CLI (`cli/preprocess-selakovic.ts`) のみが composition root として `selakovic/index.ts` を import する。

## 関連 ADR

- [ADR-0007](../../../ai-guide/adr/0007-in-source-testing-internal-helpers.md): 内部ヘルパとモジュール内共有ヘルパは in-source testing、公開 API は `tests/` ツリーで分離する
- [ADR-0010](../../../ai-guide/adr/0010-preprocessing-enclosure-3-tier.md): Selakovic 前処理器の enclosure 候補型に 3 段優先順位 (関数/メソッド → ブロック → top-level statement) を採用 (`common/enclosure.ts`、fallback 経路の粒度を決める)
- [ADR-0011](../../../ai-guide/adr/0011-preprocessing-tier-structure.md): preprocess を Tier 1 (汎用 AST diff = `common/`) + Tier 2 (Selakovic adapter = `selakovic/`) の二層に分ける。Tier 2 は段1 役割分解 / 段2 作用点ルーティング (A·B·A+B·fallback) の構成
- [ADR-0014](../../../ai-guide/adr/0014-case-split-for-both-changed.md): inline+lib 両方変化した issue は identifier 交差判定で independent なら 2 candidate に分割する (`route/case-split.ts`、`PreprocessingResult.candidate_kind`)
- [ADR-0013](../../../ai-guide/adr/0013-equivalence-operational-definition.md): 「意味論的等価」の operational definition — 反復回数は非観測 = preprocess は loop bound を書き換えない (`for (i<50000)` をそのまま残す)。`environment` hint の受け手 (equivalence-checker) 側の規約は [ADR-0012](../../../ai-guide/adr/0012-equivalence-checker-execution-environment.md)
