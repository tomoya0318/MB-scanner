import {
  VERDICT,
  type EquivalenceCheckResult,
  type EquivalenceInput,
  type OracleObservation,
} from "../contracts/equivalence-contracts";
import { executeSandboxed } from "./sandbox/executor";
import { checkArgumentMutation } from "./oracles/argument-mutation";
import { checkException } from "./oracles/exception";
import { checkExternalObservation } from "./oracles/external-observation";
import { checkReturnValue } from "./oracles/return-value";
import { deriveOverallVerdict } from "./verdict";

const DEFAULT_TIMEOUT_MS = 5000;

/**
 * (setup, slow, fast) の 1 トリプルに対して意味論的等価性を判定する。
 * slow と fast は独立した sandbox で実行され、副作用の漏洩はない。
 */
export async function checkEquivalence(
  input: EquivalenceInput,
): Promise<EquivalenceCheckResult> {
  const setup = input.setup ?? "";
  const timeout_ms = input.timeout_ms ?? DEFAULT_TIMEOUT_MS;

  try {
    const [slow, fast] = await Promise.all([
      executeSandboxed({ setup, body: input.slow, timeout_ms }),
      executeSandboxed({ setup, body: input.fast, timeout_ms }),
    ]);

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
    // setup と body の実行例外は executor 内で捕捉して exception oracle に回すので、
    // ここに来るのは executor 自身の想定外バグや vm 初期化失敗など稀なケース。
    // `vm.runInContext` 側で throw された Error は VM context (別 realm) で生成される
    // ため outer realm の `instanceof Error` が false になる (Node.js の vm モジュール
    // 固有の挙動)。duck typing で `.message` / `.constructor.name` を拾うことで
    // cross-realm Error も本来のメッセージとして報告できる。
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
