/**
 * 対象: checkEquivalence (top-level 合成: sandbox 実行 + 4 oracle 呼び出し + verdict 合成)
 * 観点: 実機 vm で slow / fast を実行し、全 oracle を並列判定して最終 verdict を導くエンドツーエンド検証
 * 判定事項:
 *   - 等価な式 (`1+1` vs `2`) → equal、return_value oracle も equal
 *   - Selakovic 反例 (`x % 2` vs `x & 1`, x=-3) → not_equal
 *   - 両側 throw で ctor+msg 一致 → equal、片方だけ throw → not_equal
 *   - setup で配列を共有し両側が同じ変異 → equal、異なる変異 → not_equal
 *   - 副作用分離: slow の破壊的変更が fast に伝播しない
 *   - console 出力差分 → not_equal
 *   - 片方 timeout → not_equal (例外 oracle で検知)
 *   - 4 oracle (return_value / argument_mutation / exception / external_observation) が必ず observations に揃う
 */
import { describe, expect, it } from "vitest";
import { checkEquivalence } from "../../src/equivalence-checker/checker";

describe("checkEquivalence", () => {
  it("equivalent な式は equal verdict", async () => {
    const result = await checkEquivalence({ slow: "1 + 1", fast: "2" });
    expect(result.verdict).toBe("equal");
    const returnValue = result.observations.find((o) => o.oracle === "return_value");
    expect(returnValue?.verdict).toBe("equal");
  });

  it("x % 2 vs x & 1 は負数で not_equal（Selakovic #8 の反例）", async () => {
    const result = await checkEquivalence({
      setup: "const x = -3;",
      slow: "x % 2",
      fast: "x & 1",
    });
    expect(result.verdict).toBe("not_equal");
    const ret = result.observations.find((o) => o.oracle === "return_value");
    expect(ret?.verdict).toBe("not_equal");
  });

  it("両側 throw (ctor + msg 一致) は equal", async () => {
    const result = await checkEquivalence({
      slow: `throw new TypeError("boom")`,
      fast: `throw new TypeError("boom")`,
    });
    expect(result.verdict).toBe("equal");
    const exc = result.observations.find((o) => o.oracle === "exception");
    expect(exc?.verdict).toBe("equal");
  });

  it("片方だけ throw は not_equal", async () => {
    const result = await checkEquivalence({
      slow: "1",
      fast: `throw new Error("x")`,
    });
    expect(result.verdict).toBe("not_equal");
  });

  it("setup で配列 + 両側が等価な変異 → equal", async () => {
    const result = await checkEquivalence({
      setup: "const arr = [1, 2, 3];",
      slow: "arr.push(4); arr",
      fast: "arr[arr.length] = 4; arr",
    });
    expect(result.verdict).toBe("equal");
  });

  it("console 出力が異なると not_equal", async () => {
    const result = await checkEquivalence({
      slow: `console.log("a")`,
      fast: `console.log("b")`,
    });
    expect(result.verdict).toBe("not_equal");
  });

  it("slow と fast は副作用を共有しない", async () => {
    // slow 側が配列を破壊しても、fast 側には伝播しない
    const result = await checkEquivalence({
      setup: "const arr = [1, 2, 3];",
      slow: "arr.pop(); arr.length",
      fast: "arr.length",
    });
    // slow は 2, fast は 3
    expect(result.verdict).toBe("not_equal");
  });

  it("timeout → error", async () => {
    const result = await checkEquivalence({
      slow: "while(true){}",
      fast: "1",
      timeout_ms: 50,
    });
    expect(result.verdict).toBe("not_equal"); // 片方 timeout 例外、片方正常 → O3 で not_equal
  });

  it("4 observation が必ず揃う", async () => {
    const result = await checkEquivalence({ slow: "1", fast: "1" });
    expect(result.observations.map((o) => o.oracle)).toEqual([
      "return_value",
      "argument_mutation",
      "exception",
      "external_observation",
    ]);
  });

  describe("undefined stub fallback", () => {
    it("setup に framework global (angular / require) を含んでも equal を判定できる", async () => {
      // jsperf 慣習を模した trio。両側とも framework 呼び出しは stub で吸収されるので
      // ピュアな算術部分の等価性だけが評価される。
      const result = await checkEquivalence({
        setup: `
          var module = angular.module("app", []);
          var lib = require("lodash");
          var n = 7;
        `,
        slow: "n * 2",
        fast: "n + n",
      });
      expect(result.verdict).toBe("equal");
    });

    it("execute(f1, n) ハーネス + setup の f1 で両側 equal を判定できる", async () => {
      // Selakovic の jsperf benchmark テンプレ: setup で f1 を定義し body は execute(f1, ...)
      // の呼び出し。execute は stub。f1 内部の最適化前後の意味が等価なら equal。
      const result = await checkEquivalence({
        setup: `var f1 = function (arr) { return arr.reduce(function (a, b) { return a + b; }, 0); };`,
        slow: "execute(function () { return f1([1,2,3,4]); }, 10)",
        fast: "execute(function () { return f1([1,2,3,4]); }, 10)",
      });
      expect(result.verdict).toBe("equal");
    });

    it("片側だけ未定義 global を呼んでも stub に化けるので throw 差にはならない", async () => {
      // 両側 stub() に解決され、return_value も typeof で揃って equal。
      const result = await checkEquivalence({
        slow: "typeof angular.module",
        fast: "typeof Ember.Application",
      });
      expect(result.verdict).toBe("equal");
    });

    it("setup で両側同じ例外が出れば exception oracle で equal", async () => {
      const result = await checkEquivalence({
        setup: `throw new TypeError("setup boom");`,
        slow: "1 + 1",
        fast: "2",
      });
      expect(result.verdict).toBe("equal");
      const exc = result.observations.find((o) => o.oracle === "exception");
      expect(exc?.verdict).toBe("equal");
    });
  });
});
