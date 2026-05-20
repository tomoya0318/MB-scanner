import { cloneNode, isIdentifier, isRestElement } from "@babel/types";
import type { Node, Statement } from "@babel/types";

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
 * before/after fn の param 列を「rename-only / identical / structural-diff」のいずれかに分類する。
 *
 * - 配列長違い / pattern type 違い → `structural-diff`
 * - 両側 `Identifier` で同名 → no-op (`identical` 維持)
 * - 両側 `Identifier` で異名 → `nameMap` に `before -> after` を登録 (`rename-only`)
 * - 両側 `RestElement` で `argument` が両側 Identifier → 同上
 * - `AssignmentPattern` (default 付き) / `ObjectPattern` / `ArrayPattern` / `TSParameterProperty` 等は `structural-diff`
 *   (default 内 identifier の意図せぬ rewrite を回避するための保守側、ADR-0023 D-γ §DROP 可視化緩和の MVP)
 *
 * `Identifier` の `name` ベース判定で、`typeAnnotation` などの TS 情報は比較しない (parser は TS plugin off)。
 */
export type ParamDiffResult =
  | { readonly kind: "identical" }
  | { readonly kind: "rename-only"; readonly nameMap: ReadonlyMap<string, string> }
  | { readonly kind: "structural-diff" };

export function classifyParamDiff(beforeFn: Node, afterFn: Node): ParamDiffResult {
  const before = (beforeFn as unknown as { params?: readonly Node[] }).params ?? [];
  const after = (afterFn as unknown as { params?: readonly Node[] }).params ?? [];
  if (before.length !== after.length) return { kind: "structural-diff" };
  const nameMap = new Map<string, string>();
  for (let i = 0; i < before.length; i++) {
    const b = before[i]!;
    const a = after[i]!;
    if (b.type !== a.type) return { kind: "structural-diff" };
    if (isIdentifier(b) && isIdentifier(a)) {
      if (b.name !== a.name) nameMap.set(b.name, a.name);
    } else if (isRestElement(b) && isRestElement(a)) {
      if (!isIdentifier(b.argument) || !isIdentifier(a.argument)) return { kind: "structural-diff" };
      if (b.argument.name !== a.argument.name) nameMap.set(b.argument.name, a.argument.name);
    } else {
      return { kind: "structural-diff" };
    }
  }
  return nameMap.size === 0 ? { kind: "identical" } : { kind: "rename-only", nameMap };
}

/**
 * `body` を deep clone し、`nameMap` (`before -> after`) に従って Identifier の `name` を書き換えた新 Statement 列を返す。
 * 元 AST は mutation しない。プロパティ名側 Identifier (`MemberExpression.property` の非 computed / `ObjectProperty.key`
 * `ObjectMethod.key` の非 computed) は変数参照ではないので除外する。scope-aware rewrite ではないので、param と同名の
 * 局所 binding (`VariableDeclarator.id` / inner fn の `id` / param) との collision は事前に `hasBindingCollision` で
 * 弾くこと。
 */
export function renameIdentifiersInStatements(
  body: readonly Statement[],
  nameMap: ReadonlyMap<string, string>,
): Statement[] {
  if (nameMap.size === 0) return body.slice();
  return body.map((stmt) => {
    const cloned = cloneNode(stmt, true, true);
    walkNodes(cloned, ({ node, parent, parentKey }) => {
      if (!isIdentifier(node)) return;
      if (parent) {
        if (parent.type === "MemberExpression" && parentKey === "property" && !parent.computed) return;
        if (
          (parent.type === "ObjectProperty" || parent.type === "ObjectMethod") &&
          parentKey === "key" &&
          !parent.computed
        ) {
          return;
        }
      }
      const replacement = nameMap.get(node.name);
      if (replacement !== undefined) node.name = replacement;
    });
    return cloned;
  });
}

/**
 * before body 内に、rename 元名 (`nameMap.keys()`) または rename 先名 (`nameMap.values()`) と衝突する
 * binding があれば `true`。scope-aware ではない保守的な安全弁で、衝突候補があれば呼び出し側で
 * `FN_PARAM_NAMES_MISMATCH` にデモートする。検出対象 binding は以下:
 *  - `VariableDeclarator.id` (`var/let/const`)
 *  - `FunctionDeclaration.id` / `FunctionExpression.id`
 *  - inner fn (`FunctionDeclaration|FunctionExpression|ArrowFunctionExpression`) の params
 *    (`Identifier` / `RestElement(Identifier)` / `AssignmentPattern(Identifier)`)
 *  - `CatchClause.param` (`Identifier` の場合のみ)
 *  - `ClassDeclaration.id` / `ClassExpression.id`
 *
 * 判断: ai-guide/adr/0027-changed-fn-rename-collision-guard.md (case A 採用)
 */
export function hasBindingCollision(
  body: readonly Statement[],
  nameMap: ReadonlyMap<string, string>,
): boolean {
  if (nameMap.size === 0) return false;
  const targets = new Set<string>([...nameMap.keys(), ...nameMap.values()]);
  let collided = false;
  for (const stmt of body) {
    walkNodes(stmt, ({ node }) => {
      if (collided) return;
      if (node.type === "VariableDeclarator") {
        if (isIdentifier(node.id) && targets.has(node.id.name)) collided = true;
        return;
      }
      if (node.type === "CatchClause") {
        if (node.param && isIdentifier(node.param) && targets.has(node.param.name)) {
          collided = true;
        }
        return;
      }
      if (node.type === "ClassDeclaration" || node.type === "ClassExpression") {
        if (node.id && targets.has(node.id.name)) collided = true;
        return;
      }
      if (
        node.type === "FunctionDeclaration" ||
        node.type === "FunctionExpression" ||
        node.type === "ArrowFunctionExpression"
      ) {
        if (node.type !== "ArrowFunctionExpression" && node.id && targets.has(node.id.name)) {
          collided = true;
          return;
        }
        for (const p of node.params) {
          if (isIdentifier(p) && targets.has(p.name)) {
            collided = true;
            return;
          }
          if (isRestElement(p) && isIdentifier(p.argument) && targets.has(p.argument.name)) {
            collided = true;
            return;
          }
          if (p.type === "AssignmentPattern" && isIdentifier(p.left) && targets.has(p.left.name)) {
            collided = true;
            return;
          }
        }
      }
    });
    if (collided) return true;
  }
  return false;
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

  describe("classifyParamDiff (in-source)", () => {
    it("同名 Identifier param → identical", () => {
      const a = firstFn("function f(x, y) { return x + y; }");
      const b = firstFn("function g(x, y) { return x * y; }");
      const r = classifyParamDiff(a, b);
      expect(r.kind).toBe("identical");
    });

    it("Identifier 名のみ差 → rename-only (nameMap に before→after)", () => {
      const a = firstFn("function f(x) { return x + 1; }");
      const b = firstFn("function g(y) { return y + 1; }");
      const r = classifyParamDiff(a, b);
      expect(r.kind).toBe("rename-only");
      if (r.kind === "rename-only") {
        expect(r.nameMap.get("x")).toBe("y");
        expect(r.nameMap.size).toBe(1);
      }
    });

    it("配列長違い → structural-diff", () => {
      const a = firstFn("function f(x) {}");
      const b = firstFn("function g(x, scale) {}");
      expect(classifyParamDiff(a, b).kind).toBe("structural-diff");
    });

    it("pattern type 違い (Identifier vs RestElement) → structural-diff", () => {
      const a = firstFn("function f(x) {}");
      const b = firstFn("function g(...x) {}");
      expect(classifyParamDiff(a, b).kind).toBe("structural-diff");
    });

    it("両側 RestElement で argument 名のみ差 → rename-only", () => {
      const a = firstFn("function f(...args) {}");
      const b = firstFn("function g(...rest) {}");
      const r = classifyParamDiff(a, b);
      expect(r.kind).toBe("rename-only");
      if (r.kind === "rename-only") expect(r.nameMap.get("args")).toBe("rest");
    });

    it("AssignmentPattern (default 付き) → structural-diff (default 内 identifier rewrite を回避)", () => {
      const a = firstFn("function f(x = 1) {}");
      const b = firstFn("function g(y = 1) {}");
      expect(classifyParamDiff(a, b).kind).toBe("structural-diff");
    });

    it("ObjectPattern → structural-diff", () => {
      const a = firstFn("function f({ x }) {}");
      const b = firstFn("function g({ y }) {}");
      expect(classifyParamDiff(a, b).kind).toBe("structural-diff");
    });
  });

  describe("renameIdentifiersInStatements (in-source)", () => {
    const stmtsOf = (src: string): Statement[] => {
      const fn = firstFn(`function f() { ${src} }`);
      const body = functionBlockBody(fn);
      if (!body) throw new Error("no body");
      return body.body as Statement[];
    };

    it("variable 参照を nameMap に従って書き換える (clone なので元 AST は不変)", async () => {
      const { default: generate } = await import("@babel/generator");
      const original = stmtsOf("return x + 1;");
      const renamed = renameIdentifiersInStatements(original, new Map([["x", "y"]]));
      expect(generate(renamed[0]!).code).toContain("y + 1");
      expect(generate(original[0]!).code).toContain("x + 1");
    });

    it("MemberExpression のプロパティ名は書き換えない (非 computed)", async () => {
      const { default: generate } = await import("@babel/generator");
      const original = stmtsOf("return obj.x;");
      const renamed = renameIdentifiersInStatements(original, new Map([["x", "y"]]));
      expect(generate(renamed[0]!).code).toContain("obj.x");
    });

    it("computed MemberExpression のプロパティは書き換える (式評価される変数参照)", async () => {
      const { default: generate } = await import("@babel/generator");
      const original = stmtsOf("return obj[x];");
      const renamed = renameIdentifiersInStatements(original, new Map([["x", "y"]]));
      expect(generate(renamed[0]!).code).toContain("obj[y]");
    });

    it("ObjectProperty / ObjectMethod の key は書き換えない (非 computed、shorthand 経由は書き換える)", async () => {
      const { default: generate } = await import("@babel/generator");
      const original = stmtsOf("return { x: x };");
      const renamed = renameIdentifiersInStatements(original, new Map([["x", "y"]]));
      const code = generate(renamed[0]!).code;
      expect(code).toMatch(/x: y/);
    });

    it("空 nameMap は no-op (新しい配列を返すが内容は同じ)", () => {
      const original = stmtsOf("return x + 1;");
      const renamed = renameIdentifiersInStatements(original, new Map());
      expect(renamed).toHaveLength(original.length);
    });
  });

  describe("hasBindingCollision (in-source)", () => {
    const stmtsOf = (src: string): Statement[] => {
      const fn = firstFn(`function f() { ${src} }`);
      const body = functionBlockBody(fn);
      if (!body) throw new Error("no body");
      return body.body as Statement[];
    };

    it("rename 先と同名の VariableDeclarator があれば true", () => {
      const body = stmtsOf("const y = 1; return x + y;");
      expect(hasBindingCollision(body, new Map([["x", "y"]]))).toBe(true);
    });

    it("rename 先と同名の inner FunctionDeclaration があれば true", () => {
      const body = stmtsOf("function y() {} return y;");
      expect(hasBindingCollision(body, new Map([["x", "y"]]))).toBe(true);
    });

    it("rename 先と同名の inner fn param があれば true", () => {
      const body = stmtsOf("const f = function (y) { return y; }; return f(x);");
      expect(hasBindingCollision(body, new Map([["x", "y"]]))).toBe(true);
    });

    it("rename 先と同名の inner fn AssignmentPattern param (default 付き) も collision 扱い", () => {
      const body = stmtsOf("function inner(y = 0) { return y; } return inner(x);");
      expect(hasBindingCollision(body, new Map([["x", "y"]]))).toBe(true);
    });

    it("rename 先と同名の CatchClause.param も collision 扱い (ADR-0027 案 A)", () => {
      const body = stmtsOf("try { throw 0; } catch (y) { return y + x; }");
      expect(hasBindingCollision(body, new Map([["x", "y"]]))).toBe(true);
    });

    it("rename 先と同名の ClassDeclaration.id も collision 扱い", () => {
      const body = stmtsOf("class y {} return x;");
      expect(hasBindingCollision(body, new Map([["x", "y"]]))).toBe(true);
    });

    it("rename 元と同名の別 binding (`var x` 等) も collision 扱い (ADR-0027: targets に nameMap.keys() も含める)", () => {
      const body = stmtsOf("var x = 1; return x;");
      expect(hasBindingCollision(body, new Map([["x", "y"]]))).toBe(true);
    });

    it("rename 元と同名の CatchClause.param も collision 扱い", () => {
      const body = stmtsOf("try { throw 0; } catch (x) { return x; }");
      expect(hasBindingCollision(body, new Map([["x", "y"]]))).toBe(true);
    });

    it("衝突なし → false", () => {
      const body = stmtsOf("const z = 1; return z + 1;");
      expect(hasBindingCollision(body, new Map([["x", "y"]]))).toBe(false);
    });

    it("空 nameMap → false", () => {
      const body = stmtsOf("const y = 1; return x + y;");
      expect(hasBindingCollision(body, new Map())).toBe(false);
    });
  });
}
