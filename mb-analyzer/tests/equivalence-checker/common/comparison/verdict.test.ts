/**
 * 対象: deriveOverallVerdict (4 oracle の OracleObservation 配列から最終 Verdict を合成)
 * 観点: 優先順位分岐 (not_equal → error → 全 not_applicable → equal) を全て網羅する
 * 判定事項:
 *   - not_equal が 1 つでもあれば最優先で not_equal
 *   - not_equal なしで error があれば error
 *   - 全 oracle が not_applicable (観測対象ゼロ) → error
 *   - 空 observation → error
 *   - 残りは必ず equal を含むので equal
 */
import { describe, expect, it } from "vitest";
import { deriveOverallVerdict } from "../../../../src/equivalence-checker/common/comparison/verdict";
import { ORACLE, ORACLE_VERDICT, type OracleObservation } from "../../../../src/contracts/equivalence-contracts";

function obs(verdict: OracleObservation["verdict"]): OracleObservation {
  return { oracle: ORACLE.RETURN_VALUE, verdict };
}

describe("deriveOverallVerdict", () => {
  it("not_equal が 1 つでもあれば not_equal（最優先）", () => {
    expect(
      deriveOverallVerdict([obs(ORACLE_VERDICT.NOT_EQUAL), obs(ORACLE_VERDICT.EQUAL)]),
    ).toBe("not_equal");
  });

  it("not_equal がなく error があれば error", () => {
    expect(
      deriveOverallVerdict([obs(ORACLE_VERDICT.EQUAL), obs(ORACLE_VERDICT.ERROR)]),
    ).toBe("error");
  });

  it("全 not_applicable なら error", () => {
    expect(
      deriveOverallVerdict([
        obs(ORACLE_VERDICT.NOT_APPLICABLE),
        obs(ORACLE_VERDICT.NOT_APPLICABLE),
        obs(ORACLE_VERDICT.NOT_APPLICABLE),
        obs(ORACLE_VERDICT.NOT_APPLICABLE),
      ]),
    ).toBe("error");
  });

  it("equal が 1 つでもあり、error/not_equal なしなら equal", () => {
    expect(
      deriveOverallVerdict([
        obs(ORACLE_VERDICT.EQUAL),
        obs(ORACLE_VERDICT.NOT_APPLICABLE),
      ]),
    ).toBe("equal");
  });

  it("空 observation は error", () => {
    expect(deriveOverallVerdict([])).toBe("error");
  });
});
