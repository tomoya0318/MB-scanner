import {
  ORACLE,
  ORACLE_VERDICT,
  VERDICT,
  type Oracle,
  type OracleObservation,
  type Verdict,
} from "../../../contracts/equivalence-contracts";

/**
 * positive な等価エビデンスを与える oracle 集合 (ADR-0018)。
 * これらのいずれかが non-`not_applicable` のときだけ全体を `equal` にできる。
 * `exception` (両側同じくクラッシュ) / `dom_mutation` (初期から変化していない可能性) /
 * `external_observation` (scaffolding global ノイズ) の `equal` は単独では positive evidence と見なさない。
 */
const POSITIVE_EVIDENCE_ORACLES: readonly Oracle[] = [
  ORACLE.RETURN_VALUE,
  ORACLE.ARGUMENT_MUTATION,
  ORACLE.INTERACTION_TRACE,
];

/**
 * `inconclusive` verdict の理由文字列 (ADR-0018)。`equal` / `not_equal` では `null`。
 * `executor-error` は executor crash / setup throw 由来の `error` verdict 用で、checker 本体が
 * 直接セットする (`deriveVerdictReason` は返さない)。
 */
export const VERDICT_REASON = {
  /** 全 oracle が not_applicable (観測チャネルゼロ)。 */
  NO_OBSERVABLE_CHANNEL: "no-observable-channel",
  /** exception oracle が equal (= 両側が同じ例外で落ちた) で、positive-evidence oracle はすべて not_applicable。 */
  BOTH_SIDES_THREW: "both-sides-threw",
  /** 例外も無く positive-evidence oracle もすべて not_applicable (dom_mutation / external_observation だけが equal 等)。 */
  NO_POSITIVE_EVIDENCE: "no-positive-evidence",
  /** executor crash / setup throw / serialize 失敗。 */
  EXECUTOR_ERROR: "executor-error",
} as const;
export type VerdictReason = (typeof VERDICT_REASON)[keyof typeof VERDICT_REASON];

/**
 * oracle observation 集合から全体 verdict を導出する純粋関数 (ADR-0018, 5 規則)。
 *
 * 1. いずれかの oracle が not_equal → not_equal
 * 2. いずれかの oracle が error → error
 * 3. 全 oracle が not_applicable → inconclusive（観測チャネルゼロ）
 * 4. not_equal/error 無し かつ positive-evidence oracle ({return_value, argument_mutation,
 *    interaction_trace}) がすべて not_applicable → inconclusive（差は観測されなかったが
 *    積極的等価エビデンスが無い = 中身を exercise できていない可能性が高い）
 * 5. それ以外 → equal
 */
export function deriveOverallVerdict(observations: OracleObservation[]): Verdict {
  const verdicts = observations.map((o) => o.verdict);

  if (verdicts.includes(ORACLE_VERDICT.NOT_EQUAL)) return VERDICT.NOT_EQUAL;
  if (verdicts.includes(ORACLE_VERDICT.ERROR)) return VERDICT.ERROR;

  const hasApplicable = verdicts.some((v) => v !== ORACLE_VERDICT.NOT_APPLICABLE);
  if (!hasApplicable) return VERDICT.INCONCLUSIVE;

  const hasPositiveEvidence = observations.some(
    (o) => POSITIVE_EVIDENCE_ORACLES.includes(o.oracle) && o.verdict !== ORACLE_VERDICT.NOT_APPLICABLE,
  );
  if (!hasPositiveEvidence) return VERDICT.INCONCLUSIVE;

  // ここまでで NOT_EQUAL / ERROR は除外され、positive-evidence oracle に non-N/A が 1 つ以上ある。
  return VERDICT.EQUAL;
}

/**
 * `deriveOverallVerdict` が `inconclusive` を返した理由を分類する (ADR-0018)。
 * `inconclusive` 以外の verdict では `null`。
 */
export function deriveVerdictReason(
  observations: OracleObservation[],
  verdict: Verdict,
): VerdictReason | null {
  if (verdict !== VERDICT.INCONCLUSIVE) return null;

  const hasApplicable = observations.some((o) => o.verdict !== ORACLE_VERDICT.NOT_APPLICABLE);
  if (!hasApplicable) return VERDICT_REASON.NO_OBSERVABLE_CHANNEL;
  // inconclusive かつ非 N/A の oracle がある時点で not_equal/error は無いので、exception は N/A か equal のいずれか。
  // equal なら「両側が同じ例外で落ちた」(jsdom では dom_mutation=equal も常に付くが、それは情報を足さないノイズ)。
  const exception = observations.find((o) => o.oracle === ORACLE.EXCEPTION);
  if (exception?.verdict === ORACLE_VERDICT.EQUAL) return VERDICT_REASON.BOTH_SIDES_THREW;
  return VERDICT_REASON.NO_POSITIVE_EVIDENCE;
}
