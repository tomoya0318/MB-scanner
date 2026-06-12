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
  before: ExecutionCapture,
  after: ExecutionCapture,
  profile: ExternalObservationProfile = EMPTY_PROFILE,
): OracleObservation {
  const oracle = ORACLE.EXTERNAL_OBSERVATION;
  const ignorePatterns = profile.ignoreNewGlobalPatterns ?? [];
  const keepGlobal = (k: string): boolean => !ignorePatterns.some((re) => re.test(k));
  const beforeGlobalsRaw = before.new_globals.filter(keepGlobal);
  const afterGlobalsRaw = after.new_globals.filter(keepGlobal);

  const noSideEffects =
    before.console_log.length === 0 &&
    after.console_log.length === 0 &&
    beforeGlobalsRaw.length === 0 &&
    afterGlobalsRaw.length === 0;
  if (noSideEffects) {
    return { oracle, verdict: ORACLE_VERDICT.NOT_APPLICABLE };
  }

  let beforeConsoleSig: string;
  let afterConsoleSig: string;
  try {
    beforeConsoleSig = serializeConsoleCalls(before.console_log);
    afterConsoleSig = serializeConsoleCalls(after.console_log);
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

  const consoleEqual = beforeConsoleSig === afterConsoleSig;

  const beforeGlobals = [...new Set(beforeGlobalsRaw)].sort();
  const afterGlobals = [...new Set(afterGlobalsRaw)].sort();
  const globalsEqual =
    beforeGlobals.length === afterGlobals.length &&
    beforeGlobals.every((k, i) => k === afterGlobals[i]);

  const beforeSummary = JSON.stringify({ console: beforeConsoleSig, new_globals: beforeGlobals });
  const afterSummary = JSON.stringify({ console: afterConsoleSig, new_globals: afterGlobals });

  if (consoleEqual && globalsEqual) {
    return {
      oracle,
      verdict: ORACLE_VERDICT.EQUAL,
      before_value: beforeSummary,
      after_value: afterSummary,
    };
  }
  const differs: string[] = [];
  if (!consoleEqual) differs.push("console");
  if (!globalsEqual) differs.push("new_globals");
  return {
    oracle,
    verdict: ORACLE_VERDICT.NOT_EQUAL,
    before_value: beforeSummary,
    after_value: afterSummary,
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

// 判断: ai-guide/adr/0007-in-source-testing-internal-helpers.md
if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;
  // 観点: 外部観測可能な副作用 (console 呼び出し列 + 新規 global key 集合) の差分を両側で比較。
  // 両側とも空 → N/A、console args の serialize 中に循環参照 → error、console 列 (順序込み) + globals 集合一致 → equal。
  // 統合観点: `f1` body / preWorkload が `<script>` で top-level 実行されると `var i` / `var keys` 等の scaffolding 変数が
  // 片側だけ global に漏れて偽 not_equal を生む (underscore-1224)。AngularJS の `ng-<timestamp>` cache key global も同様
  // (angular-7759_4)。`ignoreNewGlobalPatterns` で `/^ng/` や 1 文字 / よくある loop/temp 変数名を除外すると一致する。
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
  const logA: ConsoleCall = { method: "log", args: ["a", 1] };
  const logB: ConsoleCall = { method: "log", args: ["b"] };

  describe("checkExternalObservation (in-source)", () => {
    it("console 空 & new_globals 空 → not_applicable", () => {
      expect(checkExternalObservation(cap(), cap()).verdict).toBe("not_applicable");
    });

    it("console 列が完全一致 & globals 一致 → equal", () => {
      const s = cap({ console_log: [logA], new_globals: ["g"] });
      const f = cap({ console_log: [logA], new_globals: ["g"] });
      expect(checkExternalObservation(s, f).verdict).toBe("equal");
    });

    it("console 列が異なる → not_equal (detail に console)", () => {
      const obs = checkExternalObservation(cap({ console_log: [logA] }), cap({ console_log: [logB] }));
      expect(obs.verdict).toBe("not_equal");
      expect(obs.detail).toContain("console");
    });

    it("new_globals 集合が違う → not_equal (detail に new_globals)", () => {
      const obs = checkExternalObservation(cap({ new_globals: ["a"] }), cap({ new_globals: ["b"] }));
      expect(obs.verdict).toBe("not_equal");
      expect(obs.detail).toContain("new_globals");
    });

    it("console の順序が違うと not_equal", () => {
      const s = cap({ console_log: [logA, logB] });
      const f = cap({ console_log: [logB, logA] });
      expect(checkExternalObservation(s, f).verdict).toBe("not_equal");
    });

    it("循環参照を含む console args → error", () => {
      const cyc: Record<string, unknown> = {};
      cyc.self = cyc;
      const s = cap({ console_log: [{ method: "log", args: [cyc] }] });
      const f = cap({ console_log: [{ method: "log", args: ["x"] }] });
      expect(checkExternalObservation(s, f).verdict).toBe("error");
    });

    it("ignoreNewGlobalPatterns で framework 内部 global (ng*) を除外 → equal (angular-7759_4 の偽 not_equal 解消)", () => {
      const s = cap({ new_globals: ["ngContext", "ngScope", "result"] });
      const f = cap({ new_globals: ["result"] });
      expect(checkExternalObservation(s, f).verdict).toBe("not_equal"); // 素だと ng* の差で not_equal
      expect(checkExternalObservation(s, f, { ignoreNewGlobalPatterns: [/^ng/] }).verdict).toBe("equal");
    });

    it("ignoreNewGlobalPatterns で全部消えて両側 console/global 空 → not_applicable", () => {
      const s = cap({ new_globals: ["ngFoo"] });
      const f = cap({ new_globals: ["ngBar"] });
      expect(checkExternalObservation(s, f, { ignoreNewGlobalPatterns: [/^ng/] }).verdict).toBe("not_applicable");
    });
  });
}
