#!/usr/bin/env python3
"""prune-results.jsonl の削減率を集計する (ADR-0024 版)。

ADR-0024 で extracted.jsonl は階層化 (1 issue = 1 行、内部 candidates: list)、
equivalence-checker / pruning では preprocess hint (旧 candidate_kind / enclosure_type / aspect)
は廃止予定。旧 by_encl / by_kind の集計は extracted.jsonl から直接 join して計算する。

集計対象:
  - 削減率 = 1 - node_count_after / node_count_before
  - verdict 別の内訳
  - iterations が cap (= max_iterations) に張り付いてないか
  - extracted.jsonl から派生: enclosure_node_type / target_side / is_workload_reachable 別の削減率

usage: python research/research/preprocess_workload_reachability/code/summarize.py [prune-results.jsonl]
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
EXTRACTED = os.path.join(WORK, "extracted.jsonl")

# 比較対象 (notes より):
PREV = [
    {"label": "0019 lib-embedded (max_iter=100)", "median": 0.237, "cap_hit": "66/70", "n": 70},
    {"label": "0021 lib-enclosure (max_iter=1000)", "median": 0.642, "cap_hit": "多数 (収束せず)", "n": 8},
]


def reduction(r: dict) -> float | None:
    b, a = r.get("node_count_before"), r.get("node_count_after")
    if not b or a is None:
        return None
    return 1.0 - a / b


def load_extracted_hints() -> dict[str, dict]:
    """extracted.jsonl から ``<issue_id>#<idx>`` ごとの hint dict を構築する。

    Returns:
        ``{ "<issue_id>#<idx>": {enclosure_node_type, target_side, is_workload_reachable, aspect} }``
    """
    hints: dict[str, dict] = {}
    if not os.path.isfile(EXTRACTED):
        return hints
    with open(EXTRACTED) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            issue = json.loads(line)
            issue_id = issue.get("id")
            if issue_id is None:
                continue
            imeta = issue.get("issue_meta") or {}
            for idx, c in enumerate(issue.get("candidates", [])):
                cmeta = c.get("candidate_meta") or {}
                key = f"{issue_id}#{idx}"
                hints[key] = {
                    "enclosure_node_type": c.get("enclosure_node_type"),
                    "target_side": cmeta.get("target_side"),
                    "is_workload_reachable": cmeta.get("is_workload_reachable"),
                    "aspect": imeta.get("aspect"),
                }
    return hints


def main() -> int:
    path = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_PRUNE_RESULTS
    results = [json.loads(line) for line in open(path) if line.strip()]
    prune_in = (
        {json.loads(line)["id"]: json.loads(line) for line in open(PRUNE_INPUT) if line.strip()}
        if os.path.isfile(PRUNE_INPUT)
        else {}
    )
    hints = load_extracted_hints()

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
            f"median={statistics.median(reds):.3f}  p75={statistics.quantiles(reds, n=4)[2]:.3f}  "
            f"max={reds_sorted[-1]:.3f}",
        )
    print(
        f"  iterations が cap (max_iterations) に張り付いた pruned 件数 = {cap_hit} / {len(pruned)}  "
        "(= 収束せず or メモリリークで打ち切り)",
    )

    # extracted.jsonl から hint を join して enclosure_node_type / target_side / is_workload_reachable 別集計
    by_encl_node: dict[str, list[float]] = defaultdict(list)
    by_target_side: dict[str, list[float]] = defaultdict(list)
    by_workload_reachable: dict[str, list[float]] = defaultdict(list)
    for r in pruned:
        red = reduction(r)
        if red is None:
            continue
        h = hints.get(r.get("id", ""), {})
        by_encl_node[str(h.get("enclosure_node_type"))].append(red)
        by_target_side[str(h.get("target_side"))].append(red)
        by_workload_reachable[str(h.get("is_workload_reachable"))].append(red)
    if hints:
        print("  by enclosure_node_type:")
        for k, v in sorted(by_encl_node.items()):
            print(f"    {k}: n={len(v)} median={statistics.median(v):.3f}")
        print("  by target_side:")
        for k, v in sorted(by_target_side.items()):
            print(f"    {k}: n={len(v)} median={statistics.median(v):.3f}")
        print("  by is_workload_reachable:")
        for k, v in sorted(by_workload_reachable.items()):
            print(f"    {k}: n={len(v)} median={statistics.median(v):.3f}")
    else:
        print("  (extracted.jsonl が見つからないので enclosure_node_type / target_side 別集計は skip)")

    print()
    print("比較 (前回):")
    for p in PREV:
        print(f"  {p['label']}: n={p['n']} median={p['median']} cap_hit={p['cap_hit']}")
    if reds:
        print(f"  ADR-0024 changed-fn: n={len(reds)} median={statistics.median(reds):.3f} cap_hit={cap_hit}/{len(pruned)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
