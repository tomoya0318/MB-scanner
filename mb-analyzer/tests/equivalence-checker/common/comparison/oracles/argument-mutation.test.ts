/**
 * 対象: Oracle O2 - checkArgumentMutation (argument-mutation)
 * 観点: setup 由来の object/array に対する pre/post snapshot の差分を両側で比較する
 * 判定事項:
 *   - 両側とも setup で object/array を 1 つも定義していない → not_applicable
 *   - snapshot の pre/post にシリアライズ不能マーカを含む → error
 *   - key 集合と各 key の post が一致 → equal
 *   - いずれかの key で post が異なる → not_equal（detail に差分 key を列挙）
 */
import { describe, expect, it } from "vitest";
import { checkArgumentMutation } from "../../../../../src/equivalence-checker/common/comparison/oracles/argument-mutation";
import { UNSERIALIZABLE_MARKER } from "../../../../../src/equivalence-checker/common/sandbox/capture/snapshot";
import { capture } from "../../../../fixtures/capture";

describe("checkArgumentMutation", () => {
  it("setup で object 無し → not_applicable", () => {
    expect(checkArgumentMutation(capture(), capture()).verdict).toBe("not_applicable");
  });

  it("同じ key で同じ post → equal", () => {
    const s = capture({ arg_snapshots: [{ key: "arr", pre: "[1,2]", post: "[1,2,3]" }] });
    const f = capture({ arg_snapshots: [{ key: "arr", pre: "[1,2]", post: "[1,2,3]" }] });
    expect(checkArgumentMutation(s, f).verdict).toBe("equal");
  });

  it("同じ key で post が異なる → not_equal", () => {
    const s = capture({ arg_snapshots: [{ key: "arr", pre: "[1,2]", post: "[1,2,3]" }] });
    const f = capture({ arg_snapshots: [{ key: "arr", pre: "[1,2]", post: "[1,2]" }] });
    const obs = checkArgumentMutation(s, f);
    expect(obs.verdict).toBe("not_equal");
    expect(obs.detail).toContain("arr");
  });

  it("key 集合が違う → not_equal", () => {
    const s = capture({ arg_snapshots: [{ key: "a", pre: "{}", post: "{}" }] });
    const f = capture({ arg_snapshots: [{ key: "b", pre: "{}", post: "{}" }] });
    expect(checkArgumentMutation(s, f).verdict).toBe("not_equal");
  });

  it("UNSERIALIZABLE_MARKER を含む → error", () => {
    const s = capture({ arg_snapshots: [{ key: "c", pre: UNSERIALIZABLE_MARKER, post: "[]" }] });
    const f = capture({ arg_snapshots: [{ key: "c", pre: "[]", post: "[]" }] });
    expect(checkArgumentMutation(s, f).verdict).toBe("error");
  });
});
