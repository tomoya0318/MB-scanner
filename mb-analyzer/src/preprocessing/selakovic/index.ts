import { countNodes } from "../../ast/inspect";
import { parse } from "../../ast/parser";
import {
  ASPECT,
  CANDIDATE_KIND,
  LAYOUT_KIND,
  type CandidateKind,
  type ExecutionEnvironmentHint,
  type PreprocessingResult,
} from "../../contracts/preprocessing-contracts";
import { statementsToCode } from "../common/setup-cleanup";
import { buildAngularRunnable } from "./angular-bootstrap";
import { routeAspect, statementsChanged } from "./aspect-routing";
import { isIndependent } from "./case-split";
import { extractF1, type F1Decomposition } from "./f1-extract";
import { extractFromScripts, extractFromServerFiles } from "./legacy-diff";
import { diffLibPair } from "./lib-diff";
import { extractTest } from "./test-extract";

/**
 * Selakovic 1 issue 分の `(setup, slow, fast)` 抽出 — ADR-0011 の Tier 2 (Selakovic adapter)。
 *
 * **段 1 (役割分解 + 計測ハーネス除去)** — ADR-0011 §段1:
 * - ① `<lib>_before/after` ペア (dir scan、`extract()` には CLI が読んだ map で渡る)
 * - ② ベンチマーク関数 body ペア (client: inline `<script>` の `f1` body / server: `test_case_*.js` の `test()` body)
 * - 計測ハーネス (`execute(f1,n)` 以降 / `$.ajax({mark,mean})` / `init`/`setupTest`) は setup へ回すか破棄
 * - body 内のループ反復回数は書き換えない (= 復元可能性のため。反復縮小は等価検証側 — ADR-0013)
 *
 * **段 2 (作用点ルーティング)** — ADR-0011 §段2:
 * - ①② の実コード差分で A (lib のみ) / B (body のみ) / A+B (両方) / fallback に振り分け
 * - A / B → candidate 1 個。A+B → ADR-0014 の identifier 交差判定で independent なら 2 candidate
 *   (lib candidate / body candidate)、co-evolution の疑いなら 1 candidate
 * - fallback (どちらにも実コード差なし / 規約外フォーマット) → Tier 1 の素の top-level diff (`legacy-diff.ts`)
 */

export type SelakovicExtractInput =
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

export function extract(input: SelakovicExtractInput): PreprocessingResult[] {
  if (input.kind === "client") return extractClient(input);
  return extractServer(input);
}

// ─────────────────────────────────────────────────────────────────────────────
// client (inline `<script>` の f1)
// ─────────────────────────────────────────────────────────────────────────────

function extractClient(input: Extract<SelakovicExtractInput, { kind: "client" }>): PreprocessingResult[] {
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
    // A+B → ADR-0014: body の参照 identifier と lib の変化関数名 (lib-diff の近似) の交差で判定。
    // 交差なし (independent) → lib candidate / body candidate に分割、交差あり → 1 candidate (co-evolution の疑い)。
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

/** 作用点 A の lib candidate: lib varies / body fixed@before。 */
function buildClientLibCandidate(
  f1Before: F1Decomposition,
  libSourceBefore: string,
  libSourceAfter: string,
  kind: CandidateKind,
): PreprocessingResult {
  const preF1 = statementsToCode([...f1Before.preF1Statements]);
  if (f1Before.wrapperKind === "angular-controller-wrapper" && f1Before.angular !== undefined) {
    const a = f1Before.angular;
    return {
      layout: LAYOUT_KIND.CLIENT,
      setup: "",
      slow: buildAngularRunnable({ libSource: libSourceBefore, moduleName: a.moduleName, ctrlName: a.ctrlName, ctrlParams: a.ctrlParams, preF1Code: preF1, f1BodyCode: f1BodyRaw(f1Before) }),
      fast: buildAngularRunnable({ libSource: libSourceAfter, moduleName: a.moduleName, ctrlName: a.ctrlName, ctrlParams: a.ctrlParams, preF1Code: preF1, f1BodyCode: f1BodyRaw(f1Before) }),
      enclosure_type: "angular-controller-wrapper",
      candidate_kind: kind,
      environment: ENV_JSDOM,
    };
  }
  return {
    layout: LAYOUT_KIND.CLIENT,
    setup: "",
    slow: flatRunnable(libSourceBefore, preF1, f1BodyWrapped(f1Before)),
    fast: flatRunnable(libSourceAfter, preF1, f1BodyWrapped(f1Before)),
    enclosure_type: "lib-file",
    candidate_kind: kind,
    environment: ENV_JSDOM,
  };
}

/** 作用点 B の body candidate: body varies / lib fixed@before。 */
function buildClientBodyCandidate(
  f1Before: F1Decomposition,
  f1After: F1Decomposition,
  libSourceBefore: string,
  libNeededInSetup: boolean,
  kind: CandidateKind,
): PreprocessingResult {
  const preF1 = statementsToCode([...f1Before.preF1Statements]);
  if (f1Before.wrapperKind === "angular-controller-wrapper" && f1Before.angular !== undefined) {
    const a = f1Before.angular;
    return {
      layout: LAYOUT_KIND.CLIENT,
      setup: "",
      slow: buildAngularRunnable({ libSource: libSourceBefore, moduleName: a.moduleName, ctrlName: a.ctrlName, ctrlParams: a.ctrlParams, preF1Code: preF1, f1BodyCode: f1BodyRaw(f1Before) }),
      fast: buildAngularRunnable({ libSource: libSourceBefore, moduleName: a.moduleName, ctrlName: a.ctrlName, ctrlParams: a.ctrlParams, preF1Code: preF1, f1BodyCode: f1BodyRaw(f1After) }),
      enclosure_type: "angular-controller-wrapper",
      candidate_kind: kind,
      environment: ENV_JSDOM,
    };
  }
  const setupParts: string[] = [];
  if (libNeededInSetup && libSourceBefore.length > 0) setupParts.push(libSourceBefore);
  if (preF1.length > 0) setupParts.push(preF1);
  return {
    layout: LAYOUT_KIND.CLIENT,
    setup: setupParts.join("\n;\n"),
    slow: f1BodyWrapped(f1Before),
    fast: f1BodyWrapped(f1After),
    enclosure_type: "f1-body",
    candidate_kind: kind,
    // clientIssues の inline `<script>` は browser context で動く前提 (= `document`/`window` を参照しうる)
    // ので、純粋計算に見える f1 body でも jsdom で実行する。
    environment: ENV_JSDOM,
  };
}

/** A+B co-evolution の疑い: lib も body も同時に変える 1 candidate。 */
function buildClientCombinedCandidate(
  f1Before: F1Decomposition,
  f1After: F1Decomposition,
  libSourceBefore: string,
  libSourceAfter: string,
): PreprocessingResult {
  const preF1 = statementsToCode([...f1Before.preF1Statements]);
  if (f1Before.wrapperKind === "angular-controller-wrapper" && f1Before.angular !== undefined) {
    const a = f1Before.angular;
    return {
      layout: LAYOUT_KIND.CLIENT,
      setup: "",
      slow: buildAngularRunnable({ libSource: libSourceBefore, moduleName: a.moduleName, ctrlName: a.ctrlName, ctrlParams: a.ctrlParams, preF1Code: preF1, f1BodyCode: f1BodyRaw(f1Before) }),
      fast: buildAngularRunnable({ libSource: libSourceAfter, moduleName: a.moduleName, ctrlName: a.ctrlName, ctrlParams: a.ctrlParams, preF1Code: preF1, f1BodyCode: f1BodyRaw(f1After) }),
      enclosure_type: "angular-controller-wrapper",
      candidate_kind: CANDIDATE_KIND.SINGLE,
      environment: ENV_JSDOM,
    };
  }
  return {
    layout: LAYOUT_KIND.CLIENT,
    setup: "",
    slow: flatRunnable(libSourceBefore, preF1, f1BodyWrapped(f1Before)),
    fast: flatRunnable(libSourceAfter, preF1, f1BodyWrapped(f1After)),
    enclosure_type: "lib-file+f1-body",
    candidate_kind: CANDIDATE_KIND.SINGLE,
    environment: ENV_JSDOM,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// server (test_case_*.js の test())
// ─────────────────────────────────────────────────────────────────────────────

function extractServer(input: Extract<SelakovicExtractInput, { kind: "server" }>): PreprocessingResult[] {
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

  // server は A / B / A+B いずれも 1 candidate (ADR-0014: ケース IV-B は暫定的に 1 candidate 扱い)。
  // slow/fast = test_case_{before,after} の runnable program。aspect A なら init() の require が
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

// ─────────────────────────────────────────────────────────────────────────────
// runnable program builders
// ─────────────────────────────────────────────────────────────────────────────

/** `[libSource]\n;\n[preF1]\n;\n[bodyCode]` を 1 つの実行可能スクリプトに連結する (top-level f1 用)。 */
function flatRunnable(libSource: string, preF1Code: string, bodyCode: string): string {
  const parts: string[] = [];
  if (libSource.length > 0) {
    parts.push(libSource);
    parts.push(";");
  }
  if (preF1Code.length > 0) {
    parts.push(preF1Code);
    parts.push(";");
  }
  parts.push(bodyCode);
  return parts.join("\n");
}

/**
 * server `test_case_*.js` の内容を「module/exports/require を与えて評価 → init()/setupTest()/test() を
 * 実行 → 観測値を JSON で return」する自己完結 IIFE に包む。`require('./<lib>_*.js')` は実行環境
 * (jsdom executor) が `module_base_dir` 起点で解決する (= グローバル `require`)。
 */
function buildServerRunnable(testCaseSource: string): string {
  return [
    "(function () {",
    "var __selakovic_module = { exports: {} };",
    "var __selakovic_require = (typeof require === 'function') ? require : function () { return {}; };",
    "(function (module, exports, require) {",
    testCaseSource,
    "})(__selakovic_module, __selakovic_module.exports, __selakovic_require);",
    "var __selakovic_exp = __selakovic_module.exports;",
    "var __selakovic_tryJson = function (v) { try { return JSON.stringify(v); } catch (e) { return '<<unserializable>>'; } };",
    "var __selakovic_i, __selakovic_s, __selakovic_r, __selakovic_ex = null;",
    "try {",
    "  __selakovic_i = (typeof __selakovic_exp.init === 'function') ? __selakovic_exp.init() : undefined;",
    "  __selakovic_s = (typeof __selakovic_exp.setupTest === 'function') ? __selakovic_exp.setupTest(__selakovic_i) : undefined;",
    "  __selakovic_r = (typeof __selakovic_exp.test === 'function') ? __selakovic_exp.test(__selakovic_i, __selakovic_s) : undefined;",
    "} catch (e) {",
    "  __selakovic_ex = { name: (e && e.name) || 'Error', message: (e && e.message) || String(e) };",
    "}",
    "return JSON.stringify({ test: (__selakovic_r === undefined ? '<<undefined>>' : __selakovic_r), init: __selakovic_tryJson(__selakovic_i), setup: __selakovic_tryJson(__selakovic_s), exception: __selakovic_ex });",
    "})()",
  ].join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * f1 body の中身 (外側の `{}` を含まない statement 列) を生コード化する。
 * `buildAngularRunnable` の `f1BodyCode` (= `var f1 = function () { <ここ> }` の中身) に使う。
 */
function f1BodyRaw(f1: F1Decomposition): string {
  return statementsToCode([...f1.f1Body.body]);
}

/**
 * f1 body を `(function () { <body> })()` で包んだ実行式。standalone な body candidate / flat runnable
 * の body 部に使う。完了値が「捨てられる末尾式」(`for(...) <expr>;`) ではなく f1 本来の `return` 値
 * (なければ undefined) になるので、`%2===0` ↔ `&1===0` のような precedence 差が偽 not_equal を生まない。
 */
function f1BodyWrapped(f1: F1Decomposition): string {
  return `(function () {\n${f1BodyRaw(f1)}\n})()`;
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
