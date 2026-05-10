/**
 * sandbox 実行 1 回分の観測結果型。oracle 層が触れるのはこの `ExecutionCapture` のみ。
 * `contracts/equivalence-contracts.ts` には現れない内部型 (Python 側は見ない)。
 */

export type ConsoleMethod = "log" | "error" | "warn" | "info" | "debug";

export interface ConsoleCall {
  method: ConsoleMethod;
  args: unknown[];
}

export interface ExceptionCapture {
  ctor: string;
  message: string;
}

/**
 * setup で定義された object/array 1 つ分のスナップショット。
 * pre/post は body 実行前後の時間軸 (slow/fast のサイド軸とは別概念)。
 * 概念モデル: ai-guide/code-map.md「観測軸: slow/fast と pre/post」
 */
export interface ArgumentSnapshot {
  key: string;
  pre: string;
  post: string;
}

/**
 * 記録 Proxy で観測した workload→SUT の 1 操作。`path` は包んだ root からのアクセスパス
 * (例 `"$scope.$eval"`)、`args`/`result`/`thrown` はシリアライズ済み文字列。
 */
export interface TraceEntry {
  path: string;
  op: "call" | "construct" | "get";
  args?: string[];
  result?: string;
  thrown?: string;
}

/**
 * - `return_value` / `arg_snapshots[i].pre|post` は失敗時 `UNSERIALIZABLE_MARKER`
 * - `exception` は正常終了なら null、throw された場合は ctor + message
 * - `timed_out` は vm.runInContext の timeout による打ち切り
 * - `dom_html` は jsdom 環境で `dom.serialize()` した正規化前 HTML (vm 環境では undefined)
 * - `interaction_trace` は記録 Proxy を注入した場合の操作列 (注入しない場合は undefined)
 */
export interface ExecutionCapture {
  return_value: string;
  return_is_undefined: boolean;
  arg_snapshots: ArgumentSnapshot[];
  exception: ExceptionCapture | null;
  console_log: ConsoleCall[];
  new_globals: string[];
  timed_out: boolean;
  dom_html?: string | null;
  interaction_trace?: TraceEntry[];
}
