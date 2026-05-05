import { ORACLE, ORACLE_VERDICT, type OracleObservation } from "../../contracts/equivalence-contracts";
import { UNSERIALIZABLE_MARKER, type ExecutionCapture } from "../sandbox/executor";

/**
 * O1: 戻り値の deep equal 比較。
 * - 片方でも例外 → not_applicable（O3 に委ねる）
 * - 両側とも body が文のみ (return_is_undefined) → not_applicable
 * - 片方だけ undefined → not_equal
 * - 片方でもシリアライズ不能（循環参照等）→ error
 * - それ以外は serialize された文字列の完全一致で equal / not_equal
 */
export function checkReturnValue(
  slow: ExecutionCapture,
  fast: ExecutionCapture,
): OracleObservation {
  const oracle = ORACLE.RETURN_VALUE;

  if (slow.exception !== null || fast.exception !== null) {
    return { oracle, verdict: ORACLE_VERDICT.NOT_APPLICABLE };
  }
  if (slow.return_is_undefined && fast.return_is_undefined) {
    return { oracle, verdict: ORACLE_VERDICT.NOT_APPLICABLE };
  }
  if (slow.return_value === UNSERIALIZABLE_MARKER || fast.return_value === UNSERIALIZABLE_MARKER) {
    return {
      oracle,
      verdict: ORACLE_VERDICT.ERROR,
      slow_value: slow.return_value,
      fast_value: fast.return_value,
      detail: "return value could not be serialized",
    };
  }
  if (slow.return_is_undefined !== fast.return_is_undefined) {
    return {
      oracle,
      verdict: ORACLE_VERDICT.NOT_EQUAL,
      slow_value: slow.return_value,
      fast_value: fast.return_value,
      detail: "one side returned undefined while the other returned a value",
    };
  }
  if (slow.return_value === fast.return_value) {
    return {
      oracle,
      verdict: ORACLE_VERDICT.EQUAL,
      slow_value: slow.return_value,
      fast_value: fast.return_value,
    };
  }
  return {
    oracle,
    verdict: ORACLE_VERDICT.NOT_EQUAL,
    slow_value: slow.return_value,
    fast_value: fast.return_value,
  };
}
