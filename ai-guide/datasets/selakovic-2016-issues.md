# Selakovic 2016: JavaScript Performance Issues Dataset

等価性検証器 (`mbs check-equivalence`) の評価に利用する従来研究データセット。98 件の JS パフォーマンス改善 PR を収集したもの。

- 出典: Selakovic & Pradel, "Performance issues and optimizations in JavaScript: an empirical study" (ICSE 2016)
- 一次配布元: https://github.com/marijaselakovic/JavaScriptIssuesStudy (論文著者 repo)
- submodule 参照先: **上流を fork した `tomoya0318/selakovic-2016-issues` を参照** (ADR-0016)。fork の変更内容は「`<lib>_*.js` が `require` する npm dep を `package.json` + `pnpm-lock.yaml` として宣言した」だけ (`node_modules/` は commit せず、fork root の `scripts/install-vendor-deps.sh` = 各 vendor location で `pnpm install --frozen-lockfile` で再生成) — issue の中身 (`*.js` patch・`Description.md`・`Confirmed.md`・選定・ディレクトリ構造) は無改変。変更点は fork root の `MODIFICATIONS.md` と commit 履歴に明記。
- ライセンス: **上流 repo に記載なし**。GitHub の ToS では public repo の fork は許容、引用ベースの学術利用は慣行上問題ない。fork が lockfile で宣言する npm dep は各々が独自のライセンス (MIT 系) を持つ (install 時に `node_modules/` 内へ LICENSE ファイルごと展開される — fork 自体にはソースを置かない)。派生データセットを再配布する場合は上流著者に要確認。

## 配置

```
data/selakovic-2016-issues/   # git submodule (.gitmodules + .gitignore 例外) → tomoya0318/selakovic-2016-issues (上流の fork)
```

**git submodule 方式 + fork** を採用している理由:
- commit SHA が `.gitmodules` + submodule ポインタとして親 repo にコミットされるため、**評価の再現性**が保証される (fork した側の commit に固定)
- 上流 (`marijaselakovic/JavaScriptIssuesStudy`) は SUT lib の npm dep を宣言しておらず、それが無いと server 系 issue が `init()` の `require('<lib>_*.js')` → さらに `require('<npm-dep>')` で落ち「両側同じエラー → trivially equal」になる (Phase 2a 実走で 19/101 件、`tmp/0003_phase2a-preprocess-rework/verify-97-results.md`)。→ fork に dep を lockfile で宣言して解決 (ADR-0016。install 後、`createRequire(moduleBaseDir)` が node の上向き dir 解決で issue dir から到達可能な `node_modules/` を引く = checker 側は実装変更ゼロ)。
- 上流著者の repo を直接 submodule にすると dep が宣言されておらず動かないので、fork が必要。fork は dataset 自体が 2016 年で凍結なので一度作って commit pin したら更新不要。
- 一次配布元 (`marijaselakovic/JavaScriptIssuesStudy`) はライセンス未明記のまま消滅するリスクがあり、自家 fork を pin 先とすることでアクセス安定性も確保される (npm dep 宣言目的とは別の副次的メリット)。
- worktree 間で git objects (履歴・圧縮データ) は `main/.git/modules/selakovic-2016-issues/` に一元化される (実ファイルのみ worktree ごとに展開)

### 新規 clone 時

```bash
git clone --recurse-submodules <this-repo-url>
```

### 既存 clone / 新 worktree で実ファイルを展開

```bash
git submodule update --init --recursive
```

`start-worktree` skill の `SETUP_COMMANDS` ([`open-in-cmux.sh`](../../.agents/skills/start-worktree/open-in-cmux.sh)) に組み込み済みのため、新 worktree では自動展開される。

### vendor deps の install (ADR-0016)

fork は server 系 issue の SUT lib (`<lib>_*.js`) が `require` する npm dep を `package.json` + `pnpm-lock.yaml` として宣言しているだけで、`node_modules/` は commit していない (`.gitignore` 済)。submodule update 後、

```bash
(cd data/selakovic-2016-issues && ./scripts/install-vendor-deps.sh)   # pnpm が PATH に要る
```

を 1 回実行すると、10 箇所の vendor location で `pnpm install --frozen-lockfile` が走り `node_modules/` が lockfile から再生成される。これにより `init()` の `require('<lib>_*.js')` → `require('<npm-dep>')` が解決でき、server 系 19 件の trivial-equal が「実 `test()` が走った上での equal/not_equal」になる。配置戦略 (版衝突は issue 単位 / それ以外は親共有) と宣言依存の全リストは `data/selakovic-2016-issues/MODIFICATIONS.md` を参照。

> install を未実行の状態で server 系 issue を等価検証すると、上流と同じく `Cannot find module` で trivial-equal に戻る。`mbs preprocess-selakovic-batch` / `check-equivalence-batch` 系を server 系で回す前に install が要る (mise task / start-worktree skill での自動化は別途)。

## ディレクトリ構造

```
selakovic-2016-issues/
├── README.md              実行プロトコル (jsexecutor <before> <after> Nvm Nwarmup Nmeasure 0.9)
├── Description.md         98 件の PR 番号・ライブラリ・変換説明・root cause 一覧
├── Confirmed.md           上流に accept された最適化の報告
├── jsexecutor*.js         Node 側ベンチマーク実行器 (warmup 付き版あり)
├── browserJsExecutor.js   ブラウザを spawn して v_*.html を実行
│
├── clientIssues/          ブラウザ専用 (DOM/jQuery 依存) — 32 件
│   └── {Angular,Ember,JQuery,React}Issues/issues/issue_NNNN/
│       ├── v_before.html, v_after.html            ← 等価性検証対象 (<script> 内 f1)
│       └── <lib>_before.js, <lib>_after.js, <lib>.js~
│
├── serverIssues/          Node 専用 (fs/chalk など) — 17 件
│   └── {Chalk,Cheerio,Mocha,Request,Socket.io}Issues/issues/issue_NN/
│       ├── test_case_before.js, test_case_after.js   ← ハーネス (init/setupTest/test)
│       └── <lib>_before.js, <lib>_after.js           ← 等価性検証対象
│
└── clientServerIssues/    両方で走る中立ライブラリ — 28 件
    └── {Backbone,Ejs,Moment,NodeLruCache,Q,Underscore,Underscore.string}Issues/issues/issue_NN/
        ├── test_case_before.js, test_case_after.js   ← Node ハーネス
        ├── v_before.html, v_after.html               ← ブラウザハーネス (冗長系)
        └── <lib>_before.js, <lib>_after.js           ← 等価性検証対象
```

## 等価性検証器の `{setup, slow, fast}` への対応 (ADR-0011 Tier 2)

前処理は **2 段** (ADR-0011 §段1/§段2、`mb-analyzer/src/preprocessing/selakovic/`):

- **段 1 (役割分解 + 計測ハーネス除去)**: issue ディレクトリから ① `<lib>_before(.js|/)` / `<lib>_after(.js|/)` のペア (dir scan、`<script src>`/`require` 参照とは独立 — clientIssues でも `<lib>_*.js` を必ず読む) と ② ベンチマーク関数 body (clientIssues: inline `<script>` の `f1` body / server: `test_case_*.js` の `test()` body) を取り出す。計測ハーネス (`var a = execute(f1, n)` 以降 / `$.ajax({mark,mean})` / `console.log(mean)` / `init`/`setupTest`) は setup へ回すか破棄。`f1`/`test()` body 内のループ反復回数は書き換えない (= 復元可能性のため、反復縮小は等価検証側の transform — ADR-0013)。
- **段 2 (作用点ルーティング)**: ①② の実コード差分で **作用点 A** (lib のみ変化) / **B** (body のみ変化) / **A+B** (両方) / **fallback** (どちらも実質差なし / 規約外フォーマット → Tier 1 の素の top-level diff) に振り分け、A+B は ADR-0014 の identifier 交差判定で independent なら `lib candidate` + `body candidate` の 2 つに分割、co-evolution の疑いなら 1 candidate。

| 作用点 | slow / fast | setup | 実行環境 hint |
| :--- | :--- | :--- | :--- |
| **A** (lib のみ変化) | `<lib>_before.js` ↔ `<lib>_after.js` を load して body (before で固定) を走らせる runnable (clientIssues の Angular controller-wrapper は module/controller を再構成して `f1()` を実行) | `""` (lib が slow/fast 側に入る) | jsdom |
| **B** (body のみ変化) | `f1` body ↔ `f1` body / `test()` body ↔ `test()` body (`(function(){ ... })()` で包む) | `<lib>_before.js` (workload が参照する場合) + `f1` 定義より前の statement (clientIssues) | jsdom (server の runnable は `require` 解決のため jsdom) |
| **A+B → lib candidate** | `<lib>_before.js` ↔ `<lib>_after.js` (body は before で固定) | `""` | jsdom |
| **A+B → body candidate** | body の before ↔ after (lib は before で固定) | 同 B | jsdom |
| **fallback** | Tier 1 の素の top-level diff (変更 statement 全体を slow/fast に) | 自分以外の全 top-level statement の before 版 (ADR-0010) | jsdom |

server (`serverIssues` / `clientServerIssues`) は A / B / A+B いずれも 1 candidate (slow/fast = `test_case_{before,after}.js` を `module`/`exports`/`require` 込みで包んで `init()`/`setupTest()`/`test()` を実行する runnable。作用点 A なら `init()` の `require('./<lib>_before')` が `_after` に切り替わり、B なら `test()` body が切り替わる)。`module_base_dir` (= issue ディレクトリ) を `EquivalenceInput` に渡し、jsdom executor が相対 `require` を解決する。

### 境界設定の注意

- **clientIssues の `f1`**: `execute(f1, 10)` に渡されるクロージャで、jsperf ベンチマーク関数に相当。計測ハーネス (`$.ajax({mark})` / `console.log(mean)` 等) は **外側のレポーティング用**なので段1 で除外する (= `mark: 0|1` の値差はもう candidate にならない)。`f1` の AST 親パスは実質 2 種 (top-level 直書き / Angular controller-wrapper)。
- **`<lib>_*.js` の narrowing**: ライブラリ全体 diff には license header / version 文字列 / 整形差が混じる。`lib-diff.ts` が行ベースの multiset 差分で「実コード行が残るか」を見てルーティング判定し、変更関数名を近似する (`tmp/framework-patch-locations.tsv` の `changed_functions` が検算用)。AST ベースの正確な narrowing は Phase 2a〜2b で精度向上。
- **`clientServerIssues/*/v_*.html`**: performance 測定用の browser 再現であり、等価性検証では冗長。物理レイアウト判定 (`detectLayout`) は `v_*.html` があれば `client`、無ければ `server`。`clientServerIssues` は `v_*.html` を持つので `client` 扱いだが、`<lib>_*.js` が単一ファイル形式なので段1 ① で拾い、作用点 A としてルートされる (= 旧来の「client → server-single-file fallback」は不要になった)。

### 前処理パイプライン (擬似コード)

```
for issue_dir in data/selakovic-2016-issues/**/issues/*/:
  layout = detectLayout(issue_dir)                          # client / server / unknown
  libPair = loadLibPair(layout)                             # <lib>_before/after の dir scan (なければ null)
  # 段1: 役割分解
  if layout == client:
    f1_b, f1_a = extractF1(inline_script(v_before.html)), extractF1(inline_script(v_after.html))
    body_changed = ast_diff(f1_b.body, f1_a.body) != ∅
  else:                                                      # server
    t_b, t_a = extractTest(test_case_before.js), extractTest(test_case_after.js)
    body_changed = ast_diff(t_b.body, t_a.body) != ∅
  lib_changed = libPair != null and lib_diff(libPair).has_real_change
  # 段2: 作用点ルーティング
  aspect = route(lib_changed, body_changed)                  # A / B / A+B / fallback
  candidates = build_candidates(aspect, ...)                 # A+B は ADR-0014 で 1 or 2 個
  for c in candidates:
    checker.check({setup: c.setup, slow: c.slow, fast: c.fast,
                   environment: c.environment, module_base_dir: issue_dir})
```

## ground truth (Description.md)

`Description.md` の「変換説明」列をパースすれば、Selakovic 論文 Table 4 の **10 パターン**のどれに該当するか事前分類できる。等価性検証器の期待判定 (equal/not_equal) の ground truth としても流用可能。パースは `tmp/0001_phase0-dataset-analysis/scripts/parse_description.py` (表記揺れを `LIBRARY_NORMALIZE` / `ISSUE_ID_ALIAS` / `ROOT_CAUSE_NORMALIZE` で paper 公式呼称に正規化、submodule の Description.md は touch しない)。

## Known dataset issues & 我々の扱い

Phase 0 (`tmp/0001_phase0-dataset-analysis/`、`tmp/dataset-conventions.md`、`tmp/patch-taxonomy.md`) と Phase 1.0/2a で判明した dataset 側の不整合・処理不能ケース。**いずれも上流 / fork の Description.md・patch は無改変** — 訂正は我々の注釈レイヤ (parser の corrections テーブル) と本 doc / threats-to-validity で扱う。

### Description.md ↔ 物理 issue の不一致 (8 件)
- **description 行にあるが物理 dir 無し (3 件)**: `Less/issue_1625_1`・`Less/issue_1831` (Less ライブラリ自体が repo に無い — paper 98 件 vs repo 97 件のズレの主因)、`Moment/issue_1875` (paper 記載あり、repo に dir 無し)。→ データが無いので復元不能。「dataset 側の不整合」として記録し対象外。
- **物理 dir あるが description 行無し (5 件)**: `Backbone/issue_707`・`Cheerio/issue_387`・`Moment/issue_1785`・`Q/issue_169`・`React/issue_895`。→ 物理 issue として処理は走る (root_cause が引けないだけ)。著者ラベルが無い 5 件として記録 — 我々が root_cause をでっち上げることはしない。

### parse / preprocess できない issue (2 件、excluded)
- **`clientIssues/ReactIssues/issue_934`**: inline `<script>` が JSX を含み `@babel/parser` がそのまま parse できない (`jsx`/`flow`/`typescript` プラグインが要る) + 実行には transpile が要る。→ Phase 2a で `excluded`。「preprocess に JSX 対応を足す」は機能追加 (Phase 2b スコープ外、別決定) — 当面 1 件 excluded として記録。
- **`clientServerIssues/MomentIssues/issue_1785`**: patch が `Gruntfile.js` と `moment.js` の 2 ファイルにまたがり、preprocess が単一 `(slow, fast)` ペアにできない (`batch-result.jsonl` の `excluded: multi-file-change`)。→ 同上、当面 1 件 excluded。

### Description.md の root_cause ラベルと実 patch の不一致 (≧4 件)
`tmp/patch-taxonomy.md` §1.3 — 同じ root_cause カテゴリに作用点 A と B が混在する。具体例:
- **`#10351`** (`clientIssues/AngularIssues/issue_10351`): Description.md は "Inefficient API usage" (= 意味論保存の性能最適化) に分類しているが、Phase 1.0 deep probe で workload-observable に非等価と判明 (`$scope.$eval('null.a', {null:{a:42}})` が `42` → `undefined` — `tmp/0002_phase1-adr-and-spike/spike-results.md` §5.1、ADR-0013)。→ 観測強化した checker は `not_equal` を出し dataset ラベルと不一致になる。これは*研究の発見*として threats/discussion に書く (Phase 3 でサンプル手動クロスチェック)。
- **`#8515_8`** (`clientIssues/AngularIssues/issue_8515_8`): Description.md は "Use for loop instead of forEach" だが f1 body 内に forEach が無い → 真 patch は f1 の外側 (`app.controller` の callback)。
- **`angular-4359` / `react-808`**: Phase 0 の `inline-patch-classification.tsv` は inline `<script>` の diff だけ見て `f1_body_only` (作用点 B) とラベルしたが、`<lib>_*.js` 側にも実コード変化があり実は A+B (Phase 1.0 スパイク §4 で実検証)。= root_cause カテゴリ ≠ 作用点。

→ **扱い**: 訂正版の root_cause / 作用点ラベルが要るときは、`parse_description.py` に corrections テーブル (各エントリに根拠) を足して `description-parse.json` に反映する (実装は Phase 2b/3 で description-parse を使うときに)。fork の Description.md 自体は無改変。

### その他の抜け・不確実性
- `clientIssues/*/<lib>.js~` (末尾チルダ): 編集前のバックアップと推測されるが README/wiki に言及なし。**`<lib>_before.js` を正とし `.js~` は無視**するのが安全。
- `<lib>_before.js` / `<lib>_after.js` はライブラリ全体 diff のため、整形やコメントだけの無関係な変更も含む。narrowing 前処理が前提 (`lib-diff.ts`、AST ベース narrowing は Phase 2b で精度向上)。
- 上流が SUT lib の npm dep を宣言していない (上記「配置」§ / 「vendor deps の install」§)。→ fork に lockfile で宣言、`install-vendor-deps.sh` で展開 (ADR-0016)。
- 論文で言及される「新規発見 139 件」は repo に**含まれていない**。
