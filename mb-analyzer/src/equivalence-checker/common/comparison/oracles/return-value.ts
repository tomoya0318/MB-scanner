import { ORACLE, ORACLE_VERDICT, type OracleObservation } from "../../../../contracts/equivalence-contracts";
import { UNSERIALIZABLE_MARKER } from "../../sandbox/capture/snapshot";
import type { ExecutionCapture } from "../../sandbox/capture/types";

/**
 * O1: 戻り値の deep equal 比較。
 * - 片方でも例外 → not_applicable（O3 に委ねる）
 * - 両側とも body が文のみ (return_is_undefined) → not_applicable
 * - 片方だけ undefined → not_equal
 * - 片方でもシリアライズ不能（循環参照等）→ error
 * - それ以外は serialize された文字列の完全一致で equal / not_equal
 */
export function checkReturnValue(
  before: ExecutionCapture,
  after: ExecutionCapture,
): OracleObservation {
  const oracle = ORACLE.RETURN_VALUE;

  if (before.exception !== null || after.exception !== null) {
    return { oracle, verdict: ORACLE_VERDICT.NOT_APPLICABLE };
  }
  if (before.return_is_undefined && after.return_is_undefined) {
    return { oracle, verdict: ORACLE_VERDICT.NOT_APPLICABLE };
  }
  if (before.return_value === UNSERIALIZABLE_MARKER || after.return_value === UNSERIALIZABLE_MARKER) {
    return {
      oracle,
      verdict: ORACLE_VERDICT.ERROR,
      before_value: before.return_value,
      after_value: after.return_value,
      detail: "return value could not be serialized",
    };
  }
  if (before.return_is_undefined !== after.return_is_undefined) {
    return {
      oracle,
      verdict: ORACLE_VERDICT.NOT_EQUAL,
      before_value: before.return_value,
      after_value: after.return_value,
      detail: "one side returned undefined while the other returned a value",
    };
  }
  if (before.return_value === after.return_value) {
    return {
      oracle,
      verdict: ORACLE_VERDICT.EQUAL,
      before_value: before.return_value,
      after_value: after.return_value,
    };
  }
  return {
    oracle,
    verdict: ORACLE_VERDICT.NOT_EQUAL,
    before_value: before.return_value,
    after_value: after.return_value,
  };
}

// 判断: ai-guide/adr/0007-in-source-testing-internal-helpers.md
if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;
  // 観点: 両側の戻り値を serialize 後の文字列で完全一致比較する。片側でも例外 → N/A (O3 に委譲)、
  // 両側 return_is_undefined → N/A、UNSERIALIZABLE_MARKER → error、片側だけ undefined / 値差 → not_equal。
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

  describe("checkReturnValue (in-source)", () => {
    it("両側同値 → equal", () => {
      const v = cap({ return_value: "42", return_is_undefined: false });
      expect(checkReturnValue(v, cap({ return_value: "42", return_is_undefined: false })).verdict).toBe("equal");
    });

    it("値が異なる → not_equal (before_value/after_value を載せる)", () => {
      const obs = checkReturnValue(
        cap({ return_value: "-1", return_is_undefined: false }),
        cap({ return_value: "1", return_is_undefined: false }),
      );
      expect(obs.verdict).toBe("not_equal");
      expect(obs.before_value).toBe("-1");
      expect(obs.after_value).toBe("1");
    });

    it("両側 undefined → not_applicable", () => {
      expect(checkReturnValue(cap(), cap()).verdict).toBe("not_applicable");
    });

    it("片方だけ undefined → not_equal", () => {
      expect(checkReturnValue(cap(), cap({ return_value: "1", return_is_undefined: false })).verdict).toBe(
        "not_equal",
      );
    });

    it("片方でも exception → not_applicable (O3 に委譲)", () => {
      const before = cap({ exception: { ctor: "Error", message: "e" } });
      expect(checkReturnValue(before, cap({ return_value: "1", return_is_undefined: false })).verdict).toBe(
        "not_applicable",
      );
    });

    it("シリアライズ不能 (UNSERIALIZABLE_MARKER) → error", () => {
      const before = cap({ return_value: UNSERIALIZABLE_MARKER, return_is_undefined: false });
      expect(checkReturnValue(before, cap({ return_value: "1", return_is_undefined: false })).verdict).toBe("error");
    });
  });
}
