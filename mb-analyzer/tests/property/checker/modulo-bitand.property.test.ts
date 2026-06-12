/**
 * Angular #4359 (Selakovic 2016 Description.md:15): `x % 2` → `x & 1`
 *
 * 従来研究は等価と主張したが、JS 仕様上:
 *   - x > 0 の整数: `x % 2` も `x & 1` もどちらも 0 / 1 を返し一致
 *   - x < 0 の奇数: `x % 2 === -1` だが `x & 1 === 1` — diverge
 *   - x < 0 の偶数: `x % 2 === -0` だが `x & 1 === 0` — serializer が -0/0 を区別するため diverge
 *
 * fast-check で入力空間を広くサンプリングし、checker の判定が境界条件と
 * 矛盾しないことを保証する (生きた仕様)。
 */
import { describe, it } from "vitest";
import * as fc from "fast-check";
import { checkEquivalence } from "../../../src/equivalence-checker/selakovic/checker";

describe("x % 2 vs x & 1 boundary (Angular #4359)", () => {
  it("非負整数 (0 含む) では必ず equal", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 0, max: 10_000 }), async (x) => {
        const r = await checkEquivalence({
          setup: `const x = ${x};`,
          before: "x % 2",
          after: "x & 1",
        });
        return r.verdict === "equal";
      }),
      { numRuns: 30 },
    );
  });

  it("負の奇数では必ず not_equal (x % 2 === -1, x & 1 === 1)", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: -10_000, max: -1 }).filter((x) => x % 2 !== 0),
        async (x) => {
          const r = await checkEquivalence({
            setup: `const x = ${x};`,
            before: "x % 2",
            after: "x & 1",
          });
          return r.verdict === "not_equal";
        },
      ),
      { numRuns: 30 },
    );
  });

  it("負の偶数でも not_equal (x % 2 === -0, x & 1 === 0) — -0 識別による反例", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: -10_000, max: -2 }).filter((x) => x % 2 === 0),
        async (x) => {
          const r = await checkEquivalence({
            setup: `const x = ${x};`,
            before: "x % 2",
            after: "x & 1",
          });
          return r.verdict === "not_equal";
        },
      ),
      { numRuns: 30 },
    );
  });
});
