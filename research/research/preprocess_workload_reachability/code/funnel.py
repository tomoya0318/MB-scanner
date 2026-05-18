#!/usr/bin/env python3
"""97 issue 全件再走の funnel 可視化 (ADR-0023 D-γ §DROP 可視化)。

`extracted.jsonl` → `equiv-input.jsonl` → `equiv-results.jsonl` の 4 段集計:
  ① issue 総数 (= extracted.jsonl 行数)
  ② candidate 抽出済 issue (= issue_excluded でなく candidates が 1 件以上ある)
  ③ equiv 投入 issue (= equiv-input.jsonl に 1 行以上の id がある issue)
  ④ verdict 別 issue (= equiv-results.jsonl の verdict、equal / not_equal / inconclusive / error)

加えて:
  - issue_excluded reason 別件数 (issue level)
  - candidate_excluded reason 別件数 (candidate level)
  - 「1 candidate も equiv-input に乗らなかった issue」の主要 reason (DROP の構造)

usage:
  python research/research/preprocess_workload_reachability/code/funnel.py
  python research/research/preprocess_workload_reachability/code/funnel.py --format=md
  python research/research/preprocess_workload_reachability/code/funnel.py --format=json
"""

from __future__ import annotations

import argparse
import dataclasses
import json
import os
import sys
from collections import Counter
from collections.abc import Iterable

WORK = os.path.abspath(os.path.dirname(__file__))
DEFAULT_EXTRACTED = os.path.join(WORK, "extracted.jsonl")
DEFAULT_EQUIV_INPUT = os.path.join(WORK, "equiv-input.jsonl")
DEFAULT_EQUIV_RESULTS = os.path.join(WORK, "equiv-results.jsonl")


@dataclasses.dataclass(frozen=True)
class FunnelStats:
    """4 段集計の生データ。

    counts は段ごとの「到達 issue 数」(④ は verdict 別 issue 数)、
    reasons は reason → 件数。``equiv_input_ids`` は ``<issue_id>#<idx>`` の suffix 付。
    ``layout_wrapper_cross`` は (layout, wrapper_kind) 別の reached / dropped 内訳
    (Phase 3 で救済対象を構造軸で優先度付けるための cross 集計)。
    """

    n_issues: int
    n_extracted: int  # issue_excluded でなく candidates 数 ≥ 1
    n_equiv_input_issues: int
    verdict_issue_counts: dict[str, int]
    issue_excluded_reasons: dict[str, int]
    candidate_excluded_reasons: dict[str, int]
    dropped_issue_reasons: dict[str, int]  # 1 candidate も equiv 入りしなかった issue の主要 reason
    layout_wrapper_cross: dict[tuple[str, str], dict[str, int]]  # (layout, wrapper_kind) -> {total, reached, dropped}


def _load_jsonl(path: str) -> list[dict]:
    if not os.path.isfile(path):
        return []
    out: list[dict] = []
    with open(path) as f:
        for line in f:
            line = line.strip()
            if line:
                out.append(json.loads(line))
    return out


def _issue_dropped_reason(issue: dict) -> str:
    """1 candidate も equiv-input に乗らなかった issue を 1 つの reason に集約。

    - issue_excluded があれば ``issue:<reason>``
    - candidates 全件が candidate_excluded を持つ → 多数派の reason ``candidate:<reason>``
    - 全 candidate が non-small (= embedded のみ等) → ``no-small-candidate``
    - candidates 自体が空 → ``no-candidate``
    """
    if issue.get("issue_excluded"):
        return f"issue:{issue['issue_excluded']}"
    candidates = issue.get("candidates", []) or []
    if not candidates:
        return "no-candidate"
    excluded_reasons = [c.get("candidate_excluded") for c in candidates if c.get("candidate_excluded")]
    if len(excluded_reasons) == len(candidates):
        # 全 candidate が excluded marker
        top = Counter(excluded_reasons).most_common(1)[0][0]
        return f"candidate:{top}"
    # 一部 candidate は実体を持つが equiv-input に乗らなかった (small filter 落ち or no_dir 等)
    return "no-small-candidate"


def compute_funnel(
    extracted: Iterable[dict],
    equiv_input: Iterable[dict],
    equiv_results: Iterable[dict],
) -> FunnelStats:
    """4 段の funnel を集計する純関数。

    ``equiv_input`` / ``equiv_results`` は不在なら空 iter で良い (= 該当段は 0)。
    """
    issues = list(extracted)
    n_issues = len(issues)

    issue_excluded_reasons: Counter[str] = Counter()
    candidate_excluded_reasons: Counter[str] = Counter()
    n_extracted = 0
    for issue in issues:
        if issue.get("issue_excluded"):
            issue_excluded_reasons[str(issue["issue_excluded"])] += 1
            continue
        candidates = issue.get("candidates", []) or []
        if any(not c.get("candidate_excluded") for c in candidates):
            n_extracted += 1
        for c in candidates:
            r = c.get("candidate_excluded")
            if r:
                candidate_excluded_reasons[str(r)] += 1

    # equiv-input の id は "<issue_id>#<idx>" 形式 → issue 単位に dedup
    equiv_input_issue_ids: set[str] = set()
    for row in equiv_input:
        rid = row.get("id")
        if isinstance(rid, str) and "#" in rid:
            equiv_input_issue_ids.add(rid.rsplit("#", 1)[0])
    n_equiv_input_issues = len(equiv_input_issue_ids)

    # verdict は equiv-results の id (= "<issue_id>#<idx>") から issue 単位に rollup
    # 同一 issue 内に複数 candidate verdict がある場合の優先順: equal > not_equal > inconclusive > error
    # (= ADR §達成目標「verdict ≥ 1」の到達定義)
    verdict_priority = {"equal": 0, "not_equal": 1, "inconclusive": 2, "error": 3}
    issue_best_verdict: dict[str, str] = {}
    for row in equiv_results:
        rid = row.get("id")
        verdict = row.get("verdict")
        if not isinstance(rid, str) or "#" not in rid or not isinstance(verdict, str):
            continue
        issue_id = rid.rsplit("#", 1)[0]
        if verdict not in verdict_priority:
            continue
        cur = issue_best_verdict.get(issue_id)
        if cur is None or verdict_priority[verdict] < verdict_priority[cur]:
            issue_best_verdict[issue_id] = verdict
    verdict_counts: Counter[str] = Counter(issue_best_verdict.values())

    # 1 candidate も equiv-input に乗らなかった issue の DROP reason
    dropped_reasons: Counter[str] = Counter()
    for issue in issues:
        issue_id = issue.get("id", "")
        if issue_id in equiv_input_issue_ids:
            continue
        dropped_reasons[_issue_dropped_reason(issue)] += 1

    # (layout, wrapper_kind) cross: issue_excluded は "(unknown, unknown)" に集約 (issue_meta が無い)
    cross: dict[tuple[str, str], dict[str, int]] = {}
    for issue in issues:
        imeta = issue.get("issue_meta") or {}
        key = (str(imeta.get("layout") or "unknown"), str(imeta.get("wrapper_kind") or "unknown"))
        bucket = cross.setdefault(key, {"total": 0, "reached": 0, "dropped": 0})
        bucket["total"] += 1
        if issue.get("id", "") in equiv_input_issue_ids:
            bucket["reached"] += 1
        else:
            bucket["dropped"] += 1

    return FunnelStats(
        n_issues=n_issues,
        n_extracted=n_extracted,
        n_equiv_input_issues=n_equiv_input_issues,
        verdict_issue_counts=dict(verdict_counts),
        issue_excluded_reasons=dict(issue_excluded_reasons),
        candidate_excluded_reasons=dict(candidate_excluded_reasons),
        dropped_issue_reasons=dict(dropped_reasons),
        layout_wrapper_cross=cross,
    )


def _pct(num: int, denom: int) -> str:
    return f"{(100.0 * num / denom):.0f}%" if denom > 0 else "-"


def _drop(prev: int, cur: int) -> str:
    return str(prev - cur) if prev >= cur else "-"


def format_text(s: FunnelStats) -> str:
    n = s.n_issues
    lines = [
        f"funnel ({n} issues):",
        f"  ① 全 issue:                {n}",
        f"  ② candidate 抽出済:        {s.n_extracted}  ({_pct(s.n_extracted, n)})  DROP={_drop(n, s.n_extracted)}",
        f"  ③ equiv-input 投入 issue:  {s.n_equiv_input_issues}  ({_pct(s.n_equiv_input_issues, n)})  DROP={_drop(s.n_extracted, s.n_equiv_input_issues)}",
    ]
    total_verdict = sum(s.verdict_issue_counts.values())
    lines.append(f"  ④ verdict 到達 issue:      {total_verdict}  ({_pct(total_verdict, n)})")
    for v in ("equal", "not_equal", "inconclusive", "error"):
        if v in s.verdict_issue_counts:
            lines.append(f"      {v}: {s.verdict_issue_counts[v]}")
    if s.issue_excluded_reasons:
        lines.append("")
        lines.append("issue_excluded reasons:")
        for k, v in sorted(s.issue_excluded_reasons.items(), key=lambda kv: -kv[1]):
            lines.append(f"  {k}: {v}")
    if s.candidate_excluded_reasons:
        lines.append("")
        lines.append("candidate_excluded reasons (candidate 件数):")
        for k, v in sorted(s.candidate_excluded_reasons.items(), key=lambda kv: -kv[1]):
            lines.append(f"  {k}: {v}")
    if s.dropped_issue_reasons:
        lines.append("")
        lines.append("equiv-input に 1 件も乗らなかった issue の主要 reason:")
        for k, v in sorted(s.dropped_issue_reasons.items(), key=lambda kv: -kv[1]):
            lines.append(f"  {k}: {v}")
    if s.layout_wrapper_cross:
        lines.append("")
        lines.append("layout × wrapper_kind (issue 単位 reached / total):")
        for (layout, wrapper), b in sorted(s.layout_wrapper_cross.items(), key=lambda kv: -kv[1]["total"]):
            lines.append(f"  {layout} / {wrapper}: {b['reached']}/{b['total']}  (dropped={b['dropped']})")
    return "\n".join(lines)


def format_md(s: FunnelStats) -> str:
    n = s.n_issues
    total_verdict = sum(s.verdict_issue_counts.values())
    lines = [
        "## funnel",
        "",
        "| 段 | 件数 | DROP | 到達率 |",
        "|----|------|------|--------|",
        f"| ① 全 issue | {n} | - | 100% |",
        f"| ② candidate 抽出済 | {s.n_extracted} | {_drop(n, s.n_extracted)} | {_pct(s.n_extracted, n)} |",
        f"| ③ equiv-input 投入 issue | {s.n_equiv_input_issues} | {_drop(s.n_extracted, s.n_equiv_input_issues)} | {_pct(s.n_equiv_input_issues, n)} |",
        f"| ④ verdict 到達 issue | {total_verdict} | - | {_pct(total_verdict, n)} |",
    ]
    if s.verdict_issue_counts:
        lines += ["", "### verdict 内訳 (issue 単位、複数 candidate の場合 equal > not_equal > inconclusive > error 優先)", "", "| verdict | issues |", "|---------|-------:|"]
        for v in ("equal", "not_equal", "inconclusive", "error"):
            if v in s.verdict_issue_counts:
                lines.append(f"| {v} | {s.verdict_issue_counts[v]} |")
    if s.candidate_excluded_reasons:
        lines += ["", "### candidate_excluded reasons (candidate 件数)", "", "| reason | candidates |", "|--------|-----------:|"]
        for k, v in sorted(s.candidate_excluded_reasons.items(), key=lambda kv: -kv[1]):
            lines.append(f"| {k} | {v} |")
    if s.dropped_issue_reasons:
        lines += ["", "### equiv-input に 1 件も乗らなかった issue の主要 reason (issue 単位)", "", "| reason | issues |", "|--------|-------:|"]
        for k, v in sorted(s.dropped_issue_reasons.items(), key=lambda kv: -kv[1]):
            lines.append(f"| {k} | {v} |")
    if s.issue_excluded_reasons:
        lines += ["", "### issue_excluded reasons (issue 単位)", "", "| reason | issues |", "|--------|-------:|"]
        for k, v in sorted(s.issue_excluded_reasons.items(), key=lambda kv: -kv[1]):
            lines.append(f"| {k} | {v} |")
    if s.layout_wrapper_cross:
        lines += [
            "",
            "### layout × wrapper_kind cross (issue 単位、Phase 3 救済対象の優先度判断材料)",
            "",
            "| layout | wrapper_kind | reached | dropped | total |",
            "|--------|--------------|--------:|--------:|------:|",
        ]
        for (layout, wrapper), b in sorted(s.layout_wrapper_cross.items(), key=lambda kv: -kv[1]["total"]):
            lines.append(f"| {layout} | {wrapper} | {b['reached']} | {b['dropped']} | {b['total']} |")
    return "\n".join(lines)


def format_json(s: FunnelStats) -> str:
    d = dataclasses.asdict(s)
    # tuple key は JSON 化できないので "layout/wrapper_kind" 文字列キーに変換
    d["layout_wrapper_cross"] = {
        f"{layout}/{wrapper}": bucket for (layout, wrapper), bucket in s.layout_wrapper_cross.items()
    }
    return json.dumps(d, indent=2, ensure_ascii=False)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--format", choices=["text", "md", "json"], default="text")
    parser.add_argument("--extracted", default=DEFAULT_EXTRACTED, help="extracted.jsonl のパス (default: script 隣)")
    parser.add_argument("--equiv-input", default=DEFAULT_EQUIV_INPUT, help="equiv-input.jsonl のパス")
    parser.add_argument("--equiv-results", default=DEFAULT_EQUIV_RESULTS, help="equiv-results.jsonl のパス")
    args = parser.parse_args(argv)

    extracted = _load_jsonl(args.extracted)
    if not extracted:
        print(f"[warn] extracted.jsonl が見つからない or 空: {args.extracted}", file=sys.stderr)
    equiv_input = _load_jsonl(args.equiv_input)
    equiv_results = _load_jsonl(args.equiv_results)
    stats = compute_funnel(extracted, equiv_input, equiv_results)

    if args.format == "json":
        print(format_json(stats))
    elif args.format == "md":
        print(format_md(stats))
    else:
        print(format_text(stats))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
