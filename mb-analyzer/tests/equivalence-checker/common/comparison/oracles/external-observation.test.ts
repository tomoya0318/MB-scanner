/**
 * 対象: Oracle O4 - checkExternalObservation (external-observation)
 * 観点: 外部観測可能な副作用（console 呼び出し列・新規に生えた global key 集合）の差分を両側で比較する
 * 判定事項:
 *   - 両側とも console 呼び出し・new_globals がどちらも空 → not_applicable
 *   - console args の serialize 中に循環参照 → error
 *   - console 列（method + args の順序含む完全一致）かつ new_globals key 集合一致 → equal
 *   - console か new_globals のいずれかに差分 → not_equal（detail に差分カテゴリ）
 */
import { describe, expect, it } from "vitest";
import { checkExternalObservation } from "../../../../../src/equivalence-checker/common/comparison/oracles/external-observation";
import type { ConsoleCall } from "../../../../../src/equivalence-checker/common/sandbox/capture/types";
import { capture } from "../../../../fixtures/capture";

const logA: ConsoleCall = { method: "log", args: ["a", 1] };
const logB: ConsoleCall = { method: "log", args: ["b"] };

describe("checkExternalObservation", () => {
  it("console 空 & new_globals 空 → not_applicable", () => {
    expect(checkExternalObservation(capture(), capture()).verdict).toBe("not_applicable");
  });

  it("console 列が完全一致 & globals 一致 → equal", () => {
    const s = capture({ console_log: [logA], new_globals: ["g"] });
    const f = capture({ console_log: [logA], new_globals: ["g"] });
    expect(checkExternalObservation(s, f).verdict).toBe("equal");
  });

  it("console 列が異なる → not_equal", () => {
    const s = capture({ console_log: [logA] });
    const f = capture({ console_log: [logB] });
    const obs = checkExternalObservation(s, f);
    expect(obs.verdict).toBe("not_equal");
    expect(obs.detail).toContain("console");
  });

  it("new_globals 集合が違う → not_equal", () => {
    const s = capture({ new_globals: ["a"] });
    const f = capture({ new_globals: ["b"] });
    const obs = checkExternalObservation(s, f);
    expect(obs.verdict).toBe("not_equal");
    expect(obs.detail).toContain("new_globals");
  });

  it("console の順序が違うと not_equal", () => {
    const s = capture({ console_log: [logA, logB] });
    const f = capture({ console_log: [logB, logA] });
    expect(checkExternalObservation(s, f).verdict).toBe("not_equal");
  });

  it("循環参照を含む args → error", () => {
    const cyc: Record<string, unknown> = {};
    cyc.self = cyc;
    const s = capture({ console_log: [{ method: "log", args: [cyc] }] });
    const f = capture({ console_log: [{ method: "log", args: ["x"] }] });
    expect(checkExternalObservation(s, f).verdict).toBe("error");
  });
});
