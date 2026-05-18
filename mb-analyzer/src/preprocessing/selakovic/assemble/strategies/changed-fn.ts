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
  type SelakovicExclusionReason,
} from "../../../../contracts/preprocessing-contracts";
import type { FnChangeUnit } from "../../../common/change-units";
import {
  replaceFunctionBodyWithObserver,
  wrapObservedWorkload,
} from "../../../../codegen/placeholder";
import { statementsToCode } from "../../../common/setup-cleanup";
import type { F1Decomposition } from "../../decompose/f1";

/**
 * `aspect: lib` の changed-fn candidate を組む (ADR-0023 §4 値契約、placeholder substitution model)。
 * `unit` は workload が (推移的に) exercise すると判定済の fn unit (= `pipeline.ts` が `isReachedByAnyWorkload`
 * で KEEP したもの)。`libAfterSrc` は `findChangeUnits` に渡したのと同じ after lib ソース
 * (`unit.afterFn` の span がここを指す)。
 *
 * 出力する 4 値 (ADR-0023 D-δ §observation 仕様: 観測ハーネスは setup 側に inline 化):
 *  - `setup` = 穴あき lib (変更関数の body を「観測ハーネス入り `{ $BODY$ }`」で置換 =
 *    `replaceFunctionBodyWithObserver`) + preWorkload を結合した文字列。`$BODY$` を厳密に 1 個含み、
 *    equivalence-checker 側で `substituteBody(setup, slow|fast)` で差し込む。
 *  - `slow` = 変更前 body の statementsToCode 出力 (= 裸 body)。観測ハーネスは setup 側の `$BODY$` を
 *    囲う観測 IIFE が担うので、ここには載らない (= pruning が見る範囲から観測足場が消える)。
 *  - `fast` = 同じく変更後 body の裸 statementsToCode 出力。
 *  - `workload` = `wrapObservedWorkload(f1Body の statementsToCode)` (= `__OBS__ = []` 初期化 → workload 実行
 *    → `JSON.stringify(__OBS__)` を完了値で返す IIFE)。
 *
 * sandbox 投入時は equivalence-checker が `substituteBody(setup, slow)` で `$BODY$` (= 観測 IIFE 内側)
 * に裸 body を差し込み、`declareObservationGlobal` で `let __OBS__ = [];` を setup 先頭に prepend してから
 * executor へ渡す。
 *
 * adapter_meta:
 *  - target_side = lib (変更関数は lib 側、ADR-0024)
 *  - is_workload_reachable = true (workload 到達性で抽出された変更関数)
 *
 * 次のケースは `buildExcludedChangedFnCandidate(reason)` を返す (= この unit からは真の candidate を
 * 作らない、ADR-0023 D-γ §DROP 可視化で reason を残す):
 *  - `unit.afterFn === null` (rename / 削除) → `FN_RENAMED_OR_REMOVED`
 *  - `afterFn` / `beforeFn` の本体が BlockStatement でない (arrow `=> expr` 等) → `FN_NON_BLOCK_BODY`
 *  - before / after の param が本質変更 (個数差・pattern type 違い・default 付き等)、または
 *    rename-only でも rename 先名と body 内 binding が衝突 → `FN_PARAM_NAMES_MISMATCH`
 *    (rename-only かつ衝突なしのケースは body を identifier-rename して candidate 化、ADR-0023 D-γ §DROP 可視化緩和)
 *  - workload (`f1`) が top-level wrapper でない → `ANGULAR_WRAPPER_SKIP` (pipeline 側で先に弾かれる前提だが防御的に判定)
 */
export function buildChangedFnCandidate(
  unit: FnChangeUnit,
  libAfterSrc: string,
  f1Decomposition: F1Decomposition,
): PreprocessingCandidate {
  if (f1Decomposition.wrapperKind !== "top-level") {
    return buildExcludedChangedFnCandidate(SELAKOVIC_EXCLUSION_REASON.ANGULAR_WRAPPER_SKIP);
  }
  const afterFn = unit.afterFn;
  if (afterFn === null) {
    return buildExcludedChangedFnCandidate(SELAKOVIC_EXCLUSION_REASON.FN_RENAMED_OR_REMOVED);
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
  // rename-only は before body の Identifier を after の param 名に rewrite して candidate 化 (semantic 等価、ADR-0023 D-γ §DROP 可視化緩和)。
  const beforeBodyStatements: readonly Statement[] =
    paramDiff.kind === "rename-only"
      ? renameIdentifiersInStatements(beforeBody.body as readonly Statement[], paramDiff.nameMap)
      : (beforeBody.body as readonly Statement[]);

  const holedLib = replaceFunctionBodyWithObserver(libAfterSrc, { start: afterBody.start, end: afterBody.end });
  const preWorkload = statementsToCode([...f1Decomposition.preWorkloadStatements]);
  const setup = [holedLib, preWorkload].filter((s) => s.length > 0).join("\n;\n");
  const slow = statementsToCode(beforeBodyStatements);
  const fast = statementsToCode(afterBody.body as readonly Statement[]);
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
 * changed-fn 経路の excluded marker (ADR-0022 §計装 / ADR-0024 §candidate_excluded / ADR-0023 D-γ §DROP 可視化)。
 * setup/slow/fast を持たず、`candidate_excluded` に reason を立てた candidate を返す。痕跡が extracted.jsonl に
 * 残り、`funnel.py` / `inspect_candidates.py` で reason 別件数を集計できる。
 * `is_workload_reachable` は excluded marker では常に `false` で固定 — `CHANGE_NOT_EXERCISED` 以外の reason
 * (例: `FN_RENAMED_OR_REMOVED`) では本来 workload 到達済の unit を含むが、「真の candidate のみ true」と
 * いう規約で `build_equiv_input.py:is_small_candidate` / 集計ロジックを単純化するための便宜的扱い。
 * reason 別の意味は `candidate_excluded` 自体を参照すること。
 */
export function buildExcludedChangedFnCandidate(
  reason: SelakovicExclusionReason,
): PreprocessingCandidate {
  return {
    candidate_excluded: reason,
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
  const { findChangeUnits } = await import("../../../common/change-units");
  const { extractF1 } = await import("../../decompose/f1");
  const { parse } = await import("../../../../ast/parser");
  const { substituteBody } = await import("../../../../codegen/placeholder");
  // 観点: workload が呼ぶ変更関数の fn unit から changed-fn candidate を組む (placeholder substitution model)。
  // ADR-0023 D-δ §observation 仕様: 観測ハーネスは setup 側の関数本体に inline 化、slow/fast は裸 body。
  // setup に lib 全文 (変更関数の body を「観測ハーネス入り $BODY$」で穴あき)、slow/fast に変更前/後 body を
  // statementsToCode した裸断片、workload に f1 body を IIFE で包んだ完了値返却形式。
  // param 不一致 / arrow body / angular wrapper は excluded marker (ADR-0023 D-γ §DROP 可視化)。

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
    it("workload が呼ぶ変更関数 → setup に観測ハーネス + $BODY$ 1 個入り穴あき lib / slow・fast は裸 body / workload に IIFE", () => {
      const f1d = extractF1(inline)!;
      const unit = fnUnitFor(libBefore, libAfter);
      const r = buildChangedFnCandidate(unit, libAfter, f1d);
      expect(r.candidate_excluded).toBeUndefined();
      expect(r.candidate_meta.target_side).toBe(TARGET_SIDE.LIB);
      expect(r.candidate_meta.is_workload_reachable).toBe(true);
      expect(r.enclosure_node_type).toBe("FunctionExpression"); // lib.norm = function(){...}

      // setup: lib 全文 (norm body の位置に観測ハーネス + $BODY$ 1 個入り) + preWorkload
      expect(r.setup).toContain("var slice = [].slice;");
      expect(r.setup).toContain("var lib = {};");
      expect(r.setup).toContain("$BODY$");
      // $BODY$ は厳密に 1 個 (= 観測 IIFE 内側のみ、外側は埋まる)
      expect((r.setup!.match(/\$BODY\$/g) ?? []).length).toBe(1);
      // 観測ハーネスが setup 側に inline 化されている (ADR-0023 D-δ)
      expect(r.setup).toContain("let __OBS_R__");
      expect(r.setup).toContain("__OBS__.push");
      expect(r.setup).toContain("return __OBS_R__;");
      // 単独参照 (globalThis. プレフィックス無し)
      expect(r.setup).not.toContain("globalThis.__OBS");
      // v1 残骸 (__HOLE__ ガード / after 本体インライン) が消えている
      expect(r.setup).not.toContain("globalThis.__HOLE__");
      expect(r.setup).not.toContain("& 1 === 0");

      // slow: 変更前 body (% 2 === 0) の裸 statement 列 (= 観測ハーネス無し)
      expect(r.slow).toContain("% 2 === 0");
      expect(r.slow).not.toContain("__OBS_R__"); // 観測ハーネスは setup 側に移動
      expect(r.slow).not.toContain("__OBS__.push");
      // body 断片なので lib 宣言 / workload 呼び出しは含まれない
      expect(r.slow).not.toContain("var lib = {};");
      expect(r.slow).not.toContain("lib.norm(7);");

      // fast: 変更後 body (& 1 === 0) の裸 statement 列
      expect(r.fast).toContain("& 1 === 0");
      expect(r.fast).not.toContain("__OBS_R__");
      expect(r.fast).not.toContain("__OBS__.push");

      // workload: __OBS__ = [] 初期化 → workload → JSON.stringify(__OBS__)
      expect(r.workload).toContain("__OBS__ = [];");
      expect(r.workload).toContain("lib.norm(7);");
      expect(r.workload).toContain("lib.norm(8);");
      expect(r.workload).toContain("return JSON.stringify(__OBS__);");
      expect(r.workload).not.toContain("globalThis.__OBS");

      // node count は変更関数本体のサイズ (小さい)
      expect(r.before_node_count).toBeGreaterThan(0);
      expect(r.before_node_count).toBeLessThan(100);

      // sandbox 投入直前形 (= substituteBody(setup, slow) で観測 IIFE 内側に裸 body を差し込んだ形) が valid JS
      const substituted = substituteBody(r.setup!, r.slow!);
      expect(() => parse(substituted)).not.toThrow();
      // workload は単独で式として valid
      expect(() => parse(`var _ = ${r.workload!};`)).not.toThrow();
    });

    it("before / after で param 名のみ差 (rename-only) → before body を rename して candidate 化 (ADR-0023 D-γ 緩和)", () => {
      const f1d = extractF1(inline)!;
      const before = `var lib = {};\nlib.norm = function (x) { return x % 2 === 0; };`;
      const after = `var lib = {};\nlib.norm = function (y) { return y % 2 === 0; };`;
      const unit = fnUnitFor(before, after);
      const r = buildChangedFnCandidate(unit, after, f1d);
      expect(r.candidate_excluded).toBeUndefined();
      // slow には after の param 名 y で書き換えられた body が入り、旧 param 名 x は残らない
      expect(r.slow).toContain("y % 2 === 0");
      expect(r.slow).not.toMatch(/\bx\b/);
      // fast は after body そのまま
      expect(r.fast).toContain("y % 2 === 0");
      // setup の $BODY$ は 1 個、substituteBody 後も valid JS
      expect((r.setup!.match(/\$BODY\$/g) ?? []).length).toBe(1);
      expect(() => parse(substituteBody(r.setup!, r.slow!))).not.toThrow();
    });

    it("param 個数差 (本質変更) → FN_PARAM_NAMES_MISMATCH marker", () => {
      const f1d = extractF1(inline)!;
      const before = `var lib = {};\nlib.norm = function (x) { return x % 2 === 0; };`;
      const after = `var lib = {};\nlib.norm = function (x, scale) { return (x * scale) % 2 === 0; };`;
      const unit = fnUnitFor(before, after);
      const r = buildChangedFnCandidate(unit, after, f1d);
      expect(r.candidate_excluded).toBe(SELAKOVIC_EXCLUSION_REASON.FN_PARAM_NAMES_MISMATCH);
      expect(r.setup).toBeUndefined();
    });

    it("rename 先名が body 内 binding と衝突 → collision guard で FN_PARAM_NAMES_MISMATCH marker", () => {
      const f1d = extractF1(inline)!;
      // before fn body 内に const y がある状態で param x → y rewrite すると semantic 衝突
      const before = `var lib = {};\nlib.norm = function (x) { var y = 2; return x % y === 0; };`;
      const after = `var lib = {};\nlib.norm = function (y) { var y = 2; return y % y === 0; };`;
      const unit = fnUnitFor(before, after);
      const r = buildChangedFnCandidate(unit, after, f1d);
      expect(r.candidate_excluded).toBe(SELAKOVIC_EXCLUSION_REASON.FN_PARAM_NAMES_MISMATCH);
      expect(r.setup).toBeUndefined();
    });

    it("AssignmentPattern (default 付き param) は名前が同じでも structural-diff 扱いで marker (default 内 rewrite 回避)", () => {
      const f1d = extractF1(inline)!;
      // body にも diff を入れて findChangeUnits が fn unit として捉えるようにする
      const before = `var lib = {};\nlib.norm = function (x) { return x % 2 === 0; };`;
      const after = `var lib = {};\nlib.norm = function (x = 0) { return (x + 1) % 2 === 0; };`;
      const unit = fnUnitFor(before, after);
      const r = buildChangedFnCandidate(unit, after, f1d);
      expect(r.candidate_excluded).toBe(SELAKOVIC_EXCLUSION_REASON.FN_PARAM_NAMES_MISMATCH);
      expect(r.setup).toBeUndefined();
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
      const c = buildChangedFnCandidate(unit, libAfterWithComments, f1d);
      expect(c.candidate_excluded).toBeUndefined();
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

    it("buildExcludedChangedFnCandidate: reason 引数を candidate_excluded に伝搬 (setup/slow/fast/workload は undefined)", () => {
      const c = buildExcludedChangedFnCandidate(SELAKOVIC_EXCLUSION_REASON.CHANGE_NOT_EXERCISED);
      expect(c.candidate_excluded).toBe(SELAKOVIC_EXCLUSION_REASON.CHANGE_NOT_EXERCISED);
      expect(c.candidate_meta.adapter).toBe("selakovic");
      expect(c.candidate_meta.target_side).toBe(TARGET_SIDE.LIB);
      expect(c.candidate_meta.is_workload_reachable).toBe(false);
      expect(c.setup).toBeUndefined();
      expect(c.slow).toBeUndefined();
      expect(c.fast).toBeUndefined();
      expect(c.workload).toBeUndefined();
      expect(c.before_node_count).toBeUndefined();
      expect(c.after_node_count).toBeUndefined();

      // 別 reason も同形 (ADR-0023 D-γ §DROP 可視化、reason を変えても shape 不変)
      const c2 = buildExcludedChangedFnCandidate(SELAKOVIC_EXCLUSION_REASON.FN_PARAM_NAMES_MISMATCH);
      expect(c2.candidate_excluded).toBe(SELAKOVIC_EXCLUSION_REASON.FN_PARAM_NAMES_MISMATCH);
      expect(c2.setup).toBeUndefined();
    });

    it("afterFn === null (rename / 削除) → FN_RENAMED_OR_REMOVED marker", () => {
      const f1d = extractF1(inline)!;
      const baseUnit = fnUnitFor(libBefore, libAfter);
      const renamedUnit: FnChangeUnit = { ...baseUnit, afterFn: null, afterFnAncestors: [] };
      const r = buildChangedFnCandidate(renamedUnit, libAfter, f1d);
      expect(r.candidate_excluded).toBe(SELAKOVIC_EXCLUSION_REASON.FN_RENAMED_OR_REMOVED);
      expect(r.setup).toBeUndefined();
    });

    it("arrow body (=> expr) → FN_NON_BLOCK_BODY marker", () => {
      const f1d = extractF1(inline)!;
      const baseUnit = fnUnitFor(libBefore, libAfter);
      // ArrowFunctionExpression body=Expression (BlockStatement でない) の after を組む
      const arrowAst = parse("(x => x * 2);");
      const exprStmt = arrowAst.program.body[0] as { expression: Node };
      const arrowFn = exprStmt.expression;
      const arrowUnit: FnChangeUnit = { ...baseUnit, afterFn: arrowFn };
      const r = buildChangedFnCandidate(arrowUnit, libAfter, f1d);
      expect(r.candidate_excluded).toBe(SELAKOVIC_EXCLUSION_REASON.FN_NON_BLOCK_BODY);
      expect(r.setup).toBeUndefined();
    });

    it("angular controller wrapper の f1 → ANGULAR_WRAPPER_SKIP marker (D-β では top-level のみ)", () => {
      const angularInline = `
        var app = angular.module("benchApp", []);
        app.controller("BenchCtrl", function ($scope) { lib.norm(1); });
      `;
      const f1d = extractF1(angularInline);
      if (f1d && f1d.wrapperKind !== "top-level") {
        const unit = fnUnitFor(libBefore, libAfter);
        const r = buildChangedFnCandidate(unit, libAfter, f1d);
        expect(r.candidate_excluded).toBe(SELAKOVIC_EXCLUSION_REASON.ANGULAR_WRAPPER_SKIP);
      }
    });
  });
}
