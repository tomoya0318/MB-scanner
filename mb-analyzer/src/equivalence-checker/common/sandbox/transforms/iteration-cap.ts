/**
 * 計測ループの反復回数を縮める実行前 AST pass。
 * 判断: ai-guide/adr/0017-equivalence-sandbox-pre-execution-transforms.md
 *
 * Selakovic の計測ハーネスは「同じ関数を N 回 (N が大きい) 回して時間を測る」形なので、
 * SUT lib を before/after で丸ごと走らせる等価検証では N が timeout の主因になる。pass の役割:
 * - `for (...; <var> </<= <numeric-literal ≥ threshold>; ...)` の上限リテラルを `cap` に置換
 * - `Array(N)` / `new Array(N)` (N ≥ threshold) の引数を `cap` に置換
 *
 * `threshold` / `cap` の「決め」は dataset 知識なので `selakovic` adapter (profiles) から渡す。
 * `cap === null` なら何もしない (= 原文どおり全反復)。parse / generate に失敗したら原文をそのまま返す。
 */
import type { NumericLiteral } from "@babel/types";

import { generate, parse } from "../../../../ast/parser";
import { walkNodes } from "../../../../ast/walk";

export interface IterationCapOptions {
  /** ループ上限がこの値以上なら「計測ループ」とみなして clamp する。 */
  threshold: number;
  /** clamp 後の上限。`null` = pass を無効化 (原文どおり)。 */
  cap: number | null;
}

export function applyIterationCap(code: string, options: IterationCapOptions): string {
  if (options.cap === null) return code;
  const { cap, threshold } = options;
  if (code.length === 0) return code;

  let file;
  try {
    file = parse(code);
  } catch {
    return code;
  }

  let changed = false;
  const clamp = (lit: NumericLiteral): void => {
    if (typeof lit.value !== "number" || lit.value < threshold) return;
    lit.value = cap;
    // .extra.raw が残っていると generator がそちらを優先するので消す。
    delete lit.extra;
    changed = true;
  };

  walkNodes(file, ({ node }) => {
    if (node.type === "ForStatement" && node.test?.type === "BinaryExpression") {
      const { operator, left, right } = node.test;
      if (operator === "<" || operator === "<=" || operator === ">" || operator === ">=") {
        if (left.type === "Identifier" && right.type === "NumericLiteral") clamp(right);
        else if (left.type === "NumericLiteral" && right.type === "Identifier") clamp(left);
      }
      return;
    }
    if (node.type === "CallExpression" || node.type === "NewExpression") {
      const callee = node.callee;
      const arg0 = node.arguments.length === 1 ? node.arguments[0] : undefined;
      if (callee.type === "Identifier" && callee.name === "Array" && arg0 !== undefined && arg0.type === "NumericLiteral") {
        clamp(arg0);
      }
    }
  });

  if (!changed) return code;
  try {
    return generate(file);
  } catch {
    return code;
  }
}

// 判断: ai-guide/adr/0007-in-source-testing-internal-helpers.md
if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;

  describe("applyIterationCap (in-source)", () => {
    const opts = { threshold: 1000, cap: 5 };

    it("for (i < BIG) の上限を cap に clamp する", () => {
      const out = applyIterationCap("for (let i = 0; i < 1000000; i++) sink(i);", opts);
      expect(out).toContain("i < 5");
      expect(out).not.toContain("1000000");
    });

    it("for (i <= BIG) も clamp する", () => {
      expect(applyIterationCap("for (let i = 0; i <= 50000; i++) f();", opts)).toContain("i <= 5");
    });

    it("threshold 未満のループはそのまま", () => {
      const out = applyIterationCap("for (let i = 0; i < 10; i++) f();", opts);
      expect(out).toContain("i < 10");
    });

    it("Array(BIG) / new Array(BIG) の引数を clamp する", () => {
      expect(applyIterationCap("var a = Array(100000);", opts)).toContain("Array(5)");
      expect(applyIterationCap("var a = new Array(2000);", opts)).toContain("new Array(5)");
    });

    it("Array(small) はそのまま", () => {
      expect(applyIterationCap("var a = Array(3);", opts)).toContain("Array(3)");
    });

    it("cap=null は何もしない", () => {
      const code = "for (let i = 0; i < 1000000; i++) f();";
      expect(applyIterationCap(code, { threshold: 1000, cap: null })).toBe(code);
    });

    it("parse 不能なコードは原文をそのまま返す", () => {
      const code = "for (let i = ";
      expect(applyIterationCap(code, opts)).toBe(code);
    });

    it("clamp 対象が無ければ原文をそのまま返す (再 generate しない)", () => {
      const code = "const x = a + b;";
      expect(applyIterationCap(code, opts)).toBe(code);
    });
  });
}
