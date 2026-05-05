# code-map — 実装の意味論リファレンス

この文書は **実装がどう動いているか**（データフロー、責務分担、内部不変条件）を説明する **Reference**。論文執筆時の引用元、深堀り時の参照、新メンバ onboarding を主な用途とする。

ai-guide 全体での位置づけと他軸との住み分けは [`doc-strategy/index.md`](doc-strategy/index.md) を参照。**ファイル単位の詳細は in-tree README に委譲** し、本文書はモジュール単位の役割とデータフローまでで止める。

---

## 目次

- [等価性検証器](#等価性検証器)
  - [観測軸: slow/fast と pre/post](#観測軸-slowfast-と-prepost)
  - [4 オラクルの責務分担](#4-オラクルの責務分担)
  - [オラクル間の排他ルールと `not_applicable` の意義](#オラクル間の排他ルールと-not_applicable-の意義)
- [Pruning エンジン](#pruning-エンジン)
  - [ファイル構成](#ファイル構成)
  - [データフロー](#データフロー)
  - [試行回数 (iterations) と budget の関係](#試行回数-iterations-と-budget-の関係)
  - [候補ノード決定の 4 段フィルタ](#候補ノード決定の-4-段フィルタ)
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

（sandbox パイプライン / verdict 合成 / Python↔Node JSON 往復 の詳細は今後追加予定）

---

## 等価性検証器

実装は `mb-analyzer/src/equivalence-checker/` 配下。ファイル単位の責務 / 依存方向 / 関連 ADR は [`mb-analyzer/src/equivalence-checker/README.md`](../mb-analyzer/src/equivalence-checker/README.md) を参照。本節は **観測軸とオラクル責務の意味論** に絞る。

### 観測軸: slow/fast と pre/post

等価性検証は **2 つの直交する軸** で観測を組み立てます。名前の由来が異なるので混同しないこと。

#### slow / fast 軸 ← データセット起源

Selakovic 2016 dataset の **before/after パッチペア** に対応します。1 トリプル = **(setup, slow=before, fast=after)** を同一 setup 上で別 sandbox 実行し、**検証したい意味論的差異はこの軸で現れる**のが研究目的上の要請です。

#### pre / post 軸 ← Oracle 2 の実装技法

JS の破壊的変更（`arr.push(x)` 等）は戻り値にも例外にも現れないため、`argument-mutation` oracle は body 実行の **直前 (pre) と直後 (post) の 2 回スナップショット** を取って差分から in-place mutation を検出します。**1 回の sandbox 実行内で閉じた時間軸** であり、slow/fast のサイド軸とは別概念です。

#### 2 軸の組み合わせ

```
               pre (body 前)       post (body 後)
slow サイド    slow.snapshots.pre  slow.snapshots.post
fast サイド    fast.snapshots.pre  fast.snapshots.post
```

- Oracle 2 は **`slow.post` vs `fast.post`** を比較する
- `pre` は不変条件の記録用（setup 共通性から `slow.pre == fast.pre` が想定される）
- `slow.pre != fast.pre` や key 集合の片側欠落は **setup 不変条件の違反** に当たるが、現状は防御的に `not_equal` に畳まれる

---

### 4 オラクルの責務分担

JS で観測可能な差異は 4 方向に落ち、各オラクルが 1 軸ずつ担当します。

```
body 実行
├─ 戻り値として出てくる       → O1 (return_value)
├─ 引数が破壊的に変わる        → O2 (argument_mutation)
├─ 例外として throw される      → O3 (exception)
└─ 外界に漏れ出す (console / global) → O4 (external_observation)
```

| # | Oracle | 比較対象 | 比較方法 | 実装 |
|---|---|---|---|---|
| O1 | `return_value` | body の**戻り値** | serialize 済み文字列の完全一致 | `oracles/return-value.ts` |
| O2 | `argument_mutation` | setup 由来 object/array の **body 後の状態** | key 毎に `slow.post` vs `fast.post` を比較 | `oracles/argument-mutation.ts` |
| O3 | `exception` | body が投げた**例外** | `ctor` + `message` の一致 | `oracles/exception.ts` |
| O4 | `external_observation` | **console 呼び出し列** + **新規 global 変数** | console: method/args の順序込み／globals: key 集合 | `oracles/external-observation.ts` |

#### O1: `return_value`

`slow.return_value` vs `fast.return_value`（`snapshotValue` で文字列化済み）を比較します。代表的な検出対象: `for..in` の列挙結果、`String()` の文字列化結果、Promise の解決値（`await` 後の値で比較）。

#### O2: `argument_mutation`

setup で定義された object/array 変数の **body 実行後スナップショット** を両サイドで突き合わせます。代表的な検出対象: `arr.push(x)`、`obj.key = v`、`splice` 等の in-place 破壊的変更。戻り値に現れない副作用を担当します。詳細は [観測軸セクション](#観測軸-slowfast-と-prepost) 参照。

#### O3: `exception`

`ExceptionCapture = { ctor: string, message: string }` を両サイドで突き合わせます。代表的な検出対象: prototype 汚染下での `TypeError`、`hasOwnProperty` が破壊された時の throw、実装差による例外メッセージ変化。

##### 限界と判断根拠

O3 は設計上 3 つの観測を **していない**。それぞれの判断を明記しておく（偽陽性・偽陰性の議論で参照されやすいため）。

| 非観測項目 | 判定 | 根拠 |
|---|---|---|
| stack trace の比較 | **要件（比較しない）** | パッチ適用で行番号・内部関数名は必ず変わる。stack を比較すると Selakovic の全パッチが `not_equal` になり、検証器として成立しない。**「意味論的等価性の定義に stack を含めない」** は設計要件であり妥協ではない |
| message 内の動的値（変数名・プロパティ名）に由来する揺れ | **許容（偽陽性にならない）** | (setup, slow, fast) は **同一プロセス・同一 V8 realm** で実行され、setup が共通なら埋め込まれる動的値も両側で一致する。V8 バージョン差による文言書き換え（例: `"Cannot read property"` → `"Cannot read properties of"`）は CI の Node バージョン固定 (`mise`) で対処する |
| 例外発生までの中間状態 | **限界ではない（O2/O4 で補完済み）** | `executor.ts:82-90` は try/catch 通過後に post snapshot / console 列を確定するため、throw 直前までの副作用は **O2 (arg_snapshots) / O4 (console_log, new_globals) が自動的に拾う**。O3 単体で partial state が見えない点は oracle 間の協調で解決済み |

**結論: O3 の設計上の非観測はすべて許容しうる。** 特に stack trace 非比較は「**意味論的等価性の定義上 stack を含めない**」という研究上の要件であり、拡張して比較可能にしても FP が爆発するだけなので採用しない。

#### O4: `external_observation`

2 つの副作用ストリームを比較します:

1. **`console_log`**: console.log/warn/error 等の呼び出し列 — **method 名 + 引数の順序込み**で完全一致
2. **`new_globals`**: body 実行中に新規作成された global 変数名の集合（順序無関係、`Set` 比較）

代表的な検出対象: デバッグ出力の意図しない削除、global への無名リーク（`var`/`let` 忘れ）、DOM/I/O 系パターンの副作用差分。

---

### オラクル間の排他ルールと `not_applicable` の意義

4 軸は独立に判定されるが、**Oracle 間で責務の押し付け合いが発生しないよう排他ルールが組み込まれている**。

#### ルール 1: 例外時は O1 が身を引く

`oracles/return-value.ts` L18-20:

```ts
if (slow.exception !== null || fast.exception !== null) {
  return { oracle, verdict: ORACLE_VERDICT.NOT_APPLICABLE };
}
```

片方でも例外が起きた瞬間、O1 は `not_applicable` を返して **例外の比較は O3 に完全委譲** する。これが無いと「例外の文字列表現 vs 正常値」を比較して偽陽性が出る。

#### ルール 2: `not_applicable` は overall verdict を潰さない

`deriveOverallVerdict` は observation のうち `not_applicable` を除外してから集約する。これにより、**該当しない軸の存在が overall verdict のノイズにならない**。

具体例:

- 両側とも同じ値を返す純粋関数 → O1 `equal`、O2-O4 `not_applicable`、overall `equal`
- 両側とも同じ例外を投げる関数 → O1 `not_applicable`、O3 `equal`、overall `equal`

`not_applicable` は「検査しない」ではなく「**この軸ではこのトリプルを判定しない（他軸に任せる）**」という**責務移譲のシグナル**として機能している。

#### ルール 3: overall verdict の合成優先順位

`deriveOverallVerdict`（`verdict.ts`）は以下の優先順位で合成する:

1. いずれかの oracle が `not_equal` → **`not_equal`**
2. いずれかの oracle が `error` → **`error`**
3. 全 oracle が `not_applicable` → **`error`**（観測対象ゼロでは等価性を判定できない）
4. 残りは少なくとも 1 つ `equal` を含む → **`equal`**

設計上の含意:

- **`not_equal` が最強**: 実際に差異が観測されたら、他軸で error や not_applicable が出ていても **not_equal を信じる**。「観測できた非等価」は「観測できなかった軸」より優先。
- **`error` は not_equal に負ける**: シリアライズ不能 (循環参照) や timeout 等で観測不可でも、別の軸で差異が取れていれば non-equivalent 判定を優先する。
- **全 not_applicable も error**: 「4 軸すべてで何も観測できなかった」は等価の証拠にはならず、**観測失敗**として扱う。例: 両側とも body が文のみ (return 無し、副作用なし、例外なし、引数変更なし)。

---

### 観測できない事象（既知の限界）

4 オラクルを揃えても、以下 4 件は観測対象外であり **偽陰性（non-equivalent を equal と誤判定）のリスク源**となる。本データセット (Selakovic 2016) では発生頻度が低く実害は限定的だが、**等価性検証器を汎用ツールとして他研究へ再利用する場合は拡張が必要**。

| # | 観測されない事象 | 原因（実装箇所） | Selakovic での影響度 |
|---|---|---|---|
| 1 | setup で定義された **primitive 変数の最終値** | `executor.ts:50-59` は `typeof val === "object"` の変数のみ trackedKeys に入れる。number / string / boolean は post snapshot の対象外 | **低** — Selakovic パターンは collection 操作主体で、カウンタ変数等の primitive 変更は稀 |
| 2 | body で新規作成された **global 変数の値** | `external-observation.ts:50-54` は `new_globals` のキー集合のみ比較。値は比較しない | **中** — `var` 忘れ等の global リークはあるが、値の差まで問題になる例は少ない |
| 3 | body 同期終了**後**に実行される非同期タスク | sandbox は body 同期完了で観測打ち切り。`setTimeout` / `queueMicrotask` / 未解決 Promise の副作用は見えない | **低** — Selakovic パターンは同期コード主体 |
| 4 | `null` で初期化された変数の **null → object 変化** | `executor.ts:55` の `val !== null` により、setup で null の場合は trackedKeys に入らない。body で object 化されても pre snapshot が無く不完全 | **非常に低** — setup で null を置く使い方はほぼ無い |

#### 判断と対処

- **本論文の範囲では修正不要**: Selakovic dataset で穴 1〜4 が踏まれる頻度は低く、RQ1（C1〜C4 の ablation）と事前分析（10 パターン自動導出 ≈100%）の主張を脅かさない。等価性検証器は**研究成果ではなく中間ツール**なので、検出されるべき差異を取り逃さない限り研究は成立する
- **検証器を他研究で再利用する場合は拡張を検討**: 特に #1 (primitive tracking) と #2 (new_globals 値比較) は素直な拡張で塞げる。#3 の非同期対応は sandbox の大規模改修が必要
- **論文の妥当性の脅威には 1 行で明示**: `current-research.md` §妥当性の脅威に「等価性検証器の観測範囲は object/array mutation / 戻り値 / 例外 / console+globals key に限定される」旨を記載する
- **Future Work に予約**: 穴 1〜4 を塞いだ一般化検証器を候補として残す

---

## Pruning エンジン

第 1 段階 (構造パターン導出) の本体。`(slow, fast, setup)` トリプルから **ワイルドカード付きの最小構造パターン** を出力する。実装は `mb-analyzer/src/pruning/` 配下、ファイル単位の詳細は [`mb-analyzer/src/pruning/README.md`](../mb-analyzer/src/pruning/README.md)。**TS 側の公開 API (PruningInput / PruningResult / placeholders) の入出力契約**もそちらの §入出力契約 に集約。研究方針は [`current-research.md` §第 1 段階](current-research.md#第-1-段階-実行ベース-hydra-式-pruning) を参照。

### モジュール責務

| 領域 | 責務 |
|---|---|
| `engine.ts` | 公開 `prune` + 1 パス試行 `tryPruneCandidates`。Hydra 反復ループの本体 + mutate / revert (savepoint パターン) |
| `candidates.ts` | AST 走査 + ルール適用で候補列挙 (placeholder 除外 / whitelist / blacklist / FastSubtreeSet の 4 段フィルタ) |
| `rules/` | pruning の対象と戦略の宣言データ集 (whitelist / blacklist / replacement) |
| `ast/*` | Babel AST 汎用 toolbox (parser / inspect / diff)。pruning 固有の知識を持たない |

ファイル単位の詳細責務 / 依存方向 / 関連 ADR は [`mb-analyzer/src/pruning/README.md`](../mb-analyzer/src/pruning/README.md) に集約 (drift 面のローカル化)。

新しい placeholder kind を追加するときの drift 面は **`rules/whitelist.ts:WHITELIST_CATEGORIES` (型 → カテゴリ) と `rules/replacement.ts:REPLACEMENTS` (カテゴリ → placeholderKind + buildNode) の 2 ファイル**に集約してある。`buildNode` がカテゴリごとの「化かし方 (`ExpressionStatement(Identifier)` / `Identifier` / `StringLiteral` 生成)」を直接持つので、置換戦略の名前は引数 (string mode) として残らず、関数値として表現される。

### データフロー

`prune` は **2 段ループ構造**:

- **外側ループ (`prune`)**: AST が変わるたびに FastSubtreeSet と候補リストを再計算する。1 パスで 1 ノードが prune できれば AST を更新して次パスへ。
- **内側ループ (`tryPruneCandidates`)**: 現在の候補を size 降順で順に試し、**最初に成功した 1 候補で return**。残った候補は次パスで再列挙される。

```
PruningInput (slow, fast, setup, timeout_ms, max_iterations)
       ↓
    parse(slow) / parse(fast)                    ← ast/parser.ts
       ↓
    Phase 1: 初回等価性検証
    checkEquivalence(setup, slow, fast)
       ├─ not_equal → verdict = initial_mismatch で終了
       ├─ error     → verdict = error で終了
       └─ equal     ↓
    countNodes(slow) → node_count_before          ← ast/inspect.ts
       ↓
    Phase 2: 反復 pruning
  ┌─ 外側ループ: iterations < max_iterations かつ wall-time 内 ───────────┐
  │   FastSubtreeSet(fast)                    ← ast/subtrees.ts: 再計算    │
  │   enumerateCandidates(slow, diff)            ← candidates.ts          │
  │   候補が空 → 終了                                                      │
  │   ↓                                                                    │
  │ ┌─ 内側ループ tryPruneCandidates: size 降順に試行 ─────────────────┐ │
  │ │   replacementFor(node) → placeholderKind + buildNode             │ │
  │ │                                              ← rules/replacement │ │
  │ │     null (whitelist 外) → 次候補                                 │ │
  │ │   ↓                                                              │ │
  │ │   saved = readAt(parent, key, idx)         ← savepoint           │ │
  │ │   applyAt(parent, key, idx, buildNode(id)) ← mutate              │ │
  │ │   try {                                                          │ │
  │ │     generate(slow) → parse                 ← L3 round-trip       │ │
  │ │       throw → continue (finally で revert)                       │ │
  │ │     iterations += 1 ← ここで初めて budget を消費                 │ │
  │ │     checkEquivalence(setup, slow', fast)   ← L4 (Hydra 実行)     │ │
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

### 候補ノード決定の 4 段フィルタ

`enumerateCandidates` は以下の条件をすべて満たすノードに限定する。

| # | フィルタ | 目的 | 実装 |
|---|---|---|---|
| 1 | placeholder 自身の除外 | 前 iteration で挿入した `Identifier($Pn)` / `ExpressionStatement(Identifier($Pn))` を再候補化すると pruning ループが破綻するため除外 (ADR-0009) | `pruning/candidates.ts` の `isPlaceholderNode` |
| 2 | 型 whitelist | pruning 可能な AST 型 (Statement / Expression / Identifier の 3 分類) のみ残す。**`@babel/types` の Statement / Expression alias から自動導出** (ADR-0006) | `pruning/rules/whitelist.ts` の `WHITELIST_CATEGORIES` keys |
| 3 | 親子位置 blacklist | 親 field validator が置換後の型を受理しない位置を**文法由来で自動判定**し除外 (ADR-0005) | `pruning/rules/blacklist.ts` の `BLACKLIST_CATEGORIES` |
| 4 | AST 差分フィルタ | fast に同型ノードが存在する「共通ノード」のみに絞る (差分ノードは必須扱いで保護) | `pruning/ast/subtrees.ts` の `FastSubtreeSet.has` |

候補は **`end - start` 降順 (大きいノード優先)** でソートして返す (`candidates.ts:nodeSize`)。size 降順で試す方が、成功時に一度に縮む量が大きく、外側ループ反復数が減るという経験則。

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

1. `pruning/rules/whitelist.ts:PARSER_PLUGINS` に対応 plugin を追加 (例: `["typescript"]`)
2. (新カテゴリの場合のみ) `pruning/rules/replacement.ts:REPLACEMENTS` に「カテゴリ → placeholderKind + buildNode」を追加

L1 blacklist (ADR-0005) も alias-derived なので **plugin 追加に応じて自動で親子位置除外が効く** (再実装不要)。詳細は ADR-0006 §対象言語拡張で扱える dataset 例。

### 置換操作の粒度 (3 カテゴリ統一のワイルドカード化)

候補ノードのカテゴリで置換動作が 1:1 に決まる (`rules/replacement.ts:REPLACEMENTS`)。3 カテゴリすべてで「**`$Pn` という名前の placeholder で wildcard 化**」する点は共通だが、文法的に置換可能な型が異なるため出力 AST は別形になる。

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

外側ループは prune 成功のたびに `enumerateCandidates` を**再呼び出し**する (slow AST が変わったため、size 順や差分判定がやり直しになる)。成功時は `engine.ts` 内で `parse(generate(slow))` した reparsed AST に置き換えるので、新 AST のノード参照は完全に置き換わり、**前パスで失敗した候補が次パスで再試行される可能性がある** (構造的に同型なら blacklist / diff も再度通過する)。

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

L1 blacklist は `@babel/types` の `NODE_FIELDS[parent][key].validate` introspection (`oneOfNodeTypes` / `chainOf` / `NODE_UNION_SHAPES__PRIVATE`) から起動時 1 回だけ計算される (ADR-0005; `rules/blacklist.ts`)。ルールは 3 カテゴリ (statement / identifier / expression) 別に、親 × 子位置で自動生成される。

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

実装は `mb-analyzer/src/preprocessing/` (TS 抽出ロジック) + `mb_scanner/{domain,use_cases,adapters}/preprocessing/` (Python ラッパー)。Selakovic 2016 dataset の 1 issue を `(setup, slow, fast)` トリプルに変換するパイプラインの最前段。

論文非依存性が研究主張の核なので、本前処理器は **Selakovic 論文 §6 (10 パターン) / §7 (5 種 precondition T/NF/P/TF/V) を一切参照しない**。データセットの物理ファイル構造のみに依存して AST diff から minimal differential extraction する。

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
│   ast-diff.ts                │           │           ↓                     │
│   enclosure.ts               │           │ adapters/gateways/preprocessing/ │
│   setup-cleanup.ts           │           │   selakovic/                     │
│ (ドメイン非依存)               │           │     dataset_scanner.py (列挙)    │
│                              │           │     node_runner_gateway.py      │
│ preprocessing/selakovic/     │           │  (subprocess + JSONL parse)     │
│   layout.ts / client.ts /    │           └─────────────┬───────────────────┘
│   server.ts / index.ts       │  ←── stdin/stdout JSONL ─┘
│ (Selakovic 固有 = ドメイン)    │
│                              │
│ cli/preprocess-selakovic.ts  │ ←── stdin (1 入力 / JSONL バッチ)
│ (Node CLI エントリ)            │ ←── stdout (1 入力 → N 結果 JSONL)
└──────────────────────────────┘
```

**TS = AST 解析責務、Python = データセット列挙 + 並列化 + DB / JSONL I/O 責務** で切り分け。並列化は `ThreadPoolExecutor` で chunk 単位の subprocess を多重化する pruning と同パターン。

### 抽出アルゴリズム (論文非依存)

`extract(input)` は以下 5 ステップ:

1. **Layout 判定**: `v_*.html` / `<libname>_*/` (ディレクトリ) / `<libname>_*.js` (単一ファイル) の物理構造で 3 系統を判定 (詳細は [`clientServer フォールバック`](#clientserver-フォールバック))。内容構造規則 (`f1` / `init`/`setupTest`/`test`) には依存しない
2. **AST parse**: client は HTML 内 inline `<script>` を、server (multi-file) は `<libname>_*/` 配下の各 .js を、server (single-file) は `<libname>_*.js` 1 ファイルを Babel で parse
3. **Top-level statement の AST hash matching**: before/after の `Program.body` 各 statement について `canonicalHash` を計算し、greedy にハッシュ一致 pair を **matched (= 不変)** としてマーク。残りを **unmatched-before / unmatched-after** に分類
4. **Candidate enumeration**: unmatched-before と unmatched-after を順序対応で組合せ (`min(|U_b|, |U_a|)` ペア)。各ペアで `findChangedNodes` (top-down 最深 unmapped) → `findMinimalEnclosure` (3 段優先順位の候補型 LCA) を順に適用して、enclosure に到達できた組合せを candidate に加える
5. **結果出力**: candidate ごとに 1 つの `PreprocessingResult` を出力 (1 入力 → N 結果)

Step 3 の hash matching は GumTree top-down の簡略版。これにより before/after で statement 数が違うケース (デバッグ行追加・削除等) でも不変 statement を正しく除外して真の変更点だけを candidate にできる。

### enclosure 候補型の 3 段優先順位

`findMinimalEnclosure` (`preprocessing/common/enclosure.ts`) は changed_nodes の LCA から root に向かって 3 段の優先順位で候補型を探す:

| 段 | 候補型 | 想定する変更パターン | 例 |
|---|---|---|---|
| **1** | **関数/メソッド系**: FunctionDeclaration / FunctionExpression / ArrowFunctionExpression / ClassMethod / ObjectMethod | 関数 body 内の局所的最適化 | `var f1 = function () { ❶ };` |
| **2** | **ブロック系**: BlockStatement | 関数/メソッドではないがブロック内に閉じた変更 (if/for body 等) | `if (cond) { ❶ }` |
| **3 (改良 3)** | **Top-level statement 系**: VariableDeclaration / FunctionDeclaration / ClassDeclaration / ExpressionStatement | 関数全体の refactor、`module.exports = ...` 形式の代入式変更 | `module.exports = function (...) { ...大量変更... };` |

段 1, 2 は「**変更を内包する最も内側の構文単位**」を取る本来の minimal enclosure。段 3 は「LCA が関数/Block より外まで上昇するケース」(= 関数 body 全面 refactor / 代入式の右辺 refactor) を救済する fallback で、Selakovic の library 全面修正 (EJS の parse、Backbone の model 系) で頻出する。

段 3 採用時は slow/fast に top-level statement 全体が入るため、後段 pruning でその statement 全体の最小化が走る。**論文非依存性**: 候補型の追加は ECMAScript 文法レベルの一般概念のみで、Selakovic Table 4 / precondition には依存しない。threats to validity に「関数全体置換のような大規模 refactor は top-level statement 単位で抽出する」と明記する。

### 1 入力 → N 結果モデル

Selakovic データセットには **同一 PR に複数の独立した最適化が同居するケース**がある (例: socket.io 573 では `encodePacket` の switch case 順序入れ替え + `decodePacket` の if/else→switch 書き換えが同一 commit に含まれる)。

これに対応するため、`extract()` の戻り値を **`list[PreprocessingResult]`** に拡張:

| candidates 数 | 出力 | id 規則 |
|---|---|---|
| 0 (整形差分のみ) | 1 件 (excluded=NO_CHANGED_NODES) | `<input.id>` (suffix なし) |
| 0 (unmatched あり、enclosure 不成立) | 1 件 (excluded=MODULE_WIDE_CHANGE) | `<input.id>` |
| 1 | 1 件 (抽出成功) | `<input.id>` (suffix なし) |
| N (≥ 2) | N 件 (各 candidate 独立) | `<input.id>#0`, `<input.id>#1`, ... |
| 構造的失敗 (parse-error 等) | 1 件 (excluded) | `<input.id>` |

Python 側 Gateway は **prefix-match で id 突き合わせ**を行う (`<batch_key>` または `<batch_key>#X` 形式の全行を集める)。

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

### clientServer フォールバック

Selakovic データセットは 3 カテゴリ (clientIssues / serverIssues / clientServerIssues) でレイアウトが混在している:

| カテゴリ | 物理構造 | 最適化対象の所在 |
|---|---|---|
| **clientIssues** | `v_*.html` + `<libname>_*.js` (jsperf 用ライブラリスナップショット) | inline `<script>` 内 (`f1` 慣習で記述) |
| **serverIssues** | `<libname>_*/` ディレクトリ + `test_case_*.js` | `<libname>_*/index.js` 等 |
| **clientServerIssues** | `v_*.html` + `<libname>_*.js` 単一ファイル + `test_case_*.js` | `<libname>_*.js` 単一ファイル (inline script は jsperf 計測ハーネス) |

clientIssues と clientServerIssues は **物理構造がほぼ同一** で識別困難。`v_*.html` と `<libname>_*.js` の両方を持つ。判別の鍵は **「inline script に意味論的変更があるか」** という抽出時の動的判定:

```
1. v_*.html + <libname>_*.js (single-file) 共存を検出 (layout.detectLayout が両 path を保持)
2. 1 次抽出: client モードで inline script を AST diff
3. 1 次結果が all-excluded (= inline script に最適化が見つからない) なら:
4.   2 次抽出: server-single-file モードで <libname>_*.js を AST diff
5.   2 次結果に extracted が 1 件でも出れば採用 (clientServerIssues 救済)
6. 2 次でも空なら 1 次結果を返す
```

これは **論文非依存の物理構造ベース探索順序ルール**。threats to validity に「inline script に変更が見つからない場合のみ library 側を見る」と honest に書ける。Selakovic Table 4 / precondition への依存はない。

実測効果: clientServerIssues 28 件中 27 件 (96.4%) が fallback 経由で抽出成功。serverIssues / clientIssues も同じ判定ロジックで救済されるケースあり。

### 除外理由の意味論

`ExclusionReason` enum (`mb-analyzer/src/contracts/preprocessing-contracts.ts` ↔ `mb_scanner/domain/entities/preprocessing.py`) で 7 種を定義:

| reason | 意味 | 救済可能性 |
|---|---|---|
| `parse-error` | Babel parser が SyntaxError を throw | データ固有の特殊 syntax を扱う plugin 追加で部分救済可 |
| `no-changed-nodes` | 全 top-level statement が AST hash で matched (整形差分のみ) | 救済不要 (意味論変更なし) |
| `module-wide-change` | unmatched 残るが 3 段すべての enclosure 候補型 (関数/Block/top-level statement) に到達できない | 設計上ほぼ起きない (top-level statement で必ず救える) |
| `multi-file-change` | server 系で意味論変更が複数 .js ファイルにまたがる | 出力スキーマ拡張 (1 issue → 複数ファイル) で対応可、ただし保守的に除外 |
| `no-enclosure-candidate` | enclosure 抽出の内部不変違反 (通常起こらない) | bug fix 対象 |
| `layout-unknown` | `v_*.html` も `<libname>_*/` も `<libname>_*.js` も無いディレクトリ | データ固有、個別対応が必要 |
| `missing-files` | 期待ファイル欠落 / I/O 失敗 | データ固有、個別対応が必要 |

実測 (Selakovic 97 issue): 抽出成功 96 件 (99.0%)、`multi-file-change` 1 件のみ除外。threats to validity への記述方針: 各除外を **「データセット固有の限界として明示」** し、論文非依存性を主張する論理を保つ。

### 既知の運用上の落とし穴 (Node CLI の stdout flush)

`preprocess-selakovic` の出力は 1 issue あたり最大 100KB+ になる (改良 3 で top-level statement 全体が slow/fast に入るため)。Node の `process.exit()` を即座に呼ぶと **stdout が flush 完了前に exit して 64KB で truncate される** (macOS pipe バッファ境界)。Python subprocess.run 経由では結果消失として観測される。

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

旧実装 (`mb-analyzer/src/equivalence-checker/checker.ts`):

```ts
const message = e instanceof Error ? e.message : "unexpected non-Error thrown";
```

→ VM 内で `ReferenceError: angular is not defined` が throw されても `instanceof Error` が false で本来のメッセージが捨てられ、全件「unexpected non-Error thrown」として report されていた。

修正後 (duck typing):

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

なお `executor.ts` の `captureException` は元々 duck typing で実装されている (oracle 用の exception field キャプチャ)。本修正は **executor 外で起きる throw** (= setup の `vm.runInContext` 直接 throw) を outer try/catch で受ける際の同パターン適用。

### Selakovic データセットでの実測 (Phase 4.3 一次観測)

97 件の抽出済 issue (= 112 結果) に対する `check-equivalence-batch` 実行結果:

```
total: 112  equal: 15  not_equal: 0  error: 97
```

`error` 96 件 (1 件は別エラー) は **すべてフレームワーク / Node CommonJS / DOM / jsperf 計測ハーネスのグローバル識別子未定義**:

| 識別子 | 件数 | 種類 |
|---|---|---|
| `execute` | 34 | jsperf 計測ハーネス (`var a = execute(f1, 10)`) |
| `angular` | 19 | Angular |
| `require` | 19 | Node CommonJS |
| `Ember` | 7 | Ember.js |
| その他 | 17 | document / $ / exports / window / jQuery / _ / React / f1 |

これらは **抽出器のミスではなく VM sandbox 環境の制約**。本来両側 (slow/fast) が同じ throw → 等価判定すべきだが、現状は setup throw が全体 error verdict に畳まれる仕様。

対処: **Proxy-based undefined stub を VM sandbox に仕込む** (PR #5 で対応予定)。未定義 globalThis アクセスを「何でも吸収する stub」に自動置換し、両側で同じ動作にして等価判定を成立させる。本 PR スコープ外。
