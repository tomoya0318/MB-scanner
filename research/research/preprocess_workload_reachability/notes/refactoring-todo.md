# 0022 関連 refactoring TODO (v2 完了後の整備タスク)

`migration-plan.md` Phase 2 (v2 placeholder substitution) が完了してから着手する整備タスクをまとめる。本タスク (`__HOLE__` v1 → placeholder v2) の本筋とは独立だが、Selakovic-specific の workflow を毎セッション手で組み立てるコストを減らす整理。

---

## 背景 (Phase 5 で気づいた運用課題)

毎回 brain-2 で以下を回しているが、4 つの「臨時スクリプト」が `tmp/` に散っていて、見通しが悪い:

```
[1] preprocess-selakovic-batch    → extracted.jsonl
[2] tmp/0022_/build_inputs.py     → equiv-input.jsonl    ← 臨時
[3] check-equivalence-batch       → equiv-results.jsonl
[4] tmp/0022_/build_prune_input.py → prune-input.jsonl    ← 臨時
[5] prune-batch                   → prune-results.jsonl
[6] tmp/0022_/summarize.py        → stdout (集計)         ← 臨時
[7] tmp/0022_/jsonl_to_json.py    → *.json                ← 臨時
```

4 つの臨時スクリプトは「再利用可能な正規ロジック」で、`tmp/` に置くのは誤り:

| スクリプト | やってること | 本来の置き場所 |
|------------|--------------|---------------|
| `build_inputs.py` | extracted → equiv-input への projection (kind フィルタ / `module_base_dir`・`mount_html` 補完 / `timeout_ms` 設定 / 不要 field 除去) | パイプライン CLI の中間ステップ or `research/.../code/` |
| `build_prune_input.py` | equiv-results → prune-input への projection (`verdict=equal` フィルタ / `setup` 長で `max_iterations` を big/small 振り分け) | 同 |
| `summarize.py` | 削減率 median / cap-hit 比 / 0019/0021 比較 | `research/.../code/` (inspection) |
| `jsonl_to_json.py` | jsonl → 配列 json + `verdict=error` サブセット抽出 | `mise run convert-jsonl` (jq 経由) |

---

## 案 A: デフォルト dataset の解決順序を 1 箇所に集約

**目的**: 毎回 `--dataset data/selakovic-2016-issues` を打つ手間を消す。

**実装方針**: `mb_scanner/adapters/cli/preprocessing.py` のモジュール先頭に定数を置き、3 段 fallback で解決:

```python
DEFAULT_SELAKOVIC_DATASET = Path("data/selakovic-2016-issues")   # repo 相対

def _resolve_dataset(explicit: Path | None) -> Path:
    if explicit is not None:
        return explicit
    env = os.environ.get("MBS_SELAKOVIC_DATASET")
    if env:
        return Path(env)
    return DEFAULT_SELAKOVIC_DATASET
```

`preprocess-selakovic-batch --dataset` を optional に。

**工数**: 0.2 日 (Python 1 ファイル変更 + test)

---

## 案 B: 「中間 projection」を本体 CLI に取り込む

### B-b1: preprocess 出力に `module_base_dir` / `mount_html` を詰める

**現状**: `build_inputs.py` が extracted.jsonl の `id` から `issue_dir` を再構成して `module_base_dir`/`mount_html` を補完している。

**問題**: preprocess は既に `issue_dir` を知っているので、出力に詰めるべき。`mount_html` は `v_before.html` の中身を読んで詰める。

**実装**:
- `mb-analyzer/src/preprocessing/selakovic/pipeline.ts` の `preprocessClient` で、aspect 分岐の前後で `module_base_dir` (= issue dir) を計算して `PreprocessingResult` に詰める
- `mount_html` は embedded (`single`/`lib`/`body`) 候補に限定して詰める (changed-fn は self-contained なので不要)
- `mb-analyzer/src/contracts/preprocessing-contracts.ts` に `module_base_dir?: string` / `mount_html?: string` 追加
- Python paired-change

**工数**: 0.5 日 (TS + Python contracts + 既存テスト調整)

### B-b2: `check-equivalence-batch` に `--kinds` / `--timeout-ms` flag

**現状**: `build_inputs.py` が `candidate_kind ∈ {changed-fn, body}` のフィルタを手で実装している。

**実装**:
- `mb-analyzer/src/cli/check-equivalence.ts` (or 同等) に `--kinds changed-fn,body` (default = 全 kind) と `--timeout-ms` flag を追加
- batch CLI が extracted.jsonl をそのまま `--input` に受け付けて、内部で kind 絞り込み + timeout_ms 設定
- `build_inputs.py` 廃止 (= `research/.../code/` 経由でも不要)

**工数**: 0.3 日

### B-b3: `prune-batch` に `--from-equiv-results` flag

**現状**: `build_prune_input.py` が equiv-results を読んで verdict 絞り込み + big/small 振り分けして prune-input を作っている。

**実装** (2 案):
- (i) `prune-batch --from-equiv-results equiv-results.jsonl --equiv-input equiv-input.jsonl` の **2 入力モード**: equiv-results.jsonl は verdict / id だけ持つ、setup/slow/fast は equiv-input から
- (ii) `equiv-batch` 側で「equiv-results に元 input をマージして出力する `--include-input` flag」を追加 → `prune-batch --from-equiv-results` は 1 入力で済む
- どちらにせよ `--verdicts equal` / `--big-setup-threshold 500000` / `--max-iter-big 50` / `--max-iter-small 5000` flag を `prune-batch` に追加

**工数**: 0.7 日 (どちらの案でも)

### 移行後の brain-2 手順

```bash
cd /home/tomoya-n/workspace && W=out/selakovic-$(date +%Y%m%d) && mkdir -p "$W"

# preprocess (--dataset 省略、定数で resolve)
uv run mbs preprocess-selakovic-batch --output "$W/extracted.jsonl"

# equiv (kind フィルタ + projection を batch CLI 側で吸収)
uv run mbs check-equivalence-batch \
  --input "$W/extracted.jsonl" --output "$W/equiv-results.jsonl" \
  --kinds changed-fn,body --timeout-ms 15000 --workers -1

# prune (equiv-results を直接食う + verdict/iter フィルタ)
uv run mbs prune-batch \
  --from-equiv-results "$W/equiv-results.jsonl" --output "$W/prune-results.jsonl" \
  --verdicts equal --big-setup-threshold 500000 --max-iter-big 50 --max-iter-small 5000 \
  --workers -1 --batch-size 1

# 集計 (研究 dir で)
uv run python -m research.preprocess_workload_reachability.code.summarize \
  --equiv "$W/equiv-results.jsonl" --prune "$W/prune-results.jsonl"

# (ローカルに戻した後) jsonl → json 変換
mise run convert-jsonl tmp/.../equiv-results.jsonl
```

---

## 案 C: jq + mise + research/ 整理

### C-1: `mise run convert-jsonl` task を追加

**目的**: `jsonl_to_json.py` を廃止して jq 1 行に。

**`mise.toml` 追記**:
```toml
[tasks.convert-jsonl]
description = "JSONL を配列 JSON に変換 (jq 経由)"
usage = "mise run convert-jsonl <file>"
run = '''
set -euo pipefail
[ -n "${1:-}" ] || { echo "usage: mise run convert-jsonl <file.jsonl>" >&2; exit 1; }
jq -s '.' "$1" > "${1%.jsonl}.json"
echo "wrote ${1%.jsonl}.json"
'''

[tasks.filter-errors]
description = "JSONL から verdict=error の行だけ抜き出して JSON 配列に"
usage = "mise run filter-errors <file>"
run = '''
jq -s 'map(select(.verdict == "error"))' "$1" > "${1%.jsonl}-errors.json"
'''
```

**工数**: 0.1 日

### C-2: `research/research/preprocess_workload_reachability/` の整備

**前提**: `migration-plan.md` Phase 1 PR-3 で初期構造は作成済 (`code/_common.py` / `summarize.py` 等)。

**v2 完了後の追加整備**:
- `code/compare_v1_v2.py` ← v1 (`__HOLE__`) と v2 (placeholder) の reduction rate / error 内訳の比較
- `reports/comparison.md` ← v1 vs v2 の数字を表で
- `reports/v2-summary.md` ← v2 の Phase D-γ 結果清書

**工数**: 0.5 日

### C-3: `_common.py` (JSONL I/O 共有 utils)

別 worktree (`feat/pruning-analysis`) の `research/research/pruning/code/_common.py` を参考に:
- `load_extracted(path)` / `load_equiv_results(path)` / `load_prune_results(path)`
- `join_records(extracted, equiv, prune)` ← id でマージ
- AST utils (`strip_locations` / `renumber_placeholders` / `canonical_hash`) ← 必要に応じて

**工数**: 0.3 日

---

## 別 TODO (本タスクから派生)

| # | 内容 | 工数 |
|---|------|------|
| 1 | dep-vendoring + executor の `<script src>` 順 load (Phase 3 の正式化) | (済) |
| 2 | `prune` のメモリリーク修正 (= `prune` を数百 iter 回すと vm context 解放漏れで OOM) | 中 (3-5 日) |
| 3 | equivalence-checker oracle の堅牢性 (argument_mutation Ember 系) | (済 = 2026-05-12 fix) |
| 4 | equivalence-checker sandbox 堅牢性 (throw で worker を殺さない) | 中 (2-3 日) |
| 5 | preprocess の DROP 理由可視化 (= 案 D) | placeholder v2 D-γ で実施予定 |
| 6 | 観測形の改善 (call-trace 観測形 = 戻り値でなく変更関数が呼ぶ lib 関数列を記録) | v2 で部分対応、完全版は v3 |
| 7 | dynamic-coverage escalation の実装 (Phase 2 v2) | 大 (5-7 日) |
| 8 | angular の `buildAngularRunnable` を placeholder 対応に | placeholder v2 D-γ 派生で実施予定 |
| 9 | server 系の changed-fn 対応 | 大 (5-7 日) |
| 10 | 過去 ADR の `(setup, body)` 表記 sweep | 0.1 日 |

### #10 詳細

D-β 着手前の executor 周辺リファクタ PR (= `tmp/0001_executor-intent-refactor/`) で `executeSandboxed({ setup, body })` → `{ setup, workload }` に API リネームしたが、過去 ADR の説明テキストに残った `(setup, body, timeout)` 表記 2 箇所は本 PR スコープ外として残置。

対象:
- `ai-guide/adr/0012-equivalence-checker-execution-environment.md:67` — Playwright 側の `(setup, body)` 表記
- `ai-guide/adr/0015-equivalence-checker-layering-and-dom-oracle.md:75` — `(setup, body, timeout)` 表記

性質: 過去 ADR の改訂で、API リネームと別軸 (= drift 修復目的)。本 PR と分離した方が PR の意図 (= executor 周辺の意図表現リファクタ) がぶれず、レビューもしやすい。

実装: 各 ADR の該当 1 行を `(setup, workload, timeout)` に書き換える + ADR 末尾に「2026-MM-DD: API 名 `body` → `workload` リネーム (ADR-0023) に追従して文中表記を更新」を Status コメントで残す。

---

## 工数サマリ

| 案 | 工数 |
|----|------|
| A (dataset default) | 0.2 日 |
| B-b1 (preprocess に module_base_dir/mount_html 詰める) | 0.5 日 |
| B-b2 (`check-equivalence-batch --kinds`) | 0.3 日 |
| B-b3 (`prune-batch --from-equiv-results`) | 0.7 日 |
| C-1 (mise convert-jsonl) | 0.1 日 |
| C-2 (research/ 整備) | 0.5 日 |
| C-3 (_common.py) | 0.3 日 |
| **合計** | **2.6 日** |

着手順序: **A → C-1 → C-3 → C-2 → B-b1 → B-b2 → B-b3** (= 影響範囲の小さい順)

---

## 着手タイミング

`migration-plan.md` Phase 2 (v2 placeholder substitution) **完了後**。理由: v2 で `assemble/changed-fn.ts` / `function-hole.ts` / 契約が大きく変わるので、CLI flag 設計はそれを踏まえて行う方が合理的。

例外: **A (dataset default) と C-1 (mise convert-jsonl)** は v2 の作業中でも独立で入れられるので、v2 D-α と並行で取り込む選択肢あり。
