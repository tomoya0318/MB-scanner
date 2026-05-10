# ADR-0016: 等価検証 sandbox の SUT module 依存解決を vendor 方式にする

- **Status**: proposed。前提の実証ステータスは `tmp/phase2b-adr-assumption-audit.md` §C-5/§C-6/§C-7 参照（dep 不足が trivial-equal を生む問題は Phase 2a の 97 件実走で実証済 = §C-5。残るのは「4 lib の dep tree 列挙 chore」§C-6 のみ — これは ADR の決定とは別の作業）。`accepted` 昇格はレビュー合意時（chore は accepted の前提条件ではない — 方式は決まっている）。
- **Date**: 2026-05-10
- **Related**: ADR-0011 (preprocess 段1 が SUT lib `<lib>_*.js` を特定), ADR-0012 (実行環境 — sandbox はこの dep を解決した上で body を走らせる), ADR-0015 (adapter config — どの lib に何 dep を何版・vendor dir をどこに置くかは Selakovic adapter が `EquivalenceInput` 経由で渡す), `mb-analyzer/src/equivalence-checker/sandbox/`, `mb-analyzer/src/contracts/equivalence-contracts.ts`, `tmp/phase2b-adr-assumption-audit.md` §C-5/§C-6/§C-7, `tmp/0002_phase1-adr-and-spike/spike-results.md` §6, `tmp/0003_phase2a-preprocess-rework/verify-97-results.md`

## このADRの守備範囲

このADRが決めるのは **「SUT lib (`<lib>_*.js`) や `init()` が `require` する npm dep を、等価検証 sandbox がどう用意するか」だけ** — 方式（install / vendor / stub のどれを採るか）と解決機構（require shim をどう構成するか）。

**扱わないこと** (他 ADR の管轄。本 ADR は該当箇所を 1 行参照するだけ):
- どの実行環境 (jsdom/vm/Playwright) で body を走らせるか → **ADR-0012**
- 「どの lib に何 dep を何版・vendor dir をリポジトリ内のどこに置くか」の具体リスト → **ADR-0015 の adapter config** (本 ADR は方式だけ決め、Selakovic 固有の dep リストは adapter が持つ)
- preprocess 側の SUT lib 特定 → **ADR-0011**

## コンテキスト

等価判定は `(setup, slow, fast)` を sandbox 実行する (ADR-0012 = jsdom+vm 主軸)。server 系の `<lib>_*.js` (例 `chalk_before.js`) や `init()` が `require('escape-string-regexp')` 等の npm dep を呼ぶが、**Selakovic dataset はその npm dep を bundle していない** — dataset の `package.json` (`data/selakovic-2016-issues/package.json`) は jsexecutor の dep (commander/express 等) しか持たず、`node_modules` も無い (`spike-results.md` §6)。さらに dataset は git submodule なので触りたくない。

dep を解決しないと、`init()` が `require('<lib>_*.js')` → さらに `require('<npm-dep>')` で落ち、slow/fast が同じエラーを投げ、`test()` が一度も走らないまま「両側同じ → equal」になる。Phase 2a の 97 件実走で **101 件の equal のうち 19 件がこの trivial-equal** だった (Chalk×3 / Cheerio×8 / Mocha / Request×2 / Socket.io×2 / Backbone×3、全部 serverIssues / clientServerIssues — `verify-97-results.md`)。実際に patch を exercise した上での equal は 82 件。

現状 sandbox の executor は `createRequire(join(moduleBaseDir, "package.json"))` で bare specifier を解決しており、dataset の package.json が SUT lib の dep を持たないので失敗する。

## 選択肢

- **A. 実行時 / CI 時に `npm install`**: 検証実行 (or CI セットアップ) のたびに各 lib の dep を npm から install する。lockfile (`npm ci`) を committed にすれば版は固定できるが、**CI で毎回ネットアクセスが要る** (= checkout だけでは動かない / npm registry の可用性に依存)。lockfile が無ければさらに版ドリフトする。
- **B. vendor (= dep のソースを repo にコミットしておく)**: 各 SUT lib が必要とする npm dep を **一度だけ手元で取得して `fixtures/...` 配下にコミット**する。以降 checkout すれば dep のソースがそこにあり、検証 / CI は `npm install` を一切走らせない。dataset submodule は無変更 (vendor dir は repo 内の別の場所)。古い npm 版のソースを repo に抱えるが、版固定なので更新は不要。
- **C. stub**: dep を最小モック (`module.exports = {}` 等) で差し替える。実装は楽だが、workload (`test()`) が exercise する path で dep の戻り値が patch の効果に効くと **弱い equal を量産**する (cheerio↔htmlparser2 は本体機能で stub だと結果が出ない / chalk は stub だと `chalk.X` が undefined になり crash — `spike-results.md` §6)。

### 評価

| 軸 | A (実行時 npm install) | B (vendor) | C (stub) |
|---|---|---|---|
| 再現性 (版固定) | △ (lockfile 必須) | ✓ (ソースが固定) | ✓ |
| オフライン / checkout だけで動くか | ✗ (毎回ネット必須) | ✓ | ✓ |
| dep の戻り値が patch の効果に効くケースで正しいか | ✓ | ✓ | ✗ (弱い equal / crash) |
| 実装コスト | 中 (install スクリプト + lockfile 管理 + CI ネット) | 中 (一度の vendoring 作業 + require shim 二段解決 + repo にソース) | 小 |
| dataset submodule を触らずに済むか | ✓ | ✓ (vendor dir は別) | ✓ |

## 決定

**B (vendor) を採用する。**

主要な根拠:
- workload が exercise する path で dep の戻り値が patch の効果に surface しうる以上、stub (C) は false negative (弱い equal) を量産する。SUT lib の dep は「ある意味 SUT の一部」なので本物が要る。
- 再現性 + checkout だけで動く — A は CI で毎回 npm registry にアクセスする必要があり、registry の可用性・ネットワークに依存する。vendor ならソースが repo に固定されている。
- dataset (git submodule) を無変更に保てる — vendor dir をリポジトリ内の別の場所に持つだけ。

### vendor dir の作り方（運用手順）

「vendor」= **依存パッケージのソースコードをリポジトリにコミットしておく**こと。`npm install` を「使わない」とは「等価検証の実行時 / CI のたびには走らせない」の意で、リポジトリを整備する人が一度だけ手元で取得してコミットする。ライブラリのソース自体は npm registry から取る。

1. **(一度だけ・手作業)** 各 SUT lib (chalk / cheerio / …) について、その lib が抽出された上流 repo の該当 commit の `package.json` を見て依存リスト + 版を確定する (= `tmp/phase2b-adr-assumption-audit.md` §C-6 の chore。19 trivial candidate の `Cannot find module '...'` マーカーから transitive 込みで列挙できる)。
2. それを `fixtures/selakovic-sut-deps/<lib>/` で `npm install <dep>@<version> …` (or 各 `npm pack` して展開) して `node_modules/` を生成し、**生成された `node_modules/` (実体の `.js` ソース + LICENSE) を `git add` してコミット**する。どの版・どの上流 commit から取ったかを `fixtures/selakovic-sut-deps/versions.json` に記録する。
3. **以降**: 等価検証 / CI は `npm install` を走らせない。checkout すれば vendored ソースがそこにある。`require` shim が SUT lib の `require('escape-string-regexp')` を `fixtures/selakovic-sut-deps/<lib>/node_modules/escape-string-regexp/index.js` に解決する (下記)。

**どの lib に何 dep を何版・vendor dir のパス**は adapter (`selakovic/`) が `EquivalenceInput` 経由で sandbox に渡す = ADR-0015 の adapter config。`common/sandbox/` 側は dataset を知らない。

**例外規定**: ある lib の transitive dep tree が巨大、または native addon (要ビルド) を含み vendor が現実的でない場合は、その lib *だけ* stub または除外と判断し、本 ADR の補足に追記する (= 方式の変更ではなく個別判断)。socket.io / request はその可能性があり、Phase 2b 着手前の chore で dep tree を確認する (§C-6)。

### 解決機構: require shim の二段解決

sandbox の `require` shim を二段に変える:
- **relative specifier** (`./<lib>_before.js` / `./<lib>_before/index.js` 等) → `module_base_dir` (= issue ディレクトリ) 起点で解決 (現状どおり)。
- **bare specifier** (`escape-string-regexp` / `htmlparser2` 等) → adapter から渡された **vendor dir 群を順に探索**して解決。

`common/sandbox/` 側は「渡された vendor dir 群から bare を解決する」汎用機構だけを持ち、dataset を知らない。「どの vendor dir を渡すか」は adapter が `EquivalenceInput.vendor_dirs` (or 同等のフィールド) 経由で渡す = ADR-0015 の adapter config。

## 結果 / 影響

得るもの:
- server 系の 19 trivial-equal が「実際に `test()` が走った上での equal/not_equal」になり、検証の実効カバレッジが上がる。
- 再現性・オフライン性 (CI で `npm install` 不要)。

諦めるもの・将来のコスト:
- 古い npm 版を fixture に vendor する (版固定なので更新は不要だが、リポジトリに依存物が増える)。
- vendor dir の管理 (`fixtures/.../versions.json` で版の出所を記録する手間)。

## トリガー (再検討の条件)

以下のいずれかが成立したら本 ADR を見直す:

- ある lib の transitive dep tree が巨大 / native addon を含み vendor が破綻 → その lib だけ stub or 除外と判断し本 ADR 補足に追記。それが多数の lib に及ぶようなら方式そのものを再検討。
- 別 dataset を対象に加えた際に「dep が既に bundle されている」「npm registry に無い古い版」等で vendor が成立しない → 方式を見直す。

トリガー発火時は新しい ADR を起票し、本 ADR は `superseded by ADR-NNNN` に書き換える。

## 補足

- Phase 1.0 スパイクでは `escape-string-regexp@1` / `ansi-styles@2` / `strip-ansi@3` / `supports-color@2` を spike dir に install して chalk-27a を正常実行できた (`spike-results.md` §6) — chalk の dep はこの 4 つで版まで判明済。cheerio (htmlparser2 系) / request / socket.io / backbone の dep は、19 trivial candidate の `Cannot find module '...'` / `is not defined` マーカー (`tmp/0003_phase2a-preprocess-rework/scripts/verify-97.mjs` の trivial 検出が出力済) から transitive 込みで列挙する (Phase 2b 着手前の chore、監査 §C-6)。
- `MochaIssues/issue_701` は `init()` が空で mocha を `require` しないので dep 問題を踏まなかった (= mocha lib の変更が unexercised — これは別の課題で、ADR-0014 の `lib_referenced_by_workload` ヒューリスティックの粗さに関係する)。
