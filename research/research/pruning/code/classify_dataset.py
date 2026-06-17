#!/usr/bin/env python3
"""dataset 97 issue を「論文 10 パターン該当 / 非該当 (one-off)」に分類し、pruned 状況とクロスする。

分類は dataset の Description.md (RQ1 表) に書かれた最適化内容に基づく手動キュレーション。
各 issue を 10 パターン (pattern_map.PATTERNS) のいずれかに割り当て、該当しないものは other。
borderline (for-in 系だが →Object.keys でない等) は別途注記。

目的 (スライド用): 論文が再発パターンとしてカタログ化した枠 (P1-P10) に対する我々の到達率と、
カタログ外 one-off 最適化で pruning が pattern_code を生成できた件数 (= 固定カタログを超えた増分) を出す。
"""

from __future__ import annotations

import json

import pattern_map as pm

# Description.md の最適化内容に基づく 10 パターン該当 issue (full id)。
# コメントは Description.md の該当記述。
PATTERN_MEMBERS: dict[str, int] = {
    # P1: for-in (+hop) → Object.keys/for
    "clientIssues/AngularIssues/issue_7012": 1,  # Use Object.keys instead of for in + hop
    "clientIssues/AngularIssues/issue_7759_3": 1,  # Replace for in with hop with Object.keys
    "clientIssues/EmberIssues/issue_11338": 1,  # Avoid for in loop, use Object.keys
    "clientServerIssues/UnderscoreIssues/issue_1222": 1,  # Replace for in with .keys + for
    "clientServerIssues/UnderscoreIssues/issue_1223": 1,  # 同上
    "clientServerIssues/UnderscoreIssues/issue_1224": 1,  # 同上
    # P2: substr(i,1) → str[i]
    "clientServerIssues/EjsIssues/issue_136b": 2,  # Replaced string.substr(i,1) with string[i]
    # P3: String(v) → ''+v
    "clientServerIssues/Underscore.stringIssues/issue_347_1": 3,  # implicit string conversion instead of String wrapper
    # P4: html('') → empty()
    "clientIssues/AngularIssues/issue_4457": 4,  # Empty() or Html("")
    # P5: substr(0,2) → charAt 2回
    "clientIssues/AngularIssues/issue_5457": 5,  # Two calls to CharAt instead of substr
    # P6: split.join → replace
    "clientServerIssues/UnderscoreIssues/issue_39": 6,  # Replace split.join with replace
    # P7: toString.call → instanceof
    "clientIssues/AngularIssues/issue_7735": 7,  # Native isArray instead of toString call
    "serverIssues/MochaIssues/issue_701": 7,  # Use instanceof instead of toString.call(err)
    # P8: x%2 → x&1
    "clientIssues/AngularIssues/issue_4359": 8,  # Use &1 instead of %2
    # P9: reduce → for
    "serverIssues/ChalkIssues/issue_28": 9,  # Replace reduce() with explicit for loop
    # P10: slice.call(args).join 単一要素特化
    "serverIssues/ChalkIssues/issue_27a": 10,  # Don't concat args with slice.join if single arg
}

# borderline: パターンに近いが厳密一致しない (集計では other 扱い、注記のみ)
BORDERLINE: dict[str, str] = {
    "clientIssues/EmberIssues/issue_4329_1": "P1類 (for-in回避だが→direct access, Object.keysでない)",
    "clientServerIssues/Underscore.stringIssues/issue_347_2": "P2/P5類 (slice回避→indexOf/lastIndexOf)",
    "clientServerIssues/NodeLruCacheIssues/issue_8": "P1逆 (Object.keys[i]→for-in)",
    "serverIssues/Socket.ioIssues/issue_689": "P2類 (二つのsubstring呼びを一つに)",
}


def main():
    ext = [json.loads(l) for l in open(pm.STAGES["extracted"]) if l.strip()]
    all_ids = [r["id"] for r in ext]
    s = json.load(open("/tmp/stage_sets.json"))
    eqin, iv, pruned = set(s["eqin"]), s["iv"], set(s["pruned"])

    def status(iid: str) -> str:
        if iid in pruned:
            return "pruned"
        if iid in eqin:
            v = iv.get(iid, "?")
            return f"equiv:{v}" if v != "equal" else "equal/未pruned"
        return "射影非到達"

    in_pat = [i for i in all_ids if i in PATTERN_MEMBERS]
    other = [i for i in all_ids if i not in PATTERN_MEMBERS]

    print("# dataset 97 issue: 10パターン該当 vs カタログ外\n")
    print(f"- 総数 {len(all_ids)} / 10パターン該当 **{len(in_pat)}** / カタログ外 **{len(other)}**")
    print(f"- 全体 pruned 到達 {len(pruned)}\n")

    # パターン該当の内訳
    print("## A. 論文10パターン該当 issue (分母)\n")
    print("| P | issue | 段階 |")
    print("|---|-------|------|")
    by_p: dict[int, list[str]] = {}
    for iid in in_pat:
        p = PATTERN_MEMBERS[iid]
        by_p.setdefault(p, []).append(iid)
        print(f"| P{p} | {iid.split('/')[-1]} | {status(iid)} |")
    in_pat_pruned = [i for i in in_pat if i in pruned]
    print(f"\n→ 該当 {len(in_pat)} 件中 **pruned 到達 {len(in_pat_pruned)}** ({100*len(in_pat_pruned)//len(in_pat)}%)")

    # カタログ外で pruned 到達 = 増分
    other_pruned = [i for i in other if i in pruned]
    print("\n## B. カタログ外 one-off で pruned 到達 (= 固定カタログを超えた増分)\n")
    print(f"カタログ外 {len(other)} 件中 **pruned 到達 {len(other_pruned)}** 件\n")
    print("| issue | 段階 | borderline? |")
    print("|-------|------|------|")
    for iid in other_pruned:
        bl = BORDERLINE.get(iid, "")
        print(f"| {iid.split('/')[-1]} ({iid.split('/')[1].replace('Issues','')}) | pruned | {bl} |")

    print("\n## サマリ\n")
    print(f"- pruned 総数 {len(pruned)} = パターン該当 {len(in_pat_pruned)} + カタログ外 {len(other_pruned)}")
    print(f"- 「従来の固定10パターンでは形にできなかった最適化を {len(other_pruned)} 件 pattern_code 化」")
    if BORDERLINE:
        print("\n### borderline (集計では other)\n")
        for iid, why in BORDERLINE.items():
            print(f"- {iid.split('/')[-1]}: {why} [{status(iid)}]")


if __name__ == "__main__":
    main()
