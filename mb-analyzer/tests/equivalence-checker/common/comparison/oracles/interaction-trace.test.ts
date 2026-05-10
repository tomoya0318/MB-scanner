/**
 * 対象: Oracle C6 - checkInteractionTrace (interaction-trace)
 * 観点: 記録 Proxy で取った workload→SUT 呼び出し列を slow/fast で要素ごとに比較する
 * 判定事項:
 *   - 両側 trace 空 / undefined → not_applicable
 *   - 同じ呼び出し列 → equal
 *   - 結果が違えば not_equal (detail に最初の差分エントリ)
 *   - ignorePathPrefixes で boot-phase 等を比較対象から外せる
 *   - ignoreGets で値 read のノイズを無視できる
 */
import { describe, expect, it } from "vitest";
import { checkInteractionTrace } from "../../../../../src/equivalence-checker/common/comparison/oracles/interaction-trace";
import type { TraceEntry } from "../../../../../src/equivalence-checker/common/sandbox/capture/types";
import { capture } from "../../../../fixtures/capture";

describe("checkInteractionTrace", () => {
  it("両側 trace 空 / undefined → not_applicable", () => {
    expect(checkInteractionTrace(capture(), capture()).verdict).toBe("not_applicable");
    expect(
      checkInteractionTrace(capture({ interaction_trace: [] }), capture({ interaction_trace: [] })).verdict,
    ).toBe("not_applicable");
  });

  it("同じ呼び出し列 → equal", () => {
    const trace: TraceEntry[] = [{ path: "obj.f", op: "call", args: ["1"], result: "2" }];
    expect(
      checkInteractionTrace(capture({ interaction_trace: trace }), capture({ interaction_trace: [...trace] }))
        .verdict,
    ).toBe("equal");
  });

  it("結果が違えば not_equal (detail に差分エントリ)", () => {
    const slow = capture({ interaction_trace: [{ path: "$scope.$eval", op: "call", args: ['"null.a"'], result: "42" }] });
    const fast = capture({ interaction_trace: [{ path: "$scope.$eval", op: "call", args: ['"null.a"'], result: "undefined" }] });
    const obs = checkInteractionTrace(slow, fast);
    expect(obs.verdict).toBe("not_equal");
    expect(obs.detail).toContain("entry 0");
  });

  it("ignorePathPrefixes で boot-phase の自己呼び出しを除外", () => {
    const slow = capture({
      interaction_trace: [
        { path: "angular.module", op: "call", args: [] },
        { path: "$scope.f", op: "call", args: [], result: "1" },
      ],
    });
    const fast = capture({ interaction_trace: [{ path: "$scope.f", op: "call", args: [], result: "1" }] });
    expect(checkInteractionTrace(slow, fast, { ignorePathPrefixes: ["angular."] }).verdict).toBe("equal");
    expect(checkInteractionTrace(slow, fast).verdict).toBe("not_equal");
  });

  it("ignoreGets で値 read のノイズを無視", () => {
    const slow = capture({
      interaction_trace: [
        { path: "x.length", op: "get", result: "3" },
        { path: "x.f", op: "call", args: [], result: "1" },
      ],
    });
    const fast = capture({ interaction_trace: [{ path: "x.f", op: "call", args: [], result: "1" }] });
    expect(checkInteractionTrace(slow, fast, { ignoreGets: true }).verdict).toBe("equal");
  });
});
