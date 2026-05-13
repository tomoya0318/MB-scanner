#!/usr/bin/env python3
"""extracted.jsonl から check-equivalence-batch 用の入力 JSONL を組む (0022 版)。

0021 版との違い:
- **`candidate_kind in {"changed-fn", "body"}` だけを対象にする** (lib-embedded `single`/`lib` の数万ノード候補は equiv にも prune にも回さない)。
- **dep-vendoring は preprocess 側で済 (= 候補の `setup` に jquery/handlebars 等が連結済)** なので、ここで dep を注入する必要はない。
- `TIMEOUT_MS` を 15000 に (Ember 級は lib 全文 + 依存 lib の bootstrap が重い)。
- excluded 除外 / projection / `module_base_dir` / `mount_html` 注入 は 0021/0019 と同じ。

usage: python tmp/0022_preprocess-workload-reachability-redesign/build_inputs.py
"""
from __future__ import annotations

import json
import os
import sys
from collections import Counter

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
DATASET = os.path.join(ROOT, "data", "selakovic-2016-issues")
WORK = os.path.abspath(os.path.dirname(__file__))
EXTRACTED = os.path.join(WORK, "extracted.jsonl")
EQUIV_INPUT = os.path.join(WORK, "equiv-input.jsonl")
TIMEOUT_MS = 15_000

SMALL_KINDS = {"changed-fn", "body"}
EQUIV_FIELDS = ("id", "setup", "slow", "fast")
HINT_FIELDS = ("environment", "aspect", "candidate_kind", "enclosure_type")


def issue_dir_for(rec_id: str) -> str | None:
    """`<topcat>/<libcat>/.../issue_X#k` 形の id から issue ディレクトリの絶対パスを得る。"""
    base = rec_id.split("#", 1)[0]
    parts = base.split("/")
    if len(parts) < 3:
        return None
    topcat, libcat, issuedir = parts[0], parts[1], parts[-1]
    return os.path.join(DATASET, topcat, libcat, "issues", issuedir)


def main() -> int:
    lines: list[str] = []
    n_total = n_excluded = n_no_dir = n_skip_kind = 0
    kind_counter: Counter[str] = Counter()
    with open(EXTRACTED) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            n_total += 1
            d = json.loads(line)
            if d.get("excluded"):
                n_excluded += 1
                continue
            kind = d.get("candidate_kind")
            kind_counter[str(kind)] += 1
            if kind not in SMALL_KINDS:
                n_skip_kind += 1
                continue
            out: dict = {k: (d.get(k) or "" if k == "setup" else d.get(k)) for k in EQUIV_FIELDS}
            out["timeout_ms"] = TIMEOUT_MS
            for k in HINT_FIELDS:
                v = d.get(k)
                if v is not None:
                    out[k] = v
            issue_dir = issue_dir_for(d.get("id", ""))
            if issue_dir is not None and os.path.isdir(issue_dir):
                out["module_base_dir"] = issue_dir
                # mount_html は embedded (`single`/`lib`/`body`) 候補用 — それらは browser context (v_*.html) 前提で組まれてる。
                # changed-fn 候補は self-contained (`setup` に dep 連結済 / `slow`/`fast` に workload 抽出済) なので、
                # v_*.html を mount すると <script src> / inline <script> (= `execute(f1)` / `$.ajax({mark})`) が二重に走って害になりうる → 渡さない。
                if d.get("environment") == "jsdom" and kind != "changed-fn":
                    v_html = os.path.join(issue_dir, "v_before.html")
                    if os.path.isfile(v_html):
                        with open(v_html) as hf:
                            out["mount_html"] = hf.read()
            else:
                n_no_dir += 1
                print(f"[warn] no issue dir for {d.get('id')!r} -> {issue_dir}", file=sys.stderr)
            lines.append(json.dumps(out))

    with open(EQUIV_INPUT, "w") as f:
        if lines:
            f.write("\n".join(lines) + "\n")
    print(
        f"extracted total={n_total} excluded={n_excluded} candidate_kinds={dict(kind_counter)}\n"
        f"  -> kept(kind in {sorted(SMALL_KINDS)})={len(lines)} skipped_kind={n_skip_kind} (no_dir={n_no_dir})"
        f"  -> {EQUIV_INPUT}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
