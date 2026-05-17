/**
 * 対象: src/shared/equivalence-contracts.ts (Python ↔ TypeScript の JSON 契約)
 * 観点: Python 側 Pydantic enum / StrEnum と同じ文字列値・同じ union 幅で型が narrow されていること
 * 判定事項:
 *   - VERDICT / ORACLE_VERDICT / ORACLE: Python 側 StrEnum と同一の文字列値 (runtime)
 *   - Verdict / OracleVerdict / Oracle: union 型が Python と同じ列挙幅 (型レベル)
 *   - ALL_ORACLES: 6 oracle を過不足なく列挙
 *   - EquivalenceInput: slow/fast 必須、id/setup/timeout_ms/environment/module_base_dir/mount_html は任意
 *   - OracleObservation: JSON 往復でフィールド名と値を保持
 *   - EquivalenceCheckResult: equal は observations 必須、error は error_message を伴える
 */
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  ALL_ORACLES,
  ORACLE,
  ORACLE_VERDICT,
  VERDICT,
  type EquivalenceCheckResult,
  type EquivalenceInput,
  type Oracle,
  type OracleObservation,
  type OracleVerdict,
  type Verdict,
} from "../../src/contracts/equivalence-contracts";

describe("VERDICT", () => {
  it("Python 側 Verdict StrEnum と同じ文字列値を持つ", () => {
    expect(VERDICT).toStrictEqual({
      EQUAL: "equal",
      NOT_EQUAL: "not_equal",
      INCONCLUSIVE: "inconclusive",
      ERROR: "error",
    });
  });

  it("Verdict 型が 4 値の union として narrow される", () => {
    expectTypeOf<Verdict>().toEqualTypeOf<"equal" | "not_equal" | "inconclusive" | "error">();
  });
});

describe("ORACLE_VERDICT", () => {
  it("Python 側 OracleVerdict StrEnum と同じ文字列値を持つ", () => {
    expect(ORACLE_VERDICT).toStrictEqual({
      EQUAL: "equal",
      NOT_EQUAL: "not_equal",
      NOT_APPLICABLE: "not_applicable",
      ERROR: "error",
    });
  });

  it("OracleVerdict 型が 4 値の union", () => {
    expectTypeOf<OracleVerdict>().toEqualTypeOf<
      "equal" | "not_equal" | "not_applicable" | "error"
    >();
  });
});

describe("ORACLE", () => {
  it("Python 側 Oracle StrEnum と同じ文字列値を持つ", () => {
    expect(ORACLE).toStrictEqual({
      RETURN_VALUE: "return_value",
      ARGUMENT_MUTATION: "argument_mutation",
      EXCEPTION: "exception",
      EXTERNAL_OBSERVATION: "external_observation",
      DOM_MUTATION: "dom_mutation",
      INTERACTION_TRACE: "interaction_trace",
    });
  });

  it("ALL_ORACLES が 6 値を過不足なく列挙する", () => {
    expect(ALL_ORACLES).toHaveLength(6);
    expect(new Set(ALL_ORACLES)).toEqual(new Set(Object.values(ORACLE)));
  });
});

describe("EquivalenceInput", () => {
  it("slow / fast 必須、それ以外 (id / setup / timeout_ms / environment / module_base_dir / mount_html / workload) は任意", () => {
    const minimal: EquivalenceInput = { slow: "1", fast: "1" };
    const full: EquivalenceInput = {
      id: "case-001",
      setup: "const x = 1;",
      slow: "x",
      fast: "x",
      timeout_ms: 5000,
      environment: "jsdom",
      module_base_dir: "/abs/issue",
      mount_html: "<div id='demo'></div>",
    };
    expect(minimal.slow).toBe("1");
    expect(minimal.workload).toBeUndefined();
    expect(full.id).toBe("case-001");
    expect(full.timeout_ms).toBe(5000);
    expect(full.mount_html).toContain("demo");
    expect(full.environment).toBe("jsdom");
  });

  it("workload (ADR-0023 D-β placeholder substitution + 4 値契約) を含めて JSON 往復で保持される", () => {
    const inp: EquivalenceInput = {
      setup: "var lib = { f: function () { $BODY$ } };",
      slow: "__OBS__.push(1); return 1;",
      fast: "__OBS__.push(2); return 2;",
      workload: "(function(){ __OBS__ = []; lib.f(); return JSON.stringify(__OBS__); })()",
    };
    const parsed = JSON.parse(JSON.stringify(inp)) as EquivalenceInput;
    expect(parsed.workload).toBe(inp.workload);
    expect(parsed.setup).toContain("$BODY$");
  });
});

describe("OracleObservation", () => {
  it("JSON 往復でフィールド名と値が保持される", () => {
    const obs: OracleObservation = {
      oracle: ORACLE.RETURN_VALUE,
      verdict: ORACLE_VERDICT.NOT_EQUAL,
      slow_value: "-1",
      fast_value: "1",
      detail: null,
    };
    const parsed = JSON.parse(JSON.stringify(obs)) as OracleObservation;
    expect(parsed).toStrictEqual(obs);
    expect(Object.keys(parsed)).toEqual([
      "oracle",
      "verdict",
      "slow_value",
      "fast_value",
      "detail",
    ]);
  });
});

describe("EquivalenceCheckResult", () => {
  it("equal verdict は observations を含む", () => {
    const result: EquivalenceCheckResult = {
      verdict: VERDICT.EQUAL,
      observations: [
        { oracle: ORACLE.RETURN_VALUE, verdict: ORACLE_VERDICT.EQUAL },
        { oracle: ORACLE.ARGUMENT_MUTATION, verdict: ORACLE_VERDICT.NOT_APPLICABLE },
        { oracle: ORACLE.EXCEPTION, verdict: ORACLE_VERDICT.NOT_APPLICABLE },
        { oracle: ORACLE.EXTERNAL_OBSERVATION, verdict: ORACLE_VERDICT.NOT_APPLICABLE },
      ],
    };
    expect(result.observations).toHaveLength(4);
  });

  it("error verdict は error_message を伴える", () => {
    const result: EquivalenceCheckResult = {
      verdict: VERDICT.ERROR,
      observations: [],
      error_message: "timeout",
    };
    expect(result.error_message).toBe("timeout");
  });

  it("inconclusive verdict は verdict_reason を伴える", () => {
    const result: EquivalenceCheckResult = {
      verdict: VERDICT.INCONCLUSIVE,
      observations: [{ oracle: ORACLE.EXCEPTION, verdict: ORACLE_VERDICT.EQUAL }],
      verdict_reason: "both-sides-threw",
    };
    const parsed = JSON.parse(JSON.stringify(result)) as EquivalenceCheckResult;
    expect(parsed.verdict).toBe("inconclusive");
    expect(parsed.verdict_reason).toBe("both-sides-threw");
  });

  it("Oracle 型は readonly union として narrow される", () => {
    expectTypeOf<Oracle>().toEqualTypeOf<
      | "return_value"
      | "argument_mutation"
      | "exception"
      | "external_observation"
      | "dom_mutation"
      | "interaction_trace"
    >();
  });
});
