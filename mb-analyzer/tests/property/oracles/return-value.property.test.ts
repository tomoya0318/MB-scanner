/**
 * checkReturnValue の代数的性質 (反射律・対称律) を property-based に検証する。
 *
 * 自分自身との比較では not_equal は起きてはいけない、また slow/fast を入れ替えても
 * verdict は不変であるべき。これらは oracle の実装バグ (非対称比較・NaN 扱い漏れ等) を
 * 自動検出するための invariant。
 */
import { describe, it } from "vitest";
import * as fc from "fast-check";
import { checkReturnValue } from "../../../src/equivalence-checker/common/comparison/oracles/return-value";
import { UNSERIALIZABLE_MARKER } from "../../../src/equivalence-checker/common/sandbox/capture/snapshot";
import { exceptionArbitrary } from "../../fixtures/arbitraries";
import { capture } from "../../fixtures/capture";

const serializedValue = fc.oneof(
  fc.constant("undefined"),
  fc.constant("null"),
  fc.integer().map((n) => String(n)),
  fc.string({ maxLength: 10 }).map((s) => JSON.stringify(s)),
  fc.constant("true"),
  fc.constant("false"),
  fc.constant(UNSERIALIZABLE_MARKER),
);

const arbitraryCapture = fc
  .record({
    return_value: serializedValue,
    return_is_undefined: fc.boolean(),
    exception: exceptionArbitrary,
  })
  .map((r) => capture(r));

describe("checkReturnValue (property)", () => {
  it("反射律: 自分自身との比較で not_equal は発生しない", () => {
    fc.assert(
      fc.property(arbitraryCapture, (cap) => {
        const v = checkReturnValue(cap, cap).verdict;
        return v !== "not_equal";
      }),
      { numRuns: 200 },
    );
  });

  it("対称律: slow/fast 入れ替えで verdict 不変", () => {
    fc.assert(
      fc.property(arbitraryCapture, arbitraryCapture, (a, b) => {
        return checkReturnValue(a, b).verdict === checkReturnValue(b, a).verdict;
      }),
      { numRuns: 200 },
    );
  });

  it("例外側が絡むと必ず not_applicable (O3 に委譲)", () => {
    const withException = fc.record({
      return_value: serializedValue,
      return_is_undefined: fc.boolean(),
      exception: fc.record({
        ctor: fc.constantFrom("Error", "TypeError"),
        message: fc.string({ maxLength: 10 }),
      }),
    });
    fc.assert(
      fc.property(withException.map(capture), arbitraryCapture, (withExc, other) => {
        return checkReturnValue(withExc, other).verdict === "not_applicable";
      }),
      { numRuns: 100 },
    );
  });
});
