# code-map — 実装の意味論リファレンス

この文書は **実装がどう動いているか**（データフロー、責務分担、内部不変条件）を説明する **Reference**。論文執筆時の引用元、深堀り時の参照、新メンバ onboarding を主な用途とする。

ai-guide 全体での位置づけと他軸との住み分けは [`doc-strategy/index.md`](doc-strategy/index.md) を参照。**ファイル単位の詳細は in-tree README に委譲** し、本文書はモジュール単位の役割とデータフローまでで止める。

---

## 目次

- [等価性検証器](#等価性検証器)
  - [観測軸: slow/fast と pre/post](#観測軸-slowfast-と-prepost)
  - [4 オラクルの責務分担](#4-オラクルの責務分担)
  - [オラクル間の排他ルールと `not_applicable` の意義](#オラクル間の排他ルールと-not_applicable-の意義)
  - [観測できない事象（既知の限界）](#観測できない事象既知の限界)
- [Pruning エンジン](#pruning-エンジン)
  - [モジュール責務](#モジュール責務)
  - [データフロー](#データフロー)
  - [試行回数 (iterations) と budget の関係](#試行回数-iterations-と-budget-の関係)
  - [候補ノード決定の 5 段フィルタ](#候補ノード決定の-5-段フィルタ)
  - [置換操作の粒度 (3 カテゴリ統一のワイルドカード化)](#置換操作の粒度-3-カテゴリ統一のワイルドカード化)
  - [再列挙とクロスパス重複](#再列挙とクロスパス重複)
  - [pruning の正確性 — 多層防御](#pruning-の正確性--多層防御)
  - [文法由来 blacklist の網羅性](#文法由来-blacklist-の網羅性)
- [Selakovic 前処理器](#selakovic-前処理器)
  - [責務分担と層構造](#責務分担と層構造)
  - [抽出アルゴリズム (論文非依存)](#抽出アルゴリズム-論文非依存)
  - [enclosure 候補型の 3 段優先順位](#enclosure-候補型の-3-段優先順位)
  - [1 入力 → N 結果モデル](#1-入力--n-結果モデル)
  - [setup 構築規約](#setup-構築規約)
  - [clientServer フォールバック](#clientserver-フォールバック)
  - [除外理由の意味論](#除外理由の意味論)
  - [既知の運用上の落とし穴 (Node CLI の stdout flush)](#既知の運用上の落とし穴-node-cli-の-stdout-flush)
  - [既知の運用上の落とし穴 (VM cross-realm Error)](#既知の運用上の落とし穴-vm-cross-realm-error)
  - [既知の運用上の落とし穴 (pnpm shared install と相対 require の不整合, Phase C-1)](#既知の運用上の落とし穴-pnpm-shared-install-と相対-require-の不整合-phase-c-1)
  - [Selakovic データセットでの実測](#selakovic-データセットでの実測)

（sandbox パイプライン / Python↔Node JSON 往復 の詳細は今後追加予定）

---

## 等価性検証器

実装は `mb-analyzer/src/equivalence-checker/` 配下。ファイル単位の責務 / 依存方向 / 関連 ADR は [`mb-analyzer/src/equivalence-checker/README.md`](../mb-analyzer/src/equivalence-checker/README.md) を参照。本節は **観測軸とオラクル責務の意味論** に絞る。

### 観測軸: slow/fast と pre/post

等価性検証は **2 つの直交する軸** で観測を組み立てます。名前の由来が異なるので混同しないこと。

#### slow / fast 軸 ← データセット起源

Selakovic 2016 dataset の **before/after パッチペア** に対応します。1 candidate = **(setup, slow=before, fast=after, workload)** の 4 値契約 (ADR-0023)。`workload` は placeholder-substitution 系経路 (changed-fn / changed-stmt / server-changed-fn) で non-null (= SUT を exercise する観測駆動コード)、embedded / fallback の self-contained runnable 経路では `workload` は `null` で `slow`/`fast` 自体が完結 runnable。比較軸は **slow vs fast** で、同一 setup・同一 workload 上で別 sandbox 実行し、**検証したい意味論的差異はこの軸で現れる**のが研究目的上の要請です。

#### pre / post 軸 ← Oracle 2 の実装技法

JS の破壊的変更（`arr.push(x)` 等）は戻り値にも例外にも現れないため、`argument-mutation` oracle は workload 実行の **直前 (pre) と直後 (post) の 2 回スナップショット** を取って差分から in-place mutation を検出します。**1 回の sandbox 実行内で閉じた時間軸** であり、slow/fast のサイド軸とは別概念です。

#### 2 軸の組み合わせ

```
               pre (workload 前)   post (workload 後)
slow サイド    slow.snapshots.pre  slow.snapshots.post
fast サイド    fast.snapshots.pre  fast.snapshots.post
```

- Oracle 2 は **`slow.post` vs `fast.post`** を比較する
- `pre` は不変条件の記録用（setup 共通性から `slow.pre == fast.pre` が想定される）
- `slow.pre != fast.pre` や key 集合の片側欠落は **setup 不変条件の違反** に当たるが、現状は防御的に `not_equal` に畳まれる

---

### 4 オラクルの責務分担

JS で観測可能な差異は基本 4 方向に落ち、各オラクルが 1 軸ずつ担当します（Selakovic adapter ではこれに C2 / C6 を追加で配線する — [後述](#selakovic-adapter-で追加される-2-オラクル-c2--c6)）。実装は `mb-analyzer/src/equivalence-checker/common/comparison/oracles/` 配下。

```
workload 実行
├─ 戻り値として出てくる       → O1 / C1 (return_value)
├─ 引数が破壊的に変わる        → O2 / C4 (argument_mutation)
├─ 例外として throw される      → O3 / C5 (exception)
└─ 外界に漏れ出す (console / global) → O4 / C3+C4 (external_observation)
```

| # | Oracle | 比較対象 | 比較方法 | 実装 (`common/comparison/oracles/`) |
|---|---|---|---|---|
| O1 (C1) | `return_value` | workload の**戻り値** | serialize 済み文字列の完全一致 | `return-value.ts` |
| O2 (C4) | `argument_mutation` | setup 由来 object/array の **workload 後の状態** | key 毎に `slow.post` vs `fast.post` を比較 | `argument-mutation.ts` |
| O3 (C5) | `exception` | workload が投げた**例外** | `ctor` + `message` の一致 | `exception.ts` |
| O4 (C3+C4) | `external_observation` | **console 呼び出し列** + **新規 global 変数** | console: method/args の順序込み／globals: key 集合 | `external-observation.ts` |

#### O1: `return_value`

`slow.return_value` vs `fast.return_value`（`snapshotValue` で文字列化済み）を比較します。代表的な検出対象: `for..in` の列挙結果、`String()` の文字列化結果、Promise の解決値（`await` 後の値で比較）。

#### O2: `argument_mutation`

setup で定義された object/array 変数の **workload 実行後スナップショット** を両サイドで突き合わせます。代表的な検出対象: `arr.push(x)`、`obj.key = v`、`splice` 等の in-place 破壊的変更。戻り値に現れない副作用を担当します。詳細は [観測軸セクション](#観測軸-slowfast-と-prepost) 参照。

#### O3: `exception`

`ExceptionCapture = { ctor: string, message: string }` を両サイドで突き合わせます。代表的な検出対象: prototype 汚染下での `TypeError`、`hasOwnProperty` が破壊された時の throw、実装差による例外メッセージ変化。

##### 限界と判断根拠

O3 は設計上 3 つの観測を **していない**。それぞれの判断を明記しておく（偽陽性・偽陰性の議論で参照されやすいため）。

| 非観測項目 | 判定 | 根拠 |
|---|---|---|
| stack trace の比較 | **要件（比較しない）** | パッチ適用で行番号・内部関数名は必ず変わる。stack を比較すると Selakovic の全パッチが `not_equal` になり、検証器として成立しない。**「意味論的等価性の定義に stack を含めない」** は設計要件であり妥協ではない |
| message 内の動的値（変数名・プロパティ名）に由来する揺れ | **許容（偽陽性にならない）** | (setup, slow, fast) は **同一プロセス・同一 V8 realm** で実行され、setup が共通なら埋め込まれる動的値も両側で一致する。V8 バージョン差による文言書き換え（例: `"Cannot read property"` → `"Cannot read properties of"`）は CI の Node バージョン固定 (`mise`) で対処する |
| 例外発生までの中間状態 | **限界ではない（O2/O4 で補完済み）** | executor (`common/sandbox/executors/{vm,jsdom}.ts`) は try/catch 通過後に post snapshot / console 列を確定するため、throw 直前までの副作用は **O2 (arg_snapshots) / O4 (console_log, new_globals) が自動的に拾う**。O3 単体で partial state が見えない点は oracle 間の協調で解決済み |

**結論: O3 の設計上の非観測はすべて許容しうる。** 特に stack trace 非比較は「**意味論的等価性の定義上 stack を含めない**」という研究上の要件であり、拡張して比較可能にしても FP が爆発するだけなので採用しない。

#### O4: `external_observation`

2 つの副作用ストリームを比較します:

1. **`console_log`**: console.log/warn/error 等の呼び出し列 — **method 名 + 引数の順序込み**で完全一致
2. **`new_globals`**: workload 実行中に新規作成された global 変数名の集合（順序無関係、`Set` 比較）

代表的な検出対象: デバッグ出力の意図しない削除、global への無名リーク（`var`/`let` 忘れ）、DOM/I/O 系パターンの副作用差分。

#### Selakovic adapter で追加される 2 オラクル (C2 / C6)

上記 4 つは dataset 非依存の基本軸。Selakovic adapter (`selakovic/oracle-routing.ts` + `selakovic/profiles.ts`) は workload の種類 (DOM 直接操作 / jQuery interaction / Angular controller 等) に応じて、これにさらに 2 つを配線する:

| # | Oracle | 観測対象 | 比較方法 | 実装 (`common/comparison/oracles/`) |
|---|---|---|---|---|
| C2 | `dom_mutation` | jsdom 実行後の **DOM-HTML** (`capture.dom_html`) | adapter 渡しの `DomNormalizeProfile` (framework ノイズ属性/class/コメント除去・空白 collapse・属性 sort) で正規化してから文字列比較。**両側とも `dom_changed === false`（DOM 不変）なら N/A** (Phase C-2 — positive evidence 格上げの前提) | `dom-mutation.ts` |
| C6 | `interaction_trace` | 記録 Proxy が取った **workload→SUT の呼び出し列** (`capture.interaction_trace`) | adapter 渡しの `InteractionTraceProfile` (boot-phase prefix 無視 / get 無視) でフィルタしてから列の完全一致。両側とも trace 空 (Proxy 未注入 or 何も呼ばなかった) なら N/A | `interaction-trace.ts` |

正規化規則・無視 prefix は dataset 知識なので `profile` として adapter から渡す。oracle 本体 (DOM ノード判定・空白 collapse / trace 列比較) は汎用 (`common/`)。記録 Proxy 自体は `common/sandbox/capture/recording-proxy.ts`、profile 配線は `selakovic/profiles.ts`。C2 / C6 はともに **positive-evidence oracle**（[後述ルール 3](#ルール-3-overall-verdict-の合成-adr-0018--phase-c-2)）。

---

### オラクル間の排他ルールと `not_applicable` の意義

4 軸は独立に判定されるが、**Oracle 間で責務の押し付け合いが発生しないよう排他ルールが組み込まれている**。

#### ルール 1: 例外時は O1 が身を引く

`common/comparison/oracles/return-value.ts`:

```ts
if (slow.exception !== null || fast.exception !== null) {
  return { oracle, verdict: ORACLE_VERDICT.NOT_APPLICABLE };
}
```

片方でも例外が起きた瞬間、O1 は `not_applicable` を返して **例外の比較は O3 に完全委譲** する。これが無いと「例外の文字列表現 vs 正常値」を比較して偽陽性が出る。

#### ルール 2: `not_applicable` は overall verdict を潰さない

`deriveOverallVerdict` は observation のうち `not_applicable` を除外してから集約する。これにより、**該当しない軸の存在が overall verdict のノイズにならない**。

具体例:

- 両側とも同じ値を返す純粋関数 → O1 `equal`、他 `not_applicable`、overall `equal`
- 両側とも同じ例外を投げる関数 → O1 `not_applicable`、O3 `equal`、(positive-evidence oracle が全 N/A なので) overall **`inconclusive`** (= 「両方同じくクラッシュした」≠「等価」、ADR-0018)

`not_applicable` は「検査しない」ではなく「**この軸ではこのトリプルを判定しない（他軸に任せる）**」という**責務移譲のシグナル**として機能している。

#### ルール 3: overall verdict の合成 (ADR-0018 + Phase C-2)

`deriveOverallVerdict`（`common/comparison/verdict.ts`、Python ミラーは `equivalence_verification.py`）は以下の優先順位で合成する:

1. いずれかの oracle が `not_equal` → **`not_equal`**
2. いずれかの oracle が `error` → **`error`**
3. 全 oracle が `not_applicable` → **`inconclusive`**（観測チャネルゼロ。`verdict_reason = "no-observable-channel"`）
4. `not_equal`/`error` 無し かつ **positive-evidence oracle**（= `{return_value (C1), argument_mutation (C4-mutation), interaction_trace (C6), dom_mutation (C2)}`）がすべて `not_applicable` → **`inconclusive`**（差は観測されなかったが「同じ値を返した / 同じ引数変化をした / 同じ呼び出し列だった / 少なくとも片側が DOM を変更してそれが両側一致した」という積極的等価エビデンスが無い = 中身を exercise できていない可能性が高い。`verdict_reason` = `exception` oracle が `equal` なら `"both-sides-threw"`、それ以外なら `"no-positive-evidence"`）
5. 上記 4 を通った後、**`exception` oracle が `equal`（= 両側が同じ例外で落ちた）かつ唯一の positive evidence が `dom_mutation` のみ** → **`inconclusive`**（その DOM 変化は workload 実行ではなく runnable の bootstrap = Angular の compile step 等で生じた可能性が高く「patch を exercise していない」弱い equal。`return_value` は exception 時に必ず N/A なので、`argument_mutation` / `interaction_trace` のどちらかが non-N/A なら workload が部分的にでも exercise されたと見なし `equal` を保つ。`verdict_reason = "both-sides-threw"`）
6. それ以外 → **`equal`**（positive-evidence oracle に non-N/A が 1 つ以上 — 単独 dom_mutation かつ両側クラッシュは除く）

`dom_mutation` が positive evidence になる前提（Phase C-2）: jsdom executor が workload 実行前の初期 mount HTML を覚えておき実行後と素の文字列比較して `ExecutionCapture.dom_changed` をセットする。`dom_mutation` oracle は **両側とも `dom_changed === false`（= 両側とも DOM を一切変更しなかった）なら `not_applicable` を返す** ので、non-N/A は「少なくとも片側が DOM を実際に変更した」を意味する（→ その変化が両側一致なら積極的等価エビデンス）。これが無いと「両側に同じ初期 HTML を流したので比較は常に equal」を等価エビデンスに誤認する。

`EquivalenceCheckResult.verdict_reason?: string | null` は `inconclusive` のとき上記の理由（`no-observable-channel` / `both-sides-threw` / `no-positive-evidence`）、`error` のとき throw phase で分類した `"setup-failure"` / `"executor-error"`、`equal`/`not_equal` のとき `null`。`"setup-failure"` は **setup 段階 (`vm.runInContext(setup, ...)`) の throw** で `SandboxSetupError` 経由で型分離する (ADR-0023 §D-β)。`"executor-error"` は **workload 段階以降の executor crash / serialize 失敗だけでなく、Python Gateway 側の error（subprocess spawn 失敗 / 出力 JSON 解釈失敗 / timeout）と batch CLI の行パース失敗（slow/fast 欠落 / `timeout_ms` 不正 / 非 JSON）でも付く** — いずれも「使える verdict が出せなかった」同分類なので Node 側 outer catch と揃えてある。詳細は [ADR-0018](adr/0018-equivalence-verdict-conservative.md) / [ADR-0023](adr/0023-preprocess-placeholder-substitution.md)。

設計上の含意:

- **`not_equal` が最強**: 実際に差異が観測されたら、他軸で error や not_applicable が出ていても **not_equal を信じる**。「観測できた非等価」は「観測できなかった軸」より優先。
- **`error` は「使える verdict が出せなかった」専用**: シリアライズ不能 (循環参照) / timeout / setup throw で観測パイプラインが壊れたとき + Gateway/CLI 層のパイプライン失敗 (spawn / JSON / 行パース)。観測はできたが等価エビデンスが無い場合は `error` でなく `inconclusive`。`verdict_reason` で `"setup-failure"` (setup phase の throw) と `"executor-error"` (workload phase 以降) を区別する。
- **`equal` は「中身を exercise した上で一致」だけ**: 「両方同じくクラッシュ」「両側とも DOM 初期から不変 (→ dom_mutation N/A)」「両方クラッシュ + bootstrap で DOM だけ変化」「scaffolding global しか無い」は単独では `equal` にしない (→ `inconclusive`)。RQ では `equal`+`not_equal` の確認済み分を「検証器が著者判断と一致した」の分母にし、`inconclusive` は別途「検証カバレッジ」指標。
- **pruning は `inconclusive` を等価扱い**: Hydra 式 pruning (`pruning/common/engine.ts`) の縮約可否判定は `equal ∪ inconclusive`。`inconclusive` の保守的区別は等価検証アーティファクトのためで、パターン縮約の健全性とは別軸 (ADR-0018)。

---

### 観測できない事象（既知の限界）

4 オラクルを揃えても、以下 4 件は観測対象外であり **偽陰性（non-equivalent を equal と誤判定）のリスク源**となる。本データセット (Selakovic 2016) では発生頻度が低く実害は限定的だが、**等価性検証器を汎用ツールとして他研究へ再利用する場合は拡張が必要**。

| # | 観測されない事象 | 原因（実装箇所） | Selakovic での影響度 |
|---|---|---|---|
| 1 | setup で定義された **primitive 変数の最終値** | `common/sandbox/capture/snapshot.ts` の setup snapshot は `typeof val === "object"` の変数のみ trackedKeys に入れる。number / string / boolean は post snapshot の対象外 | **低** — Selakovic パターンは collection 操作主体で、カウンタ変数等の primitive 変更は稀 |
| 2 | workload で新規作成された **global 変数の値** | `common/comparison/oracles/external-observation.ts` は `new_globals` のキー集合のみ比較。値は比較しない | **中** — `var` 忘れ等の global リークはあるが、値の差まで問題になる例は少ない |
| 3 | workload 同期終了**後**に実行される非同期タスク | sandbox は workload 同期完了で観測打ち切り。`setTimeout` / `queueMicrotask` / 未解決 Promise の副作用は見えない | **低** — Selakovic パターンは同期コード主体 |
| 4 | `null` で初期化された変数の **null → object 変化** | `common/sandbox/capture/snapshot.ts` の setup snapshot は `val !== null` 条件があり、setup で null の場合は trackedKeys に入らない。workload で object 化されても pre snapshot が無く不完全 | **非常に低** — setup で null を置く使い方はほぼ無い |

#### 判断と対処

- **本論文の範囲では修正不要**: Selakovic dataset で穴 1〜4 が踏まれる頻度は低く、RQ1（C1〜C4 の ablation）と事前分析（10 パターン自動導出 ≈100%）の主張を脅かさない。等価性検証器は**研究成果ではなく中間ツール**なので、検出されるべき差異を取り逃さない限り研究は成立する
- **検証器を他研究で再利用する場合は拡張を検討**: 特に #1 (primitive tracking) と #2 (new_globals 値比較) は素直な拡張で塞げる。#3 の非同期対応は sandbox の大規模改修が必要
- **論文の妥当性の脅威には 1 行で明示**: `current-research.md` §妥当性の脅威に「等価性検証器の観測範囲は object/array mutation / 戻り値 / 例外 / console+globals key に限定される」旨を記載する
- **Future Work に予約**: 穴 1〜4 を塞いだ一般化検証器を候補として残す

---

## Pruning エンジン

第 1 段階 (構造パターン導出) の本体。`(slow, fast, setup)` トリプルから **ワイルドカード付きの最小構造パターン** を出力する。実装は `mb-analyzer/src/pruning/` 配下、ファイル単位の詳細は [`mb-analyzer/src/pruning/README.md`](../mb-analyzer/src/pruning/README.md)。**TS 側の公開 API (PruningInput / PruningResult / placeholders) の入出力契約**もそちらの §入出力契約 に集約。研究方針は [`current-research.md` §第 1 段階](current-research.md#第-1-段階-実行ベース-hydra-式-pruning) を参照。

### モジュール構成 (二層: `common/` + `selakovic/`)

`equivalence-checker/` ・ `preprocessing/` と対称の二層構成 (ESLint `import/no-restricted-paths` で機械強制)。pruning が「主軸 = 論文 / dataset 非依存」というルールを構造で担保するための分割。

| 領域 | 責務 |
|---|---|
| `selakovic/pruner.ts` | dataset adapter。`equivalence-checker` の `checkEquivalence` を bind して `common/engine.prune` に注入する薄い層。等価検証の実行環境 (`environment` / `module_base_dir` / `mount_html`) や oracle routing hint (`aspect` / `candidate_kind` / `enclosure_type`) はこの層が closure に閉じ込める。`equivalence-checker` を import するのは pruning 内でここだけ |
| `common/engine.ts` | dataset 非依存の Hydra 反復ループ本体 + 1 パス試行 `tryPruneCandidates` + mutate / revert (savepoint パターン)。等価検証は `prune(input, deps)` の `deps.checkEquivalence` で **DI で受ける** — `equivalence-checker` も `selakovic/` も知らない |
| `common/candidates.ts` | AST 走査 + ルール適用で候補列挙 (placeholder 除外 / whitelist / blacklist / SubtreeSet / リテラル差分内保護 の 5 段フィルタ。リテラル保護は ADR-0028) |
| `common/rules/` | pruning の対象と戦略の宣言データ集 (whitelist / blacklist / replacement)。文法だけで決まる |
| `common/ast/parser.ts` | `src/ast/parser` の汎用 parse に `common/rules/whitelist.ts` の `PARSER_PLUGINS` を渡す薄ラッパー (pruning 固有はこれだけ — 走査 / inspect / subtree-hash 等の AST toolbox 本体は `src/ast/` に集約) |

ファイル単位の詳細責務 / 依存方向 / 関連 ADR は [`mb-analyzer/src/pruning/README.md`](../mb-analyzer/src/pruning/README.md) に集約 (drift 面のローカル化)。

新しい placeholder kind を追加するときの drift 面は **`common/rules/whitelist.ts:WHITELIST_CATEGORIES` (型 → カテゴリ) と `common/rules/replacement.ts:REPLACEMENTS` (カテゴリ → placeholderKind + buildNode) の 2 ファイル**に集約してある。`buildNode` がカテゴリごとの「化かし方 (`ExpressionStatement(Identifier)` / `Identifier` / `StringLiteral` 生成)」を直接持つので、置換戦略の名前は引数 (string mode) として残らず、関数値として表現される。

### データフロー

`prune` は **2 段ループ構造**:

- **外側ループ (`prune`)**: AST が変わるたびに SubtreeSet と候補リストを再計算する。1 パスで 1 ノードが prune できれば AST を更新して次パスへ。
- **内側ループ (`tryPruneCandidates`)**: 現在の候補を size 降順で順に試し、**最初に成功した 1 候補で return**。残った候補は次パスで再列挙される。

`prune(input, deps)` の `deps.checkEquivalence` は `pruning/selakovic/pruner.ts` の `buildEquivContext` が `equivalence-checker` の `checkEquivalence` を `environment`/`module_base_dir`/`mount_html` 込みで bind して渡す (`common/` 側は実行環境を知らない。oracle 選択 hint `aspect`/`candidate_kind`/`enclosure_type` は ADR-0024 で廃止)。

> **TODO (ADR-0023 D-β 配線残り)**: `PruningInput.workload?` / `EquivalenceInput.workload` は先行追加済だが、`buildEquivContext` が **`workload` を転送していない** (現状は上記 3 フィールドのみ)。このため pruning の毎 iteration 等価検証は `(setup, slow, fast)` だけで走り、changed-fn candidate も workload 抜きの legacy 経路 (slow/fast を直接実行) で検証される。`buildEquivContext` に `workload` 転送を足して配線する。詳細は [`open-questions.md` §実装](open-questions.md)。

```
PruningInput (slow, fast, setup, timeout_ms, max_iterations, [environment, module_base_dir, ...])
       ↓
    parse(slow) / parse(fast)                    ← pruning/common/ast/parser.ts (= src/ast/parser + PARSER_PLUGINS)
       ↓
    Phase 1: 初回等価性検証
    deps.checkEquivalence(setup, slow, fast)     ← selakovic/pruner が equivalence-checker を bind
       ├─ not_equal → verdict = initial_mismatch で終了
       ├─ error     → verdict = error で終了
       └─ equal/inconclusive ↓
    countNodes(slow) → node_count_before          ← src/ast/inspect.ts
       ↓
    Phase 2: 反復 pruning
  ┌─ 外側ループ: iterations < max_iterations かつ wall-time 内 ───────────┐
  │   SubtreeSet(fast)                    ← src/ast/subtree-hash.ts: 再計算 │
  │   enumerateCandidates(slow, diff)            ← common/candidates.ts    │
  │   候補が空 → 終了                                                      │
  │   ↓                                                                    │
  │ ┌─ 内側ループ tryPruneCandidates: size 降順に試行 ─────────────────┐ │
  │ │   replacementFor(node) → placeholderKind + buildNode             │ │
  │ │                                       ← common/rules/replacement │ │
  │ │     null (whitelist 外) → 次候補                                 │ │
  │ │   ↓                                                              │ │
  │ │   saved = readAt(parent, key, idx)         ← savepoint           │ │
  │ │   applyAt(parent, key, idx, buildNode(id)) ← mutate              │ │
  │ │   try {                                                          │ │
  │ │     generate(slow) → parse                 ← L3 round-trip       │ │
  │ │       throw → continue (finally で revert)                       │ │
  │ │     iterations += 1 ← ここで初めて budget を消費                 │ │
  │ │     deps.checkEquivalence(setup, slow', fast) ← L4 (Hydra 実行)  │ │
  │ │     equal → succeeded=true, placeholders.push, return パス成功   │ │
  │ │     それ以外 → continue                                          │ │
  │ │   } finally {                                                    │ │
  │ │     if (!succeeded) applyAt(parent, key, idx, saved) ← revert    │ │
  │ │   }                                                              │ │
  │ └────────────────────────────────────────────────────────────────────┘ │
  │   パス成功 → slow を reparsed AST に差し替え → 外側ループ次反復         │
  │   パス失敗 (どの候補も prune できない or budget 切れ) → 終了             │
  └────────────────────────────────────────────────────────────────────────┘
       ↓
    generate(slow) → pattern_code
    countNodes(slow) → node_count_after
       ↓
    PruningResult (verdict=pruned, pattern_ast, pattern_code,
                   placeholders, iterations, node_count_before/after)
```

### 試行回数 (iterations) と budget の関係

`iterations` は **`checkEquivalence` (L4 = Hydra sandbox 実行) を呼んだ回数**を数える。安いフィルタ段階の skip (whitelist 外 / round-trip 失敗) は count しない。

理由は budget 設計にある (`engine.ts:resolveBudget`):

```ts
total_budget_ms: timeout_ms * max_iterations
```

`timeout_ms` は 1 回の `checkEquivalence` の上限。`max_iterations` 倍が pruning 全体の wall-time 上限になる、という関係式。budget 制御に意味があるのは「Hydra を何回回したか」だけなので、cheap fail を数えても意味がない。

設計上の含意:

- 候補が大量にあっても、ほとんど L1〜L3 で弾かれるケースでは `iterations` は小さく、wall-time も消費しない
- 逆に少数の候補でも全て L4 まで到達すると `max_iterations` を消費しきる
- `PruningResult.iterations` の値は「**Hydra 試行コストの実消費量**」を表し、ablation study で第 1 段階のコスト分析に使える

### 候補ノード決定の 5 段フィルタ

`enumerateCandidates` は以下の条件をすべて満たすノードに限定する。

| # | フィルタ | 目的 | 実装 |
|---|---|---|---|
| 1 | placeholder 自身の除外 | 前 iteration で挿入した `Identifier($Pn)` / `ExpressionStatement(Identifier($Pn))` を再候補化すると pruning ループが破綻するため除外 (ADR-0009) | `pruning/common/candidates.ts` の `isPlaceholderNode` |
| 2 | 型 whitelist | pruning 可能な AST 型 (Statement / Expression / Identifier の 3 分類) のみ残す。**`@babel/types` の Statement / Expression alias から自動導出** (ADR-0006) | `pruning/common/rules/whitelist.ts` の `WHITELIST_CATEGORIES` keys |
| 3 | 親子位置 blacklist | 親 field validator が置換後の型を受理しない位置を**文法由来で自動判定**し除外 (ADR-0005) | `pruning/common/rules/blacklist.ts` の `BLACKLIST_CATEGORIES` |
| 4 | AST 差分フィルタ | fast に同型ノードが存在する「共通ノード」のみに絞る (差分ノードは必須扱いで保護) | `src/ast/subtree-hash.ts` の `SubtreeSet.has` |
| 5 | リテラルの差分内保護 | **リテラルは「親も共通ノード」の時のみ候補**にする。subtree-hash の値衝突で差分ノード内の load-bearing リテラル (例: `substr(0,2)` の `0` が無関係な `charAt(0)` の `0` と衝突) が共通誤判定され wildcard 化されるのを防ぐ (ADR-0028) | `pruning/common/candidates.ts` の `LITERAL_TYPES` + `diff.has(parent)` |

候補は **`end - start` 降順 (大きいノード優先)** でソートして返す (`common/candidates.ts:nodeSize`)。size 降順で試す方が、成功時に一度に縮む量が大きく、外側ループ反復数が減るという経験則。

#### whitelist のカバレッジ (ADR-0006)

`WHITELIST_CATEGORIES` は `t.FLIPPED_ALIAS_KEYS.Statement` / `Expression` から alias-driven に構築され、3 群の機械的除外が適用される (構造的 no-op / アルゴリズム不変条件 / 時点規範的除外)。

| | Babel alias 全体 | WHITELIST_CATEGORIES (現状) | カバー率 |
|---|---|---|---|
| Statement | 47 型 | **24 型** | 51% |
| Identifier | 1 型 | 1 型 | 100% |
| Expression | 52 型 (Identifier 含む) | **33 型** | 65% |
| 合計 | 99 型 | **58 型** | **約 59%** |

残り 41 型は parser plugin OFF (TS / JSX / Flow 由来) + experimental (TC39 stage < 4) + EmptyStatement で全て principle 化されている (詳細は ADR-0006)。

#### 新しい型を pruning 対象に加えるとき

dataset に新しい言語が含まれる場合は **paired-change** で対応する:

1. `pruning/common/rules/whitelist.ts:PARSER_PLUGINS` に対応 plugin を追加 (例: `["typescript"]`)
2. (新カテゴリの場合のみ) `pruning/common/rules/replacement.ts:REPLACEMENTS` に「カテゴリ → placeholderKind + buildNode」を追加

L1 blacklist (ADR-0005) も alias-derived なので **plugin 追加に応じて自動で親子位置除外が効く** (再実装不要)。詳細は ADR-0006 §対象言語拡張で扱える dataset 例。

### 置換操作の粒度 (3 カテゴリ統一のワイルドカード化)

候補ノードのカテゴリで置換動作が 1:1 に決まる (`common/rules/replacement.ts:REPLACEMENTS`)。3 カテゴリすべてで「**`$Pn` という名前の placeholder で wildcard 化**」する点は共通だが、文法的に置換可能な型が異なるため出力 AST は別形になる。

| カテゴリ | `buildNode` の出力 | `pattern_code` 上の見た目 | 公開 PlaceholderKind | 機械処理での識別 |
|---|---|---|---|---|
| statement | `ExpressionStatement(Identifier("$Pn"))` | `$Pn;` | `STATEMENT` | `node.type === "ExpressionStatement" && node.expression.type === "Identifier" && /^\$P\d+$/.test(node.expression.name)` |
| identifier | `Identifier("$Pn")` | `$Pn` (引用符なし) | `IDENTIFIER` | `node.type === "Identifier" && /^\$P\d+$/.test(node.name)` (binding 位置の文法制約と併用) |
| expression | `StringLiteral("$Pn")` | `"$Pn"` (引用符付き) | `EXPRESSION` | `node.type === "StringLiteral" && /^\$P\d+$/.test(node.value)` |

statement カテゴリの置換先が `EmptyStatement` ではなく `ExpressionStatement(Identifier(...))` になっているのは ADR-0009 の判断: 単純な `;` だと元コード由来の `;` (例: `for (;;)` の `;`) と pruning 由来 placeholder が AST 上も `pattern_code` 上も区別できず、第 2 段階抽出器の実装負担が大きいため。新形は人間可読 (`$Pn;`) と機械処理 (型 2 段判定) の両立を狙う。

statement カテゴリの対象型は `Statement` alias から `EmptyStatement` (元から空の `;`) を除いた **24 型** (`If` / `For*` / `While` / `Switch` / `Try` / `Function/ClassDeclaration` / `Import/Export*` / `Block` / `Return` / `Throw` / `Break` / `Continue` 等)。

`body: [s1, s2, s3]` のような Statement 配列では候補に `listIndex` が付くので 1 要素だけ `$Pn;` 化でき、**隣接 Statement を残したまま 1 個ずつワイルドカード化する** ことは可能 (`engine.ts:applyAt`)。

#### 元コード衝突と placeholder 自身の再候補化防止

`$Pn` 形 Identifier はユーザーコードにも書ける (構文として有効) ため、入力 slow / fast に同形が含まれると判別不能になる。`engine.prune()` は parse 直後に walk して `$Pn` Identifier があれば stderr に warning を出すが、pruning 動作は変えない設計 (ADR-0009 §元コード衝突)。

加えて、新置換先 `ExpressionStatement(Identifier("$Pn"))` 自身は statement カテゴリなので、次反復で再度 pruning 候補になる risk がある (placeholder を別 placeholder に置き換える円形再帰)。これを防ぐため `candidates.ts:isPlaceholderNode` が `Identifier($Pn)` と `ExpressionStatement(Identifier($Pn))` の 2 形を 1 段目フィルタで除外する。`PLACEHOLDER_NAME_PATTERN = /^\$P\d+$/` は `replacement.ts` で 1 箇所定義 (drift 防止)。

### 再列挙とクロスパス重複

外側ループは prune 成功のたびに `enumerateCandidates` を**再呼び出し**する (slow AST が変わったため、size 順や差分判定がやり直しになる)。成功時は `common/engine.ts` 内で `parse(generate(slow))` した reparsed AST に置き換えるので、新 AST のノード参照は完全に置き換わり、**前パスで失敗した候補が次パスで再試行される可能性がある** (構造的に同型なら blacklist / diff も再度通過する)。

これは現状の単純さを優先した割り切りで、性能上のロスのみ (機能的問題なし)。本格的に dedup したい場合は canonical hash (例: `type + start + end`) ベースの set を導入する余地がある (将来の最適化)。

外側ループの終了条件:

1. **iterations 上限到達** または **wall-time budget 超過** → 内側ループから `pruned: false` で return → 外側 break
2. **候補ゼロ** → `enumerateCandidates(...).length === 0`
3. **どの候補も prune できない** → 内側ループが `pruned: false` で return

いずれも `verdict: pruned` で結果を返す (`iterations` は実消費分まで反映)。

### pruning の正確性 — 多層防御

候補置換が「文法的・意味論的に不正」になる経路は **4 層の validation で段階的に排除** される。

| 層 | チェック内容 | 実装箇所 | 失敗時の挙動 |
|---|---|---|---|
| L1 | 静的除外 (文法由来 blacklist) | `@babel/types` の `NODE_FIELDS`/`NODE_UNION_SHAPES__PRIVATE` から自動導出したカテゴリ別ルール (ADR-0005) | 候補リストから事前除外 (試行コスト削減) |
| L2 | Babel 型検査 | AST ビルダー (`identifier()`, `stringLiteral()` 等) が型不整合を throw | engine の try/catch で revert → 次候補 |
| L3 | round-trip 検証 | mutate 後の AST を generate → parse で復元可能性を確認 | parse 失敗 → continue → finally で revert |
| L4 | 意味論的等価性 | `checkEquivalence` を sandbox 実行 | `not_equal` / `error` → 必須ノード扱い |

**L1 は効率化最適化に過ぎず、正確性は L2〜L4 の積で担保される**。L1 が漏れていても誤 prune (unsound な縮小) は発生せず、未除外の試行が sandbox 実行まで到達して L4 で弾かれるだけ (コストが増えるのみ)。

### 文法由来 blacklist の網羅性

L1 blacklist は `@babel/types` の `NODE_FIELDS[parent][key].validate` introspection (`oneOfNodeTypes` / `chainOf` / `NODE_UNION_SHAPES__PRIVATE`) から起動時 1 回だけ計算される (ADR-0005; `common/rules/blacklist.ts`)。ルールは 3 カテゴリ (statement / identifier / expression) 別に、親 × 子位置で自動生成される。

カバーされる位置の例 (列挙は自動):

- **LVal 位置**: `ForIn/OfStatement.left`, `AssignmentExpression.left`, `VariableDeclarator.id`, `CatchClause.param`
- **Identifier-only 位置**: `MemberExpression.property (computed=false)`, `Object/ClassProperty/Method.key (computed=false)`, `Labeled/Break/ContinueStatement.label`, `Function*.id`, `Function*.params`
- **destructuring LVal**: `RestElement.argument`, `ArrayPattern.elements`, `ObjectPattern.properties`
- **module / TS 系**: `ImportSpecifier` / `ExportSpecifier` 識別子、`PrivateName`、`TSTypeAnnotation` — `WHITELIST_CATEGORIES` にない型は候補 whitelist 段階で既に弾かれるが、将来拡張時にも自動で L1 が追従する

**唯一の意図的 diff**: `UpdateExpression.argument` は旧手書き blacklist では除外していたが、文法上は `Expression` alias を受理するため自動導出では除外しない。意味論的に誤った prune は L4 等価性検証で弾く方針 (詳細は ADR-0005)。

論文上の扱い:

- pruning 候補除外は「**効率最適化**」として位置づけ、unsoundness の議論とは独立に扱う ([`current-research.md` §Unsoundness の緩和](current-research.md#第-1-段階-実行ベース-hydra-式-pruning) の 3 点目)
- blacklist は Selakovic dataset に依存せず `@babel/types` の文法メタデータから mechanically 導出される、と明言できる (dataset leak 回避)

---

## Selakovic 前処理器

実装は `mb-analyzer/src/preprocessing/` (TS 抽出ロジック) + `mb_scanner/{domain,use_cases,adapters}/preprocessing/` (Python ラッパー)。Selakovic 2016 dataset の 1 issue を `(setup, slow, fast, workload)` candidate (4 値契約, ADR-0023; `workload` は placeholder-substitution 系経路 (changed-fn / changed-stmt / server-changed-fn) のみ non-null) に変換するパイプラインの最前段。設計判断は ADR-0010 (enclosure 3 段) / ADR-0011 (Tier 1/Tier 2 二層化) / ADR-0014 (A+B の candidate 分割)、`(setup,slow,fast,workload)` への対応表は [`datasets/selakovic-2016-issues.md`](datasets/selakovic-2016-issues.md)。

**論文非依存性のスコープ** (ADR-0011 §補足): 主軸 (pruning など) は Selakovic 論文 §6 (10 パターン) / §7 (5 種 precondition) に依存しない。preprocess / 等価検証は dataset 依存 OK で、`f1` / `init`/`setupTest`/`test` / `execute(f1,n)` / `mark` / `<lib>_*.js` の物理規約 (HTML 80/80・test_case 45/45 で実物検証済) を積極利用してよい (`tmp/dataset-conventions.md` §5)。本前処理器を Tier 1 (`preprocessing/common/` = dataset 非依存 AST primitive) と Tier 2 (`preprocessing/selakovic/` = Selakovic adapter) に分けるのは、その依存の境界をコード構造で明文化するため。

### 責務分担と層構造

```
TS 側 (mb-analyzer/src/)                    Python 側 (mb_scanner/)
┌──────────────────────────────┐           ┌─────────────────────────────────┐
│ ast/                         │           │ adapters/cli/preprocessing.py   │
│   parser.ts / walk.ts /      │           │  (mbs preprocess-selakovic[-batch])│
│   subtree-hash.ts /          │           │           │                     │
│   inspect.ts                 │           │           ↓                     │
│ (汎用 AST 基盤、末端層)        │           │ use_cases/preprocessing/         │
│                              │           │   selakovic.py (UseCase)         │
│ preprocessing/common/        │           │           │                     │
│ (= Tier 1, ADR-0011)         │           │           ↓                     │
│   ast-diff.ts                │           │ adapters/gateways/preprocessing/ │
│   enclosure.ts               │           │   selakovic/                     │
│   setup-cleanup.ts           │           │     dataset_scanner.py (列挙)    │
│ (dataset 非依存 AST primitive)│           │     node_runner_gateway.py      │
│                              │           │  (subprocess + JSONL parse)     │
│ preprocessing/selakovic/     │           └─────────────┬───────────────────┘
│ (= Tier 2, ADR-0011)         │  ←── stdin/stdout JSONL ─┘
│   io/ (FS I/O 層)            │
│     layout / lib-pair        │
│   decompose/ (段1 役割分解)  │
│     inline-script / f1 /     │
│     test-case                │
│   route/ (段2 作用点ルート)  │
│     aspect / lib-diff /      │
│     case-split (ADR-0014)    │
│ assemble/(setup/slow/fast/wl)│
│     angular / client /       │
│     server / fallback        │
│   pipeline (段1·段2 統括) /  │
│   index (薄い barrel)        │
│ (モジュール内ヘルパのテストは │
│  各ファイルの in-source —     │
│  ADR-0007)                   │
│                              │
│ cli/preprocess-selakovic.ts  │ ←── stdin (1 入力 / JSONL バッチ)
│ (Node CLI エントリ)            │ ←── stdout (1 入力 → N 結果 JSONL)
└──────────────────────────────┘
```

**TS = AST 解析責務、Python = データセット列挙 + 並列化 + DB / JSONL I/O 責務** で切り分け。並列化は `ThreadPoolExecutor` で chunk 単位の subprocess を多重化する pruning と同パターン。

### 抽出アルゴリズム — Tier 2 の段1 / 段2 (ADR-0011)

`preprocess(input)` (`preprocessing/selakovic/pipeline.ts`、公開は薄い barrel `index.ts` 経由) は CLI が読んだファイル内容 (inline `<script>` / `test_case_*.js` / `<lib>_before/after` の map) を受け取り、`io → decompose → route → assemble` の 4 層を順に通す。Layout 判定 (`io/layout.ts` の `detectLayout`) と `<lib>_*` の dir scan (`io/lib-pair.ts` の `loadLibPair`) は I/O を含むので CLI 側から呼ぶ — selakovic で `fs` に触るのは `io/` 配下だけ。

**段 1 (役割分解 + 計測ハーネス除去)** — `decompose/f1.ts` / `decompose/test-case.ts` / `decompose/inline-script.ts` (+ `io/lib-pair.ts`):

- ① `<lib>_before/after` ペアを **dir scan** で取る (`<lib>_before(.js|/)` を探す。`<script src>`/`require` 参照とは独立 — clientIssues でも `<lib>_*.js` を必ず読む。これが ADR-0011 改修の核で、作用点 A の clientIssues が初めて真 patch を見られるようになる)。
- ② ベンチマーク関数 body ペアを取る。clientIssues: inline `<script>` から `f1` 定義 (AST 親パスは実質 top-level 直書き / Angular controller-wrapper の 2 種) を特定して body を切り出し、`var a = execute(f1, n)` 以降 / `$.ajax({mark,mean})` / `console.log(mean)` を harness に分離、`f1` 定義より前の非ハーネス statement を preF1 (= setup の母体) に。server: `test_case_*.js` から `init`/`setupTest`/`test` を特定し `test()` body を切り出す (`init`/`setupTest` は計測ハーネス)。**body 内のループ反復回数 (`for (i<50000)`) は書き換えない** — 復元可能性のため、反復縮小は等価検証側の transform に委ねる (ADR-0013)。

**段 2 (作用点ルーティング)** — `route/aspect.ts` / `route/lib-diff.ts` / `route/case-split.ts`:

- ① の差分 (`route/lib-diff.ts`: 行ベース multiset 差分で license/version/整形 noise を除いて実コード行が残るか + 近傍の関数名を近似) と ② の差分 (`route/aspect.ts` の `statementsChanged` = Tier 1 `findChangedNodes` の AST diff が空でないか) で作用点を **A** (lib のみ) / **B** (body のみ) / **A+B** (両方) / **fallback** (どちらも実質差なし / 規約外フォーマット) に振り分ける。
- A → candidate 1 個 (lib varies / body fixed@before)。B → candidate 1 個 (body varies / lib fixed@before)。A+B → ADR-0014 の identifier 交差判定 (`route/case-split.ts` の `isIndependent`: body の参照 identifier ∩ lib 変更関数名が空なら independent) で 2 candidate (`candidate_kind: lib` / `body`) に分割、交差ありなら co-evolution の疑いで 1 candidate。
- candidate の `(setup, slow, fast, workload)` (4 値契約, ADR-0023; 上図 `wl` = workload) は `assemble/` が **strategy (組み立て方) × wrapper (包み方)** で構築する。現構成: `assemble/strategies/{changed-fn, changed-stmt, fallback, server-changed-fn}.ts` + `assemble/wrappers/{angular, top-level, server}.ts` (順2-1 で wrapper を分離、順3-2 で server-changed-fn を追加)。**placeholder-substitution 系経路 (changed-fn / changed-stmt / server-changed-fn)** は setup=穴あき lib(+bootstrap)・slow/fast=変更前後の裸 body・workload=観測駆動 (changed-fn/changed-stmt は `wrapObservedWorkload` で `f1()` を包み `JSON.stringify(__OBS__)` を返す。server-changed-fn は下記の 2 チャネル観測) の 4 値、**embedded / fallback の self-contained runnable 経路**は `workload` を持たず slow/fast が自己完結 runnable。Angular controller-wrapper は `wrappers/angular.ts` が「lib を load → module/controller を再構成 (ハーネス除去済) → controller を実体化 → `f1()` を 1 回実行 → 観測値を return」する自己完結 IIFE を作る (Phase 1.0 スパイクで AngularJS 950KB の jsdom load+bootstrap を実証)。top-level f1 の client candidate は `wrappers/top-level.ts` が `(function(){ <f1 body> })()` で包む。
- **server-changed-fn (`strategies/server-changed-fn.ts`、ADR-0025 / 順3-2)**: `layout=server` の変更関数が browser-style $BODY$ 連結と整合せず drop していた問題を、CommonJS 構造を保ったまま変更関数 body だけ `$BODY$` 穴あけする holed lib で救済する。multi-file は in-memory map-require、観測は 2 チャネル (戻り値 `r` + init 戻り値の post-state `s`)。実行は ADR-0024 で予約した `environment: 'vm'` の node:vm executor。これにより server×top_level の reached が 0/26 → 14/3 に改善。
- `environment` hint (ADR-0012): server / Angular wrapper / lib を含む candidate は `jsdom` (= `require` 解決 / DOM が要る)、Phase 2a では client candidate もすべて `jsdom` (inline `<script>` が `document`/`window` を参照しうるため)。後段 (verify スクリプト / Python orchestrator) が `EquivalenceInput.environment` + `module_base_dir` (= issue ディレクトリ) に渡し、jsdom executor が相対 `require` を解決する。

**fallback (`assemble/fallback.ts`)**: 段2 が「①にも②にも実質差なし」または `f1`/`test` が規約外フォーマットと判定した issue は、Tier 1 の素の top-level statement AST diff (= ADR-0011 以前の `preprocess()` (旧名 `extract()`) の素の挙動: `canonicalHash` で matched を除外 → unmatched ペアを `findChangedNodes`/`findMinimalEnclosure` → candidate、setup = 自分以外の全 top-level statement の before 版) にフォールバックする。実物では稀 (Phase 2a の 97 issue では JSX を含む 1 件のみ excluded、fallback 経由抽出は 0)。下記「setup 構築規約」「enclosure 3 段優先順位」はこの fallback 経路の話。

### enclosure 候補型の 3 段優先順位

`findMinimalEnclosure` (`preprocessing/common/enclosure.ts`) は changed_nodes の LCA から root に向かって 3 段の優先順位で候補型を探す:

| 段 | 候補型 | 想定する変更パターン | 例 |
|---|---|---|---|
| **1** | **関数/メソッド系**: FunctionDeclaration / FunctionExpression / ArrowFunctionExpression / ClassMethod / ObjectMethod | 関数 body 内の局所的最適化 | `var f1 = function () { ❶ };` |
| **2** | **ブロック系**: BlockStatement | 関数/メソッドではないがブロック内に閉じた変更 (if/for body 等) | `if (cond) { ❶ }` |
| **3 (改良 3)** | **Top-level statement 系**: VariableDeclaration / FunctionDeclaration / ClassDeclaration / ExpressionStatement | 関数全体の refactor、`module.exports = ...` 形式の代入式変更 | `module.exports = function (...) { ...大量変更... };` |

段 1, 2 は「**変更を内包する最も内側の構文単位**」を取る本来の minimal enclosure。段 3 は「LCA が関数/Block より外まで上昇するケース」(= 関数 body 全面 refactor / 代入式の右辺 refactor) を救済する fallback で、Selakovic の library 全面修正 (EJS の parse、Backbone の model 系) で頻出する。

段 3 採用時は slow/fast に top-level statement 全体が入るため、後段 pruning でその statement 全体の最小化が走る。**論文非依存性**: 候補型の追加は ECMAScript 文法レベルの一般概念のみで、Selakovic Table 4 / precondition には依存しない。threats to validity に「関数全体置換のような大規模 refactor は top-level statement 単位で抽出する」と明記する。

### 1 入力 → 1 IssueResult モデル (ADR-0024、base / adapter 分離 + issue 階層化)

Selakovic データセットには **同一 PR に複数の独立した最適化が同居するケース**がある (例: socket.io 573 では `encodePacket` の switch case 順序入れ替え + `decodePacket` の if/else→switch 書き換えが同一 commit に含まれる)。これに対応するため、`preprocess()` の戻り値を **1 つの `PreprocessingIssueResult`** (内部に `candidates: list[PreprocessingCandidate]` を持つ階層構造) にする。

#### 物理レイアウト

```
PreprocessingIssueResult (= jsonl の 1 行)
├─ id, issue_excluded, issue_excluded_detail, candidate_count    ← base (dataset 非依存)
├─ candidates: list[PreprocessingCandidate]                       ← N candidate を内包
│    ├─ setup, slow, fast, before/after_node_count                ← base
│    ├─ enclosure_node_type, candidate_excluded                   ← base
│    └─ candidate_meta: SelakovicCandidateMeta                    ← adapter (Selakovic 固有)
│         ├─ adapter: "selakovic" (discriminator)
│         ├─ target_side: lib / workload / both
│         └─ is_workload_reachable: bool
└─ issue_meta: SelakovicIssueMeta                                 ← adapter (Selakovic 固有)
     ├─ adapter: "selakovic" (discriminator)
     ├─ layout: client / server / unknown
     ├─ aspect: lib / workload / lib+workload / fallback
     └─ wrapper_kind: top_level / angular_controller_wrapper
```

新 dataset 追加時は base contract を触らず adapter sub-class (`OtherIssueMeta` / `OtherCandidateMeta`) を足し、`IssueMeta` / `CandidateMeta` の Discriminated Union を広げる。

#### candidates 数の意味

| candidates 数 | 出力 |
|---|---|
| 0 (issue 全体が処理失敗) | `issue_excluded` を立てて 1 IssueResult を返す (= 旧 excluded と等価) |
| 1 | 通常の単独 candidate (embedded / co-evolution / workload-only / fallback 等) |
| 2 | ADR-0014 の independent split (target_side=lib + target_side=workload) |
| N (≥ 2) | aspect=lib + changed-fn 複数 (各 fn unit ごとに candidate)、または fallback で複数 candidate |

id は **issue 単位で 1 対 1** (旧 `<input.id>#<index>` の suffix 付与は廃止)。Python Gateway も prefix-match による集約ロジック削除、入力数 == 出力数で対応。

#### 主要フィールドの生成箇所と意味

| フィールド | 値 | 生成箇所 | 用途 |
|---|---|---|---|
| `issue_meta.layout` | client / server / unknown | `io/layout.ts:detectLayout` | レイアウト判定。equiv 入力時の `environment` (vm/jsdom) はここから派生 |
| `issue_meta.aspect` | lib / workload / lib+workload / fallback | `route/aspect.ts:routeAspect` | 真 patch がどこにあるか (= issue level、ADR-0011 §段2) |
| `issue_meta.wrapper_kind` | top_level / angular_controller_wrapper | `decompose/f1.ts:extractF1` | f1 の wrap 構造 (Angular DI bootstrap 要否の判定) |
| `candidate_meta.target_side` | lib / workload / both | 各 assemble 関数で hardcode | この candidate がどっち側を表現するか (candidate level) |
| `candidate_meta.is_workload_reachable` | bool | `assemble/changed-fn.ts` で True、その他で False | 旧 changed_fn 抽出由来かどうかの識別 |
| `enclosure_node_type` | Babel ノード型 (`FunctionExpression` 等) or null | `assemble/changed-fn.ts:69` (afterFn.type) / `assemble/fallback.ts` (findMinimalEnclosure) | ADR-0010 の本来意図 — 「どの粒度に収束したか」の threats to validity 集計 hint |

#### 旧 → 新 mapping (廃止フィールド)

旧 `candidate_kind` / `enclosure_type` (戦略ラベル含む) / `environment` は廃止:
- 旧 `candidate_kind` (single/lib/body/changed-fn) → `(issue_meta.aspect, candidate_meta.target_side, candidate_meta.is_workload_reachable)` の組合せで再構成
- 旧 `enclosure_type` の戦略ラベル (`lib-file` / `f1-body` / `lib-file+f1-body` / `server-test-case` / `angular-controller-wrapper`) → `(aspect, target_side, layout, wrapper_kind)` から派生可能 (= 廃止)
- 旧 `enclosure_type` の Babel ノード型 → `enclosure_node_type` に分離 (changed_fn / fallback でのみ意味)
- 旧 `environment` → 廃止。equiv 入力時に Selakovic adapter (`research/.../code/build_equiv_input.py:derive_environment`) が現状は **常に `jsdom`** で埋める (server candidate も `require`/Node globals を jsdom executor の shim で解決する前提、ADR-0015 / `oracle-routing.ts` 参照)。VM executor が server contract をサポートする実装が入ったら layout 別の派生に戻す

#### 集計フィルタの書き方 (research script)

旧 `SMALL_KINDS = {"changed-fn", "body"}` を新フィールド条件に置換:

```python
def is_small_candidate(issue, candidate):
    cmeta = candidate["candidate_meta"]
    if cmeta["is_workload_reachable"]:    # 旧 changed-fn 相当
        return True
    imeta = issue["issue_meta"]
    return imeta["aspect"] == "lib+workload" and cmeta["target_side"] == "workload"  # 旧 body 相当
```

具体例:
- co-evolution issue だけ: `issue_meta.aspect == "lib+workload" and candidate_count == 1 and candidates[0].candidate_meta.target_side == "both"`
- Angular benchmark だけ: `issue_meta.wrapper_kind == "angular_controller_wrapper"`
- changed-fn が 1 件も出なかった (= workload reachability で全 drop された) issue: `issue_meta.aspect == "lib" and not any(c.candidate_meta.is_workload_reachable for c in candidates)`

### setup 構築規約

各 candidate の `setup` は **「自分以外の全 top-level statement (matched + 他 unmatched) の before 版を index 順に結合」** したもの。

```
candidate i に対する setup:
  setup = generate(beforeBody.filter(idx => idx !== candidate.beforeIndex))
  slow  = generate(beforeBody[candidate.beforeIndex])
  fast  = generate(afterBody[candidate.afterIndex])
```

メンタルモデル: 「他の最適化対象は **最適化前の状態 (before) を環境として固定**」。これにより:

1. **両側 (slow/fast) の setup が完全同一**になり、関数間依存があっても等価判定が破綻しない
2. 各 candidate を独立した最適化単位として扱える (Selakovic 論文では PR 単位の最適化として記述されているが、本前処理器ではより細かい変換単位で抽出する)
3. `var hoisting` や副作用順序を含めた実行コンテキストが現実的に再現される

#### changed-fn (v2 placeholder substitution、ADR-0023) の 4 値構成 (setup / slow / fast / workload)

`changed-fn` candidate は 4 値契約 (ADR-0023 D-β)。`slow`/`fast` は変更前/後の**裸 body** statement 列、`workload` は **別フィールド**で SUT を exercise する観測駆動 (`wrapObservedWorkload` 出力 = `f1()` 呼び出し → `JSON.stringify(__OBS__)` 返却)。検証器は `setup` を executor.setup、`workload` を executor.workload として**別々に**渡す (`workload` は setup に含まれない)。以下は `setup` フィールドの構成。

`setup` は **2 つの要素を順序固定で連結** したものとして定義される。両要素とも optional (空ならスキップ):

| 要素 | 内容 | optional になりうるケース |
|------|------|------------------------|
| **`libs`** | workload が必要とする lib テキスト群の連結。物理的な出処 (`<script src>` 由来の外部依存 / `<lib>_*.js` 由来の変更対象 SUT lib) を問わず、sandbox にとっては同列の「workload が叩く lib」として扱う。`changed-fn` の場合、このうち 1 つ (= 変更対象の SUT lib) の **変更関数本体に観測 IIFE が inline 化され、その内側に `$BODY$` プレースホルダが残る** (= `replaceFunctionBodyWithObserver` の出力、ADR-0023 D-δ §observation 仕様) | workload が lib を要求しない issue |
| **`preWorkload`** | workload 関数 (= dataset の `var f1 = function () { ... }`) を実行する前に必要な top-level 文。計測ハーネス (`execute()` / `mean()` / `$.ajax({mark, mean})`) は preprocess 段階で剥がして含めない (ADR-0011) | dataset に該当文がない issue |

連結ルール:

```ts
setup = [libs, preWorkload].filter((s) => s.length > 0).join("\n;\n")
```

`$BODY$` プレースホルダは sandbox 実行直前に `before` / `after` の変更関数本体 (= 裸 statement 列、観測ハーネスは setup 側の `replaceFunctionBodyWithObserver` 出力に inline 化済) で差し替えられる (`codegen/placeholder.ts` の `substituteBody`)。

加えて executor に渡す直前で **`let __OBS__ = [];` 宣言** が setup の最先頭に prepend される (`declareObservationGlobal` helper)。これにより `replaceFunctionBodyWithObserver` で inline 化された観測 IIFE / `wrapObservedWorkload` が出力する `__OBS__` 参照が sandbox top-level の lexical binding として全関数から closure 経由で見える。executor.setup 引数の最終形は:

```
let __OBS__ = [];
;
[dep prelude (= <script src> 由来の jquery / handlebars 等、ある場合のみ)]
;
[libs ($BODY$ 差し込み済)]
;
[preWorkload]
```

`__OBS__` 宣言を dep prelude より前に置く (= TDZ 安全)。連結順序は呼び出し側 (`pipeline.ts` または D-β の `changed-fn.ts`) で保証する。

例: Underscore 1222 (`_.values` の changed-fn) では:

```js
// libs (= Underscore lib 本体、_.values の body だけ「観測 IIFE + $BODY$」化、D-δ)
//   = workload が叩く lib テキスト
(function () {
  // ... Underscore lib 本体 ...
  _.values = function (obj) {
    // ↓ replaceFunctionBodyWithObserver で setup 側に inline 化された観測 IIFE
    let __OBS_R__ = (function () { $BODY$ }).call(this);
    __OBS__.push((function () { try { return JSON.stringify(__OBS_R__); } catch (e) { return "<unserializable>"; } })());
    return __OBS_R__;
  };
  // ... lib bootstrap ...
}).call(this);

// preWorkload (= var f1 より前の top-level 文)
var map = {};
for (var i = 0; i < 100; i++) { map["prop" + i] = i; }
```

物理層 (dataset の `<script src>` 解決 / `<lib>_*.js` 読み込み) は `preprocessing/selakovic/io/script-deps.ts` および `preprocessing/selakovic/pipeline.ts` で吸収する。`codegen/placeholder.ts` (末端層) は dep / SUT の区別を持たず、純粋に AST/string transform として動作する。

### レイアウト判定 (clientServer 救済は段1 ① で自然に解決)

Selakovic データセットは 3 カテゴリ (clientIssues / serverIssues / clientServerIssues) でレイアウトが混在している:

| カテゴリ | 物理構造 | 最適化対象の所在 |
|---|---|---|
| **clientIssues** | `v_*.html` + `<libname>_*.js` (jsperf 用ライブラリスナップショット) | inline `<script>` 内 (作用点 B) または `<libname>_*.js` 内 (作用点 A) |
| **serverIssues** | `<libname>_*/` ディレクトリ + `test_case_*.js` | `<libname>_*/...` 内 (作用点 A) または `test()` body 内 (作用点 B = ケース IV-B) |
| **clientServerIssues** | `v_*.html` + `<libname>_*.js` 単一ファイル + `test_case_*.js` | `<libname>_*.js` 単一ファイル (inline script は jsperf 計測ハーネス) |

`detectLayout` は `v_*.html` があれば `client`、無く `<libname>_*/` or `<libname>_*.js` があれば `server`、どちらも無ければ `unknown` と判定する (内容構造規則 `f1` / `init`/`setupTest`/`test` には依存しない)。

**旧来の「client → server-single-file fallback」(clientServer 救済) は ADR-0011 改修で不要になった**: 段1 ① が client 経路でも `<libname>_*.js` を dir scan で必ず読むので、clientServerIssues (inline script は計測ハーネスで真 patch は lib 側) は段2 で `bodyHasRealChange=false / libHasRealChange=true` → 作用点 A としてルートされる。同様に作用点 A の clientIssues (Phase 0-A `harness_only` ≈ dataset の 6 割) も初めて真 patch を抽出できる (Phase 0-A では client 経路が `<script src>` を捨てて `mark: 0|1` artefact だけ candidate 化していた — `tmp/dataset-conventions.md` §4)。

### 除外理由の意味論 (ADR-0024 で base / Selakovic に分離)

ADR-0024 で除外理由 enum を **base 4 値 + Selakovic 4 値の Union** (`ExclusionReasonAny = ExclusionReasonBase | SelakovicExclusionReason`) に分離。`issue_excluded` (issue level) と `candidate_excluded` (candidate level) の両方が同 Union 型を受ける。新 dataset 追加時は `XxxExclusionReason` を Union に追加。

| reason | 種別 | 意味 | 救済可能性 |
|---|---|---|---|
| `parse-error` | base (`ExclusionReasonBase`) | Babel parser が SyntaxError を throw | データ固有の特殊 syntax を扱う plugin 追加で部分救済可 |
| `no-changed-nodes` | base | 全 top-level statement が AST hash で matched (整形差分のみ) | 救済不要 (意味論変更なし) |
| `multi-file-change` | base | server 系で意味論変更が複数 .js ファイルにまたがる | 出力スキーマ拡張で対応可 |
| `missing-files` | base | 期待ファイル欠落 / I/O 失敗 | データ固有、個別対応が必要 |
| `module-wide-change` | Selakovic (`SelakovicExclusionReason`) | unmatched 残るが 3 段すべての enclosure 候補型 (関数/Block/top-level statement) に到達できない | 設計上ほぼ起きない (top-level statement で必ず救える) |
| `no-enclosure-candidate` | Selakovic | enclosure 抽出の内部不変違反 (通常起こらない) | bug fix 対象 |
| `layout-unknown` | Selakovic | `v_*.html` も `<libname>_*/` も `<libname>_*.js` も無いディレクトリ | データ固有、個別対応が必要 |
| `change-not-exercised` | Selakovic | lib の変更を (推移的にも) exercise する workload (`f1` / `test()`) が無い (= reachability で全 drop) | 別 ADR で計装する予定 (現状は未使用 enum slot) |

実測 (現行パイプライン 17bb101 再走、Selakovic 97 issue → 316 candidate): 抽出済 issue 96 / excluded 1 (`parse-error` = inline `<script>` が JSX を含む 1 件)。Tier 2 で `f1`/`test()` が規約外フォーマットの場合は exclude せず fallback (Tier 1 素の diff) に回るようになったので、上表の理由は実質 fallback 経路でのみ発生する。これら抽出済 candidate を等価検証まで流した最新の verdict 内訳は本文書の [§Selakovic データセットでの実測](#selakovic-データセットでの実測) (現行パイプライン 17bb101 再走 = verdict 到達 79/97、issue 単位 equal 65 / not_equal 9 / error 5) を参照。threats to validity への記述方針: 各除外・各 not_equal を **「データセット / 等価検証器の限界として明示」** し、論文非依存性を主張する論理 (= 主軸 pruning は論文非依存) を保つ。

### 既知の運用上の落とし穴 (Node CLI の stdout flush)

`preprocess-selakovic` の出力は 1 issue あたり大きい — 作用点 A の clientIssue は bundled ライブラリ (AngularJS 665KB / Ember 2MB 等) を slow/fast に丸ごと埋めるので 1 candidate が数 MB になりうる (Phase 2a; 将来 Phase 2b の adapter 再配置で shared setup によるサイズ削減を検討)。Node の `process.exit()` を即座に呼ぶと **stdout が flush 完了前に exit して 64KB で truncate される** (macOS pipe バッファ境界)。Python subprocess.run 経由では結果消失として観測される。

回避策 (`mb-analyzer/src/cli/index.ts`):

```ts
main()
  .then(async (code) => {
    await waitForFlush(process.stdout);  // drain イベントを待つ
    await waitForFlush(process.stderr);
    process.exit(code);
  });
```

`process.exit()` の前に `waitForFlush` で drain を待つ。これは preprocess-selakovic / preprocess-selakovic-batch のように大量 stdout を返すサブコマンド全般で必要な対策。pruning / equivalence-checker は出力量が小さいので顕在化しなかったが、**新サブコマンドで大量出力が想定される場合は同パターンを踏襲する**。

### 既知の運用上の落とし穴 (VM cross-realm Error)

`vm.runInContext` で throw された `Error` は **VM context (別 realm) の Error コンストラクタで生成**されるため、outer realm から `e instanceof Error` で判定すると **常に false になる**。これは Node.js の vm モジュール固有の挙動で、ライブラリ作者が頻繁に踏む落とし穴。

旧実装 (Phase 2b.1 リファクタ前の `equivalence-checker/checker.ts`):

```ts
const message = e instanceof Error ? e.message : "unexpected non-Error thrown";
```

→ VM 内で `ReferenceError: angular is not defined` が throw されても `instanceof Error` が false で本来のメッセージが捨てられ、全件「unexpected non-Error thrown」として report されていた。

修正後 (duck typing、現在は `selakovic/checker.ts` の `extractErrorMessage`):

```ts
function extractErrorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "object" && e !== null) {
    const obj = e as { message?: unknown; constructor?: { name?: unknown } };
    const ctorName = typeof obj.constructor?.name === "string" ? obj.constructor.name : null;
    if (typeof obj.message === "string") {
      return ctorName !== null && ctorName !== "Object" ? `${ctorName}: ${obj.message}` : obj.message;
    }
  }
  if (typeof e === "string") return e;
  return `unexpected throw: ${String(e)}`;
}
```

`.constructor.name` で型名 (`ReferenceError` / `TypeError` / `SyntaxError`) を、`.message` で詳細を拾う。これで VM 内 throw でも本来のエラー種別とメッセージが outer に伝わる。

なお `common/sandbox/capture/snapshot.ts` の `captureException` は元々 duck typing で実装されている (oracle 用の exception field キャプチャ)。本修正は **executor 外で起きる throw** (= setup の `vm.runInContext` 直接 throw) を `selakovic/checker.ts` の outer try/catch で受ける際の同パターン適用 (`error_message` 用)。

### 既知の運用上の落とし穴 (pnpm shared install と相対 require の不整合, Phase C-1)

Selakovic dataset fork は SUT lib の npm dep を lockfile で宣言し pnpm でインストールする (ADR-0016)。pnpm の **shared install** は実体を上位 dir の `node_modules/` に置くため、`<issueDir>/<lib>/node_modules/<dep>/` のような物理パスは存在しない。ところが dataset の一部 `test_case_*.js` (Selakovic 2016 の Backbone 系) は lib の transitive dep を `require('./<lib>/node_modules/underscore')` のように **hardcode 相対パス**で参照する。jsdom executor の require shim はまず素直に相対解決を試み、失敗したら **末尾 `/node_modules/<dep>` パターンを bare module 名として抜き出し `createRequire` 経由で再解決する** (`common/sandbox/executors/jsdom.ts` の `installRequire`)。bare 解決も失敗したら元の `ENOENT` を投げて Phase F の error 分類で可視化する。これにより Node の relative 解決では辿れない pnpm shared dep を救う。

### Selakovic データセットでの実測

workload-reachability v2 (ADR-0022/0023/0024) + server strategy (ADR-0025) + リテラル保護 (ADR-0028) を経た**現行パイプラインで Selakovic 97 issue を全件再走** (main @ `17bb101`) した funnel:

- ① 全 issue **97** → ② 真の candidate 抽出済 **96** (excluded 1 = `parse-error`) → ③④ equiv-input 投入 = verdict 到達 **79 issue (81%)**
- issue 単位 verdict: **`equal` 65 / `not_equal` 9 / `error` 5**
- candidate 単位: 抽出 **316** → small-candidate 投入 **113** (equal 84 / not_equal 16 / error 12 / inconclusive 1)
- layout × wrapper_kind (issue, reached/total): client top_level 48/55・client angular 17/25・**server top_level 14/17** (順3-2 で server を 0→14 救済)
- pruning: equal 84 candidate → **`pruned` 50** / error 33 / initial_mismatch 1 (error の主因は client big-setup の `$BODY$` 未解決、server 非波及)

**詳細・集計スクリプトは `research/research/preprocess_workload_reachability/code/` (`funnel.py`) と `tmp/0048_full-rerun-17bb101/` を参照** (code-map 側はスナップショットを持つだけ。RQ の主張への結び付け方は [`current-research.md` §妥当性の脅威](current-research.md))。旧 Phase 2a スナップショット (`equal` 71/108, ADR-0018 期) は workload-reachability 再設計前のもので **superseded**。

pruning 段の検証 (段階別 funnel / 論文 10 パターンの形検出 regex vs AST / リテラル保護 ADR-0028 spike) は `research/research/pruning/` (`code/{stage_funnel,match_regex,match_ast,pattern_map}` + `notes/{method,result,spike-literal-impact}.md`) にまとまっている。主な知見: 形検出は loose 8/8・strict 6/8 (regex≒AST)、リテラル保護で 5/8→6/8。既知の限界は ADR-0028 (繰り返し式の hash 衝突 / 挿入型最適化)。
