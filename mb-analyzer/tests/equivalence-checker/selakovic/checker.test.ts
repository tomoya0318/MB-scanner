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
import { checkEquivalence } from "../../../src/equivalence-checker/selakovic/checker";

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

  it("vm 環境では 4 observation が必ず揃う (C1/C4/C5/C3)", async () => {
    const result = await checkEquivalence({ slow: "1", fast: "1" });
    expect(result.observations.map((o) => o.oracle)).toEqual([
      "return_value",
      "argument_mutation",
      "exception",
      "external_observation",
    ]);
  });

  it("jsdom 環境では 6 observation が揃う (+ C2 dom_mutation / C6 interaction_trace)", async () => {
    const result = await checkEquivalence({ slow: "1 + 1", fast: "2", environment: "jsdom", timeout_ms: 5000 });
    expect(new Set(result.observations.map((o) => o.oracle))).toEqual(
      new Set(["exception", "return_value", "interaction_trace", "dom_mutation", "argument_mutation", "external_observation"]),
    );
    // 記録 Proxy は未注入なので C6 は not_applicable、DOM は両側未変更なので一致 (equal)
    const c6 = result.observations.find((o) => o.oracle === "interaction_trace");
    expect(c6?.verdict).toBe("not_applicable");
    expect(result.verdict).toBe("equal");
  });

  it("jsdom 環境で DOM を変えると C2 が verdict を出す", async () => {
    const result = await checkEquivalence({
      slow: "document.body.innerHTML = '<p>A</p>'; 1",
      fast: "document.body.innerHTML = '<p>B</p>'; 1",
      environment: "jsdom",
      timeout_ms: 5000,
    });
    const c2 = result.observations.find((o) => o.oracle === "dom_mutation");
    expect(c2?.verdict).toBe("not_equal");
    expect(result.verdict).toBe("not_equal");
  });
});
