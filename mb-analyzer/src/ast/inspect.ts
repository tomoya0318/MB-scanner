import type { Node } from "@babel/types";

import { tryGenerateNode } from "./parser";
import { walkNodes } from "./walk";

/**
 * AST 上のノード集計・元コード抽出など、副作用なしの read-only 検査ユーティリティ。
 * 機能間で共有 (preprocessing の `countNodes` 重複もここで解消)。
 */

/**
 * 任意の AST ノードを root として、subtree に含まれるノード総数を `VISITOR_KEYS` ベースで数える。
 * `File` も `Node` の subtype なので、ファイル全体・関数 body・任意の subtree いずれの粒度でも呼べる。
 * `comments` / `tokens` のように `type` を持つが Node ではないメタ情報は対象外。
 */
export function countNodes(node: Node): number {
  let count = 0;
  walkNodes(node, () => {
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
 * 関数 / メソッドノードの param 名のリスト。`Identifier` 以外のパターン (Rest / Object pattern 等)
 * は `$x` プレースホルダで埋める (= preprocessing の changed-fn 経路で「形だけ揃えた仮の名前」)。
 */
export function paramNames(fnNode: Node): string[] {
  return ((fnNode as unknown as { params?: Array<{ type: string; name?: string }> }).params ?? []).map((p) =>
    p.type === "Identifier" && p.name ? p.name : "$x",
  );
}

/**
 * `fnNode` の本体 (BlockStatement) を返す。arrow `=> expr` 等で BlockStatement でなければ `null`。
 * `start` / `end` も非 number なら `null` を返す (= 後段で `body.start..body.end` の span を使えない形)。
 */
export function functionBlockBody(fnNode: Node): { type: string; start: number; end: number; body: Node[] } | null {
  const b = (fnNode as unknown as { body?: { type?: string; start?: number; end?: number; body?: Node[] } }).body;
  if (!b || b.type !== "BlockStatement" || typeof b.start !== "number" || typeof b.end !== "number") return null;
  return b as { type: string; start: number; end: number; body: Node[] };
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
  const { walkNodes } = await import("./walk");

  const nodeTypeOf = (n: Node | undefined): string | undefined =>
    (n as unknown as { type?: string } | undefined)?.type;

  /** `parse(src)` から最初に見つかる FunctionExpression/FunctionDeclaration を返す。 */
  const firstFn = (src: string): Node => {
    const ast = parse(src);
    let found: Node | null = null;
    walkNodes(ast, ({ node }) => {
      if (found) return;
      const t = nodeTypeOf(node);
      if (t === "FunctionExpression" || t === "FunctionDeclaration") found = node;
    });
    if (!found) throw new Error("no function found");
    return found;
  };

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

    it("任意の subtree (関数 body) も数える: subtree のノード数は File 全体より小さい", () => {
      const file = parse("function f(x) { return x + 1; }");
      const fn = firstFn("function f(x) { return x + 1; }");
      const body = functionBlockBody(fn)!;
      expect(countNodes(body as unknown as Node)).toBeGreaterThan(0);
      expect(countNodes(body as unknown as Node)).toBeLessThan(countNodes(file));
    });
  });

  describe("paramNames (in-source)", () => {
    it("Identifier param はそのまま名前を返す", () => {
      const fn = firstFn("function f(a, b, c) {}");
      expect(paramNames(fn)).toEqual(["a", "b", "c"]);
    });

    it("Identifier 以外のパターン (Rest / Object pattern) は $x プレースホルダになる", () => {
      const fn = firstFn("function f(a, ...rest) {}");
      const names = paramNames(fn);
      expect(names[0]).toBe("a");
      expect(names[1]).toBe("$x");
    });

    it("引数ゼロは空配列", () => {
      const fn = firstFn("function f() {}");
      expect(paramNames(fn)).toEqual([]);
    });
  });

  describe("functionBlockBody (in-source)", () => {
    it("通常の関数は BlockStatement を返し、span が取れる", () => {
      const fn = firstFn("function f() { return 1; }");
      const body = functionBlockBody(fn);
      expect(body).not.toBeNull();
      expect(body!.type).toBe("BlockStatement");
      expect(typeof body!.start).toBe("number");
      expect(typeof body!.end).toBe("number");
      expect(body!.body.length).toBeGreaterThan(0);
    });

    it("arrow の expression body (=> expr) は null を返す", () => {
      const ast = parse("const f = (x) => x + 1;");
      let arrow: Node | null = null;
      walkNodes(ast, ({ node }) => {
        if (!arrow && nodeTypeOf(node) === "ArrowFunctionExpression") arrow = node;
      });
      expect(arrow).not.toBeNull();
      expect(functionBlockBody(arrow!)).toBeNull();
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
