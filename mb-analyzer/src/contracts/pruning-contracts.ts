/**
 * Python 側 (`mb_scanner.domain.entities.pruning`) との JSON シリアライゼーション
 * 契約。列挙値の文字列とフィールド名の snake_case を両言語で厳密に揃える。
 *
 * 変更時は paired-change で `mb_scanner/domain/entities/pruning.py` も同時に更新。
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

export interface PruningInput {
  id?: string;
  slow: string;
  fast: string;
  setup?: string;
  timeout_ms?: number;
  max_iterations?: number;
}

export interface PruningResult {
  id?: string;
  verdict: PruningVerdict;
  pattern_ast?: unknown;
  pattern_code?: string;
  placeholders?: Placeholder[];
  iterations?: number;
  node_count_before?: number;
  node_count_after?: number;
  effective_timeout_ms?: number;
  error_message?: string | null;
}
