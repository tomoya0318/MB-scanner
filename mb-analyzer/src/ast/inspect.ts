import type { File, Node } from "@babel/types";

import { tryGenerateNode } from "./parser";
import { walkNodes } from "./walk";

/**
 * AST 上のノード集計・元コード抽出など、副作用なしの read-only 検査ユーティリティ。
 * 機能間で共有 (preprocessing の `countNodes` 重複もここで解消)。
 */

/**
 * File に含まれる AST ノード総数を `VISITOR_KEYS` ベースで数える。
 * `comments` / `tokens` のように `type` を持つが Node ではないメタ情報は対象外。
 */
export function countNodes(file: File): number {
  let count = 0;
  walkNodes(file, () => {
    count += 1;
  });
  return count;
}

/**
 * `node.end - node.start` のソース上のサイズ (バイト数)。位置が未付与なら 0。
 */
export function nodeSize(node: Node): number {
  const start = node.start ?? 0;
  const end = node.end ?? 0;
  return end - start;
}

/**
 * 候補ノードの元スニペットを再構成する。start/end が取れれば元コードから切り出し、
 * 取れなければ generate で近似。pruning の placeholder original_snippet などで使う。
 */
export function snippetOfNode(node: Node, sourceCode: string): string {
  const start = node.start;
  const end = node.end;
  if (typeof start === "number" && typeof end === "number" && end >= start) {
    return sourceCode.slice(start, end);
  }
  return tryGenerateNode(node);
}

// 判断: ai-guide/adr/0007-in-source-testing-internal-helpers.md
if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;
  const { numericLiteral } = await import("@babel/types");
  const { parse } = await import("./parser");

  describe("countNodes (in-source)", () => {
    it("空 File は最低限の構造ノード (File / Program) を数える", () => {
      const file = parse("");
      expect(countNodes(file)).toBe(2);
    });

    it("単純な statement のノード数を数える", () => {
      const file = parse("const x = 1;");
      expect(countNodes(file)).toBe(6);
    });

    it("ノード数は構造の複雑さに応じて増える", () => {
      const simple = parse("x;");
      const complex = parse("if (a) { f(b, c); } else { g(d); }");
      expect(countNodes(complex)).toBeGreaterThan(countNodes(simple));
    });

    it("入れ子は再帰的に数える", () => {
      const flat = parse("a + b;");
      const nested = parse("a + b + c + d;");
      expect(countNodes(nested)).toBeGreaterThan(countNodes(flat));
    });
  });

  describe("snippetOfNode (in-source)", () => {
    it("start/end が取れる場合は元ソースから正確に切り出す", () => {
      const code = "const x = arr[0]; use(x);";
      const file = parse(code);
      const decl = file.program.body[0];
      expect(decl?.type).toBe("VariableDeclaration");
      expect(snippetOfNode(decl as Node, code)).toBe("const x = arr[0];");
    });

    it("内側ノードでも正確に切り出す", () => {
      const code = "const x = arr[0]; use(x);";
      const file = parse(code);
      const decl = file.program.body[0];
      if (decl?.type !== "VariableDeclaration") throw new Error("unexpected");
      const init = decl.declarations[0]?.init;
      expect(init?.type).toBe("MemberExpression");
      expect(snippetOfNode(init as Node, code)).toBe("arr[0]");
    });

    it("start/end が無いノードは generate で近似する", () => {
      const node = numericLiteral(42);
      const snippet = snippetOfNode(node, "");
      expect(snippet).toBe("42");
    });

    it("generate も失敗するような不完全ノードは空文字を返す (defensive)", () => {
      const broken = { type: "NotARealType" } as unknown as Node;
      expect(snippetOfNode(broken, "")).toBe("");
    });
  });
}
