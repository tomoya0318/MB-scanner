# ADR-0025: server SUT を CommonJS-respecting holed lib + node:vm 直 eval で扱う

- **Status**: accepted (ローカル spike で 3/3 equal 達成、go ライン 2/3 以上を満たす — chalk-27a / chalk-28 / cheerio-386b)
- **Date**: 2026-05-18
- **Related**: ADR-0012 (vm executor + server vm globals/`.json` require の予約), ADR-0015 (equivalence-checker 二層化 / oracle 環境非依存), ADR-0017 (SUT lib npm dep を fork lockfile-vendored で解決), ADR-0023 (placeholder substitution + 4 値契約), ADR-0024 (preprocess contract base/adapter 分離 + `environment` 派生)

## このADRの守備範囲

このADRが決めるのは **「server レイアウト issue (= `<lib>_*.js` が CommonJS module の `module.exports`/`require` を使う形) を equivalence-checker に乗せるとき、holed lib をどう組み立て、どの executor で走らせるか」だけ**。本実装は順 3-2 で行う別 PR。本 PR は ADR draft + 3 件 spike で go/no-go を出すための spike 駆動 ADR。

**扱わないこと** (他 ADR の管轄):
- 何を観測するか (return / DOM / interaction trace 等) → **ADR-0013**
- どの環境で走らせるか (jsdom+vm 主軸 / Playwright fallback の選定根拠) → **ADR-0012** (本 ADR は ADR-0012 §「server 系 SUT 用に最小 Node グローバル」を引用するだけで再定義しない)
- placeholder の物理形 (`$BODY$` 単一置換, 4 値契約) → **ADR-0023**
- 派生フィールド `environment` の出力位置 → **ADR-0024** (本 ADR は server × top_level のとき `vm` を返すよう adapter 側 derivation を改修する旨を予告するだけで、契約形式は触らない)
- npm dep 解決 (`createRequire(libBase)`, fork lockfile-vendored) → **ADR-0017**

## コンテキスト

D-γ baseline (`tmp/0036_d-gamma-baseline/funnel-baseline.md`) で **server × top_level の 26 件 (issue 単位) が funnel ②→③ で全件 DROP** している。

`<lib>_*.js` が CommonJS スタイル (`module.exports = {...}` / 末尾で require される形) で書かれているとき、現行 preprocess の changed-fn strategy (`assemble/strategies/changed-fn.ts`) は browser-style の前提 — つまり「lib の関数群を IIFE で並べ、変更関数 body だけ `$BODY$` で穴あき、workload の前に `<script>` 順 load 相当で連結する」モデル — でしか holed lib を組み立てない。CommonJS では関数定義が `module.exports.xxx = function (...) {...}` の右辺にあったり、`exports.xxx = function () {...}` だったり、IIFE で wrap して末尾で代入したり、と多様な物理形を取るため、browser-style 単純連結では `ReferenceError: makePromise is not defined` 等の構造的失敗を起こす (= 上流研究 v1-notes §153 で記録済の構造的限界)。

ADR-0012 は「server SUT 用に最小 Node グローバル (`process` / `Buffer` / `setImmediate` / `.json` require) を vm context に注入する」までは設計に書いてあるが、その vm executor を **どの preprocess 経路 (= どの strategy + どの wrapper) から呼ぶか** は未定 — Phase 2a/2b では server も jsdom executor に流していた (ADR-0024 §`environment` derivation 末尾「現状は常に jsdom」)。結果、server changed-fn は jsdom 上で browser-style assemble の前提で走り、26 件全 DROP した。

## 選択肢

- **A. 現状維持 (server を全件 DROP のまま諦める)**: 実装ゼロ。verdict 到達 issue 43→43 のまま、threats に「server 26 件は構造的限界で観測不能」と書く。
- **B. server も jsdom + browser-style 連結に統一**: 既に Phase 2a/2b で失敗実証済 (v1-notes §153)。`module.exports` 構造を壊さず連結する方法が無い。
- **C. CommonJS-respecting holed lib + `node:vm` 直 eval (採用案)**: 新 strategy `assemble/strategies/server-changed-fn.ts` を追加し、`module.exports` 構造を保ったまま変更関数 body だけ `$BODY$` で穴あく。executor は ADR-0012 で予約済の vm executor (Node グローバル注入済) に server changed-fn を乗せる。`derive_environment` を `layout === "server" && wrapper_kind === "top_level"` のとき `vm` を返すよう adapter 側で改修。
- **D. Playwright 上で Node polyfill (browserify バンドル等)**: 実装コスト過大、ADR-0012 §トリガーが想定する fallback 用途と乖離。却下。

### 評価

| 軸 | A (現状) | B (jsdom 統一) | C (採用) | D (Playwright polyfill) |
|---|---|---|---|---|
| 救済期待件数 (26 件中) | 0 | 0 (失敗実証済) | 期待 ≥ 15 (spike で確定) | 不明 (実装前) |
| 実装コスト | 0 | 中 (失敗) | 中 (新 strategy + adapter env 1 分岐) | 大 (bundler 統合) |
| dep 解決 | n/a | 不整合 | ADR-0017 既存経路に乗る | 別経路要設計 |
| oracle 整合 | n/a | n/a | ADR-0015 環境非依存原則を維持 (oracle は capture を見るだけ) | 同左 |
| 拡張性 (ESM 等) | × | × | ESM は別途 ADR、本 ADR の範囲外と明示 | △ |
| migration コスト | 0 | 中 | 中 (本 PR は spike + ADR、本実装は順 3-2 別 PR) | 大 |

## 決定

**C (CommonJS-respecting holed lib + node:vm 直 eval)** を採用する。

ローカル spike で 3/3 件 equal 達成。go ライン 2/3 以上を満たしたため `accepted` に確定。

### spike 結果サマリ

3 件を手書きで `setup-template` (穴あき lib) + `body-slow` / `body-fast` + `workload` に分解し、`node:vm` の `createContext` + `createRequire` で slow / fast 両方を実行して observation を比較した:

| case | lib 構造 | 変更関数 | diff の種類 | observation (slow≡fast) | verdict |
|---|---|---|---|---|---|
| chalk-27a | 単一ファイル CommonJS (chalk@1.x) | 内部 `self()` | 引数短絡 (`arguments.length === 1 ? …`) | ANSI 文字列配列 240 要素一致 | **equal** |
| chalk-28 | 単一ファイル (chalk@0.4) | `applyStyle()` | `reduce` → `for-loop` 書き換え | 複合スタイル 200 要素一致 | **equal** |
| cheerio-386b | multi-file (`index.js + lib/api/*.js`) | `removeClass()` | `_.difference` → `indexOf/splice` | 最終 HTML + class 属性一致 | **equal** |

3 件すべて slow と fast の observation・postState・exception が完全一致。閾値の最上段 `accepted` に到達。

実証された点:
- CommonJS `module.exports`/`require` 構造を保ったまま `$BODY$` 置換で穴あき lib を生成し、`createRequire(libBase)` で deps (ADR-0017 lockfile-vendored) を解決して実行できる
- ADR-0012 で予約済の Node グローバル shim (`process`/`Buffer`/`setImmediate`) で SUT の require が `ReferenceError` ゼロで通る
- multi-file lib (cheerio) でも変更ファイル 1 つだけを穴あき版に差し替える形で成立する

### 受け入れ判定 (spike 駆動、accept 時点で確定)

3 件の手書きケース (Chalk 27a / Chalk 28 / Cheerio 386b) で「変更前 / 変更後とも実行成功 + observation 取得 + 等価判定相当 (equal もしくは正当な not_equal)」を以下の閾値で判定した:

| spike 結果 | ADR の最終 status |
|---|---|
| 2 件以上 (≥ 2/3) | `accepted` — 順 3-2 で本実装着手可 |
| 1 件 (1/3) | `accepted (scope 縮小: 純粋計算系 lib のみ)` — 救済対象を Chalk-like (return が serializable な計算系) に絞り、HTML 操作系 / HTTP 系は別 ADR で扱う条項を §トリガーに残す |
| 0 件 (0/3) | `rejected` — server 26 件は構造的限界として threats に残す |

**実測結果**: 3/3 equal (上記 §「spike 結果サマリ」参照)。閾値の最上段 `accepted` に到達。

主要な根拠:
- 5 系統の問題のうち本 ADR が解くのは「server CommonJS lib が assemble 経路に乗らない」1 系統のみ。他は他 ADR の管轄。
- ADR-0012 で予約済の vm executor + server Node グローバル注入を**実際の preprocess 経路から呼ぶ最小単位の決定**であり、新規概念の導入はゼロ (= 既存 ADR の組み合わせ)。
- `mb-analyzer/` 本体への変更は順 3-2 別 PR に切る (PR 分割原則: 地ならし + 本丸の分離)。

## 設計の骨子 (本実装は順 3-2)

本 ADR は判断のみ。実装意味論 (関数シグネチャ・データフロー) は順 3-2 PR で `ai-guide/code-map.md` に書く。本節は **コードベースで何がどう変わるか** を最小単位のファイル変更で示す。

### 変更マトリクス (順 3-2 で入る差分の所在)

| # | 種類 | ファイル | 変更内容 |
|---|---|---|---|
| 1 | 新規 | `mb-analyzer/src/preprocessing/selakovic/assemble/strategies/server-changed-fn.ts` | 新 strategy。`module.exports.xxx = function (...) { $BODY$ }` 形で holed lib を組み立てる builder。既存 `strategies/changed-fn.ts` (browser-style 連結) と並列に置き、IIFE 連結ではなく CommonJS 構造を保持する。 |
| 2 | 既存改修 | `mb-analyzer/src/preprocessing/selakovic/pipeline.ts` の `preprocessServer()` (line 200-242 周辺) | 現状: server は 1 candidate 固定で `setup: ""`, `slow/fast = buildServerRunnable(test_case)` のみ組み立てる (= changed-fn 経路に乗らない)。改修後: lib 側に real change があるとき `findChangeUnits` + 新 strategy で changed-fn candidate を追加する分岐を入れる。`buildServerRunnable` を捨てるのではなく、aspect = workload-only の場合は従来通り維持。 |
| 3 | 既存改修 | adapter 側 `environment` 派生箇所 (= ADR-0024 で `equivalence-checker/oracle-routing.ts` 起点。具体的に Python 側 `mb_scanner/use_cases/equivalence_verification.py` か TS 側 `build_equiv_input` 同等) | `layout === "server" && wrapper_kind === "top_level"` のとき `environment: "vm"` を返す 1 分岐を追加。ADR-0024 末尾「現状は常に jsdom」を覆す。 |
| 4 | (触らない) | `mb-analyzer/src/equivalence-checker/common/sandbox/executors/vm.ts` | ADR-0012 §「server 系 SUT 用に最小 Node グローバル + `.json` require」で既に実装済 (Phase 2b)。順 3-2 では 3. の env 分岐で初めて preprocess 経路から呼ばれる。コード追加なし。 |
| 5 | (触らない) | `mb-analyzer/src/contracts/preprocessing-contracts.ts` 等 contract 群 | `environment` フィールドは ADR-0024 で既に存在。本 ADR は値域 `vm` を活性化するだけで型・形は変えない。paired-change なし。 |

### 整合性メモ

- **ADR-0023 `$BODY$` 置換規約**: 1. の新 strategy 内で setup string 中の `$BODY$` を slow/fast 各 1 回置換する。既存 `changed-fn.ts` と同じ規約を踏襲し、helper は `ast/inspect.ts` の汎用群を再利用 (ADR-0024 §AST helper 集約と整合)。
- **ADR-0014 case-split**: server changed-fn でも lib 側変更関数 × workload で複数 candidate を組む点は client changed-fn と同じ枠組み。independent split は client 側と同じ判定で良い。
- **recorder Proxy の境界** (C6 interaction trace): 本 ADR では未確定。`module.exports` 全体を Proxy で包むか、`init()` の戻り値だけを包むかは順 3-2 で詰める。`assemble/recorder-hooks.ts` (現状は server で `init`/`setupTest` 戻り値を包む構造) の境界判断に新 ADR が要るかもしれない (= §トリガーに該当条項あり)。

## 結果 / 影響

採用 (accepted) の場合に得るもの:
- server × top_level 26 件のうち spike 推定で N 件 (= 2/3 換算で ~17 件) が verdict 到達。Phase 3 ゴール「funnel ②→③ DROP < 10」への寄与大。
- vm executor (ADR-0012) が actual に preprocess 経路から呼ばれる初の事例になり、ADR-0012 §C-1 (Playwright fallback 0 発火) と並ぶ「環境別分岐の最小決定例」として後続 ADR の参照点になる。
- contract 変更ゼロ (`environment` フィールドは ADR-0024 で既に存在、本 ADR では値域 `vm` を活性化するだけ)。

諦めるもの・将来のコスト:
- CommonJS dep 解決は ADR-0017 lockfile-vendored 前提でロックインされる。npm registry から dep が消えると spike 自体が再現不能になる (ADR-0017 のトリガーと連動)。
- recorder Proxy の境界決定が順 3-2 に持ち越される。C6 interaction trace の oracle 結果に影響する可能性があり、順 3-2 PR でも spike 同等の事前検証が要る。
- ESM (`import`/`export`) を使う lib は本 ADR の射程外。Selakovic 2016 dataset には ESM lib は無い前提だが、将来 dataset 拡張時は別 ADR。

## トリガー (再検討の条件)

以下のいずれかが成立したら本 ADR を見直す:

- spike (本 PR) で `accepted (scope 縮小)` または `rejected` になったとき → scope 拡大には新 spike が要る
- ESM (`import`/`export`) を使う server lib が dataset に追加されたとき → 本 ADR の射程外、新 ADR を起票
- npm registry から SUT dep が失われ ADR-0017 lockfile install が壊れたとき → ADR-0017 のトリガーと連動
- vm executor では DOM-like API を内蔵呼出する server SUT (例: cheerio の内部で document-like API を叩く実装) が判明し、vm globals で polyfill しきれないとき → ADR-0012 fallback (Playwright) の trigger 1 と合流するか、本 ADR を superseded する
- recorder Proxy の境界決定 (順 3-2) で C6 interaction trace が両側 N/A になることが判明したとき → 順 3-2 で oracle 設計を変えるか、本 ADR を superseded する

トリガー発火時は新 ADR を起票し、本 ADR は `superseded by ADR-NNNN` に書き換える。

## 補足

- spike (3 件分の手書き setup/body/workload + node:vm runner) はローカル scratch (`tmp/`、commit せず) で実施。結果は上記 §「spike 結果サマリ」に転記済で本 ADR は self-contained。
- 上流参照: `research/src/research/preprocess_workload_reachability/notes/v1-notes.md` §153「Node-module スタイル構造的限界」(本 repo 外、ai-research-workspace 側)。
- baseline 数値: `tmp/0036_d-gamma-baseline/funnel-baseline.md` §layout × wrapper_kind cross (server × top_level = 0/26 到達)。
