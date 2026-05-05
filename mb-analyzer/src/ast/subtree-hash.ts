import { VISITOR_KEYS } from "@babel/types";
import type { File, Node } from "@babel/types";

import { walkNodes } from "./walk";

/**
 * AST ノードのサブツリー同型判定用ハッシュと所属判定器。
 *
 * 機能間で重複していた subtree-hash ユーティリティをここに集約する (旧
 * `pruning/ast/subtrees.ts` の `FastSubtreeSet` / `preprocessing/common/subtree-hash.ts` を
 * 統合し、ここで `SubtreeSet` として再エクスポートしている)。
 *
 * 「同型」はハッシュによる厳密一致で、タイプ・子・識別子名・リテラル値・演算子が
 * すべて揃って初めて同型と扱う。例えば `arr[0]` と `arr[1]` は別物。loc / start /
 * end / コメントなどの表示系メタデータは無視する。
 *
 * 採用判断 (top-down subtree hash 自作 / bottom-up は非採用):
 *   - ai-guide/adr/0002-babel-topdown-subtree-hash.md
 *   - ai-guide/adr/0003-bottom-up-mapping-deferred.md
 */
export class SubtreeSet {
  private readonly hashes: Set<string>;

  constructor(root: File | Node) {
    this.hashes = new Set<string>();
    walkNodes(root, ({ node }) => this.hashes.add(canonicalHash(node)));
  }

  /** node と同型のサブツリーが root のどこかに含まれるか。 */
  has(node: Node): boolean {
    return this.hashes.has(canonicalHash(node));
  }
}

// Babel AST ノードには loc / start / end / comments / extra などソース位置・表示系の
// プロパティが含まれる。同じコードを再 parse しても微妙にぶれる値が多いので、ハッシュ
// からはまとめて除外する。
const METADATA_KEYS: ReadonlySet<string> = new Set([
  "type",
  "loc",
  "start",
  "end",
  "range",
  "leadingComments",
  "trailingComments",
  "innerComments",
  "extra",
  "trailingComma",
  "comments",
  "errors",
]);

type VisitorChild = Node | null | undefined | Array<Node | null | undefined>;

function hashChild(child: VisitorChild): string {
  if (child === null || child === undefined) return "_";
  if (Array.isArray(child)) {
    return `[${child.map(hashChild).join(",")}]`;
  }
  return canonicalHash(child);
}

/**
 * ノードの正規化ハッシュ。
 *
 * タイプ・子ノード・識別子名・リテラル値・演算子・`computed` などの構造フラグが
 * 全部一致すれば等しいハッシュを持つ。ソース位置・コメント・`extra` (原表記情報)
 * は計算に含めない — METADATA_KEYS 参照。
 */
export function canonicalHash(node: Node): string {
  const visitorKeys = VISITOR_KEYS[node.type] ?? [];
  const visitorKeySet = new Set<string>(visitorKeys);

  const record = node as unknown as Record<string, unknown>;
  const valueEntries: string[] = [];
  for (const key of Object.keys(record).sort()) {
    if (METADATA_KEYS.has(key)) continue;
    if (visitorKeySet.has(key)) continue;
    const value = record[key];
    if (value === undefined) continue;
    valueEntries.push(`${key}=${JSON.stringify(value)}`);
  }

  const childEntries: string[] = [];
  for (const key of visitorKeys) {
    childEntries.push(`${key}=${hashChild(record[key] as VisitorChild)}`);
  }

  return `${node.type}{${valueEntries.join(",")}}(${childEntries.join(",")})`;
}

// 判断: ai-guide/adr/0007-in-source-testing-internal-helpers.md
if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;
  // parser は本 if ブロック内でだけ必要なので遅延 import (production bundle には残らない)
  const { parse } = await import("./parser");

  const firstStatement = (code: string): Node => {
    const stmt = parse(code).program.body[0];
    if (stmt === undefined) throw new Error("empty program");
    return stmt;
  };

  describe("canonicalHash (in-source)", () => {
    it("同一コードを二度 parse しても同じ hash になる (決定性)", () => {
      expect(canonicalHash(parse("arr[0]"))).toBe(canonicalHash(parse("arr[0]")));
    });

    it("識別子名が異なると hash が異なる", () => {
      expect(canonicalHash(parse("a"))).not.toBe(canonicalHash(parse("b")));
    });

    it("数値リテラル値が異なると hash が異なる (arr[0] vs arr[1])", () => {
      expect(canonicalHash(parse("arr[0]"))).not.toBe(canonicalHash(parse("arr[1]")));
    });

    it("文字列リテラル値が異なると hash が異なる", () => {
      expect(canonicalHash(parse("'a'"))).not.toBe(canonicalHash(parse("'b'")));
    });

    it("演算子が異なると hash が異なる (a + b vs a - b)", () => {
      expect(canonicalHash(parse("a + b"))).not.toBe(canonicalHash(parse("a - b")));
    });

    it("computed か shorthand か等の構造フラグも区別する (obj.x vs obj['x'])", () => {
      expect(canonicalHash(parse("obj.x"))).not.toBe(canonicalHash(parse("obj['x']")));
    });

    it("loc / コメントは hash に影響しない", () => {
      const plain = canonicalHash(parse("arr[0]"));
      const withComment = canonicalHash(parse("// prefix\narr[0] // trailing"));
      expect(plain).toBe(withComment);
    });
  });

  describe("SubtreeSet (in-source) — メタデータ無視", () => {
    it("空の File からも壊れず構築できる", () => {
      const set = new SubtreeSet(parse(""));
      expect(set.has(parse("x"))).toBe(false);
    });

    it("サブツリーも漏れなく含まれる: arr[0] は arr 識別子・0 リテラル・MemberExpression を持つ", () => {
      const set = new SubtreeSet(parse("arr[0]"));

      const memberStmt = parse("arr[0]").program.body[0];
      if (memberStmt?.type !== "ExpressionStatement") throw new Error("unexpected");
      const memberExpr = memberStmt.expression;
      if (memberExpr.type !== "MemberExpression") throw new Error("unexpected");

      expect(set.has(memberExpr)).toBe(true);
      expect(set.has(memberExpr.object)).toBe(true); // arr (Identifier)
      expect(set.has(memberExpr.property)).toBe(true); // 0 (NumericLiteral)
    });
  });

  describe("SubtreeSet.has (in-source) — 基本", () => {
    it("同一ファイル同士では全 statement が common 判定", () => {
      const src = "const x = arr[0]; use(x);";
      const file = parse(src);
      const set = new SubtreeSet(parse(src));
      for (const stmt of file.program.body) {
        expect(set.has(stmt)).toBe(true);
      }
    });

    it("root の部分式として同型が存在するノードは common (a+b は (a+b)+c の左部分式)", () => {
      const slow = parse("a + b");
      const set = new SubtreeSet(parse("a + b + c"));
      const stmt = slow.program.body[0];
      if (stmt?.type !== "ExpressionStatement") throw new Error("unexpected");
      expect(set.has(stmt.expression)).toBe(true);
    });

    it("root に同型サブツリーが存在しないノードは not-common (演算子違い)", () => {
      const slow = parse("a - b");
      const set = new SubtreeSet(parse("a + b"));
      const stmt = slow.program.body[0];
      if (stmt?.type !== "ExpressionStatement") throw new Error("unexpected");
      expect(set.has(stmt.expression)).toBe(false);
    });

    it("空の root から作った SubtreeSet は任意ノードに対し false", () => {
      const set = new SubtreeSet(parse(""));
      expect(set.has(firstStatement("x"))).toBe(false);
    });
  });
}
