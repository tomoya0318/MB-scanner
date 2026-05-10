import { ORACLE_VERDICT, VERDICT, type OracleObservation, type Verdict } from "../../../contracts/equivalence-contracts";

/**
 * 4 oracle の observation 集合から全体 verdict を導出する純粋関数。
 *
 * 優先順位:
 * 1. いずれかの oracle が not_equal → not_equal
 * 2. いずれかの oracle が error → error
 * 3. 全 oracle が not_applicable → error（観測対象ゼロでは等価性を判定できない）
 * 4. 残りは必ず equal を含む → equal
 */
export function deriveOverallVerdict(observations: OracleObservation[]): Verdict {
  const verdicts = observations.map((o) => o.verdict);

  if (verdicts.includes(ORACLE_VERDICT.NOT_EQUAL)) return VERDICT.NOT_EQUAL;
  if (verdicts.includes(ORACLE_VERDICT.ERROR)) return VERDICT.ERROR;

  const hasApplicable = verdicts.some((v) => v !== ORACLE_VERDICT.NOT_APPLICABLE);
  if (!hasApplicable) return VERDICT.ERROR;

  // ここまでで NOT_EQUAL / ERROR は除外され、全 NOT_APPLICABLE でもないことが保証される。
  // 残る OracleVerdict は EQUAL または NOT_APPLICABLE のみなので、少なくとも 1 つは EQUAL。
  return VERDICT.EQUAL;
}
