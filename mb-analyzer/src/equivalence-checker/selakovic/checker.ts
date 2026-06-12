import { declareObservationGlobal, substituteBody } from "../../codegen/placeholder";
import {
  EXECUTION_ENVIRONMENT,
  ORACLE,
  VERDICT,
  type EquivalenceCheckResult,
  type EquivalenceInput,
  type ExecutionEnvironment,
  type Oracle,
  type OracleObservation,
} from "../../contracts/equivalence-contracts";
import {
  checkArgumentMutation,
  checkDomMutation,
  checkException,
  checkExternalObservation,
  checkInteractionTrace,
  checkReturnValue,
  deriveOverallVerdict,
  deriveVerdictReason,
  VERDICT_REASON,
} from "../common/comparison";
import {
  applyIterationCap,
  executeInJsdom,
  executeSandboxed,
  SandboxSetupError,
  type ExecutionCapture,
  type JsdomExecuteOptions,
} from "../common/sandbox";
import { routeOracles } from "./oracle-routing";
import {
  DOM_NORMALIZE_PROFILE,
  EXCEPTION_PROFILE,
  EXTERNAL_OBSERVATION_PROFILE,
  INTERACTION_TRACE_PROFILE,
  ITERATION_CAP,
} from "./profiles";

const DEFAULT_TIMEOUT_MS = 5000;

/**
 * Selakovic dataset 用の等価検証エントリ。`(setup, slow, fast)` を環境ごとに実行し、
 * `oracle-routing.ts` が選んだ oracle 群で観測して verdict に畳む。
 *
 * - `environment === "vm"` (デフォルト / pruning): 素 vm + 非決定性遮断。oracle は C1/C4/C5/C3 の 4 本。
 * - `environment === "jsdom"` (Selakovic の client/server candidate): jsdom window/document + require shim + server vm globals。
 *   workload には iteration-cap をかける。記録 Proxy を `globalThis.__recorder` として注入する
 *   (runnable が `preprocessing/selakovic/assemble/*` 由来で `globalThis.__recorder` を見て workload が叩く境界オブジェクトを
 *   wrap してから SUT を呼ぶ → `capture.interaction_trace` が埋まる)。oracle は上記 4 本 + C2 (DOM) + C6 (interaction-trace)。
 *   C2/C6 のチャネルが空なら oracle 自身が `not_applicable` を返す。`mount_html` も plumb する。
 *
 * 入力 2 系統 (`input.workload` の有無で分岐):
 * - **placeholder substitution model** (`input.workload != null`、ADR-0023 D-β): setup に `$BODY$` 1 個 +
 *   slow/fast は body 断片 (関数本体に差し込まれる前提) + workload が呼び出し列。checker 側で:
 *     1. `substituteBody(setup, slow|fast)` で `$BODY$` を body 断片で差し替え
 *     2. `declareObservationGlobal()` で setup 最先頭に `let __OBS__ = [];` を prepend
 *     3. 結果を executor の setup 引数、`input.workload` を executor の workload 引数に渡す (iteration-cap は workload 側)
 * - **direct executable** (`input.workload == null`、client embedded / fallback / server 等の経路): slow/fast が
 *   top-level program 形式でそのまま executor の workload 引数に流れる (executor は無改修、iteration-cap は slow/fast 側)
 *
 * 判断: ai-guide/adr/0012-equivalence-checker-execution-environment.md / 0015-equivalence-checker-layering-and-dom-oracle.md / 0023-preprocess-placeholder-substitution.md
 */
export async function checkEquivalence(input: EquivalenceInput): Promise<EquivalenceCheckResult> {
  const timeout_ms = input.timeout_ms ?? DEFAULT_TIMEOUT_MS;
  const environment: ExecutionEnvironment = input.environment ?? EXECUTION_ENVIRONMENT.VM;
  const isJsdom = environment === EXECUTION_ENVIRONMENT.JSDOM;
  const hasPlaceholderWorkload = input.workload != null;

  const cap = (code: string): string => (isJsdom ? applyIterationCap(code, ITERATION_CAP) : code);

  // 1 side (slow / fast の body) を executor 入力 {setup, workload} に組み立てる。
  // placeholder model のときは body を $BODY$ に差し込んで setup を再構成し、workload を別に持つ。
  // direct executable のときは body 自体が top-level program なので executor の workload に流す。
  const buildExecutorInput = (body: string): { setup: string; workload: string } => {
    if (hasPlaceholderWorkload) {
      const substituted = substituteBody(input.setup ?? "", body);
      return {
        setup: declareObservationGlobal(substituted),
        workload: cap(input.workload!),
      };
    }
    return {
      setup: input.setup ?? "",
      workload: cap(body),
    };
  };

  const run = (body: string): Promise<ExecutionCapture> => {
    const { setup, workload } = buildExecutorInput(body);
    if (isJsdom) {
      const jsdomOpts: JsdomExecuteOptions = { setup, workload, timeout_ms, recordInteractions: true };
      if (input.module_base_dir !== undefined) jsdomOpts.module_base_dir = input.module_base_dir;
      if (input.mount_html !== undefined) jsdomOpts.mount_html = input.mount_html;
      return executeInJsdom(jsdomOpts);
    }
    return executeSandboxed({ setup, workload, timeout_ms });
  };

  try {
    const [slow, fast] = await Promise.all([run(input.slow), run(input.fast)]);
    const observations: OracleObservation[] = routeOracles(isJsdom ? "jsdom" : "vm").map((o) =>
      runOracle(o, slow, fast, isJsdom),
    );
    const verdict = deriveOverallVerdict(observations);
    return {
      verdict,
      observations,
      verdict_reason: deriveVerdictReason(observations, verdict),
      effective_timeout_ms: timeout_ms,
    };
  } catch (e) {
    // executor からの throw は 2 種類に分けて verdict_reason を付ける (ADR-0023 §D-β):
    // - setup 段階 (= `prepareSandbox` 内 `vm.runInContext(setup, ...)` の throw) は executor 側で
    //   `SandboxSetupError` で wrap されて outer realm に届く → `setup-failure`
    // - workload 段階以降の crash / serialize 失敗 / 想定外 throw は `executor-error`
    // cross-realm: `vm.runInContext` で throw された Error は VM context (別 realm) で生成されるため
    // outer realm の `instanceof Error` が false になる (Node.js の vm モジュール固有)。
    // `SandboxSetupError` は host コードで `new` するので outer realm の instanceof は通る、
    // `cause` 側の元 Error は依然 cross-realm なので message 取得は `extractErrorMessage` 経由で行う。
    const isSetupFailure = e instanceof SandboxSetupError;
    const causeForMessage = isSetupFailure ? e.cause : e;
    return {
      verdict: VERDICT.ERROR,
      observations: [],
      verdict_reason: isSetupFailure ? VERDICT_REASON.SETUP_FAILURE : VERDICT_REASON.EXECUTOR_ERROR,
      error_message: extractErrorMessage(causeForMessage),
      effective_timeout_ms: timeout_ms,
    };
  }
}

function runOracle(
  oracle: Oracle,
  slow: ExecutionCapture,
  fast: ExecutionCapture,
  isJsdom: boolean,
): OracleObservation {
  switch (oracle) {
    case ORACLE.RETURN_VALUE:
      return checkReturnValue(slow, fast);
    case ORACLE.ARGUMENT_MUTATION:
      return checkArgumentMutation(slow, fast);
    case ORACLE.EXCEPTION:
      return checkException(slow, fast, EXCEPTION_PROFILE);
    case ORACLE.EXTERNAL_OBSERVATION:
      return checkExternalObservation(slow, fast, isJsdom ? EXTERNAL_OBSERVATION_PROFILE : undefined);
    case ORACLE.DOM_MUTATION:
      return checkDomMutation(slow, fast, DOM_NORMALIZE_PROFILE);
    case ORACLE.INTERACTION_TRACE:
      return checkInteractionTrace(slow, fast, INTERACTION_TRACE_PROFILE);
  }
}

function extractErrorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "object" && e !== null) {
    const obj = e as { message?: unknown; constructor?: { name?: unknown } };
    const ctorName = typeof obj.constructor?.name === "string" ? obj.constructor.name : null;
    if (typeof obj.message === "string") {
      return ctorName !== null && ctorName !== "Object" ? `${ctorName}: ${obj.message}` : obj.message;
    }
  }
  if (typeof e === "string") return e;
  return `unexpected throw: ${String(e)}`;
}

// 判断: ai-guide/adr/0007-in-source-testing-internal-helpers.md
if (import.meta.vitest) {
  const { describe, it, expect, vi } = import.meta.vitest;
  // 観点: placeholder substitution model のとき executor に届く setup が
  //  - `let __OBS__ = []` で始まり
  //  - `$BODY$` プレースホルダが slow/fast の body で差し替え済み
  //  であることを確認する。executor 自体は mock してチェック。

  describe("checkEquivalence (in-source) — placeholder substitution model", () => {
    it("workload != null のとき executor が受け取る setup が `let __OBS__ = []` 始まり + $BODY$ 差替済", async () => {
      const sandbox = await import("../common/sandbox");
      const calls: Array<{ setup: string; workload: string }> = [];
      const spy = vi
        .spyOn(sandbox, "executeSandboxed")
        .mockImplementation((opts: { setup: string; workload: string; timeout_ms: number }) => {
          calls.push({ setup: opts.setup, workload: opts.workload });
          return Promise.resolve({
            return_value: null,
            argument_mutations: [],
            exception: null,
            external_observations: { effects: [] },
            dom_mutations: null,
            interaction_trace: null,
            timed_out: false,
          } as unknown as ExecutionCapture);
        });
      try {
        await checkEquivalence({
          // ADR-0023 D-δ: 観測ハーネスは setup 側に inline 化、slow/fast は裸 body 断片
          setup: "var f = function (x) { let __OBS_R__ = (function () { $BODY$ }).call(this); __OBS__.push(JSON.stringify(__OBS_R__)); return __OBS_R__; };",
          slow: "return x + 1;",
          fast: "return x + 2;",
          workload: "(function () { __OBS__ = []; f(7); f(8); return JSON.stringify(__OBS__); })()",
          timeout_ms: 1000,
        });
        expect(calls.length).toBe(2);
        for (const c of calls) {
          // setup が `let __OBS__ = []` で始まる (declareObservationGlobal の prepend)
          expect(c.setup).toMatch(/^let __OBS__ = \[\];/);
          // $BODY$ は差替済み (= もう含まれない)
          expect(c.setup).not.toContain("$BODY$");
          // 元 setup の `var f = function (x) {` は残る
          expect(c.setup).toContain("var f = function (x)");
          // workload は input.workload がそのまま (vm 環境では iteration-cap 無し)
          expect(c.workload).toContain("__OBS__ = [];");
          expect(c.workload).toContain("JSON.stringify(__OBS__)");
        }
        // slow / fast の body 断片が差し込まれて、それぞれの side に正しく入っている
        expect(calls[0]!.setup).toContain("return x + 1;");
        expect(calls[1]!.setup).toContain("return x + 2;");
      } finally {
        spy.mockRestore();
      }
    });

    it("workload == null は setup が原文のまま + slow/fast が executor の workload に流れる", async () => {
      const sandbox = await import("../common/sandbox");
      const calls: Array<{ setup: string; workload: string }> = [];
      const spy = vi
        .spyOn(sandbox, "executeSandboxed")
        .mockImplementation((opts: { setup: string; workload: string; timeout_ms: number }) => {
          calls.push({ setup: opts.setup, workload: opts.workload });
          return Promise.resolve({
            return_value: null,
            argument_mutations: [],
            exception: null,
            external_observations: { effects: [] },
            dom_mutations: null,
            interaction_trace: null,
            timed_out: false,
          } as unknown as ExecutionCapture);
        });
      try {
        await checkEquivalence({
          setup: "var lib = { f: function (x) { return x; } };",
          slow: "lib.f(1); lib.f(2);",
          fast: "lib.f(3); lib.f(4);",
          // workload 省略 = slow/fast 素通し経路
          timeout_ms: 1000,
        });
        expect(calls.length).toBe(2);
        for (const c of calls) {
          // setup は原文そのまま (declareObservationGlobal は通っていない)
          expect(c.setup).toBe("var lib = { f: function (x) { return x; } };");
        }
        // slow / fast がそのまま executor の workload に
        expect(calls[0]!.workload).toBe("lib.f(1); lib.f(2);");
        expect(calls[1]!.workload).toBe("lib.f(3); lib.f(4);");
      } finally {
        spy.mockRestore();
      }
    });
  });
}
