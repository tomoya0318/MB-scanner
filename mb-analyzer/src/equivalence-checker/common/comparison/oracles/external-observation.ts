import { ORACLE, ORACLE_VERDICT, type OracleObservation } from "../../../../contracts/equivalence-contracts";
import { serializeValue, SerializationError } from "../../serializer";
import type { ConsoleCall, ExecutionCapture } from "../../sandbox/capture/types";

/** O4 (= C3 console + C4 新規 global key) の adapter 渡し opt。 */
export interface ExternalObservationProfile {
  /** `new_globals` からこの正規表現群のいずれかにマッチする key を除外する (例: AngularJS の `ng*` 内部 global → angular-7759_4 の偽 not_equal 解消)。 */
  ignoreNewGlobalPatterns?: readonly RegExp[];
}

const EMPTY_PROFILE: ExternalObservationProfile = {};

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
  profile: ExternalObservationProfile = EMPTY_PROFILE,
): OracleObservation {
  const oracle = ORACLE.EXTERNAL_OBSERVATION;
  const ignorePatterns = profile.ignoreNewGlobalPatterns ?? [];
  const keepGlobal = (k: string): boolean => !ignorePatterns.some((re) => re.test(k));
  const slowGlobalsRaw = slow.new_globals.filter(keepGlobal);
  const fastGlobalsRaw = fast.new_globals.filter(keepGlobal);

  const noSideEffects =
    slow.console_log.length === 0 &&
    fast.console_log.length === 0 &&
    slowGlobalsRaw.length === 0 &&
    fastGlobalsRaw.length === 0;
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

  const slowGlobals = [...new Set(slowGlobalsRaw)].sort();
  const fastGlobals = [...new Set(fastGlobalsRaw)].sort();
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
