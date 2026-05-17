import type { Node, Statement } from "@babel/types";

import {
  TARGET_SIDE,
  type PreprocessingCandidate,
} from "../../../contracts/preprocessing-contracts";
import type { FnChangeUnit } from "../../common/change-units";
import {
  buildHoleFunction,
  countSubtreeNodes,
  functionBlockBody,
  holeLibSource,
  paramNames,
  pickLiftedDeps,
  wrapWorkloadObserved,
} from "../../common/function-hole";
import { statementsToCode } from "../../common/setup-cleanup";
import type { F1Decomposition } from "../decompose/f1";

/**
 * `aspect: lib` の changed-fn candidate を組む (plan §D1 / spike v2)。`unit` は workload が (推移的に) exercise
 * すると判定済の fn unit (= `pipeline.ts` が `isReachedByAnyWorkload` で KEEP したもの)。`libAfterSrc` は
 * `findChangeUnits` に渡したのと同じ after lib ソース (`unit.afterFn` の span がここを指す)。
 *
 * 構造:
 *  - `setup` = lib (after、変更関数の body だけ穴あき + ガード + after 本体インライン fallback) + preWorkload
 *  - `slow` = `globalThis.__HOLE__ = function(<liftDeps>, <fnParams>){…変更前の本体…+ 戻り値を __OBS に記録}` + workload
 *  - `fast` = 同じく `__HOLE__` に変更後の本体 + 観測する形の workload
 *  - pruning が削る対象は `slow` (= 変更関数本体 + workload) の AST、`setup` (= lib 全文 + dep) は不変
 *
 * adapter_meta:
 *  - target_side = lib (変更関数は lib 側、ADR-0024)
 *  - is_workload_reachable = true (workload 到達性で抽出された変更関数)
 *
 * 次のケースは `null` を返す (= この unit からは candidate を作らない、embedded `#0` がカバー):
 *  - `unit.afterFn === null` (rename / 削除)
 *  - `afterFn` / `beforeFn` の本体が BlockStatement でない (arrow `=> expr` 等)
 *  - before / after の param 名リストが一致しない
 *  - workload (`f1`) が top-level wrapper でない (Angular controller wrapper は v1 では skip)
 */
export function buildChangedFnCandidate(
  unit: FnChangeUnit,
  libAfterSrc: string,
  f1Decomposition: F1Decomposition,
): PreprocessingCandidate | null {
  if (f1Decomposition.wrapperKind !== "top-level") return null;
  const afterFn = unit.afterFn;
  if (afterFn === null) return null;
  const afterBody = functionBlockBody(afterFn);
  const beforeBody = functionBlockBody(unit.beforeFn);
  if (afterBody === null || beforeBody === null) return null;
  const aParams = paramNames(afterFn);
  if (aParams.join(",") !== paramNames(unit.beforeFn).join(",")) return null;

  const liftDeps = pickLiftedDeps(unit.beforeFn, afterFn, unit.afterFnAncestors);
  const holeParams = [...liftDeps, ...aParams];

  const holedLib = holeLibSource(libAfterSrc, afterBody, liftDeps, aParams);
  const preWorkload = statementsToCode([...f1Decomposition.preWorkloadStatements]);
  const workload = wrapWorkloadObserved(statementsToCode([...f1Decomposition.f1Body.body]));

  return {
    setup: [holedLib, preWorkload].filter((s) => s.length > 0).join("\n;\n"),
    slow: `globalThis.__HOLE__ = ${buildHoleFunction(holeParams, statementsToCode(beforeBody.body as readonly Statement[]))};\n;\n${workload}`,
    fast: `globalThis.__HOLE__ = ${buildHoleFunction(holeParams, statementsToCode(afterBody.body as readonly Statement[]))};\n;\n${workload}`,
    enclosure_node_type: afterFn.type,
    // node count は「pruning が削る対象 = 変更関数の本体」のサイズ (inline 全文サイズ ≠ embedded の値)。
    before_node_count: countSubtreeNodes(beforeBody as unknown as Node),
    after_node_count: countSubtreeNodes(afterBody as unknown as Node),
    candidate_meta: { adapter: "selakovic", target_side: TARGET_SIDE.LIB, is_workload_reachable: true },
  };
}

// 判断: ai-guide/adr/0007-in-source-testing-internal-helpers.md
if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;
  const { findChangeUnits } = await import("../../common/change-units");
  const { extractF1 } = await import("../decompose/f1");
  const { parse } = await import("../../../ast/parser");
  // 観点: workload が呼ぶ変更関数の fn unit から changed-fn candidate を組む。setup に lib 全文 (変更関数だけ穴あき)、
  // slow/fast に __HOLE__ (変更前/後の本体) + 観測ラッパ + workload。lib 内部依存は lambda-lift で引数化。
  // param 不一致 / arrow body / angular wrapper は null。

  const inline = `var f1 = function () { lib.norm(7); lib.norm(8); };\nvar a = execute(f1, 10);`;
  const libBefore = `var slice = [].slice;\nvar lib = {};\nlib.norm = function (x) { return slice.call([x]).length % 2 === 0; };`;
  const libAfter = `var slice = [].slice;\nvar lib = {};\nlib.norm = function (x) { return slice.call([x]).length & 1 === 0; };`;

  const fnUnitFor = (before: string, after: string): FnChangeUnit => {
    const cu = findChangeUnits(before, after);
    const u = cu.units.find((x): x is FnChangeUnit => x.kind === "fn");
    if (!u) throw new Error("no fn unit");
    return u;
  };

  describe("buildChangedFnCandidate (in-source)", () => {
    it("workload が呼ぶ変更関数 → setup に穴あき lib / slow・fast に __HOLE__ + 観測 + workload、内部依存は lift", () => {
      const f1d = extractF1(inline)!;
      const unit = fnUnitFor(libBefore, libAfter);
      const c = buildChangedFnCandidate(unit, libAfter, f1d);
      expect(c).not.toBeNull();
      const r = c!;
      expect(r.candidate_meta.target_side).toBe(TARGET_SIDE.LIB);
      expect(r.candidate_meta.is_workload_reachable).toBe(true);
      expect(r.enclosure_node_type).toBe("FunctionExpression"); // lib.norm = function(){...}
      // setup: lib 全文 (norm だけ穴あき) + preWorkload
      expect(r.setup).toContain("var slice = [].slice;");
      expect(r.setup).toContain("var lib = {};");
      expect(r.setup).toContain("globalThis.__HOLE__.call(this, slice, x)");
      expect(r.setup).toContain("& 1 === 0");
      // slow: __HOLE__ = 変更前の本体 (% 2 === 0) + 観測ラッパ + workload
      expect(r.slow).toContain("function (slice, x)");
      expect(r.slow).toContain("% 2 === 0");
      expect(r.slow).toContain("globalThis.__OBS");
      expect(r.slow).toContain("lib.norm(7);");
      expect(r.slow).not.toContain("var lib = {};");
      // fast: __HOLE__ = 変更後の本体 (& 1 === 0)
      expect(r.fast).toContain("& 1 === 0");
      expect(r.fast).toContain("lib.norm(7);");
      // node count は変更関数本体のサイズ (小さい)
      expect(r.before_node_count).toBeGreaterThan(0);
      expect(r.before_node_count).toBeLessThan(100);
      // parse できる
      expect(() => parse(r.setup!)).not.toThrow();
      expect(() => parse(r.slow!)).not.toThrow();
      expect(() => parse(r.fast!)).not.toThrow();
    });

    it("before / after の param 名が違う → null (spike の簡略化)", () => {
      const f1d = extractF1(inline)!;
      const before = `var lib = {};\nlib.norm = function (x) { return x % 2 === 0; };`;
      const after = `var lib = {};\nlib.norm = function (y) { return y & 1 === 0; };`;
      const unit = fnUnitFor(before, after);
      expect(buildChangedFnCandidate(unit, after, f1d)).toBeNull();
    });

    it("変更関数本体の leading / trailing コメントは slow/fast から落ちる", () => {
      const libBeforeWithComments = `
var lib = {};
lib.norm = function (x) {
  // before: ascii-rule comment
  /* leading block */
  return x % 2 === 0; // trailing line
};
`;
      const libAfterWithComments = `
var lib = {};
lib.norm = function (x) {
  // after: bit-shift comment
  return (x & 1) === 0;
};
`;
      const f1d = extractF1(inline)!;
      const unit = fnUnitFor(libBeforeWithComments, libAfterWithComments);
      const c = buildChangedFnCandidate(unit, libAfterWithComments, f1d)!;
      expect(c).not.toBeNull();
      expect(c.slow).not.toContain("before: ascii-rule");
      expect(c.slow).not.toContain("trailing line");
      expect(c.slow).not.toContain("/*");
      expect(c.fast).not.toContain("after: bit-shift");
      expect(c.setup).toContain("after: bit-shift");
    });

    it("angular controller wrapper の f1 → null (v1 では embedded のみ)", () => {
      const angularInline = `
        var app = angular.module("benchApp", []);
        app.controller("BenchCtrl", function ($scope) { lib.norm(1); });
      `;
      const f1d = extractF1(angularInline);
      if (f1d && f1d.wrapperKind !== "top-level") {
        const unit = fnUnitFor(libBefore, libAfter);
        expect(buildChangedFnCandidate(unit, libAfter, f1d)).toBeNull();
      }
    });
  });
}
