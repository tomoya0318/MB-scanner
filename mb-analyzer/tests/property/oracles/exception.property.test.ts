/**
 * checkException の代数的性質 (反射律・対称律) を property-based に検証する。
 */
import { describe, it } from "vitest";
import * as fc from "fast-check";
import { checkException } from "../../../src/equivalence-checker/common/comparison/oracles/exception";
import { exceptionArbitrary } from "../../fixtures/arbitraries";
import { capture } from "../../fixtures/capture";

const arbitraryCapture = exceptionArbitrary.map((exception) => capture({ exception }));

describe("checkException (property)", () => {
  it("反射律: 自分自身との比較で not_equal は発生しない", () => {
    fc.assert(
      fc.property(arbitraryCapture, (cap) => {
        const v = checkException(cap, cap).verdict;
        return v !== "not_equal";
      }),
      { numRuns: 200 },
    );
  });

  it("対称律: slow/fast 入れ替えで verdict 不変", () => {
    fc.assert(
      fc.property(arbitraryCapture, arbitraryCapture, (a, b) => {
        return checkException(a, b).verdict === checkException(b, a).verdict;
      }),
      { numRuns: 200 },
    );
  });

  it("片方だけ例外は常に not_equal", () => {
    const withExc = fc
      .record({
        ctor: fc.constantFrom("Error", "TypeError"),
        message: fc.string({ maxLength: 10 }),
      })
      .map((exception) => capture({ exception }));
    const withoutExc = fc.constant(capture({ exception: null }));
    fc.assert(
      fc.property(withExc, withoutExc, (exc, noexc) => {
        return checkException(exc, noexc).verdict === "not_equal";
      }),
      { numRuns: 50 },
    );
  });
});
