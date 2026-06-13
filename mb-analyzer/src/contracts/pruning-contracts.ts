/**
 * Python 側 Pydantic モデルとの JSON シリアライゼーション契約。
 * 列挙値の文字列とフィールド名の snake_case を両言語で厳密に揃える。
 * 変更時は Python 側の対応モデルと paired-change で同時に更新する。
 */

export const PRUNING_VERDICT = {
  PRUNED: "pruned",
  INITIAL_MISMATCH: "initial_mismatch",
  ERROR: "error",
} as const;
export type PruningVerdict = (typeof PRUNING_VERDICT)[keyof typeof PRUNING_VERDICT];

export const PLACEHOLDER_KIND = {
  EXPRESSION: "expression",
  STATEMENT: "statement",
  IDENTIFIER: "identifier",
} as const;
export type PlaceholderKind = (typeof PLACEHOLDER_KIND)[keyof typeof PLACEHOLDER_KIND];

export interface Placeholder {
  id: string;
  kind: PlaceholderKind;
  original_snippet: string;
}

/**
 * pruning が内部で回す等価検証の実行環境。値は `equivalence-contracts.ts` の
 * `EXECUTION_ENVIRONMENT` / `preprocessing-contracts.ts` の `ExecutionEnvironmentHint` と一致させる。
 */
export type ExecutionEnvironmentHint = "vm" | "jsdom";

export interface PruningInput {
  id?: string;
  before: string;
  after: string;
  setup?: string;
  timeout_ms?: number;
  max_iterations?: number;
  /**
   * 後段の等価検証 (`equivalence-checker`) にそのまま渡す実行コンテキスト。
   * pruning アルゴリズム本体 (`pruning/common/`) はこれらを **解釈しない** — `pruning/selakovic/` が
   * `checkEquivalence` 呼び出しの closure に閉じ込めるだけ。値の集合・意味論は `equivalence-contracts.ts`
   * の `EquivalenceInput` と揃える (`environment` 省略時は等価検証側で `vm`、`module_base_dir` は jsdom で
   * 相対 `require('./x')` の解決基準、`mount_html` は jsdom で mount する HTML)。
   */
  environment?: ExecutionEnvironmentHint;
  module_base_dir?: string;
  mount_html?: string;
  /**
   * ADR-0023 D-β の placeholder substitution + 4 値契約フィールド。pruning 本体は解釈せず、
   * `pruning/selakovic/` が `checkEquivalence` 呼び出しの closure に閉じ込めて
   * `EquivalenceInput.workload` にそのまま流す。changed-fn 経路の candidate のみ非 null
   * (Python paired side が `None` を送ると JSON 経由で `null` になる、判定は `!= null` loose で)。
   */
  workload?: string;
}

export interface PruningResult {
  id?: string;
  verdict: PruningVerdict;
  pattern_ast?: unknown;
  pattern_code?: string;
  placeholders?: Placeholder[];
  iterations?: number;
  node_count_initial?: number;
  node_count_pruned?: number;
  effective_timeout_ms?: number;
  error_message?: string | null;
}
