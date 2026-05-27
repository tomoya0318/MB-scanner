#!/usr/bin/env python3
"""10 パターンの各 issue が pipeline のどの段階で落ちるかを追跡する。

ステージ: 前処理後 extracted → 射影後 equiv-input → 等価判定後 equiv-results → pruning 後 prune-results。
各 issue を「どこまで通過し、どこで・なぜ落ちたか」に分類して、パターン別に集計する。
"""

from __future__ import annotations

from collections import Counter, defaultdict

import pattern_map as pm

PRI = {"equal": 0, "not_equal": 1, "inconclusive": 2, "error": 3}


def build_index() -> tuple[dict[str, dict], set[str], dict[str, str], set[str], set[str]]:
    ext: dict[str, dict] = {r["id"]: r for r in pm.load_jsonl(pm.STAGES["extracted"])}
    eqin_ids = {r["id"].split("#")[0] for r in pm.load_jsonl(pm.STAGES["equiv_input"])}
    # issue 単位 verdict
    iv: dict[str, str] = {}
    for r in pm.load_jsonl(pm.STAGES["equiv_results"]):
        i = r["id"].split("#")[0]
        v = str(r.get("verdict") or "")
        if i not in iv or PRI.get(v, 9) < PRI.get(iv[i], 9):
            iv[i] = v
    pruned = {r["id"].split("#")[0] for r in pm.load_jsonl(pm.STAGES["prune_results"]) if r["verdict"] == "pruned"}
    prune_err = {r["id"].split("#")[0] for r in pm.load_jsonl(pm.STAGES["prune_results"]) if r["verdict"] != "pruned"}
    return ext, eqin_ids, iv, pruned, prune_err


def classify(
    iid: str,
    ext: dict[str, dict],
    eqin_ids: set[str],
    iv: dict[str, str],
    pruned: set[str],
    prune_err: set[str],
) -> tuple[str, str]:
    rec = ext.get(iid)
    if rec is None:
        return "extract", "issue 抽出されず"
    if rec.get("issue_excluded"):
        return "extract", f"issue_excluded={rec.get('issue_excluded')}"
    # candidate_excluded reasons
    reasons = Counter(c.get("candidate_excluded") for c in (rec.get("candidates") or []) if c.get("candidate_excluded"))
    if iid not in eqin_ids:
        why = ",".join(f"{k}={v}" for k, v in reasons.items()) or "no-small-candidate"
        return "projection", f"equiv-input 非到達 ({why})"
    v = iv.get(iid)
    if v != "equal":
        return f"equiv:{v}", f"verdict={v}"
    if iid in pruned:
        return "pruned", "✓ pruned 到達"
    if iid in prune_err:
        return "pruning", "equal だが pruning error"
    return "pruning", "equal だが pruning 結果なし"


def main():
    ext, eqin_ids, iv, pruned, prune_err = build_index()

    print("## 段階別 funnel: 10 パターンの issue がどこで落ちるか\n")
    print("| P | issue | 抽出 | 射影 | verdict | pruned | 到達/脱落段 |")
    print("|---|-------|:--:|:--:|:------:|:--:|------|")
    per_pattern = defaultdict(lambda: defaultdict(int))
    for n, p in pm.PATTERNS.items():
        for iid in p["issues"]:
            stage, why = classify(iid, ext, eqin_ids, iv, pruned, prune_err)
            rec = ext.get(iid, {})
            ncand = len(rec.get("candidates") or [])
            in_ext = "✓" if rec and not rec.get("issue_excluded") else "✗"
            in_proj = "✓" if iid in eqin_ids else "✗"
            v = iv.get(iid, "-")
            pr = "✓" if iid in pruned else ("err" if iid in prune_err else "-")
            short = iid.split("/")[-1].replace("issue_", "") + " (" + iid.split("/")[1].replace("Issues", "") + ")"
            print(f"| P{n} | {short} | {in_ext}{ncand} | {in_proj} | {v} | {pr} | {stage}: {why} |")
            per_pattern[n][stage] += 1

    print("\n## パターン別 通過サマリ\n")
    print("| P | パターン | issue数 | pruned 到達 | 主な脱落段 |")
    print("|---|------|----:|----:|------|")
    for n, p in pm.PATTERNS.items():
        d = per_pattern[n]
        total = sum(d.values())
        npruned = d.get("pruned", 0)
        drops = {k: v for k, v in d.items() if k != "pruned"}
        drops_s = ", ".join(f"{k}×{v}" for k, v in sorted(drops.items(), key=lambda x: -x[1])) or "-"
        print(f"| P{n} | {p['name'][:34]} | {total} | {npruned} | {drops_s} |")


if __name__ == "__main__":
    main()
