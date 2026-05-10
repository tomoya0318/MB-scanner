# Selakovic 2016: JavaScript Performance Issues Dataset

等価性検証器 (`mbs check-equivalence`) の評価に利用する従来研究データセット。98 件の JS パフォーマンス改善 PR を収集したもの。

- 出典: Selakovic & Pradel, "Performance issues and optimizations in JavaScript: an empirical study" (ICSE 2016)
- 上流: https://github.com/marijaselakovic/JavaScriptIssuesStudy
- ライセンス: **repo に記載なし**。引用ベースの研究利用は慣行上問題ないが、派生データセットを再配布する場合は著者に要確認。

## 配置

```
data/selakovic-2016-issues/   # git submodule として登録済み (.gitmodules + .gitignore 例外)
```

**git submodule 方式**を採用している理由:
- commit SHA が `.gitmodules` + submodule ポインタとして親 repo にコミットされるため、**評価の再現性**が保証される
- ライセンス未明記の上流 repo を fork せず、参照のみで済む
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

`Description.md` の「変換説明」列をパースすれば、Selakovic 論文 Table 4 の **10 パターン**のどれに該当するか事前分類できる。等価性検証器の期待判定 (equal/not_equal) の ground truth としても流用可能。

## 既知の抜け・不確実性

- `clientIssues/*/<lib>.js~` (末尾チルダ): 編集前のバックアップと推測されるが README/wiki に言及なし。**`<lib>_before.js` を正とし `.js~` は無視**するのが安全。
- `<lib>_before.js` / `<lib>_after.js` はライブラリ全体 diff のため、整形やコメントだけの無関係な変更も含む。narrowing 前処理が前提。
- 論文で言及される「新規発見 139 件」は repo に**含まれていない**。
