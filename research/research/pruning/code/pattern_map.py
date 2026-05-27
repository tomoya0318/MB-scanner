#!/usr/bin/env python3
"""Selakovic & Pradel 2016 の 10 最適化パターン定義と、データセット issue への対応表。

本モジュールは pruning 段階検証の単一の真実源 (single source of truth):
- PATTERNS: 各パターンの before→after 概要、before-shape の regex、対応 issue id
- AST セレクタ条件は match_ast.mjs 側に同じ番号で実装 (言語が違うため定義は分散だが、番号と
  before_shape の意図はここに集約)

precondition (いつ適用してよいか) は対象外。各 regex は「変更前 (slow) の形」を検出する。

入力 jsonl は preprocess_workload_reachability/code/ を参照する。
"""

from __future__ import annotations

import json
import os

HERE = os.path.abspath(os.path.dirname(__file__))
# 既存パイプラインの結果置き場
DATA = os.path.abspath(os.path.join(HERE, "..", "..", "preprocess_workload_reachability", "code"))

STAGES = {
    "extracted": os.path.join(DATA, "extracted.jsonl"),
    "equiv_input": os.path.join(DATA, "equiv-input.jsonl"),
    "equiv_results": os.path.join(DATA, "equiv-results.jsonl"),
    "prune_input": os.path.join(DATA, "prune-input.jsonl"),
    "prune_results": os.path.join(DATA, "prune-results.jsonl"),
}

# 10 パターン。issues は full issue id (candidate suffix #n は付けない)。
PATTERNS: dict[int, dict] = {
    1: {
        "name": "for-in (+hasOwnProperty) → Object.keys/for",
        "before_shape": "for-in loop (任意で hasOwnProperty ガード)",
        # regex: ForIn の構文 + (任意) hasOwnProperty
        "regex": [r"for\s*\(\s*(?:var\s+)?[\w$.\[\]]+\s+in\b"],
        "regex_aux": [r"\.hasOwnProperty\s*\(", r"\.has\s*\("],
        "issues": [
            "clientIssues/AngularIssues/issue_7012",
            "clientIssues/AngularIssues/issue_7759_3",
            "clientIssues/EmberIssues/issue_11338",
            "clientServerIssues/UnderscoreIssues/issue_1222",
            "clientServerIssues/UnderscoreIssues/issue_1223",
            "clientServerIssues/UnderscoreIssues/issue_1224",
        ],
    },
    2: {
        "name": "str.substr(i,1) → str[i]",
        "before_shape": "substr の第2引数が 1",
        "regex": [r"\.substr\s*\(\s*[^,()]+,\s*1\s*\)"],
        "issues": ["clientServerIssues/EjsIssues/issue_136b"],
    },
    3: {
        "name": "String(v) → ''+v",
        "before_shape": "String(...) ラッパ呼び出し",
        "regex": [r"\bString\s*\("],
        "issues": ["clientServerIssues/Underscore.stringIssues/issue_347_1"],
    },
    4: {
        "name": ".html('') → .empty()",
        "before_shape": ".html('') 空文字呼び出し",
        "regex": [r"\.html\s*\(\s*(['\"])\1\s*\)"],
        "issues": ["clientIssues/AngularIssues/issue_4457"],
    },
    5: {
        "name": "substr(0,2) → charAt 2回",
        "before_shape": "substr(0, 2)",
        "regex": [r"\.substr\s*\(\s*0\s*,\s*2\s*\)"],
        "issues": ["clientIssues/AngularIssues/issue_5457"],
    },
    6: {
        "name": "split(x).join(y) → replace(/x/g,y)",
        "before_shape": "split(...).join(...) チェーン",
        # [^;)] で split() の閉じ括弧をまたがないよう制限 (無関係な `split(..), x).join` 誤検出を抑制)。
        # nested 括弧の split 引数は取りこぼすが、厳密な構造判定は AST backend (match_ast.mjs) に委ねる。
        "regex": [r"\.split\s*\([^;)]*\)\s*\.join\s*\("],
        "issues": ["clientServerIssues/UnderscoreIssues/issue_39"],
    },
    7: {
        "name": "toString.call(x)==='[object T]' → instanceof",
        "before_shape": "toString.call(...) または '[object T]' 比較",
        "regex": [r"toString\s*\.\s*call\s*\(", r"\[object\s+\w+\]"],
        "issues": [
            "clientIssues/AngularIssues/issue_7735",
            "serverIssues/MochaIssues/issue_701",
        ],
    },
    8: {
        "name": "x % 2 → x & 1",
        "before_shape": "剰余 % 2",
        "regex": [r"%\s*2\b"],
        "issues": ["clientIssues/AngularIssues/issue_4359"],
    },
    9: {
        "name": "arr.reduce(...) → for loop",
        "before_shape": ".reduce(...) 呼び出し",
        "regex": [r"\.reduce\s*\("],
        "issues": ["serverIssues/ChalkIssues/issue_28"],
    },
    10: {
        "name": "[].slice.call(arguments).join(' ') → 単一要素分岐",
        "before_shape": "[].slice.call(arguments).join(...)",
        "regex": [r"\[\s*\]\s*\.\s*slice\s*\.\s*call\s*\(\s*arguments\s*\)\s*\.\s*join\s*\("],
        "issues": ["serverIssues/ChalkIssues/issue_27a"],
    },
}


def load_jsonl(path: str) -> list[dict]:
    with open(path, encoding="utf-8") as f:
        return [json.loads(l) for l in f if l.strip()]


def issue_to_pattern() -> dict[str, int]:
    out = {}
    for n, p in PATTERNS.items():
        for iid in p["issues"]:
            out[iid] = n
    return out


if __name__ == "__main__":
    # 簡易自己診断: issue が extracted に在るか
    ext = {r["id"] for r in load_jsonl(STAGES["extracted"])}
    for n, p in PATTERNS.items():
        miss = [i for i in p["issues"] if i not in ext]
        print(f"P{n:<2} {p['name']}  issues={len(p['issues'])}  missing={miss}")
