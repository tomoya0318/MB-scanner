/**
 * 対象: routeOracles (Selakovic adapter の oracle 選択)
 * 観点: 実行環境ごとに observations に載せる oracle 群を決める。vm は Phase 2a と同一、jsdom は + C2 + C6。
 */
import { describe, expect, it } from "vitest";
import { routeOracles } from "../../../src/equivalence-checker/selakovic/oracle-routing";

describe("routeOracles", () => {
  it("vm は C1/C4/C5/C3 の 4 本を従来の順で返す", () => {
    expect([...routeOracles("vm")]).toEqual([
      "return_value",
      "argument_mutation",
      "exception",
      "external_observation",
    ]);
  });

  it("jsdom は 4 本 + C2 (dom_mutation) + C6 (interaction_trace)", () => {
    const oracles = routeOracles("jsdom");
    expect(new Set(oracles)).toEqual(
      new Set(["return_value", "argument_mutation", "exception", "external_observation", "dom_mutation", "interaction_trace"]),
    );
    expect(oracles).toContain("dom_mutation");
    expect(oracles).toContain("interaction_trace");
  });
});
