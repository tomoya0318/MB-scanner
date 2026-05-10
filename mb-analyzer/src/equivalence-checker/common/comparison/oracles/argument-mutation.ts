import { ORACLE, ORACLE_VERDICT, type OracleObservation } from "../../../../contracts/equivalence-contracts";
import { UNSERIALIZABLE_MARKER } from "../../sandbox/capture/snapshot";
import type { ExecutionCapture } from "../../sandbox/capture/types";

/**
 * O2: setup 由来 object/array の pre/post snapshot 差分比較。
 * pre/post は body 実行前後の時間軸 (slow/fast のサイド軸とは別概念)。
 * 概念モデル: ai-guide/code-map.md「観測軸: slow/fast と pre/post」
 *
 * - 両側とも setup で object/array を 1 つも定義していない → not_applicable
 * - snapshot にシリアライズ不能マーカを含む → error
 * - key 集合と各 post が一致 → equal
 * - いずれか差分 → not_equal
 */
export function checkArgumentMutation(
  slow: ExecutionCapture,
  fast: ExecutionCapture,
): OracleObservation {
  const oracle = ORACLE.ARGUMENT_MUTATION;

  if (slow.arg_snapshots.length === 0 && fast.arg_snapshots.length === 0) {
    return { oracle, verdict: ORACLE_VERDICT.NOT_APPLICABLE };
  }

  const hasUnserializable = [...slow.arg_snapshots, ...fast.arg_snapshots].some(
    (s) => s.pre === UNSERIALIZABLE_MARKER || s.post === UNSERIALIZABLE_MARKER,
  );
  if (hasUnserializable) {
    return {
      oracle,
      verdict: ORACLE_VERDICT.ERROR,
      detail: "one or more argument snapshots could not be serialized",
    };
  }

  const slowPost = new Map(slow.arg_snapshots.map((s) => [s.key, s.post]));
  const fastPost = new Map(fast.arg_snapshots.map((s) => [s.key, s.post]));
  const keys = new Set<string>([...slowPost.keys(), ...fastPost.keys()]);

  const differingKeys: string[] = [];
  for (const k of keys) {
    if (slowPost.get(k) !== fastPost.get(k)) differingKeys.push(k);
  }

  const slowSummary = JSON.stringify(Object.fromEntries(slowPost));
  const fastSummary = JSON.stringify(Object.fromEntries(fastPost));

  if (differingKeys.length === 0) {
    return {
      oracle,
      verdict: ORACLE_VERDICT.EQUAL,
      slow_value: slowSummary,
      fast_value: fastSummary,
    };
  }
  return {
    oracle,
    verdict: ORACLE_VERDICT.NOT_EQUAL,
    slow_value: slowSummary,
    fast_value: fastSummary,
    detail: `differing keys: ${differingKeys.sort().join(", ")}`,
  };
}
