#!/usr/bin/env python3
"""Backend A (regex): pruned pattern_code に各パターンの before-shape 正規表現を当てる。

strict = 生 pattern_code (骨格) / loose = placeholder 展開後 (reconstructed)。
出力は match_ast.mjs と同形式の JSON (shape-targets.json) も書き、AST 側と比較できるようにする。
"""

from __future__ import annotations

import json
import os
import re

import pattern_map as pm

HERE = os.path.abspath(os.path.dirname(__file__))


def reconstruct(rec: dict) -> str:
    code = rec.get("pattern_code") or ""
    snip = {p["id"]: p["original_snippet"] for p in rec.get("placeholders") or []}
    code = re.sub(r'"(\$P\d+)"', lambda m: snip.get(m.group(1), m.group(0)), code)
    return re.sub(r"\$P\d+", lambda m: snip.get(m.group(0), m.group(0)), code)


def detect(text: str, regexes: list[str]) -> bool:
    return any(re.search(r, text, re.I) for r in regexes)


def main():
    # pruned candidate を issue 単位で集約 (pattern_code/reconstructed を全 pruned candidate 分保持)
    pres = [r for r in pm.load_jsonl(pm.STAGES["prune_results"]) if r["verdict"] == "pruned"]
    by_issue: dict[str, list[dict]] = {}
    for r in pres:
        by_issue.setdefault(r["id"].split("#")[0], []).append(r)

    targets = []  # match_ast.mjs 用 (issue ごとの pattern_code 群)
    rows = []
    for n, p in pm.PATTERNS.items():
        for iid in p["issues"]:
            cands = by_issue.get(iid)
            if not cands:
                rows.append((n, iid, "n/a", None, None))  # pruned 到達せず
                continue
            pcs = [c.get("pattern_code") or "" for c in cands]
            recons = [reconstruct(c) for c in cands]
            # placeholder スニペット (loose を skeleton OR スニペット で定義し、AST と揃える)
            snippets = [ph.get("original_snippet", "") for c in cands for ph in (c.get("placeholders") or [])]
            strict = any(detect(pc, p["regex"]) for pc in pcs)
            # loose = skeleton ∪ フル展開 ∪ 各スニペット (= pruning が保持した中に形があるか)
            loose = (
                strict or any(detect(rc, p["regex"]) for rc in recons) or any(detect(s, p["regex"]) for s in snippets)
            )
            rows.append((n, iid, "pruned", strict, loose))
            targets.append(
                {
                    "pattern": n,
                    "id": iid,
                    "regexes": p["regex"],
                    "pattern_codes": pcs,
                    "reconstructed": recons,
                    "placeholder_snippets": snippets,
                }
            )

    print("## Backend A (regex): before-shape 検出 (pruned issue のみ)\n")
    print("| P | issue | pruned | strict(骨格) | loose(展開後) |")
    print("|---|-------|:--:|:--:|:--:|")
    for n, iid, st, strict, loose in rows:
        if st == "n/a":
            mark = "— (pruned 未到達)"
            print(f"| P{n} | {iid.split('/')[-1]} | ✗ | {mark} | |")
        else:
            s = "✅" if strict else "❌"
            l = "✅" if loose else "❌"
            print(f"| P{n} | {iid.split('/')[-1]} | ✓ | {s} | {l} |")

    # パターン単位サマリ (issue を OR 集約: そのパターンに pruned issue が1つでも strict/loose 検出あるか)
    print("\n## パターン単位 (pruned issue を OR 集約)\n")
    print("| P | パターン | pruned issue | regex strict | regex loose |")
    print("|---|------|----:|:--:|:--:|")
    for n, p in pm.PATTERNS.items():
        prs = [r for r in rows if r[0] == n and r[2] == "pruned"]
        if not prs:
            print(f"| P{n} | {p['name'][:30]} | 0 | — | — |")
            continue
        st = "✅" if any(r[3] for r in prs) else "❌"
        lo = "✅" if any(r[4] for r in prs) else "❌"
        print(f"| P{n} | {p['name'][:30]} | {len(prs)} | {st} | {lo} |")

    with open(os.path.join(HERE, "shape-targets.json"), "w") as f:
        json.dump(targets, f, ensure_ascii=False, indent=2)


if __name__ == "__main__":
    main()
