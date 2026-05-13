import type { Statement } from "@babel/types";

import { walkNodes } from "../../../ast/walk";

/**
 * ADR-0014: A+B (lib も body も変化) にルートされた issue について、body (`f1.body` / `test.body`)
 * の参照 identifier 集合 `I` と lib 側 changed-function 名集合 `F` (`diffLibPair` の近似) の交差を取り、
 *
 * - `I ∩ F = ∅` (交差なし) → independent → 2 candidate に分割 (lib candidate / body candidate)
 * - `I ∩ F ≠ ∅` (交差あり) → co-evolution の疑い → 分割しない (1 candidate のまま)
 *
 * を判定する。`F` が空 (lib の変更関数名を特定できない) のときは「干渉なし」とみなして split する。
 *
 * `I` はプロパティ名・object key も含めて保守的に集める (= 偽 co-evolution = 分割しない 側に倒れ、
 * 誤分割による `error` を避ける — ADR-0014「迷ったら 1 candidate」)。
 */
export function isIndependent(
  bodyStatements: readonly Statement[],
  libChangedFunctionNames: ReadonlySet<string>,
): boolean {
  if (libChangedFunctionNames.size === 0) return true;
  const ids = collectIdentifierNames(bodyStatements);
  for (const name of ids) {
    if (libChangedFunctionNames.has(name)) return false;
  }
  return true;
}

function collectIdentifierNames(statements: readonly Statement[]): Set<string> {
  const names = new Set<string>();
  for (const stmt of statements) {
    walkNodes(stmt, ({ node }) => {
      if (node.type === "Identifier") names.add(node.name);
    });
  }
  return names;
}

// 判断: ai-guide/adr/0007-in-source-testing-internal-helpers.md
if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;
  const { parse } = await import("../../../ast/parser");

  describe("isIndependent (in-source, ADR-0014)", () => {
    it("lib の変更関数名集合が空なら independent (= split する)", () => {
      expect(isIndependent(parse("a + b;").program.body, new Set())).toBe(true);
    });

    it("body の参照 identifier と lib 変更関数名が交差すれば co-evolution の疑い (= split しない)", () => {
      expect(isIndependent(parse("foo(x);").program.body, new Set(["foo"]))).toBe(false);
    });

    it("交差しなければ independent", () => {
      expect(isIndependent(parse("foo(x);").program.body, new Set(["bar"]))).toBe(true);
    });
  });
}
