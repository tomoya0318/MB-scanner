#!/usr/bin/env python3
"""prune-results.jsonl の削減率を集計し、0019 (lib-embedded) / 0021 (lib-enclosure) と比較する (0022 版 — Phase 5 DoD)。

削減率 = 1 - node_count_after / node_count_before。verdict 別の内訳、iterations が cap (= max_iterations) に
張り付いてないか (= 収束したか / メモリリークで途中で死んでないか)、enclosure_type / candidate_kind 別の削減率を出す。

usage: python tmp/0022_.../summarize.py [prune-results.jsonl]   (引数なしなら tmp/0022_.../prune-results.jsonl)
"""

from __future__ import annotations

from collections import Counter, defaultdict
import json
import os
import statistics
import sys

WORK = os.path.abspath(os.path.dirname(__file__))
DEFAULT_PRUNE_RESULTS = os.path.join(WORK, "prune-results.jsonl")
PRUNE_INPUT = os.path.join(WORK, "prune-input.jsonl")

# 比較対象 (notes より):
#  0019 = lib-embedded, equal-only 70 件, max_iter=100 → median reduction 0.237, cap-hit 66/70
#  0021 = lib-enclosure (= 「全変更を 1 enclosure で包む」旧方式), equal 8 件 pruned → median 0.642 だが cap 張り付き多数
PREV = [
    {"label": "0019 lib-embedded (max_iter=100)", "median": 0.237, "cap_hit": "66/70", "n": 70},
    {"label": "0021 lib-enclosure (max_iter=1000)", "median": 0.642, "cap_hit": "多数 (収束せず)", "n": 8},
]


def reduction(r: dict) -> float | None:
    b, a = r.get("node_count_before"), r.get("node_count_after")
    if not b or a is None:
        return None
    return 1.0 - a / b


def main() -> int:
    path = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_PRUNE_RESULTS
    results = [json.loads(l) for l in open(path) if l.strip()]
    prune_in = (
        {json.loads(l)["id"]: json.loads(l) for l in open(PRUNE_INPUT) if l.strip()}
        if os.path.isfile(PRUNE_INPUT)
        else {}
    )

    verdict_c: Counter[str] = Counter(str(r.get("verdict")) for r in results)
    pruned = [r for r in results if r.get("verdict") == "pruned"]
    reds = [x for x in (reduction(r) for r in pruned) if x is not None]

    # cap 張り付き: iterations == max_iterations (prune-input の max_iterations と突合)
    cap_hit = 0
    for r in pruned:
        mi = prune_in.get(r.get("id"), {}).get("max_iterations")
        if mi is not None and r.get("iterations") == mi:
            cap_hit += 1

    print(f"prune-results: {path}")
    print(f"  total={len(results)}  verdicts={dict(verdict_c)}")
    print(f"  pruned={len(pruned)}  reduction (1 - after/before) で集計可能なもの={len(reds)}")
    if reds:
        reds_sorted = sorted(reds)
        print(
            f"    min={reds_sorted[0]:.3f}  p25={statistics.quantiles(reds, n=4)[0]:.3f}  "
            f"median={statistics.median(reds):.3f}  p75={statistics.quantiles(reds, n=4)[2]:.3f}  max={reds_sorted[-1]:.3f}"
        )
    print(
        f"  iterations が cap (max_iterations) に張り付いた pruned 件数 = {cap_hit} / {len(pruned)}  (= 収束せず or メモリリークで打ち切り)"
    )

    # enclosure_type / candidate_kind 別
    by_encl: dict[str, list[float]] = defaultdict(list)
    by_kind: dict[str, list[float]] = defaultdict(list)
    for r in pruned:
        red = reduction(r)
        if red is None:
            continue
        by_encl[str(r.get("enclosure_type"))].append(red)
        by_kind[str(r.get("candidate_kind"))].append(red)
    print("  by enclosure_type:")
    for k, v in sorted(by_encl.items()):
        print(f"    {k}: n={len(v)} median={statistics.median(v):.3f}")
    print("  by candidate_kind:")
    for k, v in sorted(by_kind.items()):
        print(f"    {k}: n={len(v)} median={statistics.median(v):.3f}")

    print()
    print("比較 (前回):")
    for p in PREV:
        print(f"  {p['label']}: n={p['n']} median={p['median']} cap_hit={p['cap_hit']}")
    if reds:
        print(f"  0022 changed-fn: n={len(reds)} median={statistics.median(reds):.3f} cap_hit={cap_hit}/{len(pruned)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
