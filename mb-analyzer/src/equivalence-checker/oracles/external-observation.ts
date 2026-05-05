import { ORACLE, ORACLE_VERDICT, type OracleObservation } from "../../contracts/equivalence-contracts";
import { serializeValue, SerializationError } from "../sandbox/serializer";
import type { ExecutionCapture } from "../sandbox/executor";
import type { ConsoleCall } from "../sandbox/stabilizer";

/**
 * O4: console 呼び出し列 + 新規 global key の diff。
 * - console 列が空かつ両側とも new_globals 空 → not_applicable
 * - console args のシリアライズ中に循環参照 → error
 * - console 列の完全一致（method + args の順序含む）かつ new_globals key 集合一致 → equal
 * - いずれか差分 → not_equal
 */
export function checkExternalObservation(
  slow: ExecutionCapture,
  fast: ExecutionCapture,
): OracleObservation {
  const oracle = ORACLE.EXTERNAL_OBSERVATION;

  const noSideEffects =
    slow.console_log.length === 0 &&
    fast.console_log.length === 0 &&
    slow.new_globals.length === 0 &&
    fast.new_globals.length === 0;
  if (noSideEffects) {
    return { oracle, verdict: ORACLE_VERDICT.NOT_APPLICABLE };
  }

  let slowConsoleSig: string;
  let fastConsoleSig: string;
  try {
    slowConsoleSig = serializeConsoleCalls(slow.console_log);
    fastConsoleSig = serializeConsoleCalls(fast.console_log);
  } catch (e) {
    if (e instanceof SerializationError) {
      return {
        oracle,
        verdict: ORACLE_VERDICT.ERROR,
        detail: "console argument could not be serialized (circular reference)",
      };
    }
    // 想定外エラーは握りつぶさずクラッシュさせる防御再スロー。現 serializer は
    // SerializationError のみを投げる設計なので型上 unreachable。将来 serializer が
    // 別例外を投げたときにサイレント誤判定になるのを防ぐ。
    /* c8 ignore next 2 */
    throw e;
  }

  const consoleEqual = slowConsoleSig === fastConsoleSig;

  const slowGlobals = [...new Set(slow.new_globals)].sort();
  const fastGlobals = [...new Set(fast.new_globals)].sort();
  const globalsEqual =
    slowGlobals.length === fastGlobals.length &&
    slowGlobals.every((k, i) => k === fastGlobals[i]);

  const slowSummary = JSON.stringify({ console: slowConsoleSig, new_globals: slowGlobals });
  const fastSummary = JSON.stringify({ console: fastConsoleSig, new_globals: fastGlobals });

  if (consoleEqual && globalsEqual) {
    return {
      oracle,
      verdict: ORACLE_VERDICT.EQUAL,
      slow_value: slowSummary,
      fast_value: fastSummary,
    };
  }
  const differs: string[] = [];
  if (!consoleEqual) differs.push("console");
  if (!globalsEqual) differs.push("new_globals");
  return {
    oracle,
    verdict: ORACLE_VERDICT.NOT_EQUAL,
    slow_value: slowSummary,
    fast_value: fastSummary,
    detail: `differs in: ${differs.join(", ")}`,
  };
}

function serializeConsoleCalls(calls: ConsoleCall[]): string {
  const serialized = calls.map((c) => ({
    method: c.method,
    args: c.args.map((a) => serializeValue(a)),
  }));
  return JSON.stringify(serialized);
}
