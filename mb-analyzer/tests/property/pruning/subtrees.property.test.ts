/**
 * 対象: src/ast/subtree-hash.ts の SubtreeSet
 * 観点: ランダムな式について SubtreeSet の所属判定が再 parse 安定性 / 決定性 /
 *      衝突回避の 3 性質を満たすかを検証 (内部 canonicalHash の代数的性質を public
 *      API 経由で間接確認)
 * 判定事項:
 *   - 同一ソースから生成した 2 つの File は互いに SubtreeSet で全サブツリー所属
 *   - 同一コードから別々に作った SubtreeSet は他方の全サブツリーを含む (決定性)
 *   - リテラル値を 1 箇所変えた File は元集合に含まれない (衝突回避)
 */
import * as fc from "fast-check";
import { describe, it } from "vitest";
import { SubtreeSet } from "../../../src/ast/subtree-hash";
import { parse } from "../../../src/pruning/common/ast/parser";
import { walkAllNodes } from "./walk";

// 識別子・リテラル・演算子・構造を混ぜた短い JS 断片を生成する arbitrary。
// 再帰的に式を組み立て、pruning 対象として現実的な分布に寄せる。
const identifierArb: fc.Arbitrary<string> = fc.constantFrom("a", "b", "obj", "arr", "key", "x");
const numberArb: fc.Arbitrary<string> = fc.integer({ min: 0, max: 3 }).map((n) => String(n));
const stringArb: fc.Arbitrary<string> = fc
  .constantFrom("a", "b", "c")
  .map((s) => JSON.stringify(s));

const expressionArb: fc.Arbitrary<string> = fc.letrec((tie) => ({
  expr: fc.oneof(
    { depthSize: "small", withCrossShrink: true },
    identifierArb,
    numberArb,
    stringArb,
    fc
      .tuple(tie("expr") as fc.Arbitrary<string>, tie("expr") as fc.Arbitrary<string>)
      .map(([l, r]) => `(${l} + ${r})`),
    fc
      .tuple(tie("expr") as fc.Arbitrary<string>, tie("expr") as fc.Arbitrary<string>)
      .map(([o, p]) => `${o}[${p}]`),
    (tie("expr") as fc.Arbitrary<string>).map((e) => `!${e}`),
  ),
})).expr;

describe("SubtreeSet (property)", () => {
  it("同じソースから作った 2 つの File は全サブツリーが集合に含まれる (再 parse 安定性)", () => {
    fc.assert(
      fc.property(expressionArb, (code) => {
        const before = parse(code);
        const after = parse(code);
        const subtrees = new SubtreeSet(after);
        for (const node of walkAllNodes(before)) {
          if (!subtrees.has(node)) return false;
        }
        return true;
      }),
      { numRuns: 200 },
    );
  });

  it("同じコードから別々に構築した SubtreeSet は他方の全サブツリーを含む (決定性)", () => {
    // 集合構築の結果が実行間で安定 (内部 hash が決定論的) なら、別々に作っても
    // 一方のサブツリーは他方に必ず含まれる
    fc.assert(
      fc.property(expressionArb, (code) => {
        const set1 = new SubtreeSet(parse(code));
        const file2 = parse(code);
        for (const node of walkAllNodes(file2)) {
          if (!set1.has(node)) return false;
        }
        return true;
      }),
      { numRuns: 200 },
    );
  });

  it("リテラル値を 1 箇所変えた File は元集合に含まれない (衝突回避)", () => {
    const codeArb = fc.tuple(identifierArb, numberArb, numberArb).filter(([, a, b]) => a !== b);
    fc.assert(
      fc.property(codeArb, ([name, a, b]) => {
        const setA = new SubtreeSet(parse(`${name}[${a}]`));
        const fileB = parse(`${name}[${b}]`);
        // File 全体・Program 全体・ExpressionStatement のいずれも setA には無い
        // (リテラル値が違うので)
        if (setA.has(fileB)) return false;
        if (setA.has(fileB.program)) return false;
        const stmt = fileB.program.body[0];
        if (stmt !== undefined && setA.has(stmt)) return false;
        return true;
      }),
      { numRuns: 100 },
    );
  });
});
