/**
 * どの実行環境でどの oracle を走らせるか + 評価順を決める (Selakovic adapter)。
 * 判断: ai-guide/adr/0015-equivalence-checker-layering-and-dom-oracle.md
 *
 * - `vm` 環境 (= pruning / 純粋計算): DOM も記録 Proxy も無いので C1/C4/C5/C3 の 4 本のみ。
 * - `jsdom` 環境 (= Selakovic の client / server candidate): 上記 4 本 + C2 (DOM) + C6 (interaction-trace)。
 *   C2/C6 はチャネル (`capture.dom_html` / `capture.interaction_trace`) が空なら oracle 自身が `not_applicable` を返す
 *   ので、環境だけで over-listing しても verdict は変わらない。
 *
 * 評価順は report の可読性のためだけで、verdict 合成は順序非依存。
 */
import { ORACLE, type Oracle } from "../../contracts/equivalence-contracts";

const VM_ORACLES: readonly Oracle[] = [
  ORACLE.RETURN_VALUE,
  ORACLE.ARGUMENT_MUTATION,
  ORACLE.EXCEPTION,
  ORACLE.EXTERNAL_OBSERVATION,
];

const JSDOM_ORACLES: readonly Oracle[] = [
  ORACLE.EXCEPTION,
  ORACLE.RETURN_VALUE,
  ORACLE.INTERACTION_TRACE,
  ORACLE.DOM_MUTATION,
  ORACLE.ARGUMENT_MUTATION,
  ORACLE.EXTERNAL_OBSERVATION,
];

export function routeOracles(environment: "vm" | "jsdom"): readonly Oracle[] {
  return environment === "jsdom" ? JSDOM_ORACLES : VM_ORACLES;
}

// 判断: ai-guide/adr/0007-in-source-testing-internal-helpers.md
if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;
  // 観点: 実行環境ごとに observations に載せる oracle 群を決める。vm = C1/C4/C5/C3 の 4 本、jsdom = 4 本 + C2 + C6。

  describe("routeOracles (in-source)", () => {
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
        new Set([
          "return_value",
          "argument_mutation",
          "exception",
          "external_observation",
          "dom_mutation",
          "interaction_trace",
        ]),
      );
      expect(oracles).toContain("dom_mutation");
      expect(oracles).toContain("interaction_trace");
    });
  });
}
