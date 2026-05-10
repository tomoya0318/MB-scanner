import {
  EXECUTION_ENVIRONMENT,
  VERDICT,
  type EquivalenceCheckResult,
  type EquivalenceInput,
  type ExecutionEnvironment,
  type OracleObservation,
} from "../../contracts/equivalence-contracts";
import {
  checkArgumentMutation,
  checkException,
  checkExternalObservation,
  checkReturnValue,
  deriveOverallVerdict,
} from "../common/comparison";
import {
  executeInJsdom,
  executeSandboxed,
  type ExecutionCapture,
  type JsdomExecuteOptions,
} from "../common/sandbox";

const DEFAULT_TIMEOUT_MS = 5000;

/**
 * (setup, slow, fast) の 1 トリプルに対して意味論的等価性を判定する。
 * slow と fast は独立した sandbox で実行され、副作用の漏洩はない。
 *
 * `environment` (ADR-0012): `vm` (デフォルト) = 素の `node:vm` + 非決定 API stub。
 * `jsdom` = jsdom window/document + 相対 `require` 解決 (browser ライブラリ / server `test_case` 向け)。
 */
export async function checkEquivalence(
  input: EquivalenceInput,
): Promise<EquivalenceCheckResult> {
  const setup = input.setup ?? "";
  const timeout_ms = input.timeout_ms ?? DEFAULT_TIMEOUT_MS;
  const environment: ExecutionEnvironment = input.environment ?? EXECUTION_ENVIRONMENT.VM;
  const run = (body: string): Promise<ExecutionCapture> => {
    if (environment === EXECUTION_ENVIRONMENT.JSDOM) {
      const jsdomOpts: JsdomExecuteOptions = { setup, body, timeout_ms };
      if (input.module_base_dir !== undefined) jsdomOpts.module_base_dir = input.module_base_dir;
      if (input.mount_html !== undefined) jsdomOpts.mount_html = input.mount_html;
      return executeInJsdom(jsdomOpts);
    }
    return executeSandboxed({ setup, body, timeout_ms });
  };

  try {
    const [slow, fast] = await Promise.all([run(input.slow), run(input.fast)]);

    const observations: OracleObservation[] = [
      checkReturnValue(slow, fast),
      checkArgumentMutation(slow, fast),
      checkException(slow, fast),
      checkExternalObservation(slow, fast),
    ];

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
