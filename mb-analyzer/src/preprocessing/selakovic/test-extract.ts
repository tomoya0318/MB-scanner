import type {
  ArrowFunctionExpression,
  BlockStatement,
  File,
  FunctionDeclaration,
  FunctionExpression,
} from "@babel/types";

import { parse } from "../../ast/parser";
import { walkNodes } from "../../ast/walk";

/**
 * Selakovic serverIssues / clientServerIssues の `test_case_*.js` から `init` / `setupTest` /
 * `test` の 3 関数を特定し、`test()` の body を取り出す (ADR-0011 §段1②)。
 *
 * `test_case_*.js` は IIFE で `function init(){...} function setupTest(){...} function test(){...}
 * exports.init = init; ...` を包む形が dataset 全件 (45/45) で成立。`init` / `setupTest` /
 * `test` は FunctionDeclaration の他に `exports.test = function(){...}` / `var test = function(){...}`
 * の形もありうる。
 *
 * `init`/`setupTest` は計測ハーネスの一部 (= setup 扱い)。`test()` body が slow/fast の母集団。
 * 規約外フォーマット (`test()` が見つからない等) は `null`。
 */

type FnLike = FunctionDeclaration | FunctionExpression | ArrowFunctionExpression;

export interface TestDecomposition {
  /** test() の body (BlockStatement) — slow/fast の母集団。 */
  readonly testBody: BlockStatement;
  /** test() の宣言パラメタ名 (= `initResult` / `setupTestResult` 等)。 */
  readonly testParams: readonly string[];
}

export function extractTest(testCaseSource: string): TestDecomposition | null {
  let file: File;
  try {
    file = parse(testCaseSource);
  } catch {
    return null;
  }

  const testFn = findNamedFn(file, "test");
  if (testFn === null) return null;
  if (testFn.body.type !== "BlockStatement") return null;
  const testParams = testFn.params.map((p) => (p.type === "Identifier" ? p.name : "$x"));
  return { testBody: testFn.body, testParams };
}

function findNamedFn(file: File, name: string): FnLike | null {
  let found: FnLike | null = null;
  walkNodes(file, ({ node, parent }) => {
    if (found !== null) return;
    if (
      node.type === "FunctionDeclaration" &&
      node.id !== null &&
      node.id !== undefined &&
      node.id.name === name
    ) {
      found = node;
      return;
    }
    if (node.type === "FunctionExpression" || node.type === "ArrowFunctionExpression") {
      if (parent === null) return;
      // exports.test = function(){...}  /  module.exports.test = function(){...}
      if (
        parent.type === "AssignmentExpression" &&
        parent.left.type === "MemberExpression" &&
        parent.left.property.type === "Identifier" &&
        parent.left.property.name === name
      ) {
        found = node;
        return;
      }
      // var test = function(){...}
      if (
        parent.type === "VariableDeclarator" &&
        parent.id.type === "Identifier" &&
        parent.id.name === name
      ) {
        found = node;
      }
    }
  });
  return found;
}
