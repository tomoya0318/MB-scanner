import { ORACLE, ORACLE_VERDICT, type OracleObservation } from "../../../../contracts/equivalence-contracts";
import type { ExceptionCapture, ExecutionCapture } from "../../sandbox/capture/types";

/**
 * O3: 例外の判定表。
 * - 両側正常終了 → not_applicable
 * - 両側例外 & ctor + message 一致 → equal
 * - 両側例外 & 不一致 → not_equal
 * - 片方だけ例外 → not_equal
 */
export function checkException(
  slow: ExecutionCapture,
  fast: ExecutionCapture,
): OracleObservation {
  const oracle = ORACLE.EXCEPTION;
  const se = slow.exception;
  const fe = fast.exception;

  if (se === null && fe === null) {
    return { oracle, verdict: ORACLE_VERDICT.NOT_APPLICABLE };
  }
  if (se !== null && fe !== null) {
    if (se.ctor === fe.ctor && se.message === fe.message) {
      return {
        oracle,
        verdict: ORACLE_VERDICT.EQUAL,
        slow_value: formatException(se),
        fast_value: formatException(fe),
      };
    }
    return {
      oracle,
      verdict: ORACLE_VERDICT.NOT_EQUAL,
      slow_value: formatException(se),
      fast_value: formatException(fe),
      detail:
        se.ctor !== fe.ctor
          ? `different exception type: ${se.ctor} vs ${fe.ctor}`
          : `different message: ${JSON.stringify(se.message)} vs ${JSON.stringify(fe.message)}`,
    };
  }
  return {
    oracle,
    verdict: ORACLE_VERDICT.NOT_EQUAL,
    slow_value: se ? formatException(se) : null,
    fast_value: fe ? formatException(fe) : null,
    detail: se ? "only slow threw an exception" : "only fast threw an exception",
  };
}

function formatException(e: ExceptionCapture): string {
  return `${e.ctor}: ${e.message}`;
}
