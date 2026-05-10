# ADR-0013: 「意味論的等価」の operational definition — 計算結果 + 観測可能な副作用 + workload↔SUT の interaction trace、timing / 反復回数 / stack / 非同期後タスクは非観測

- **Status**: proposed。前提の実証ステータスは `tmp/phase2b-adr-assumption-audit.md` §B 参照（定義そのもの = 決定事項、実装前に潰すべき賭けは C6 の取得方法 = 監査 §B-3/§D-3 のみ）。`accepted` 昇格は Phase 2b 着手前 spike (C6 汎用 Proxy wrap) 完了時。
- **Date**: 2026-05-10
- **Related**: ADR-0011 (preprocess 段1 の SUT 特定が interaction trace の「包む対象」を決める入力), ADR-0012 (実行環境 — DOM/trace の生成経路は executor 側), ADR-0015 (oracle 層の構造 + DOM oracle + interaction-trace oracle + adapter config), ADR-0017 (実行前 transform — 反復回数を非観測と決めたのは本 ADR、その帰結の iteration-cap 機構が 0017), `mb-analyzer/src/equivalence-checker/`, `ai-guide/code-map.md` §等価性検証器, `tmp/oracle-mapping.md` §2/§4/§6/§7, `tmp/dataset-conventions.md` §1.3/§6, `tmp/phase2b-adr-assumption-audit.md` §B

## このADRの守備範囲

このADRが決めるのは **「2 つの body が "意味論的に等価" であるとは、どの観測量がすべて一致することか」と「複数 oracle の判定をどう 1 つの verdict に合成するか」だけ** — つまり*意味論*の話。具体的には: 等価の構成要素 (C1–C6) と各々が構成要素である理由 / 等価から除外する観測量 (timing・iteration 回数・memory・stack・同期後 async・非決定性 API 生値) と除外理由 / verdict 合成の 4 規則 / oracle 評価順序 / 既知の穴と threats への書き方。

**扱わないこと** (他 ADR の管轄。本 ADR は該当箇所を 1 行参照するだけ):
- jsdom か Playwright か / `capture.dom_html`・`capture.interaction_trace` の生成経路 → **ADR-0012 (実行環境)**
- 非決定性 API の固定 / iteration-cap transform の*アルゴリズム* → **ADR-0017 (実行前 transform)**
- SUT lib (`<lib>_*.js`) の npm dep 解決 (vendor 方式) → **ADR-0016**
- equivalence-checker の `common`/`selakovic` 二層化 / C2・C6 oracle のファイル配置と I/F / adapter が `common/` に渡す config (iteration-cap の値・dep vendor リスト・DOM 正規化プロファイル・包む対象リスト等) → **ADR-0015 (構造 + adapter config)**
- 既存 oracle (O1–O4) の実装意味論 → `ai-guide/code-map.md` §等価性検証器 + `equivalence-checker/README.md`

> iteration-cap・npm dep のように 1 つの話題が複数 ADR にまたがるときの分界: *なぜ等価判定がそれを無視するか/構成要素に入れるか* → 0013（ここ） / *sandbox がそれをどう処理するか（アルゴリズム・方式）* → 実行環境=0012・実行前 transform=0017・依存解決=0016 / *Selakovic の場合の具体値・どの adapter フィールドで渡すか* → 0015。

## コンテキスト

Selakovic & Pradel (ICSE 2016) は性能修正パッチが "semantic-preserving" であることを **著者の手動 judgment** でしか定義していない (自動検証手段なし、ground-truth は著者の判断のみ — `tmp/dataset-conventions.md` §1.3)。本研究は before/after パッチペアの等価性を**自動判定**するので、「何をもって等価とみなすか」を operational に固定する必要がある。これが固まらないと oracle の責務範囲 (どの観測 channel を見るか) も verdict の合成規則も決められない。

観測しうる「実行結果の側面」(= channel) は 6 種類 (`tmp/oracle-mapping.md` §2 + Phase 1.0 スパイクで追加した C6):

| ID | channel | 観測対象 |
|---|---|---|
| C1 | return value | body を関数として実行した戻り値 |
| C2 | DOM mutation | mount point 配下の DOM 状態 (innerHTML / textContent / attribute / element 数) |
| C3 | console output | `console.*` の呼出列 (method + args + 順序) |
| C4 | argument / state mutation | setup で定義した object/array の pre/post snapshot 差分 + 新規 global key |
| C5 | exception | 投げられた例外の constructor + message |
| C6 | **interaction trace** | **作用点 A のとき: workload (`f1`/`test()` = 不変側) が変わった SUT (`<lib>_*.js`) に投げた呼び出しに対し、SUT が*返した答え* — 戻り値・例外 (順序や SUT 内部は見ない)** |

加えて timing / iteration 回数 / memory profile / stack trace / body 同期終了**後**の非同期タスク副作用 / 非決定性 API (`Date.now()` / `Math.random()`) の生値 がある。Selakovic の性能パッチは **timing が変わるのが目的**であり、また patch を当てれば**行番号・内部関数名は必ず変わる**ので stack trace も必然的に変わる。これらを「等価」の構成要素に入れると全パッチが `not_equal` になり検証器として成立しない (`ai-guide/code-map.md` §等価性検証器)。

**C6 (interaction trace) を追加した理由 (Phase 1.0 スパイクの発見)**: C1〜C5 だけだと workload が*捨てる*中間計算結果を見逃す。`clientIssues/Angular/issue_10351` で、`f1` が `$scope.$eval("null.a", {null:{a:42}})` 等を呼ぶが戻り値を捨てる → C1 (= `f1` の戻り値) は両側 `undefined` で「等価」に見える。だが `$scope.$eval(...)` の*戻り値*は patch (= angular の式パーサ変更) で `42` → `undefined` に変わっている = workload-observable に非等価。`f1` の計算の本体は `$eval(...)` の評価なので、それを観測しないと計算を観測したことにならない。`f1`/`test()` が SUT に投げた呼び出しの**戻り値**をトレース (= C6) すれば捕まる。SUT の*内部*や*呼び出し順序*は見ない (workload からは見えない = 内部 bookkeeping や一時変数の違いで誤 `not_equal` にならない); 比較前に dataset 固有の正規化 (angular の `$$hashKey` 等) をかける (ADR-0015)。詳細は `tmp/0002_phase1-adr-and-spike/spike-results.md` §5.1。

## 選択肢

- **A. strict (観測可能なすべてを一致要求)**: return + 全副作用 + DOM + console + exception + timing + stack を比較。Selakovic の全パッチが timing 差・stack 差で `not_equal` になる。**検証器として成立しない**。
- **B. semantic (計算結果 + 観測可能な副作用)**: C1〜C5 を「等価」の構成要素とし、**timing / memory / stack trace / body 同期終了後の非同期タスク / 非決定性 API の生値を非観測**にする。「機能的に同じ振る舞いをするか」を operational definition とする。
- **C. return-only**: C1 (戻り値) だけ比較。実装は最小だが、副作用系パッチ (キャッシュ追加・prototype 拡張) や DOM 系パッチ (`innerHTML → textContent`) を「等価」と誤判定する。**弱すぎる**。

### 評価

| 軸 | A (strict) | B (semantic) | C (return-only) |
|---|---|---|---|
| Selakovic パッチで成立するか | ✗ (全件 not_equal) | ✓ | ✓ |
| 副作用系パッチを判定できるか | ✓ | ✓ | ✗ |
| DOM 系パッチを判定できるか | ✓ | ✓ (C2) | ✗ |
| false negative (非等価を equal と誤判定) | 最小 | 観測範囲外 (後述の穴) のみ | 多い |
| 実装コスト | — (そもそも成立しない) | 中 (5 oracle) | 小 |
| 「等価」の意味の説明しやすさ | 自明だが使えない | 「機能的等価 = 計算結果 + 観測可能な副作用」と説明可 | 「戻り値だけ」= 過小 |

## 決定

**B (semantic) を採用する** (＋ Phase 1.0 の発見を受けて C6 = interaction trace を構成要素に追加)。「意味論的等価」を以下のように operational に定義する:

> **before / after の body を同一 setup の下で別 sandbox 実行したとき、(C1) 戻り値、(C2) mount point 配下の正規化 DOM、(C3) `console.*` 呼出列、(C4) setup 由来 object/array の状態変化と新規 global key、(C5) 投げた例外の型とメッセージ、(C6) workload が SUT に投げた呼び出しの戻り値・例外のトレース (正規化後) — がすべて一致するとき、その 2 body は意味論的に等価とみなす。**

作用点 (ADR-0011 §段2) で観測の主軸が変わる: **作用点 A (変わったのは `<lib>_*.js`、workload は不変)** では C6 (= workload が SUT から受け取る答えのトレース) が主軸 + workload 自身の C1〜C5 (不変なはずだが念のため)。**作用点 B (変わったのは `f1.body` 自身)** では `f1.body` 自身の C1〜C5 が主軸で C6 はほぼ非活性 (SUT＝`f1.body` を呼ぶ「外側の workload」がない)。

### 観測する channel (= 「等価」の構成要素)

| channel | 担当 oracle | 等価への寄与 |
|---|---|---|
| C1 return value | O1 `return-value.ts` | 戻り値の正規化文字列の完全一致 |
| C2 DOM mutation | O5 `dom-mutation.ts` (Phase 2 新規 — ADR-0015) | mount point 配下の正規化 HTML 文字列の一致 |
| C3 console output | O4 `external-observation.ts` | console 呼出列 (method + args + 順序) の一致。計測ハーネス由来の `console.log(mean)` 等は adapter 側でノイズ除去してから比較 (ADR-0015) |
| C4 argument / state mutation | O2 `argument-mutation.ts` + O4 (新規 global key) | setup で定義した object/array の pre/post snapshot 差分の一致 + 新規 global key 集合の一致 |
| C5 exception | O3 `exception.ts` | 例外の constructor 名 + message の一致 |
| C6 interaction trace | O6 `interaction-trace.ts` (Phase 2 新規 — ADR-0015) | 作用点 A のとき: `f1`/`test()` が SUT (`<lib>_*.js` 由来のオブジェクト) に投げた呼び出しの (戻り値・例外) 列の一致 (正規化後)。SUT 内部・呼び出し順序は見ない。server なら `module.exports` を、client なら framework global (`angular`/`React`/`$`) + 注入 service (`$scope`/`$compile`) を記録 Proxy で包む — 「何を包むか」は dataset 依存なので `selakovic/` adapter が指定 (ADR-0015) |

### 観測しない (= 「等価」の構成要素に入れない)

- **timing / 実行時間**: Selakovic の性能測定軸。パッチで変わるのが目的なので等価判定からは除外 (`tmp/dataset-conventions.md` §2.6)。
- **iteration 回数 / ループ反復回数**: 等価判定の観測対象外 (timing と同じ理由 — loop bound を縮小しても等価判定の結果は変わらない、`spike-results.md` §7 で実測確認)。preprocess は `f1`/`test()` body 内のループ反復回数を書き換えず原文を残す (= 復元可能性、ADR-0011)。loop-heavy な body を tractable に走らせるための **iteration-cap transform は sandbox 側の機構 = ADR-0017** (*アルゴリズム* も 0017、*値* = 既定 N・on/off の config は ADR-0015 の adapter config)。本 ADR が言うのは「反復回数は等価の構成要素に入れない」というこの 1 点だけ。
- **memory profile**: 同上。
- **stack trace**: パッチ適用で行番号・内部関数名は必ず変わる。比較すると全パッチが `not_equal` になる。「**意味論的等価性の定義に stack を含めない**」は設計要件であり妥協ではない (`ai-guide/code-map.md` §等価性検証器)。
- **body 同期終了後の非同期タスクの副作用**: sandbox は body の同期完了で観測を打ち切る。`setTimeout` / `queueMicrotask` / 未解決 Promise の後続副作用は見ない。本 dataset は同期コード主体 + 計測ハーネス除去後は `$.ajax` の async も消えるので実害は低い (`ai-guide/code-map.md` §等価性検証器の穴 3)。
- **非決定性 API の生値**: `Date.now()` / `Math.random()` / `process.hrtime()` 等は sandbox の実行前 transform で固定または遮断する (ADR-0017)。固定後の値は両側同一なので等価判定に影響しない = 実質非観測。

### verdict の合成規則

各 oracle は `equal` / `not_equal` / `not_applicable` / `error` のいずれかを返す。全体 verdict は:

1. **`not_equal` が 1 つでもあれば → `not_equal`**。実際に観測できた非等価は、他軸で `error` / `not_applicable` が出ていても優先する (「観測できた非等価」> 「観測できなかった軸」 — `ai-guide/code-map.md` §verdict)。
2. **全 oracle が `not_applicable` → `error`**。観測対象がゼロ (戻り値なし・副作用なし・例外なし・DOM 変化なし) では等価を主張できない = 観測失敗扱い。
3. **`not_equal` がなく、`not_applicable` 以外がすべて `equal` → `equal`**。
4. **上記以外 (`not_equal` はないが `error` が混じる) → `error`** (または report 上は `inconclusive` として扱い手動レビューに回す)。

### oracle 評価の順序 (report の読みやすさ / short-circuit 用)

C5 (exception) → C1 (return) → C6 (interaction trace) → C2 (DOM) → C4 (mutation) → C3 (console)。例外が投げられると他 channel が観測不能になるため C5 を最初に見る (`tmp/oracle-mapping.md` §6)。C6 は C1 の直後 (作用点 A では計算の本体なので戻り値の次に重要)。これは「先に見る」順序の話で、verdict 合成自体は上の 4 規則どおり (= どの oracle が `not_equal` でも全体 `not_equal`)。

## 結果 / 影響

**得るもの:**

- 「等価」の意味が固定され、自動判定が成立する。RQ (C1〜C4 の ablation、事前分析の 10 パターン自動導出) の主張が「この operational definition の下で」と書ける
- threats to validity に「等価性検証器の観測範囲は 戻り値 / DOM mutation / object・array mutation / 新規 global key / console 呼出列 / 例外 に限定される (timing・memory・stack・同期後の非同期タスクは非観測)」と 1〜2 行で明記できる (`current-research.md` §妥当性の脅威 にも反映)

**諦めるもの (= false negative の既知の穴、`ai-guide/code-map.md` §等価性検証器の穴 + Phase 1.0 の発見):**

- setup で定義された **primitive 変数の最終値** (number / string / boolean): `executor.ts` は `typeof === "object"` の変数のみ追跡。カウンタ変数等の変化は見えない。Selakovic は collection 操作主体なので頻度低
- **DOM 環境が無い実行 (server 系)** での DOM 変化: そもそも `document` が無いので O5 は N/A。server 系で DOM を触るパッチは本 dataset にはない想定
- body 同期終了**後**の非同期タスクの副作用 (上述)
- **workload が exercise しない入力での非等価** (= C6 でも捕まらない): C6 は「この実行で workload が SUT に渡した引数」に対する答えしか見ない。例: `serverIssues/Chalk/issue_27a` の patch (`arguments.length===1 ? arg+'' : [].slice.call(arguments).join(' ')`) は `null`/`undefined` 単一引数では非等価 (`'null'` vs `''`) だが、workload (`test()`) は文字列 `'foo'` しか渡さないので C6 でも差が出ない (Phase 1.0 deep probe で実測確認 — `spike-results.md` §5.1)。これを捕まえるには「変更関数を生成入力で fuzz する」必要があるが、それは Selakovic の ground-truth (= "intended use に対して意味論保存") を*超える* → 本 checker の範囲外。threats-to-validity の調査プローブとしてサンプルに対して別途回し、「fuzz すると N 件で ground-truth と不一致」を threats に書く位置づけ。
- **dataset の ground-truth 自体が「intended use に対して」の判断**: `clientIssues/Angular/issue_10351` は Description.md で "Inefficient API usage" (= 意味論保存の性能最適化) に分類されているが、C6 で観測すると workload-observable に非等価 (`$scope.$eval('null.a', {null:{a:42}})` が `42` → `undefined`、`'this.null.a'` が `undefined` → `42`)。これは「元の angular が `null`/`this` を変数 lookup していたバグを、patch がキーワード扱いに修正した = 意味論*訂正*」で、Selakovic はそれを症状 (式評価が遅い) から perf に収録した、と解釈できる。**「Selakovic の ground-truth は著者の手動判断で、少なくとも 1 件 (#10351) は workload-observable な意味論差がある」→ 観測強化した checker は #10351 を `not_equal` 判定し ground-truth と不一致になる**。これは「checker が間違い」か「ラベルが間違い」かの解釈問題で、トリガーの「著者 ground-truth との一致率」検証 (= サンプル手動レビュー) で重点的に見る。`tmp/dataset-conventions.md` §1.3 が前から「自動判定と paper の手動判定の一致を検証する手段がない」と指摘していた具体例。
- これらは本 dataset (Selakovic 2016) では発生頻度が低く、RQ と事前分析の主張を脅かさない (#10351 の disagreement は 1 件で、threats に明記すれば RQ の主張は保たれる)。等価性検証器は**研究成果ではなく中間ツール**。汎用ツールとして他研究へ再利用する場合は拡張が必要 (= トリガー)

## トリガー (再検討の条件)

- 観測範囲外の差 (primitive 変数最終値・同期後の非同期タスク等) が原因で「非等価なのに `equal`」と誤判定するケースが dataset 内で見つかったとき → 該当 channel の観測を追加
- 著者 ground-truth (paper §7 / `Confirmed.md` の 10 件 = 上流 accept 済 + サンプル 10〜20 件の手動レビュー) との一致率が低いとき → operational definition または oracle 実装を見直す
- 別 dataset を対象に加える際に async completion / timing が本質的な等価性の構成要素になるとき → channel を追加し本 ADR を superseded

## 補足

- 前提の実証ステータス (C1–C5 が jsdom で取れる / C6 の必要性 / 既知の穴) は `tmp/phase2b-adr-assumption-audit.md` §B にソース付きでまとめた。要点: C1–C5 は Phase 1.0 代表 7 件 + Phase 2a の 97 件実走で取得実証済 (`spike-results.md` §5、`tmp/0003_phase2a-preprocess-rework/verify-97-results.md`)、C6 の必要性は #10351 の deep probe で実証済 (`spike-results.md` §5.1)、ただし C6 の*取得方法*「framework global を汎用 Proxy で包む」は未検証 = Phase 2b 着手前の spike 対象 (監査 §D-3)。
- 著者 ground-truth との突合手順: `Confirmed.md` の 10 件は「著者が確実に semantic-preserving と判断した issue」として、これらで oracle が `equal` を返さなければ我々の判定が誤検出。残り 87 件はサンプル 10〜20 件を手動レビュー (`tmp/oracle-mapping.md` §7.1)。**#10351 系 (= C6 で非等価が出る issue) は重点的にレビュー**して「checker が正しい / ラベルが正しい」の解釈を Phase 3 で確定する。
