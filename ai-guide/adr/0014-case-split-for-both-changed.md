# ADR-0014: inline+lib 両方変化した issue は identifier 交差判定で independent なら 2 candidate に分割する

- **Status**: accepted (Phase 1.0 スパイクで angular-9067 の A+B 2 candidate 分割が動作 — `tmp/0002_phase1-adr-and-spike/spike-results.md` §2)
- **Date**: 2026-05-10
- **Related**: ADR-0010 (setup 構築規約 = 「他の最適化対象は before で固定」), ADR-0011 (本 ADR は ADR-0011 §段 2「作用点ルーティング」で『① `<lib>_*.js` にも ② ベンチマーク関数 body にも実質差あり』= 作用点 A+B にルートされた issue を扱う分岐), ADR-0013 (分割後の各 candidate は同じ operational definition で判定), `mb-analyzer/src/preprocessing/selakovic/index.ts`, `tmp/case-split-feasibility.md`, `tmp/oracle-mapping.md` §1/§3.3, `tmp/0001_phase0-dataset-analysis/scripts/inspect_case3_case4.py`, `tmp/0002_phase1-adr-and-spike/plan.md` Phase 1.1

## コンテキスト

Selakovic 1 issue は通常「1 つの計測 trigger = 1 つの最適化単位」なので 1 candidate に対応する。だが ADR-0011 §段 2 の作用点ルーティングで **① `<lib>_*.js` にも ② ベンチマーク関数 body (client の `f1.body` / server の `test()` body) にも実質差がある = 作用点 A+B** にルートされた issue (`both_changed`、本 dataset で 4 件: Angular/8515_8, Angular/9067, Ember/4263, React/1885。+ `test()` body が変化するケース IV-B が 2 件: Underscore/928, Mocha/701) では、両方の変更をまとめた 1 つの `(setup, slow, fast)` を作ると:

- slow/fast に「inline patch の効果」と「lib patch の効果」が混在し、AST が肥大化する → 後段 pruning のコストが上がる (ADR-0010 段 3 のサイズ問題と同種)
- 等価判定で「lib patch だけが等価か」「body patch だけが等価か」を個別に言えない
- candidate 総数の根拠 (= 「Selakovic 97 件 → N candidate」という事前分析の数値) が「issue 単位なのか最適化単位なのか」で曖昧になる

一方、Phase 0-A の実物調査 (`inspect_case3_case4.py` → `tmp/case-split-feasibility.md`) で、`f1.body` 内で参照される identifier 集合と、ライブラリ側 AST diff の changed_functions の名前集合との **交差を取ると 4 件すべて交差なし** = この 4 件の lib patch と body patch は「API rename / 削除に伴う co-evolution」ではなく**独立した最適化**だと分かった (= co-evolution は 0 件)。independent なら「片方を before で固定してもう片方だけ評価する」が成立する。

## 選択肢

- **A. 分割しない (1 issue = 1 candidate)**: 4 件は lib+body 混合の slow/fast。AST 肥大化、pruning コスト増、「どっちの patch が効いたか」不明。実装ゼロ。
- **B. 常に 2 分割**: `both_changed` なら無条件で lib candidate と body candidate に分ける。co-evolution な issue (API rename で両側が連動) を分割すると、分割後の片方が「rename 前の identifier を参照」になって `ReferenceError` = `error` verdict になる。本 dataset では co-evolution 0 件なので実害はないが、規則としては危険。
- **C. identifier 交差判定で条件付き分割**: `f1.body` の参照 identifier 集合 ∩ lib 側 changed_functions の名前集合 が空なら independent → 2 分割、空でなければ co-evolution の疑い → 1 candidate のまま。
- **D. C + test_case body 変化 (ケース IV-B/IV-C) にも同じ判定を適用**: server 系の `test.body` が変化 + lib も変化しているケース (例 Mocha/701) にも同じ交差判定を使う。

### 評価

| 軸 | A (分割なし) | B (常に 2 分割) | C (交差判定で条件付き) | D (C + test.body) |
|---|---|---|---|---|
| AST サイズ (4 件) | 大 (混合) | 小 (半減) | 小 (independent なら半減) | 小 |
| pruning コスト | 高 | 低 | 低 | 低 |
| 「lib だけ / body だけ等価か」が分かる | ✗ | ✓ | ✓ (independent のとき) | ✓ |
| co-evolution への安全性 | — (混合なので問題ない) | ✗ (誤分割で `error`) | ✓ (co-evolution は分割しない) | ✓ |
| 実装コスト | 0 | 小 | 中 (交差判定 + setup 2 通り) | 中 |
| candidate 総数の根拠 | issue 単位 (曖昧) | 最適化単位 | 最適化単位 + 安全弁付き | 同左 |

## 決定

**C + D (identifier 交差判定で条件付き分割、`f1.body` と `test.body` の両方に適用) を採用する。**

### 分割規則

`inline f1.body` (client) または `test.body` (server) が変化し、**かつ**ライブラリ側 `<lib>_*.js` も実質的に変化している issue について:

1. body (`f1.body` / `test.body`) の中で参照される identifier 集合 `I` を取る
2. ライブラリ側 AST diff の changed_functions の名前集合 `F` を取る (無名関数は `<anon-fn-expr>#N` のような合成名)
3. **`I ∩ F = ∅` (交差なし) → independent → 2 candidate に分割:**
   - **lib candidate**: setup = (inline/test の不変 statement) + (`f1.body` / `test.body` の **before 版**)、slow = `<lib>_before.js`、fast = `<lib>_after.js`
   - **body candidate**: setup = (inline/test の不変 statement) + (ライブラリの **before 版**で固定)、slow = `f1.body` / `test.body` の before、fast = same の after
4. **`I ∩ F ≠ ∅` (交差あり) → co-evolution の疑い → 分割しない (1 candidate のまま)**: setup = 不変 statement のみ、slow/fast = lib + body 両方の変化を含む 1 つの組

ケース I (lib のみ変化、83 件) / ケース II (`f1.body` のみ変化、8 件) / ケース IV-A (`init` の require 切替のみ、43 件) は片方しか変化していないので分割の対象外 = 自動的に 1 candidate。

### setup 構築規約との整合 (ADR-0010)

「他の最適化対象は最適化前 (before) の状態を環境として固定する」という ADR-0010 の setup 規約をそのまま使う:
- lib candidate を評価するときは body patch を**まだ当てていない** (before) ことにする → setup に `f1.body` の before を入れる
- body candidate を評価するときは lib patch を**まだ当てていない** (before) ことにする → setup に lib の before を入れる

両側 (slow/fast) の setup が同一になるので関数間依存があっても等価判定は破綻しない。

### 実装場所

preprocess の **Tier 2 の段 2 (作用点ルーティング — ADR-0011)**。段 1 が ① `<lib>_*.js` ペアと ② `f1.body` / `test.body` ペアを作り、段 2 が両方に実質差ありと判定した issue が本 ADR の交差判定にかかる。分割もそこで行う (`identifier 抽出` と `changed_functions 抽出` は Tier 1 の AST primitive を使う)。

### 本 dataset での適用結果

- ケース III の 4 件 (Angular/8515_8, Angular/9067, Ember/4263, React/1885): 全件 `I ∩ F = ∅` (Phase 0-A 実測) → それぞれ 2 candidate に分割 → +4 candidate。Phase 1.0 スパイクで Angular/9067 を実動作させ、lib candidate (= lib 側 diff、body fixed@before) と body candidate (= `f1.body` 側 diff、lib fixed@before) を別々に jsdom+vm で走らせて両方 `equal` を確認 (= 分割が成立) — `spike-results.md` §2。
- ケース IV-B の 2 件 (Underscore/928, Mocha/701): `test` body 変化 + lib 変化あり。本 ADR の規則を適用するが、これらの lib diff が require 切替や cosmetic に近いため暫定的に 1 candidate 扱い (Phase 2a で `I ∩ F` を実測して確定。independent なら +2 candidate になる)。なお Mocha/701 は `init()` が空で mocha を `require` しない → lib 変化が完全に unexercised なので、仮に分割しても lib candidate は trivially equal (Phase 1.0 で確認、§下記「lib 変化が exercise されるか」)。
- **件数の注意**: Phase 0 の「`both_changed` = 4 件 / 作用点 A=85 / B=12」は inline `<script>` の diff (`inline_diff_kind`) ベースの暫定値。Phase 1.0 で `clientIssues/Angular/issue_4359`・`clientIssues/React/issue_808` が「Phase 0 で `f1_body_only`(B) だが lib にも license 以外の実コード変化あり = 実は A+B」と判明 (`spike-results.md` §4。同じ micro-opt を `f1` と library の両方に適用 / react は内部の textContent 関連変更。A2 `framework-patch-locations.tsv` が `changed_functions` を既に記録済)。→ **lib を narrowing して丁寧に diff すると A+B が増え B-only が減る。正確な再カウントは Phase 2a の lib narrowing 実装後** (本 ADR の分割規則自体は件数に依らない)。
- 暫定総数: 97 issue → **101 candidate** (= 83 + 8 + 4×2 + 2)。再カウント後は A+B が増えるのでこの数も増える方向 (Phase 2a で確定)。

## 結果 / 影響

**得るもの:**

- ケース III の 4 件で AST サイズが半減 → pruning が軽くなる
- 「lib patch だけ等価か」「body patch だけ等価か」を個別の verdict として出せる
- candidate 総数の根拠が「最適化単位」として明確になり、事前分析の数値主張 (「N candidate を評価した」) が説明しやすい
- co-evolution な issue は分割しないので、誤分割による `error` が原理的に出ない

**諦めるもの:**

- co-evolution 判定が「identifier 名の集合交差」というヒューリスティック。動的 dispatch (`obj[methodName]()`) やプロパティアクセス経由の呼び出し、文字列で組み立てた呼び出しは捕捉できない → 偽 independent (本当は連動しているのに独立と判定) のリスク。本 dataset では 4/4 が明確に交差なしなので問題ないが、別 dataset では誤分割が起きうる
- 誤分割した場合、分割後の片方が `ReferenceError` 等で `error` verdict になる → 「分割したのに片方 `error`」を監視シグナルにする (= トリガー)

## トリガー (再検討の条件)

- 分割した candidate の片方が `error` / `not_equal` で終わる率が高い (例: 分割ペアの 30% 以上) とき → 交差判定をプロパティアクセスも見るように厳しくする、または分割を諦めて 1 candidate に戻す
- 別 dataset を対象に加える際に co-evolution (API rename を伴う性能修正) が頻出するとき → 交差判定のヒューリスティックを再設計、または静的解析を強化
- Phase 1.0 スパイクで Angular/9067 の lib candidate / body candidate が実際には分離評価できない (= 片方が落ちる) と判明したとき

## 補足

- ケース統合モデルの全体像は `tmp/oracle-mapping.md` §1、co-evolution 判定の実測は `tmp/case-split-feasibility.md` §1 を参照。
- **Phase 1.0 スパイク結果で `accepted` に上げた**: Angular/9067 の lib candidate と body candidate を別々に jsdom+vm で動かし、分離評価が成立 (両方 `equal`) を確認 (`spike-results.md` §2)。
- **「lib 変化が workload で exercise されるか」も実質的な判定軸になる** (Phase 1.0 の観察): co-evolution 判定 (identifier 交差) で「分割可」と出ても、lib 側の変更関数が `f1`/`test()` から*そもそも呼ばれない*ことがある (react-808 の react 内部変更は `f1` の直接 DOM 呼び出しを通らない / mocha-701 は `init()` が mocha を require しない)。この場合 lib candidate は trivially equal になる (= 害はないが、candidate を作る価値も薄い)。Phase 2a で「lib の changed_function ∩ workload が到達する API」が空なら lib candidate を出さない (= 1 candidate に縮約) という最適化を検討する余地あり。本 ADR の分割規則はそのままで、出力 candidate 数の効率化の話。
- **両側に実 diff があると判定された issue は等価検証で C6 (interaction trace) も効く** (ADR-0013): lib candidate の評価は「workload (fixed@before) が lib_before vs lib_after に投げた呼び出しの戻り値が同じか」= まさに C6。`clientIssues/Angular/issue_10351` (作用点 A、本 ADR の分割対象ではないが) で C6 が workload-observable な非等価を検出した例があるので、A+B の lib candidate でも同様の検出が起きうる。
- 「無名関数の合成名 `<anon-fn-expr>#N`」の付け方は Tier 1 の AST 走査順に依存するヒューリスティック。before/after で同じ走査順なら名前は安定するが、関数の追加・削除があると番号がずれうる。交差判定では「名前が完全一致した場合のみ交差扱い」とし、ずれによる偽陰性 (= 本当は連動だが独立と判定) は上記トリガーで監視する。

### 2026-05-12 更新 (作用点ラベルのリネーム + 0022 の lib narrowing 再設計)

ADR-0011 §段2 の作用点ラベルを `A` / `B` / `A+B` → **`lib` / `workload` / `lib+workload`** にリネームした (ADR-0011 の「2026-05-12 更新」参照。本 ADR 本文の `A+B`・`作用点 A` 等は読み替え)。本 ADR の分割規則 (independent なら lib / body の 2 candidate) は不変。

§補足 末尾の「lib changed_function ∩ workload 到達 API が空なら lib candidate を出さない最適化を Phase 2a で検討」は、`tmp/0022_preprocess-workload-reachability-redesign/` でより一般的に実装した — `aspect: lib` (および `aspect: lib+workload` 独立判定の lib 側) について、workload (`f1`/`test()`) が (推移的に) exercise する変更関数だけを `<lib>_*.js` から 1 つずつ切り出して lambda-lift + 観測する形にした `candidate_kind: "changed-fn"` 候補を出し、exercise されない変更は `change-not-exercised` で除外する。embedded (`single`) candidate は併存 (equiv 安定性 fallback)。`candidate_kind` から 0021 の `lib-enclosure` は削除。

### 2026-05-15 更新 (ADR-0024 で candidate_kind 廃止)

`candidate_kind` (`single` / `lib` / `body`) は ADR-0024 で廃止する。本 ADR の independent split 後の役割は `target_side: lib | workload` (candidate level、`SelakovicCandidateMeta`)、co-evolution の 1 candidate は `target_side: both` で表現する形に再構成する。本 ADR の分割規則 (identifier 交差判定で independent / co-evolution を切り分ける) は不変。詳細は ADR-0024 §決定 を参照。
