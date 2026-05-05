import { VISITOR_KEYS } from "@babel/types";
import type { Node } from "@babel/types";

/**
 * Babel AST を `VISITOR_KEYS` ベースで深さ優先に走査する共通機構。
 *
 * 機能間で重複していた walk ユーティリティをここに集約する (旧 `pruning/ast/walk.ts` /
 * `preprocessing/common/walk.ts`)。
 *
 * 判断: ai-guide/adr/0001-pruning-ast-traversal.md (旧場所だが内容は基盤層に共通)
 */

export interface VisitContext {
  readonly node: Node;
  readonly parent: Node | null;
  readonly parentKey: string | null;
  readonly listIndex: number | undefined;
  readonly ancestors: readonly Node[];
}

/**
 * `root` を起点に AST を DFS 走査し、各ノードで `visit` を呼ぶ。
 *
 * `ancestors` は root から自分の親までの path (配列順)。`parent` / `parentKey` /
 * `listIndex` は root では `null` / `null` / `undefined` で、子に降りる際に親情報が
 * 埋まる。配列子 (`body[i]` 等) では `listIndex` が付き、単一子では `undefined`。
 * 子が `null` / `undefined` の slot や Node でないリーフ (リテラル値等) は skip する。
 */
export function walkNodes(root: Node, visit: (ctx: VisitContext) => void): void {
  function go(
    node: Node,
    parent: Node | null,
    parentKey: string | null,
    listIndex: number | undefined,
    ancestors: readonly Node[],
  ): void {
    visit({ node, parent, parentKey, listIndex, ancestors });
    const visitorKeys = VISITOR_KEYS[node.type] ?? [];
    const record = node as unknown as Record<string, unknown>;
    const nextAncestors = [...ancestors, node];
    for (const key of visitorKeys) {
      const child = record[key];
      if (child === null || child === undefined) continue;
      if (Array.isArray(child)) {
        for (let i = 0; i < child.length; i++) {
          const c = child[i] as unknown;
          if (isNode(c)) go(c, node, key, i, nextAncestors);
        }
      } else if (isNode(child)) {
        go(child, node, key, undefined, nextAncestors);
      }
    }
  }
  go(root, null, null, undefined, []);
}

/**
 * Babel `Node` の型ガード。`comments` / `tokens` のように `type` を持つが Node では
 * ないメタ情報は通過しない。
 */
export function isNode(value: unknown): value is Node {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    typeof (value as { type: unknown }).type === "string"
  );
}
