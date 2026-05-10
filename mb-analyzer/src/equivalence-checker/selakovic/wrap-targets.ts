/**
 * 記録 Proxy (C6 の取得側) で「何を包むか」の spec を `enclosure_type` から決める (Selakovic adapter)。
 *
 * 包む対象 = 「workload (`f1` / `test()`) が実際に受け取る・叩く境界オブジェクト」(spike-results §3):
 * - server `test_case`: `init()` / `setupTest()` の戻り値の値 (`module.exports` = chalk / cheerio root / moment object /
 *   Backbone / lru-cache constructor 等。`init`/`setupTest` 自体は RAW で走らせる)
 * - Angular controller-wrapper: controller に注入される service (`$scope` / `$compile` / `$filter` のうち workload が使うもの)
 * - lib-file (client、top-level f1 が lib を直接叩く): lib に対応する window グローバル (jQuery / `_` / ejs / …)。
 *   `EquivalenceInput` は lib 名を持たないので保守的に既知の global 候補を並べ、存在するものだけ wrap する想定。
 *
 * ── 現状: この spec はまだ executor から消費していない ──
 * server/Angular の runnable は「`init()→setupTest()→test()` / module・controller 再構成→`f1()` を 1 つの IIFE で
 * 完結させ JSON 観測束を return する」monolithic な形 (`preprocessing/selakovic/assemble/{server,angular}.ts`) で、
 * 「setup 実行後・body 実行前」に包む対象が global として見えるシームが無い。C6 の trace を実際に取るには runnable 側を
 * 「`globalThis.__recorder` があれば内部の `__selakovic_i`/`__selakovic_s`/`__selakovic_scope`/lib global を wrap して呼ぶ」
 * recorder-aware な形にする必要があり、これは preprocessing 側の変更 = 設計判断 (handoff 参照)。本ファイルは「包む対象」を
 * コード上に明文化しておくためのもの。executor wiring が入ったら `selakovic/checker.ts` がこれを executor に渡す。
 */

export type WrapTargetSpec =
  | { kind: "init-setup-results" }
  | { kind: "injected-services"; names: readonly string[] }
  | { kind: "globals"; names: readonly string[] };

const ANGULAR_INJECTED_SERVICES: readonly string[] = ["$scope", "$compile", "$filter"];

// client lib-file 系で workload が直接叩きうる window グローバル候補 (保守的)。
const CLIENT_LIB_GLOBALS: readonly string[] = ["$", "jQuery", "_", "ejs", "Ember", "React", "angular", "Q"];

/** `enclosure_type` (preprocessing-contracts) から記録 Proxy の wrap spec を返す。包む対象が無ければ null。 */
export function wrapTargetsFor(enclosureType: string | undefined): WrapTargetSpec | null {
  switch (enclosureType) {
    case "server-test-case":
      return { kind: "init-setup-results" };
    case "angular-controller-wrapper":
      return { kind: "injected-services", names: ANGULAR_INJECTED_SERVICES };
    case "lib-file":
    case "lib-file+f1-body":
      return { kind: "globals", names: CLIENT_LIB_GLOBALS };
    // f1-body (作用点 B の body candidate) / fallback / top-level の f1-body 等は workload↔SUT 境界が無い → 包まない
    default:
      return null;
  }
}
