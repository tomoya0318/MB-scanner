# ADR-0015: equivalence-checker を common (dataset 非依存) + selakovic adapter に二層化し、DOM oracle (C2) と interaction-trace oracle (C6) を common 側の primitive として実装する

- **Status**: accepted。前提の実証ステータスは `tmp/phase2b-adr-assumption-audit.md` §D 参照（二層化パターンと adapter config の形は妥当 = §D-1/§D-4、C6 の汎用記録 Proxy wrap = §D-3 を spike で実証 — 結論と Proxy の機構・「包む対象」の詳細は `tmp/0005_phase2b-c6-proxy-spike/spike-results.md`、DOM 正規化プロファイルの中身 = §D-2 は実装中に 97 件再走で詰める性質）。本 ADR の再配置・C2/C6 oracle 追加の実コード移動は Phase 2b。
- **Date**: 2026-05-10
- **Related**: ADR-0011 (preprocess の対称な二層化 — 段1 の SUT 特定が interaction-trace の「包む対象」を決める), ADR-0012 (実行環境 — DOM/interaction-trace の生成経路は executor 側), ADR-0013 (等価の operational definition — C2・C6 を等価の構成要素に含める / verdict 合成規則), ADR-0016 (SUT lib の npm dep 解決 — dataset fork に lockfile で宣言するので adapter は dep を渡さない / 本 ADR の adapter config から vendor リスト行が消える), ADR-0017 (実行前 transform — iteration-cap の既定 N・on/off は adapter config), `mb-analyzer/src/equivalence-checker/`, `mb-analyzer/src/equivalence-checker/README.md`, `mb-analyzer/src/contracts/equivalence-contracts.ts`, `ai-guide/code-map.md` §等価性検証器, `tmp/oracle-mapping.md` §5, `tmp/phase2b-adr-assumption-audit.md` §D, `tmp/0002_phase1-adr-and-spike/spike-results.md` §5/§5.1

## このADRの守備範囲

このADRが決めるのは **「dataset 依存の判断を `common/` から `selakovic/` adapter に追い出す境界をどこに引くか」と「ADR-0013 が足すと決めた C2・C6 oracle をその構造のどこに・どんな I/F で実装するか」= equivalence-checker のコード構造**。具体的には: `common/` (dataset 非依存 primitive) と `selakovic/` (adapter) の二層化と一方向 DI / ファイル配置 / **adapter が `common/` に渡す config の全リストと各々の中身** (oracle 選択・DOM 正規化プロファイル・interaction-trace の包む対象 + 正規化・console ノイズ除去・iteration-cap の既定 N と on/off・timeout — SUT lib の npm dep は ADR-0016 で dataset fork に lockfile で宣言する方式に変えたので adapter config からは*外れる*) / C2 oracle の I/F / C6 oracle の I/F / 移行手順。

**扱わないこと** (他 ADR の管轄。本 ADR は該当箇所を 1 行参照するだけ):
- 何を一致と見なすか / どの channel を等価の構成要素にするか → **ADR-0013 (等価の定義)**
- jsdom か Playwright か / `capture.dom_html`・`capture.interaction_trace` の*生成経路* → **ADR-0012 (実行環境)** / iteration-cap transform の*アルゴリズム*・非決定性 API の固定 → **ADR-0017** / SUT lib の npm dep 解決 (= dataset fork に lockfile で宣言、checker 側の解決は `createRequire(moduleBaseDir)` のまま) → **ADR-0016**

> 1 つの話題が複数 ADR にまたがるときの分界: *なぜ等価判定がそれを無視するか* → 0013 / *sandbox がそれをどう処理するか（アルゴリズム・方式）* → 0012 / *Selakovic の場合の具体値・どの adapter フィールドで渡すか・どのファイルに置くか* → 0015（ここ）。

## コンテキスト

現状の `equivalence-checker/` はフラット構成: `oracles/{return-value, argument-mutation, exception, external-observation}.ts` + `sandbox/{executor, serializer, stabilizer}.ts` + `checker.ts` + `verdict.ts`。対象 dataset が Selakovic 1 個だけなので「dataset 依存ロジックがどこに散らばっているか」は今は問題化していない。だが:

1. **DOM oracle (C2) と interaction-trace oracle (C6) を Phase 2 で足す必要がある**。ADR-0013 で「mount point 配下の DOM mutation (C2)」と「workload が SUT に投げた呼び出しの戻り値・例外のトレース (C6 — Phase 1.0 スパイクで #10351 の真の意味論差を見つけたのを受けて追加)」を等価の構成要素に含めると決めた以上、`oracles/dom-mutation.ts` と `oracles/interaction-trace.ts` (相当のもの) が要る。
2. **preprocess を ADR-0011 で `preprocessing/common/` (dataset 非依存) + `preprocessing/selakovic/` (Selakovic adapter) に二層化する**。等価検証側も同じ思想で揃えておかないと、「dataset 依存ロジックの隔離先」が preprocess と等価検証でチグハグになる。
3. 等価検証には**実は dataset 依存の判断が紛れ込む余地**がある: どの oracle を走らせるか (client は DOM oracle 要、server は不要) / DOM の正規化規則 (AngularJS や React がレンダリング時に足すノイズの種類 = 使われている framework 群に依存) / **interaction-trace で「どのオブジェクトを記録 Proxy で包むか」(server = `module.exports`、client = framework global `angular`/`React`/`$` + 注入 service `$scope`/`$compile`) と「trace 値の比較前正規化」(angular の `$$hashKey` 等)** / 計測ハーネスの `console.log(mean)` が preprocess を擦り抜けた場合のノイズ除去 / sandbox の timeout や非決定性 API stub のリスト / **iteration-cap の threshold・既定 N** / **server lib が `require` する npm dep の解決戦略** (Selakovic は npm dep を bundle していない — Phase 1.0 で判明、`spike-results.md` §6)。これらを `checker.ts` に直書きすると、将来 dataset を足すときに分岐だらけになる。

「2 つの実行 capture を観測して比較する」(= 戻り値・例外・console・状態変化・DOM の比較 primitive) は dataset を一切知らなくても書ける。一方上記 3 の判断は Selakovic dataset の計測プロトコルや使用 framework を知らないと書けない。この境界をコード構造に落とす。

## 選択肢

- **A. フラットのまま DOM oracle を `oracles/dom-mutation.ts` に足すだけ**: 実装が一番楽。dataset 依存ロジック (oracle 選択・DOM 正規化規則・console ノイズ除去・sandbox config) が `checker.ts` に直書きされ、preprocess の二層構造と非対称。将来 dataset 追加時は `checker.ts` を if 分岐だらけにするか全面書き換え。
- **B. preprocess と対称に二層化**: `equivalence-checker/common/` = dataset 非依存 (oracle primitive・sandbox・verdict)、`equivalence-checker/selakovic/` = adapter (oracle 選択・DOM 正規化プロファイル・console ノイズ除去・sandbox config、`checkEquivalence` の公開エントリ)。`common/` は `selakovic/` を import しない一方向 DI を ESLint `import/no-restricted-paths` で機械強制 (preprocess の `common`→`selakovic` と同じ)。DOM oracle primitive は `common/oracles/dom-mutation.ts`、Selakovic 固有の正規化規則は `selakovic/` から `opts` で注入。
- **C. dataset ごとに `equivalence-checker/<dataset>/` プラグイン型**: 今は 1 個しかないので過剰。B のままで将来 `equivalence-checker/<other>/` を足せば足りる。

### 評価

| 軸 | A (フラット) | B (二層化) | C (プラグイン) |
|---|---|---|---|
| dataset 依存ロジックの隔離 | ✗ (checker.ts に直書き) | ✓ (selakovic/ に集約) | ✓ |
| preprocess (ADR-0011) との対称性 | ✗ | ✓ (`common/` + `<dataset>/` で統一) | ✓ |
| `common/` の単体テスト (benchmark 非依存) | ✗ (checker と密結合) | ✓ | ✓ |
| DOM oracle の実行環境非依存性 (ADR-0012) | △ (どこに置いても可) | ✓ (`common/oracles/`、`capture.dom_html` を見るだけ) | ✓ |
| 実装コスト (Phase 2) | 小 (oracle 1 個追加) | 中 (再配置 + import 更新 + lint ルール) | 大 (抽象化レイヤ追加) |
| 将来 dataset 追加時 | checker.ts 改造 | `<dataset>/` 追加、`common/` 再利用 | プラグイン追加 |

## 決定

**B (preprocess と対称に二層化) を採用する。**

### 配置

```
equivalence-checker/
├── common/                     ← dataset 非依存。「2 つの実行 capture を観測して比較」だけ
│   ├── oracles/                ← サブディレクトリのまま維持 (フラットにしない — 6 本ファミリー)
│   │   ├── return-value.ts         (C1) 戻り値 deep equal
│   │   ├── argument-mutation.ts    (C4) setup 由来 object/array の pre/post snapshot 差分
│   │   ├── exception.ts            (C5) 例外 ctor + message
│   │   ├── external-observation.ts (C3 + C4 一部) console 呼出列 + 新規 global key
│   │   ├── dom-mutation.ts         (C2) 正規化 DOM-HTML 文字列比較 ★Phase 2 新規
│   │   └── interaction-trace.ts    (C6) workload→SUT 呼び出しの (戻り値・例外) 列の一致 (正規化後) ★Phase 2 新規
│   ├── sandbox/
│   │   ├── executor.ts             vm/jsdom 隔離実行 (DOM 環境があれば capture.dom_html を出す / SUT を記録 Proxy で包んで capture.interaction_trace を出す)
│   │   ├── serializer.ts           値 → 正規化文字列
│   │   └── stabilizer.ts           非決定性 API 遮断 + console hook + iteration-cap (`for(...; i<BIG; ...)` → `i<N`) transform
│   └── verdict.ts                  oracle 観測の合成 (ADR-0013 の 4 規則)
├── selakovic/                  ← dataset 依存。Selakovic 規約を common 層に橋渡しする adapter
│   └── checker.ts                  checkEquivalence(EquivalenceInput) = 公開エントリ
└── index.ts                    ← 公開 re-export (selakovic の checkEquivalence + common の contracts)
```

境界の判定基準は ADR-0011 と同じ: **「ECMAScript / Node 標準だけで書けるか」→ Yes なら `common/`。「Selakovic の計測プロトコルや使用 framework を知らないと書けないか」→ Yes なら `selakovic/`。**

### `common/` 側の責務 — dataset 非依存

- `common/oracles/*`: 各 oracle は `(slow: ExecutionCapture, fast: ExecutionCapture, opts?) → OracleObservation` の純粋関数。観測対象が無ければ自分で `not_applicable` を返す (例: server 系で `capture.dom_html` が null なら O5 は N/A)。`f1` / `init` / `mark` / 計測ハーネスの形を一切参照しない。
- `common/sandbox/*`: `(setup, body, timeout)` を隔離実行し `ExecutionCapture` を返す。DOM 環境があれば `capture.dom_html` に正規化前の HTML を詰める (jsdom: `dom.serialize()` / Playwright: `page.content()` — ADR-0012)。
- `common/verdict.ts`: ADR-0013 の verdict 合成規則 (`not_equal` が 1 つでも → `not_equal` / 全 N/A → `error` / N/A 以外すべて `equal` → `equal` / それ以外 → `error`)。

### `selakovic/checker.ts` 側の責務 — dataset 依存

`checkEquivalence(EquivalenceInput)` の公開エントリ。以下を `common/` に**引数として**渡す:

| 責務 | 中身 | 渡し先 |
|---|---|---|
| oracle 選択 | candidate の `LayoutKind` / 作用点で走らせる oracle の部分集合 (client → O5 含む / server → O5 は呼んでも N/A なので省略可 / 作用点 A → O6 (interaction trace) が主軸 / 作用点 B → O6 はほぼ N/A / IV-B → O3 を重視) | どの oracle 関数を呼ぶか |
| DOM 正規化プロファイル | root = jsdom の `document` / AngularJS の `ng-*` 属性・`class` 内の `ng-scope`/`ng-binding`・`<!-- ngView/ngIf/ngRepeat ... -->` コメントマーカーを無視 / React (0.x) の `data-reactid` 属性・`<!-- react-text: N -->` `<!-- /react-text -->` コメントを無視 / 共通: 空白の collapse・属性の辞書順ソート / **Selakovic の `f1` workload が mount する `<script>` タグのテキストは無視** (元の `v_*.html` を mount するため slow/fast 共通だが念のため) | O5 `dom-mutation.ts` の `opts` |
| interaction-trace の対象 + 正規化 | **包む対象 = workload (`f1`/`test()`) が受け取る・叩く境界オブジェクト**: server = `init()` の戻り値の object/function 値 (`require('./<lib>_*.js')` の `module.exports` 等) **および `setupTest()` の戻り値の object/function 値** (SUT 由来 object は `setupTestResult` 側にいることがある — `new LRU(2)` の `cache`、`underscore.extend({x:0}, Backbone.Events)` の `bb` 等)。`init`/`setupTest` 自体は RAW SUT で実行し、戻り値を wrap してから `test()` に渡す / client = controller に注入される service (`$scope`/`$compile`/`$filter` のうち workload が使うもの)。**framework global (`window.angular`/`window.React`/`window.$`・`window.jQuery`/`window._`) は `f1` が直接叩く場合のみ包む** — angular-controller-wrapper 系は `$scope.$eval` だけ叩くので注入 service だけでよく `window.angular` を包むと bootstrap-phase の `angular.module`/`angular.injector` 等を拾う / lib-file 系 (jQuery `$('p')` / Underscore `_.invert` / EJS `ejs(...)` 等) は `f1` が global を直接叩くのでそれを包む。**trace 値の正規化**: angular が付ける `$$`-prefix プロパティ (`$$hashKey` 等) を無視 / serializer 共通の正規化 (循環参照 `<<circular>>` / 関数 `<<function>>` / object キー sort / 深さ上限 / DOM ノードは `<dom:tag#id.cls text="…">` の短縮表現 — cheerio/jQuery の DOM ノード混じり戻り値で効く)。Selakovic adapter は使用 framework を知ってよいので包む対象は hardcode で十分 | O6 `interaction-trace.ts` の `opts` + `common/sandbox/executor.ts` (記録 Proxy = `get`/`set`/`apply`/`construct` トラップ + 戻り値の再帰 wrap + WeakMap キャッシュ — `tmp/0005_phase2b-c6-proxy-spike/spike-results.md` §3/§7) |
| console ノイズ除去 | 計測ハーネスの `console.log(mean)` 等が preprocess の harness 除去を擦り抜けた場合に O4 入力から除く既知パターン (Selakovic では原則 preprocess で消える想定なので保険) | O4 `external-observation.ts` の `opts` |
| sandbox config | timeout (重い AngularJS issue 用に長め、97 件は 20000ms で実走) / stub する非決定性 API のリスト / **iteration-cap の `{ iterationCap: N \| null }`** (既定 N=3〜5、`null` で無効化 = 原文どおり全反復。transform の*アルゴリズム*は ADR-0017) | `common/sandbox/executor.ts` |

> ※ 当初この表に「SUT lib の npm dep の vendor リスト」を adapter config として置いていたが、ADR-0016 で「上流が宣言しない dep を dataset fork に lockfile (`package.json` + `pnpm-lock.yaml`) で宣言する」方式に変更したため、dep は `createRequire(moduleBaseDir)` が issue dir から到達可能な `node_modules/` (fork の lockfile から `pnpm install` で再生成済み) から引く = adapter は dep を一切渡さない。`EquivalenceInput` への `vendor_dirs` 追加も不要。
| (将来) `mark` 突合 | `$.ajax({mark: 0\|1})` の値を ground-truth ヒントとして使う場合の照合 | adapter 内で完結 |

`common/` は adapter が無くても単体でテスト可能 (= benchmark 非依存のユニットテストが書ける)。DI 方向は `selakovic/` → `common/` の一方向で、ESLint `import/no-restricted-paths` (`mise run lint-analyzer`) で機械強制する (preprocess の `preprocessing/common` → `preprocessing/selakovic` と同じ)。

### DOM oracle (C2) の実装方針

- **`common/oracles/dom-mutation.ts`**: `(slow, fast, opts: DomNormalizeProfile) → OracleObservation`。
  - `opts` ≈ `{ rootSelector?: string; ignoreAttributes: string[]; ignoreClassTokens: string[]; ignoreCommentNodes: boolean; collapseWhitespace: boolean; sortAttributes: boolean }`
  - `capture.dom_html` (正規化前の生 HTML 文字列) を `opts` で正規化し、両側の正規化結果を文字列比較
  - 両側とも `capture.dom_html` が null (= DOM 環境なし) → `not_applicable`
  - 両側の正規化 HTML が一致 → `equal` / 不一致 → `not_equal` (`detail` に最初の差分位置)
  - 片側だけ DOM 環境あり → `not_equal` (環境差なので通常起きないが防御的に)
- **sandbox 側**: `capture.dom_html` の生成は実行環境に応じて jsdom (`dom.serialize()`) / Playwright (`page.content()`) で行う (ADR-0012)。oracle はその文字列を受け取るだけ = 環境非依存。
- **Selakovic 正規化プロファイルの中身**: 上の表の値は **暫定**。Phase 1.0 スパイク (React/808 = `innerHTML → textContent` 5 連) で C2 が jsdom で取れること自体は実証済 (`#demo1`/`#demo2` の innerHTML mutation を `dom.serialize()` で比較できた — `spike-results.md` §5)。AngularJS / React が実際に DOM へ足すノイズの具体パターンは Phase 2 で実物を見て確定する。

### interaction-trace oracle (C6) の実装方針

- **`common/oracles/interaction-trace.ts`**: `(slow, fast, opts) → OracleObservation`。`capture.interaction_trace` (= `[{ path, op: "call"|"construct"|"get", args正規化?, result正規化 | thrown正規化 }]` の列) を `opts` で正規化 (`$$`-prefix プロパティ無視等) して両側を要素ごとに比較。両側とも trace が空 (作用点 B 等で SUT を包んでない) → `not_applicable`。一致 → `equal` / 不一致 → `not_equal` (`detail` に最初の差分要素)。
- **記録は「境界」だけ・「答え」だけ**: 包むのは workload (`f1`/`test()`) が*受け取る・叩く* SUT の境界オブジェクトのみ。記録するのは各呼び出し (メソッド call / 関数 apply / `new` construct) の *戻り値 / 投げた例外*（= workload が観測しうるもの）であって、SUT 内部の関数呼び出し列・一時変数は記録しない。これを機構で保証する鍵は **呼び出し転送を real target を `this` (or 素の `Reflect.construct`) にして実行する**こと — SUT 内部の `this.foo()` 連鎖は Proxy を通らないので trace に乗らない。chained API (`obj('.apple').next('.orange')…`、`$('p').get(-1)`) を辿るために traced call/construct の戻り値も再帰 wrap するが、wrap されるのは「workload が次に叩くオブジェクト」だけで内部は real のまま。→ 純粋な性能最適化 (同じ戻り値・内部だけ違う) は trace 同一 → `equal`、挙動変更 (戻り値が違う) は trace 違い → `not_equal`。「主因のコードは等価だが副次的な内部コードで誤 `not_equal`」が原理的に起きない (`tmp/0005_phase2b-c6-proxy-spike/spike-results.md` §2.1(c)/§7 — angular/chalk/cheerio/jQuery 等 7 SUT で内部ノイズ 0 を実証)。
- **sandbox 側 (= 汎用記録 Proxy の機構)**: `executor.ts` が adapter から渡された「包む対象」のオブジェクトを **`get`/`set`/`apply`/`construct` トラップを持つ記録 Proxy** で wrap し、呼び出しを `capture.interaction_trace` に append する。`get`/`set`/`apply`/`construct` 以外のトラップは未定義 (= Reflect 素通し) なので `instanceof` / `hasOwnProperty` / `Object.getPrototypeOf` / `ownKeys` を壊さない (Selakovic の 7 SUT どれも Proxy で包んで壊れなかった)。`apply`/`construct` トラップは「SUT を関数として直接呼ぶ」(cheerio root `obj(...)`、`jQuery(...)`、`ejs(...)`) や「コンストラクタ」(`new LRUCache(...)`) を記録するのに要る。同一 target の再 wrap は WeakMap でキャッシュ (chained API で identity が暴れるのを防ぐ)。oracle はできた列を受け取るだけ = 実行環境非依存。当初案の「`get`/`set` だけの Proxy」では cheerio の連鎖や jQuery の関数呼び出しが取れないので不足 — Phase 2b 着手前 spike で確定 (`spike-results.md` §3/§7)。
- **C6 を入れる根拠と取得方法の実証**: Phase 1.0 deep probe で `$scope.$eval` をラップして式→結果をログし、angular-10351 で `$scope.$eval('null.a', {null:{a:42}})` が `42`(before)→`undefined`(after) と differ する (= shallow 観測 (C1) では `equal` に見えるのを正しく `not_equal` に) を検出 = C6 を入れる根拠。その「hand-written な 1 メソッドラッパ」を「汎用記録 Proxy」に格上げできるかは Phase 2b 着手前 spike で実証済 (`tmp/0005_phase2b-c6-proxy-spike/spike-results.md` — angular/chalk + cheerio/node-lru-cache/moment/jQuery/underscore の 5 形を含む 7 SUT で完走、C6 verdict は ground-truth と一致、内部ノイズなし)。

### iteration-cap transform — 配置と config (決定とアルゴリズムは ADR-0017)

- 置き場は `common/sandbox/stabilizer.ts` 系 (= 非決定性 API stub と同じ「実行を決定的・tractable にする」transform の仲間)。**transform の決定 (sandbox 側で・preprocess には焼き込まず・`{N | null}` で parameterize) と AST pass のアルゴリズムは ADR-0017 の管轄。**
- adapter (`selakovic/`) が `{ iterationCap: N | null }` を渡す: 既定 N は小さく 3〜5、`null` = 無効 = 原文どおり全反復実行。これが本 ADR (構造 + adapter config) の管轄分。

### 移行 (Phase 2)

- `oracles/* → common/oracles/*`、`sandbox/* → common/sandbox/*`、`verdict.ts → common/verdict.ts`、`checker.ts → selakovic/checker.ts`、`index.ts` はルート維持で re-export 先を更新
- 新規: `common/oracles/dom-mutation.ts` (C2)、`common/oracles/interaction-trace.ts` (C6)、`common/sandbox/executor.ts` に「DOM 環境構築 (jsdom)」「SUT を記録 Proxy で包む」「iteration-cap transform 呼び出し」を追加、`common/sandbox/stabilizer.ts` に iteration-cap transform を追加。`contracts/equivalence-contracts.ts` の `ExecutionCapture` に `dom_html?: string | null` と `interaction_trace?: TraceEntry[]` を追加 (+ Python 側 paired-change)
- Phase 2a (preprocess) では `equivalence-checker/` は**フラットのまま** = preprocess 出力の検証器として使う。再配置 + DOM/interaction oracle 追加は Phase 2b (ADR-0011 §段「進行順序」、`plan.md` §備考)
- import path の全面更新 + ESLint `import/no-restricted-paths` ルール追加 + テストファイル (in-source / `tests/`) の import 更新
- `equivalence-checker/README.md` の依存図・ファイル index を二層構造に更新
- 本 ADR は `proposed` (構造の合意は固まっているが `accepted` 昇格は C6 spike 完了時 — §補足)。実コード移動は Phase 2b

## 結果 / 影響

**得るもの:**

- dataset 依存ロジックが `selakovic/checker.ts` に隔離され、`common/` は benchmark 非依存のユニットテストが書ける
- preprocess (ADR-0011) と等価検証で「dataset 依存の隔離先」の命名・構造が揃う (`common/` + `<dataset>/`)
- DOM oracle (C2) が実行環境非依存 (jsdom でも Playwright でも同一実装。oracle は `capture.dom_html` を見るだけ)
- 将来 Selakovic 以外の dataset を足すときは `equivalence-checker/<dataset>/` を新設するだけ。`common/` (oracle primitive・sandbox・verdict) はそのまま再利用

**諦めるもの:**

- Phase 2 で再配置のコスト (import path 全変更・ESLint ルール追加・テストの import 更新・README 更新)。一括でやる前提
- `common/oracles/dom-mutation.ts` の「素の正規化 HTML 文字列比較」では拾えない差 (例: 空白・属性順序の正規化では足りず DOM tree の構造単位で比較すべきケース) があれば、`opts` の表現力を上げるか別実装が要る → トリガーで監視
- DOM 正規化プロファイルが Selakovic 内の framework ごとに大きく違うと 1 プロファイルで足りなくなる (= `LayoutKind` ごとにプロファイルを切る必要)

## トリガー (再検討の条件)

- 別 dataset を対象に加える際に `equivalence-checker/common/` にも変更が必要になったとき → 「common = dataset 非依存」の定義を見直す
- DOM 正規化プロファイルが framework ごとに大きく分岐し、1 プロファイル + `LayoutKind` 分岐で収まらなくなったとき → プロファイルを `common/` 側の named preset 群にする等の再設計
- `common/oracles/dom-mutation.ts` の文字列比較が false positive / false negative だらけで、DOM tree の構造比較 (要素単位の対応付け) が必要と判明したとき
- ESLint `import/no-restricted-paths` で `common/` → `selakovic/` の逆流入を防げないケース (動的 import 等) が出たとき → import-linter (Python 側で使っているもの) 相当の機構を TS 側にも入れる

## 補足

- 「`common/oracles/` をサブディレクトリのまま維持する (preprocess の `common/` はフラットだが oracle は今 6 本ファミリーなのでディレクトリにする)」「DOM oracle primitive を `common/` に置き正規化プロファイルだけ `selakovic/` から注入する」「当初案の ADR 0016 は新設せず本 ADR に統合する」は 2026-05-10 にユーザ確認済 (`tmp/0002_phase1-adr-and-spike/prompt.md` フィードバック 2)。interaction-trace oracle (C6) も同じ思想で `common/oracles/interaction-trace.ts` (primitive) + `selakovic/` adapter (包む対象・正規化) に分ける — 2026-05-10 ユーザ確認済 (`spike-results.md` §5.1 の原理合意)。
- 現状の oracle 実装の意味論 (O1〜O4 が何を `not_applicable` にするか、O3 が stack を比較しない理由など) は `ai-guide/code-map.md` §等価性検証器 と `mb-analyzer/src/equivalence-checker/README.md` を参照。本 ADR はそれらを移動・拡張するだけで既存 oracle の意味論は変えない (C2・C6 を*足す*)。
- 前提の実証ステータスは `tmp/phase2b-adr-assumption-audit.md` §D にソース付き。要点: 二層化の手本となる preprocess の `common`/`selakovic` 構造は Phase 2a で commit 済・機能している / DOM oracle primitive が jsdom で成立 (react-808 で C2 取得、`tmp/0002_phase1-adr-and-spike/spike-results.md` §5) / interaction-trace の必要性を deep probe で実証 (#10351、同 §5.1) / **C6 の「SUT を汎用記録 Proxy で包む」機構も Phase 2b 着手前 spike で実証済** (`tmp/0005_phase2b-c6-proxy-spike/spike-results.md` — Proxy は `get`/`set`/`apply`/`construct` トラップ + traced call/construct の戻り値の再帰 wrap の形、angular/chalk/cheerio/node-lru-cache/moment/jQuery/underscore = 7 SUT で完走 & 内部ノイズなし。「包む対象」は server なら `init`/`setupTest` 戻り値、client なら注入 service + workload が叩く framework global)。DOM 正規化プロファイルの具体値は実装中に 97 件再走で詰める性質 (監査 §D-2)。
