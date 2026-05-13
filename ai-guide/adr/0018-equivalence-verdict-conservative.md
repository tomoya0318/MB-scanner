# ADR-0018: 等価判定の保守化 — `inconclusive` verdict と positive-evidence ルール (差は観測されなかったが「同じ計算をした」エビデンスが無いものは `equal` と呼ばない)

- **Status**: accepted
- **Date**: 2026-05-11
- **Related**: ADR-0013 (等価の operational definition + 旧 verdict 合成 4 規則 — 本 ADR が verdict 合成 § を上書き), ADR-0015 (oracle 層構造 + DOM/interaction-trace oracle), ADR-0012 (実行環境 — `inconclusive` の主要因 = SUT dep 不在 / Ember AMD loader), ADR-0017 (iteration-cap), `mb-analyzer/src/equivalence-checker/common/comparison/verdict.ts`, `mb-analyzer/src/pruning/engine.ts`, `mb_scanner/use_cases/equivalence_verification.py`, `mb_scanner/domain/entities/equivalence.py` ↔ `mb-analyzer/src/contracts/equivalence-contracts.ts`, `ai-guide/code-map.md` §等価性検証器, `tmp/0006_phase2b-equivalence-checker/verify-97-crosscheck.md` §1.5

## コンテキスト

ADR-0013 の旧 verdict 合成 (4 規則) は **「どの oracle も `not_equal` を返さなければ `equal`」** という *dissent の不在* ベースだった。これだと「`exception` oracle が『両側とも同じ `Cannot find module` を投げた』」= `equal` を返したとき、全体も `equal` になる — **「両方が同じ理由でクラッシュした」≠「意味論等価」** なのに `equal` と報告される。Phase 2b.4 の 97 件再走では `equal` 90 件のうち patch を実 exercise したのは 61 件で、残り 29 件は「弱い equal」(両側同じ runtime error / dep 不在で init・setup が落ちた / DOM・external が同じなだけで何も計算していない) だった。

ユーザの思想: **「`equal` と判定するのは*確実に等価と言えるもの*だけにする。実行が完走していない / patch を exercise していない『弱い equal』は『判別不可』にラベリングする方が安全」**。ADR-0013 rule 4 は既に「report 上は `inconclusive` として扱い手動レビューに回す」と書いていた (= `error` だが手動レビュー行き) が、これを first-class な verdict 値に昇格し、適用範囲を「弱い equal」全体に拡大する必要があった。

## 選択肢

- **A. `inconclusive` を新 verdict 値として追加 (`error` は据え置き)**: 弱い equal を `inconclusive` に倒す。`error` は executor crash / setup throw / serialize 失敗のまま。
- **B. 弱い equal を `not_equal` に倒す**: 新 verdict を増やさず既存 3 値で表現。
- **C. 弱い equal を `error` に統合**: `inconclusive` を増やさず `error` 扱い (= ADR-0013 rule 4 の文言どおり)。

### 評価

| 軸 | A (`inconclusive` 追加) | B (`not_equal` に倒す) | C (`error` に統合) |
|---|---|---|---|
| 「判別不可」と「差あり」の区別 | ✓ | ✗ (混同 — 著者判断との不一致数を誤って膨らませる) | ✓ |
| 「判別不可」と「executor が壊れた」の区別 | ✓ | ✓ | ✗ (両方 `error` で原因が混ざる) |
| executor 改善後の救済可能性 | ✓ (`inconclusive` → 後で `equal` に格上げ可) | ✗ (`not_equal` にしてしまうと「実は等価だった」ケースを誤判定したことになる) | ✓ |
| RQ の主張のしやすさ | ✓ (`equal`=確認 / `not_equal`=差を観測 / `inconclusive`=検証不能、後者は分母から外す) | ✗ | △ (`error` に「壊れた」と「検証できなかった」が混在) |
| 契約変更コスト | 中 (paired change: enum + `verdict_reason` フィールド) | 小 | 小 |

## 決定

**A (`inconclusive` を新 verdict 値として追加)** を採用する。`error` は据え置き。verdict 合成を以下の **5 規則** にする (ADR-0013 の 4 規則を上書き):

1. いずれかの oracle が `not_equal` → **`not_equal`**
2. いずれかの oracle が `error` → **`error`**
3. 全 oracle が `not_applicable` (= 観測チャネルゼロ) → **`inconclusive`** (`verdict_reason = "no-observable-channel"`)
4. `not_equal` / `error` 無し かつ **positive-evidence oracle** (= `{return_value (C1), argument_mutation (C4-mutation), interaction_trace (C6)}`) がすべて `not_applicable` → **`inconclusive`**
   - `exception` oracle が `equal` (= 両側が同じ例外で落ちた) なら `verdict_reason = "both-sides-threw"` (jsdom では `dom_mutation=equal` が常に併存するが情報を足さないノイズなので無視)
   - それ以外 (例外も無く `dom_mutation` / `external_observation` だけが `equal` 等) なら `verdict_reason = "no-positive-evidence"`
5. それ以外 → **`equal`** (= positive-evidence oracle に non-`not_applicable` が 1 つ以上ある)

### positive evidence の定義

`equal` を許す条件 = **`{C1 return_value, C4 argument_mutation, C6 interaction_trace}` のいずれかが non-`not_applicable`**。これらが non-N/A ということは「両側が非 undefined の同じ値を返した / 同じ引数変化をした / 同じ呼び出し列だった」= 計算を実 exercise した上で一致した、という積極的エビデンス。一方:

- **`C5 exception` の `equal`** (= 両側とも同じ ctor + message で throw): 「両方同じくクラッシュした」だけで何も計算していない → 単独では positive evidence と見なさない。`exception=equal` を「runtime-failure marker を含まなければ deliberate な throw = positive」とする緩和は今回入れない (該当ケースが無く、dataset 知識を要するので入れるなら `selakovic/` 側)。
- **`C2 dom_mutation` の `equal`**: jsdom では `dom_html` が常に non-null なので `dom_mutation` は常に non-N/A だが、「初期 mount HTML == 初期 mount HTML」(= 何も変わってない) でも `equal` になる。「DOM が初期から変化したか」の判定が無いので単独では positive evidence と見なさない (将来 `ExecutionCapture.dom_changed` フラグを足し「両側 `dom_changed` かつ `dom_mutation=equal`」を positive に格上げする — 別作業)。
- **`C4 external_observation` (新規 global key) の `equal`**: `__selakovic_*` 等の scaffolding global がノイズとして乗りうるので単独では positive evidence と見なさない (Phase B で scaffolding global を ignore pattern に入れて「何も起きてない」とき正しく N/A にする)。

### `verdict_reason` フィールド

`EquivalenceCheckResult` に `verdict_reason?: string | null` を足す (paired change — `equivalence-contracts.ts` ↔ `equivalence.py`)。値:

| verdict | `verdict_reason` |
|---|---|
| `equal` / `not_equal` | `null` |
| `inconclusive` (規則 3 — 全 N/A) | `"no-observable-channel"` |
| `inconclusive` (規則 4 — exception=equal = 両側 throw) | `"both-sides-threw"` |
| `inconclusive` (規則 4 — それ以外) | `"no-positive-evidence"` |
| `error` (executor crash / setup throw / serialize 失敗 — checker 本体が直接セット) | `"executor-error"` |
| `error` (oracle が error を返した) | `null` |

`derive_overall_verdict` / `derive_verdict_reason` は TS (`verdict.ts`) と Python (`equivalence_verification.py`) の両方にミラーで存在し、Python の `_finalize()` が Node から受け取った verdict / verdict_reason を信頼せず observation から再計算する (ADR-0013 と同じ防御 — TS↔Python の列挙値ズレを use case で検知)。

### pruning は `inconclusive` を「等価と見なしてよい」扱いにする

Hydra 式 pruning (`pruning/engine.ts`) の縮約可否判定 (`isEquivalentEnoughForPruning`) は `equal` だけでなく `inconclusive` も「これ以上縮約しても witness 上の挙動が変わっていない」と見なす。理由: `inconclusive` の保守的な区別は *等価検証アーティファクト (Selakovic dataset の検証主張)* のためのもので、パターン縮約の健全性とは別軸 — pruning は「観測可能な差が無い」を縮約可否の基準にする (元々 fast が実値を返すなら縮約後 slow が実値を返さなければ `not_equal` で弾かれるので、`inconclusive` が出るのは「初期状態から両側 throw / 両側 undefined」の弱いケースだけ = そこでの leniency は pruning の健全性を下げない)。

## 結果 / 影響

**得るもの:**

- 「弱い equal」という曖昧カテゴリが*出力レベルから*無くなる。`equal` = positive evidence で確認 / `not_equal` = 差を観測 / `inconclusive` = 検証不能、と 4 値で説明できる
- RQ の分母を「`equal` + `not_equal` の確認済み分」に限定し、`inconclusive` を別途「カバレッジ (どれだけ実 exercise できたか)」指標として扱える。これは「100% 正確 (最初から全部 equal)」より「実 exercise した N 件で著者判断と一致、M 件は検証不能」の方が defensible
- executor を改善 (SUT dep 解決 / Ember bootstrap / DOM-changed 観測 / lib-narrowing) すると `inconclusive` が減って `equal` / `not_equal` に移る — 改善の余地が verdict 分布で見える

**諦めるもの / 将来のコスト:**

- 契約 (`Verdict` enum) が 3 値 → 4 値に増え、両言語の合成ロジック・CLI exit code・テストを追従させる必要がある (済)。CLI exit code は `equal=0 / not_equal=1 / inconclusive=2 / error=3` (入力パース失敗も 3) に変更 — 旧 `error=2` だった頃に exit code で分岐していた下流があれば挙動が変わる
- `equal` の件数自体は減る (Phase 2b.4 の予測: 旧 `equal` 90 → `equal` ~61 + `inconclusive` ~29)。これは「悪化」ではなく「実行していない equal が正しく分類された」結果だが、対外的に「件数が減った」と誤解されないよう RQ の書き方で「`equal` = 実 exercise 済」を強調する必要がある
- `inconclusive` の件数を減らす施策 (SUT dep 全解決 / Ember AMD loader 対応 / DOM-changed フラグ / lib-narrowing) は本 ADR の範囲外 (= Phase C 以降の別作業)。Ember 1.x の内部 AMD loader は専用 bootstrap を作らない方針なので ~9 件は `inconclusive` の既知 limitation として残す

## トリガー (再検討の条件)

- positive-evidence の定義 (`{C1,C4,C6}` のみ) で「本当は等価なのに `inconclusive`」が多発するとき → `C2 dom_mutation` / `C5 exception` の格上げ条件 (`dom_changed` フラグ / runtime-failure-marker 緩和) を実装してこの ADR を更新
- `inconclusive` の件数が「本質的に検証不能なもの (Ember 等)」を大きく超えて減らないとき → executor 側の dep 解決 / lib-narrowing を優先タスク化
- 別 dataset を対象に加える際に「両側 throw だが deliberate な throw で意味論的に等価」を `equal` にしたいとき → `selakovic/` adapter 側に positive-evidence 判定の dataset 依存フックを足す

トリガー発火時は新しい ADR を起票し、本 ADR は `superseded by ADR-NNNN` に書き換える。

## 補足

- 旧 4 規則 → 新 5 規則の差分: 旧 rule 2「全 N/A → `error`」が新 rule 3「全 N/A → `inconclusive`」に。旧 rule 3「`not_equal` なし & 残り全部 `equal` → `equal`」が新 rule 4 (positive evidence チェック) + 新 rule 5 に分裂。旧 rule 4「`not_equal` なしで `error` 混入 → `error`」は新 rule 2 に吸収。oracle 評価順序 (C5→C1→C6→C2→C4→C3) は変更なし (verdict 合成は順序非依存)。
- 再走の生データ・突合は `tmp/0006_phase2b-equivalence-checker/verify-97-{results,crosscheck}.{md,tsv}` を上書き更新。新規分析 (`inconclusive` の理由分布等) は `tmp/0007_equivalence-verdict-conservative-reclassification/`。

### 2026-05-11 更新 (Phase C-2 で `dom_changed` を実装)

§決定 の「`dom_mutation` の positive 格上げは Phase C」と §トリガーの「dom_changed フラグを足す」を実装した:

- `ExecutionCapture.dom_changed?: boolean` を追加。jsdom executor が body 実行前の初期 mount HTML を覚えておき実行後と文字列比較してセットする。
- `dom_mutation` oracle は「両側とも `dom_changed === false`」のとき N/A を返す (= DOM 観測としては何も起きていない)。
- `POSITIVE_EVIDENCE_ORACLES` に `DOM_MUTATION` を追加。
- **保守化追加ルール**: 「`exception=equal` (両側同じく落ちた) かつ唯一の positive evidence が `dom_mutation` のみ」の場合は `inconclusive(both-sides-threw)` に倒す。これは Angular の bootstrap で DOM を触ってから両側同じく落ちたケース (workload を完走できていない = 弱い equal) を防ぐ。`return_value` (C1 = exception 時に N/A) / `argument_mutation` (C4) / `interaction_trace` (C6) のいずれかが non-N/A なら workload が部分的にでも exercise されたと見なせるので `equal` を保つ。

効果 (97 件再走): `equal 67→71` (+4 = react-808#0/#1 / angular-4359#0/7759_3 の純粋 dom-only が `real-c2` に昇格) / `inconclusive 33→29` (-4) / `not_equal 6` 不変 / 検証カバレッジ 67.6%→71.3%。Phase B 時点で `inconclusive(no-positive-evidence)` 6 件のうち 2 件 (react-1885#0/3665#0) は `dom_changed=false` だったため `inconclusive` に正しく残った (= Phase B の dom-only 分類が一部不正確だった、を C-2 が修正した側面)。

### 2026-05-12 更新 (`argument_mutation` の unserializable snapshot を `error` でなく key 除外に)

§トリガー「`inconclusive` が Ember 等を超えて減らないとき → executor 側を優先タスク化」に該当する小修正。`argument_mutation` oracle (`oracles/argument-mutation.ts`) は従来「snapshot に `UNSERIALIZABLE_MARKER` を 1 つでも含む → `verdict=error`」だったが、これだと verdict 合成 rule 2 (`error` 混入 → 全体 `error`) で **候補が捨てられる**。`UNSERIALIZABLE_MARKER` の発生源は `serializer.ts` の循環参照検出のみで、Ember では `globalThis.Ember` が循環したオブジェクトグラフ (computed property ↔ meta ↔ owner …) なので、Ember を読み込んだ candidate は `argument_mutation` が常に `error` → 0022 (workload-reachability で lib を絞る) で Ember candidate が bootstrap・実行できるようになっても等価判定が `error` で潰れる。

修正: **`UNSERIALIZABLE_MARKER` を含む key を比較対象から除外し、残った key だけで判定。残り 0 件なら `not_applicable`** (= 「観測できる setup object が無い」と同じ扱い)。「観測できない」と「壊れている」は別 — 後者だけ `error` に値する。除外後に `not_applicable` になると positive-evidence ルール (本 ADR rule 4/5) が後段で効くので、他に positive evidence (`return_value` 等) が無ければ全体は `inconclusive` に倒れる = 健全性は保たれる。Ember 3174/4329_1/4158 (`tmp/0022_.../spike-e2e-v2.log` で `argument_mutation=error` で潰れてた) はこれで `return_value`/`external_observation` 基準の判定に委ねられる。

§決定 の「Ember 1.x の AMD loader は ~9 件 `inconclusive` の既知 limitation」は緩和方向 (0022 の lib-narrowing + 本修正で Ember candidate も実 exercise・等価判定に乗る)。将来 serializer.ts 側で循環を `<circular>` sentinel に丸めれば (TODO コメントあり)、この key 除外も不要になり「巨大だが有限の文字列」として比較できる (要 maxDepth デフォルト)。
