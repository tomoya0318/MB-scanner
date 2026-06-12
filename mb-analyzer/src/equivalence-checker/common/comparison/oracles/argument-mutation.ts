import { ORACLE, ORACLE_VERDICT, type OracleObservation } from "../../../../contracts/equivalence-contracts";
import { UNSERIALIZABLE_MARKER } from "../../sandbox/capture/snapshot";
import type { ExecutionCapture } from "../../sandbox/capture/types";

/**
 * O2: setup 由来 object/array の pre/post snapshot 差分比較。
 * pre/post は body 実行前後の時間軸 (slow/fast のサイド軸とは別概念)。
 *
 * - 両側とも setup で object/array を 1 つも定義していない → not_applicable
 * - snapshot にシリアライズ不能マーカ (循環参照等) を含む key は **比較対象から除外**。残り 0 件 → not_applicable
 *   (= 「観測できる setup object が無かった」と同じ扱い)。理由: serialize 失敗 (= 観測できない) を `error`
 *   に丸めると Ember 級 lib で `globalThis.Ember` が循環していて常に `error` → 候補全体が捨てられる。
 *   観測できないことと壊れていることは別。observe できる key だけで判定し、ゼロなら N/A にして他 oracle に委ねる。
 *   ADR-0018 の保守化 (positive evidence が無ければ全体 `inconclusive`) はこの後段で効くので健全性は保たれる。
 * - key 集合と各 post が一致 → equal
 * - いずれか差分 → not_equal
 */
// TODO(v2): serializer.ts 側で循環参照を throw でなく `<circular>` sentinel に丸めれば、循環オブジェクトも
// 「巨大だが有限の文字列」として比較できる (要 maxDepth デフォルト設定で文字列サイズを抑える)。
// そうすればここのシリアライズ不能 key 除外も不要になる。
export function checkArgumentMutation(
  slow: ExecutionCapture,
  fast: ExecutionCapture,
): OracleObservation {
  const oracle = ORACLE.ARGUMENT_MUTATION;

  if (slow.arg_snapshots.length === 0 && fast.arg_snapshots.length === 0) {
    return { oracle, verdict: ORACLE_VERDICT.NOT_APPLICABLE };
  }

  const serializable = (s: { pre: string; post: string }): boolean =>
    s.pre !== UNSERIALIZABLE_MARKER && s.post !== UNSERIALIZABLE_MARKER;
  const slowPost = new Map(slow.arg_snapshots.filter(serializable).map((s) => [s.key, s.post]));
  const fastPost = new Map(fast.arg_snapshots.filter(serializable).map((s) => [s.key, s.post]));
  if (slowPost.size === 0 && fastPost.size === 0) {
    return { oracle, verdict: ORACLE_VERDICT.NOT_APPLICABLE };
  }
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
  // UNSERIALIZABLE_MARKER を含む key は除外 (残り 0 件 → N/A、残った key だけで判定)、
  // key 集合 + 各 post 一致 → equal、差分 → not_equal (detail に差分 key)。
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

    it("snapshot が全て UNSERIALIZABLE_MARKER (循環 Ember グローバル等) → not_applicable (error にしない)", () => {
      const s = cap({ arg_snapshots: [{ key: "Ember", pre: UNSERIALIZABLE_MARKER, post: UNSERIALIZABLE_MARKER }] });
      const f = cap({ arg_snapshots: [{ key: "Ember", pre: UNSERIALIZABLE_MARKER, post: UNSERIALIZABLE_MARKER }] });
      expect(checkArgumentMutation(s, f).verdict).toBe("not_applicable");
    });

    it("一部の key だけ UNSERIALIZABLE → その key は無視し、残りで判定 (一致 → equal)", () => {
      const s = cap({ arg_snapshots: [{ key: "Ember", pre: UNSERIALIZABLE_MARKER, post: UNSERIALIZABLE_MARKER }, { key: "arr", pre: "[1]", post: "[1,2]" }] });
      const f = cap({ arg_snapshots: [{ key: "Ember", pre: UNSERIALIZABLE_MARKER, post: UNSERIALIZABLE_MARKER }, { key: "arr", pre: "[1]", post: "[1,2]" }] });
      expect(checkArgumentMutation(s, f).verdict).toBe("equal");
    });

    it("一部の key だけ UNSERIALIZABLE で、観測できる残りに差分 → not_equal", () => {
      const s = cap({ arg_snapshots: [{ key: "Ember", pre: UNSERIALIZABLE_MARKER, post: "[]" }, { key: "arr", pre: "[1]", post: "[1,2]" }] });
      const f = cap({ arg_snapshots: [{ key: "Ember", pre: "[]", post: "[]" }, { key: "arr", pre: "[1]", post: "[1]" }] });
      const obs = checkArgumentMutation(s, f);
      expect(obs.verdict).toBe("not_equal");
      expect(obs.detail).toContain("arr");
    });
  });
}
