/**
 * Python 側 (`mb_scanner.domain.entities.preprocessing`) との JSON シリアライゼーション契約。
 * 列挙値の文字列とフィールド名 (snake_case) を両言語で厳密に揃える。
 *
 * 変更時は paired-change で `mb_scanner/domain/entities/preprocessing.py` も同時に更新。
 *
 * 構造の方針 (ADR-0024):
 *  - **base contract**: 全 dataset で意味を持つフィールドのみ
 *    (id, issue_excluded, issue_excluded_detail, candidate_count, candidates[].setup/slow/fast,
 *     candidates[].before/after_node_count, candidates[].enclosure_node_type, candidates[].candidate_excluded)
 *  - **adapter extension**: dataset 固有情報は `issue_meta` / `candidate_meta` (discriminated union)
 *  - **issue 階層化**: jsonl 1 行 = 1 issue、`candidates: list[PreprocessingCandidate]`
 *  - 旧 `candidate_kind` / `enclosure_type` (戦略ラベル含む) / `aspect` / `layout` (issue level) /
 *    `environment` は廃止 or adapter_meta へ移動
 *  - `excluded` フィールドは旧フラット契約名。新契約では `issue_excluded` / `candidate_excluded` の
 *    2 レベル (issue level と candidate level) に分離
 */

// ============================================================================
// Base contract (dataset 非依存)
// ============================================================================

/**
 * 抽出が成立しなかった場合の汎用理由コード。任意 dataset で意味を持つ集合。
 *
 * - `parse-error`: before / after の AST parse に失敗
 * - `no-changed-nodes`: AST diff が空 (整形差分のみで意味論変更なし)
 * - `multi-file-change`: 変更が複数ファイルにまたがる
 * - `missing-files`: 期待するファイル (v_*.html / <lib>_* など) が欠落
 *
 * dataset 固有の理由は `SelakovicExclusionReason` 等の adapter 側 enum に置く。
 * `issue_excluded` / `candidate_excluded` フィールドは Union 型 `ExclusionReasonAny` を受ける。
 */
export const EXCLUSION_REASON_BASE = {
  PARSE_ERROR: "parse-error",
  NO_CHANGED_NODES: "no-changed-nodes",
  MULTI_FILE_CHANGE: "multi-file-change",
  MISSING_FILES: "missing-files",
} as const;
export type ExclusionReasonBase = (typeof EXCLUSION_REASON_BASE)[keyof typeof EXCLUSION_REASON_BASE];

/**
 * CLI の入力 (1 issue 分)。Python から subprocess の stdin に流し込まれる。
 */
export interface PreprocessingInput {
  id?: string;
  issue_dir: string;
}

/**
 * 1 candidate の出力 (equivalence-checker の入力単位)。
 *
 * `candidate_excluded` が指定されている場合 `slow` / `fast` / `setup` は undefined。
 * `enclosure_node_type` は抽出した最小 enclosure の AST ノード型名 (Babel ノード型、
 * "FunctionDeclaration" / "BlockStatement" 等)。threats to validity 集計で「どの粒度に
 * 収束したか」を見るため (ADR-0010)。
 *
 * `workload` は ADR-0023 D-β の placeholder substitution + 4 値契約フィールド。
 * `setup` に `$BODY$` プレースホルダを 1 個含み、`slow` / `fast` を `setup` の `$BODY$`
 * に差し込んで sandbox に渡す経路 (= changed-fn 経路) でのみ定義される。それ以外の
 * 経路 (client embedded / fallback / server 等) では `null` / `undefined`
 * (Python paired side が `None` を送ると JSON 経由で `null` になる)。
 */
export interface PreprocessingCandidate {
  setup?: string;
  slow?: string;
  fast?: string;
  workload?: string;
  before_node_count?: number;
  after_node_count?: number;
  enclosure_node_type?: string;
  candidate_excluded?: ExclusionReasonAny;
  candidate_meta: CandidateMeta;
}

/**
 * 1 issue = jsonl の 1 行。
 *
 * `issue_excluded` が指定されている場合 `candidates` は空配列でよい (= issue 全体が
 * 処理失敗)。`candidate_count` は `candidates.length` の冗長フィールド (見通し用)。
 */
export interface PreprocessingIssueResult {
  id?: string;
  issue_excluded?: ExclusionReasonAny;
  issue_excluded_detail?: string;
  candidates: PreprocessingCandidate[];
  candidate_count: number;
  /** issue 全体が gateway error で処理できなかった場合は省略可。それ以外は adapter が必ず付与する。 */
  issue_meta?: IssueMeta;
}

// ============================================================================
// Selakovic adapter (dataset 固有)
// ============================================================================

/**
 * 1 issue ディレクトリの物理レイアウト判定結果 (Selakovic dataset 構造)。
 *  - `client`: `v_*.html` 経由 (jsperf benchmark 形式)
 *  - `server`: `<lib>_*` ディレクトリ経由 (server / clientServer 系)
 *  - `unknown`: 判定不能
 */
export const LAYOUT_KIND = {
  CLIENT: "client",
  SERVER: "server",
  UNKNOWN: "unknown",
} as const;
export type LayoutKind = (typeof LAYOUT_KIND)[keyof typeof LAYOUT_KIND];

/**
 * 作用点ルーティングの結果 (ADR-0011 §段2)。「実コード変化が *どこ* にあるか」(issue level)。
 *  - `lib`: ライブラリ (`<lib>_*.js`) のみに実コード変化
 *  - `workload`: ベンチマーク関数 body (`f1.body` / `test()` body) のみに変化
 *  - `lib+workload`: 両方変化 — ADR-0014 の identifier 交差判定で 1 or 2 candidate に分割
 *  - `fallback`: どちらにも実コード変化なし / 規約外フォーマット → Tier 1 の素 diff
 */
export const ASPECT = {
  LIB: "lib",
  WORKLOAD: "workload",
  BOTH: "lib+workload",
  FALLBACK: "fallback",
} as const;
export type Aspect = (typeof ASPECT)[keyof typeof ASPECT];

/**
 * 出力候補がどっち側を表現しているか (candidate level、ADR-0024 §決定 §C)。
 *  - `lib`: lib 全文 embedded / lib+workload independent split の lib 側 / changed-fn (lib reachable)
 *  - `workload`: workload (`f1.body`) 単独 / lib+workload independent split の body 側
 *  - `both`: lib+workload co-evolution (1 candidate に両方含む) / fallback (Tier 1 素 diff)
 *
 * issue level の `aspect` と語彙が重なる ("lib"/"workload") が、レベルが違う:
 *  - `aspect` = 元 patch がどこにあるか (1 issue = 1 値)
 *  - `target_side` = この candidate がどっち側を表現するか (1 candidate = 1 値)
 */
export const TARGET_SIDE = {
  LIB: "lib",
  WORKLOAD: "workload",
  BOTH: "both",
} as const;
export type TargetSide = (typeof TARGET_SIDE)[keyof typeof TARGET_SIDE];

/**
 * f1 の wrap 構造 (ADR-0011 §段1、Selakovic benchmark の f1 の書かれ方)。
 *  - `top_level`: `var f1 = function(){...}` / `function f1(){...}` が Program 直下
 *  - `angular_controller_wrapper`: `app.controller("Ctrl", function($scope){ ...; var f1 = ...; ... })`
 */
export const WRAPPER_KIND = {
  TOP_LEVEL: "top_level",
  ANGULAR_CONTROLLER_WRAPPER: "angular_controller_wrapper",
} as const;
export type WrapperKind = (typeof WRAPPER_KIND)[keyof typeof WRAPPER_KIND];

/**
 * Selakovic dataset 固有の除外理由 (ADR-0024 で base から分離)。
 *  - `module-wide-change`: minimal enclosure が Program / File に到達 (複数関数最適化、fallback 経路)
 *  - `no-enclosure-candidate`: 候補型 (Function/Method/Block) が見つからない (fallback 経路)
 *  - `layout-unknown`: client / server のどちらでもないディレクトリ構造
 *  - `change-not-exercised`: lib の変更を (推移的にも) exercise する workload (`f1` / `test()`) が無い
 */
export const SELAKOVIC_EXCLUSION_REASON = {
  MODULE_WIDE_CHANGE: "module-wide-change",
  NO_ENCLOSURE_CANDIDATE: "no-enclosure-candidate",
  LAYOUT_UNKNOWN: "layout-unknown",
  CHANGE_NOT_EXERCISED: "change-not-exercised",
} as const;
export type SelakovicExclusionReason =
  (typeof SELAKOVIC_EXCLUSION_REASON)[keyof typeof SELAKOVIC_EXCLUSION_REASON];

/** Selakovic adapter の issue level メタ (1 issue = 1 値)。 */
export interface SelakovicIssueMeta {
  adapter: "selakovic";
  layout: LayoutKind;
  aspect: Aspect;
  wrapper_kind: WrapperKind;
}

/** Selakovic adapter の candidate level メタ (1 candidate = 1 値)。 */
export interface SelakovicCandidateMeta {
  adapter: "selakovic";
  target_side: TargetSide;
  /** changed_fn 抽出由来かどうか (= workload-reachable な変更関数を lambda-lift した小候補) */
  is_workload_reachable: boolean;
}

// ============================================================================
// Discriminated union (adapter 拡張ポイント)
// ============================================================================

/** issue level の adapter 拡張。新 dataset 追加時は `| OtherIssueMeta` で union を広げる。 */
export type IssueMeta = SelakovicIssueMeta;

/** candidate level の adapter 拡張。新 dataset 追加時は `| OtherCandidateMeta` で union を広げる。 */
export type CandidateMeta = SelakovicCandidateMeta;

/** 失敗理由の Union。base 4 値 + Selakovic 4 値 (= 8 値、enum 値文字列はオーバーラップなし)。 */
export type ExclusionReasonAny = ExclusionReasonBase | SelakovicExclusionReason;
