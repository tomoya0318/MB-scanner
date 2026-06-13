# cli

> 生成物 — 手編集禁止 (ADR-0029)。再生成: `/generate-approach-spec mb-analyzer/src/cli`
> 生成時コミット: `d122da9` (2026-06-13)

mb-analyzer の subprocess エントリポイント。Python 側 Gateway (`mb_scanner/adapters/gateways/{equivalence,pruning}/node_runner_gateway.py`、`mb_scanner/adapters/gateways/preprocessing/selakovic/node_runner_gateway.py`) が `node dist/cli.js <subcommand>` で起動し、stdin / stdout 経由で JSON / JSONL を交換する。

入出力データの意味論 (各フィールドの定義、verdict の解釈、placeholder の AST 形、除外理由の分類など) は各 engine モジュールの README を一次ソースとし、本 README には **CLI 固有の規約** (argv / stdin / stdout / stderr / 終了コード) のみ記述する。

| データ意味論の参照先 |
|---|
| equivalence 系: [`../equivalence-checker/README.md`](../equivalence-checker/README.md) |
| pruning 系: [`../pruning/README.md`](../pruning/README.md) |
| preprocessing 系: [`../preprocessing/README.md`](../preprocessing/README.md) |

## 全体構成 (dispatcher)

- `index.ts` の `SUBCOMMANDS` テーブル (6 サブコマンド) が `process.argv[2]` をハンドラ関数 (`() => Promise<number>`) に dispatch する (`index.ts:6-13`, `index.ts:16-26`)
- 未知 / 未指定のサブコマンドは stderr に Usage を出して exit 2 (`index.ts:17-24`)
- ハンドラ関数の戻り値がそのまま exit code (`index.ts:25-26`, `index.ts:47-51`)
- ハンドラが throw した場合は stderr に `Fatal: <message>` を出して exit 2 (`index.ts:53-57`)
- `process.exit()` の前に stdout / stderr の `drain` を await して flush する。pipe 出力で 64KB 超の stdout が truncate される事故 (preprocess-selakovic が 1 issue から 100KB+ を返すケース) への対策 (`index.ts:29-51`)

`readStdin` / `parseInput` / `parseBatchLine` は 3 サブコマンドファイルに、`errorResult` ヘルパは check-equivalence / prune の 2 ファイルに複製されている (共通化はしていない)。

---

## `check-equivalence`

ハンドラ: `runCheckEquivalence` (`check-equivalence.ts:80`)

### 引数
なし (`node dist/cli.js check-equivalence`)

### stdin
1 つの JSON object。

| フィールド | 規約 |
|---|---|
| `before` / `after` | **必須**、string (`check-equivalence.ts:56-57`) |
| `setup` | optional、string (`check-equivalence.ts:60-63`) |
| `timeout_ms` | optional、有限 number。省略時は engine 側 default (`check-equivalence.ts:64-69`) |
| `environment` | optional、`"vm"` \| `"jsdom"`。`null` は未指定扱い (`check-equivalence.ts:70-74`, ADR-0012) |
| `module_base_dir` / `mount_html` / `workload` | optional、string。`null` は未指定扱い (`check-equivalence.ts:14`, `check-equivalence.ts:16-27`) |

`id` は単発モードでは受理しない (echo もされない)。

### stdout
1 つの JSON object (1 行 + 末尾改行) — `EquivalenceCheckResult` (`verdict` / `observations` / `verdict_reason` / `error_message` / `effective_timeout_ms`、`contracts/equivalence-contracts.ts:99-114`)。意味論は [`../equivalence-checker/README.md`](../equivalence-checker/README.md)。

### stderr
- stdin の JSON parse 失敗 / 非 object / フィールド型違いのときに人間可読メッセージ 1 行 (`check-equivalence.ts:83-85`)

### 終了コード (`check-equivalence.ts:29-33`, `check-equivalence.ts:91-94`)
| code | 条件 |
|---|---|
| 0 | `verdict === "equal"` |
| 1 | `verdict === "not_equal"` |
| 2 | `verdict === "inconclusive"` (ADR-0018 で追加された保守的 verdict) |
| 3 | stdin parse 失敗 / `verdict === "error"` (どちらも「使える verdict が出せなかった」として統一) |

Python 側 Gateway は `{0, 1, 2, 3}` を許容集合とする (`gateways/equivalence/node_runner_gateway.py:76`)。

---

## `check-equivalence-batch`

ハンドラ: `runCheckEquivalenceBatch` (`check-equivalence.ts:160`)

### 引数
なし

### stdin
JSONL (1 行 1 トリプル、空行は無視)。

| フィールド | 規約 |
|---|---|
| `before` / `after` | **必須**、string (`check-equivalence.ts:117-118`) |
| `timeout_ms` | **必須**、有限 number。欠落 / 不正は error verdict 行 (`check-equivalence.ts:119-124`) |
| `id` | optional、string。あれば出力行にエコーバック (`check-equivalence.ts:115`, `check-equivalence.ts:131`) |
| `setup` | optional、string (`check-equivalence.ts:132-135`) |
| `environment` | optional、`"vm"` \| `"jsdom"` (`check-equivalence.ts:136-140`) |
| `module_base_dir` / `mount_html` / `workload` | optional、string (`check-equivalence.ts:141-142`) |

`timeout_ms` を batch でのみ必須化したのは、Python → Node の受け渡しで `timeout_ms` が落ちて engine default にサイレントフォールバックした過去の事故への対策 (`check-equivalence.ts:97-100`)。

### stdout
JSONL (1 行 1 結果、**入力順**)。行単位の parse 失敗は `{"verdict": "error", "verdict_reason": "executor-error", ...}` 行にして処理を継続する (ADR-0018 の分類に合わせる、`check-equivalence.ts:146-158`)。

### stderr
- stdin の読み取り失敗時のみ (`check-equivalence.ts:164-166`)

### 終了コード (`check-equivalence.ts:34-35`, `check-equivalence.ts:184`)
| code | 条件 |
|---|---|
| 0 | 全行処理完了 (各行の verdict は JSONL 内) |
| 2 | stdin の読み取り失敗のみ |

---

## `prune`

ハンドラ: `runPrune` (`prune.ts:117`)

### 引数
なし

### stdin
1 つの JSON object。

| フィールド | 規約 |
|---|---|
| `before` / `after` | **必須**、string (`prune.ts:94-95`) |
| `setup` | optional、string (`prune.ts:98-101`) |
| `timeout_ms` | optional、**整数** かつ `[1, 60000]` (`prune.ts:17-18`, `prune.ts:22-30`, `prune.ts:102-106`) |
| `max_iterations` | optional、**整数** かつ `[1, 100000]` (`prune.ts:19-20`, `prune.ts:32-40`, `prune.ts:107-111`) |
| `environment` | optional、`"vm"` \| `"jsdom"`。`null` は未指定扱い (`prune.ts:42`, `prune.ts:57-65`) |
| `module_base_dir` / `mount_html` | optional、string。`null` は未指定扱い (`prune.ts:43`, `prune.ts:66-71`) |

値域チェックは Python 側 contract (`mb_scanner.domain.entities.pruning`) との整合用 — 弾かないと 0 / 負 / 小数の `max_iterations` で engine がループをスキップして silently `pruned` を返す (`prune.ts:14-16`)。`environment` / `module_base_dir` / `mount_html` は pruning 本体が解釈しない pass-through で、内部の等価検証にそのまま渡る (`prune.ts:45-55`)。

契約型 `PruningInput` には `workload` フィールドが定義されているが (`contracts/pruning-contracts.ts:51-57`)、prune CLI の parse (`prune.ts:83-115`, `prune.ts:137-179`) は **`workload` を転記しない** (受理フィールドは上表が全て)。

`id` は単発モードでは受理しない。

### stdout
1 つの JSON object (1 行 + 末尾改行) — `PruningResult` (`verdict` / `pattern_ast` / `pattern_code` / `placeholders` / `iterations` / `node_count_initial` / `node_count_pruned` / `effective_timeout_ms` / `error_message`、`contracts/pruning-contracts.ts:60-71`)。意味論は [`../pruning/README.md`](../pruning/README.md)。

### stderr
- stdin の JSON parse 失敗 / 非 object / フィールド型・値域違いのときに人間可読メッセージ 1 行 (`prune.ts:120-122`)

### 終了コード (`prune.ts:8-10`, `prune.ts:128-130`)
| code | 条件 |
|---|---|
| 0 | `verdict === "pruned"` |
| 1 | `verdict === "initial_mismatch"` |
| 2 | stdin parse 失敗 / `verdict === "error"` |

**check-equivalence (0-3 の 4 値) と体系が異なる** — prune は 0-2 の 3 値。Python 側 Gateway は `{0, 1, 2}` を許容集合とする (`gateways/pruning/node_runner_gateway.py:82`)。

---

## `prune-batch`

ハンドラ: `runPruneBatch` (`prune.ts:190`)

### 引数
なし

### stdin
JSONL (1 行 1 トリプル、空行は無視)。

| フィールド | 規約 |
|---|---|
| `before` / `after` | **必須**、string (`prune.ts:153-154`) |
| `timeout_ms` | **必須**、整数 `[1, 60000]`。欠落 / 不正は error verdict 行 (`prune.ts:155-159`) |
| `max_iterations` | optional、整数 `[1, 100000]` (engine が default を解決、`prune.ts:171-175`) |
| `id` | optional、string。あれば出力行にエコーバック (`prune.ts:151`, `prune.ts:166`) |
| `setup` | optional、string (`prune.ts:167-170`) |
| `environment` / `module_base_dir` / `mount_html` | optional (単発と同じ、`prune.ts:176-177`) |

`timeout_ms` 必須化の理由は check-equivalence-batch と同じ (`prune.ts:133-136`)。`workload` は転記しない (単発と同じ)。

### stdout
JSONL (1 行 1 結果、**入力順**)。行単位の parse 失敗は `{"verdict": "error", "error_message": ...}` 行にして処理を継続する (`prune.ts:181-188`, `prune.ts:200-212`)。

### stderr
- stdin の読み取り失敗時のみ (`prune.ts:194-196`)

### 終了コード (`prune.ts:11-12`, `prune.ts:214`)
| code | 条件 |
|---|---|
| 0 | 全行処理完了 |
| 2 | stdin の読み取り失敗のみ |

---

## `preprocess-selakovic`

ハンドラ: `runPreprocessSelakovic` (`preprocess-selakovic.ts:176`)

Selakovic dataset の 1 issue ディレクトリを前処理して candidate 群を返す。1 入力 → 1 `PreprocessingIssueResult` モデル (ADR-0024、`preprocess-selakovic.ts:27-34`)。ファイル I/O (レイアウト判定 / HTML・lib・test_case 読み込み) は CLI 層に閉じ、`preprocess()` 本体は文字列のみ受け取る純関数に保つ (`preprocess-selakovic.ts:33`, `preprocess-selakovic.ts:85-164`)。

### 引数
なし

### stdin
1 つの JSON object。

| フィールド | 規約 |
|---|---|
| `issue_dir` | **必須**、string (issue ディレクトリのパス、`preprocess-selakovic.ts:55`) |
| `id` | optional、string。`null` は未指定扱い。あれば出力にエコーバック (`preprocess-selakovic.ts:57-60`, `preprocess-selakovic.ts:166-170`) |

### stdout
1 行の JSON — `PreprocessingIssueResult` (`candidates` / `candidate_count` / `issue_excluded` / `issue_excluded_detail` / `issue_meta`、`contracts/preprocessing-contracts.ts:74-82`)。出力は batch と合わせて **常に JSONL 形式 (1 issue = 1 行)** で統一 (`preprocess-selakovic.ts:29-30`)。

issue 単位の失敗は exit code ではなく結果 JSON の `issue_excluded` で表現する:
- レイアウト判定不能 → `issue_excluded: "layout-unknown"` (`preprocess-selakovic.ts:88-101`)
- ファイル読み込み失敗 → `issue_excluded: "missing-files"` (`preprocess-selakovic.ts:104-119`)

### stderr
- stdin の JSON parse 失敗 / フィールド型違いのときに人間可読メッセージ 1 行 (`preprocess-selakovic.ts:179-182`)
- client layout で `<script src>` の依存が解決できなかったときの警告行 `[preprocess-selakovic] <dir>: unresolved <script src> deps: ...` (処理は継続、`preprocess-selakovic.ts:137-140`)

### 終了コード (`preprocess-selakovic.ts:22-23`, `preprocess-selakovic.ts:176-187`)
| code | 条件 |
|---|---|
| 0 | 結果を 1 行出力した (issue_excluded 付きの除外結果も含む) |
| 2 | stdin parse 失敗 / フィールド型違い |

**verdict 連動の exit code を持たない** — check-equivalence / prune とここが異なる。Python 側 Gateway は `0` のみを成功とする (`gateways/preprocessing/selakovic/node_runner_gateway.py:80`)。

---

## `preprocess-selakovic-batch`

ハンドラ: `runPreprocessSelakovicBatch` (`preprocess-selakovic.ts:222`)

### 引数
なし

### stdin
JSONL (1 行 1 issue、空行は無視)。フィールドは単発と同じ (`issue_dir` 必須 / `id` optional、`preprocess-selakovic.ts:194-220`)。

### stdout
JSONL (1 行 1 `PreprocessingIssueResult`、**入力順**)。行単位の parse 失敗は `issue_excluded: "layout-unknown"` + `issue_excluded_detail` にエラーメッセージを入れた結果行にして処理を継続する (`preprocess-selakovic.ts:234-249`)。

### stderr
- stdin の読み取り失敗時 (`preprocess-selakovic.ts:226-229`) と、単発と同じ unresolved deps 警告

### 終了コード (`preprocess-selakovic.ts:24-25`, `preprocess-selakovic.ts:255`)
| code | 条件 |
|---|---|
| 0 | 全行処理完了 |
| 2 | stdin の読み取り失敗のみ |

---

## 終了コード体系の比較

| subcommand | 0 | 1 | 2 | 3 |
|---|---|---|---|---|
| `check-equivalence` | equal | not_equal | inconclusive | error / parse 失敗 |
| `prune` | pruned | initial_mismatch | error / parse 失敗 | — |
| `preprocess-selakovic` | 出力成功 (除外含む) | — | parse 失敗 | — |
| `*-batch` (3 種共通) | 全行処理完了 | — | stdin I/O 失敗 | — |
| dispatcher (`index.ts`) | — | — | 未知 subcommand / Fatal | — |

## 並列化方針

**TS 側は 1 subprocess = stateless 逐次** に徹する。batch ハンドラは行を `for` ループで順次 `await` するだけで、`Promise.all` / `worker_threads` は使わない (`check-equivalence.ts:170-182`, `prune.ts:200-212`, `preprocess-selakovic.ts:231-253`)。

並列化は Python 側 `ThreadPoolExecutor` が **多重 subprocess を起動** する形で実現する:

```
Python: ThreadPoolExecutor(max_workers=N) ─┬─ subprocess 1: node dist/cli.js <x>-batch (chunk 1 を逐次)
                                           ├─ subprocess 2: node dist/cli.js <x>-batch (chunk 2 を逐次)
                                           └─ ...
```

実装は `mb_scanner/adapters/cli/{equivalence,pruning,preprocessing}.py` の `_run_batch` (`_chunked` で分割 → `as_completed` で完了順回収 → 入力順に再結合): `equivalence.py:161`, `pruning.py:182`, `preprocessing.py:147`。batch サブコマンドが「行単位エラーを exit code でなく JSONL 行に畳んで常に 0 で終わる」設計なのは、この多重起動で Gateway が `returncode != 0` を subprocess 異常としてのみ扱えるようにするため (`gateways/equivalence/node_runner_gateway.py:164`, `gateways/pruning/node_runner_gateway.py:170`, `gateways/preprocessing/selakovic/node_runner_gateway.py:156`)。

## ファイル一覧

```
src/cli/
├── index.ts                  ← SUBCOMMANDS dispatcher (entry point、build.mjs の bundle 起点)
├── check-equivalence.ts      ← runCheckEquivalence / runCheckEquivalenceBatch
├── prune.ts                  ← runPrune / runPruneBatch
├── preprocess-selakovic.ts   ← runPreprocessSelakovic / runPreprocessSelakovicBatch (+ layout 判定とファイル I/O)
└── README.md                 ← 本ファイル (生成物)
```

## ビルド

`mise run build-analyzer` (`.mise.toml:141-147`) が `pnpm --prefix mb-analyzer install --prefer-offline` → `pnpm run build` (= `node build.mjs`、`package.json:11`) を実行し、`src/cli/index.ts` を esbuild で bundle (esm / target node22) して `dist/cli.js` を生成する (`build.mjs:9-35`)。

- `vm` / `jsdom` は external — jsdom が fs リソースを `__dirname` 相対で読むため bundle せず、実行時に `node_modules` から require する (`build.mjs:16-18`)。`dist/cli.js` 1 ファイル + `node_modules` の jsdom で動く
- in-source test (`import.meta.vitest`) は `define` + `minifySyntax` で DCE される (`build.mjs:19-24`, ADR-0007)

## 関連 ADR

| ADR | CLI への影響 |
|---|---|
| ADR-0018 | `inconclusive` verdict の追加と保守的 verdict 合成 → check-equivalence の exit 0-3 体系、batch エラー行の `verdict_reason: "executor-error"` 分類 |
| ADR-0023 | placeholder substitution + 4 値契約 → `workload` フィールド (check-equivalence は受理、prune は非転記) |
| ADR-0024 | preprocess contract の base / adapter 分離 + issue 階層化 → 1 入力 = 1 `PreprocessingIssueResult`、出力の JSONL 統一 |
| ADR-0012 | 実行環境 `vm` / `jsdom` の 2 値 → `environment` フィールドの値域 |
| ADR-0007 | in-source testing → build 時の `import.meta.vitest` DCE |
| ADR-0029 | 本 README 自体の生成型運用 |
