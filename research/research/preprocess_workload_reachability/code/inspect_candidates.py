#!/usr/bin/env python3
"""extracted.jsonl の中身を集計する (0022 版 — Phase 5 §新 candidate の検証)。

- candidate_kind / aspect / enclosure_type 別の件数
- changed-fn 候補の `before_node_count` (= 変更関数本体のノード数) の分布
- 「`aspect: lib` の issue だが changed-fn を出せなかった」件数 (= workload が変更関数を呼ばない / fn unit 無し /
   build 失敗 のいずれか — issue 単位で `aspect == "lib"` の候補があるのに同 issue に changed-fn が無いものを数える)

usage: python tmp/0022_preprocess-workload-reachability-redesign/inspect_candidates.py
"""

from __future__ import annotations

from collections import Counter, defaultdict
import json
import os
import statistics

WORK = os.path.abspath(os.path.dirname(__file__))
EXTRACTED = os.path.join(WORK, "extracted.jsonl")


def issue_key(rec_id: str) -> str:
    return rec_id.split("#", 1)[0]


def main() -> int:
    recs = [json.loads(l) for l in open(EXTRACTED) if l.strip()]
    n = len(recs)
    excluded = [r for r in recs if r.get("excluded")]
    ok = [r for r in recs if not r.get("excluded")]

    kind_c: Counter[str] = Counter(str(r.get("candidate_kind")) for r in ok)
    aspect_c: Counter[str] = Counter(str(r.get("aspect")) for r in ok)
    encl_c: Counter[str] = Counter(str(r.get("enclosure_type")) for r in ok)
    excl_c: Counter[str] = Counter(str(r.get("excluded")) for r in excluded)

    changed_fn = [r for r in ok if r.get("candidate_kind") == "changed-fn"]
    sizes = sorted(r["before_node_count"] for r in changed_fn if isinstance(r.get("before_node_count"), int))

    # aspect: lib の issue 集合 / そのうち changed-fn を持つ issue
    lib_issues = {issue_key(r["id"]) for r in ok if r.get("aspect") == "lib" and "id" in r}
    lib_issues_with_cf = {issue_key(r["id"]) for r in changed_fn if "id" in r}
    lib_no_cf = sorted(lib_issues - lib_issues_with_cf)

    # changed-fn が複数出てる issue (= 同 issue で workload-reachable な変更関数が複数)
    cf_per_issue: dict[str, int] = defaultdict(int)
    for r in changed_fn:
        cf_per_issue[issue_key(r["id"])] += 1
    multi_cf = {k: v for k, v in cf_per_issue.items() if v > 1}

    print(f"records={n}  ok={len(ok)}  excluded={len(excluded)}")
    print(f"  candidate_kind: {dict(kind_c)}")
    print(f"  aspect:         {dict(aspect_c)}")
    print(f"  enclosure_type: {dict(encl_c)}")
    print(f"  excluded reasons: {dict(excl_c)}")
    print()
    print(f"changed-fn candidates: {len(changed_fn)}  (issues with >=1 changed-fn: {len(lib_issues_with_cf)})")
    if sizes:
        print(
            f"  before_node_count: min={sizes[0]} median={int(statistics.median(sizes))} "
            f"p90={sizes[int(len(sizes) * 0.9)] if len(sizes) > 1 else sizes[0]} max={sizes[-1]}  (n={len(sizes)})"
        )
    if multi_cf:
        print(f"  issues with multiple changed-fn: {multi_cf}")
    print()
    print(
        f"aspect: lib issues = {len(lib_issues)}  / with changed-fn = {len(lib_issues_with_cf)}  / WITHOUT changed-fn = {len(lib_no_cf)}"
    )
    if lib_no_cf:
        print("  (no changed-fn = fn unit が無い or workload 非到達 or param 不一致 等):")
        for k in lib_no_cf:
            print(f"    {k}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
