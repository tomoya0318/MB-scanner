# ADR-0016: Selakovic dataset が同梱していない npm dep を、fork に lockfile で宣言して解決する

- **Status**: accepted (2026-05-10、ユーザ確認済)。fork repo `tomoya0318/selakovic-2016-issues` の作成・dep 宣言・submodule 付け替えまで実装済 (PR #10、submodule pointer = `e6a8e15`)。前提の実証ステータスは `tmp/phase2b-adr-assumption-audit.md` §C-5/§C-6。
- **Date**: 2026-05-10
- **Related**: ADR-0011 (preprocess 段1 が SUT lib `<lib>_*.js` を特定 — どの lib の dep が要るかの入力), ADR-0012 (実行環境 — sandbox は dep が `createRequire` で引ける状態で body を走らせる), ADR-0015 (構造 — fork 方式では adapter が vendor パスを渡す必要がなくなり `createRequire(moduleBaseDir)` のままで済む = adapter config から vendor リスト行が消える), `.gitmodules`, `data/selakovic-2016-issues/` (= fork), `data/selakovic-2016-issues/MODIFICATIONS.md`, `data/selakovic-2016-issues/scripts/install-vendor-deps.sh`, `mb-analyzer/src/equivalence-checker/sandbox/`, `ai-guide/datasets/selakovic-2016-issues.md`, `tmp/phase2b-adr-assumption-audit.md` §C-5/§C-6, `tmp/0002_phase1-adr-and-spike/spike-results.md` §6, `tmp/0003_phase2a-preprocess-rework/verify-97-results.md`

## このADRの守備範囲

このADRが決めるのは **「SUT lib (`<lib>_*.js`) や `init()` が `require` する npm dep を、等価検証 sandbox がどう用意するか」だけ**。

**扱わないこと** (他 ADR の管轄。本 ADR は該当箇所を 1 行参照するだけ):
- どの実行環境 (jsdom/vm/Playwright) で body を走らせるか → **ADR-0012**
- preprocess の SUT lib 特定 → **ADR-0011**
- equivalence-checker の `common`/`selakovic` 二層化・oracle 配置・adapter config → **ADR-0015** (本 ADR の決定により、adapter が渡す config から「SUT lib の npm dep の vendor リスト」が*消える* — fork 側で解決されるため)

## コンテキスト

等価検証は `(setup, slow, fast)` を sandbox 実行する (ADR-0012 = jsdom+vm 主軸)。server 系の `<lib>_*.js` (例 `chalk_before.js`) や `init()` が `require('escape-string-regexp')` 等の npm dep を呼ぶが、**Selakovic dataset (`data/selakovic-2016-issues/` = `marijaselakovic/JavaScriptIssuesStudy` の git submodule、上流 commit `c2f63062` 固定) はその npm dep を同梱していない** — dataset の `package.json` は jsexecutor の dep しか持たず、SUT lib の dep は列挙されておらず `node_modules` も無い (`spike-results.md` §6)。

dep を解決しないと `init()` が `require('<lib>_*.js')` → さらに `require('<npm-dep>')` で落ち、slow/fast が同じエラーを投げ、`test()` が一度も走らないまま「両側同じ → equal」になる。Phase 2a の 97 件実走で **101 件の equal のうち 19 件がこの trivial-equal** だった (Chalk×3 / Cheerio×8 / Mocha / Request×2 / Socket.io×2 / Backbone×3、全部 serverIssues / clientServerIssues — `verify-97-results.md`)。実際に patch を exercise した上での equal は 82 件。

現状 sandbox の executor は `createRequire(join(moduleBaseDir, "package.json"))` で specifier を解決する。`./<lib>_*.js` のような relative は `module_base_dir` (= issue ディレクトリ) 起点で引けるが、bare specifier (`escape-string-regexp` 等) は dataset の package.json に dep が無いので失敗する。node の解決規則は dir tree を上に辿る (`<issueDir>/node_modules/` → `<親>/node_modules/` → … → `<datasetRoot>/node_modules/`) ので、**dep が issue dir から到達可能な `node_modules/` にありさえすれば `createRequire` がそのまま引ける** — 追加の解決ロジックは要らない。問題は「その `node_modules/` をどう用意するか」だけ。

## 選択肢

- **A. fork に lockfile で dep を宣言 (本案)**: `marijaselakovic/JavaScriptIssuesStudy` を fork し、`<lib>_*.js` が `require` する npm dep を `package.json` + `pnpm-lock.yaml` として宣言する (transitive 込み、版は lib の上流 commit の `package.json` に合わせる)。`node_modules/` は commit せず gitignore し、`pnpm install --frozen-lockfile` で再生成する。MB-scanner の submodule をその fork に付け替える。dataset の不完全さ (require するのに dep を宣言していない) を source で直す形。issue の中身 (`*.js` patch・`Description.md`・`Confirmed.md`・選定・構造) は無改変。
- **A'. A + tarball archive**: A に加えて各 dep の npm tarball を fork に同梱し、registry が消えても install できるようにする。registry 消失耐性が上がるが unpack script と repo サイズ増を抱える。
- **B. 別 dir に vendor + require shim の二段解決**: dep を `fixtures/selakovic-sut-deps/<lib>/node_modules/` に vendoring してコミットし、sandbox の require shim を「relative は `module_base_dir` 起点、bare は adapter から渡された vendor dir 群を順探索」の二段にする。`EquivalenceInput` に `vendor_dirs` を足す等の契約変更と二段解決の実装が要る。
- **C. stub**: dep を最小モック (`module.exports = {}` 等) で差し替える。workload が exercise する path で dep の戻り値が patch の効果に効くと弱い equal を量産する (cheerio↔htmlparser2 は本体機能で stub だと結果が出ない / chalk は stub だと `chalk.X` が undefined になり crash — `spike-results.md` §6)。**弱すぎる**。
- **D. fork に `node_modules/` ごと commit**: A の「lockfile + install」の代わりに、生成した `node_modules/` の実体を fork に commit する。checkout だけで動くが、`node_modules` を git に commit するのは GitHub アンチパターン (pnpm の symlink + content-addressable 構造、24MB を 1 commit でレビュー不能、Windows 互換性・再生成の透明性に難)。

### 評価

| 軸 | A (lockfile vendored) | A' (+ tarball) | B (別 vendor + 二段 shim) | C (stub) | D (node_modules commit) |
|---|---|---|---|---|---|
| 再現性 (版固定) | ✓ (integrity hash) | ✓ | ✓ | ✓ | ✓ |
| checkout だけで動くか | ✗ (install 1 step) | ✗ (展開 1 step) | ✓ | ✓ | ✓ |
| registry 消失耐性 | ✗ (registry live 前提) | ✓ (tarball が repo に) | ✓ | ✓ | ✓ |
| dep の戻り値が patch の効果に効くケースで正しいか | ✓ | ✓ | ✓ | ✗ (弱い equal / crash) | ✓ |
| checker 側の追加実装 | **なし** (`createRequire` のまま) | **なし** | 二段 require shim + `EquivalenceInput` 契約変更 | stub 群 | **なし** |
| GitHub ベストプラクティス整合 | ✓ (`node_modules` は ignore) | ✓ | ✓ | ✓ | ✗ |
| 運用 / レビュー透明性 | ✓ (`package.json` で意図が読める、diff 小) | △ (script + tarball) | △ (checker の shim が要る) | △ | ✗ (24MB 1 commit) |
| repo サイズ | 数百 KB (lockfile のみ) | 数 MB (tarball 圧縮) | 数 MB (vendor ソース) | 小 | 24 MB+ (uncompressed) |

## 決定

**A (fork に lockfile で dep を宣言) を採用する。**

主要な根拠:
- **checker 側の実装がゼロで済む** — dep が各 issue dir から到達可能な `node_modules/` にあれば、現状の `createRequire(moduleBaseDir)` がそのまま引く。二段 require shim も `EquivalenceInput.vendor_dirs` も adapter の vendor パス config も要らない (= ADR-0015 の adapter config から「SUT lib の npm dep の vendor リスト」行が消える)。
- **source で直す** — dataset は「require するのに dep を宣言していない」という意味で不完全。それを完全にするのが本筋で、外部 vendor + shim (B) は workaround。
- **GitHub ベストプラクティス整合 + 運用透明** — `node_modules` は gitignore し lockfile を commit する。10 個の `package.json` で「どの issue にどの lib のどの dep が要るか」が読め、diff が小さくレビュー可能。`node_modules` を git に commit する D は pnpm の symlink/content-addressable 構造・24MB 1 commit でこれを満たさない。
- workload が exercise する path で dep の戻り値が patch の効果に効きうる以上、stub (C) は不可。
- 完全な registry 消失耐性 (A は registry live 前提) は犠牲にするが、`pnpm-lock.yaml` の `integrity` hash で全 transitive dep を byte-for-byte 固定するので、registry が live な限り再現性は担保される。長期 (10 年規模) の archive 要件が出たら **将来の nix derivation (新 ADR)** で content-addressable cache を別途用意する段階的アプローチにする。

honesty: 「上流 (`marijaselakovic/JavaScriptIssuesStudy`) が宣言していない npm 依存を `package.json` + `pnpm-lock.yaml` として fork で宣言した。issue 内容・ラベル・選定・構造は無改変。変更点は fork の `MODIFICATIONS.md` と commit 履歴に明記」— これは研究記述として honest。査読者が気にするのは*研究対象 (patch・ラベル・選定)* の改変であり、ランタイム依存の宣言追加は明示すればクリーン。

### fork の precise な変更内容

fork: `marijaselakovic/JavaScriptIssuesStudy` (上流 commit `c2f63062`) → **`tomoya0318/selakovic-2016-issues`** (submodule pointer `e6a8e15`)。

- 10 箇所の vendor location に `package.json` + `pnpm-lock.yaml` を追加。配置戦略は「**版衝突がある場合は issue 単位、無い場合は親で共有**」 — chalk@1 (27a/27b) ↔ chalk@0.4 (28) / request@2.12 (403) ↔ request@2.45 (1165) / socket.io@0.8.5 (573) ↔ 0.8.7 (689) は版が非互換なので issue 単位、cheerio@0.13.1 (8 issue 共通) / backbone (4 issue 共通、underscore@1.13.8 が全 range を満たす) は親で共有。全リストは fork の `MODIFICATIONS.md`。
- `.gitignore` に `node_modules/` / `.pnpm-store/` / `.DS_Store` を追加 — `node_modules/` は **commit しない**。
- `scripts/install-vendor-deps.sh`: 上記 10 箇所で `pnpm install --frozen-lockfile` を順次実行して `node_modules/` を再生成する。
- `MODIFICATIONS.md`: 配置戦略・宣言依存リスト・install / lockfile 再生成手順・再現性の注記・known-unrunnable (ember/9991, react/934, moment/1785) を明記し auditable にする。
- **issue の中身は一切触らない** — `*.js` patch・`Description.md`・`Confirmed.md`・issue 選定・ディレクトリ構造は上流と byte-identical。

### MB-scanner 側の変更

- `.gitmodules`: URL を `git@github.com:tomoya0318/selakovic-2016-issues.git` に変更 (PR #10 で実施済)。
- submodule pointer: `e6a8e15` (fork master、lockfile 宣言マージ後) に更新 (PR #10 で実施済)。
- `ai-guide/datasets/selakovic-2016-issues.md` に fork の変更内容と「vendor deps の install」手順を記載 (本 ADR と同じブランチで実施)。
- **checker 側はゼロ** — dep が各 issue dir から到達可能な `node_modules/` にあれば、現状の `createRequire(moduleBaseDir)` がそのまま引く (node の上向き dir 解決)。

## 結果 / 影響

得るもの:
- server 系の 19 trivial-equal が「実際に `test()` が走った上での equal/not_equal」になり、検証の実効カバレッジが上がる。
- checker 側の dep 解決ロジックは追加ゼロ (`createRequire(moduleBaseDir)` のまま)。ADR-0015 の adapter config から vendor リスト行が消える。`EquivalenceInput` の契約変更も不要。
- GitHub ベストプラクティスと整合 (`node_modules` は gitignore、lockfile を commit)。10 個の `package.json` で意図が読め、diff が小さくレビュー可能。repo サイズは数百 KB (D の 24MB+ に対し ~100x 小さい)。
- fork した dataset が self-contained・再現可能 (lockfile の integrity hash で版固定、submodule pointer で commit 固定)。

諦めるもの・将来のコスト:
- checkout だけでは動かない — `data/selakovic-2016-issues/scripts/install-vendor-deps.sh` を 1 回実行して `node_modules/` を再生成する手順が要る (mise task / start-worktree skill で自動化する)。
- registry 消失耐性は npm registry の SLA に依存 — 10 年規模の archive 保証は将来の nix derivation で別途担保する (本 ADR の段階アプローチ)。
- dataset の fork を所有・維持する (dataset 自体は 2016 年で凍結なので一度 pin したら更新不要。論文で引くなら投稿時に Zenodo 等で archive)。
- 妥当性記述に「上流が宣言しない npm dep を fork で宣言した」の 1 文が加わる (issue 内容無改変なので結果への影響は無いが明示する)。

## トリガー (再検討の条件)

以下のいずれかが成立したら本 ADR を見直す:

- npm registry から該当パッケージが unpublish され `pnpm install --frozen-lockfile` が壊れた → 当該 tarball を fork に同梱する (= 方式 A')。
- 論文 archive 等で 10 年規模の再現性保証が必須要件になる → **nix derivation** (node2nix / dream2nix 等) で content-addressable cache 方式を新 ADR として起票する。
- ある lib の transitive dep tree が巨大、または native addon (要ビルド) を含み install が現実的でない → その lib *だけ* stub または除外と判断し本 ADR の補足に追記する (= 方式の変更ではなく個別判断)。socket.io / request はその可能性があったが `MODIFICATIONS.md` の通り宣言済。
- 別 dataset を対象に加え、その dataset が独自の dep 解決方式を要求する (dep が既に同梱・fork 不可・registry に無い古い版) → その dataset には別の方式 (B = 別 vendor + 二段 shim 等) を適用し本 ADR を見直す。

トリガー発火時は新しい ADR を起票し、本 ADR は `superseded by ADR-NNNN` に書き換える。

## 補足

- **方式の変遷**: 本 ADR の初版は B (別 dir vendor + require shim 二段解決) を採っていた → 2026-05-10 に「checker 側実装ゼロ + source で直す + self-contained」を理由に「fork に dep を追加」へ変更し、その実装方式として一旦 D (`node_modules/` ごと commit) を試行 (`/tmp/sel-fork` ローカル master、unpush) → push 段階で「`node_modules` を git に commit するのは GitHub アンチパターン」と判明し、最終的に A (lockfile vendored) に落ち着いた (ユーザ確認済)。B は将来 fork できない dataset を加える場合の代替として選択肢に残す。D は破棄。
- Phase 1.0 スパイクでは `escape-string-regexp@1` / `ansi-styles@2` / `strip-ansi@3` / `supports-color@2` / `has-ansi@2` を spike dir に install して chalk-27a を正常実行できた (`spike-results.md` §6)。全 lib の宣言依存と版は fork の `MODIFICATIONS.md` の表に確定済。
- `MochaIssues/issue_701` は `init()` が空で mocha を `require` しないので dep 問題を踏まなかった (= mocha lib の変更が unexercised — 別の課題、ADR-0014 の `lib_referenced_by_workload` ヒューリスティック関連)。`<lib>_*.js` が `require` する issue (763) には mocha の dep を宣言してある。
- fork の `MODIFICATIONS.md` / commit メッセージは本 ADR を **「ADR-0017」** と参照しているが、これは fork 作成時の番号取り違え (このリポジトリでは ADR-0017 = 実行前 transform、本 ADR = ADR-0016)。fork 側の参照は次回 fork を触る機会に「ADR-0016」へ訂正する。
- **2026-05-11 (Phase C-1): jsdom executor の require shim に `.../node_modules/<dep>` → bare の fallback を追加** — 本 ADR の「checker 側の dep 解決ロジックは追加ゼロ」に対する小さな例外。pnpm の shared install は dep の実体を上位 dir の `node_modules/` に置くため `<issueDir>/<lib>/node_modules/<dep>/` という物理パスは存在しないが、dataset の一部 `test_case_*.js` (Selakovic の Backbone 系) は lib の transitive dep を `require('./<lib>/node_modules/underscore')` のように hardcode 相対パスで参照する。`createRequire` の relative 解決はこのパスでは `ENOENT` になるので、shim は **relative 解決失敗時に末尾 `/node_modules/<dep>` パターンを bare module 名として抜き出し `createRequire` で再解決する** (`common/sandbox/executors/jsdom.ts` の `installRequire`)。bare 解決も失敗したら元の `ENOENT` を投げる (= error 分類で可視化)。これは「dep の用意の仕方」(= 本 ADR の本題、方式 A = fork の lockfile + pnpm install) は不変で、dataset 側が hardcode した物理パスと pnpm の shared layout の不整合を吸収するだけの個別救済。トリガー発火 (= 方式変更) ではないので superseded にはしない。
