# preprocessing/ — 前処理器 (汎用 AST diff + Selakovic adapter)

> 生成物 — 手編集禁止 (ADR-0029)。再生成: `/generate-approach-spec mb-analyzer/src/preprocessing`
> 生成時コミット: `d122da9` (2026-06-13)

Selakovic dataset の 1 issue (before/after のファイル群) を、等価検証器 (equivalence-checker) の入力単位である candidate 列に変換する前処理器。計測ハーネス (`execute(f1, n)` / `$.ajax({mark, mean})` / `init`/`setupTest` 等) を剥がし、真の patch がある場所 (lib / workload) を特定して `(setup, before, after, workload)` を組み立てる。出力は 1 issue = 1 `PreprocessingIssueResult` (JSONL 1 行、ADR-0024)。

## 二層構造 (ADR-0011)

| 層 | ディレクトリ | 知ってよい知識 |
|---|---|---|
| **Tier 1 (汎用)** | `common/` | 与えられた AST / statement 列だけ。dataset の物理レイアウトも計測ハーネスの識別子規約 (`f1` / `execute` / `init` / `setupTest` / `test`) も一切知らない AST primitive |
| **Tier 2 (adapter)** | `selakovic/` | Selakovic dataset の物理レイアウト (`v_*.html` / `<lib>_before|after` / `test_case_*.js`) とハーネス規約。「どの statement を before/after の母集団として Tier 1 に渡すか」を決める |

依存は Tier 2 → Tier 1 の一方向のみ (ESLint `import/no-restricted-paths` で機械強制)。将来の別 dataset は `preprocessing/<dataset>/` を adapter として追加し、`common/` と contract の base 部は触らない (ADR-0024)。

公開 API は `selakovic/index.ts:11-19` の 5 つ (`preprocess` / `detectLayout` / `loadLibPair` / `resolveScriptDepSources` / `extractInlineScripts`) のみで、内部構成 (`io/` → `decompose/` → `route/` → `assemble/` → `pipeline.ts`) は外に出さない (`index.ts:9`)。

## ファイル index

### common/ — Tier 1 (dataset 非依存 AST primitive)

| file | 役割 | 主な依存 |
|---|---|---|
| `ast-diff.ts` | GumTree top-down 簡略版の subtree mapping で「最深 unmapped 境界」= changed nodes を返す `findChangedNodes` (`ast-diff.ts:27`) | `ast/subtree-hash` |
| `change-units.ts` | before/after lib の差分を **fn unit** (変更を含む最寄り named 関数、匿名は飛ばす) と **stmt unit** (ブロック直下の文) に切り分ける `findChangeUnits` (`change-units.ts:205`)。`FnChangeUnit` (`change-units.ts:145`) / `StmtChangeUnit` (`change-units.ts:161`、binding 名 + occurrence 番号で after 側と一意対応) | `ast-diff.ts`, `ast/parser`, `ast/walk` |
| `enclosure.ts` | changed nodes を内包する最小 enclosure を 3 段優先順位 (関数/メソッド → BlockStatement → top-level statement) で求める `findMinimalEnclosure` (`enclosure.ts:63`、ADR-0010) | `ast/walk` |
| `reachability.ts` | lib の named 関数 + workload root の名前ベース参照グラフ `buildCallGraph` (`reachability.ts:73`) と到達判定 `isReachedByAnyWorkload` (`reachability.ts:126`) / `isAnyBindingReachedByWorkload` (`reachability.ts:137`)。member-access は末端セグメント照合の over-approximation = KEEP 寄り安全側 | `change-units.ts` (FN_TYPES / functionBindingName) |
| `setup-cleanup.ts` | enclosure を含む Program 直下 statement で AST を分割する `splitAtEnclosure` (`setup-cleanup.ts:30`)、statement 列 → コード文字列化 `statementsToCode` (`setup-cleanup.ts:70`、コメントは出力しない) | `ast/parser`, `ast/walk` |

### selakovic/ — Tier 2 (Selakovic adapter)

| file | 役割 | 主な依存 |
|---|---|---|
| `index.ts` | public API の再 export (上記 5 関数) | `pipeline.ts`, `io/`, `decompose/inline-script` |
| `pipeline.ts` | 1 issue 分の前処理本体 `preprocess` (`pipeline.ts:60`、**純関数** — FS I/O を持たない)。client / server に分岐し、route 結果に応じて assemble を dispatch。changed-fn / changed-stmt 候補の append (`pipeline.ts:160`) と server 版 (`pipeline.ts:240`) もここ | `common/*`, `decompose/`, `route/`, `assemble/`, contracts |

#### selakovic/io/ — issue ディレクトリの読み出し (selakovic で `fs` に触る唯一の層 — `lib-pair.ts:16-17`)

| file | 役割 | 主な依存 |
|---|---|---|
| `layout.ts` | 物理ファイル構造から client (`v_*.html`) / server (`<lib>_before/` dir or `<lib>_before.js`) / unknown を判定する `detectLayout` (`layout.ts:39`)。`test_case_*` を lib 候補から除外 (`layout.ts:99`)、HTML + 単一ファイル lib の共存 (clientServerIssues) は client 優先 (`layout.ts:53-59`) | contracts (`LAYOUT_KIND`), `fs` |
| `lib-pair.ts` | `<lib>_before|after` (dir / 単一ファイル) を読み出して relative path → ソースの map ペアにする `loadLibPair` (`lib-pair.ts:28`) | `layout.ts`, `fs` |
| `script-deps.ts` | HTML の `<script src>` を harness / patched-lib / cdn-dep / local-other に分類する `classifyScriptSrcs` (`script-deps.ts:52`) と、CDN 依存 (jquery / handlebars / underscore) を issue 最寄りの `node_modules/` から解決する `resolveScriptDepSources` (`script-deps.ts:119`、ADR-0016 の client 拡張) | `fs` |

#### selakovic/decompose/ — 役割分解 + 計測ハーネス除去 (ADR-0011 §段1)

| file | 役割 | 主な依存 |
|---|---|---|
| `inline-script.ts` | `v_*.html` から inline `<script>` 本文を抽出する `extractInlineScripts` (`inline-script.ts:22`、純関数・正規表現実装) | — |
| `f1.ts` | inline script から `f1` を特定し f1 body / preWorkload / harness statement に分解する `extractF1` (`f1.ts:62`)。wrapper は `top-level` / `angular-controller-wrapper` の 2 種 (`f1.ts:32`)。規約外フォーマットは `null` → fallback | `ast/parser`, `ast/walk` |
| `test-case.ts` | `test_case_*.js` から `test()` body とパラメタを取り出す `extractTest` (`test-case.ts:34`)。`init`/`setupTest` はハーネス扱い | `ast/parser`, `ast/walk` |

#### selakovic/route/ — 作用点ルーティング (ADR-0011 §段2)

| file | 役割 | 主な依存 |
|---|---|---|
| `aspect.ts` | (lib に実コード変化, body に実コード変化) → `lib` / `workload` / `lib+workload` / `fallback` の `routeAspect` (`aspect.ts:15`) と AST 差分有無の `statementsChanged` (`aspect.ts:26`) | `common/ast-diff` |
| `lib-diff.ts` | lib ペアの行 multiset 差分で license / version / 整形 noise を除いた「実コード変化」と近傍関数名を出す `diffLibPair` (`lib-diff.ts:27`) | — |
| `case-split.ts` | `lib+workload` の issue を body 参照 identifier × lib 変更関数名の交差で independent (split) / co-evolution (1 candidate) に判定する `isIndependent` (`case-split.ts:17`、ADR-0014。迷ったら 1 candidate に倒す保守的判定) | `ast/walk` |

#### selakovic/assemble/ — candidate の組み立て

| file | 役割 | 主な依存 |
|---|---|---|
| `recorder-hooks.ts` | 等価検証器が注入する記録 Proxy (`globalThis.__recorder`、C6 interaction-trace) を runnable 内から使う hook 文の生成 (`recorder-hooks.ts:21,45`)。jQuery のみ `recurse: false` (`recorder-hooks.ts:42`) | — |
| `strategies/changed-fn.ts` | workload 到達済み fn unit から changed-fn candidate を組む `buildChangedFnCandidate` (`changed-fn.ts:55`、ADR-0023 placeholder substitution model)。hole 化 / body slice / param 検査の共通処理後に wrapperKind で `wrappers/` へ dispatch (`changed-fn.ts:96-123`)。rename-only param は collision guard 付きで救済 (ADR-0027)。excluded marker は `buildExcludedChangedFnCandidate` (`changed-fn.ts:137`) | `wrappers/{top-level,angular}`, `codegen/placeholder`, `ast/inspect`, `common/*` |
| `strategies/changed-stmt.ts` | stmt unit (モジュール直下の `var VERSION = ...` 等) を candidate 化する `buildChangedStmtCandidate` (`changed-stmt.ts:56`)。changed stmt を `$BODY$` 穴あけ + workload 到達可能な named fn 群を observer 計装する full-observation モデル | `codegen/placeholder`, `common/{change-units,reachability,setup-cleanup}` |
| `strategies/server-changed-fn.ts` | server (CommonJS) lib の changed-fn candidate `buildServerChangedFnCandidate` (`server-changed-fn.ts:41`、ADR-0025)。in-memory map-require で相対 require を解決し、変更ファイルだけ穴あけ。観測は 2 チャネル (変更関数戻り値 `r` + init 戻り値 post-state `s`) | `changed-fn.ts`, `codegen/placeholder`, `ast/inspect` |
| `strategies/fallback.ts` | `f1`/`test` 規約外 / 実質差なし issue の安全弁。top-level statement の canonical hash greedy match で素の diff candidate を切り出す `extractFromScripts` (`fallback.ts:47`) / `extractFromServerFiles` (`fallback.ts:136`) | `common/{ast-diff,enclosure,setup-cleanup}`, `ast/subtree-hash` |
| `wrappers/top-level.ts` | client の embedded candidate 3 種 (`buildClientLibCandidate` `top-level.ts:24` / `buildClientBodyCandidate` `top-level.ts:49` / `buildClientCombinedCandidate` `top-level.ts:78`) と top-level changed-fn の実行容器 `assembleTopLevelChangedFn` (`top-level.ts:167`) | `wrappers/angular`, `recorder-hooks.ts`, `codegen/placeholder` |
| `wrappers/angular.ts` | Angular controller-wrapper の自己完結 runnable `buildAngularRunnable` (`angular.ts:68`) と changed-fn 容器 `assembleAngularChangedFn` (`angular.ts:120`、bootstrap を setup / workload に分割) | `recorder-hooks.ts`, `codegen/placeholder` |
| `wrappers/server.ts` | server の embedded runnable `buildServerRunnable` (`server.ts:18`)。test_case を CommonJS wrapper で評価し init/setupTest/test を実行、内部 throw は re-throw して exception oracle に乗せる | `recorder-hooks.ts` |

## 処理フロー (依存方向)

```
CLI (composition root)                 pipeline.ts (純関数)
──────────────────────                 ─────────────────────────────────────────
io/  detectLayout                      decompose/  extractF1 / extractTest
     loadLibPair              ──→                  (規約外 → fallback)
     resolveScriptDepSources                │
     + extractInlineScripts                 ▼
     = SelakovicPreprocessInput        route/      diffLibPair + statementsChanged
                                                   → routeAspect (lib / workload /
                                                     lib+workload / fallback)
                                                   lib+workload → isIndependent
                                                │
                                                ▼
                                       assemble/   wrappers (embedded #0)
                                                   + strategies (changed-fn /
                                                     changed-stmt / server-changed-fn
                                                     / fallback)
                                                │
                                                ▼
                                       PreprocessingIssueResult
```

- FS I/O は `io/` に閉じる。`preprocess()` (`pipeline.ts:60`) はファイル内容を受け取る純関数で、CLI が `io/` の結果から `SelakovicPreprocessInput` (`pipeline.ts:40`) を組んで渡す。
- client `aspect: lib` (および lib+workload の independent split) では、embedded candidate `#0` に加えて、workload (`f1`) が推移的に exercise する変更 unit ごとに changed-fn / changed-stmt candidate を append する (`pipeline.ts:160-227`)。真の candidate を作れない unit は `candidate_excluded` marker として痕跡を残す (ADR-0023 D-γ §DROP 可視化)。
- server では embedded `#0` (`buildServerRunnable`) に加え、lib に実変化があれば CommonJS-respecting な server-changed-fn candidate を append する (`pipeline.ts:330-332`、ADR-0025)。
- `common/` → `selakovic/` の逆方向 import は存在しない。`assemble/` 内も `strategies/` → `wrappers/` の一方向 dispatch。

## JSON 契約 (`../contracts/preprocessing-contracts.ts`)

Python 側 `mb_scanner/domain/entities/preprocessing.py` との paired-change 対象 (`preprocessing-contracts.ts:1-13`)。構造は base contract (全 dataset 共通フィールド) + adapter extension (`issue_meta` / `candidate_meta` の discriminated union) + issue 階層化 (ADR-0024)。

- **`PreprocessingInput`** (`preprocessing-contracts.ts:37`): CLI の stdin 入力 (1 issue 分)。`{ id?, issue_dir }`。
- **`PreprocessingIssueResult`** (`preprocessing-contracts.ts:74`): **1 issue = JSONL 1 行 = 1 モデル**。
  - `issue_excluded?` / `issue_excluded_detail?` — issue 全体の処理失敗理由 (指定時 `candidates` は空でよい)
  - `candidates: PreprocessingCandidate[]` + `candidate_count` (= `candidates.length` の冗長フィールド、見通し用)
  - `issue_meta?: SelakovicIssueMeta` (`preprocessing-contracts.ts:176`) = `{ adapter: "selakovic", layout, aspect, wrapper_kind }` — issue level で 1 値。gateway error 以外は adapter が必ず付与
- **`PreprocessingCandidate`** (`preprocessing-contracts.ts:56`): 等価検証の入力単位。
  - `setup?` / `before?` / `after?` — 基本 3 値。`candidate_excluded` 指定時は undefined
  - `workload?` — ADR-0023 の placeholder substitution 用 4 値目。`setup` が `$BODY$` プレースホルダを厳密 1 個含み、`before`/`after` を差し込んで sandbox に渡す経路 (changed-fn 系) でのみ定義。それ以外の経路 (client embedded / fallback / server embedded) では null/undefined
  - `before_node_count?` / `after_node_count?` — AST ノード数 (changed-fn 系は変更関数本体のサイズ、embedded/fallback は全文サイズ — `pipeline.ts:124-136`)
  - `enclosure_node_type?` — 抽出した最小 enclosure の Babel ノード型名 (粒度集計用、ADR-0010)
  - `candidate_excluded?: ExclusionReasonAny` — この candidate を作れなかった理由 (DROP 可視化 marker)
  - `candidate_meta: SelakovicCandidateMeta` (`preprocessing-contracts.ts:184`) = `{ adapter: "selakovic", target_side, is_workload_reachable }` — candidate level で 1 値
- **除外理由** = base 4 値 (`preprocessing-contracts.ts:26`: parse-error / no-changed-nodes / multi-file-change / missing-files) + Selakovic 固有 12 値 (`preprocessing-contracts.ts:158`: module-wide-change / no-enclosure-candidate / layout-unknown / change-not-exercised / no-lib-source / angular-wrapper-skip / change-units-parse-fail / empty-diff / no-fn-unit / unit-renamed-or-removed / fn-non-block-body / fn-param-names-mismatch) の union (`preprocessing-contracts.ts:198`)。
- **`aspect` と `target_side` のレベル差** (`preprocessing-contracts.ts:104,122`): `aspect` は「元 patch がどこにあるか」(1 issue = 1 値)、`target_side` は「この candidate がどっち側を表現するか」(1 candidate = 1 値)。語彙 (`lib`/`workload`) は重なるが意味レベルが違う。

CLI / equivalence-checker 側の使われ方は [`../cli/README.md`](../cli/README.md) / [`../equivalence-checker/README.md`](../equivalence-checker/README.md) 参照。

## 関連 ADR

- ADR-0010: Selakovic 前処理器の enclosure 候補型に 3 段優先順位 (関数 / Block / Top-level statement) を採用
- ADR-0011: preprocess を Tier 1 (汎用 AST diff) + Tier 2 (Selakovic adapter) の二層に分ける
- ADR-0014: inline+lib 両方変化した issue は identifier 交差判定で independent なら 2 candidate に分割する
- ADR-0016: SUT lib の npm dep を dataset fork に lockfile で宣言して解決する (`script-deps.ts` の client 拡張の前提)
- ADR-0017: ループ反復回数は preprocess では書き換えず sandbox の iteration-cap に委ねる
- ADR-0023: preprocess を placeholder substitution + 4 値契約に書き直す (v2) — ADR-0022 (v1) を supersede
- ADR-0024: preprocess contract を base / adapter 分離 + issue 階層化に再設計する
- ADR-0025: server SUT を CommonJS-respecting holed lib で扱う (server-changed-fn / map-require)
- ADR-0027: changed-fn rename-only 救済の collision guard (scope-aware rename 不採用)
- ADR-0029: ai-guide の Reference 軸を生成型へ移行 (この README の生成根拠)
