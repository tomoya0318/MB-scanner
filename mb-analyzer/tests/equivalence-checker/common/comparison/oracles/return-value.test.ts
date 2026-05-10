/**
 * 対象: Oracle O1 - checkReturnValue (return-value)
 * 観点: 関数の戻り値を両側で serialize 後の文字列として完全一致比較する
 * 判定事項:
 *   - 片方でも例外発生 → not_applicable（例外は O3 に委譲）
 *   - 両側とも戻り値なし (return_is_undefined) → not_applicable
 *   - 片方でもシリアライズ不能（循環参照等 / UNSERIALIZABLE_MARKER） → error
 *   - 片方だけ undefined、または値が異なる → not_equal
 *   - serialize された文字列が完全一致 → equal
 */
import { describe, expect, it } from "vitest";
import { checkReturnValue } from "../../../../../src/equivalence-checker/common/comparison/oracles/return-value";
import { UNSERIALIZABLE_MARKER } from "../../../../../src/equivalence-checker/common/sandbox/capture/snapshot";
import { capture } from "../../../../fixtures/capture";

describe("checkReturnValue", () => {
  it("両側同値 → equal", () => {
    const slow = capture({ return_value: "42", return_is_undefined: false });
    const fast = capture({ return_value: "42", return_is_undefined: false });
    expect(checkReturnValue(slow, fast).verdict).toBe("equal");
  });

  it("値が異なる → not_equal", () => {
    const slow = capture({ return_value: "-1", return_is_undefined: false });
    const fast = capture({ return_value: "1", return_is_undefined: false });
    const obs = checkReturnValue(slow, fast);
    expect(obs.verdict).toBe("not_equal");
    expect(obs.slow_value).toBe("-1");
    expect(obs.fast_value).toBe("1");
  });

  it("両側 undefined → not_applicable", () => {
    expect(checkReturnValue(capture(), capture()).verdict).toBe("not_applicable");
  });

  it("片方 undefined → not_equal", () => {
    const slow = capture({ return_value: "undefined", return_is_undefined: true });
    const fast = capture({ return_value: "1", return_is_undefined: false });
    expect(checkReturnValue(slow, fast).verdict).toBe("not_equal");
  });

  it("片方でも exception → not_applicable", () => {
    const slow = capture({ exception: { ctor: "Error", message: "e" } });
    const fast = capture({ return_value: "1", return_is_undefined: false });
    expect(checkReturnValue(slow, fast).verdict).toBe("not_applicable");
  });

  it("シリアライズ不能 → error", () => {
    const slow = capture({ return_value: UNSERIALIZABLE_MARKER, return_is_undefined: false });
    const fast = capture({ return_value: "1", return_is_undefined: false });
    expect(checkReturnValue(slow, fast).verdict).toBe("error");
  });
});
