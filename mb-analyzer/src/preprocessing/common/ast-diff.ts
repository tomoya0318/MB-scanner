import { VISITOR_KEYS } from "@babel/types";
import type { File, Node } from "@babel/types";

import { SubtreeSet } from "../../ast/subtree-hash";
import { isNode } from "../../ast/walk";

/**
 * GumTree top-down 流の subtree mapping で「最深 unmapped」 (= 自分自身は after に同型が
 * なく、子はすべて mapped または `unmapped かつ 子も mapped` ではない構造の境界) を返す。
 *
 * 「全 unmapped」を返すと祖先まで unmapped 判定されて minimal enclosure が Module 全体に
 * 上昇してしまう (root も子の hash が変わるためハッシュ非一致)。本実装は top-down 走査で
 * 「同型サブツリーが after に存在する最大単位」を mapped と扱い、その境界 (mapped 直上の
 * unmapped node) を変更点として返す。
 *
 * GumTree top-down との対応:
 * - heap based の matching を「after の subtree hash 集合に含まれるか」の判定に簡略化
 * - height ベースの優先度は「先に親をチェックし、mapped なら降りない」で代替
 * - 1:1 mapping の制約は省略 (after に複数同型がある場合も全部 mapped 扱い、precision は
 *   minimal enclosure 抽出には十分)
 *
 * 採用判断 (簡略版で十分):
 * - 厳密な GumTree は対応付けの 1:1 性を保証するが、本用途では「変更の境界を見つける」だけで
 *   十分。1:1 性が崩れても enclosure 計算結果は変わらない
 * - 実装複雑度を 1/5 程度に抑えられる
 */
export function findChangedNodes(before: File, after: File): Set<Node> {
  const afterSet = new SubtreeSet(after);
  const changed = new Set<Node>();
  visit(before, afterSet, changed);
  return changed;
}

/**
 * 戻り値: `node` 自身または子孫に unmapped があるか (= changed を引き起こすか)。
 *
 * 自分が mapped (after に同型 subtree がある) なら子は探索しない (子も mapped 扱い)。
 * 自分が unmapped で、子探索の結果すべての子が mapped (= 子孫に unmapped なし) なら、
 * 自分が「変更の最深境界」として `changed` に追加する。
 *
 * 子孫に unmapped がある場合は自分は changed に追加しない。子のいずれかに変更点が
 * 局所化されているため、自分は不要 (ancestor として LCA で吸収される)。
 */
function visit(node: Node, afterSet: SubtreeSet, changed: Set<Node>): boolean {
  if (afterSet.has(node)) return false;

  const visitorKeys = VISITOR_KEYS[node.type] ?? [];
  const record = node as unknown as Record<string, unknown>;
  let hasUnmappedDescendant = false;
  for (const key of visitorKeys) {
    const child = record[key];
    if (child === null || child === undefined) continue;
    if (Array.isArray(child)) {
      for (const c of child) {
        if (isNode(c)) {
          if (visit(c, afterSet, changed)) hasUnmappedDescendant = true;
        }
      }
    } else if (isNode(child)) {
      if (visit(child, afterSet, changed)) hasUnmappedDescendant = true;
    }
  }

  if (!hasUnmappedDescendant) {
    // 自分が境界 unmapped (子孫はすべて mapped) → 変更点
    changed.add(node);
  }
  return true;
}
