#!/usr/bin/env python3
"""tmp/0022_.../ 内の `*.jsonl` を人間可読な `*.json` (配列形式 + indent=2) に変換する。

Phase 5 のまとめ作業用 — `extracted` / `equiv-{input,results}` / `prune-{input,results}` を
配列形式の json に直して、`equiv-results.error` / `prune-results.error` だけ抜いた
`*-errors.json` も吐く (error 原因分類の手元材料)。

usage (brain-2 docker の ~/workspace から):
  uv run python tmp/0022_preprocess-workload-reachability-redesign/jsonl_to_json.py

戻し:
  rsync -av brain-2:/mnt/data1/tomoya-n/MB-Scanner/tmp/0022_preprocess-workload-reachability-redesign/ \
            tmp/0022_preprocess-workload-reachability-redesign/
"""
from __future__ import annotations

import json
import os
import sys

WORK = os.path.abspath(os.path.dirname(__file__))
# 変換対象 (存在しないファイルは skip)
TARGETS = (
    "extracted.jsonl",
    "equiv-input.jsonl",
    "equiv-results.jsonl",
    "prune-input.jsonl",
    "prune-results.jsonl",
)
# 結果系で error だけ抜き出すサブセット (verdict == "error")
ERROR_SUBSETS = ("equiv-results.jsonl", "prune-results.jsonl")


def convert(jsonl_path: str) -> int:
    """`jsonl_path` を `<same>.json` (配列) に変換し、record 数を返す。"""
    records: list[dict] = []
    with open(jsonl_path) as f:
        for i, line in enumerate(f, 1):
            line = line.strip()
            if not line:
                continue
            try:
                records.append(json.loads(line))
            except json.JSONDecodeError as e:
                print(f"[warn] {os.path.basename(jsonl_path)} L{i}: {e}", file=sys.stderr)
    out_path = jsonl_path[: -len(".jsonl")] + ".json"
    with open(out_path, "w") as f:
        json.dump(records, f, indent=2, ensure_ascii=False)
        f.write("\n")
    return len(records)


def extract_errors(jsonl_path: str) -> int:
    """`verdict == "error"` の record だけ抜いて `<basename>-errors.json` に書く。"""
    errors: list[dict] = []
    with open(jsonl_path) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            d = json.loads(line)
            if d.get("verdict") == "error":
                errors.append(d)
    base = jsonl_path[: -len(".jsonl")]
    out_path = base + "-errors.json"
    with open(out_path, "w") as f:
        json.dump(errors, f, indent=2, ensure_ascii=False)
        f.write("\n")
    return len(errors)


def main() -> int:
    total = 0
    for name in TARGETS:
        path = os.path.join(WORK, name)
        if not os.path.isfile(path):
            print(f"[skip] {name} (not found)")
            continue
        n = convert(path)
        total += n
        print(f"  {name} -> {name[:-1]}  ({n} records)")
        if name in ERROR_SUBSETS:
            n_err = extract_errors(path)
            print(f"    + {name[:-len('.jsonl')]}-errors.json  ({n_err} error records)")
    print(f"\n  total records converted = {total}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
