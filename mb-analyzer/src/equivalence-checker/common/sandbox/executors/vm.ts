import vm from "node:vm";

import { createConsoleHook } from "../capture/console-hook";
import {
  captureException,
  collectArgSnapshots,
  collectNewGlobals,
  isTimeoutError,
  normalizeSetup,
  resolveIfPromise,
  snapshotSetupState,
  snapshotValue,
} from "../capture/snapshot";
import type { ConsoleCall, ExceptionCapture, ExecutionCapture } from "../capture/types";
import { SandboxSetupError } from "../errors";
import { nonDeterministicGlobals } from "../transforms/non-determinism";

export interface ExecuteOptions {
  setup: string;
  workload: string;
  timeout_ms: number;
}

/** workload 段階の評価結果 (戻り値 / 例外 / timeout を構造化)。 */
interface WorkloadEvaluation {
  returnValue: string;
  returnIsUndefined: boolean;
  exception: ExceptionCapture | null;
  timedOut: boolean;
}

/**
 * 素の `node:vm` context を作る (DOM 不要な純粋計算向け / pruning も使う)。
 * - 非決定 API は `nonDeterministicGlobals()` で遮断・固定化
 * - `process` / `require` / `eval` / `Function` を `undefined` にして host への逃げ道を遮断
 * `baselineKeys` は setup/workload 実行前に存在した key の集合 (new_globals 差分の基準点)。
 */
function createVmContext(): {
  context: vm.Context;
  consoleCalls: ConsoleCall[];
  baselineKeys: ReadonlySet<string>;
} {
  const consoleCalls: ConsoleCall[] = [];
  const sandbox: Record<string, unknown> = {
    console: createConsoleHook(consoleCalls),
    ...nonDeterministicGlobals(),
    process: undefined,
    require: undefined,
    eval: undefined,
    Function: undefined,
  };
  const context = vm.createContext(sandbox);
  const baselineKeys = new Set(Object.keys(sandbox));
  return { context, consoleCalls, baselineKeys };
}

/**
 * setup フェーズを context 上で実行する副作用呼び出し (戻り値なし)。
 * setup 内での throw は `SandboxSetupError` で型分離して outer realm に投げる
 * (= checker.ts の outer catch が `verdict_reason: "setup-failure"` に分類するため、ADR-0023 §D-β)。
 * cross-realm 制約: `new SandboxSetupError(e)` は **host コード (= outer realm)** で生成する必要がある
 * (この catch ブロック自体は host 側で走るので OK、`errors.ts` の docstring 参照)。
 */
function prepareSandbox(setupCode: string, context: vm.Context, timeoutMs: number): void {
  if (setupCode.length === 0) return;
  try {
    vm.runInContext(normalizeSetup(setupCode), context, {
      timeout: timeoutMs,
      displayErrors: false,
    });
  } catch (e) {
    throw new SandboxSetupError(e);
  }
}

/**
 * workload を context 上で評価して `{ returnValue, returnIsUndefined, exception, timedOut }` を返す。
 * 戻り値 / 例外 / timeout の 3 経路をひとつの structured value にまとめる。
 * 例外は `ExecutionCapture.exception` に詰めて返り、ここから outer に throw はしない (= verdict=error にせず
 * exception oracle で観測する経路)。
 */
async function evaluateWorkload(
  workloadCode: string,
  context: vm.Context,
  timeoutMs: number,
): Promise<WorkloadEvaluation> {
  let exception: ExceptionCapture | null = null;
  let timedOut = false;
  let returnValue = "undefined";
  let returnIsUndefined = true;
  try {
    const result: unknown = vm.runInContext(workloadCode, context, {
      timeout: timeoutMs,
      displayErrors: false,
    });
    const resolved = await resolveIfPromise(result);
    if (resolved !== undefined) {
      returnIsUndefined = false;
    }
    returnValue = snapshotValue(resolved);
  } catch (e) {
    if (isTimeoutError(e)) {
      timedOut = true;
    }
    exception = captureException(e);
  }
  return { returnValue, returnIsUndefined, exception, timedOut };
}

/**
 * (setup, workload) を素の vm context で実行し `ExecutionCapture` を返す。
 * 流れ: `createVmContext → prepareSandbox → snapshotSetupState → evaluateWorkload → collect*`。
 * setup と workload は同じ context で順に走る (setup の定義を workload から参照できる)。
 */
export async function executeSandboxed(options: ExecuteOptions): Promise<ExecutionCapture> {
  const { context, consoleCalls, baselineKeys } = createVmContext();

  prepareSandbox(options.setup, context, options.timeout_ms);

  const ctxRecord = context as unknown as Record<string, unknown>;
  const { setupKeys, trackedKeys, preSnapshots } = snapshotSetupState(ctxRecord, baselineKeys);

  const evaluation = await evaluateWorkload(options.workload, context, options.timeout_ms);

  return {
    return_value: evaluation.returnValue,
    return_is_undefined: evaluation.returnIsUndefined,
    arg_snapshots: collectArgSnapshots(ctxRecord, trackedKeys, preSnapshots),
    exception: evaluation.exception,
    console_log: [...consoleCalls],
    new_globals: collectNewGlobals(ctxRecord, baselineKeys, setupKeys),
    timed_out: evaluation.timedOut,
  };
}
