# cli

mb-analyzer の subprocess エントリポイント。Python 側 Gateway (`mb_scanner/adapters/gateways/{equivalence,pruning}/node_runner_gateway.py`) が `node dist/cli.js <subcommand>` で起動し、stdin / stdout 経由で JSON / JSONL を交換する。

入出力データの意味論 (各フィールドの定義、verdict の解釈、placeholder の AST 形など) は engine モジュールの README を一次ソースとし、本 README には **CLI 固有の規約** (argv / stdin / stdout / stderr / 終了コード) のみ記述する。

| データ意味論の参照先 |
|---|
| equivalence 系: [`../equivalence-checker/README.md`](../equivalence-checker/README.md) |
| pruning 系: [`../pruning/README.md`](../pruning/README.md) |

## 全体構成

- `index.ts` の `SUBCOMMANDS` テーブルが `process.argv[2]` をハンドラ関数 (`() => Promise<number>`) に dispatch
- 未知のサブコマンドは exit 2 + stderr に Usage を出して終了
- ハンドラ関数の戻り値が exit code

`readStdin` / `parseInput` / `parseBatchLine` / `errorResult` は各サブコマンドファイル内に複製。共通化は実装した上で価値が見えてから (現状は重複 ~30 行 × 2 ファイルなので許容範囲)。

---

## `check-equivalence`

ハンドラ: `check-equivalence.ts:runCheckEquivalence`

### 引数
なし (`node dist/cli.js check-equivalence`)

### stdin
1 つの JSON object。

```jsonc
{
  "before": "string",          // 必須
  "after": "string",          // 必須
  "setup": "string",         // optional (default: "")
  "timeout_ms": 5000         // optional (default: engine の DEFAULT_TIMEOUT_MS = 5_000)
}
```

### stdout
1 つの JSON object (1 行 + 末尾改行)。`verdict` と `observations` を含む。詳細は [equivalence-checker/README.md](../equivalence-checker/README.md)。

### stderr
- stdin が JSON parse 失敗 / 非 object / 必須フィールド型違いのときに人間可読メッセージ

### 終了コード
| code | 条件 |
|---|---|
| 0 | `verdict === "equal"` |
| 1 | `verdict === "not_equal"` |
| 2 | `verdict === "inconclusive"` |
| 3 | parse 失敗 / 必須フィールド不足 / verdict=error |

---

## `check-equivalence-batch`

ハンドラ: `check-equivalence.ts:runCheckEquivalenceBatch`

### 引数
なし

### stdin
JSONL (1 行 1 トリプル)。

```jsonc
{"id": "case-1", "before": "...", "after": "...", "timeout_ms": 5000, "setup": "..."}
{"id": "case-2", "before": "...", "after": "...", "timeout_ms": 5000}
```

| フィールド | 規約 |
|---|---|
| `before` / `after` | 必須、string |
| `timeout_ms` | **必須**、有限 number。欠落は error verdict 行 |
| `id` | optional。あればエコーバック、無ければ出力でも欠落 |
| `setup` | optional |

`timeout_ms` を必須化したのは Python → Node のシリアライゼーション欠落で `timeout_ms` がサイレントに engine デフォルトへ fallback する事故を過去に踏んだため。

### stdout
JSONL (1 行 1 結果、**入力順**)。各結果は single と同じスキーマに `id` を加えたもの。1 行の error が後続行の処理を止めない (該当行を error verdict にして処理継続)。

### stderr
- stdin/stdout の I/O 失敗時のみ

### 終了コード
| code | 条件 |
|---|---|
| 0 | 全行処理完了 (各行の verdict は JSONL 内) |
| 2 | stdin/stdout I/O 失敗のみ |

---

## `prune`

ハンドラ: `prune.ts:runPrune`

### 引数
なし

### stdin
1 つの JSON object。

```jsonc
{
  "before": "string",          // 必須
  "after": "string",          // 必須
  "setup": "string",         // optional (default: "")
  "timeout_ms": 5000,        // optional (default: 5_000)
  "max_iterations": 1000     // optional (default: 1_000)
}
```

`timeout_ms × max_iterations` が pruning 全体の wall-time 上限になる ([pruning/README.md §試行回数と budget](../pruning/README.md))。

### stdout
1 つの JSON object (1 行 + 末尾改行)。`verdict` と verdict ごとに付与されるフィールド (`pattern_ast` / `pattern_code` / `placeholders` / `iterations` 等) を含む。詳細は [pruning/README.md](../pruning/README.md)。

### stderr
- stdin parse 失敗 / 非 object / 必須フィールド型違いのときに人間可読メッセージ

### 終了コード
| code | 条件 |
|---|---|
| 0 | `verdict === "pruned"` |
| 1 | `verdict === "initial_mismatch"` (before ≢ after 入力ミス) |
| 2 | parse 失敗 / 必須フィールド不足 / verdict=error (parse 失敗 / タイムアウト / setup runtime error) |

---

## `prune-batch`

ハンドラ: `prune.ts:runPruneBatch`

### 引数
なし

### stdin
JSONL (1 行 1 トリプル)。

```jsonc
{"id": "case-1", "before": "...", "after": "...", "timeout_ms": 2000, "max_iterations": 200}
{"id": "case-2", "before": "...", "after": "...", "timeout_ms": 2000}
```

| フィールド | 規約 |
|---|---|
| `before` / `after` | 必須、string |
| `timeout_ms` | **必須**、有限 number。欠落は error verdict 行 (`check-equivalence-batch` と同じ理由) |
| `max_iterations` | optional、有限 number。型違いは error verdict 行 |
| `id` | optional。あればエコーバック、無ければ出力でも欠落 |
| `setup` | optional |

### stdout
JSONL (1 行 1 結果、**入力順**)。各結果は single と同じスキーマに `id` を加えたもの。1 行の error が後続行の処理を止めない。

### stderr
- stdin/stdout の I/O 失敗時のみ

### 終了コード
| code | 条件 |
|---|---|
| 0 | 全行処理完了 |
| 2 | stdin/stdout I/O 失敗のみ |

---

## 並列化方針

**TS 側は 1 subprocess = stateless 逐次** に徹する。`Promise.all` / `worker_threads` は使わない。

並列化は Python `ThreadPoolExecutor` 側で **多重 subprocess を起動** する形で実現:

```
Python:  ThreadPoolExecutor(max_workers=N) ─┬─ subprocess 1: node cli.js prune-batch (chunk 1 を逐次)
                                            ├─ subprocess 2: node cli.js prune-batch (chunk 2 を逐次)
                                            └─ ...
```

この設計の根拠:
- engine の `prune()` / `checkEquivalence()` は副作用を持たず各呼び出しが独立 (mutate + revert / savepoint パターン)。Python から N 並列 subprocess で叩いても汚染なし
- subprocess 起動コストは小さくないため、各 subprocess で chunk 内逐次処理する方が `tsx` 的な毎回起動より効率的
- TS 側で並列化を入れると CPU bound (Babel parse) と I/O 待ち (`vm.runInNewContext` の timeout) が混在して timeout 算出が複雑化。Python 側に閉じ込めることで責務分離

詳細は `mb_scanner/adapters/cli/{equivalence,pruning}.py:_run_batch` (`_chunked` で分割 → `as_completed` で完了順回収 → 入力順再結合) 参照。

## ファイル一覧

```
src/cli/
├── index.ts               ← SUBCOMMANDS dispatcher (entry point、build.mjs の bundle 起点)
├── check-equivalence.ts   ← runCheckEquivalence / runCheckEquivalenceBatch
└── prune.ts               ← runPrune / runPruneBatch
```

## ビルド

`mise run build-analyzer` (内部で `node build.mjs`) が `src/cli/index.ts` を esbuild bundle (esm / target node22) して `dist/cli.js` を生成する。Babel 系の依存も全部 inline されるため、本番では `dist/cli.js` 1 ファイルだけ Node に渡せば動く。
