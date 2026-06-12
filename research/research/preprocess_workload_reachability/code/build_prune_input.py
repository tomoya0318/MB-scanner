#!/usr/bin/env python3
"""equiv-results.jsonl から pruning 対象 (verdict == equal) を取り出して prune-batch 用の入力を作る (0022 版)。

0021 版との違い:
- candidate_kind の絞り込みは `build_inputs.py` で済 (= ここに来るのは {changed-fn, body} だけ)。
- 「重い候補」の判定を `before` 長 → **`setup` 長** に変更 (changed-fn の `setup` は Ember 級 lib 全文 + 依存 lib で巨大。
  1 iter ごとに lib bootstrap が走るので、`setup` がデカい候補は max_iterations を控えめにする。`before` は changed-fn でも小さい)。
- `timeout_ms` を per-iter 用の小さい値 (3000) に上書き (equiv-input は 15000 を持ってるが、prune の 1 iter 用には別)。
- 当面 **equal-only** (C2 — `inconclusive` は弱い equal で巨大候補が混ざるので様子見)。
- `prune` のメモリリーク (別 TODO #2) で数百 iter 回すと OOM するので、収束 cap は控えめ。重い候補ほど小さく。

注意: slow/fast → before/after の契約キーリネーム以前に保存した equiv-results.jsonl /
equiv-input.jsonl (brain-2 等のバッチ出力) とは互換がない。以後の集計は再走が前提。

usage:
  python tmp/0022_.../build_prune_input.py                       # BIG_MAX_ITER=50  SMALL_MAX_ITER=5000
  python tmp/0022_.../build_prune_input.py 30 2000               # 上書き (BIG, SMALL)
"""

from __future__ import annotations

import json
import os
import sys

WORK = os.path.abspath(os.path.dirname(__file__))
EQUIV_RESULTS = os.path.join(WORK, "equiv-results.jsonl")
EQUIV_INPUT = os.path.join(WORK, "equiv-input.jsonl")
PRUNE_INPUT = os.path.join(WORK, "prune-input.jsonl")

PRUNE_VERDICTS = {"equal"}
MAX_CODE_LENGTH = (
    20_000_000  # PruningInput.MAX_CODE_LENGTH (= EquivalenceInput と同じ。setup に lib 全文が入るので大きめ)
)
TIMEOUT_MS = 3_000  # per-iteration 等価検証 timeout
# setup がこの文字数を超える候補 (= Ember 級 lib 全文 + 依存 lib) は 1 iter が重い + prune のメモリリークで
# 数百 iter で OOM → 収束は諦めて小さい cap。それ未満 (= 小 lib の changed-fn / body) は大きめ cap。
BIG_SETUP_THRESHOLD = 500_000
BIG_MAX_ITERATIONS = int(sys.argv[1]) if len(sys.argv) > 1 else 50
SMALL_MAX_ITERATIONS = int(sys.argv[2]) if len(sys.argv) > 2 else 5_000


def main() -> int:
    results = [json.loads(l) for l in open(EQUIV_RESULTS) if l.strip()]
    equiv_input = {json.loads(l)["id"]: json.loads(l) for l in open(EQUIV_INPUT) if l.strip()}

    target_ids = [r["id"] for r in results if r.get("verdict") in PRUNE_VERDICTS]
    kept = kept_big = 0
    skipped_huge: list[str] = []
    skipped_missing: list[str] = []
    with open(PRUNE_INPUT, "w") as f:
        for rec_id in target_ids:
            src = equiv_input.get(rec_id)
            if src is None:
                skipped_missing.append(rec_id)
                continue
            # PruningInput の max_length に引っかかる candidate は除外 (= mbs prune-batch が 1 行でも invalid だとバッチごと abort するため)。
            if any(len(src.get(k, "") or "") > MAX_CODE_LENGTH for k in ("setup", "before", "after", "workload")):
                skipped_huge.append(rec_id)
                continue
            out = dict(src)
            out["timeout_ms"] = TIMEOUT_MS
            if len(src.get("setup", "")) > BIG_SETUP_THRESHOLD:
                out["max_iterations"] = BIG_MAX_ITERATIONS
                kept_big += 1
            else:
                out["max_iterations"] = SMALL_MAX_ITERATIONS
                kept += 1
            f.write(json.dumps(out) + "\n")

    verdict_counter: dict[str, int] = {}
    for r in results:
        verdict_counter[r.get("verdict", "?")] = verdict_counter.get(r.get("verdict", "?"), 0) + 1
    print(
        f"equiv verdicts={verdict_counter}\n"
        f"  prune-target (verdict in {sorted(PRUNE_VERDICTS)})={len(target_ids)}"
        f"  kept(small setup, max_iter={SMALL_MAX_ITERATIONS})={kept}"
        f"  kept(big setup >{BIG_SETUP_THRESHOLD}chars, max_iter={BIG_MAX_ITERATIONS})={kept_big}"
        f"  skipped(>MAX_CODE_LENGTH)={len(skipped_huge)} skipped_missing={len(skipped_missing)}"
        f"  -> {PRUNE_INPUT}"
    )
    if skipped_huge:
        print("  over MAX_CODE_LENGTH:", skipped_huge)
    if skipped_missing:
        print("  not found in equiv-input.jsonl:", skipped_missing)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
