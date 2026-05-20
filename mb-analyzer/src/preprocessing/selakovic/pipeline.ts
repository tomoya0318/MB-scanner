import { countNodes } from "../../ast/inspect";
import { parse } from "../../ast/parser";
import {
  ASPECT,
  LAYOUT_KIND,
  SELAKOVIC_EXCLUSION_REASON,
  TARGET_SIDE,
  WRAPPER_KIND,
  type Aspect,
  type LayoutKind,
  type PreprocessingCandidate,
  type PreprocessingIssueResult,
  type SelakovicIssueMeta,
  type WrapperKind,
} from "../../contracts/preprocessing-contracts";
import { findChangeUnits, type FnChangeUnit, type StmtChangeUnit } from "../common/change-units";
import { buildCallGraph, isAnyBindingReachedByWorkload, isReachedByAnyWorkload } from "../common/reachability";
import { buildChangedFnCandidate, buildExcludedChangedFnCandidate } from "./assemble/strategies/changed-fn";
import { buildChangedStmtCandidate } from "./assemble/strategies/changed-stmt";
import { extractFromScripts, extractFromServerFiles, type FallbackResult } from "./assemble/strategies/fallback";
import {
  buildClientBodyCandidate,
  buildClientCombinedCandidate,
  buildClientLibCandidate,
} from "./assemble/wrappers/top-level";
import { buildServerRunnable } from "./assemble/wrappers/server";
import { extractF1, type F1Decomposition, type WrapperKind as DecomposeWrapperKind } from "./decompose/f1";
import { extractTest } from "./decompose/test-case";
import { routeAspect, statementsChanged } from "./route/aspect";
import { isIndependent } from "./route/case-split";
import { diffLibPair } from "./route/lib-diff";

/**
 * Selakovic 1 issue 分の前処理 — issue のファイル内容を 1 つの `PreprocessingIssueResult` (内部に
 * `candidates: list[PreprocessingCandidate]` を持つ階層構造) に変換する純関数 (ADR-0011 Tier 2、ADR-0024)。
 * `io → decompose → route → assemble` の 4 層を通し、`f1`/`test()` が規約外フォーマットなら fallback。
 */

export type SelakovicPreprocessInput =
  | {
      kind: "client";
      before_inline: string;
      after_inline: string;
      lib_before_files: Record<string, string>;
      lib_after_files: Record<string, string>;
      lib_kind: "dir" | "file" | null;
      lib_referenced_by_workload: boolean;
      dep_lib_sources?: readonly string[];
    }
  | {
      kind: "server";
      before_test_case: string | null;
      after_test_case: string | null;
      lib_before_files: Record<string, string>;
      lib_after_files: Record<string, string>;
      lib_kind: "dir" | "file" | null;
    };

export function preprocess(input: SelakovicPreprocessInput): PreprocessingIssueResult {
  if (input.kind === "client") return preprocessClient(input);
  return preprocessServer(input);
}

function preprocessClient(input: Extract<SelakovicPreprocessInput, { kind: "client" }>): PreprocessingIssueResult {
  const f1Before = extractF1(input.before_inline);
  const f1After = extractF1(input.after_inline);
  const beforeNodeCount = safeCount(input.before_inline);
  const afterNodeCount = safeCount(input.after_inline);

  const fallback = (): PreprocessingIssueResult => {
    const fb = extractFromScripts(input.before_inline, input.after_inline);
    return buildIssueResult(
      LAYOUT_KIND.CLIENT,
      ASPECT.FALLBACK,
      mapWrapperKind(f1Before?.wrapperKind),
      fb,
      beforeNodeCount,
      afterNodeCount,
    );
  };

  if (f1Before === null || f1After === null) return fallback();
  if (f1Before.wrapperKind !== f1After.wrapperKind) return fallback();
  if (
    f1Before.wrapperKind === "angular-controller-wrapper" &&
    (f1Before.angular === undefined || f1After.angular === undefined)
  ) {
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

  let candidates: PreprocessingCandidate[];
  if (aspect === ASPECT.LIB) {
    // embedded (#0、target_side=lib) + workload が exercise する変更関数ごとに changed-fn 候補 (#1+、target_side=lib)
    candidates = [buildClientLibCandidate(f1Before, libSourceBefore, libSourceAfter, TARGET_SIDE.LIB)];
    appendChangeUnitCandidates(candidates, libSourceBefore, libSourceAfter, f1Before);
  } else if (aspect === ASPECT.WORKLOAD) {
    candidates = [buildClientBodyCandidate(f1Before, f1After, libSourceBefore, libNeededInSetup, TARGET_SIDE.WORKLOAD)];
  } else {
    // lib+workload: independent → lib + workload (split)、co-evolution → 1 candidate (target_side=both)
    if (isIndependent(f1Before.f1Body.body, libChange.changedFunctionNames)) {
      candidates = [
        buildClientLibCandidate(f1Before, libSourceBefore, libSourceAfter, TARGET_SIDE.LIB),
        buildClientBodyCandidate(f1Before, f1After, libSourceBefore, libNeededInSetup, TARGET_SIDE.WORKLOAD),
      ];
      appendChangeUnitCandidates(candidates, libSourceBefore, libSourceAfter, f1Before);
    } else {
      candidates = [buildClientCombinedCandidate(f1Before, f1After, libSourceBefore, libSourceAfter)];
    }
  }

  // CDN 依存 lib (jquery/handlebars/underscore) を各候補の setup 先頭に連結。
  const depPrefix = (input.dep_lib_sources ?? []).join("\n;\n");
  const finalized = candidates.map((c) => {
    // excluded marker (= candidate_excluded を持つ) は setup/node count を持たない (ADR-0023 D-γ §DROP 可視化):
    // reason に依らず dep 連結も node count 上書きも skip する。
    if (c.candidate_excluded !== undefined) return c;
    const base =
      depPrefix.length > 0 && typeof c.setup === "string"
        ? { ...c, setup: c.setup.length > 0 ? `${depPrefix}\n;\n${c.setup}` : depPrefix }
        : c;
    // changed-fn は builder が入れた node count (= 変更関数本体のサイズ) を尊重し、inline 全文サイズで上書きしない。
    return base.candidate_meta.is_workload_reachable
      ? base
      : { ...base, before_node_count: beforeNodeCount, after_node_count: afterNodeCount };
  });

  return {
    candidates: finalized,
    candidate_count: finalized.length,
    issue_meta: {
      adapter: "selakovic",
      layout: LAYOUT_KIND.CLIENT,
      aspect,
      wrapper_kind: mapWrapperKind(f1Before.wrapperKind),
    },
  };
}

/**
 * `aspect: lib` (および `aspect: lib+workload` 独立判定の lib 側) について、`<lib>_*.js` の変更を unit に切り分け
 * (`findChangeUnits`)、workload (`f1`) が (推移的に) exercise する変更 unit ごとに candidate を `candidates`
 * の末尾に push する (fn unit / stmt unit の両方を扱うので関数名は `ChangeUnit` 単位、順 1-d で responsibility
 * 拡大)。fn unit は changed-fn strategy (`buildChangedFnCandidate`)、stmt unit は changed-stmt strategy
 * (`buildChangedStmtCandidate`、ADR-0023 §observation 仕様 の workload-driven 退化形) で組む。真の candidate を
 * 作れない unit は `candidate_excluded` marker として push し、痕跡を残す (setup/slow/fast は持たない、ADR-0022
 * §計装 / ADR-0023 D-γ §DROP 可視化)。早期 return (= lib 全体の DROP) も issue ごとに 1 件 marker。等価検証
 * 本体は embedded `#0` がカバーする。angular controller wrapper の f1 は D-β では skip (D-γ で対応検討)。
 */
function appendChangeUnitCandidates(
  candidates: PreprocessingCandidate[],
  libSourceBefore: string,
  libSourceAfter: string,
  f1Before: F1Decomposition,
): void {
  if (libSourceBefore.length === 0 || libSourceAfter.length === 0) {
    candidates.push(buildExcludedChangedFnCandidate(SELAKOVIC_EXCLUSION_REASON.NO_LIB_SOURCE));
    return;
  }
  if (f1Before.wrapperKind !== "top-level") {
    candidates.push(buildExcludedChangedFnCandidate(SELAKOVIC_EXCLUSION_REASON.ANGULAR_WRAPPER_SKIP));
    return;
  }

  let cu;
  try {
    cu = findChangeUnits(libSourceBefore, libSourceAfter);
  } catch {
    candidates.push(buildExcludedChangedFnCandidate(SELAKOVIC_EXCLUSION_REASON.CHANGE_UNITS_PARSE_FAIL));
    return;
  }
  if (cu.empty) {
    candidates.push(buildExcludedChangedFnCandidate(SELAKOVIC_EXCLUSION_REASON.EMPTY_DIFF));
    return;
  }
  // afterFn=null (rename / 削除) も含めて fn unit を可視化対象にする (ADR-0023 D-γ §DROP 可視化、
  // FN_RENAMED_OR_REMOVED reason を builder 内で marker 化)。stmt unit も changed-stmt strategy で 1st-class
  // candidate に格上げ (no-fn-unit rescue、phase3 順 1-d): モジュール本体 / 匿名 IIFE 本体直下の変更
  // (`var VERSION = '...'` 等) を、reachable な named fn から読まれるなら workload-driven observation で
  // 等価検証に乗せる。
  const fnUnits = cu.units.filter((u): u is FnChangeUnit => u.kind === "fn");
  const stmtUnits = cu.units.filter((u): u is StmtChangeUnit => u.kind === "stmt");
  if (fnUnits.length === 0 && stmtUnits.length === 0) {
    candidates.push(buildExcludedChangedFnCandidate(SELAKOVIC_EXCLUSION_REASON.NO_FN_UNIT));
    return;
  }

  const graph = buildCallGraph(cu.beforeAst, [{ name: "f1", body: [...f1Before.preWorkloadStatements, ...f1Before.f1Body.body] }]);
  for (const u of fnUnits) {
    if (!isReachedByAnyWorkload(graph, u.name)) {
      candidates.push(buildExcludedChangedFnCandidate(SELAKOVIC_EXCLUSION_REASON.CHANGE_NOT_EXERCISED));
      continue;
    }
    candidates.push(buildChangedFnCandidate(u, libSourceAfter, f1Before));
  }
  for (const u of stmtUnits) {
    // 名指しできない stmt (`if`/`for` 等の制御構文 top-level、bindings=[]) は workload-reachability で
    // 判定不能なので NO_FN_UNIT marker で先弾く (CHANGE_NOT_EXERCISED は「判定したが到達不能」を意味する
    // ので、判定不能と区別する)。
    if (u.bindings.length === 0) {
      candidates.push(buildExcludedChangedFnCandidate(SELAKOVIC_EXCLUSION_REASON.NO_FN_UNIT));
      continue;
    }
    if (!isAnyBindingReachedByWorkload(graph, u.bindings)) {
      candidates.push(buildExcludedChangedFnCandidate(SELAKOVIC_EXCLUSION_REASON.CHANGE_NOT_EXERCISED));
      continue;
    }
    candidates.push(buildChangedStmtCandidate(u, libSourceBefore, libSourceAfter, f1Before, graph));
  }
}

function preprocessServer(input: Extract<SelakovicPreprocessInput, { kind: "server" }>): PreprocessingIssueResult {
  const fallback = (): PreprocessingIssueResult => {
    const fb = extractFromServerFiles(input.lib_before_files, input.lib_after_files);
    return buildIssueResult(LAYOUT_KIND.SERVER, ASPECT.FALLBACK, WRAPPER_KIND.TOP_LEVEL, fb);
  };

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
  // target_side は aspect から派生 (lib→lib, workload→workload, lib+workload→both)。
  const beforeNodeCount = safeCount(input.before_test_case);
  const afterNodeCount = safeCount(input.after_test_case);
  const targetSide = aspectToServerTargetSide(aspect);
  const candidates: PreprocessingCandidate[] = [
    {
      setup: "",
      slow: buildServerRunnable(input.before_test_case),
      fast: buildServerRunnable(input.after_test_case),
      before_node_count: beforeNodeCount,
      after_node_count: afterNodeCount,
      candidate_meta: { adapter: "selakovic", target_side: targetSide, is_workload_reachable: false },
    },
  ];
  return {
    candidates,
    candidate_count: candidates.length,
    issue_meta: {
      adapter: "selakovic",
      layout: LAYOUT_KIND.SERVER,
      aspect,
      wrapper_kind: WRAPPER_KIND.TOP_LEVEL,
    },
  };
}

/** server 経路で aspect から target_side を派生する (server は常に 1 candidate)。 */
function aspectToServerTargetSide(aspect: Aspect): "lib" | "workload" | "both" {
  if (aspect === ASPECT.LIB) return TARGET_SIDE.LIB;
  if (aspect === ASPECT.WORKLOAD) return TARGET_SIDE.WORKLOAD;
  return TARGET_SIDE.BOTH;
}

/** decompose 由来の WrapperKind ("top-level" / "angular-controller-wrapper") を contract enum にマップ。 */
function mapWrapperKind(kind: DecomposeWrapperKind | undefined): WrapperKind {
  return kind === "angular-controller-wrapper"
    ? WRAPPER_KIND.ANGULAR_CONTROLLER_WRAPPER
    : WRAPPER_KIND.TOP_LEVEL;
}

/** fallback の `FallbackResult` (candidates + issue_excluded) を `PreprocessingIssueResult` にラップ。 */
function buildIssueResult(
  layout: LayoutKind,
  aspect: Aspect,
  wrapperKind: WrapperKind,
  fb: FallbackResult,
  fallbackBeforeNodeCount?: number,
  fallbackAfterNodeCount?: number,
): PreprocessingIssueResult {
  const issueMeta: SelakovicIssueMeta = {
    adapter: "selakovic",
    layout,
    aspect,
    wrapper_kind: wrapperKind,
  };
  if (fb.candidates.length === 0) {
    // issue 全体が excluded (fallback の中で全 candidate が抽出失敗)
    const result: PreprocessingIssueResult = {
      candidates: [],
      candidate_count: 0,
      issue_meta: issueMeta,
    };
    if (fb.issue_excluded !== undefined) {
      result.issue_excluded = fb.issue_excluded;
      if (fb.issue_excluded_detail !== undefined) result.issue_excluded_detail = fb.issue_excluded_detail;
    }
    return result;
  }
  // fallback 経路で候補が複数出ることもあるので、各 candidate の node count を inline 全文 (= fallback の場合は
  // before/after script 全体) のサイズで上書きしておく (= 既存挙動維持)。
  const candidates = fb.candidates.map((c) => {
    const beforeCount = fallbackBeforeNodeCount ?? fb.before_node_count ?? c.before_node_count;
    const afterCount = fallbackAfterNodeCount ?? fb.after_node_count ?? c.after_node_count;
    const updated: PreprocessingCandidate = { ...c };
    if (beforeCount !== undefined) updated.before_node_count = beforeCount;
    if (afterCount !== undefined) updated.after_node_count = afterCount;
    return updated;
  });
  return {
    candidates,
    candidate_count: candidates.length,
    issue_meta: issueMeta,
  };
}

/** lib file map から「単一の lib ソース」を取り出す。 */
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

// 判断: ai-guide/adr/0007-in-source-testing-internal-helpers.md
if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;
  // 観点: appendChangeUnitCandidates の routing (順 1-d で stmt unit を 1st-class 化したパス)。
  // preprocess() を直接呼んで、fn+stmt 混在 / stmt unreachable / 空 bindings の 3 分岐を確認する。

  const inlineCallingBothFooBar = `var f1 = function () { lib.foo(); lib.bar(); };\nvar a = execute(f1, 10);`;
  const inlineCallingFoo = `var f1 = function () { lib.foo(); };\nvar a = execute(f1, 10);`;

  const clientInput = (libBefore: string, libAfter: string, inline: string) => ({
    kind: "client" as const,
    before_inline: inline,
    after_inline: inline,
    lib_before_files: { "lib.js": libBefore },
    lib_after_files: { "lib.js": libAfter },
    lib_kind: "file" as const,
    lib_referenced_by_workload: true,
  });

  describe("appendChangeUnitCandidates routing (in-source)", () => {
    it("fn unit + stmt unit 混在 → fn は changed-fn、stmt は changed-stmt で両方候補化", () => {
      // VERSION 変更 (stmt unit) + lib.bar body 変更 (fn unit)。lib.foo は VERSION を読むので
      // VERSION reachable。lib.bar は workload が直接呼ぶので reachable。
      const libBefore = `var VERSION = '1.0';\nvar lib = {};\nlib.foo = function () { return VERSION; };\nlib.bar = function () { return 1; };`;
      const libAfter = `var VERSION = '2.0';\nvar lib = {};\nlib.foo = function () { return VERSION; };\nlib.bar = function () { return 2; };`;
      const r = preprocess(clientInput(libBefore, libAfter, inlineCallingBothFooBar));
      const real = r.candidates.filter((c) => c.candidate_excluded === undefined && c.candidate_meta.is_workload_reachable);
      // embedded #0 を除いた is_workload_reachable=true な候補が 2 件 (stmt + fn) 出る
      expect(real.length).toBe(2);
    });

    it("stmt unit が unreachable → CHANGE_NOT_EXERCISED marker", () => {
      // UNUSED は誰も読まない binding。reachability で false に落ちる。
      const libBefore = `var UNUSED = '1.0';\nvar lib = {};\nlib.foo = function () { return 'ok'; };`;
      const libAfter = `var UNUSED = '2.0';\nvar lib = {};\nlib.foo = function () { return 'ok'; };`;
      const r = preprocess(clientInput(libBefore, libAfter, inlineCallingFoo));
      expect(r.candidates.some((c) => c.candidate_excluded === SELAKOVIC_EXCLUSION_REASON.CHANGE_NOT_EXERCISED)).toBe(true);
    });

    it("名指しできない stmt (bindings=[]) → NO_FN_UNIT marker (CHANGE_NOT_EXERCISED とは区別)", () => {
      // console.log は ExpressionStatement かつ CallExpression で AssignmentExpression でない →
      // statementBindings が [] を返す。pipeline 側で先弾きされ NO_FN_UNIT に落ちる。
      const libBefore = `var lib = {};\nlib.foo = function () { return 1; };\nconsole.log('start');`;
      const libAfter = `var lib = {};\nlib.foo = function () { return 1; };\nconsole.log('end');`;
      const r = preprocess(clientInput(libBefore, libAfter, inlineCallingFoo));
      expect(r.candidates.some((c) => c.candidate_excluded === SELAKOVIC_EXCLUSION_REASON.NO_FN_UNIT)).toBe(true);
    });
  });
}
