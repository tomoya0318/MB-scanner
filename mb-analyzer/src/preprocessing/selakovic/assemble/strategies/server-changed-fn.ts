import type { Node, Statement } from "@babel/types";

import {
  classifyParamDiff,
  countNodes,
  functionBlockBody,
  hasBindingCollision,
  renameIdentifiersInStatements,
} from "../../../../ast/inspect";
import {
  SELAKOVIC_EXCLUSION_REASON,
  TARGET_SIDE,
  type PreprocessingCandidate,
} from "../../../../contracts/preprocessing-contracts";
import type { FnChangeUnit } from "../../../common/change-units";
import { replaceFunctionBodyWithObserver } from "../../../../codegen/placeholder";
import { statementsToCode } from "../../../common/setup-cleanup";
import { buildExcludedChangedFnCandidate } from "./changed-fn";

/**
 * server (CommonJS) layout の changed-fn candidate を組む (ADR-0025、placeholder substitution model)。
 *
 * client の `buildChangedFnCandidate` と同じ「変更関数 body を `$BODY$` 穴あけ → slow/fast に裸 body →
 * 観測ハーネスで戻り値を `__OBS__` に収集」モデルを、CommonJS `module.exports`/`require` 構造を保ったまま
 * server の `test_case_*.js` 経路に乗せる。違いは実行容器:
 *
 *  - **client**: lib を setup に top-level で並べ、workload (f1 body) が `lib.foo()` を直接叩く。
 *  - **server (本関数)**: lib は `module.exports` を持つ CommonJS module。setup で穴あき lib を
 *    `(function (module, exports, require) { <holed lib> })(...)` の CommonJS wrapper で評価し、その exports を
 *    `globalThis.__SUT__` に公開する。workload は `test_case` を同じ CommonJS wrapper で評価し、その中の
 *    相対 `require('./<lib>')` を `__SUT__` に差し替えて `init()/setupTest()/test()` を実行する。test() 自体は
 *    戻り値を持たないことが多い (chalk 等) が、変更関数 body に inline された観測ハーネスが各呼び出しの戻り値を
 *    `__OBS__` に push するので、workload の完了値 `JSON.stringify(__OBS__)` が positive-evidence (return_value
 *    oracle、ADR-0018) になる。
 *
 * `libAfterSrc` は単一ファイル CommonJS lib の after ソース全文 (`unit.afterFn` の span がここを指す)。
 * `testCaseSource` は after 側 `test_case_*.js` の全文 (slow/fast で共通の workload なので片側で足りる)。
 *
 * dep 解決: 穴あき lib / test_case 内の bare require (`require('ansi-styles')` 等) と、lib の相対 require は
 * ambient な jsdom executor の `require` (= `module_base_dir` 起点 + ADR-0016 lockfile-vendored fallback) が解決する。
 * 本関数が差し替えるのは test_case → lib の相対 require のみ。
 *
 * excluded marker の条件は client `buildChangedFnCandidate` と同じ (rename/削除 / non-block body / param 本質変更)。
 *
 * NOTE (Phase 1 スコープ): single-file lib (`module.exports` を持つ 1 ファイル、Chalk 形) のみ対象。
 * multi-file (named export / index 再 export / UMD) は後続 Phase で `installRequire` 経路との整合を取って一般化する。
 */
export function buildServerChangedFnCandidate(
  unit: FnChangeUnit,
  libAfterSrc: string,
  testCaseSource: string,
): PreprocessingCandidate {
  const afterFn = unit.afterFn;
  if (afterFn === null) {
    return buildExcludedChangedFnCandidate(SELAKOVIC_EXCLUSION_REASON.UNIT_RENAMED_OR_REMOVED);
  }
  const afterBody = functionBlockBody(afterFn);
  const beforeBody = functionBlockBody(unit.beforeFn);
  if (afterBody === null || beforeBody === null) {
    return buildExcludedChangedFnCandidate(SELAKOVIC_EXCLUSION_REASON.FN_NON_BLOCK_BODY);
  }
  const paramDiff = classifyParamDiff(unit.beforeFn, afterFn);
  if (paramDiff.kind === "structural-diff") {
    return buildExcludedChangedFnCandidate(SELAKOVIC_EXCLUSION_REASON.FN_PARAM_NAMES_MISMATCH);
  }
  if (
    paramDiff.kind === "rename-only" &&
    hasBindingCollision(beforeBody.body as readonly Statement[], paramDiff.nameMap)
  ) {
    return buildExcludedChangedFnCandidate(SELAKOVIC_EXCLUSION_REASON.FN_PARAM_NAMES_MISMATCH);
  }
  const beforeBodyStatements: readonly Statement[] =
    paramDiff.kind === "rename-only"
      ? renameIdentifiersInStatements(beforeBody.body as readonly Statement[], paramDiff.nameMap)
      : (beforeBody.body as readonly Statement[]);

  const holedLib = replaceFunctionBodyWithObserver(libAfterSrc, { start: afterBody.start, end: afterBody.end });
  const slow = statementsToCode(beforeBodyStatements);
  const fast = statementsToCode(afterBody.body as readonly Statement[]);

  return {
    setup: buildServerHoledLibSetup(holedLib),
    slow,
    fast,
    workload: buildServerObservedWorkload(testCaseSource),
    before_node_count: countNodes(beforeBody as unknown as Node),
    after_node_count: countNodes(afterBody as unknown as Node),
    enclosure_node_type: afterFn.type,
    candidate_meta: { adapter: "selakovic", target_side: TARGET_SIDE.LIB, is_workload_reachable: true },
  };
}

/** 穴あき CommonJS lib を `(module, exports, require)` wrapper で評価し exports を `globalThis.__SUT__` に公開する setup。 */
function buildServerHoledLibSetup(holedLib: string): string {
  return [
    "var __SUT_module__ = { exports: {} };",
    "(function (module, exports, require) {",
    holedLib,
    "})(__SUT_module__, __SUT_module__.exports, require);",
    "globalThis.__SUT__ = __SUT_module__.exports;",
  ].join("\n");
}

/**
 * test_case を CommonJS wrapper で評価し、相対 `require('./<lib>')` を `globalThis.__SUT__` (= 穴あき lib の
 * exports) に差し替えて init()/setupTest()/test() を実行する workload。完了値は `JSON.stringify(__OBS__)`。
 *
 * `__OBS__` は setup 側に inline された観測ハーネスが変更関数の戻り値を push する配列 (`declareObservationGlobal`
 * で宣言済)。先頭で `__OBS__ = []` リセットし、workload 中の呼び出し由来の観測だけを完了値に乗せる。
 *
 * single-file 前提: 相対 require (`./` / `../`) はすべて lib への参照とみなして `__SUT__` を返す。
 */
function buildServerObservedWorkload(testCaseSource: string): string {
  return [
    "(function () {",
    "__OBS__ = [];",
    "var __tc_module__ = { exports: {} };",
    "var __tc_require__ = function (spec) {",
    "  if (typeof spec === 'string' && (spec.indexOf('./') === 0 || spec.indexOf('../') === 0)) return globalThis.__SUT__;",
    "  return require(spec);",
    "};",
    "(function (module, exports, require) {",
    testCaseSource,
    "})(__tc_module__, __tc_module__.exports, __tc_require__);",
    "var __tc_exp__ = __tc_module__.exports;",
    "var __tc_i__ = (typeof __tc_exp__.init === 'function') ? __tc_exp__.init() : undefined;",
    "var __tc_s__ = (typeof __tc_exp__.setupTest === 'function') ? __tc_exp__.setupTest(__tc_i__) : undefined;",
    "if (typeof __tc_exp__.test === 'function') __tc_exp__.test(__tc_i__, __tc_s__);",
    "return JSON.stringify(__OBS__);",
    "})()",
  ].join("\n");
}

// 判断: ai-guide/adr/0007-in-source-testing-internal-helpers.md
if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;
  const { findChangeUnits } = await import("../../../common/change-units");
  const { parse } = await import("../../../../ast/parser");
  const { substituteBody, declareObservationGlobal } = await import("../../../../codegen/placeholder");
  // 観点: single-file CommonJS lib の変更関数 (named-FE 含む) を holed lib + test_case workload で 4 値契約に組む。
  // setup = CommonJS wrapper で穴あき lib を評価し __SUT__ に公開 ($BODY$ 1 個 + 観測ハーネス)。
  // slow/fast = 変更前/後 body の裸断片。workload = test_case を評価し相対 require を __SUT__ に差し替え observation を返す。
  // rename/削除・arrow body・param 本質変更は excluded marker。

  const libBefore = `var lib = module.exports;\nlib.run = function () { return wrap(function self() { return 1; }); };`;
  const libAfter = `var lib = module.exports;\nlib.run = function () { return wrap(function self() { return 2; }); };`;
  const testCase = `exports.test = function () { return require('./lib_after.js').run(); };`;

  const fnUnitFor = (before: string, after: string, name: string): FnChangeUnit => {
    const cu = findChangeUnits(before, after);
    const u = cu.units.find((x): x is FnChangeUnit => x.kind === "fn" && x.name === name);
    if (!u) throw new Error(`no fn unit named ${name}`);
    return u;
  };

  describe("buildServerChangedFnCandidate (in-source)", () => {
    it("named-FE の変更 → CommonJS wrapper の穴あき lib setup / 裸 body slow·fast / test_case workload", () => {
      const unit = fnUnitFor(libBefore, libAfter, "self");
      const c = buildServerChangedFnCandidate(unit, libAfter, testCase);

      expect(c.candidate_excluded).toBeUndefined();
      expect(c.candidate_meta.target_side).toBe(TARGET_SIDE.LIB);
      expect(c.candidate_meta.is_workload_reachable).toBe(true);
      expect(c.enclosure_node_type).toBe("FunctionExpression");

      // setup: CommonJS wrapper + 穴あき lib (観測ハーネス + $BODY$ 1 個) + __SUT__ 公開
      expect(c.setup).toContain("var __SUT_module__ = { exports: {} };");
      expect(c.setup).toContain("})(__SUT_module__, __SUT_module__.exports, require);");
      expect(c.setup).toContain("globalThis.__SUT__ = __SUT_module__.exports;");
      expect(c.setup).toContain("var lib = module.exports;");
      expect((c.setup!.match(/\$BODY\$/g) ?? []).length).toBe(1);
      expect(c.setup).toContain("let __OBS_R__");
      expect(c.setup).toContain("__OBS__.push");

      // slow/fast: 変更前/後 self body の裸断片 (観測ハーネス無し)
      expect(c.slow).toContain("return 1;");
      expect(c.slow).not.toContain("__OBS_R__");
      expect(c.fast).toContain("return 2;");

      // workload: __OBS__ reset → test_case 評価 (相対 require 差し替え) → init/setupTest/test → stringify
      expect(c.workload).toContain("__OBS__ = [];");
      expect(c.workload).toContain("return globalThis.__SUT__;");
      expect(c.workload).toContain("exports.test = function () { return require('./lib_after.js').run(); };");
      expect(c.workload).toContain("__tc_exp__.test(__tc_i__, __tc_s__)");
      expect(c.workload).toContain("return JSON.stringify(__OBS__);");

      // sandbox 投入直前形 (substituteBody(setup, slow) + __OBS__ 宣言) が valid JS
      expect(() => parse(declareObservationGlobal(substituteBody(c.setup!, c.slow!)))).not.toThrow();
      expect(() => parse(`var _ = ${c.workload!};`)).not.toThrow();
    });

    it("afterFn === null (rename / 削除) → UNIT_RENAMED_OR_REMOVED marker", () => {
      const base = fnUnitFor(libBefore, libAfter, "self");
      const renamed: FnChangeUnit = { ...base, afterFn: null, afterFnAncestors: [] };
      const c = buildServerChangedFnCandidate(renamed, libAfter, testCase);
      expect(c.candidate_excluded).toBe(SELAKOVIC_EXCLUSION_REASON.UNIT_RENAMED_OR_REMOVED);
      expect(c.setup).toBeUndefined();
    });

    it("param 個数差 (本質変更) → FN_PARAM_NAMES_MISMATCH marker", () => {
      const before = `var lib = module.exports;\nlib.run = function () { return wrap(function self(x) { return x + 1; }); };`;
      const after = `var lib = module.exports;\nlib.run = function () { return wrap(function self(x, y) { return x + y; }); };`;
      const unit = fnUnitFor(before, after, "self");
      const c = buildServerChangedFnCandidate(unit, after, testCase);
      expect(c.candidate_excluded).toBe(SELAKOVIC_EXCLUSION_REASON.FN_PARAM_NAMES_MISMATCH);
      expect(c.setup).toBeUndefined();
    });
  });
}
