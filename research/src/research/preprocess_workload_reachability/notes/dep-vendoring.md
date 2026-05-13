# dep-vendoring タスク一覧 (0022 Phase 3 の一部 / ADR-0016 の client 拡張)

作成: 2026-05-12

## 背景

- ADR-0016 = 「dataset が同梱してない npm dep を fork に lockfile で宣言して解決」。**既に server issue の `require()` dep について実装済**（fork `tomoya0318/selakovic-2016-issues`、10 箇所の vendor location、`scripts/install-vendor-deps.sh` で `node_modules/` 再生成、PR #10、submodule pointer = `e6a8e15`）。
- 0022 Phase 3 の「dep-vendoring」= **client issue の `<script src>` CDN dep**。`clientIssues/EmberIssues/.../v_before.html` の `<script src=".../jquery/2.1.3/...">` 等。jsdom は `<script src>` を auto-load しない → 0022 の方針 (C1) は「executor を触らず、候補の `setup` に dep の `.js` ソースを連結する」。
- 方針 (A) = ①の仕組み（fork の `package.json` + `pnpm-lock.yaml`）を②にも使う。jquery/handlebars/underscore は npm にあるので、fork の client-issue にも宣言 → `install-vendor-deps.sh` で `node_modules/` 再生成 → 0022 の `<script src>` 解決ヘルパが `node_modules/<pkg>/dist/<pkg>.js` を読んで `setup` に連結。`require()` か read-file-and-concatenate かが①との違い。

## `<script src>` 洗い出し結果（全 client/clientServer の `v_before.html` 集計、2026-05-12）

| `<script src>` | 件数 | 扱い |
|---|---|---|
| `../../js/execute.js` | 80 | ハーネス（`execute(f1,n)`）→ skip（preprocess が f1 抽出時に剥がす） |
| `cdn.jsdelivr.net/jstat/1.2.1/jstat.min.js` / `cdn.imnjb.me/libs/jstat/1.0.8/...` / `../../js/jstat.min.js` | 59 / 13 / 8 | ハーネス（`$.ajax({mark,mean})` の統計用）→ skip |
| `<lib>_before.js`（angular 25 / underscore 12 / jquery 9 / ember 9 / backbone 5 / underscore.string 3 / moment 3 / ejs 3 / react 2 / q 1 / nodelrucache 1） | — | **patched lib（SUT）** → 「dep」じゃない。preprocess が `lib_before/after_files` で扱う → skip |
| `JSXTransformer.js` | 2 | React の JSX 変換（React issue 用）→ v1 では skip |
| **`ajax.googleapis.com/.../jquery/2.1.3/jquery.min.js`** | 36 | **vendor 対象** → `jquery@2.1.3` |
| **`ajax.googleapis.com/.../jquery/1.11.3/jquery.min.js`** | 27 | **vendor 対象** → `jquery@1.11.3` |
| **`ajax.googleapis.com/.../jquery/1.7/jquery.min.js`** | 8 | **vendor 対象** → `jquery@1.7.x` |
| **`cdnjs.../handlebars.js/1.1.0/handlebars.js`** | 9 | **vendor 対象** → `handlebars@1.1.0`（Ember） |
| **`cdnjs.../underscore.js/1.8.3/underscore.js`** | 5 | **vendor 対象** → `underscore@1.8.3`（Backbone 等） |

→ vendor すべき: **jquery@{2.1.3, 1.11.3, 1.7.x}, handlebars@1.1.0, underscore@1.8.3** の 5 つ（jstat = ハーネス、`<lib>_before.js` = SUT、`execute.js`/`JSXTransformxqr.js` = ハーネス → 全部 skip）。

---

## フォーク側タスク（`~/dev/research/MB-scanner/selakovic-2016-issues` = fork のクローンで） — ✅ 完了 (PR #2 → fork master `be15a06`、2026-05-12)

- [x] **T1**: 各 client/clientServer issue がどの CDN dep をどの版で要るか **per-issue で洗い出す**（`v_before.html` と `v_after.html` 両方 — 版が before/after で違うことがある。例: Ember 4158 = `v_before.html` が jquery 2.1.3 を載せてるが Ember 1.5 と非互換、`v_after.html` は？）。出力 = `issue → [{pkg, version}]` の表。
  - 参考コマンド: `for f in $(find clientIssues clientServerIssues -name "v_*.html"); do echo "=== $f ==="; grep -oiE '<script[^>]*src="[^"]+"' "$f" | sed 's|.*src="||;s|"||'; done`
- [x] **T2**: ADR-0016 のレイアウト規約で **配置場所を決める**（「版衝突あれば issue 単位、無ければ親 category で共有」）:
  - 例: `clientIssues/EmberIssues/package.json` = `jquery@2.1.3` + `handlebars@1.1.0` / `clientIssues/EmberIssues/issues/issue_4158/package.json` = `jquery@1.7.x`（category を override — Ember 1.5 × jquery 2.x 非互換のワークアラウンド）。4263（handlebars 欠落）は category-level の `handlebars@1.1.0` 宣言で自動補完される。
  - `clientServerIssues/Underscore.stringIssues/` = `jquery@<版>` / `clientServerIssues/BackboneIssues/` = `underscore@1.8.3` + `jquery@<版>` / 等（T1 の結果次第）。jquery の 3 版（2.1.3 / 1.11.3 / 1.7.x）が同一 category 内で衝突するなら issue 単位に。
- [x] **T3**: `package.json` + `pnpm-lock.yaml` を各場所に追加 — `pnpm install --lockfile-only` で lockfile 生成、既存の server-issue 用と同じスタイル（`MODIFICATIONS.md` の表 / `scripts/install-vendor-deps.sh` の中身を参考に）。
- [x] **T4**: `scripts/install-vendor-deps.sh` を更新 — 今は server の 10 箇所をインストール → client-issue 用の場所も追加。
- [x] **T5**: `MODIFICATIONS.md` 更新 — vendor location の表に client 系を追加 + 「client `<script src>` 系の npm dep（jquery/handlebars/underscore）も宣言するようになった。server の `require()` dep と違い、解決は MB-scanner の preprocess が `node_modules/<pkg>/dist/<pkg>.js` を読んで候補 `setup` に連結する形（jsdom が `<script src>` を auto-load しないため）」と追記。
- [x] **T6** — fork master = `be15a06` (PR #2 `vendor-client-script-src-deps` = commit `8f64b91`)。: commit →（PR →）`master` に merge → push。**新コミットハッシュをメモ**（MB-scanner 側の submodule bump で使う）。

## MB-scanner 側タスク（このリポジトリで、フォーク merge 後）

- [x] **M1**: submodule pointer の更新。
  - [x] (おまけ・先行) submodule の `origin` を上流 (`marijaselakovic/JavaScriptIssuesStudy`) → フォーク (`tomoya0318/selakovic-2016-issues`) に修正済 (`git -C data/selakovic-2016-issues remote set-url origin ...` + `git fetch origin`)。fork 到達確認済 (`origin/master` = `e6a8e15` = 現 HEAD、`origin/lockfile` ブランチもあり)。submodule status クリーン。これは `.git/config` のローカル変更なので commit 不要
  - [x] (T6 後) submodule を `be15a06` に checkout → 親 repo の gitlink を bump (MB-scanner commit `8e6a52c`)
- [x] **M2**: `<script src>` 解決ヘルパ — **`mb-analyzer/src/preprocessing/selakovic/io/script-deps.ts` 新設**（`selakovic/index.ts` に export）。
  - `classifyScriptSrcs(html, patchedLibFilenames): ScriptSrcEntry[]`（純関数）— `<script src>` を出現順に `harness`（`execute|jsexecutor|jstat|JSXTransformer`）/ `patched-lib`（`lib_*_files` のキー or `_before.js`/`_after.js` 接尾）/ `cdn-dep`（jquery/handlebars/underscore の basename + http(s)|`//` URL、`pkg` 付き）/ `local-other` に分類
  - `resolveScriptDepSources(issueDir, html, patchedLibFilenames): { sources: string[]; missing: string[] }`（I/O）— cdn-dep を「issueDir から祖先方向に最大 8 階層さかのぼり最初に見つかる `<dir>/node_modules/<pkg>/<候補>`」で解決して読む（issue 単位が category 単位より優先 → 4158 の jquery 1.7 override が自然に効く。URL の版は無視）。候補パス: jquery=`dist/jquery.min.js`→`dist/jquery.js`→`jquery.js`、handlebars=`dist/handlebars.min.js`→`dist/handlebars.js`→`lib/handlebars.js`→`handlebars.js`、underscore=`underscore-min.js`→`underscore.js`。解決できなかった cdn-dep / local-other は `missing` に積む
  - in-source test 7 件（分類 5 + 一時 `node_modules/` での解決 2: issue 単位優先 / 無ければ missing）。`mise` lint/tsc/test green（498 tests）
  - ⚠️ 候補パスは推測込み（特に handlebars 1.x のレイアウト）。M6 で実 `node_modules/` を見たら `PKG_FILE_CANDIDATES` を実際の位置に合わせて調整
- [x] **M3**: dep ソースを CLI 入力 → `preprocess()` に配線 — `SelakovicPreprocessInput`（client variant）に `dep_lib_sources: string[]` を追加（CLI が M2 で解決して詰める。これは内部の純関数入力なので JSON 契約じゃない = Python paired-change 不要）→ `pipeline.ts` が `buildChangedFnCandidate(unit, libAfterSrc, f1, dep_lib_sources)` に渡す + embedded builder の `setup` に連結（`buildClientLibCandidate` / `buildClientBodyCandidate` / `buildClientCombinedCandidate` を `setup = [...dep_lib_sources, ...既存].filter(...).join("\n;\n")` に。今 embedded は `setup=""`）。
- [x] **M4**: ADR-0016 に「2026-05-12 更新 (本 ADR の仕組みを client `<script src>` CDN dep にも適用 — 0022 Phase 3)」節を追記。dataset doc (`ai-guide/datasets/selakovic-2016-issues.md`) / code-map.md は task 末の ai-guide 反映で。旧 M4 案: ADR-0016 + dataset doc 更新 — ADR-0016 に「2026-05-12 更新: client `<script src>` 系の npm dep（jquery/handlebars/underscore）もこの仕組みで宣言。違い: server の `require()` dep は sandbox が `createRequire` で引くが、client の `<script src>` dep は jsdom が auto-load しないので MB-scanner の preprocess が `node_modules/<pkg>/dist/<pkg>.js` を読んで候補 `setup` に連結する」。`ai-guide/datasets/selakovic-2016-issues.md` / 該当箇所も。
- [x] **M5**: テスト — `io/script-deps.ts` の in-source 7 件 + `selakovic.test.ts` に「dep_lib_sources は全候補の setup 先頭に連結される」テスト追加。`mise` lint/tsc/test green (499 tests)。旧 M5 案: テスト — resolver の unit test（`<script src>` 分類が正しい / 最寄り `node_modules/` の解決）、`selakovic.test.ts` / CLI test に dep ソースが要るなら更新。`mise run lint-analyzer typecheck-analyzer test-analyzer` green。

## 最後（あなた、brain-2 で）

- [ ] **M6**: `data/selakovic-2016-issues/scripts/install-vendor-deps.sh` を回して `node_modules/` 再生成（client deps 含む）→ 実候補が動く状態に（Phase 5 の準備）。

## 進め方の提案

- あなたが T1〜T6 を別クローンでやってる間、僕は M2（resolver）を**小さい合成 fixture で先に書いて**おく（`node_modules/` のレイアウトを仮定すれば実 dataset 無しでも書ける・テストできる）。T6 が終わったら M1（submodule bump）→ M3〜M5 を繋げる。

## 注

- Phase 3 の残り（`build_prune_input.py` を `verdict==equal` のみに戻す / equiv gate）は dep-vendoring とは独立 → これの後で。
- jstat は今のところ全部「測定ハーネス」判定だが、もし f1 body が `jStat` を参照する issue があれば（無いはず）resolver の skip 判定を見直す。
