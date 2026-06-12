import { VISITOR_KEYS } from "@babel/types";
import type { Node } from "@babel/types";

/**
 * Babel AST を `VISITOR_KEYS` ベースで深さ優先に走査する共通機構。
 *
 * 判断: ai-guide/adr/0001-pruning-ast-traversal.md
 */

export interface VisitContext {
  readonly node: Node;
  readonly parent: Node | null;
  readonly parentKey: string | null;
  readonly listIndex: number | undefined;
  /**
   * root から自分の親までの path (配列順)。アクセス時に内部スタックを slice したコピーを
   * 返し、同一 visit 内で複数回読んでも同じ配列を返す (1 回目でキャッシュ)。返る配列は
   * 内部スタックから切り離されているため、参照を保存しても後続の traversal で改変されない。
   */
  readonly ancestors: readonly Node[];
}

/**
 * `root` を起点に AST を DFS 走査し、各ノードで `visit` を呼ぶ。
 *
 * `ancestors` は root から自分の親までの path。`parent` / `parentKey` / `listIndex` は
 * root では `null` / `null` / `undefined` で、子に降りる際に親情報が埋まる。配列子
 * (`body[i]` 等) では `listIndex` が付き、単一子では `undefined`。子が `null` /
 * `undefined` の slot や Node でないリーフ (リテラル値等) は skip する。
 *
 * 実装メモ: 内部では祖先を可変スタックで持ち、`ancestors` getter が初回読みで slice
 * してキャッシュする。ancestors を読まない visit にはコピーコストが発生しない。
 */
export function walkNodes(root: Node, visit: (ctx: VisitContext) => void): void {
  const stack: Node[] = [];
  function go(
    node: Node,
    parent: Node | null,
    parentKey: string | null,
    listIndex: number | undefined,
  ): void {
    let snapshot: readonly Node[] | undefined;
    visit({
      node,
      parent,
      parentKey,
      listIndex,
      get ancestors(): readonly Node[] {
        return (snapshot ??= stack.slice());
      },
    });
    const visitorKeys = VISITOR_KEYS[node.type] ?? [];
    const record = node as unknown as Record<string, unknown>;
    stack.push(node);
    for (const key of visitorKeys) {
      const child = record[key];
      if (child === null || child === undefined) continue;
      if (Array.isArray(child)) {
        for (let i = 0; i < child.length; i++) {
          const c = child[i] as unknown;
          if (isNode(c)) go(c, node, key, i);
        }
      } else if (isNode(child)) {
        go(child, node, key, undefined);
      }
    }
    stack.pop();
  }
  go(root, null, null, undefined);
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

// 判断: ai-guide/adr/0007-in-source-testing-internal-helpers.md
if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;

  const stubNode = (type: string, extra: Record<string, unknown> = {}): Node =>
    ({ type, ...extra }) as unknown as Node;

  describe("walkNodes (in-source)", () => {
    it("root は parent=null / parentKey=null / listIndex=undefined / ancestors=[] で visit される", () => {
      const visited: VisitContext[] = [];
      walkNodes(stubNode("Identifier"), (ctx) => visited.push(ctx));
      expect(visited).toHaveLength(1);
      expect(visited[0]?.parent).toBeNull();
      expect(visited[0]?.parentKey).toBeNull();
      expect(visited[0]?.listIndex).toBeUndefined();
      expect(visited[0]?.ancestors).toEqual([]);
    });

    it("VISITOR_KEYS に登録の無い型でも crash せず単発で終わる", () => {
      const visited: VisitContext[] = [];
      expect(() =>
        walkNodes(stubNode("__UnknownNonStandardType__"), (ctx) => visited.push(ctx)),
      ).not.toThrow();
      expect(visited).toHaveLength(1);
    });

    it("ancestors は visit 後に他ノードを traverse しても改変されない (detached snapshot)", () => {
      // BinaryExpression を VISITOR_KEYS なしで簡易組立: root.body=[child] を Program 風に作る
      const child1 = stubNode("Identifier", { name: "a" });
      const child2 = stubNode("Identifier", { name: "b" });
      const root = stubNode("Program", { body: [child1, child2] });

      const captured: { node: Node; ancestors: readonly Node[] }[] = [];
      walkNodes(root, ({ node, ancestors }) => {
        captured.push({ node, ancestors });
      });

      // root: ancestors=[], child1: ancestors=[root], child2: ancestors=[root]
      // 全 visit 後に保存済みの ancestors を確認 — pop されても snapshot は無傷
      expect(captured[0]?.ancestors).toEqual([]);
      expect(captured[1]?.ancestors).toEqual([root]);
      expect(captured[2]?.ancestors).toEqual([root]);
    });

    it("同一 visit 内で ancestors を 2 回読むと同じ配列が返る (cache)", () => {
      const child = stubNode("Identifier", { name: "x" });
      const root = stubNode("Program", { body: [child] });

      let firstReadAtChild: readonly Node[] | undefined;
      let secondReadAtChild: readonly Node[] | undefined;
      walkNodes(root, ({ node, ancestors }) => {
        if (node === child) {
          firstReadAtChild = ancestors;
          secondReadAtChild = ancestors;
        }
      });
      expect(firstReadAtChild).toBe(secondReadAtChild);
    });
  });

  describe("isNode (in-source)", () => {
    it("`{ type: string }` の object は Node 扱い", () => {
      expect(isNode({ type: "Identifier" })).toBe(true);
    });

    it("type を持たない object / null / プリミティブは false", () => {
      expect(isNode({ name: "x" })).toBe(false);
      expect(isNode(null)).toBe(false);
      expect(isNode("Identifier")).toBe(false);
      expect(isNode(undefined)).toBe(false);
    });

    it("type が string でない場合は false", () => {
      expect(isNode({ type: 42 })).toBe(false);
    });
  });
}
