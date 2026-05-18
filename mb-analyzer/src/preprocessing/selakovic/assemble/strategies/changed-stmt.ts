import type { File, Node, Statement } from "@babel/types";

import { countNodes } from "../../../../ast/inspect";
import { parse } from "../../../../ast/parser";
import { walkNodes } from "../../../../ast/walk";
import { wrapObservedWorkload } from "../../../../codegen/placeholder";
import {
  SELAKOVIC_EXCLUSION_REASON,
  TARGET_SIDE,
  type PreprocessingCandidate,
  type SelakovicExclusionReason,
} from "../../../../contracts/preprocessing-contracts";
import { statementBindings, type StmtChangeUnit } from "../../../common/change-units";
import { statementToCode, statementsToCode } from "../../../common/setup-cleanup";
import type { F1Decomposition } from "../../decompose/f1";

/**
 * stmt unit (= モジュール本体 / 匿名 IIFE 本体直下の変更、`var VERSION = '...'` / `Ember.X = ...;` 等)
 * を 1st-class candidate に格上げする strategy (順 1-d、no-fn-unit rescue、ADR-0023 §observation 仕様 の
 * workload-driven 退化形)。`changed-fn.ts` の stmt 版で、ファイル配置を `changed-fn` と対称にしている。
 *
 *  - `lib_after` 内の対応 stmt span を `$BODY$` で hole 置換 → setup に preWorkload を連結
 *  - slow/fast は before/after stmt の `statementToCode` 出力 (= 観測 hook 無しの裸 stmt)
 *  - workload = `wrapObservedWorkload(f1Body)` (= changed-fn と同形、observation は workload 側のみ)
 *  - adapter_meta: target_side=lib / is_workload_reachable=true
 *
 * **観測モデルの退化**: slow/fast が関数本体ではないので observer hook を inline 化できない (changed-fn の
 * `replaceFunctionBodyWithObserver` 相当のヘルパが stmt には適用できない)。代わりに reachability で
 * 「変更 stmt の binding を読む reachable な named fn がある」と判定した上で workload が見せる差分を観測する
 * (= workload-driven only)。「変更が workload に伝播しないなら equal verdict になる」のは正しい結果。
 *
 * 関連: fallback 経路 (`fallback.ts:extractFromScripts/extractFromServerFiles`) は f1 / test が規約外の
 * issue 用安全弁で、target_side=both / is_workload_reachable=false の degenerate 経路。本 strategy は
 * f1 が抽出済の前提で workload-reachability の判定込みで 1st-class candidate を組む。
 */

const STMT_BODY_PLACEHOLDER = "$BODY$";

/**
 * 前提 (呼び出し側 = `pipeline.ts:appendChangeUnitCandidates` で保証):
 *  - `f1Decomposition.wrapperKind === "top-level"` (angular wrapper は pipeline 側で先弾き)
 *  - `unit.bindings.length > 0` (空 bindings は pipeline 側で `NO_FN_UNIT` 先弾き)
 *
 * excluded marker を返すケース:
 *  - after-AST に対応 stmt 無し (削除 / rename) → `FN_RENAMED_OR_REMOVED`
 *    (reason 名は fn 由来だが「after に対応するものが無い」の意味で stmt 側にも再利用、改名は別 PR)
 */
export function buildChangedStmtCandidate(
  unit: StmtChangeUnit,
  _libBeforeSrc: string,
  libAfterSrc: string,
  f1Decomposition: F1Decomposition,
): PreprocessingCandidate {
  const afterStmt = findAfterStmtByBindings(libAfterSrc, unit.bindings);
  if (afterStmt === null) {
    return buildExcludedChangedStmtCandidate(SELAKOVIC_EXCLUSION_REASON.FN_RENAMED_OR_REMOVED);
  }
  const span = nodeSpan(afterStmt);
  if (span === null) {
    return buildExcludedChangedStmtCandidate(SELAKOVIC_EXCLUSION_REASON.FN_RENAMED_OR_REMOVED);
  }

  const holedLib = libAfterSrc.slice(0, span.start) + STMT_BODY_PLACEHOLDER + libAfterSrc.slice(span.end);
  const preWorkload = statementsToCode([...f1Decomposition.preWorkloadStatements]);
  const setup = [holedLib, preWorkload].filter((s) => s.length > 0).join("\n;\n");
  const slow = statementToCode(unit.stmt as Statement);
  const fast = statementToCode(afterStmt as Statement);
  const workload = wrapObservedWorkload(statementsToCode([...f1Decomposition.f1Body.body]));

  return {
    setup,
    slow,
    fast,
    workload,
    enclosure_node_type: (unit.stmt as { type: string }).type,
    before_node_count: countNodes(unit.stmt),
    after_node_count: countNodes(afterStmt),
    candidate_meta: { adapter: "selakovic", target_side: TARGET_SIDE.LIB, is_workload_reachable: true },
  };
}

/**
 * changed-stmt 経路の excluded marker (changed-fn の `buildExcludedChangedFnCandidate` と同形)。
 * `pipeline.ts` の集計ロジックが target_side=lib / is_workload_reachable=false で扱えるように合わせる。
 */
export function buildExcludedChangedStmtCandidate(
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

/** AST node の `start`/`end` 取得 (なければ null)。Babel の Node は両方 number | null | undefined。 */
function nodeSpan(n: Node): { start: number; end: number } | null {
  const s = (n as unknown as { start?: number | null }).start;
  const e = (n as unknown as { end?: number | null }).end;
  if (typeof s !== "number" || typeof e !== "number") return null;
  return { start: s, end: e };
}

/**
 * `libAfterSrc` を parse して、`statementBindings` が `bindings` と sorted equal になる最初の stmt を返す。
 * top-level だけでなく BlockStatement (IIFE body 等) 内も walk して探す (lib は `(function(){...})()` で
 * 包まれていることが多いため)。見つからなければ null。
 */
function findAfterStmtByBindings(libAfterSrc: string, bindings: readonly string[]): Node | null {
  let ast: File;
  try {
    ast = parse(libAfterSrc);
  } catch {
    return null;
  }
  const target = [...bindings].sort().join("|");
  let found: Node | null = null;
  walkNodes(ast, ({ node, ancestors }) => {
    if (found !== null) return;
    const parent = ancestors[ancestors.length - 1];
    const parentType = (parent as unknown as { type?: string } | undefined)?.type;
    if (parentType !== "Program" && parentType !== "BlockStatement") return;
    const b = statementBindings(node);
    if (b.length === 0) return;
    if ([...b].sort().join("|") === target) found = node;
  });
  return found;
}

// 判断: ai-guide/adr/0007-in-source-testing-internal-helpers.md
if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;
  // 観点: stmt unit から changed-stmt candidate を組む (順 1-d、no-fn-unit rescue)。pipeline.ts の経路と
  // 分離して直接 builder を叩く。pipeline 経路全体は pipeline.ts の in-source test 参照。

  const { findChangeUnits } = await import("../../../common/change-units");
  const { extractF1 } = await import("../../decompose/f1");
  const { substituteBody } = await import("../../../../codegen/placeholder");

  const inline = `var f1 = function () { lib.foo(); };\nvar a = execute(f1, 10);`;
  const libBefore = `var VERSION = '1.0';\nvar lib = {};\nlib.foo = function () { return VERSION; };`;
  const libAfter = `var VERSION = '2.0';\nvar lib = {};\nlib.foo = function () { return VERSION; };`;

  const stmtUnitFor = (before: string, after: string): StmtChangeUnit => {
    const cu = findChangeUnits(before, after);
    const u = cu.units.find((x): x is StmtChangeUnit => x.kind === "stmt");
    if (!u) throw new Error("no stmt unit");
    return u;
  };

  describe("buildChangedStmtCandidate (in-source)", () => {
    it("module-level の var VERSION 変更 → setup に $BODY$ 1 個入り穴あき lib / slow・fast に裸 stmt / workload に IIFE", () => {
      const f1d = extractF1(inline)!;
      const unit = stmtUnitFor(libBefore, libAfter);
      const r = buildChangedStmtCandidate(unit, libBefore, libAfter, f1d);

      expect(r.candidate_excluded).toBeUndefined();
      expect(r.candidate_meta.target_side).toBe(TARGET_SIDE.LIB);
      expect(r.candidate_meta.is_workload_reachable).toBe(true);

      // setup: lib_after の var VERSION の位置を $BODY$ で置換、他は無変更
      expect(r.setup).toContain("$BODY$");
      expect((r.setup!.match(/\$BODY\$/g) ?? []).length).toBe(1);
      expect(r.setup).toContain("var lib = {};");
      expect(r.setup).toContain("lib.foo = function () { return VERSION; }");
      // 変更前/後 stmt のリテラルは setup に残らない (穴に置換されたため)
      expect(r.setup).not.toContain("'1.0'");
      expect(r.setup).not.toContain("'2.0'");

      // slow / fast は裸 stmt (observer hook 無し)
      expect(r.slow).toContain("'1.0'");
      expect(r.fast).toContain("'2.0'");
      expect(r.slow).not.toContain("__OBS_R__");
      expect(r.fast).not.toContain("__OBS_R__");

      // workload: __OBS__ 初期化 + f1 body + JSON.stringify(__OBS__)
      expect(r.workload).toContain("__OBS__ = [];");
      expect(r.workload).toContain("lib.foo()");
      expect(r.workload).toContain("return JSON.stringify(__OBS__);");

      // substituteBody(setup, slow) は valid JS として parse できる (= sandbox 投入直前形)
      const substituted = substituteBody(r.setup!, r.slow!);
      expect(() => parse(substituted)).not.toThrow();
    });

    it("after に対応 stmt 無し (rename / 削除) → FN_RENAMED_OR_REMOVED marker", () => {
      const f1d = extractF1(inline)!;
      const unit = stmtUnitFor(libBefore, libAfter);
      const libAfterDeleted = `var OTHER = 'x';\nvar lib = {};\nlib.foo = function () { return OTHER; };`;
      const r = buildChangedStmtCandidate(unit, libBefore, libAfterDeleted, f1d);
      expect(r.candidate_excluded).toBe(SELAKOVIC_EXCLUSION_REASON.FN_RENAMED_OR_REMOVED);
      expect(r.setup).toBeUndefined();
    });

    it("buildExcludedChangedStmtCandidate: setup/slow/fast 無し + target_side=lib / is_workload_reachable=false", () => {
      const c = buildExcludedChangedStmtCandidate(SELAKOVIC_EXCLUSION_REASON.CHANGE_NOT_EXERCISED);
      expect(c.candidate_excluded).toBe(SELAKOVIC_EXCLUSION_REASON.CHANGE_NOT_EXERCISED);
      expect(c.candidate_meta.target_side).toBe(TARGET_SIDE.LIB);
      expect(c.candidate_meta.is_workload_reachable).toBe(false);
      expect(c.setup).toBeUndefined();
      expect(c.slow).toBeUndefined();
      expect(c.fast).toBeUndefined();
      expect(c.workload).toBeUndefined();
    });
  });
}
