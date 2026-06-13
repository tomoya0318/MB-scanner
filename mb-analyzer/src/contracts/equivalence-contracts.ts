/**
 * Python 側 Pydantic モデルとの JSON シリアライゼーション契約。
 * 列挙値の文字列とフィールド名の snake_case を両言語で厳密に揃える。
 * 変更時は Python 側の対応モデルと paired-change で同時に更新する。
 */

export const VERDICT = {
  EQUAL: "equal",
  NOT_EQUAL: "not_equal",
  /**
   * 差は観測されなかったが「同じ値を返した / 同じ引数変化をした / 同じ呼び出し列だった」という
   * positive な等価エビデンスが無い (= 中身を exercise できていない可能性が高い) ケース。
   * 「両側が同じ例外で落ちた」「DOM が初期から変化していない」「scaffolding global しか観測できていない」等。
   * ADR-0018 参照。
   */
  INCONCLUSIVE: "inconclusive",
  ERROR: "error",
} as const;
export type Verdict = (typeof VERDICT)[keyof typeof VERDICT];

export const ORACLE_VERDICT = {
  EQUAL: "equal",
  NOT_EQUAL: "not_equal",
  NOT_APPLICABLE: "not_applicable",
  ERROR: "error",
} as const;
export type OracleVerdict = (typeof ORACLE_VERDICT)[keyof typeof ORACLE_VERDICT];

export const ORACLE = {
  RETURN_VALUE: "return_value",
  ARGUMENT_MUTATION: "argument_mutation",
  EXCEPTION: "exception",
  EXTERNAL_OBSERVATION: "external_observation",
  /** C2: 正規化 DOM-HTML 文字列比較 (jsdom 環境のみ)。 */
  DOM_MUTATION: "dom_mutation",
  /** C6: 記録 Proxy で観測した workload→SUT 呼び出し列の比較。 */
  INTERACTION_TRACE: "interaction_trace",
} as const;
export type Oracle = (typeof ORACLE)[keyof typeof ORACLE];

export const ALL_ORACLES: readonly Oracle[] = [
  ORACLE.RETURN_VALUE,
  ORACLE.ARGUMENT_MUTATION,
  ORACLE.EXCEPTION,
  ORACLE.EXTERNAL_OBSERVATION,
  ORACLE.DOM_MUTATION,
  ORACLE.INTERACTION_TRACE,
] as const;

/**
 * 実行環境 (ADR-0012)。
 * - `vm`: `node:vm` の素 context (非決定 API stub のみ)。純粋計算向け。
 * - `jsdom`: jsdom の window/document を持つ context + 相対 `require` 解決。
 *   browser ライブラリ (AngularJS / jQuery 等) / server `test_case` 向け。
 */
export const EXECUTION_ENVIRONMENT = {
  VM: "vm",
  JSDOM: "jsdom",
} as const;
export type ExecutionEnvironment = (typeof EXECUTION_ENVIRONMENT)[keyof typeof EXECUTION_ENVIRONMENT];

export interface EquivalenceInput {
  id?: string;
  setup?: string;
  before: string;
  after: string;
  timeout_ms?: number;
  /** 実行環境。省略時は `vm`。 */
  environment?: ExecutionEnvironment;
  /** `jsdom` 環境で相対 `require('./x')` を解決する基準ディレクトリ (= 通常 issue ディレクトリの絶対パス)。 */
  module_base_dir?: string;
  /** `jsdom` 環境で mount する HTML (`<body>` の中身)。react-808 系の `#demo*` 要素不在の解消用。 */
  mount_html?: string;
  /**
   * placeholder substitution + 4 値契約 (ADR-0023 D-β) の workload。
   *
   * 定義されているとき (= changed-fn 経路) は checker が:
   *   1. `setup` に含まれる `$BODY$` プレースホルダを `before` / `after` の body 文で差し替え
   *   2. 観測配列 `__OBS__` を `setup` 最先頭に `let __OBS__ = [];` で宣言
   *   3. 結果を executor の `setup` 引数として、本フィールドを executor の `workload` 引数として渡す
   *
   * `null` / `undefined` のとき (= client embedded / fallback / server 等の経路) は
   * `before` / `after` がそのまま executor の workload に流れる。
   * Python `EquivalenceInput.workload=None` は JSON 経由で `null` として届くので、checker 側の
   * 経路判定は `input.workload != null` (loose) で書く。
   */
  workload?: string;
}

export interface OracleObservation {
  oracle: Oracle;
  verdict: OracleVerdict;
  before_value?: string | null;
  after_value?: string | null;
  detail?: string | null;
}

export interface EquivalenceCheckResult {
  id?: string;
  verdict: Verdict;
  observations: OracleObservation[];
  /**
   * `verdict === "inconclusive"` のときの理由分類 (`"no-observable-channel"` / `"both-sides-threw"` /
   * `"no-positive-evidence"`)、または `verdict === "error"` 時の crash 分類:
   *  - `"setup-failure"`: setup phase (`vm.runInContext(setup, ...)`) で throw。`SandboxSetupError` 由来。
   *  - `"executor-error"`: workload phase 以降の executor crash / serialize 失敗 (= setup 以外の error)。
   *
   * `equal` / `not_equal` では `null`。ADR-0018 / ADR-0023 §D-β 参照。
   */
  verdict_reason?: string | null;
  error_message?: string | null;
  effective_timeout_ms?: number;
}
