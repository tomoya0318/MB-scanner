/**
 * sandbox 層の error 型分離。executor の outer catch 側で
 * `instanceof SandboxSetupError` により setup phase の throw を識別し、
 * `verdict_reason: "setup-failure"` に分類する (ADR-0023 §D-β、checker.ts 参照)。
 *
 * **cross-realm 制約**: `vm.runInContext` 内で生成された Error は別 realm の
 * `Error.prototype` を継承するため、outer realm の `instanceof Error` が false に
 * なる (Node.js vm モジュール固有)。したがって `new SandboxSetupError(cause)` は
 * 必ず host コード (= outer realm) の catch ブロック内で生成する。vm 内で wrap
 * すると checker.ts の `instanceof SandboxSetupError` が false になり型分離が
 * 機能しない。`cause` 側の元 Error は依然 cross-realm のままなので、message
 * 取得は checker.ts の `extractErrorMessage` 経由で行う。
 */
export class SandboxSetupError extends Error {
  override readonly name = "SandboxSetupError";
  override readonly cause: unknown;

  constructor(cause: unknown) {
    super("setup phase failed");
    this.cause = cause;
  }
}
