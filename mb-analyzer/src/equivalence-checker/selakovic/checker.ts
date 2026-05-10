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
} from "../common/comparison";
import {
  applyIterationCap,
  executeInJsdom,
  executeSandboxed,
  type ExecutionCapture,
  type JsdomExecuteOptions,
} from "../common/sandbox";
import { routeOracles } from "./oracle-routing";
import {
  DOM_NORMALIZE_PROFILE,
  EXTERNAL_OBSERVATION_PROFILE,
  INTERACTION_TRACE_PROFILE,
  ITERATION_CAP,
} from "./profiles";

const DEFAULT_TIMEOUT_MS = 5000;

/**
 * Selakovic dataset 用の等価検証エントリ。`(setup, slow, fast)` を環境ごとに実行し、
 * `oracle-routing.ts` が選んだ oracle 群で観測して verdict に畳む。
 *
 * - `environment === "vm"` (デフォルト / pruning): 素 vm + 非決定性遮断。oracle は C1/C4/C5/C3 の 4 本 (Phase 2a と同一)。
 * - `environment === "jsdom"` (Selakovic の client/server candidate): jsdom window/document + require shim + server vm globals。
 *   body には iteration-cap (ADR-0017) をかける。oracle は上記 4 本 + C2 (DOM) + C6 (interaction-trace)。
 *   C2/C6 のチャネルが空なら oracle 自身が `not_applicable` を返す。`mount_html` も plumb する。
 *
 * 記録 Proxy (C6 の取得側) の executor への注入はまだ繋いでいない (= runnable が recorder-aware である必要があり
 * preprocessing 側の設計判断待ち。`wrap-targets.ts` 参照)。よって現状 C6 は常に `not_applicable`。
 */
export async function checkEquivalence(input: EquivalenceInput): Promise<EquivalenceCheckResult> {
  const setup = input.setup ?? "";
  const timeout_ms = input.timeout_ms ?? DEFAULT_TIMEOUT_MS;
  const environment: ExecutionEnvironment = input.environment ?? EXECUTION_ENVIRONMENT.VM;
  const isJsdom = environment === EXECUTION_ENVIRONMENT.JSDOM;

  const slowBody = isJsdom ? applyIterationCap(input.slow, ITERATION_CAP) : input.slow;
  const fastBody = isJsdom ? applyIterationCap(input.fast, ITERATION_CAP) : input.fast;

  const run = (body: string): Promise<ExecutionCapture> => {
    if (isJsdom) {
      const jsdomOpts: JsdomExecuteOptions = { setup, body, timeout_ms };
      if (input.module_base_dir !== undefined) jsdomOpts.module_base_dir = input.module_base_dir;
      if (input.mount_html !== undefined) jsdomOpts.mount_html = input.mount_html;
      return executeInJsdom(jsdomOpts);
    }
    return executeSandboxed({ setup, body, timeout_ms });
  };

  try {
    const [slow, fast] = await Promise.all([run(slowBody), run(fastBody)]);
    const observations: OracleObservation[] = routeOracles(isJsdom ? "jsdom" : "vm").map((o) =>
      runOracle(o, slow, fast, isJsdom),
    );
    return {
      verdict: deriveOverallVerdict(observations),
      observations,
      effective_timeout_ms: timeout_ms,
    };
  } catch (e) {
    // setup 自体の実行エラーや予期しない executor 例外は全体 error に畳み込む。
    // `vm.runInContext` で throw された Error は VM context (別 realm) で生成されるため
    // outer realm の `instanceof Error` が false になる (Node.js の vm モジュール固有の挙動)。
    // duck typing で `.message` / `.constructor.name` を拾うことで cross-realm Error も
    // 本来のメッセージとして報告できる。
    return {
      verdict: VERDICT.ERROR,
      observations: [],
      error_message: extractErrorMessage(e),
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
      return checkException(slow, fast);
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
