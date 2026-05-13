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
import { nonDeterministicGlobals } from "../transforms/non-determinism";

export interface ExecuteOptions {
  setup: string;
  body: string;
  timeout_ms: number;
}

/**
 * 素の `node:vm` context を作る (DOM 不要な純粋計算向け / pruning も使う)。
 * - 非決定 API は `nonDeterministicGlobals()` で遮断・固定化
 * - `process` / `require` / `eval` / `Function` を `undefined` にして host への逃げ道を遮断
 * `baselineKeys` は setup/body 実行前に存在した key の集合 (new_globals 差分の基準点)。
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
 * (setup, body) を素の vm context で実行し `ExecutionCapture` を返す。
 * setup と body は同じ context で順に走る (setup の定義を body から参照できる)。
 */
export async function executeSandboxed(options: ExecuteOptions): Promise<ExecutionCapture> {
  const { context, consoleCalls, baselineKeys } = createVmContext();

  if (options.setup.length > 0) {
    vm.runInContext(normalizeSetup(options.setup), context, {
      timeout: options.timeout_ms,
      displayErrors: false,
    });
  }

  const ctxRecord = context as unknown as Record<string, unknown>;
  const { setupKeys, trackedKeys, preSnapshots } = snapshotSetupState(ctxRecord, baselineKeys);

  let exception: ExceptionCapture | null = null;
  let timedOut = false;
  let returnValue = "undefined";
  let returnIsUndefined = true;

  try {
    const result: unknown = vm.runInContext(options.body, context, {
      timeout: options.timeout_ms,
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

  return {
    return_value: returnValue,
    return_is_undefined: returnIsUndefined,
    arg_snapshots: collectArgSnapshots(ctxRecord, trackedKeys, preSnapshots),
    exception,
    console_log: [...consoleCalls],
    new_globals: collectNewGlobals(ctxRecord, baselineKeys, setupKeys),
    timed_out: timedOut,
  };
}
