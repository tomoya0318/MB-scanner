import { ORACLE, ORACLE_VERDICT, type OracleObservation } from "../../../../contracts/equivalence-contracts";
import type { ExceptionCapture, ExecutionCapture } from "../../sandbox/capture/types";

/** O3 (exception) の adapter 渡し opt。 */
export interface ExceptionProfile {
  /**
   * 比較前に ctor / message に適用する `[RegExp, replacement]` 群。
   * 例: Selakovic dataset は slow/fast を `<lib>_before/`/`<lib>_after/` の別 dir に置くので
   * `Cannot find module './backbone_before/...'` vs `'./backbone_after/...'` のように message に
   * 配置 artifact が混じる → `_(before|after)` を除去して「両側同じく落ちた」と正しく判定する。
   */
  normalizeMessagePatterns?: ReadonlyArray<readonly [RegExp, string]>;
}

const EMPTY_PROFILE: ExceptionProfile = {};

/**
 * O3: 例外の判定表。
 * - 両側正常終了 → not_applicable
 * - 両側例外 & ctor + (正規化後の) message 一致 → equal
 * - 両側例外 & 不一致 → not_equal
 * - 片方だけ例外 → not_equal
 */
export function checkException(
  slow: ExecutionCapture,
  fast: ExecutionCapture,
  profile: ExceptionProfile = EMPTY_PROFILE,
): OracleObservation {
  const oracle = ORACLE.EXCEPTION;
  const se = slow.exception;
  const fe = fast.exception;
  const patterns = profile.normalizeMessagePatterns ?? [];
  const norm = (s: string): string => patterns.reduce((acc, [re, repl]) => acc.replace(re, repl), s);

  if (se === null && fe === null) {
    return { oracle, verdict: ORACLE_VERDICT.NOT_APPLICABLE };
  }
  if (se !== null && fe !== null) {
    const sCtor = norm(se.ctor);
    const fCtor = norm(fe.ctor);
    const sMsg = norm(se.message);
    const fMsg = norm(fe.message);
    if (sCtor === fCtor && sMsg === fMsg) {
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
        sCtor !== fCtor
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
