#!/usr/bin/env python3
"""extracted.jsonl から check-equivalence-batch 用の入力 JSONL を組む (ADR-0024 版)。

ADR-0024 で extracted.jsonl の構造が「1 行 = 1 candidate (flat)」から「1 行 = 1 IssueResult
(内部 candidates: list)」に変わった。本スクリプトは:
  - 各 issue の candidates を flatten して 1 candidate = 1 row 形式に変換
  - id は ``<issue_id>#<candidate_idx>`` で suffix 付与 (equiv-input/prune-input の対応用)
  - 旧 SMALL_KINDS フィルタ (= changed-fn / body 相当) を新フィールドベースに置換:
        is_workload_reachable=True OR (aspect=lib+workload, target_side=workload)
  - environment: 現状は常に ``jsdom`` 固定 (Selakovic の server candidate も ``require``/Node globals
    を jsdom executor の shim で解決する前提、ADR-0015 / ``oracle-routing.ts`` 参照)
  - mount_html 出し分け: changed_fn 候補は self-contained なので渡さない

注意: slow/fast → before/after の契約キーリネーム以前に保存した extracted.jsonl
(brain-2 等のバッチ出力) とは互換がない。以後の集計は preprocess からの再走が前提。

usage: python research/research/preprocess_workload_reachability/code/build_equiv_input.py
"""

from __future__ import annotations

from collections import Counter
import json
import os
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "..", ".."))
DATASET = os.path.join(ROOT, "data", "selakovic-2016-issues")
WORK = os.path.abspath(os.path.dirname(__file__))
EXTRACTED = os.path.join(WORK, "extracted.jsonl")
EQUIV_INPUT = os.path.join(WORK, "equiv-input.jsonl")
TIMEOUT_MS = 15_000

EQUIV_FIELDS = ("setup", "before", "after", "workload")


def issue_dir_for(issue_id: str) -> str | None:
    """``<topcat>/<libcat>/.../issue_X`` 形の issue_id から issue ディレクトリの絶対パスを得る。"""
    parts = issue_id.split("/")
    if len(parts) < 3:
        return None
    topcat, libcat, issuedir = parts[0], parts[1], parts[-1]
    return os.path.join(DATASET, topcat, libcat, "issues", issuedir)


def is_small_candidate(issue: dict, candidate: dict) -> bool:
    """旧 ``SMALL_KINDS = {"changed-fn", "body"}`` の新スキーマ等価。

    - changed-fn 由来: ``candidate.candidate_meta.is_workload_reachable == True``
    - body 由来 (= aspect=lib+workload independent split の workload 側):
        ``issue.issue_meta.aspect == "lib+workload"`` AND ``candidate.candidate_meta.target_side == "workload"``
    """
    cmeta = candidate.get("candidate_meta", {})
    if cmeta.get("is_workload_reachable"):
        return True
    imeta = issue.get("issue_meta") or {}
    return imeta.get("aspect") == "lib+workload" and cmeta.get("target_side") == "workload"


def derive_environment(_issue: dict) -> str:
    """equivalence-checker の environment hint。現状は常に ``jsdom`` 固定。

    Selakovic の server candidate (``test_case_*.js``) は ``require('./<lib>_*.js')`` で SUT lib を
    解決し、jsdom executor の require shim + Node-like globals に依存する (``assemble/server.ts``
    のコメント参照)。VM executor は ``require=undefined`` で server contract をサポートしないため、
    layout=server でも ``vm`` には派生させない。VM executor が server contract を扱えるように
    なったら layout 別の派生に戻す (= 別 ADR + 実装変更)。
    """
    return "jsdom"


def main() -> int:
    lines: list[str] = []
    n_issues = n_issue_excluded = n_no_dir = 0
    n_candidates_total = n_candidates_kept = n_candidates_skipped = 0
    target_side_counter: Counter[str] = Counter()
    with open(EXTRACTED) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            n_issues += 1
            issue = json.loads(line)
            if issue.get("issue_excluded"):
                n_issue_excluded += 1
                continue
            issue_id = issue.get("id", "")
            issue_dir = issue_dir_for(issue_id) if issue_id else None
            for idx, c in enumerate(issue.get("candidates", [])):
                n_candidates_total += 1
                cmeta = c.get("candidate_meta") or {}
                target_side_counter[str(cmeta.get("target_side"))] += 1
                if c.get("candidate_excluded"):
                    n_candidates_skipped += 1
                    continue
                if not is_small_candidate(issue, c):
                    n_candidates_skipped += 1
                    continue
                # equiv-input row 1 つを作る。
                # - setup: 旧経路でも空文字を明示 (executor の setup 引数は string 必須)
                # - before / after: candidate に常にある
                # - workload: ADR-0023 D-β placeholder substitution の changed-fn 由来 candidate のみ
                #   non-None。それ以外 (旧経路) は None のまま JSON null に乗り、TS 側 checker が
                #   `input.workload != null` で経路判定 (loose 比較で undefined / null 両対応)
                out: dict = {"id": f"{issue_id}#{idx}" if issue_id else None}
                for k in EQUIV_FIELDS:
                    out[k] = (c.get(k) or "") if k == "setup" else c.get(k)
                out["timeout_ms"] = TIMEOUT_MS
                out["environment"] = derive_environment(issue)
                if issue_dir is not None and os.path.isdir(issue_dir):
                    out["module_base_dir"] = issue_dir
                    # mount_html: embedded 候補 (= is_workload_reachable=False の jsdom 候補) のみ渡す。
                    # changed_fn 候補は self-contained なので、v_*.html を mount すると workload (`execute(f1)`)
                    # が二重に走って害になりうる → 渡さない。
                    if (
                        out["environment"] == "jsdom"
                        and not cmeta.get("is_workload_reachable")
                    ):
                        v_html = os.path.join(issue_dir, "v_before.html")
                        if os.path.isfile(v_html):
                            with open(v_html) as hf:
                                out["mount_html"] = hf.read()
                else:
                    n_no_dir += 1
                    print(f"[warn] no issue dir for {issue_id!r} -> {issue_dir}", file=sys.stderr)
                n_candidates_kept += 1
                lines.append(json.dumps(out))

    with open(EQUIV_INPUT, "w") as f:
        if lines:
            f.write("\n".join(lines) + "\n")
    print(
        f"issues total={n_issues} excluded={n_issue_excluded}\n"
        f"  candidates total={n_candidates_total} target_sides={dict(target_side_counter)}\n"
        f"  -> kept (small candidates) = {n_candidates_kept} skipped = {n_candidates_skipped} (no_dir={n_no_dir})\n"
        f"  -> {EQUIV_INPUT}",
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
