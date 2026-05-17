import type { Node, Statement } from "@babel/types";

import { countNodes, functionBlockBody, paramNames } from "../../../ast/inspect";
import {
  SELAKOVIC_EXCLUSION_REASON,
  TARGET_SIDE,
  type PreprocessingCandidate,
} from "../../../contracts/preprocessing-contracts";
import type { FnChangeUnit } from "../../common/change-units";
import {
  replaceFunctionBody,
  wrapBodyObserved,
  wrapObservedWorkload,
} from "../../common/placeholder";
import { statementsToCode } from "../../common/setup-cleanup";
import type { F1Decomposition } from "../decompose/f1";

/**
 * `aspect: lib` の changed-fn candidate を組む (ADR-0023 §4 値契約、placeholder substitution model)。
 * `unit` は workload が (推移的に) exercise すると判定済の fn unit (= `pipeline.ts` が `isReachedByAnyWorkload`
 * で KEEP したもの)。`libAfterSrc` は `findChangeUnits` に渡したのと同じ after lib ソース
 * (`unit.afterFn` の span がここを指す)。
 *
 * 出力する 4 値:
 *  - `setup` = 穴あき lib (変更関数の body を `{ $BODY$ }` プレースホルダで置換) + preWorkload を結合した文字列。
 *    `$BODY$` を厳密に 1 個含み、equivalence-checker 側で `substituteBody(setup, slow|fast)` で差し込む。
 *  - `slow` = `wrapBodyObserved(変更前 body の statementsToCode)` (= 戻り値を `__OBS__` に push して返す形)。
 *    関数本体に差し込まれることが前提の statement 列で、単独では top-level program として動かない。
 *  - `fast` = 同じく変更後 body 版。
 *  - `workload` = `wrapObservedWorkload(f1Body の statementsToCode)` (= `__OBS__ = []` 初期化 → workload 実行
 *    → `JSON.stringify(__OBS__)` を完了値で返す IIFE)。
 *
 * sandbox 投入時は equivalence-checker が `let __OBS__ = [];` を setup 先頭に prepend
 * (`declareObservationGlobal`) し、`substituteBody(setup, slow)` で `$BODY$` を差し替えてから executor へ渡す。
 *
 * adapter_meta:
 *  - target_side = lib (変更関数は lib 側、ADR-0024)
 *  - is_workload_reachable = true (workload 到達性で抽出された変更関数)
 *
 * 次のケースは `null` を返す (= この unit からは candidate を作らない、embedded `#0` がカバー):
 *  - `unit.afterFn === null` (rename / 削除)
 *  - `afterFn` / `beforeFn` の本体が BlockStatement でない (arrow `=> expr` 等)
 *  - before / after の param 名リストが一致しない (D-γ で緩和検討)
 *  - workload (`f1`) が top-level wrapper でない (Angular controller wrapper は D-β では skip)
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

  const holedLib = replaceFunctionBody(libAfterSrc, { start: afterBody.start, end: afterBody.end });
  const preWorkload = statementsToCode([...f1Decomposition.preWorkloadStatements]);
  const setup = [holedLib, preWorkload].filter((s) => s.length > 0).join("\n;\n");
  const slow = wrapBodyObserved(statementsToCode(beforeBody.body as readonly Statement[]));
  const fast = wrapBodyObserved(statementsToCode(afterBody.body as readonly Statement[]));
  const workload = wrapObservedWorkload(statementsToCode([...f1Decomposition.f1Body.body]));

  return {
    setup,
    slow,
    fast,
    workload,
    enclosure_node_type: afterFn.type,
    // node count は「pruning が削る対象 = 変更関数の本体」のサイズ (inline 全文サイズ ≠ embedded の値)。
    before_node_count: countNodes(beforeBody as unknown as Node),
    after_node_count: countNodes(afterBody as unknown as Node),
    candidate_meta: { adapter: "selakovic", target_side: TARGET_SIDE.LIB, is_workload_reachable: true },
  };
}

/**
 * workload-unreachable な fn unit を表す excluded marker (ADR-0022 §計装 / ADR-0024 §candidate_excluded)。
 * setup/slow/fast を持たず、`candidate_excluded` のみ立てた candidate を返す。痕跡が extracted.jsonl に残り、
 * `inspect_candidates.py` で「lib に変更があったが workload が呼ばなかった関数」の件数を集計できる。
 */
export function buildExcludedChangedFnCandidate(): PreprocessingCandidate {
  return {
    candidate_excluded: SELAKOVIC_EXCLUSION_REASON.CHANGE_NOT_EXERCISED,
    candidate_meta: {
      adapter: "selakovic",
      target_side: TARGET_SIDE.LIB,
      is_workload_reachable: false,
    },
  };
}

// 判断: ai-guide/adr/0007-in-source-testing-internal-helpers.md
if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;
  const { findChangeUnits } = await import("../../common/change-units");
  const { extractF1 } = await import("../decompose/f1");
  const { parse } = await import("../../../ast/parser");
  const { substituteBody } = await import("../../common/placeholder");
  // 観点: workload が呼ぶ変更関数の fn unit から changed-fn candidate を組む (placeholder substitution model)。
  // setup に lib 全文 (変更関数の body を $BODY$ 1 個で穴あき)、slow/fast に変更前/後 body を観測ラッパで包んだ
  // statement 列の断片、workload に f1 body を IIFE で包んだ完了値返却形式。
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
    it("workload が呼ぶ変更関数 → setup に $BODY$ 1 個入り穴あき lib / slow・fast に観測ラッパ / workload に IIFE", () => {
      const f1d = extractF1(inline)!;
      const unit = fnUnitFor(libBefore, libAfter);
      const c = buildChangedFnCandidate(unit, libAfter, f1d);
      expect(c).not.toBeNull();
      const r = c!;
      expect(r.candidate_meta.target_side).toBe(TARGET_SIDE.LIB);
      expect(r.candidate_meta.is_workload_reachable).toBe(true);
      expect(r.enclosure_node_type).toBe("FunctionExpression"); // lib.norm = function(){...}

      // setup: lib 全文 (norm body のみ $BODY$ 1 個で穴あき) + preWorkload
      expect(r.setup).toContain("var slice = [].slice;");
      expect(r.setup).toContain("var lib = {};");
      expect(r.setup).toContain("$BODY$");
      // $BODY$ は厳密に 1 個
      expect((r.setup!.match(/\$BODY\$/g) ?? []).length).toBe(1);
      // v1 残骸 (__HOLE__ ガード / after 本体インライン) が消えている
      expect(r.setup).not.toContain("globalThis.__HOLE__");
      expect(r.setup).not.toContain("& 1 === 0");

      // slow: 変更前 body (% 2 === 0) を __OBS__ に push して返す形
      expect(r.slow).toContain("% 2 === 0");
      expect(r.slow).toContain("let __OBS_R__");
      expect(r.slow).toContain("__OBS__.push");
      // 単独参照 (globalThis. プレフィックス無し)
      expect(r.slow).not.toContain("globalThis.__OBS");
      // body 断片なので lib 宣言 / workload 呼び出しは含まれない
      expect(r.slow).not.toContain("var lib = {};");
      expect(r.slow).not.toContain("lib.norm(7);");

      // fast: 変更後 body (& 1 === 0)
      expect(r.fast).toContain("& 1 === 0");
      expect(r.fast).toContain("let __OBS_R__");

      // workload: __OBS__ = [] 初期化 → workload → JSON.stringify(__OBS__)
      expect(r.workload).toContain("__OBS__ = [];");
      expect(r.workload).toContain("lib.norm(7);");
      expect(r.workload).toContain("lib.norm(8);");
      expect(r.workload).toContain("return JSON.stringify(__OBS__);");
      expect(r.workload).not.toContain("globalThis.__OBS");

      // node count は変更関数本体のサイズ (小さい)
      expect(r.before_node_count).toBeGreaterThan(0);
      expect(r.before_node_count).toBeLessThan(100);

      // sandbox 投入直前形 (= substituteBody(setup, slow) を関数本体内に差し込んだ形) が valid JS
      const substituted = substituteBody(r.setup!, r.slow!);
      expect(() => parse(substituted)).not.toThrow();
      // workload は単独で式として valid
      expect(() => parse(`var _ = ${r.workload!};`)).not.toThrow();
    });

    it("before / after の param 名が違う → null (D-γ で緩和検討)", () => {
      const f1d = extractF1(inline)!;
      const before = `var lib = {};\nlib.norm = function (x) { return x % 2 === 0; };`;
      const after = `var lib = {};\nlib.norm = function (y) { return y & 1 === 0; };`;
      const unit = fnUnitFor(before, after);
      expect(buildChangedFnCandidate(unit, after, f1d)).toBeNull();
    });

    it("変更関数本体の leading / trailing コメントは slow/fast から落ちる ($BODY$ には setup 側の文字列が残る)", () => {
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
      // slow / fast は statementsToCode (comments:false) なので元コメントは落ちる
      expect(c.slow).not.toContain("before: ascii-rule");
      expect(c.slow).not.toContain("trailing line");
      expect(c.slow).not.toContain("/*");
      expect(c.fast).not.toContain("after: bit-shift");
      // setup には after lib ソース原文がそのまま残っている (= replaceFunctionBody は body span 外を保持)
      // ただし body 内のコメント (after: bit-shift) は body 内なので $BODY$ に置換されて消える
      expect(c.setup).toContain("$BODY$");
      expect(c.setup).not.toContain("after: bit-shift");
    });

    it("buildExcludedChangedFnCandidate: candidate_excluded のみ立つ marker (setup/slow/fast/workload は undefined)", () => {
      const c = buildExcludedChangedFnCandidate();
      expect(c.candidate_excluded).toBe("change-not-exercised");
      expect(c.candidate_meta.adapter).toBe("selakovic");
      expect(c.candidate_meta.target_side).toBe(TARGET_SIDE.LIB);
      expect(c.candidate_meta.is_workload_reachable).toBe(false);
      expect(c.setup).toBeUndefined();
      expect(c.slow).toBeUndefined();
      expect(c.fast).toBeUndefined();
      expect(c.workload).toBeUndefined();
      expect(c.before_node_count).toBeUndefined();
      expect(c.after_node_count).toBeUndefined();
    });

    it("angular controller wrapper の f1 → null (D-β では top-level のみ)", () => {
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
