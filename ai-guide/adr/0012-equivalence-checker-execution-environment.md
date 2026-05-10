# ADR-0012: 等価検証の実行環境を jsdom+vm 主軸 + Playwright fallback にする

- **Status**: proposed (Phase 1.0 スパイクで load-bearing な前提を実証済 — 代表 7 件すべて jsdom+vm で動作、AngularJS 1.3.18 665KB の load+bootstrap・server lib の npm dep 解決を含む。`tmp/0002_phase1-adr-and-spike/spike-results.md` §1/§2/§8。`accepted` 昇格は Phase 2b 着手時 — Phase 2a は本 ADR の「最小 jsdom sandbox」部分だけ前借りする)
- **Date**: 2026-05-10
- **Related**: ADR-0013 (等価の operational definition — timing/反復回数 非観測), ADR-0015 (DOM oracle / interaction-trace oracle は実行環境非依存 / iteration-cap・npm dep 解決の config), `mb-analyzer/src/equivalence-checker/sandbox/`, `ai-guide/code-map.md` §等価性検証器, `tmp/oracle-mapping.md` §8, `tmp/dataset-conventions.md` §6, `tmp/0002_phase1-adr-and-spike/spike-results.md` §1/§2/§6/§8, `tmp/0002_phase1-adr-and-spike/plan.md` Phase 1.0/1.1`

## コンテキスト

等価判定は `(setup, slow, fast)` の body を sandbox 実行して 5 channel (戻り値 / DOM / console / 状態変化 / 例外 — ADR-0013) を観測する。現状の `equivalence-checker/sandbox/` は `node:vm` ベースの隔離実行で、`window` / `document` を持たない (= DOM 環境なし)。

Selakovic dataset は **client 系 80 件 (Angular / Ember / jQuery / React の HTML 持ち issue)** を含み、その中に `innerHTML → textContent` (React/808 の 5 連、Angular/9369)、`element.text() → textContent`、jQuery `html()` / `empty()` 系といった **DOM を触るパッチ (C2 channel、推定 5〜10 件)** がある (`tmp/oracle-mapping.md` §5.4)。`node:vm` 単体では `document` が無いのでこれらの DOM 変化を観測できず、`f1.body` の中で DOM API を呼ぶと `error` になる。

実行環境の候補:

- **`node:vm` のみ** (現状): server 系 (test_case、DOM 不要) は問題ないが、client 系の DOM 系パッチが判定不能。
- **jsdom + `node:vm`**: `jsdom` パッケージが `window` / `document` を JS 実装で提供。軽量 (issue あたり ms オーダー)、AngularJS 1.x が動く実績がある。ただし `$compile` / `$watch` やレイアウト計算 (`getBoundingClientRect` 等) は完全には再現されない。
- **Playwright (実ブラウザ)**: chromium 等を起動して `page.evaluate` で実行。DOM / CSS / レイアウトが完全。ただしブラウザ起動コストが大きい (issue あたり 5〜10 秒)、CI で 97 件 × 起動は重い。
- **jsdom+vm 主軸 + Playwright fallback**: 通常は jsdom で実行し、jsdom で「環境が足りなくて観測できない / フレームワークの挙動が再現されない」と判明した issue だけ Playwright で再実行する。

## 選択肢

- **A. `node:vm` のみ (現状維持)**: 実装ゼロ。client 系 DOM 系パッチ (5〜10 件) は観測対象外 = false negative。threats が重くなる。
- **B. jsdom + vm 一本化**: 全 issue を jsdom で。jsdom で動かない issue は除外 (excluded) として記録。実装は中程度、CI は軽い。リスクは「AngularJS の compile/watch が再現されず DOM が両側とも空になる」issue が出ること。
- **C. Playwright 一本化**: 全 97 件を実ブラウザで。環境忠実度は最高だが、CI が重い (97 × 起動コスト ≈ 数十分)、server 系 (DOM 不要) にもブラウザを使うのは無駄。
- **D. jsdom+vm 主軸 + Playwright fallback**: jsdom で取れる issue は jsdom (大半)、jsdom で取れないと判明した issue だけ Playwright (chromium 1 種に絞る)。両環境とも oracle には `capture.dom_html` (正規化前 HTML 文字列) を渡すだけなので oracle 側は同一実装 (ADR-0015)。

### 評価

| 軸 | A (vm のみ) | B (jsdom 一本) | C (Playwright 一本) | D (jsdom 主軸 + Playwright fallback) |
|---|---|---|---|---|
| DOM 系パッチ (C2) のカバレッジ | ✗ | △ (jsdom で動く範囲) | ◎ | ◎ (jsdom で足りない分を Playwright で救済) |
| 通常実行の速度 | 速い | 速い (ms) | 遅い (秒) | 速い (大半 jsdom) |
| CI コスト | 低 | 低 | 高 | 中 (fallback 件数次第) |
| 環境忠実度 | 低 (DOM なし) | 中 | 高 | 高 (必要な issue だけ高忠実) |
| 依存追加 | なし | jsdom | playwright (重い) | jsdom + playwright |
| threats の重さ | 重い (DOM 系を諦める) | 中 (jsdom 不動 issue を諦める) | 軽い | 軽い (「N 件は Playwright で実行」と書ける) |

## 決定

**D (jsdom+vm 主軸 + Playwright fallback) を採用する。**

### 主軸: jsdom + `node:vm`

- `sandbox/executor.ts` (= ADR-0015 の `common/sandbox/executor.ts`) が、client 系のとき jsdom の `JSDOM` から `window` / `document` を作って vm context に注入する。server 系 (DOM 不要) は jsdom 環境を作らず現状の vm のみ → `document` が無いので DOM oracle (O5) は `not_applicable` を返す。
- body 同期実行後、`capture.dom_html` に `dom.serialize()` の結果 (正規化前の生 HTML 文字列) を詰める。
- 非決定性 API (`Date.now()` / `Math.random()` / タイマー) は stabilizer で固定・遮断する (現状の vm 版と同じ方針を jsdom 環境にも適用)。

### fallback: Playwright (chromium のみ)

以下のいずれかに該当した issue だけ Playwright で再実行する (具体的な該当件数・症状は Phase 1.0 スパイクで確定 — 下記「補足」):

1. jsdom での sandbox 実行が **環境不足由来の `error`** (`document.xxx is not a function` / `xxx is not defined` 等、jsdom が未実装の API) を返す
2. patch が明らかに DOM API を使っているのに jsdom で **C2 channel が両側とも空** (= jsdom が当該 DOM 操作を no-op にしている疑い)
3. AngularJS の `$compile` / `$watch` 等の挙動が jsdom で再現されず、slow/fast の DOM が**両方とも未レンダリング**で差が出ない

Playwright 側は `page.evaluate` で `(setup, body)` を実行し、`capture.dom_html` に `page.content()` の結果を詰める。**firefox / webkit は使わない** (chromium 1 種で十分、CI コストを抑える)。

### oracle 側は環境非依存

jsdom でも Playwright でも、oracle (特に O5 DOM oracle) が見るのは `capture.dom_html` (正規化前 HTML 文字列) と他の capture フィールドだけ。正規化 (空白・属性順序・フレームワークノイズの除去) は oracle 側 (= adapter から渡される正規化プロファイル、ADR-0015) で一括して行う。→ 実行環境の差は executor に閉じ込められ、oracle は 1 実装で済む。

### fallback 発火は記録する

何件が Playwright に回ったかを batch 結果に記録し、threats to validity に「N 件 (うち内訳…) は jsdom で環境不足のため Playwright (chromium) で実行した」と honest に書く。timing は等価判定の観測対象ではない (ADR-0013) ので、Playwright で実行しても等価判定の**結果**は変わらない (遅くなるだけ)。

### server lib の npm dep 解決 (Phase 1.0 で判明)

server 系の `<lib>_*.js` (例 `chalk_before.js`) は `require('escape-string-regexp')` 等の npm dep を bundle しておらず、dataset の `package.json` も jsexecutor の dep しか持たない (`spike-results.md` §6)。`init()` がその lib を `require` する issue は dep を解決しないと sandbox 実行できない。→ adapter (`equivalence-checker/selakovic/` — ADR-0015) が「各 lib の元 `package.json` から install / 主要 dep を fixture として vendor / stub」のいずれかで dep を用意する (具体策は Phase 2a で確定 — 既存フラット checker に 97 件流す際に dep 不足 issue を洗い出す)。スパイクでは `ansi-styles@2`/`escape-string-regexp@1`/`strip-ansi@3`/`supports-color@2` を spike dir に install して回避し、chalk-27a を正常に実行できた。

### 段階的実装 (Phase 2a → 2b)

- **Phase 2a**: preprocess 改修 (ADR-0011) の検証に**既存フラットの `equivalence-checker/`** を使う。vm のみで jsdom が無いので、server 系は完全に検証できるが client 系の run 検証が弱い → ここで**最小 jsdom sandbox** (= スパイク `spike-jsdom.mjs` の production 化、Playwright fallback も channel ルーティングも無し) を前借り実装し、client preprocess 出力も run 検証できるようにする。
- **Phase 2b**: `equivalence-checker/` を `common/`+`selakovic/` に再配置 (ADR-0015)、Playwright fallback・channel ルーティング・iteration-cap transform を完成。

## 結果 / 影響

**得るもの:**

- client 系の DOM 系パッチ (C2) が判定可能になる。「観測対象外で諦める」が「ほぼ全件観測できる」になり threats が軽くなる
- 通常実行は jsdom で軽量 (ms オーダー)、CI コストが現実的なまま
- 実行環境の差が `executor.ts` に閉じ込められ、oracle / verdict は環境非依存

**諦めるもの:**

- Playwright fallback が必要な issue は実行が遅い (5〜10 秒/issue)。fallback 件数が多いと batch 全体が遅くなる
- `playwright` を dev 依存に追加 (バイナリが重い、CI セットアップに `playwright install chromium` が要る)
- jsdom と Playwright で `capture.dom_html` の生成経路が 2 系統になる (ただし生成後の正規化は oracle 側 1 箇所)

## トリガー (再検討の条件)

- Playwright fallback 率が高い (例: client 80 件中 30 件超が fallback) とき → jsdom の代わりに happy-dom 等の別実装を検討、または client 系を全面 Playwright に倒すことを再検討
- jsdom が AngularJS 1.x の典型パターンで根本的に動かない (compile/watch が機能せず DOM が常に空) と Phase 1.0 で判明したとき → client 系の DOM 系を全面 Playwright に変更
- `playwright` の CI セットアップコストが許容できなくなったとき → fallback トリガー 2/3 を諦め、1 (実行 error) のみ Playwright に回す

## 補足

- **Phase 1.0 スパイクで本 ADR の load-bearing な前提を実証済** (`tmp/0002_phase1-adr-and-spike/spike-results.md` §1/§2/§8。`accepted` 昇格は Phase 2b 着手時 — Phase 2a は最小 jsdom sandbox だけ前借り): 代表 7 件 (chalk 27a / Angular 4359 / Angular 9067 lib・body / Mocha 701 / React 808 / **Angular 10351 = AngularJS 950KB を jsdom で load+bootstrap+`f1()` 実行**) を **jsdom+vm で全件動作**させた。AngularJS 1.3.18 (665KB) を jsdom で load し `angular.injector(['ng','myApp']).get('$controller')` で controller を実体化して `f1()` を `$scope.$eval` 込みで実行できることを実証 (= 本 ADR の最大リスクだった「jsdom が AngularJS でほぼ動かない」は否定)。C2 (DOM) も react-808 で取れた。**fallback トリガー 1〜3 に該当する issue は本 7 代表には無かった** → Playwright fallback は「DOM 忠実性が要る patch (`getBoundingClientRect` / レイアウト依存 / CSS 計算等) で jsdom が失敗した場合」の文書化された機構として残すが、本代表では未発火。発火条件の最終確定は Phase 2a (= 既存フラット checker に 97 件流して `error`/`not_equal` の理由を見る) で行う。
- スパイク script は `mb-analyzer/src/` 無変更の使い捨て (`tmp/0002_phase1-adr-and-spike/spike/`)。Phase 2a の最小 jsdom sandbox はこれを production 化する種にする (`spike-results.md` §8、本 ADR §段階的実装)。
- 「DOM oracle が既存 sandbox に潜在していないか」の再確認も実施済 — `sandbox/{executor,serializer,stabilizer}.ts` に DOM 取得機能は無い (Phase 2 で `executor.ts` に jsdom 環境構築 + `capture.dom_html` + `capture.interaction_trace` を足す — ADR-0015)。
