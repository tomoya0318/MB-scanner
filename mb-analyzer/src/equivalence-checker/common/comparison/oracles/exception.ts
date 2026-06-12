import { ORACLE, ORACLE_VERDICT, type OracleObservation } from "../../../../contracts/equivalence-contracts";
import type { ExceptionCapture, ExecutionCapture } from "../../sandbox/capture/types";

/** O3 (exception) の adapter 渡し opt。 */
export interface ExceptionProfile {
  /**
   * 比較前に ctor / message に適用する `[RegExp, replacement]` 群。
   * 例: Selakovic dataset は before/after を `<lib>_before/`/`<lib>_after/` の別 dir に置くので
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
  before: ExecutionCapture,
  after: ExecutionCapture,
  profile: ExceptionProfile = EMPTY_PROFILE,
): OracleObservation {
  const oracle = ORACLE.EXCEPTION;
  const se = before.exception;
  const fe = after.exception;
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
        before_value: formatException(se),
        after_value: formatException(fe),
      };
    }
    return {
      oracle,
      verdict: ORACLE_VERDICT.NOT_EQUAL,
      before_value: formatException(se),
      after_value: formatException(fe),
      detail:
        sCtor !== fCtor
          ? `different exception type: ${se.ctor} vs ${fe.ctor}`
          : `different message: ${JSON.stringify(se.message)} vs ${JSON.stringify(fe.message)}`,
    };
  }
  return {
    oracle,
    verdict: ORACLE_VERDICT.NOT_EQUAL,
    before_value: se ? formatException(se) : null,
    after_value: fe ? formatException(fe) : null,
    detail: se ? "only before threw an exception" : "only after threw an exception",
  };
}

function formatException(e: ExceptionCapture): string {
  return `${e.ctor}: ${e.message}`;
}

// 判断: ai-guide/adr/0007-in-source-testing-internal-helpers.md
if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;
  // 観点: 両側の throw 状況と例外 ctor + (正規化後の) message を比較。両側正常 → N/A、両側 throw で一致 → equal、
  // ctor / message 差 → not_equal、片側だけ throw → not_equal。
  // 統合観点: dataset が before/after を `<lib>_before/` `<lib>_after/` の別 dir に置くと
  // `Cannot find module './backbone_before/...'` vs `'./backbone_after/...'` の message 差が偽 not_equal を生む
  // (backbone-1097/2858/707 / mocha-763)。`normalizeMessagePatterns` で `_(before|after)` を除去すると一致する。
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

  describe("checkException (in-source)", () => {
    it("両側正常終了 → not_applicable", () => {
      expect(checkException(cap(), cap()).verdict).toBe("not_applicable");
    });

    it("ctor + message 一致 → equal", () => {
      const e = { ctor: "TypeError", message: "x" };
      expect(checkException(cap({ exception: e }), cap({ exception: e })).verdict).toBe("equal");
    });

    it("ctor 不一致 → not_equal (detail に型名)", () => {
      const obs = checkException(
        cap({ exception: { ctor: "TypeError", message: "x" } }),
        cap({ exception: { ctor: "RangeError", message: "x" } }),
      );
      expect(obs.verdict).toBe("not_equal");
      expect(obs.detail).toContain("TypeError");
    });

    it("message 不一致 → not_equal", () => {
      const s = cap({ exception: { ctor: "Error", message: "a" } });
      const f = cap({ exception: { ctor: "Error", message: "b" } });
      expect(checkException(s, f).verdict).toBe("not_equal");
    });

    it("片方だけ例外 → not_equal (detail に which side)", () => {
      const obs = checkException(cap({ exception: { ctor: "Error", message: "x" } }), cap());
      expect(obs.verdict).toBe("not_equal");
      expect(obs.detail).toContain("only before");
    });

    it("normalizeMessagePatterns で `_before`/`_after` を消すと両側同じく落ちたと判定 → equal", () => {
      const s = cap({ exception: { ctor: "Error", message: "Cannot find module './backbone_before/node_modules/x'" } });
      const f = cap({ exception: { ctor: "Error", message: "Cannot find module './backbone_after/node_modules/x'" } });
      const profile = {
        normalizeMessagePatterns: [[/([A-Za-z][\w.$-]*)_(?:before|after)(?=[/'")\s.\\:]|$)/g, "$1"]] as const,
      };
      expect(checkException(s, f).verdict).toBe("not_equal"); // 正規化なしでは differ
      expect(checkException(s, f, profile).verdict).toBe("equal"); // 正規化すると一致
    });
  });
}
