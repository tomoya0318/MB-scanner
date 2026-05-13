import {
  ORACLE,
  ORACLE_VERDICT,
  VERDICT,
  type Oracle,
  type OracleObservation,
  type Verdict,
} from "../../../contracts/equivalence-contracts";

/**
 * positive な等価エビデンスを与える oracle 集合。これらのいずれかが non-`not_applicable` のときだけ
 * 全体を `equal` にできる。判断: ai-guide/adr/0018-equivalence-verdict-conservative.md
 *
 * `dom_mutation` の non-N/A は「少なくとも片側が DOM を実際に変更した」を意味する (oracle 側が
 * `capture.dom_changed` を見て両側未変更なら N/A を返すため) = positive evidence。
 * 一方 `exception` (両側同じくクラッシュ) / `external_observation` (scaffolding global ノイズ) の `equal` は
 * 単独では positive evidence と見なさない (前者は patch を exercise していない、後者は ignore pattern 後も
 * 残るノイズの可能性)。
 */
const POSITIVE_EVIDENCE_ORACLES: readonly Oracle[] = [
  ORACLE.RETURN_VALUE,
  ORACLE.ARGUMENT_MUTATION,
  ORACLE.INTERACTION_TRACE,
  ORACLE.DOM_MUTATION,
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
 * oracle observation 集合から全体 verdict を導出する純粋関数。
 *
 * 1. いずれかの oracle が not_equal → not_equal
 * 2. いずれかの oracle が error → error
 * 3. 全 oracle が not_applicable → inconclusive（観測チャネルゼロ）
 * 4. not_equal/error 無し かつ positive-evidence oracle ({return_value, argument_mutation,
 *    interaction_trace, dom_mutation}) がすべて not_applicable → inconclusive（差は観測されなかったが
 *    積極的等価エビデンスが無い = 中身を exercise できていない可能性が高い）
 * 5. exception=equal（両側同じく落ちた）かつ唯一の positive evidence が dom_mutation のみ → inconclusive
 *    （その DOM 変化は workload でなく bootstrap 由来の可能性が高い = 弱い equal）
 * 6. それ以外 → equal
 */
export function deriveOverallVerdict(observations: OracleObservation[]): Verdict {
  const verdicts = observations.map((o) => o.verdict);

  if (verdicts.includes(ORACLE_VERDICT.NOT_EQUAL)) return VERDICT.NOT_EQUAL;
  if (verdicts.includes(ORACLE_VERDICT.ERROR)) return VERDICT.ERROR;

  const hasApplicable = verdicts.some((v) => v !== ORACLE_VERDICT.NOT_APPLICABLE);
  if (!hasApplicable) return VERDICT.INCONCLUSIVE;

  const positiveEvidence = observations.filter(
    (o) => POSITIVE_EVIDENCE_ORACLES.includes(o.oracle) && o.verdict !== ORACLE_VERDICT.NOT_APPLICABLE,
  );
  if (positiveEvidence.length === 0) return VERDICT.INCONCLUSIVE;

  // 保守化: 両側が同じ例外で落ちた (exception=equal) かつ唯一の positive evidence が dom_mutation の場合、
  // その DOM 変化は workload 実行ではなく runnable の bootstrap (Angular の compile step 等) で生じた可能性が高く、
  // 「patch を exercise していない」= 弱い equal に該当する → inconclusive(both-sides-threw) に倒す。
  // C1 (return_value) は exception 時に必ず N/A、C4 (argument_mutation) / C6 (interaction_trace) が non-N/A なら
  // workload が部分的にでも exercise されたと見なせるので equal を保つ。
  const exception = observations.find((o) => o.oracle === ORACLE.EXCEPTION);
  const onlyDomEvidence = positiveEvidence.length === 1 && positiveEvidence[0]?.oracle === ORACLE.DOM_MUTATION;
  if (exception?.verdict === ORACLE_VERDICT.EQUAL && onlyDomEvidence) return VERDICT.INCONCLUSIVE;

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
