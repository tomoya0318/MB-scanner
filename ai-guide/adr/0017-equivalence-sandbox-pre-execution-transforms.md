# ADR-0017: 等価検証 sandbox の実行前 transform — 非決定性 API の固定 + iteration-cap (loop bound の AST clamp)

- **Status**: proposed。前提の実証ステータスは `tmp/phase2b-adr-assumption-audit.md` §A-4/§A-5/§C-3/§C-4 参照（非決定性 API の凍結は Phase 2a の jsdom 最小版で実装・実証済、iteration-cap は Phase 1.0 で regex 代用で実証済 — 本実装の AST pass 化は実装詳細）。`accepted` 昇格はレビュー合意時（検証 phase は不要）。
- **Date**: 2026-05-10
- **Related**: ADR-0011 (preprocess は `f1`/`test()` body 内の loop bound を書き換えず原文を残す — 本 ADR の前提), ADR-0013 (timing / iteration 回数 / 非決定性 API 生値 を等価の構成要素に入れない — なぜ transform が要るかの根拠), ADR-0012 (実行環境 — どの環境でもこの transform を適用する), ADR-0015 (iteration-cap の既定 N と on/off は adapter config / transform の置き場 `common/sandbox/stabilizer.ts` は構造の話), `mb-analyzer/src/equivalence-checker/sandbox/stabilizer.ts`, `tmp/phase2b-adr-assumption-audit.md` §A-4/§A-5/§C-3/§C-4, `tmp/0002_phase1-adr-and-spike/spike-results.md` §7

## このADRの守備範囲

このADRが決めるのは **「等価検証 sandbox が body を実行する*前*に施す transform は何か / どこで施すか」** — (a) 非決定性 API (`Date.now`/`Math.random`/timer 等) をどう扱うか、(b) 計測ハーネスの大反復ループをどう tractable にするか (どこで cap するか・cap するか否か・どう識別するか)。

**扱わないこと** (他 ADR の管轄。本 ADR は該当箇所を 1 行参照するだけ):
- timing / iteration 回数 / 非決定性 API 生値を等価の構成要素に入れない*という決定* → **ADR-0013** (本 ADR はその*帰結*としての「実行を決定的・tractable にする手当て」を扱う)
- preprocess が `f1`/`test()` body 内の loop bound を書き換えない*という決定* → **ADR-0011**
- iteration-cap の既定 N の値・on/off の config・transform を `common/sandbox/` のどこに置くかの構造 → **ADR-0015 の adapter config / 配置**
- どの実行環境 (jsdom/vm/Playwright) で走らせるか → **ADR-0012**

## コンテキスト

等価判定は `(setup, slow, fast)` を sandbox 実行し 6 channel を観測して比較する (ADR-0013)。だが Selakovic の `f1`/`test()` body には性能測定のための **大反復ループ** (`for (var i = 0; i < 50000; i++)` 等) や `new Array(BIG)` が残る — preprocess (ADR-0011) は復元可能性のため body 内の loop bound を書き換えず原文どおり残す (剥がすのは外側の計測ハーネス `execute(f1, n)` / `var mean = jStat(a).mean()` / `$.ajax({mark, mean})` / `console.log(mean)` だけ)。これをそのまま実行すると等価検証が極端に遅くなる (重い AngularJS issue では非現実的)。

また `Date.now()` / `Math.random()` / `process.hrtime()` / タイマーは非決定的で、slow/fast で値が違うと観測がブレる (AngularJS の `ng-<timestamp>` cache key 等)。これらは等価の構成要素ではない (ADR-0013) ので、観測を成立させるには固定する必要がある。

「等価判定は反復回数も非決定値も観測しない」(ADR-0013) のだから、**実行を決定的・tractable にする transform を入れても等価判定の*結果*は変わらない** — 変わるのは速度と観測のブレだけ。決めるべきは「どこで・どうやるか」。

## 選択肢 (iteration-cap について)

非決定性 API は「固定・遮断する」一択 (議論の余地が無いので選択肢は立てない)。iteration-cap については:

- **A. 何も cap しない**: 原文どおり 50000 回回す。等価判定の*結果*は正しいが遅い。重い AngularJS issue では非現実的。
- **B. preprocess に焼き込む**: preprocess の段階で `for (i < 50000)` を `for (i < 5)` に書き換えて slow/fast に埋める。実行は速くなるが **原文が失われる** (slow/fast が「縮小済みコード」になり元に戻せない)。preprocess の方針「剥がすものは明示的に剥がし、それ以外は原文保持」(ADR-0011) と非整合。
- **C. sandbox 側のパラメタ化 transform**: preprocess は原文保持、sandbox が実行直前に AST pass で loop bound を clamp。config `{ iterationCap: N | null }` で N を可変・`null` で無効 (= 原文どおり全反復)。原文が source of truth、cap は明示的・名前付き・可逆。「`{setup,slow,fast}` をコード文字列で持ち transform は実行時適用」という既存設計 (stabilizer が非決定性 API stub で既にやっている) と整合。

### 評価

| 軸 | A (cap しない) | B (preprocess 焼き込み) | C (sandbox transform) |
|---|---|---|---|
| 実行時間 (重い AngularJS issue) | 非現実的 | 速い | 速い |
| 原文の復元可能性 | ✓ | ✗ (縮小済みが残る) | ✓ (cap は実行時適用、原文不変) |
| ADR-0011 (preprocess は loop bound 不変) との整合 | ✓ | ✗ | ✓ |
| cap 無効化して全反復実行できるか (= 等価判定が cap に依存していないことの検算) | (常に全反復) | ✗ | ✓ (`iterationCap: null`) |
| 実装コスト | 0 | 中 | 中 (stabilizer の枠組みに乗る) |

## 決定

**C (sandbox 側のパラメタ化 transform) を採用する。** sandbox は body 実行前に 2 系統の transform を施す:

1. **非決定性 API の固定・遮断**: `Date.now()` / `Math.random()` / `process.hrtime()` / `setTimeout` 等を固定値・no-op に差し替える。固定後の値は slow/fast で同一なので等価判定に影響しない (= 実質非観測、ADR-0013)。AngularJS の `ng-<timestamp>` cache key の非決定性もこれで消える (ただし `angular_before`↔`angular_after` で cache key の*命名規約自体*が違うケースは凍結しても残る — それは別問題で adapter の正規化プロファイルで吸収する、ADR-0015)。
2. **iteration-cap transform**: 実行直前に AST pass で `for (...; <var> < <numeric-literal ≥ THRESHOLD>; ...)` の bound を `<var> < N` に clamp する (`Array(BIG)` / `new Array(BIG)` の引数も縮小)。
   - 既定 N は小さい値 (3〜5)、`{ iterationCap: null }` で無効化 = 原文どおり全反復実行。N と on/off の*値*は adapter が渡す (ADR-0015)。
   - **preprocess には焼き込まない** — 原文が source of truth (ADR-0011)。
   - `for` 形でないループ (`while`/再帰/巨大配列への `.map` 等) は cap が効かない = そういう body はそのまま走る (壊れはしないが遅い)。出現したら個別対応 (トリガー)。
   - Phase 1.0 スパイクでは regex (`<\s*\d{3,}\b` → `< N`) で代用したが (`spike-results.md` §7)、本実装は AST pass にする (license header の数字等の誤爆を避けるため)。

どちらの transform も `common/sandbox/stabilizer.ts` 系に置く (= 「実行を決定的・tractable にする transform」の仲間。配置の話は ADR-0015)。

## 結果 / 影響

得るもの:
- 重い AngularJS issue でも等価検証が現実的な時間で回る。
- 非決定性に起因する観測のブレが消える。
- 原文が保たれ、`iterationCap: null` で「原文どおり全反復」を再現できる (= 等価判定が cap の値に依存していないことの検算ができる)。

諦めるもの・将来のコスト:
- `for` 形以外のループは cap が効かない (出現したら transform のパターンを足す)。
- iteration-cap の既定値次第で「反復回数依存のバグ」(N=3 では出ないが N=50000 で出る等) は見えない — ただし反復回数は等価の構成要素ではない (ADR-0013) ので設計上の問題ではない。

## トリガー (再検討の条件)

以下のいずれかが成立したら本 ADR を見直す:

- `for` 形でない大反復 (`while(true)` + break、巨大再帰、`Array(BIG).map(...)` 等) で実行が tractable にならない issue が出る → transform のパターンを増やす。
- iteration-cap の既定 N を変えると verdict が変わる issue が出る (= 反復回数が等価に効いている) → ADR-0013 の operational definition を見直す (= 反復回数を観測対象に含めるか検討)。
- preprocess 側で loop bound を書き換える方が良いと判明 → 本 ADR と ADR-0011 を併せて見直す。

トリガー発火時は新しい ADR を起票し、本 ADR は `superseded by ADR-NNNN` に書き換える。

## 補足

- Phase 1.0 スパイクで非決定性 API の固定 (`Date.now`/`Math.random` 凍結で AngularJS の `ng-<timestamp>` 非決定性が消える) を実証、Phase 2a の jsdom 最小版で production 実装済 (`equivalence-checker/sandbox/jsdom-executor.ts`)。iteration-cap は regex 版で #3/#4/#7 を実行できることを実証 (`spike-results.md` §7) — 本実装の AST pass 化は実装詳細であり追加検証は不要。
- 「反復回数 / timing / 非決定性 API の生値を等価の構成要素に入れない」根拠は ADR-0013 §観測しない を参照。本 ADR はその*帰結*としての実行手当てを扱う。本 ADR と ADR-0011 (preprocess 側で loop bound を書き換えない) は対 — 「原文は preprocess が保ち、cap は sandbox が実行時に可逆的にかける」という分担。
