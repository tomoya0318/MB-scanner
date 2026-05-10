import { countNodes } from "../../ast/inspect";
import { parse } from "../../ast/parser";
import {
  ASPECT,
  CANDIDATE_KIND,
  LAYOUT_KIND,
  type ExecutionEnvironmentHint,
  type PreprocessingResult,
} from "../../contracts/preprocessing-contracts";
import {
  buildClientBodyCandidate,
  buildClientCombinedCandidate,
  buildClientLibCandidate,
} from "./assemble/client";
import { extractFromScripts, extractFromServerFiles } from "./assemble/fallback";
import { buildServerRunnable } from "./assemble/server";
import { extractF1 } from "./decompose/f1";
import { extractTest } from "./decompose/test-case";
import { routeAspect, statementsChanged } from "./route/aspect";
import { isIndependent } from "./route/case-split";
import { diffLibPair } from "./route/lib-diff";

/**
 * Selakovic 1 issue 分の前処理 — issue のファイル内容を `(setup, slow, fast)` candidate に変換する純関数
 * (ADR-0011 Tier 2)。`io → decompose → route → assemble` の 4 層を通し、`f1`/`test()` が規約外フォーマット
 * なら `assemble/fallback.ts` の素の top-level diff にフォールバックする。各層と作用点ルーティングの
 * 詳細は `preprocessing/README.md` §抽出パイプライン。
 */

export type SelakovicPreprocessInput =
  | {
      kind: "client";
      /** v_before.html の inline `<script>` 内容 (`<script src>` は除く)。 */
      before_inline: string;
      after_inline: string;
      /** `<lib>_before/after` の relative path / 正規化ファイル名 → ソース (lib pair なしなら `{}`)。 */
      lib_before_files: Record<string, string>;
      lib_after_files: Record<string, string>;
      lib_kind: "dir" | "file" | null;
      /** v_before.html が `<script src="<lib>_before.js">` でこの lib を参照しているか (= workload が runtime に lib を叩く)。 */
      lib_referenced_by_workload: boolean;
    }
  | {
      kind: "server";
      /** test_case_before.js / test_case_after.js の内容 (なければ null → fallback)。 */
      before_test_case: string | null;
      after_test_case: string | null;
      lib_before_files: Record<string, string>;
      lib_after_files: Record<string, string>;
      lib_kind: "dir" | "file" | null;
    };

const ENV_JSDOM: ExecutionEnvironmentHint = "jsdom";

export function preprocess(input: SelakovicPreprocessInput): PreprocessingResult[] {
  if (input.kind === "client") return preprocessClient(input);
  return preprocessServer(input);
}

function preprocessClient(input: Extract<SelakovicPreprocessInput, { kind: "client" }>): PreprocessingResult[] {
  const f1Before = extractF1(input.before_inline);
  const f1After = extractF1(input.after_inline);
  const beforeNodeCount = safeCount(input.before_inline);
  const afterNodeCount = safeCount(input.after_inline);

  const fallback = (): PreprocessingResult[] =>
    annotateFallback(extractFromScripts(input.before_inline, input.after_inline, LAYOUT_KIND.CLIENT));

  if (f1Before === null || f1After === null) return fallback();
  if (f1Before.wrapperKind !== f1After.wrapperKind) return fallback();
  // angular wrapper の bootstrap 再構成情報が欠落 → フォールバック
  if (f1Before.wrapperKind === "angular-controller-wrapper" && (f1Before.angular === undefined || f1After.angular === undefined)) {
    return fallback();
  }

  const libChange = diffLibPair(input.lib_before_files, input.lib_after_files);
  const libHasRealChange = input.lib_kind !== null && libChange.hasRealChange;
  const bodyHasRealChange = statementsChanged(f1Before.f1Body.body, f1After.f1Body.body);
  const aspect = routeAspect(libHasRealChange, bodyHasRealChange);
  if (aspect === ASPECT.FALLBACK) return fallback();

  const libSourceBefore = singleLibSource(input.lib_before_files);
  const libSourceAfter = singleLibSource(input.lib_after_files);
  const libNeededInSetup = input.lib_kind !== null && input.lib_referenced_by_workload;

  let candidates: PreprocessingResult[];
  if (aspect === ASPECT.LIB) {
    candidates = [buildClientLibCandidate(f1Before, libSourceBefore, libSourceAfter, CANDIDATE_KIND.SINGLE)];
  } else if (aspect === ASPECT.BODY) {
    candidates = [buildClientBodyCandidate(f1Before, f1After, libSourceBefore, libNeededInSetup, CANDIDATE_KIND.SINGLE)];
  } else {
    // A+B: body の参照 identifier と lib の変化関数名 (diffLibPair の近似) が交差しなければ
    // independent → lib candidate / body candidate に分割、交差すれば co-evolution の疑いで 1 candidate (ADR-0014)。
    if (isIndependent(f1Before.f1Body.body, libChange.changedFunctionNames)) {
      candidates = [
        buildClientLibCandidate(f1Before, libSourceBefore, libSourceAfter, CANDIDATE_KIND.LIB),
        buildClientBodyCandidate(f1Before, f1After, libSourceBefore, libNeededInSetup, CANDIDATE_KIND.BODY),
      ];
    } else {
      candidates = [buildClientCombinedCandidate(f1Before, f1After, libSourceBefore, libSourceAfter)];
    }
  }

  return candidates.map((c) => ({ ...c, aspect, before_node_count: beforeNodeCount, after_node_count: afterNodeCount }));
}

function preprocessServer(input: Extract<SelakovicPreprocessInput, { kind: "server" }>): PreprocessingResult[] {
  const fallback = (): PreprocessingResult[] =>
    annotateFallback(extractFromServerFiles(input.lib_before_files, input.lib_after_files));

  if (input.before_test_case === null || input.after_test_case === null) return fallback();
  const testBefore = extractTest(input.before_test_case);
  const testAfter = extractTest(input.after_test_case);
  if (testBefore === null || testAfter === null) return fallback();

  const libChange = diffLibPair(input.lib_before_files, input.lib_after_files);
  const libHasRealChange = input.lib_kind !== null && libChange.hasRealChange;
  const bodyHasRealChange = statementsChanged(testBefore.testBody.body, testAfter.testBody.body);
  const aspect = routeAspect(libHasRealChange, bodyHasRealChange);
  if (aspect === ASPECT.FALLBACK) return fallback();

  // server は作用点に関わらず 1 candidate (ADR-0014 のケース IV-B は暫定 1 candidate 扱い)。
  // slow/fast = test_case_{before,after} の runnable program — aspect A なら init() の require が
  // `_before` ↔ `_after` で切り替わり、aspect B なら test() body が切り替わる。
  const beforeNodeCount = safeCount(input.before_test_case);
  const afterNodeCount = safeCount(input.after_test_case);
  return [
    {
      layout: LAYOUT_KIND.SERVER,
      setup: "",
      slow: buildServerRunnable(input.before_test_case),
      fast: buildServerRunnable(input.after_test_case),
      enclosure_type: "server-test-case",
      candidate_kind: CANDIDATE_KIND.SINGLE,
      environment: ENV_JSDOM,
      aspect,
      before_node_count: beforeNodeCount,
      after_node_count: afterNodeCount,
    },
  ];
}

/** lib file map から「単一の lib ソース」を取り出す (clientIssues の lib は単一ファイル形式)。 */
function singleLibSource(files: Record<string, string>): string {
  const values = Object.values(files);
  if (values.length === 0) return "";
  if (values.length === 1) return values[0] ?? "";
  return values.join("\n;\n");
}

function safeCount(source: string): number {
  try {
    return countNodes(parse(source));
  } catch {
    return 0;
  }
}

/** fallback (Tier 1 素の diff) の結果に `aspect: "fallback"` 等の hint を付与する。 */
function annotateFallback(results: PreprocessingResult[]): PreprocessingResult[] {
  return results.map((r) => ({
    ...r,
    aspect: ASPECT.FALLBACK,
    candidate_kind: CANDIDATE_KIND.SINGLE,
    environment: ENV_JSDOM,
  }));
}
