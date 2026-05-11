import { ORACLE, ORACLE_VERDICT, type OracleObservation } from "../../../../contracts/equivalence-contracts";
import type { ExecutionCapture, TraceEntry } from "../../sandbox/capture/types";

/**
 * C6 (interaction-trace): 記録 Proxy で取った workload→SUT の呼び出し列 (`capture.interaction_trace`) を
 * slow/fast で比較する。どの path prefix を無視するか等は dataset 知識なので `profile` で adapter から渡す
 * (記録 Proxy 自体は汎用 — `common/sandbox/capture/recording-proxy.ts`)。
 *
 * - 両側とも trace 空 (= 記録 Proxy を注入していない or 何も呼ばなかった) → `not_applicable`
 * - 列が一致 → `equal` / 不一致 → `not_equal` (detail に最初の差分エントリ)
 */
export interface InteractionTraceProfile {
  /** trace entry の `path` がこれらの prefix で始まるものを比較対象から外す (例: framework boot-phase の自己呼び出し)。 */
  ignorePathPrefixes?: readonly string[];
  /** `op === "get"` のエントリ (値 read) を比較対象から外すか。call/construct だけ見たいとき。 */
  ignoreGets?: boolean;
}

const EMPTY_PROFILE: InteractionTraceProfile = {};

export function checkInteractionTrace(
  slow: ExecutionCapture,
  fast: ExecutionCapture,
  profile: InteractionTraceProfile = EMPTY_PROFILE,
): OracleObservation {
  const oracle = ORACLE.INTERACTION_TRACE;
  const slowTrace = filterTrace(slow.interaction_trace, profile);
  const fastTrace = filterTrace(fast.interaction_trace, profile);

  if (slowTrace.length === 0 && fastTrace.length === 0) {
    return { oracle, verdict: ORACLE_VERDICT.NOT_APPLICABLE };
  }

  const slowSig = serializeTrace(slowTrace);
  const fastSig = serializeTrace(fastTrace);
  if (slowSig === fastSig) {
    return { oracle, verdict: ORACLE_VERDICT.EQUAL, slow_value: slowSig, fast_value: fastSig };
  }
  const idx = firstDiffIndex(slowTrace, fastTrace);
  return {
    oracle,
    verdict: ORACLE_VERDICT.NOT_EQUAL,
    slow_value: slowSig,
    fast_value: fastSig,
    detail: `interaction trace differs at entry ${idx} — slow: ${describeEntry(slowTrace[idx])} / fast: ${describeEntry(fastTrace[idx])}`,
  };
}

function filterTrace(trace: TraceEntry[] | undefined, profile: InteractionTraceProfile): TraceEntry[] {
  if (trace === undefined) return [];
  const prefixes = profile.ignorePathPrefixes ?? [];
  return trace.filter((e) => {
    if (profile.ignoreGets === true && e.op === "get") return false;
    if (prefixes.some((p) => e.path.startsWith(p))) return false;
    return true;
  });
}

function serializeTrace(trace: TraceEntry[]): string {
  return JSON.stringify(
    trace.map((e) => ({ p: e.path, o: e.op, a: e.args ?? null, r: e.result ?? null, t: e.thrown ?? null })),
  );
}

function firstDiffIndex(a: TraceEntry[], b: TraceEntry[]): number {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) if (describeEntry(a[i]) !== describeEntry(b[i])) return i;
  return n;
}

function describeEntry(e: TraceEntry | undefined): string {
  if (e === undefined) return "<missing>";
  const args = e.args !== undefined ? `(${e.args.join(", ")})` : "";
  const outcome = e.thrown !== undefined ? ` throws ${e.thrown}` : e.result !== undefined ? ` → ${e.result}` : "";
  return `${e.op} ${e.path}${args}${outcome}`;
}

// 判断: ai-guide/adr/0007-in-source-testing-internal-helpers.md
if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;
  // 観点: 記録 Proxy で取った workload→SUT の呼び出し列を slow/fast で要素ごとに比較。両側 trace 空/undefined → N/A、
  // 列一致 → equal、不一致 → not_equal (detail に最初の差分エントリ)。`ignorePathPrefixes` で boot-phase の自己呼び出しを、
  // `ignoreGets` で値 read のノイズを除外できる (どちらも dataset 知識なので profile で adapter から渡す)。
  // 統合観点: `$scope.$eval("null.a", {null:{a:42}})` が slow=42 / fast=undefined を返すような workload-observable な
  // 非等価を C6 が検出する (angular-10351 — checker のバグではなく設計どおり)。
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

  describe("checkInteractionTrace (in-source)", () => {
    it("両側 trace 空 / undefined → not_applicable", () => {
      expect(checkInteractionTrace(cap(), cap()).verdict).toBe("not_applicable");
      expect(
        checkInteractionTrace(cap({ interaction_trace: [] }), cap({ interaction_trace: [] })).verdict,
      ).toBe("not_applicable");
    });

    it("同じ呼び出し列 → equal", () => {
      const trace: TraceEntry[] = [{ path: "obj.f", op: "call", args: ["1"], result: "2" }];
      expect(
        checkInteractionTrace(cap({ interaction_trace: trace }), cap({ interaction_trace: [...trace] })).verdict,
      ).toBe("equal");
    });

    it("結果が違えば not_equal (detail に差分エントリ)", () => {
      const slow = cap({ interaction_trace: [{ path: "$scope.$eval", op: "call", args: ['"null.a"'], result: "42" }] });
      const fast = cap({ interaction_trace: [{ path: "$scope.$eval", op: "call", args: ['"null.a"'], result: "undefined" }] });
      const obs = checkInteractionTrace(slow, fast);
      expect(obs.verdict).toBe("not_equal");
      expect(obs.detail).toContain("entry 0");
    });

    it("ignorePathPrefixes で boot-phase の自己呼び出しを除外 → equal", () => {
      const slow = cap({
        interaction_trace: [
          { path: "angular.module", op: "call", args: [] },
          { path: "$scope.f", op: "call", args: [], result: "1" },
        ],
      });
      const fast = cap({ interaction_trace: [{ path: "$scope.f", op: "call", args: [], result: "1" }] });
      expect(checkInteractionTrace(slow, fast, { ignorePathPrefixes: ["angular."] }).verdict).toBe("equal");
      expect(checkInteractionTrace(slow, fast).verdict).toBe("not_equal");
    });

    it("ignoreGets で値 read のノイズを無視 → equal", () => {
      const slow = cap({
        interaction_trace: [
          { path: "x.length", op: "get", result: "3" },
          { path: "x.f", op: "call", args: [], result: "1" },
        ],
      });
      const fast = cap({ interaction_trace: [{ path: "x.f", op: "call", args: [], result: "1" }] });
      expect(checkInteractionTrace(slow, fast, { ignoreGets: true }).verdict).toBe("equal");
    });
  });
}
