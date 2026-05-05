import type { File, Node } from "@babel/types";

import { walkNodes } from "../../ast/walk";

/**
 * AST diff の changed_nodes をすべて内包する最小の syntactic enclosure を求める。
 *
 * 候補型は ECMAScript 文法レベルの一般概念のみ。優先順位:
 *
 * 1. **関数/メソッド系**: FunctionDeclaration / FunctionExpression / ArrowFunctionExpression
 *    / ClassMethod / ObjectMethod (最も内側)
 * 2. **ブロック系**: BlockStatement
 * 3. **Top-level statement 系**: VariableDeclaration / FunctionDeclaration / ClassDeclaration
 *    / ExpressionStatement (1 と 2 で見つからない場合のフォールバック)
 *
 * 1 と 2 が見つからずに Program/File 直下まで上昇するケース (= 「関数全体に変更が散在」
 * のような大規模 refactor) では 3 が拾う。これは EJS / Backbone のような library 全面
 * 修正で頻出。改良 3 と呼ぶ。
 *
 * Program / File そのものが LCA に含まれて、Top-level statement にも到達できない場合
 * のみ `null` を返す (真の module-wide-change)。
 */

const FUNCTION_LIKE_TYPES = new Set([
  "FunctionDeclaration",
  "FunctionExpression",
  "ArrowFunctionExpression",
  "ClassMethod",
  "ObjectMethod",
]);

const BLOCK_TYPE = "BlockStatement";

/**
 * Program 直下に直接現れる「式 or 宣言を含む文」型。LCA が関数/Block より外にある場合
 * のフォールバックとして使う (改良 3)。
 *
 * ExpressionStatement は `module.exports = ...` や `obj.method = function() {}` のような
 * top-level 代入を捕捉する。FunctionDeclaration は `function foo() {}` 形式、
 * VariableDeclaration は `var foo = function() {}` 形式、ClassDeclaration は ES6 class。
 */
const TOP_LEVEL_STATEMENT_TYPES = new Set([
  "VariableDeclaration",
  "FunctionDeclaration",
  "ClassDeclaration",
  "ExpressionStatement",
]);

const MODULE_TYPES = new Set(["Program", "File"]);

export interface EnclosureResult {
  readonly enclosure: Node;
  readonly enclosureType: string;
  readonly ancestorsToRoot: readonly Node[];
}

/**
 * `changed` のうち少なくとも 1 つを内包する最小の関数/メソッドノードを返す。
 *
 * 各 changed ノードの祖先パス (root から自分までの Node[]) を計算し、それらの末端共通
 * 祖先 (LCA) を求めてから上昇し、候補型に当たれば返す。
 */
export function findMinimalEnclosure(
  before: File,
  changed: ReadonlySet<Node>,
): EnclosureResult | null {
  if (changed.size === 0) return null;

  const ancestorPaths = collectAncestorPaths(before, changed);
  if (ancestorPaths.length === 0) return null;

  const lcaPath = longestCommonPrefix(ancestorPaths);
  if (lcaPath.length === 0) {
    // 何 1 つ祖先を共有しないことは normally あり得ない (root は全員共通)。
    return null;
  }

  // lcaPath の末端から root に向かって走査。
  const fromInnermost = [...lcaPath].reverse();

  // 第 1 ループ: 関数/メソッド優先で最初の候補型を採る。
  // Program/File に当たる前に Function/Method/Block を探す。
  for (const node of fromInnermost) {
    if (FUNCTION_LIKE_TYPES.has(node.type)) {
      return { enclosure: node, enclosureType: node.type, ancestorsToRoot: lcaPath };
    }
    if (MODULE_TYPES.has(node.type)) break;
  }

  // 第 2 ループ: BlockStatement (Function/Method なしのケース)。
  for (const node of fromInnermost) {
    if (node.type === BLOCK_TYPE) {
      return { enclosure: node, enclosureType: node.type, ancestorsToRoot: lcaPath };
    }
    if (MODULE_TYPES.has(node.type)) break;
  }

  // 第 3 ループ (改良 3): Top-level statement 系にフォールバック。
  // 「関数全体に変更が散在」「ExpressionStatement の代入式が変更」など、関数/Block で
  // 拾えないが top-level statement 全体を抽出単位にすれば救えるケースを救済する。
  for (const node of fromInnermost) {
    if (TOP_LEVEL_STATEMENT_TYPES.has(node.type)) {
      return { enclosure: node, enclosureType: node.type, ancestorsToRoot: lcaPath };
    }
    if (MODULE_TYPES.has(node.type)) break;
  }

  return null;
}

function collectAncestorPaths(root: File, targets: ReadonlySet<Node>): Array<readonly Node[]> {
  const paths: Array<readonly Node[]> = [];
  walkNodes(root, ({ node, ancestors }) => {
    if (targets.has(node)) {
      paths.push([...ancestors, node]);
    }
  });
  return paths;
}

function longestCommonPrefix(paths: readonly (readonly Node[])[]): readonly Node[] {
  if (paths.length === 0) return [];
  const first = paths[0];
  if (first === undefined) return [];

  let length = first.length;
  for (let i = 1; i < paths.length; i++) {
    const other = paths[i];
    if (other === undefined) continue;
    const limit = Math.min(length, other.length);
    let matched = 0;
    for (let j = 0; j < limit; j++) {
      if (first[j] === other[j]) matched++;
      else break;
    }
    length = matched;
    if (length === 0) break;
  }

  return first.slice(0, length);
}
