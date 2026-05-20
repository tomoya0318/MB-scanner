import type { File, Node } from "@babel/types";

import { parse, tryGenerateNode } from "../../ast/parser";
import { walkNodes } from "../../ast/walk";
import { findChangedNodes } from "./ast-diff";

/**
 * patch された library ファイル (before / after) の差分を「変更を含む unit」ごとに切り分ける。
 *
 * unit の決め方 (plan §A1):
 *  1. **fn unit**: 変更ノードから祖先をたどり、最初に当たる *名前を推定できる関数*
 *     (`function f`/`var f = function`/`X.f = function`/`{f: function}`/ObjectMethod 等)。
 *     途中の匿名関数 (配列 `.forEach(function(){...})` の callback / IIFE / AMD `define("...",[...],function(){...})`
 *     のコールバック本体) は飛ばしてさらに上の named 関数までたどる。同じ関数に局所化された複数の
 *     変更ノードは 1 つの fn unit にまとまる。
 *  2. **stmt unit**: 祖先パス上に named 関数が無い (= 変更がモジュール本体 / 匿名ラッパ本体に直接ある)
 *     → 変更を含む「ブロック直下の文」(`Ember.VERSION = '...'` / `var X = ...;` / top-level `if` 等。
 *     IIFE 全体・ファイル全体にはならない)。version-bump ノイズ等はここに落ちる。
 *  3. どちらにも anchor できない (理論上ほぼ起きない) → `unanchored` にカウントだけして捨てる。
 *
 * 戻り値には before/after の AST と、fn unit については after-AST 上の同名関数 (rename/削除なら null)
 * も含める (後段の Phase 2 reachability / Phase 4 runnable 組み立てが両方使うため)。
 *
 * `findChangedNodes` の diff はコメント・整形を無視済 (`canonicalHash` が `leadingComments` 等を除外) なので、
 * 「ノイズ」として残るのは incidental な *コード* 変更 (`Ember.VERSION = '...'` の代入や declarator 並び替え)。
 */

/** 関数ノードの型。`common/reachability.ts` (call-graph 構築) でも再利用する。 */
export const FN_TYPES: ReadonlySet<string> = new Set([
  "FunctionDeclaration",
  "FunctionExpression",
  "ArrowFunctionExpression",
  "ObjectMethod",
  "ClassMethod",
]);
const BLOCK_PARENT_TYPES = new Set(["Program", "BlockStatement"]);
/** `extend`/`reopen` 等で渡したオブジェクトリテラルのプロパティ関数を `<recv>.<key>` で命名できる callee 名。 */
const MIXIN_CALLEES = /^(extend|reopen|reopenClass|mixin|create)$/;

function nodeType(n: Node | undefined): string | undefined {
  return (n as unknown as { type?: string } | undefined)?.type;
}

/**
 * `chain` (root→自分の親) と関数ノード `fn` から binding 名を推定する。匿名なら `null`。
 *
 * 対応: `function f(){}` / `var f = function(){}` / `X.f = function(){}` / `{ f: function(){} }` /
 * `var o = { f: function(){} }` → `o.f` / ObjectMethod / `X.extend({ f: function(){} })` → `X.f`。
 *
 * `common/reachability.ts` (call-graph の named 関数列挙) でも再利用する。
 */
export function functionBindingName(chain: readonly Node[], fn: Node): string | null {
  const at = (i: number): Node | undefined => chain[chain.length + i];
  const f = fn as unknown as { id?: { type: string; name?: string }; type: string };
  const parent = at(-1);

  if (f.type === "FunctionDeclaration" && f.id?.type === "Identifier" && f.id.name) return f.id.name;
  if (nodeType(parent) === "AssignmentExpression") {
    const left = (parent as unknown as { left: Node }).left;
    if (nodeType(left) === "MemberExpression" || nodeType(left) === "Identifier") return tryGenerateNode(left);
  }
  if (nodeType(parent) === "VariableDeclarator") {
    const id = (parent as unknown as { id: Node }).id;
    if (nodeType(id) === "Identifier") return (id as unknown as { name: string }).name;
  }
  if (nodeType(parent) === "ObjectProperty" || nodeType(parent) === "ObjectMethod") {
    const key = (parent as unknown as { key: { type: string; name?: string; value?: string } }).key;
    const keyName = key.type === "Identifier" ? key.name : key.type === "StringLiteral" ? key.value : undefined;
    if (keyName === undefined) return null;
    const owner = at(-3); // ObjectProperty -> ObjectExpression -> owner
    if (nodeType(owner) === "AssignmentExpression") {
      const left = (owner as unknown as { left: Node }).left;
      if (nodeType(left) === "MemberExpression" || nodeType(left) === "Identifier") return `${tryGenerateNode(left)}.${keyName}`;
    }
    if (nodeType(owner) === "VariableDeclarator") {
      const id = (owner as unknown as { id: Node }).id;
      if (nodeType(id) === "Identifier") return `${(id as unknown as { name: string }).name}.${keyName}`;
    }
    if (nodeType(owner) === "CallExpression") {
      const callee = (owner as unknown as { callee: Node }).callee;
      if (nodeType(callee) === "MemberExpression" && MIXIN_CALLEES.test((callee as unknown as { property: { name?: string } }).property?.name ?? "")) {
        return `${tryGenerateNode((callee as unknown as { object: Node }).object)}.${keyName}`;
      }
      return null; // 任意の callback として渡されたオブジェクトリテラル: 命名不能
    }
    return keyName; // 親オブジェクトの帰属が不明: 末端キー名だけ (over-approx 寄り)
  }
  // 親ベースで命名できなかった named FunctionExpression (`defineProps(function self() {...})` のように
  // callback 引数として渡される名前付き関数式) は、自身の `id.name` を最後の手段として採用する。
  // これにより変更ノードが内側の named 関数式に局所化されているとき (server CommonJS lib に多い)、
  // 外側の getter / IIFE まで遡らず最寄りの named 関数で unit を切れる。
  // 順序は最後 — `var f = function g(){}` / `o.f = function g(){}` は従来どおり親ベース ("f" / "o.f") を優先する。
  if (f.type === "FunctionExpression") {
    const id = (fn as unknown as { id?: { name?: string } }).id;
    if (id?.name) return id.name;
  }
  return null;
}

/** `ancestors` をたどり「変更を含む最寄りの *named* 関数」を返す。匿名しか居なければ `null`。 */
function nearestNamedFunction(
  ancestors: readonly Node[],
): { fn: Node; name: string; fnAncestors: readonly Node[] } | null {
  for (let i = ancestors.length - 1; i >= 0; i--) {
    const a = ancestors[i]!;
    if (!FN_TYPES.has(a.type)) continue;
    const name = functionBindingName(ancestors.slice(0, i), a);
    if (name !== null) return { fn: a, name, fnAncestors: ancestors.slice(0, i) };
    // 匿名 (callback arg / IIFE 等) → さらに上へ
  }
  return null;
}

/** 変更ノード `node` (祖先 `ancestors`) を含む「ブロック直下の文」を返す。見つからなければ `null`。 */
function nearestBlockStatement(node: Node, ancestors: readonly Node[]): Node | null {
  if (ancestors.length > 0 && BLOCK_PARENT_TYPES.has(nodeType(ancestors[ancestors.length - 1]) ?? "")) return node;
  for (let i = ancestors.length - 1; i >= 1; i--) {
    if (BLOCK_PARENT_TYPES.has(nodeType(ancestors[i - 1]) ?? "")) return ancestors[i]!;
  }
  return null;
}

/** 文ノードが定義する binding / property 名 (`var a=1, b=2;` → `["a","b"]` / `X.f = ...;` → `["X.f"]` / `function f(){}` → `["f"]`)。 */
export function statementBindings(stmt: Node): string[] {
  const t = nodeType(stmt);
  if (t === "VariableDeclaration") {
    return (stmt as unknown as { declarations: Array<{ id: Node }> }).declarations
      .map((d) => (nodeType(d.id) === "Identifier" ? (d.id as unknown as { name: string }).name : tryGenerateNode(d.id)))
      .filter((s): s is string => typeof s === "string" && s.length > 0);
  }
  if (t === "FunctionDeclaration" || t === "ClassDeclaration") {
    const id = (stmt as unknown as { id?: { name?: string } }).id;
    return id?.name ? [id.name] : [];
  }
  if (t === "ExpressionStatement") {
    const expr = (stmt as unknown as { expression: Node }).expression;
    if (nodeType(expr) === "AssignmentExpression") {
      const left = (expr as unknown as { left: Node }).left;
      if (nodeType(left) === "MemberExpression" || nodeType(left) === "Identifier") return [tryGenerateNode(left)];
    }
  }
  return [];
}

export interface FnChangeUnit {
  readonly kind: "fn";
  /** 末端まで含む binding 名 (例: `_s.startsWith` / `Ember.cacheFor` / `jQuery.fn.index`)。 */
  readonly name: string;
  /** before-AST 上の関数ノード。 */
  readonly beforeFn: Node;
  /** before-AST 上の祖先 (root → 親)。変更関数を囲う lexical scope chain (Phase 4 の lambda-lift で使う)。 */
  readonly beforeFnAncestors: readonly Node[];
  /** after-AST 上の同名関数ノード。rename / 削除されていれば `null`。 */
  readonly afterFn: Node | null;
  /** after-AST 上の祖先 (afterFn が null なら空配列)。 */
  readonly afterFnAncestors: readonly Node[];
  /** この unit に局所化された変更ノード (before-AST)。 */
  readonly changedNodes: readonly Node[];
}

export interface StmtChangeUnit {
  readonly kind: "stmt";
  /** before-AST 上の文ノード (Program / 関数 body の直下)。 */
  readonly stmt: Node;
  /** この文が定義する binding / property 名。 */
  readonly bindings: readonly string[];
  /**
   * 「before-AST の block 直下の文のうち、`bindings` と sorted-equal な文の中でこの文が何番目か」(0-based)。
   * after-AST 側で対応する文を引くとき、binding 名だけだと同名 (`var X = 1; ... X = 2;` 等) で誤マッチするので、
   * occurrence 番号で一意化する (changed-stmt strategy が `findAfterStmtByBindingsAndOccurrence` で利用)。
   */
  readonly bindingsOccurrence: number;
  /** 人間可読の短い説明 (ログ用)。 */
  readonly desc: string;
  /** この文に局所化された変更ノード (before-AST)。 */
  readonly changedNodes: readonly Node[];
}

export type ChangeUnit = FnChangeUnit | StmtChangeUnit;

export interface ChangeUnitsResult {
  readonly beforeAst: File;
  readonly afterAst: File;
  readonly units: readonly ChangeUnit[];
  /** どちらの unit にも anchor できなかった変更ノード数 (threats カウント。理論上ほぼ 0)。 */
  readonly unanchored: number;
  /** `findChangedNodes` が空 = 意味論差なし (呼び出し側で fallback / exclude)。 */
  readonly empty: boolean;
}

/** after-AST の named 関数を binding 名で索引する (最初に一致したものを採用)。 */
function indexFunctionsByName(ast: File): Map<string, { fn: Node; ancestors: readonly Node[] }> {
  const byName = new Map<string, { fn: Node; ancestors: readonly Node[] }>();
  walkNodes(ast, ({ node, ancestors }) => {
    if (!FN_TYPES.has(node.type)) return;
    const name = functionBindingName(ancestors, node);
    if (name !== null && !byName.has(name)) byName.set(name, { fn: node, ancestors });
  });
  return byName;
}

/**
 * `libBeforeSrc` / `libAfterSrc` を parse → `findChangedNodes` → 変更を unit ごとに切り分ける。
 */
export function findChangeUnits(libBeforeSrc: string, libAfterSrc: string): ChangeUnitsResult {
  const beforeAst = parse(libBeforeSrc);
  const afterAst = parse(libAfterSrc);
  const changed = findChangedNodes(beforeAst, afterAst);
  if (changed.size === 0) {
    return { beforeAst, afterAst, units: [], unanchored: 0, empty: true };
  }

  const afterByName = indexFunctionsByName(afterAst);

  // 各変更ノード → 所属 unit を決める。fn unit は name で集約、stmt unit は stmt ノードで集約。
  const fnUnits = new Map<string, { fn: Node; ancestors: readonly Node[]; changed: Node[] }>();
  const stmtUnits = new Map<Node, { stmt: Node; changed: Node[] }>();
  let unanchored = 0;

  walkNodes(beforeAst, ({ node, ancestors }) => {
    if (!changed.has(node)) return;
    const named = nearestNamedFunction(ancestors);
    if (named) {
      const u = fnUnits.get(named.name);
      if (u) u.changed.push(node);
      else fnUnits.set(named.name, { fn: named.fn, ancestors: named.fnAncestors, changed: [node] });
      return;
    }
    const stmt = nearestBlockStatement(node, ancestors);
    if (stmt) {
      const u = stmtUnits.get(stmt);
      if (u) u.changed.push(node);
      else stmtUnits.set(stmt, { stmt, changed: [node] });
      return;
    }
    unanchored++;
  });

  const occurrenceOf = computeStmtOccurrences(beforeAst);

  const units: ChangeUnit[] = [];
  for (const [name, u] of fnUnits) {
    const after = afterByName.get(name) ?? null;
    units.push({
      kind: "fn",
      name,
      beforeFn: u.fn,
      beforeFnAncestors: u.ancestors,
      afterFn: after?.fn ?? null,
      afterFnAncestors: after?.ancestors ?? [],
      changedNodes: u.changed,
    });
  }
  for (const u of stmtUnits.values()) {
    units.push({
      kind: "stmt",
      stmt: u.stmt,
      bindings: statementBindings(u.stmt),
      bindingsOccurrence: occurrenceOf.get(u.stmt) ?? 0,
      desc: tryGenerateNode(u.stmt).split("\n")[0]!.slice(0, 80),
      changedNodes: u.changed,
    });
  }

  return { beforeAst, afterAst, units, unanchored, empty: false };
}

/**
 * `ast` の block 直下 (Program / BlockStatement) の文を document 順に走査し、各文に
 * 「同じ sorted-bindings を持つ文の中で何番目か」(0-based) を割り当てた Map を返す。
 * changed-stmt strategy が after-AST 側で同じ走査・filter (`findAfterStmtByBindingsAndOccurrence`) を使い、
 * occurrence 番号で before↔after の文を一意対応させる ([[change-units]] の StmtChangeUnit.bindingsOccurrence)。
 */
function computeStmtOccurrences(ast: File): Map<Node, number> {
  const result = new Map<Node, number>();
  const counts = new Map<string, number>();
  walkNodes(ast, ({ node, ancestors }) => {
    const parent = ancestors[ancestors.length - 1];
    const parentType = nodeType(parent);
    if (parentType !== "Program" && parentType !== "BlockStatement") return;
    const bindings = statementBindings(node);
    if (bindings.length === 0) return;
    const key = [...bindings].sort().join("|");
    const k = counts.get(key) ?? 0;
    result.set(node, k);
    counts.set(key, k + 1);
  });
  return result;
}

// 判断: ai-guide/adr/0007-in-source-testing-internal-helpers.md
if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;
  // 観点: 変更ノードを「変更を含む named 関数 (匿名は飛ばす)」か「ブロック直下の文」に切り分ける。
  // 同一関数内の複数変更は 1 unit に集約、複数関数に散れば関数ごとに別 unit、関数外の変更は stmt unit、
  // 変更ゼロは empty。fn unit には after-AST の同名関数も付く。

  const wrap = (body: string): string => `(function () {\n${body}\n})();`;
  const fnUnitNames = (before: string, after: string): string[] =>
    findChangeUnits(before, after).units.filter((u): u is FnChangeUnit => u.kind === "fn").map((u) => u.name).sort();

  describe("findChangeUnits (in-source)", () => {
    it("変更ゼロ → empty", () => {
      const src = wrap("function foo() { return 1; }");
      const r = findChangeUnits(src, src);
      expect(r.empty).toBe(true);
      expect(r.units).toEqual([]);
    });

    it("named 関数の中の変更 → その関数だけが fn unit", () => {
      const before = wrap("function foo() { return 1; } function bar() { return 2; }");
      const after = wrap("function foo() { return 1 + 1; } function bar() { return 2; }");
      expect(fnUnitNames(before, after)).toEqual(["foo"]);
    });

    it("1 関数内の複数変更 → 1 つの fn unit に集約 (changedNodes が複数)", () => {
      const before = wrap("function foo() { var a = 1; var b = 2; return a + b; }");
      const after = wrap("function foo() { var a = 10; var b = 20; return a + b; }");
      const units = findChangeUnits(before, after).units.filter((u): u is FnChangeUnit => u.kind === "fn");
      expect(units.map((u) => u.name)).toEqual(["foo"]);
      expect(units[0]!.changedNodes.length).toBeGreaterThanOrEqual(2);
    });

    it("複数の named 関数に散る変更 → 関数ごとに別 unit", () => {
      const before = wrap("function foo() { return 1; } function bar() { return 2; }");
      const after = wrap("function foo() { return 11; } function bar() { return 22; }");
      expect(fnUnitNames(before, after)).toEqual(["bar", "foo"]);
    });

    it("匿名 callback / IIFE 内の変更 → 上の named 関数まで遡る", () => {
      const before = wrap("function foo() { return [1, 2].map(function (x) { return x + 1; }); }");
      const after = wrap("function foo() { return [1, 2].map(function (x) { return x + 2; }); }");
      expect(fnUnitNames(before, after)).toEqual(["foo"]);
    });

    it("named 関数の外 (モジュールレベル) の変更 → stmt unit", () => {
      const before = wrap("var VERSION = '1.0'; function foo() { return VERSION; }");
      const after = wrap("var VERSION = '2.0'; function foo() { return VERSION; }");
      const r = findChangeUnits(before, after);
      const stmts = r.units.filter((u): u is StmtChangeUnit => u.kind === "stmt");
      expect(stmts.length).toBe(1);
      expect(stmts[0]!.bindings).toContain("VERSION");
      expect(stmts[0]!.bindingsOccurrence).toBe(0); // 単独宣言なので 0 番目
      expect(r.units.some((u) => u.kind === "fn")).toBe(false);
    });

    it("同名 binding が複数: 変更された方の occurrence 番号が付く (Copilot #2 対策)", () => {
      // var X が 2 回宣言され、2 回目 (occurrence=1) だけ変更されるケース。
      const before = wrap("var X = 1; function noop() {} var X = 'a'; function foo() { return X; }");
      const after = wrap("var X = 1; function noop() {} var X = 'b'; function foo() { return X; }");
      const r = findChangeUnits(before, after);
      const stmts = r.units.filter((u): u is StmtChangeUnit => u.kind === "stmt");
      expect(stmts.length).toBe(1);
      expect(stmts[0]!.bindings).toEqual(["X"]);
      // before の「2 回目の var X」が変更対象 → occurrence=1
      expect(stmts[0]!.bindingsOccurrence).toBe(1);
    });

    it("X.f = function(){} 形 / { f: function(){} } 形の命名", () => {
      const before = wrap("var o = {}; o.foo = function () { return 1; }; var p = { bar: function () { return 2; } };");
      const after = wrap("var o = {}; o.foo = function () { return 10; }; var p = { bar: function () { return 20; } };");
      expect(fnUnitNames(before, after)).toEqual(["o.foo", "p.bar"]);
    });

    it("fn unit には after-AST の同名関数が付く (本体が変わっても name で対応)", () => {
      const before = wrap("var o = { foo: function () { return 1; } };");
      const after = wrap("var o = { foo: function () { return 2; } };");
      const u = findChangeUnits(before, after).units.find((x): x is FnChangeUnit => x.kind === "fn" && x.name === "o.foo");
      expect(u).toBeDefined();
      expect(u!.afterFn).not.toBeNull();
    });

    it("親ベースで命名できない named FunctionExpression の中の変更 → その id 名で fn unit (server CommonJS パターン)", () => {
      // chalk_*.js の `defineProps(function self() { var str = ...; })` を模した形。
      // self は callback 引数なので親ベース命名は付かず、従来は外側の named fn まで遡っていた。
      // named-FE fallback で self 自身に anchor する。
      const before = wrap("function init() { var obj = wrap(function self() { var str = a(); return str; }); }");
      const after = wrap("function init() { var obj = wrap(function self() { var str = b(); return str; }); }");
      expect(fnUnitNames(before, after)).toEqual(["self"]);
    });

    it("named FunctionExpression でも parent ベース命名が付くなら従来優先 (var f = function g(){} → f)", () => {
      const before = wrap("var f = function g() { return 1; };");
      const after = wrap("var f = function g() { return 2; };");
      // id 名 g ではなく VariableDeclarator 由来の f が採られる (named-FE は最後の手段)
      expect(fnUnitNames(before, after)).toEqual(["f"]);
    });
  });
}
