/**
 * 対象: Oracle O3 - checkException (exception)
 * 観点: 両側の throw 状況と例外の ctor + message を比較する
 * 判定事項:
 *   - 両側とも正常終了 → not_applicable
 *   - 両側例外かつ ctor と message が一致 → equal
 *   - 両側例外だが ctor か message が異なる → not_equal
 *   - 片方だけ例外 → not_equal
 */
import { describe, expect, it } from "vitest";
import { checkException } from "../../../../../src/equivalence-checker/common/comparison/oracles/exception";
import { capture } from "../../../../fixtures/capture";

describe("checkException", () => {
  it("両側正常終了 → not_applicable", () => {
    expect(checkException(capture(), capture()).verdict).toBe("not_applicable");
  });

  it("ctor + message 一致 → equal", () => {
    const e = { ctor: "TypeError", message: "x" };
    expect(checkException(capture({ exception: e }), capture({ exception: e })).verdict).toBe("equal");
  });

  it("ctor 不一致 → not_equal", () => {
    const s = capture({ exception: { ctor: "TypeError", message: "x" } });
    const f = capture({ exception: { ctor: "RangeError", message: "x" } });
    const obs = checkException(s, f);
    expect(obs.verdict).toBe("not_equal");
    expect(obs.detail).toContain("TypeError");
  });

  it("message 不一致 → not_equal", () => {
    const s = capture({ exception: { ctor: "Error", message: "a" } });
    const f = capture({ exception: { ctor: "Error", message: "b" } });
    expect(checkException(s, f).verdict).toBe("not_equal");
  });

  it("片方だけ例外 → not_equal", () => {
    const obs = checkException(capture({ exception: { ctor: "Error", message: "x" } }), capture());
    expect(obs.verdict).toBe("not_equal");
    expect(obs.detail).toContain("only slow");
  });
});
