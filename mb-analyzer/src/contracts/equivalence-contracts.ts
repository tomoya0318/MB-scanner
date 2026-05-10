/**
 * Python 側 (`mb_scanner.domain.entities.equivalence`) との JSON シリアライゼーション
 * 契約。列挙値の文字列とフィールド名の snake_case を両言語で厳密に揃える。
 *
 * 変更時は paired-change で `mb_scanner/domain/entities/equivalence.py` も同時に更新。
 */

export const VERDICT = {
  EQUAL: "equal",
  NOT_EQUAL: "not_equal",
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
 *   browser ライブラリ (AngularJS / jQuery 等) / server `test_case` 向け (Phase 2a の最小版 —
 *   Playwright fallback・channel ルーティングは Phase 2b)。
 */
export const EXECUTION_ENVIRONMENT = {
  VM: "vm",
  JSDOM: "jsdom",
} as const;
export type ExecutionEnvironment = (typeof EXECUTION_ENVIRONMENT)[keyof typeof EXECUTION_ENVIRONMENT];

export interface EquivalenceInput {
  id?: string;
  setup?: string;
  slow: string;
  fast: string;
  timeout_ms?: number;
  /** 実行環境。省略時は `vm`。 */
  environment?: ExecutionEnvironment;
  /** `jsdom` 環境で相対 `require('./x')` を解決する基準ディレクトリ (= 通常 issue ディレクトリの絶対パス)。 */
  module_base_dir?: string;
  /** `jsdom` 環境で mount する HTML (`<body>` の中身)。react-808 系の `#demo*` 要素不在の解消用。 */
  mount_html?: string;
  /**
   * 後段 oracle 選択 / 記録 Proxy で包む対象を決めるための preprocess 由来 hint。
   * 値の集合は `preprocessing-contracts.ts` の `ASPECT` / `CANDIDATE_KIND` / `PreprocessingResult.enclosure_type`
   * と揃える (両 contract を独立した leaf に保つため型は loose な `string`)。
   */
  aspect?: string;
  candidate_kind?: string;
  enclosure_type?: string;
}

export interface OracleObservation {
  oracle: Oracle;
  verdict: OracleVerdict;
  slow_value?: string | null;
  fast_value?: string | null;
  detail?: string | null;
}

export interface EquivalenceCheckResult {
  id?: string;
  verdict: Verdict;
  observations: OracleObservation[];
  error_message?: string | null;
  effective_timeout_ms?: number;
}
