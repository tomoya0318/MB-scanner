#!/usr/bin/env python3
"""pruning 出力の placeholder を統合・reindex する後処理 (ADR-0023 D-δ Phase 2)。

pruning は AST の identifier node ごとに別 placeholder (`$P6 / $P7 / $P8`) を立てるので、
同じ binding を指す identifier (例: `obj` × 3 出現) が複数 placeholder に分裂する。
これは「各位置で独立に置き換えられる」と読めるが、実際は同じ binding を指すので
「ここは同じものでなければならない」が正しい制約。

本スクリプトは ``prune-results.jsonl`` の各 row について:
  1. ``placeholders`` を ``(kind, original_snippet)`` で group by
  2. ``kind=identifier`` のグループは複数 placeholder を 1 つに集約 (= 同 binding 統合)
  3. 残った placeholder を ``$P0, $P1, ...`` に reindex
  4. ``pattern_code`` 内の ``$Pn`` 参照を新 id で書き換え
  5. ``kind=expression`` / ``kind=statement`` は触らない (= 偶然一致リスク回避、保守的に identifier のみ)

出力は別 jsonl (``prune-results-normalized.jsonl``) として書き出し、元 artifact は不変。

usage:
  python research/research/preprocess_workload_reachability/code/normalize_pattern.py
  python research/research/preprocess_workload_reachability/code/normalize_pattern.py --format=md
"""

from __future__ import annotations

import argparse
import dataclasses
import json
import os
import re
import sys
from collections.abc import Iterable

WORK = os.path.abspath(os.path.dirname(__file__))
DEFAULT_INPUT = os.path.join(WORK, "prune-results.jsonl")
DEFAULT_OUTPUT = os.path.join(WORK, "prune-results-normalized.jsonl")

# `$Pn` 参照の正規表現。negative lookahead `(?!\d)` で `$P10` を `$P1` と誤マッチさせない
# (= 降順処理を強制する代わりに正規表現側で安全化、判断 e: 軸 6)。
PLACEHOLDER_REF_RE = re.compile(r"\$P(\d+)(?!\d)")


@dataclasses.dataclass(frozen=True)
class NormalizeStats:
    """1 行分の統合効果の生データ。

    ``before`` / ``after`` は placeholder の個数。``before == 0`` の行は集計から除外
    (= pruning が pattern_code を生成しなかった行)。
    """

    row_id: str | None
    before: int
    after: int


def _placeholder_index(placeholder_id: str) -> int:
    """``$P0`` → ``0``、``$P10`` → ``10`` を返す。形式違反は -1 (= sort 時に先頭)。"""
    m = re.fullmatch(r"\$P(\d+)", placeholder_id)
    return int(m.group(1)) if m else -1


def normalize_row(row: dict) -> tuple[dict, NormalizeStats]:
    """1 行を正規化して (new_row, stats) を返す。

    入力 row が ``placeholders`` / ``pattern_code`` を持たないなら ``before==0`` の stats を返し、
    row は (placeholders / pattern_code に手を入れずに) ほぼそのまま返す。
    """
    placeholders = row.get("placeholders") or []
    pattern_code = row.get("pattern_code")
    if not placeholders or pattern_code is None:
        return row, NormalizeStats(row_id=row.get("id"), before=0, after=0)

    # (kind, original_snippet) で group by。dict の挿入順序を保持 (= 元 placeholder の出現順)
    groups: dict[tuple[str, str], list[dict]] = {}
    for p in placeholders:
        key = (p["kind"], p["original_snippet"])
        groups.setdefault(key, []).append(p)

    # 各元 id → 代表 id (= 同 binding 統合後の id) のマッピング。
    # kind=identifier の重複 group のみ統合、expression / statement は触らない (判断 b1)
    rep_map: dict[str, str] = {}
    for (kind, _snippet), members in groups.items():
        if kind == "identifier" and len(members) > 1:
            rep = min(members, key=lambda m: _placeholder_index(m["id"]))
            for m in members:
                rep_map[m["id"]] = rep["id"]
        else:
            for m in members:
                rep_map[m["id"]] = m["id"]

    # 統合後の distinct 代表 placeholder を「元 id 番号の昇順」で並べ、$P0, $P1, ... に reindex
    distinct_rep_ids = sorted(set(rep_map.values()), key=_placeholder_index)
    reindex_map = {rep_id: f"$P{i}" for i, rep_id in enumerate(distinct_rep_ids)}

    # 最終 mapping: 元 id → 最終新 id (rep_map → reindex_map の合成)
    final_id_map: dict[str, str] = {old_id: reindex_map[rep_id] for old_id, rep_id in rep_map.items()}

    # pattern_code 内の $Pn 参照を一括置換。negative lookahead で `$P10` を `$P1` と誤マッチさせない
    def _replace(match: re.Match[str]) -> str:
        old_id = match.group(0)
        return final_id_map.get(old_id, old_id)

    new_pattern_code = PLACEHOLDER_REF_RE.sub(_replace, pattern_code)

    # placeholders 配列を rebuild ($P0, $P1, ... 順、original_snippet / kind は代表元のものを継承)
    id_to_orig = {p["id"]: p for p in placeholders}
    new_placeholders = [
        {
            "id": reindex_map[rep_id],
            "kind": id_to_orig[rep_id]["kind"],
            "original_snippet": id_to_orig[rep_id]["original_snippet"],
        }
        for rep_id in distinct_rep_ids
    ]

    new_row = dict(row)
    new_row["pattern_code"] = new_pattern_code
    new_row["placeholders"] = new_placeholders

    return new_row, NormalizeStats(
        row_id=row.get("id"),
        before=len(placeholders),
        after=len(new_placeholders),
    )


def _load_jsonl(path: str) -> list[dict]:
    out: list[dict] = []
    with open(path) as f:
        for line in f:
            line = line.strip()
            if line:
                out.append(json.loads(line))
    return out


def _write_jsonl(rows: Iterable[dict], path: str) -> int:
    n = 0
    with open(path, "w") as f:
        for row in rows:
            f.write(json.dumps(row, ensure_ascii=False))
            f.write("\n")
            n += 1
    return n


def _summarize(stats_list: list[NormalizeStats]) -> dict[str, object]:
    """統合効果の集計。

    ``before == 0`` の行 (= pattern_code 無し) は分母から除く。
    """
    effective = [s for s in stats_list if s.before > 0]
    n_effective = len(effective)
    n_reduced = sum(1 for s in effective if s.after < s.before)
    total_before = sum(s.before for s in effective)
    total_after = sum(s.after for s in effective)

    avg_before = (total_before / n_effective) if n_effective else 0.0
    avg_after = (total_after / n_effective) if n_effective else 0.0
    overall_reduction_ratio = (1 - total_after / total_before) if total_before else 0.0

    per_row_ratios = [(1 - s.after / s.before) for s in effective if s.before > 0]
    max_reduction_ratio = max(per_row_ratios) if per_row_ratios else 0.0
    max_row = max(effective, key=lambda s: (1 - s.after / s.before) if s.before else 0.0, default=None)

    return {
        "n_rows_total": len(stats_list),
        "n_rows_with_pattern": n_effective,
        "n_rows_reduced": n_reduced,
        "total_placeholders_before": total_before,
        "total_placeholders_after": total_after,
        "avg_placeholders_before": avg_before,
        "avg_placeholders_after": avg_after,
        "overall_reduction_ratio": overall_reduction_ratio,
        "max_reduction_ratio": max_reduction_ratio,
        "max_reduction_row_id": max_row.row_id if max_row and max_row.before > 0 else None,
    }


def _format_md(summary: dict[str, object]) -> str:
    return "\n".join(
        [
            "## normalize_pattern: identifier placeholder 統合 (ADR-0023 D-δ Phase 2)",
            "",
            f"- 入力行数 (全 verdict): {summary['n_rows_total']}",
            f"- pattern_code を持つ行数: {summary['n_rows_with_pattern']}",
            f"- 統合で削減された行数: {summary['n_rows_reduced']}",
            f"- placeholder 個数 (合計): before {summary['total_placeholders_before']} → after {summary['total_placeholders_after']}",
            f"- placeholder 個数 (平均): before {summary['avg_placeholders_before']:.2f} → after {summary['avg_placeholders_after']:.2f}",
            f"- 全体削減率: {summary['overall_reduction_ratio'] * 100:.1f}%",
            f"- 最大削減率 (行単位): {summary['max_reduction_ratio'] * 100:.1f}% (id={summary['max_reduction_row_id']})",
            "",
        ]
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--input", default=DEFAULT_INPUT, help="prune-results.jsonl の path")
    parser.add_argument("--output", default=DEFAULT_OUTPUT, help="正規化後の jsonl 出力先")
    parser.add_argument("--format", choices=["md", "json"], default="md", help="stdout サマリ形式")
    args = parser.parse_args()

    if not os.path.isfile(args.input):
        print(f"input not found: {args.input}", file=sys.stderr)
        return 1

    rows = _load_jsonl(args.input)
    normalized_rows: list[dict] = []
    stats_list: list[NormalizeStats] = []
    for row in rows:
        new_row, stats = normalize_row(row)
        normalized_rows.append(new_row)
        stats_list.append(stats)

    n_written = _write_jsonl(normalized_rows, args.output)
    summary = _summarize(stats_list)
    summary["output_path"] = args.output
    summary["n_rows_written"] = n_written

    if args.format == "json":
        print(json.dumps(summary, indent=2, ensure_ascii=False))
    else:
        print(_format_md(summary))
    return 0


if __name__ == "__main__":
    sys.exit(main())
