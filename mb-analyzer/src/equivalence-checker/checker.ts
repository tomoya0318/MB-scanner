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
    // setup 自体の実行エラーや予期しない executor 例外は全体 error に畳み込む
    const message = e instanceof Error ? e.message : "unexpected non-Error thrown";
    return {
      verdict: VERDICT.ERROR,
      observations: [],
      error_message: message,
      effective_timeout_ms: timeout_ms,
    };
  }
}
