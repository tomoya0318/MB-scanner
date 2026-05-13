import type { Node } from "@babel/types";

import { walkNodes } from "../../ast/walk";
import { FN_TYPES } from "./change-units";

/**
 * 変更関数を pruning 向けの「穴あき lib + `__HOLE__` 関数式 + 観測する形の workload」に組み立てる部品。
 *
 * 設計 (plan §D1 / spike v2 で実証):
 *  - **lambda-lift**: 変更関数が使う *lib 内部の補助関数・変数* (= 自由変数のうち、変更関数を囲ういずれかの
 *    スコープ (Program / 関数 / IIFE / AMD `define(...)` コールバック body) で hoist 束縛されてるもの) を
 *    引数化して取り出す。`__HOLE__.call(this, <内部依存>, <元の引数>)` のフック呼び出しは変更関数の元の場所に
 *    書くので `<内部依存>` はそこから見える → 値を `slow`/`fast` の `__HOLE__` 本体へ転送。
 *  - **穴 + ガード**: lib (after) を丸ごと setup に置き、変更関数の body だけを
 *    `{ if (globalThis.__HOLE__) { return globalThis.__HOLE__.call(this, <内部依存>, <元の引数>); } <after 本体をインライン> }`
 *    に置換する。lib bootstrap 中 (= `__HOLE__` 未設定) は after 本体で素直に動き、workload 実行時
 *    (= `slow`/`fast` が `__HOLE__` を設定済み) だけフック経由で観測/差し替えされる (bootstrap-invocation 対策)。
 *  - **観測する形**: ベンチが結果を捨てる (perf 用) と等価検証に観測チャネルが無く pruning が garbage に削る
 *    → `__HOLE__` 本体で変更関数の戻り値を `globalThis.__OBS` に記録し、workload の最後に `JSON.stringify(__OBS)` を
 *    返す。これで `return_value` oracle が positive evidence を出し、過剰削減が `not_equal` で reject される。
 */

const SCOPE_TYPES: ReadonlySet<string> = new Set<string>([...FN_TYPES, "Program"]);
const BUILTINS: ReadonlySet<string> = new Set([
  "String", "Number", "Boolean", "Object", "Array", "Function", "RegExp", "Date", "Math", "JSON", "Error", "TypeError", "RangeError", "SyntaxError", "ReferenceError",
  "Symbol", "Map", "Set", "WeakMap", "WeakSet", "Promise", "Proxy", "Reflect", "console", "undefined", "NaN", "Infinity", "globalThis", "window", "document", "self", "global",
  "parseInt", "parseFloat", "isNaN", "isFinite", "encodeURIComponent", "decodeURIComponent", "encodeURI", "decodeURI", "this", "arguments", "true", "false", "null", "void",
]);

function nodeType(n: Node | undefined): string | undefined {
  return (n as unknown as { type?: string } | undefined)?.type;
}

/** subtree のノード数。`before_node_count` 等に使う。 */
export function countSubtreeNodes(node: Node): number {
  let count = 0;
  walkNodes(node, () => {
    count += 1;
  });
  return count;
}

/** 関数 / メソッドの param 名のリスト (Identifier 以外のパターンは `$x` プレースホルダ)。 */
export function paramNames(fnNode: Node): string[] {
  return ((fnNode as unknown as { params?: Array<{ type: string; name?: string }> }).params ?? []).map((p) =>
    p.type === "Identifier" && p.name ? p.name : "$x",
  );
}

/** `fnNode` の本体 (BlockStatement) を返す。arrow `=> expr` 等で BlockStatement でなければ `null`。 */
export function functionBlockBody(fnNode: Node): { type: string; start: number; end: number; body: Node[] } | null {
  const b = (fnNode as unknown as { body?: { type?: string; start?: number; end?: number; body?: Node[] } }).body;
  if (!b || b.type !== "BlockStatement" || typeof b.start !== "number" || typeof b.end !== "number") return null;
  return b as { type: string; start: number; end: number; body: Node[] };
}

/**
 * `fnNode` の本体で参照されている自由識別子名 (params / その本体内のローカル `var`・`function` 宣言 / 既知の組み込みグローバル を除く)。
 * over-approx (ネストした関数の params/locals も拾い得るが、後段で「lib のモジュールスコープ名」と交差させて落とす)。
 */
export function freeIdentifierNames(fnNode: Node): Set<string> {
  const params = new Set(paramNames(fnNode).filter((n) => n !== "$x"));
  const locals = new Set<string>();
  const all = new Set<string>();
  walkNodes(fnNode, ({ node, parent, parentKey }) => {
    const t = nodeType(node);
    if (t === "Identifier") {
      // ObjectProperty/ObjectMethod の key は名前参照ではない (`{ foo: ... }` の `foo`)
      if (parent && (nodeType(parent) === "ObjectProperty" || nodeType(parent) === "ObjectMethod") && parentKey === "key") return;
      // MemberExpression の non-computed property (`x.foo` の `foo`) も「自由変数」ではない (`x` の方が変数)
      if (parent && nodeType(parent) === "MemberExpression" && parentKey === "property" && !(parent as unknown as { computed?: boolean }).computed) return;
      all.add((node as unknown as { name: string }).name);
    }
    if (t === "VariableDeclaration") for (const d of (node as unknown as { declarations: Array<{ id: { type: string; name?: string } }> }).declarations) if (d.id.type === "Identifier" && d.id.name) locals.add(d.id.name);
    if (t === "FunctionDeclaration") { const id = (node as unknown as { id?: { type: string; name?: string } }).id; if (id?.type === "Identifier" && id.name) locals.add(id.name); }
  });
  const free = new Set<string>();
  for (const name of all) if (!params.has(name) && !locals.has(name) && !BUILTINS.has(name)) free.add(name);
  return free;
}

/** scope ノード (Program / 各種関数) が直下に hoist 束縛する名前: top-level の `var` / `function` 宣言 + 関数の params。 */
function scopeBindings(scope: Node): Set<string> {
  const names = new Set<string>();
  const body =
    nodeType(scope) === "Program"
      ? ((scope as unknown as { body?: Node[] }).body ?? [])
      : nodeType((scope as unknown as { body?: Node }).body) === "BlockStatement"
        ? ((scope as unknown as { body: { body?: Node[] } }).body.body ?? [])
        : [];
  for (const s of body) {
    if (nodeType(s) === "VariableDeclaration")
      for (const d of (s as unknown as { declarations: Array<{ id: { type: string; name?: string } }> }).declarations)
        if (d.id.type === "Identifier" && d.id.name) names.add(d.id.name);
    if (nodeType(s) === "FunctionDeclaration") {
      const id = (s as unknown as { id?: { type: string; name?: string } }).id;
      if (id?.type === "Identifier" && id.name) names.add(id.name);
    }
  }
  for (const p of (scope as unknown as { params?: Array<{ type: string; name?: string }> }).params ?? [])
    if (p.type === "Identifier" && p.name) names.add(p.name);
  return names;
}

/**
 * 変更関数を囲うすべてのスコープ (Program + 各 enclosing 関数 / IIFE / AMD `define(...)` コールバック body) の
 * hoist 束縛名の和集合。`fnAncestors` は root → 変更関数の親 の path (`change-units.ts` の `FnChangeUnit.afterFnAncestors`)。
 */
export function liftableNames(fnAncestors: readonly Node[]): Set<string> {
  const names = new Set<string>();
  for (const a of fnAncestors) if (SCOPE_TYPES.has(nodeType(a) ?? "")) for (const n of scopeBindings(a)) names.add(n);
  return names;
}

/**
 * 引数化して取り出す lib 内部依存名: `(freeVars(beforeFn) ∪ freeVars(afterFn)) ∩ liftable(afterFn のスコープ群)`、
 * ただし変更関数自身の param 名は除く (引数で別途渡すので二重に lift しない)。
 */
export function pickLiftedDeps(beforeFn: Node, afterFn: Node, afterFnAncestors: readonly Node[]): string[] {
  const liftable = liftableNames(afterFnAncestors);
  const params = new Set(paramNames(afterFn));
  const union = new Set<string>([...freeIdentifierNames(beforeFn), ...freeIdentifierNames(afterFn)]);
  return [...union].filter((n) => liftable.has(n) && !params.has(n));
}

/**
 * lib (after) のソース文字列を transform: `afterFn` の body `{...}` (span = `body.start..body.end`) を
 * `{ if (globalThis.__HOLE__) { return globalThis.__HOLE__.call(this, <liftDeps>, <fnParams>); } <after 本体をそのままインライン> }`
 * に置換した文字列を返す。`afterFnBody` は `functionBlockBody(afterFn)` の結果 (caller が non-null を確認済の前提)。
 */
export function holeLibSource(
  libAfterSrc: string,
  afterFnBody: { start: number; end: number },
  liftDeps: readonly string[],
  fnParams: readonly string[],
): string {
  const callArgs = ["this", ...liftDeps, ...fnParams].join(", ");
  const afterBodyInline = libAfterSrc.slice(afterFnBody.start + 1, afterFnBody.end - 1); // { } の中身 (formatting 保持)
  return (
    libAfterSrc.slice(0, afterFnBody.start) +
    `{ if (globalThis.__HOLE__) { return globalThis.__HOLE__.call(${callArgs}); }${afterBodyInline}\n}` +
    libAfterSrc.slice(afterFnBody.end)
  );
}

/**
 * `globalThis.__HOLE__` に代入する関数式のソース: `(<liftDeps>, <fnParams>)` を受け取り、`<bodyCode>` を `.call(this)` で
 * 実行 → 戻り値を `globalThis.__OBS` に (serialize して) push → そのまま返す。`bodyCode` は変更前 (slow) / 変更後 (fast) の
 * 関数本体の statement 列のソース。
 */
export function buildHoleFunction(holeParams: readonly string[], bodyCode: string): string {
  return [
    `function (${holeParams.join(", ")}) {`,
    `  globalThis.__OBS = globalThis.__OBS || [];`,
    `  var __r = (function () {`,
    bodyCode,
    `  }).call(this);`,
    `  globalThis.__OBS.push((function () { try { return JSON.stringify(__r); } catch (e) { return "<unserializable>"; } })());`,
    `  return __r;`,
    `}`,
  ].join("\n");
}

/**
 * workload (= `f1` body / `test()` body の statement 列のソース) を観測する形で包んだ実行式:
 * `(function () { globalThis.__OBS = []; <workloadBodyCode>; return JSON.stringify(globalThis.__OBS); })()`。
 * 完了値が `__OBS` の serialize 結果になるので、`return_value` oracle が「変更関数を何回どんな値で呼んだか」を観測できる。
 */
export function wrapWorkloadObserved(workloadBodyCode: string): string {
  return ["(function () {", "globalThis.__OBS = [];", workloadBodyCode, "return JSON.stringify(globalThis.__OBS);", "})()"].join("\n");
}

// 判断: ai-guide/adr/0007-in-source-testing-internal-helpers.md
if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;
  const { parse } = await import("../../ast/parser");
  // 観点: 自由変数抽出 / lexical chain の hoist 束縛抽出 / 内部依存の選別 (and-交差) / lib ソースの穴あけ /
  // __HOLE__ 関数式・観測ラッパの組み立て。

  /** `parse(src)` から最初に見つかる FunctionExpression/FunctionDeclaration とその ancestors を返す。 */
  const firstFn = (src: string): { fn: Node; ancestors: readonly Node[] } => {
    const ast = parse(src);
    let result: { fn: Node; ancestors: readonly Node[] } | null = null;
    walkNodes(ast, ({ node, ancestors }) => {
      if (result || !(nodeType(node) === "FunctionExpression" || nodeType(node) === "FunctionDeclaration")) return;
      result = { fn: node, ancestors };
    });
    if (!result) throw new Error("no function found");
    return result;
  };

  describe("freeIdentifierNames (in-source)", () => {
    it("params / ローカル / 組み込み を除いた自由変数を返す", () => {
      const { fn } = firstFn("var g = function (a, b) { var c = 1; return makeString(a) + b + c + Math.max(a); };");
      const free = freeIdentifierNames(fn);
      expect(free.has("makeString")).toBe(true);
      expect(free.has("a")).toBe(false); // param
      expect(free.has("c")).toBe(false); // local
      expect(free.has("Math")).toBe(false); // builtin
    });
    it("x.foo の foo (non-computed property) は自由変数にしない", () => {
      const { fn } = firstFn("var g = function (obj) { return obj.foo + helper.bar; };");
      const free = freeIdentifierNames(fn);
      expect(free.has("helper")).toBe(true);
      expect(free.has("foo")).toBe(false);
      expect(free.has("bar")).toBe(false);
    });
  });

  describe("liftableNames / pickLiftedDeps (in-source)", () => {
    // (function () { var makeString = function () {...}; function helper(){}; var api = { f: function (x) { ... helper, makeString ... } }; })();
    const src = `(function () {
      var makeString = function () { return "x"; };
      function helper(s) { return s; }
      var api = { f: function (x) { return helper(makeString()) + helper(x); } };
    })();`;
    // 最初に見つかる 1-param の FunctionExpression = api.f (makeString は 0-param なのでスキップ)
    const apiF = (): { fn: Node; ancestors: readonly Node[] } => {
      const ast = parse(src);
      let target: { fn: Node; ancestors: readonly Node[] } | null = null;
      walkNodes(ast, ({ node, ancestors }) => {
        if (target) return;
        if (nodeType(node) === "FunctionExpression" && (node as unknown as { params: unknown[] }).params.length === 1) target = { fn: node, ancestors };
      });
      if (!target) throw new Error("api.f not found");
      return target;
    };
    it("lexical chain (Program + IIFE body) の hoist 束縛を集める", () => {
      const names = liftableNames(apiF().ancestors);
      expect(names.has("makeString")).toBe(true);
      expect(names.has("helper")).toBe(true);
      expect(names.has("api")).toBe(true);
    });
    it("pickLiftedDeps = (freeVars(before) ∪ freeVars(after)) ∩ liftable − params", () => {
      const t = apiF();
      // before === after === api.f とみなしてテスト (実際は別 AST だが、自由変数/lift の論理は同じ)
      const deps = pickLiftedDeps(t.fn, t.fn, t.ancestors);
      expect(deps).toContain("makeString");
      expect(deps).toContain("helper");
      expect(deps).not.toContain("x"); // param
    });
  });

  describe("holeLibSource / buildHoleFunction / wrapWorkloadObserved (in-source)", () => {
    it("holeLibSource: 関数本体を __HOLE__ ガード + after 本体インラインに置換", () => {
      const src = "var g = function (x) { return x + 1; };";
      const { fn } = firstFn(src);
      const body = functionBlockBody(fn)!;
      const holed = holeLibSource(src, body, ["dep1"], ["x"]);
      expect(holed).toContain("if (globalThis.__HOLE__)");
      expect(holed).toContain("globalThis.__HOLE__.call(this, dep1, x)");
      expect(holed).toContain("return x + 1;"); // after 本体はインライン fallback として残る
      // parse できる (壊れた構文を吐いてない)
      expect(() => parse(holed)).not.toThrow();
    });
    it("buildHoleFunction: __OBS に戻り値を記録して返す関数式", () => {
      const code = buildHoleFunction(["dep1", "x"], "return x + dep1;");
      expect(code).toContain("function (dep1, x)");
      expect(code).toContain("globalThis.__OBS.push");
      expect(code).toContain("return x + dep1;");
      expect(() => parse(`globalThis.__HOLE__ = ${code};`)).not.toThrow();
    });
    it("wrapWorkloadObserved: __OBS を init して body を実行し JSON.stringify(__OBS) を返す式", () => {
      const code = wrapWorkloadObserved("api.f(1); api.f(2);");
      expect(code).toContain("globalThis.__OBS = [];");
      expect(code).toContain("return JSON.stringify(globalThis.__OBS);");
      expect(() => parse(code)).not.toThrow();
    });
  });
}
