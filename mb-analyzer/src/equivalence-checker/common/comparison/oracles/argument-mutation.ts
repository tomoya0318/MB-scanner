import { ORACLE, ORACLE_VERDICT, type OracleObservation } from "../../../../contracts/equivalence-contracts";
import { UNSERIALIZABLE_MARKER } from "../../sandbox/capture/snapshot";
import type { ExecutionCapture } from "../../sandbox/capture/types";

/**
 * O2: setup 由来 object/array の pre/post snapshot 差分比較。
 * pre/post は body 実行前後の時間軸 (slow/fast のサイド軸とは別概念)。
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

// 判断: ai-guide/adr/0007-in-source-testing-internal-helpers.md
if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;
  // 観点: setup 由来 object/array の pre/post snapshot を両側で比較。両側とも snapshot 無し → N/A、
  // UNSERIALIZABLE_MARKER → error、key 集合 + 各 post 一致 → equal、差分 → not_equal (detail に差分 key)。
  const cap = (o: Partial<ExecutionCapture> = {}): ExecutionCapture => ({
    return_value: "undefined",
    return_is_undefined: true,
    arg_snapshots: [],
    exception: null,
    console_log: [],
    new_globals: [],
    timed_out: false,
    ...o,
  });

  describe("checkArgumentMutation (in-source)", () => {
    it("setup で object 無し → not_applicable", () => {
      expect(checkArgumentMutation(cap(), cap()).verdict).toBe("not_applicable");
    });

    it("同じ key で同じ post → equal", () => {
      const s = cap({ arg_snapshots: [{ key: "arr", pre: "[1,2]", post: "[1,2,3]" }] });
      const f = cap({ arg_snapshots: [{ key: "arr", pre: "[1,2]", post: "[1,2,3]" }] });
      expect(checkArgumentMutation(s, f).verdict).toBe("equal");
    });

    it("同じ key で post が異なる → not_equal (detail に差分 key)", () => {
      const s = cap({ arg_snapshots: [{ key: "arr", pre: "[1,2]", post: "[1,2,3]" }] });
      const f = cap({ arg_snapshots: [{ key: "arr", pre: "[1,2]", post: "[1,2]" }] });
      const obs = checkArgumentMutation(s, f);
      expect(obs.verdict).toBe("not_equal");
      expect(obs.detail).toContain("arr");
    });

    it("key 集合が違う → not_equal", () => {
      const s = cap({ arg_snapshots: [{ key: "a", pre: "{}", post: "{}" }] });
      const f = cap({ arg_snapshots: [{ key: "b", pre: "{}", post: "{}" }] });
      expect(checkArgumentMutation(s, f).verdict).toBe("not_equal");
    });

    it("UNSERIALIZABLE_MARKER を含む → error", () => {
      const s = cap({ arg_snapshots: [{ key: "c", pre: UNSERIALIZABLE_MARKER, post: "[]" }] });
      const f = cap({ arg_snapshots: [{ key: "c", pre: "[]", post: "[]" }] });
      expect(checkArgumentMutation(s, f).verdict).toBe("error");
    });
  });
}
