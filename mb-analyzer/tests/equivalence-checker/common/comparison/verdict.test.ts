/**
 * 対象: deriveOverallVerdict / deriveVerdictReason (ADR-0018, 5 規則)
 * 観点: positive-evidence ルール (equal を許すのは {return_value, argument_mutation, interaction_trace}
 *       のいずれかが non-N/A のときだけ)、それ以外は inconclusive、と reason 分類を網羅する
 * 判定事項:
 *   - not_equal が 1 つでもあれば最優先で not_equal
 *   - not_equal なしで error があれば error
 *   - 全 oracle が not_applicable → inconclusive ("no-observable-channel")
 *   - 空 observation → inconclusive ("no-observable-channel")
 *   - exception=equal のみ → inconclusive ("both-sides-threw")
 *   - dom_mutation=equal / external_observation=equal だけ → inconclusive ("no-positive-evidence")
 *   - return_value/argument_mutation/interaction_trace のいずれかが non-N/A かつ差なし → equal (reason null)
 */
import { describe, expect, it } from "vitest";
import { deriveOverallVerdict, deriveVerdictReason } from "../../../../src/equivalence-checker/common/comparison/verdict";
import { ORACLE, ORACLE_VERDICT, type Oracle, type OracleObservation } from "../../../../src/contracts/equivalence-contracts";

function obs(oracle: Oracle, verdict: OracleObservation["verdict"]): OracleObservation {
  return { oracle, verdict };
}

const NA = ORACLE_VERDICT.NOT_APPLICABLE;
const EQ = ORACLE_VERDICT.EQUAL;
const NE = ORACLE_VERDICT.NOT_EQUAL;
const ERR = ORACLE_VERDICT.ERROR;

describe("deriveOverallVerdict", () => {
  it("not_equal が 1 つでもあれば not_equal（最優先）", () => {
    expect(
      deriveOverallVerdict([obs(ORACLE.RETURN_VALUE, NE), obs(ORACLE.INTERACTION_TRACE, EQ)]),
    ).toBe("not_equal");
  });

  it("not_equal がなく error があれば error", () => {
    expect(
      deriveOverallVerdict([obs(ORACLE.RETURN_VALUE, EQ), obs(ORACLE.ARGUMENT_MUTATION, ERR)]),
    ).toBe("error");
  });

  it("全 not_applicable は inconclusive", () => {
    expect(
      deriveOverallVerdict([
        obs(ORACLE.RETURN_VALUE, NA),
        obs(ORACLE.ARGUMENT_MUTATION, NA),
        obs(ORACLE.EXCEPTION, NA),
        obs(ORACLE.EXTERNAL_OBSERVATION, NA),
      ]),
    ).toBe("inconclusive");
  });

  it("空 observation は inconclusive", () => {
    expect(deriveOverallVerdict([])).toBe("inconclusive");
  });

  it("exception=equal のみ (両側同じくクラッシュ) は inconclusive", () => {
    expect(
      deriveOverallVerdict([
        obs(ORACLE.RETURN_VALUE, NA),
        obs(ORACLE.ARGUMENT_MUTATION, NA),
        obs(ORACLE.EXCEPTION, EQ),
        obs(ORACLE.EXTERNAL_OBSERVATION, NA),
      ]),
    ).toBe("inconclusive");
  });

  it("dom_mutation=equal は positive evidence (C-2 で dom_changed を見て N/A 判定する前提) → equal", () => {
    // ADR-0018 + Phase C-2: dom_mutation oracle が「両側とも DOM 未変更」を N/A にするので、
    // ここに non-N/A の equal が来ているなら「少なくとも片側が DOM を実際に変更した」を意味する = positive。
    expect(
      deriveOverallVerdict([
        obs(ORACLE.RETURN_VALUE, NA),
        obs(ORACLE.ARGUMENT_MUTATION, NA),
        obs(ORACLE.EXCEPTION, NA),
        obs(ORACLE.EXTERNAL_OBSERVATION, NA),
        obs(ORACLE.DOM_MUTATION, EQ),
        obs(ORACLE.INTERACTION_TRACE, NA),
      ]),
    ).toBe("equal");
  });

  it("exception=equal + dom_mutation=equal だけ → inconclusive (bootstrap で DOM 触ってから両側同じく落ちた = 弱い equal)", () => {
    expect(
      deriveOverallVerdict([
        obs(ORACLE.RETURN_VALUE, NA),
        obs(ORACLE.ARGUMENT_MUTATION, NA),
        obs(ORACLE.EXCEPTION, EQ),
        obs(ORACLE.EXTERNAL_OBSERVATION, NA),
        obs(ORACLE.DOM_MUTATION, EQ),
        obs(ORACLE.INTERACTION_TRACE, NA),
      ]),
    ).toBe("inconclusive");
  });

  it("exception=equal + dom_mutation=equal + interaction_trace=equal → equal (workload が trace を残しているので exercise されている)", () => {
    expect(
      deriveOverallVerdict([
        obs(ORACLE.RETURN_VALUE, NA),
        obs(ORACLE.ARGUMENT_MUTATION, NA),
        obs(ORACLE.EXCEPTION, EQ),
        obs(ORACLE.DOM_MUTATION, EQ),
        obs(ORACLE.INTERACTION_TRACE, EQ),
      ]),
    ).toBe("equal");
  });

  it("external_observation=equal だけ (positive evidence 無し) は inconclusive", () => {
    // 残った非 positive な oracle (external_observation = scaffolding global ノイズの可能性) 単独では equal 不可。
    expect(
      deriveOverallVerdict([
        obs(ORACLE.RETURN_VALUE, NA),
        obs(ORACLE.ARGUMENT_MUTATION, NA),
        obs(ORACLE.EXCEPTION, NA),
        obs(ORACLE.EXTERNAL_OBSERVATION, EQ),
        obs(ORACLE.DOM_MUTATION, NA),
        obs(ORACLE.INTERACTION_TRACE, NA),
      ]),
    ).toBe("inconclusive");
  });

  it("return_value=equal があれば (positive evidence) equal", () => {
    expect(
      deriveOverallVerdict([obs(ORACLE.RETURN_VALUE, EQ), obs(ORACLE.ARGUMENT_MUTATION, NA)]),
    ).toBe("equal");
  });

  it("interaction_trace=equal があれば equal", () => {
    expect(
      deriveOverallVerdict([
        obs(ORACLE.RETURN_VALUE, NA),
        obs(ORACLE.EXCEPTION, NA),
        obs(ORACLE.INTERACTION_TRACE, EQ),
      ]),
    ).toBe("equal");
  });

  it("argument_mutation=equal があれば equal", () => {
    expect(
      deriveOverallVerdict([obs(ORACLE.ARGUMENT_MUTATION, EQ), obs(ORACLE.EXCEPTION, EQ)]),
    ).toBe("equal");
  });
});

describe("deriveVerdictReason", () => {
  it("inconclusive 以外の verdict では null", () => {
    expect(deriveVerdictReason([obs(ORACLE.RETURN_VALUE, EQ)], "equal")).toBeNull();
    expect(deriveVerdictReason([obs(ORACLE.RETURN_VALUE, NE)], "not_equal")).toBeNull();
    expect(deriveVerdictReason([], "error")).toBeNull();
  });

  it("全 not_applicable / 空 → no-observable-channel", () => {
    expect(deriveVerdictReason([], "inconclusive")).toBe("no-observable-channel");
    expect(
      deriveVerdictReason([obs(ORACLE.RETURN_VALUE, NA), obs(ORACLE.EXCEPTION, NA)], "inconclusive"),
    ).toBe("no-observable-channel");
  });

  it("exception=equal のみ → both-sides-threw", () => {
    expect(
      deriveVerdictReason(
        [obs(ORACLE.RETURN_VALUE, NA), obs(ORACLE.EXCEPTION, EQ), obs(ORACLE.DOM_MUTATION, NA)],
        "inconclusive",
      ),
    ).toBe("both-sides-threw");
  });

  it("dom_mutation=equal だけ → no-positive-evidence", () => {
    expect(
      deriveVerdictReason(
        [obs(ORACLE.RETURN_VALUE, NA), obs(ORACLE.DOM_MUTATION, EQ)],
        "inconclusive",
      ),
    ).toBe("no-positive-evidence");
  });

  it("exception=equal + dom_mutation=equal → both-sides-threw (dom_mutation=equal はノイズとして無視)", () => {
    // jsdom では dom_mutation が常に non-N/A になるので、exception=equal が「両側 throw」の指標。
    expect(
      deriveVerdictReason(
        [obs(ORACLE.EXCEPTION, EQ), obs(ORACLE.DOM_MUTATION, EQ)],
        "inconclusive",
      ),
    ).toBe("both-sides-threw");
  });
});
