import type { File, Node, Statement } from "@babel/types";

import { generate } from "../../ast/parser";
import { walkNodes } from "../../ast/walk";

/**
 * enclosure を含む最も近い Program 直下の statement で AST を分割し、
 * 「slow/fast に渡す statement」と「setup として渡す前置 statement 列」を返す。
 *
 * 切り方の根拠 (plan.md §抽出器の設計 Step 3):
 * - slow/fast は「enclosure を含む top-level statement」 (例: `var f1 = function () { ... };`
 *   のような変数宣言全体)
 * - setup は「その statement より前の statement 列」 = ファイル先頭 〜 enclosure 直前
 * - enclosure 直後の statement (jsperf の `execute(f1)` などの報告コード) は捨てる
 *
 * これにより:
 * 1. setup と slow/fast の意味論が分離される (setup には enclosure 関数の宣言が残らない)
 * 2. 報告系ノイズ (execute / jStat / $.ajax) が自動除外される
 * 3. server 系の Step 4 浄化が statement 分割で自動的に達成される
 *
 * Returns null if enclosure が Program 直下の statement に到達しない (= 通常起こらない、
 * Program 直下の文に必ず祖先が存在するはず)。
 */
export interface SplitResult {
  readonly setupStatements: readonly Statement[];
  readonly slowStatement: Statement;
  readonly statementIndex: number;
}

export function splitAtEnclosure(ast: File, enclosure: Node): SplitResult | null {
  const programBody = ast.program.body;
  for (let i = 0; i < programBody.length; i++) {
    const stmt = programBody[i];
    if (stmt === undefined) continue;
    if (containsNode(stmt, enclosure)) {
      return {
        setupStatements: programBody.slice(0, i),
        slowStatement: stmt,
        statementIndex: i,
      };
    }
  }
  return null;
}

/**
 * `target` が `root` の AST サブツリーに含まれるか (参照同一性で判定)。
 *
 * `findMinimalEnclosure` の出力は `before` AST 内の Node なので、同じ AST を辿れば
 * 必ず見つかる。
 */
export function containsNode(root: Node, target: Node): boolean {
  if (root === target) return true;
  let found = false;
  walkNodes(root, ({ node }) => {
    if (node === target) found = true;
  });
  return found;
}

/**
 * statement 列を結合して 1 つの JS コード文字列に generate する。Program AST を
 * 構築して `generate()` に通す。空配列なら空文字を返す。
 *
 * コメントは出力しない: `File.comments=[]` だけだと Node に attach された
 * leadingComments / trailingComments は @babel/generator が依然出力するため、
 * generate 側に明示的に `{ comments: false }` を渡す。preprocess の slow/fast/setup
 * は元 lib のコメントを引きずる必要が無い (むしろ candidate サイズが膨らむ)。
 */
export function statementsToCode(statements: readonly Statement[]): string {
  if (statements.length === 0) return "";
  const fakeFile: File = {
    type: "File",
    program: {
      type: "Program",
      body: [...statements],
      directives: [],
      sourceType: "script",
    },
    comments: [],
    errors: [],
  } as unknown as File;
  return generate(fakeFile, { comments: false });
}

/**
 * 単一 statement を JS コード文字列に generate する。
 */
export function statementToCode(statement: Statement): string {
  return statementsToCode([statement]);
}
