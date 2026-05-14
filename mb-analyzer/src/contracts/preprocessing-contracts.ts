/**
 * Python 側 (`mb_scanner.domain.entities.preprocessing`) との JSON シリアライゼーション契約。
 * 列挙値の文字列とフィールド名 (snake_case) を両言語で厳密に揃える。
 *
 * 変更時は paired-change で `mb_scanner/domain/entities/preprocessing.py` も同時に更新。
 */

export const LAYOUT_KIND = {
  CLIENT: "client",
  SERVER: "server",
  UNKNOWN: "unknown",
} as const;
export type LayoutKind = (typeof LAYOUT_KIND)[keyof typeof LAYOUT_KIND];

/**
 * 抽出が成立しなかった場合の理由コード。集計で内訳を取るのに使う。
 *
 * - `parse-error`: before / after の AST parse に失敗
 * - `no-changed-nodes`: AST diff が空 (整形差分のみで意味論変更なし)
 * - `module-wide-change`: minimal enclosure が Program / File に到達 (複数関数最適化、fallback 経路)
 * - `multi-file-change`: server 系で変更が複数ファイルにまたがる
 * - `no-enclosure-candidate`: 候補型 (Function/Method/Block) が見つからない (fallback 経路)
 * - `layout-unknown`: client / server のどちらでもないディレクトリ構造
 * - `missing-files`: 期待するファイル (v_*.html / <lib>_* など) が欠落
 * - `change-not-exercised`: lib の変更を (推移的にも) exercise する workload (`f1` / `test()`) が無い
 *   = ベンチが lib 変更を測っていない (例: 最適化を inline `<script>` に micro-reconstruct)。実行ベース
 *   等価検証では検証不能 → 除外 (recall の限界)。
 */
export const EXCLUSION_REASON = {
  PARSE_ERROR: "parse-error",
  NO_CHANGED_NODES: "no-changed-nodes",
  MODULE_WIDE_CHANGE: "module-wide-change",
  MULTI_FILE_CHANGE: "multi-file-change",
  NO_ENCLOSURE_CANDIDATE: "no-enclosure-candidate",
  LAYOUT_UNKNOWN: "layout-unknown",
  MISSING_FILES: "missing-files",
  CHANGE_NOT_EXERCISED: "change-not-exercised",
} as const;
export type ExclusionReason = (typeof EXCLUSION_REASON)[keyof typeof EXCLUSION_REASON];

/**
 * 作用点ルーティングの結果 (ADR-0011 §段2)。「実コード変化が *どこ* にあるか」。
 * - `lib`: ライブラリ (`<lib>_*.js`) のみに実コード変化 — 真 patch は lib の中 (実 PR では production コード変更に相当、常態)
 * - `workload`: ベンチマーク関数 body (`f1.body` / `test()` body) のみに変化 — 真 patch は workload コードの中
 * - `lib+workload`: 両方変化 — ADR-0014 の identifier 交差判定で 1 or 2 candidate に分割
 * - `fallback`: どちらにも実コード変化なし / 規約外フォーマット → Tier 1 の素の top-level diff
 */
export const ASPECT = {
  LIB: "lib",
  WORKLOAD: "workload",
  BOTH: "lib+workload",
  FALLBACK: "fallback",
} as const;
export type Aspect = (typeof ASPECT)[keyof typeof ASPECT];

/**
 * candidate の役割 / 形。
 * - `single`: split しない既定形 (`aspect: lib` の embedded / `aspect: workload` / `aspect: lib+workload` の
 *   co-evolution / `fallback`)。`(setup, slow, fast)` がそのまま 1 セット
 * - `lib`: `aspect: lib+workload` の独立判定で 2 分割したときの lib 側 — lib varies / workload body fixed@before
 * - `body`: 同 workload body 側 — workload body varies / lib fixed@before
 * - `changed-fn`: `aspect: lib` (lib 内 patch) について、workload が (推移的に) exercise する変更関数を 1 つ
 *   `<lib>_*.js` から切り出した pruning 向け candidate。slow/fast = `__HOLE__` に変更前/後の関数本体
 *   (lambda-lift = lib 内部の補助関数・変数を引数化) + 観測する形 (戻り値を記録して返す) + workload、
 *   setup = lib 全文 (変更関数だけ穴空き、ガード + after 本体インライン fallback) + 依存 lib + preWorkload。
 *   1 issue で 0〜数個出る — 同 issue の embedded (`single`) と併存し、等価検証/pruning はこの小さい版を使う。
 */
export const CANDIDATE_KIND = {
  SINGLE: "single",
  LIB: "lib",
  BODY: "body",
  CHANGED_FN: "changed-fn",
} as const;
export type CandidateKind = (typeof CANDIDATE_KIND)[keyof typeof CANDIDATE_KIND];

/**
 * preprocess が推奨する等価検証の実行環境 (= 後段の equivalence-checker への hint)。
 * server / Angular controller-wrapper は `require` 解決 / DOM が要るので `jsdom`、
 * 純粋計算の top-level f1 は `vm`。値は `equivalence-contracts.ts` の `EXECUTION_ENVIRONMENT` と一致させる。
 */
export type ExecutionEnvironmentHint = "vm" | "jsdom";

/**
 * CLI の入力 (1 issue 分)。Python から subprocess の stdin に流し込まれる。
 *
 * `issue_dir` は絶対パスで、CLI 側でファイル読み込みとレイアウト判定をする。
 * 純粋関数 `preprocess()` は文字列内容を受け取るので、ファイル I/O は CLI に閉じ込める。
 */
export interface PreprocessingInput {
  id?: string;
  issue_dir: string;
}

/**
 * 抽出結果。`excluded` が指定されている場合 `slow` / `fast` / `setup` は undefined。
 *
 * `enclosure_type` は AST ノード型名 ("FunctionDeclaration" / "BlockStatement" 等)。
 * threats to validity 集計で「どの粒度に収束したか」を見るため。
 */
export interface PreprocessingResult {
  id?: string;
  layout: LayoutKind;
  setup?: string;
  slow?: string;
  fast?: string;
  enclosure_type?: string;
  before_node_count?: number;
  after_node_count?: number;
  excluded?: ExclusionReason;
  excluded_detail?: string;
  /** 作用点ルーティングの結果 (ADR-0011 §段2)。fallback 経路では `fallback`。 */
  aspect?: Aspect;
  /** A+B split (ADR-0014) における役割。split しない candidate は `single`。 */
  candidate_kind?: CandidateKind;
  /** 後段の等価検証で使う実行環境の hint (`vm` / `jsdom`)。 */
  environment?: ExecutionEnvironmentHint;
}
