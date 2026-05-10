# ADR-0011: preprocess を Tier 1 (汎用 AST diff) + Tier 2 (Selakovic adapter) の二層に分ける

- **Status**: accepted (Phase 1.0 スパイクで段1 役割分解・段2 ルーティングが代表 7 件で成立、作用点 A clientIssues の de-risk 通過 — `tmp/0002_phase1-adr-and-spike/spike-results.md` §1/§3/§4)
- **Date**: 2026-05-10
- **Related**: ADR-0010 (Tier 1 の enclosure 戦略), ADR-0013 (Tier 2 が落とす harness は等価判定でも非観測), ADR-0014 (両側変化時の candidate 分割 = 本 ADR §段 2 の「両方差あり」分岐), ADR-0015 (等価検証器も同じ common/adapter 二層), ADR-0016 (Tier 2 が特定した `<lib>_*.js` の npm dep を sandbox が vendor で解決), ADR-0017 (preprocess は loop bound を保ち sandbox が iteration-cap をかける ← 本 ADR §段 1 の「ループ反復回数は書き換えない」と対), `mb-analyzer/src/preprocessing/{common,selakovic}/`, `mb-analyzer/src/contracts/preprocessing-contracts.ts`, `ai-guide/code-map.md` §Selakovic 前処理器, `ai-guide/datasets/selakovic-2016-issues.md` (§`{setup, slow, fast}` 対応表 — 本 ADR で clientIssues も `<script src>` 解決で `<lib>_*.js` を diff 対象にするよう更新が要る), `tmp/patch-taxonomy.md` §1/§5/§7 (作用点 A/B の定義), `tmp/case-split-feasibility.md` (5 ケース統合), `tmp/dataset-conventions.md` §2.4/§2.5/§5, `tmp/0002_phase1-adr-and-spike/plan.md` Phase 1.1

## コンテキスト

Selakovic 前処理器 (`preprocessing/selakovic/index.ts`) は現状、論文 Table 4 / precondition に一切依存せず、inline `<script>` 全体 (client) または `test_case_*.js` 全体 (server) の **top-level statement AST diff** だけで `(setup, slow, fast)` を切り出す (ADR-0010 の 3 段 enclosure + setup 構築規約で 96/97 抽出可能)。

問題は「**現状の diff は計測ハーネス側を見ていて、本物の patch を見ていない**」こと。Phase 0-A の patch 分類 (`tmp/patch-taxonomy.md` §1、`tmp/inline-patch-classification.tsv`) で、Selakovic の patch には 2 つの **作用点** があると判明している:

- **作用点 A (ライブラリ本体側 = `<lib>_*.js` 内)**: ライブラリ作者が内部関数を最適化したもの。`f1` / `test()` の body は before/after で不変、`<lib>_*.js` だけが変わる。**85 件 (88%)** — `harness_only` 68 + `no-html` (= test_case の require 切替のみ) 17。
- **作用点 B (ベンチマーク関数本体側 = client の `f1` body / server の `test()` body)**: ライブラリ利用者が API の呼び方を変えたもの (paper Table 4 の `%2→&1` 等)。`<lib>_*.js` は実質不変。**12 件** — `f1_body_only` 8 + `both_changed` 4 (= 両方変化)。

現状 preprocess の挙動:

- **client 系は inline `<script>` だけを diff し、`<script src="<lib>_before.js">` は捨てている** (`preprocessing/selakovic/client.ts` が `src=` 付き script を `continue`)。→ 作用点 A の clientIssues (= `harness_only` の大半) では `<lib>_*.js` を一度も読まないので **真 patch が一切 diff に乗らず**、残るのは `$.ajax({mark: 0|1})` の **before/after フラグ差** (unmatched ExpressionStatement = 偽 candidate) と整形差・`<script src>` 切替だけ。Phase 0-A 実測でも 97 入力 → 113 結果のうち multi-candidate な base 14 件の `#1` の多くがこの mark artefact (`tmp/dataset-conventions.md` §4)。
- **server 系は `test_case_*.js` の `init()` 内 `require('./<lib>_before')` を解決して `<lib>_*.js` 同士を diff している**ので作用点 A は処理できているが、`f1.body` に相当する `test()` body の変化 (ケース IV-B, 2 件) と require 切替 artefact の扱いが暗黙。
- 作用点 B (12 件) では inline `<script>` 全体 diff のため `f1.body` の真 patch と `$.ajax({mark})` artefact が**両方** candidate 化し、candidate 数 > 真 patch 数になる (`tmp/dataset-conventions.md` §4)。

つまり「inline `<script>` を見るだけ」では作用点 A の clientIssues を取りこぼし、「`<lib>_*.js` を丸ごと diff するだけ」では作用点 B を取り違える。**どの作用点の issue か (= ① `<lib>_*.js` ② ベンチマーク関数本体 のどちらに実質的な AST 差があるか) を判定して抽出元を分ける**しかない。

一方、`data/selakovic-2016-issues/` の物理規約は強い (Phase 0-A 実物検証 — `tmp/dataset-conventions.md` §2.4/§2.5)。これが作用点判定と計測ハーネス除去の足場になる:

- `v_before.html` を持つ 80 件**全件**で inline `<script>` に `var f1 = function ()` または `function f1(` の定義 + `execute(f1, 10)` (161 出現すべて n=10 固定) + `$.ajax({mark: 0|1, mean: ...})` (mark は 0/1 の 2 値のみ) が成立し、かつ `<script src="<lib>_before.js">` が同梱の `<lib>_before.js` を指す。`var a = execute(f1, 10)` 以降と `<script src>` は計測ハーネス。**真 patch は作用点 A なら `<lib>_*.js` の中、作用点 B なら `f1.body` の中** (どちらかは AST diff で確定 — 段 2)。
- `test_case_before.js` を持つ 45 件**全件**で `init` / `setupTest` / `test` の 3 関数 + `exports` が成立し、`init()` が `require('./<lib>_before')` を返す。`init`/`setupTest` と require 切替は計測ハーネス。**真 patch は作用点 A なら `<lib>_*.js` の中、作用点 B なら `test()` body の中**。

ai-guide (`datasets/selakovic-2016-issues.md`) の「論文非依存」ルールは **pruning など主軸アプローチの妥当性を保つため**のもので、preprocess / 等価検証が dataset 依存になるのは必然 (`tmp/dataset-conventions.md` §5)。だが「どこまでが dataset 非依存の汎用ロジックで、どこからが Selakovic 固有か」をコード構造として明文化しないと、`common/` に Selakovic 知識が漏れる / 逆に `selakovic/` を汎用化しすぎて規約を活かさない、というブレが出る。本 ADR でその境界を確定する。

## 選択肢

- **A. 現状維持** (= `selakovic/` も「inline `<script>` / `test_case` だけを top-level diff する」を貫く): 作用点 A の clientIssues (≈ `harness_only` 68 件の client 側) は `<lib>_*.js` を一度も読まないので**真 patch を永遠に取りこぼす**。mark artefact / require 切替は後段 pruning と等価検証で吸収するしかない。実装ゼロだが取り込み率が頭打ちになり、threats to validity も「計測ハーネス artefact が混じる」と弱い記述になる。
- **B. 二層化 (Tier 1 / Tier 2)**: `preprocessing/common/` = **Tier 1** = dataset を一切知らない AST diff primitive (`ast-diff.ts` / `enclosure.ts` / `setup-cleanup.ts`)。`preprocessing/selakovic/` = **Tier 2** = Selakovic 固有 adapter で、処理を 2 段に分ける — **段 1 (役割分解 + 計測ハーネス除去)**: issue ディレクトリから ① ライブラリ本体 `<lib>_*.js` の before/after ペアと ② ベンチマーク関数本体 (`f1` body / `test()` body) の before/after ペアの最大 2 つを取り出し、計測ハーネス (`execute(f1, n)` / `$.ajax({mark, mean})` / `init`/`setupTest` の require 切替 / `<script src>` の path 切替 / license header) は setup へ回すか破棄する。**段 2 (作用点ルーティング)**: ① ② それぞれを Tier 1 の正規化 AST diff にかけ、実質的な changed_nodes が残った側だけ Tier 1 の enclosure に渡して `(setup, slow, fast)` を作る (① だけ → 作用点 A / ② だけ → 作用点 B / 両方 → ADR-0014 の交差判定で 1 or 2 candidate / どちらも空 → Tier 1 の素の top-level diff にフォールバック)。Tier 2 が Tier 1 を import する一方向 DI を import-linter で機械強制 (既存の `preprocessing/common` → `preprocessing/selakovic` 関係と同じ)。
- **C. dataset ごとに `preprocessing/<dataset>/` を増やす完全プラグイン型**: 今は Selakovic 1 個しか対象がないので過剰。B の構造のままで将来 `preprocessing/<other>/` を足せば足りる。

### 評価

| 軸 | A (現状維持) | B (二層化) | C (完全プラグイン) |
|---|---|---|---|
| 作用点 A (lib 側 patch) の抽出 | ✗ (client は `<script src>` を捨てるので ≈59 件不可視) | ✓ (段 1 で `<lib>_*.js` ペアを生成) | ✓ |
| 作用点 B (`f1`/`test` body patch) の抽出 | △ (取れるが mark artefact と同居) | ✓ (段 1 で body ペアを生成、計測ハーネスは除去) | ✓ |
| dataset 規約の活用 | しない | する (80/80, 45/45 の実証規約を使う) | する |
| candidate 数 ≈ 真 patch 数 | ✗ (mark/require artefact 混入) | ✓ | ✓ |
| 主軸 (pruning) への論文依存の漏れ | なし | なし (Tier 1 と分離、Tier 2 は threats に明記) | なし |
| 実装コスト | 0 | 中 (Tier 2 に `<script src>`/`require` 解決 + `f1`/`test` 抽出 + 作用点ルーティングを追加) | 大 (抽象化レイヤ追加) |
| 将来 dataset 追加時 | — | Tier 2 相当を新規実装、Tier 1 は再利用 | プラグイン追加のみ |
| threats to validity の記述 | 弱い | 「計測ハーネス規約 (実証済) に依存して境界を取る」と honest | 同左 |

## 決定

**B (二層化) を採用する。**

### 層の境界の判定基準

「使う言語機能」ではなく「**ハードコードする外部知識**」で切る:

- **Tier 1 (`common/`)** = 与えられた statement 列だけ見れば書けるロジック。dataset の物理レイアウト (HTML / `test_case_*.js` / `<lib>_*/` の組合せ) も、計測ハーネスの識別子規約 (`f1` / `execute` / `mark` / `init` / `setupTest` / `test`) も**一切知らない** AST primitive。入力は `(before_stmts, after_stmts)` の純関数で、「どの statement か」「どこから来たか」「どれが SUT でどれが計測ハーネスか」を知らない。
- **Tier 2 (`selakovic/`)** = 「どの statement を slow/fast の母集団として渡すか」「それをどう探すか」を答えるロジック = Selakovic の物理レイアウトと計測ハーネスの識別子規約を知らないと書けないもの。

注: 「TypeScript の AST 操作で書けるか」では切れない (Tier 2 の `<script src>` 解決も `f1` body 切り出しも mark 除外も、全部 AST/文字列操作で書ける = ECMAScript レベルのコード)。同様に Tier 1 を「ECMAScript 文法だけ」と呼ぶのも過剰主張 (3 段 enclosure = ADR-0010、subtree-hash diff = ADR-0002、statement→文字列化 はいずれも ECMAScript 仕様から導出できる規則ではなく設計ヒューリスティクス)。中間地帯 (Selakovic 固有ではないが test harness 一般の知識 — 例「ベンチマークループは SUT ではなく setup」) は当面すべて Tier 2 に置く (= 選択肢 C を退けた帰結)。2 個目の dataset が来て同じヒューリスティクスを再利用したくなった時点で Tier 1.5 として括り出す。それまで `common/` に harness 知識を下ろさない。

### Tier 1 (`preprocessing/common/`) の責務 — 変更なし

- `ast-diff.ts`: top-down subtree hash による changed_nodes 抽出 (ADR-0002)
- `enclosure.ts`: 3 段優先順位の minimal enclosure (ADR-0010)
- `setup-cleanup.ts`: statement → code 文字列化

Tier 1 は「与えられた statement 列の before/after から minimal differential extraction する」だけ。**どの statement を渡すかは知らない。**

### Tier 2 (`preprocessing/selakovic/`) の責務 — 2 段構成

**前提: layout 検出** — `(has_html, has_lib_file, has_lib_dir, has_test_case)` の 5 組合せで client / server (single-file) / server (multi-file) を判定 (現状 `detectLayout()`、変更なし)。段 1 が「どこから ①② を取るか」を決めるのに使う。

#### 段 1: 役割分解 + 計測ハーネス除去

issue ディレクトリから、before/after で AST 差が出うる「材料」を最大 2 ペア取り出す:

- **① ライブラリ本体ペア** = `(<lib>_before.js の AST, <lib>_after.js の AST)`。
  - **取り方は client / server 共通: issue ディレクトリの dir scan で `<lib>_before(.js|/)` / `<lib>_after(.js|/)` を見つける** (= 既存 `layout.ts` の `findLibEntry` と同じ。`<script src>` の参照や `require` の有無とは*独立* — Phase 1.0 で確認: #2 angular-4359 は HTML が `<script src="angular_before.js">` を持たないが `<lib>_before.js` は dir にある、#7 angular-10351 は持つ。`spike-results.md` §3)。**※ 現状 `extract()` の client 経路は `<lib>_*.js` を一度も読まない (inline `<script>` だけ diff する) のでここが新規実装。** server 経路は `init()` の `require('./<lib>_before')` を解決して `<lib>_*.js` を diff しているので既存。
  - `<script src>` / `require` の参照は別途見る: 「workload (`f1`/`test()`) が runtime にその lib を load して叩くか」の判定に使う (作用点 A の clientIssues では `f1` が lib 内部を叩くので bootstrap 時に lib を load する必要がある — equivalence-checker 側の話、ADR-0012/0013)。
  - `<lib>_*.js` 全体 diff には整形差・license header (`@license` / `sha.xxx` / version 文字列・`errors.angularjs.org/<version>`) などの無関係変更が混じる。`test_case_*.js` / `f1` の call site (= 呼ぶ API) から到達可能な changed_function に narrowing する (既存 `ai-guide/datasets/selakovic-2016-issues.md` §境界設定の注意の方針)。Phase 0 の `framework-patch-locations.tsv` が既に `changed_functions` を記録しているのでそれが narrowing の出発点。narrowing の精度は Phase 2a で詰める (スパイクの簡易フィルタは whitespace 正規化が甘く `diff -u` の whitespace-only flag を拾うことがあった — `spike-results.md` §4)。
- **② ベンチマーク関数本体ペア** = client: `(f1.body の before, f1.body の after)` / server: `(test() body の before, test() body の after)`。
  - client: inline `<script>` から `f1` 定義 (`var f1 = function` / `function f1`、AST 親パスは 4 種だが実質「top-level 直書き」と「Angular controller wrapper」の 2 種 — `tmp/inline-layout-catalog.md`) を特定し、その body を取り出す。
  - server: `test_case_*.js` から `test` 関数を特定し、その body を取り出す。
- **計測ハーネス (= レポーティング部) の除去** = `var a = execute(f1, n)` 以降 (`mean(a)` / `$.ajax({mark: 0|1, mean, ...})` / success・error callback)、`<script src>` の `_before`↔`_after` path 切替、`init`/`setupTest` の require 切替、`<lib>_*.js` 内の license header。これらは「他の最適化対象は最適化前で固定」(ADR-0010 の setup 規約) として setup に回すか、純粋な artefact (`mark: 0/1` の値差、`<script src>` の path 文字列差) は破棄する。→ `mark: 0|1` の before/after 差はここで消えるので、もう candidate にならない。
  - **ただし `f1`/`test()` body 内のループ反復回数 (`for (i < 50000)` 等) は書き換えない** — preprocess は外側の計測ハーネス (`execute(f1, n)` / `$.ajax`) を剥がすだけで、body 内は原文どおり残す (= 復元可能性のため。反復の縮小は等価検証 sandbox 側の iteration-cap transform に委ねる — ADR-0017。「原文は preprocess が保ち、cap は sandbox が実行時に可逆的にかける」という分担)。

#### 段 2: 作用点ルーティング

①② それぞれを Tier 1 の `ast-diff.ts` にかけ、(narrowing 後に) 実質的な changed_nodes が残るかを見て出力先を分ける:

| ① `<lib>_*.js` に実質差 | ② body に実質差 | → 作用点 | 出力 |
|:---:|:---:|---|---|
| あり | なし | **A** (本 dataset 85 件、`harness_only` 68 + `no-html` 17) | candidate 1 個。slow/fast = ① の changed_nodes を Tier 1 の `enclosure.ts` に渡した結果 (= `<lib>_*.js` の変更関数 body)。setup = `<lib>` の不変部 + ②全体 (before で固定) + 計測ハーネス |
| なし | あり | **B** (本 dataset 8 件、`f1_body_only`) | candidate 1 個。slow/fast = `f1.body` / `test()` body。setup = `f1`/`test` 定義より前の statement + `<lib>` 全体 (before で固定) + 計測ハーネス |
| あり | あり | **A+B** (本 dataset 4 件、`both_changed` + ケース IV-B 2 件) | ADR-0014 の identifier 交差判定へ。independent なら lib candidate と body candidate の 2 つに分割、co-evolution の疑いなら 1 candidate のまま |
| なし | なし | (artefact 除去後に何も残らない) | Tier 1 の素の top-level diff にフォールバック (= 抽出は維持、粒度だけ粗くなる)。実物では起きない (`harness_only` 全件で ① に差がある) が、`f1`/`test` が規約外フォーマットの新 issue 等に備える安全弁 |

「どの作用点か」は `tmp/inline-patch-classification.tsv` (A3) と `tmp/framework-patch-locations.tsv` (A2) のクロスで判定する。Phase 0 の暫定値は「作用点 A = 85/97 (88%)、B = 12」だが、これは A3 の `inline_diff_kind` ベース (= inline `<script>` の diff だけ見た) で、**`<lib>_*.js` を narrowing して丁寧に diff すると A+B が増え B-only が減る** (Phase 1.0 スパイク: `clientIssues/Angular/issue_4359`・`clientIssues/React/issue_808` は Phase 0 で `f1_body_only`(B) だが、lib 側に license 以外の実コード変化があり — 同じ micro-opt を `f1` と library の両方に適用 — 実は A+B。A2 はこれを `changed_functions` (`ngRepeatAction`・`getTextContentAccessor`) として既に記録済。`spike-results.md` §4)。**正確な再カウントは Phase 2a の lib narrowing 実装後に行う** (本 ADR の Tier 構造・段1/段2 の妥当性自体は件数に依らない)。

作用点 A の大半 (client 検出された `harness_only`) は**現状コードでは `<lib>_*.js` を読まないため真 patch ゼロ**で、段 1 の ① ペア生成がないと救えない。Phase 1.0 で `clientIssues/Angular/issue_10351` (= `harness_only`/作用点 A/client、AngularJS 950KB を jsdom で load + bootstrap + `f1()` 実行) を実動作させ、この経路が成立することを確認 (de-risk 通過 — `spike-results.md` §1)。`f1` の AST 親パスは実質 2 種 (top-level 直書き / angular-controller-wrapper) で、両方の役割分解が成立 (`spike-results.md` §3、`tmp/inline-layout-catalog.md` の「実質 2 種」と一致)。

### 等価検証器との対称性

等価検証器 (`equivalence-checker/`) も同じ思想で `common/` (dataset 非依存の oracle primitive・sandbox・verdict) + `selakovic/` adapter に二層化する (ADR-0015)。preprocess と等価検証で「dataset 依存ロジックの隔離先」を同じ命名 (`common/` + `<dataset>/`) で揃える。

## 結果 / 影響

**得るもの:**

- **作用点 A の clientIssues (≈59 件) で初めて真 patch を取れる**。現状コードは `<script src>` を捨てて `<lib>_*.js` を一度も読まず、これらの slow/fast は `mark` artefact だけだった。段 1 の ① ペア生成 (dir scan) でこれが解消し、Selakovic 97 件のうち実質的に評価できる candidate 数が大幅に増える (= Phase 3 の取り込み率比較の主因)。Phase 1.0 スパイクで #10351 を実動作させ、この経路 (lib を jsdom で load → bootstrap → `f1()` 実行) が成立することを実証済 (`spike-results.md` §1)。
- candidate 数 ≈ 真の patch 数 になる。`mark: 0|1` の値差・require 切替・`<script src>` 切替は段 1 で除去されるので偽 candidate (`#1` 等) が消える (Phase 0-A で `#1` 候補の主因と判明済)。
- 後段 pruning / 等価検証の入力が小さくクリーンになる (作用点 A は narrowing 済の `<lib>` 変更関数 body、作用点 B は `f1.body` の中の差分だけ)。
- threats to validity に「Selakovic の物理レイアウトと計測ハーネス規約 (HTML 80/80・test_case 45/45・`execute(f1,10)` 161/161 で実物検証済) に依存して slow/fast 境界を取る」と書ける。論文非依存性が必要な主軸 (pruning) は Tier 1 までしか触らないので主張は保たれる。

**諦めるもの:**

- `<lib>_*.js` 全体 diff には license header・整形差・無関係 commit が混じる。call site からの narrowing で大半は落とせるが、関数全体 refactor 系 (= 作用点 A の `issue_8515_44` は lib 側 51 行差、EJS の parse、Backbone の model 系など) は ADR-0010 段 3 で top-level statement 単位の抽出になり粒度が粗い。これは threats to validity に honest に明記。
- `f1` / `test` が規約外フォーマットの issue、または `<lib>_*.js` が dir scan で見つからない issue は Tier 1 フォールバックなので抽出粒度が粗い (= top-level statement 単位)。Phase 1.0 の代表 7 件ではフォールバックは発生せず。
- **server lib の npm dep**: server 系の `<lib>_*.js` (例 `chalk_before.js`) は `require('escape-string-regexp')` 等の npm dep を bundle していない (Selakovic dataset の制約 — `spike-results.md` §6)。`init()` がその lib を `require` する issue は equivalence-checker 側で dep を解決する必要がある (vendor 方式 — ADR-0016)。preprocess 自体は dep が無くても `<lib>_*.js` の diff は取れる (parse はできる) が、実行する equivalence-checker は dep を要する。
- **観測の薄さ / dataset の ground-truth**: workload (`f1`/`test()`) が patch の効果を surface しない issue がある (chalk-27a は戻り値破棄、mocha-701 は両分岐 no-op、angular-10351 は `$eval` だけ) → 等価検証側で「workload が SUT に投げた呼び出しの戻り値」も観測する必要 (= C6 interaction trace、ADR-0013)。さらに #10351 は C6 で観測すると workload-observable に非等価 (Description.md は perf 最適化に分類) — 「Selakovic の ground-truth は著者の手動判断で完璧ではない」を threats に明記 (`spike-results.md` §5.1、ADR-0013 の「諦めるもの」)。これは preprocess の問題ではなく dataset / 等価検証の問題だが、preprocess の Tier 2 が SUT を `<lib>_*.js` / `f1`/`test()` body として特定したことが C6 の「包む対象」を決める入力になる、という形で繋がる。
- 将来 Selakovic 以外の dataset を足すときは Tier 2 相当を新規実装する必要 (ただし Tier 1 はそのまま再利用できる)。
- Tier 2 が `f1` の AST 親パス 4 種 (top-level 直書き / Angular controller wrapper 3 variant — `tmp/inline-layout-catalog.md`、Phase 1.0 では top-level と controller wrapper の 2 種を実装・実証) を扱う必要があり、`f1` 特定ロジックにそれなりの分岐が要る。

## トリガー (再検討の条件)

- 段 1 の ① ペア生成 (`<script src>` 解決 / `require` 解決) が失敗してフォールバックになる率が 10% を超えるとき → 解決ロジックを見直すか、フォールバックを threats でより重く扱う。
- 段 2 で「①にも②にも差がない」(= 全 artefact 扱いになった) issue が出るとき → 計測ハーネス除去が真 patch まで巻き込んでいないか確認。
- 別 dataset を追加する際に Tier 1 (`common/`) にも変更が必要になったとき → Tier 1 の「汎用」の定義を再検討。
- 計測ハーネス規約 (`f1`/`execute`/`mark`/`init`/`setupTest`/`test`) や `<script src>`/`require` の `_before`↔`_after` 命名が崩れる新しい issue が dataset に追加されたとき。

## 補足

- 「論文非依存」の正確なスコープ: 主軸 (pruning など) は論文非依存。preprocess / 等価検証は dataset 依存 OK で `f1`/`init`/`mark`/`<lib>_*.js` 規約を積極利用してよい (`tmp/dataset-conventions.md` §5、ai-guide メモリ)。本 ADR の Tier 2 はこのスコープ内。
- Phase 0-A の `tmp/patch-taxonomy.md` §5.1/§9 が既に「作用点 A → `<lib>_*.js` の変更関数 body を slow/fast に / 作用点 B → `f1.body` を slow/fast に / 両方 → 別 candidate」と結論していた。本 ADR はそれを Tier 2 の段 1 (役割分解) / 段 2 (作用点ルーティング) として正式化したもの。`ai-guide/datasets/selakovic-2016-issues.md` の §`{setup, slow, fast}` 対応表は clientIssues の slow/fast を「`f1` 関数本体」のみとしていて作用点 A を欠くので、本 ADR 確定後に「clientIssues も dir scan で見つけた `<lib>_*.js` を diff 対象に含む / 作用点で抽出元を分ける」と更新が要る (Phase 2a)。
- **Phase 1.0 スパイク結果で `accepted` に上げた** (`tmp/0002_phase1-adr-and-spike/spike-results.md`): 代表 7 件で段 1 の役割分解 (① `<lib>_*.js` ペアの dir scan 生成、② `f1`/`test()` body 抽出、計測ハーネス除去) と段 2 のルーティング (①②の実 diff で A/B/A+B 判定) が成立。作用点 A の clientIssues (#10351 = AngularJS 950KB を jsdom で load+bootstrap+`f1()`) の de-risk 通過。A+B の 2 candidate 分割 (#9067) も動作。文言修正点: ① ペアは「`<script src>` 解決」ではなく「dir scan」(`<script src>` は runtime dep 判定用) — 本文に反映済。残課題: 作用点カウントの再計算 (Phase 2a)、lib narrowing の精度向上 (Phase 2a)、観測強化 (= C6、equivalence-checker 側 — ADR-0013/0015)。
