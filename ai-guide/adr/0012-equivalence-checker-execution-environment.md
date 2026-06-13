# ADR-0012: 等価検証の実行環境を jsdom+vm 主軸 + Playwright fallback にする

- **Status**: accepted (2026-05-11)。前提は Phase 1.0 代表 7 件 + Phase 2a 97 件実走で実証済（`tmp/phase2b-adr-assumption-audit.md` §A-1/§A-2）。残っていた §C-1（Playwright fallback の扱い）は下記「### fallback: Playwright」に判断を書き込んだ — fallback トリガーは 7 代表でも 97 件でも 0 発火のため Playwright executor は未実装の documented-but-untested とし、trigger を満たす issue が出たら trigger 1（runtime error）から実装する。Phase 2a は本 ADR の「最小 jsdom sandbox」部分を前借り済、Phase 2b で `common/sandbox/executors/{vm,jsdom}.ts` への再配置 + server vm globals/`.json` require を実装済。
- **Date**: 2026-05-10
- **Related**: ADR-0013 (等価の operational definition — どの channel を観測するか / timing は非観測), ADR-0015 (equivalence-checker の構造 — DOM/interaction-trace oracle は実行環境非依存、`capture.dom_html` を見るだけ), ADR-0016 (SUT module の npm dep 解決 — 上流が宣言しない dep を dataset fork に lockfile で宣言。sandbox はそれが install 済みで `createRequire` で引ける状態で body を走らせる), ADR-0017 (sandbox の実行前 transform — 非決定性 API の固定 + iteration-cap), `mb-analyzer/src/equivalence-checker/sandbox/`, `tmp/oracle-mapping.md` §8, `tmp/dataset-conventions.md` §6, `tmp/phase2b-adr-assumption-audit.md` §A/§C-1/§C-2, `tmp/0002_phase1-adr-and-spike/spike-results.md` §1/§2/§8

## このADRの守備範囲

このADRが決めるのは **「等価判定のために `(setup, slow, fast)` の body を*どの JS 実行環境で*走らせるか」だけ** — jsdom + `node:vm` を主軸にし、jsdom で DOM 忠実性が足りない issue だけ Playwright (chromium) で再実行する fallback を持つ。+ その帰結として「環境差を executor に閉じ込め、oracle は `capture.dom_html`/`capture.interaction_trace` を受け取るだけ = 環境非依存」という設計原則。

**扱わないこと** (他 ADR の管轄。本 ADR は該当箇所を 1 行参照するだけ):
- 何を一致と見なすか / どの channel を等価の構成要素にするか / 何を非観測にするか → **ADR-0013 (等価の定義)**
- equivalence-checker の `common`/`selakovic` 二層化 / oracle のファイル配置と I/F / adapter config (timeout 値・正規化プロファイル等) → **ADR-0015 (構造 + adapter config)**
- SUT lib (`<lib>_*.js`) が `require` する npm dep をどう用意するか (= 上流 dataset が宣言しない dep を dataset fork に lockfile で宣言、`pnpm install` で再生成。checker 側の解決は `createRequire(moduleBaseDir)` のまま) → **ADR-0016**
- body 実行前に sandbox が施す transform (非決定性 API の固定 / iteration-cap = loop bound の AST clamp) → **ADR-0017**

> 1 つの話題が複数 ADR にまたがるときの分界: *なぜ等価判定がそれを無視するか* → 0013（定義） / *sandbox がそれをどう処理するか（アルゴリズム・方式）* → 実行環境=0012・実行前 transform=0017・依存解決=0016 / *Selakovic の場合の具体値・どの adapter フィールドで渡すか* → 0015。

## コンテキスト

等価判定は `(setup, slow, fast)` の body を sandbox 実行して 6 channel (戻り値 / DOM / console / 状態変化 / 例外 / workload↔SUT の interaction trace — ADR-0013。C6 = interaction trace は Phase 1.0 スパイクで追加) を観測する。現状の `equivalence-checker/sandbox/` は `node:vm` ベースの隔離実行で、`window` / `document` を持たない (= DOM 環境なし)。

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

- `sandbox/executor.ts` (= ADR-0015 の `common/sandbox/executor.ts`) が、client 系のとき jsdom の `JSDOM` から `window` / `document` を作って vm context に注入する。server 系 (DOM 不要) は jsdom 環境を作らず現状の vm のみ → `document` が無いので DOM oracle (O5) は `not_applicable` を返す。
- **server 系 SUT 用に最小 Node グローバルを vm context に用意する**: `process` (`{ browser: false, env: {}, nextTick, stdout: { isTTY: false } }` 等の最小スタブ) / `Buffer` / `global` / `setImmediate`。SUT lib (cheerio 等) が `process.browser` / `process.env` / `Buffer` を参照するため。また相対 `require('<path>.json')` は vm で eval せず `JSON.parse` で解決する (SUT lib が `require('../package.json')` 等でバージョンを読む)。これらが無いと SUT lib が `ReferenceError: process is not defined` / `SyntaxError` で落ち、`test()` が走らず両側同じエラー = trivial equal になる (監査 §C-5 の trivial-equal バケツの一因 — ADR-0016 の npm dep vendor と合わせて潰す)。Phase 2b 着手前 spike で確認 (`tmp/0005_phase2b-c6-proxy-spike/spike-results.md` §7)。
- body 同期実行後、`capture.dom_html` に `dom.serialize()` の結果 (正規化前の生 HTML 文字列) を詰める。
- 非決定性 API (`Date.now()` / `Math.random()` / タイマー) の固定・遮断、および計測ハーネスの大反復ループの iteration-cap は、jsdom でも Playwright でも同じく sandbox の実行前 transform として適用する — 詳細は **ADR-0017**。

### fallback: Playwright (chromium のみ)

以下のいずれかに該当した issue だけ Playwright で再実行する (具体的な該当件数・症状は Phase 1.0 スパイクで確定 — 下記「補足」):

1. jsdom での sandbox 実行が **環境不足由来の `error`** (`document.xxx is not a function` / `xxx is not defined` 等、jsdom が未実装の API) を返す
2. patch が明らかに DOM API を使っているのに jsdom で **C2 channel が両側とも空** (= jsdom が当該 DOM 操作を no-op にしている疑い)
3. AngularJS の `$compile` / `$watch` 等の挙動が jsdom で再現されず、slow/fast の DOM が**両方とも未レンダリング**で差が出ない

Playwright 側は `page.evaluate` で `(setup, body)` を実行し、`capture.dom_html` に `page.content()` の結果を詰める。**firefox / webkit は使わない** (chromium 1 種で十分、CI コストを抑える)。

**§C-1 の判断 (accepted 時点)**: 上記 trigger 1〜3 は Phase 1.0 代表 7 件でも Phase 2a 97 件実走でも **0 発火** (`tmp/phase2b-adr-assumption-audit.md` §C-1)。よって本 ADR では Playwright fallback を**設計には残すが executor は実装しない (documented-but-untested)**。jsdom で環境不足由来の `error` になった issue は batch 結果にその旨を記録する (= 現状は trigger 1 の手前で止まっている状態)。将来 trigger を満たす issue が現れたら **trigger 1 (runtime error → chromium 再実行) から実装**し、必要なら本 ADR の「## トリガー」も含めて再検討する。`playwright` の dev 依存追加・CI セットアップも実装時まで先送り。

### oracle 側は環境非依存

jsdom でも Playwright でも、oracle (特に O5 DOM oracle) が見るのは `capture.dom_html` (正規化前 HTML 文字列) と他の capture フィールドだけ。正規化 (空白・属性順序・フレームワークノイズの除去) は oracle 側 (= adapter から渡される正規化プロファイル、ADR-0015) で一括して行う。→ 実行環境の差は executor に閉じ込められ、oracle は 1 実装で済む。

### fallback 発火は記録する

何件が Playwright に回ったかを batch 結果に記録し、threats to validity に「N 件 (うち内訳…) は jsdom で環境不足のため Playwright (chromium) で実行した」と honest に書く。timing は等価判定の観測対象ではない (ADR-0013) ので、Playwright で実行しても等価判定の**結果**は変わらない (遅くなるだけ)。

### 関連する sandbox の振る舞い (本 ADR の管轄外)

- **実行前 transform** (非決定性 API の固定・iteration-cap = loop bound の AST clamp) → **ADR-0017**。jsdom でも Playwright でも同じく適用する。
- **SUT lib の npm dep 解決** (= 上流 dataset が宣言しない dep を dataset fork に lockfile で宣言、checker 側の解決ロジックは追加なし) → **ADR-0016**。`init()` が `require('<lib>_*.js')` → さらに npm dep を呼ぶ issue は、fork が宣言し install 済みの dep が `createRequire(moduleBaseDir)` で引ける状態で sandbox 実行する。
- **adapter config** (timeout 値・DOM 正規化プロファイル等) と **二層化の構造** (`common/sandbox/executor.ts` 等) → **ADR-0015**。

### 段階的実装 (Phase 2a → 2b)

- **Phase 2a (完了)**: preprocess 改修 (ADR-0011) の検証に既存フラットの `equivalence-checker/` を使い、**最小 jsdom sandbox** (= スパイク `spike-jsdom.mjs` の production 化 = `sandbox/jsdom-executor.ts`、Playwright fallback も channel ルーティングも無し) だけ前借り実装した。
- **Phase 2b**: `equivalence-checker/` を `common/`+`selakovic/` に再配置 (ADR-0015)、server vm globals/`.json` require、channel ルーティング、iteration-cap transform の AST pass 化 (ADR-0017) を実装。Playwright fallback は §C-1 の判断どおり documented-but-untested（executor 未実装）。

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

- 前提の実証ステータスは `tmp/phase2b-adr-assumption-audit.md` §A/§C にソース付き。要点: jsdom+vm 主軸は Phase 1.0 代表 7 件 (AngularJS 1.3.18 665KB の load+bootstrap+`f1()` 実行を含む) + Phase 2a の 97 件実走で実証済 (`spike-results.md` §1/§2、`tmp/0003_phase2a-preprocess-rework/verify-97-results.md`)。「jsdom が AngularJS でほぼ動かない」という最大リスクは否定済、C2 (DOM) も react-808 で取れた。**Playwright fallback は代表 7 件でも 97 件実走でも 0 発火** = 「fallback が要る patch がある」という前提に現状エビデンスがない → §C-1 の判断（上記「### fallback: Playwright」）= documented-but-untested として設計に残し、executor は実装しない。2b.4 の 97 件再走 (C2/C6 込み) で trigger が発火したら trigger 1 から実装する。
- Phase 1.0 スパイク script は `mb-analyzer/src/` 無変更の使い捨て (`tmp/0002_phase1-adr-and-spike/spike/`)。Phase 2a の最小 jsdom sandbox はこれを production 化したもの (`equivalence-checker/sandbox/jsdom-executor.ts`)。
- 既存 sandbox に DOM 取得機能は無い (`sandbox/{executor,serializer,stabilizer}.ts`) — Phase 2b で `executor.ts` に jsdom 環境構築 + `capture.dom_html` + `capture.interaction_trace` を足す (ADR-0015)。
