#!/usr/bin/env python3
"""extracted.jsonl の中身を集計する (ADR-0024 版)。

ADR-0024 で extracted.jsonl は「1 行 = 1 IssueResult (内部 candidates: list)」構造。
旧 candidate_kind / aspect (flat) → issue.issue_meta.aspect, candidate.candidate_meta.target_side,
candidate.candidate_meta.is_workload_reachable で集計。

usage: python research/research/preprocess_workload_reachability/code/inspect_candidates.py
"""

from __future__ import annotations

from collections import Counter, defaultdict
import json
import os
import statistics

WORK = os.path.abspath(os.path.dirname(__file__))
EXTRACTED = os.path.join(WORK, "extracted.jsonl")


def main() -> int:
    issues = [json.loads(line) for line in open(EXTRACTED) if line.strip()]
    n_issues = len(issues)
    issue_excluded = [i for i in issues if i.get("issue_excluded")]
    issue_ok = [i for i in issues if not i.get("issue_excluded")]

    # issue level 集計
    aspect_c: Counter[str] = Counter()
    layout_c: Counter[str] = Counter()
    wrapper_c: Counter[str] = Counter()
    issue_excl_c: Counter[str] = Counter(str(i.get("issue_excluded")) for i in issue_excluded)
    for i in issue_ok:
        imeta = i.get("issue_meta") or {}
        aspect_c[str(imeta.get("aspect"))] += 1
        layout_c[str(imeta.get("layout"))] += 1
        wrapper_c[str(imeta.get("wrapper_kind"))] += 1

    # candidate level 集計
    target_side_c: Counter[str] = Counter()
    workload_reachable_c: Counter[bool] = Counter()
    encl_node_c: Counter[str] = Counter()
    cand_excl_c: Counter[str] = Counter()
    n_candidates = 0
    changed_fn_sizes: list[int] = []
    issue_with_changed_fn: set[str] = set()
    cf_per_issue: dict[str, int] = defaultdict(int)

    for issue in issue_ok:
        issue_id = issue.get("id", "")
        for c in issue.get("candidates", []):
            n_candidates += 1
            cmeta = c.get("candidate_meta") or {}
            target_side_c[str(cmeta.get("target_side"))] += 1
            workload_reachable_c[bool(cmeta.get("is_workload_reachable"))] += 1
            encl_node_c[str(c.get("enclosure_node_type"))] += 1
            if c.get("candidate_excluded"):
                cand_excl_c[str(c.get("candidate_excluded"))] += 1
            if cmeta.get("is_workload_reachable"):
                issue_with_changed_fn.add(issue_id)
                cf_per_issue[issue_id] += 1
                bnc = c.get("before_node_count")
                if isinstance(bnc, int):
                    changed_fn_sizes.append(bnc)

    # aspect: lib の issue で changed-fn を持たない issue (= workload 非到達 / fn unit 無し / param 不一致 等)
    lib_issues = {i.get("id") for i in issue_ok if (i.get("issue_meta") or {}).get("aspect") == "lib"}
    lib_no_cf = sorted(lib_issues - issue_with_changed_fn)
    multi_cf = {k: v for k, v in cf_per_issue.items() if v > 1}

    print(f"issues={n_issues}  ok={len(issue_ok)}  issue_excluded={len(issue_excluded)}")
    print(f"  aspect:        {dict(aspect_c)}")
    print(f"  layout:        {dict(layout_c)}")
    print(f"  wrapper_kind:  {dict(wrapper_c)}")
    if issue_excl_c:
        print(f"  issue_excluded reasons: {dict(issue_excl_c)}")
    print()
    print(f"candidates total: {n_candidates}")
    print(f"  target_side:           {dict(target_side_c)}")
    print(f"  is_workload_reachable: {dict(workload_reachable_c)}")
    print(f"  enclosure_node_type:   {dict(encl_node_c)}")
    if cand_excl_c:
        print(f"  candidate_excluded reasons: {dict(cand_excl_c)}")
    print()
    sizes = sorted(changed_fn_sizes)
    print(
        f"changed-fn (is_workload_reachable=True) candidates: {len(changed_fn_sizes)}  "
        f"(issues with >=1: {len(issue_with_changed_fn)})",
    )
    if sizes:
        print(
            f"  before_node_count: min={sizes[0]} median={int(statistics.median(sizes))} "
            f"p90={sizes[int(len(sizes) * 0.9)] if len(sizes) > 1 else sizes[0]} max={sizes[-1]}  "
            f"(n={len(sizes)})",
        )
    if multi_cf:
        print(f"  issues with multiple changed-fn: {multi_cf}")
    print()
    print(
        f"aspect: lib issues = {len(lib_issues)}  / with changed-fn = {len(issue_with_changed_fn & lib_issues)}  "
        f"/ WITHOUT changed-fn = {len(lib_no_cf)}",
    )
    if lib_no_cf:
        print("  (no changed-fn = fn unit が無い or workload 非到達 or param 不一致 等):")
        for k in lib_no_cf:
            print(f"    {k}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
