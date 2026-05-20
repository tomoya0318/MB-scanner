import type { File, Node, Statement } from "@babel/types";

import { countNodes } from "../../../../ast/inspect";
import { parse } from "../../../../ast/parser";
import { walkNodes } from "../../../../ast/walk";
import { applySpanEdits, wrapBodyWithObserver, wrapObservedWorkload, type SpanEdit } from "../../../../codegen/placeholder";
import {
  SELAKOVIC_EXCLUSION_REASON,
  TARGET_SIDE,
  type PreprocessingCandidate,
  type SelakovicExclusionReason,
} from "../../../../contracts/preprocessing-contracts";
import { FN_TYPES, functionBindingName, statementBindings, type StmtChangeUnit } from "../../../common/change-units";
import { isReachedByAnyWorkload, type CallGraph } from "../../../common/reachability";
import { statementToCode, statementsToCode } from "../../../common/setup-cleanup";
import type { F1Decomposition } from "../../decompose/f1";

/**
 * stmt unit (= モジュール本体 / 匿名 IIFE 本体直下の変更、`var VERSION = '...'` / `Ember.X = ...;` 等)
 * を 1st-class candidate に格上げする strategy (順 1-d、no-fn-unit rescue)。`changed-fn.ts` の stmt 版で、
 * ファイル配置を `changed-fn` と対称にしている。
 *
 *  - `lib_after` 内の対応 stmt span を `$BODY$` で hole 置換 (slow/fast がここに差し込まれる)
 *  - **workload から到達可能な named fn 全部の本体を observer ラッパで計装** (`wrapBodyWithObserver`)。
 *    これにより workload (`f1`) 実行時、reachable fn が呼ばれるたびに戻り値が `__OBS__` に push される
 *  - slow/fast は before/after stmt の `statementToCode` 出力 (= 裸 stmt、観測足場は load しない)
 *  - workload = `wrapObservedWorkload(f1Body)`
 *  - adapter_meta: target_side=lib / is_workload_reachable=true
 *
 * **観測モデル (full-observation)**: changed-fn は「変更関数 1 個だけ」を `$BODY$` 入り observer で置換する
 * (= 変更関数の本体が比較対象)。changed-stmt は変更箇所が関数の外 (stmt) なので、`$BODY$` 穴は changed stmt
 * 側に 1 個だけ残し、**reachable な named fn 群は本体を保持したまま observer 化** する。stmt の変更が reachable
 * fn の戻り値に伝播すれば observer の push 差として観測される (over-observation = 変更に依存しない fn は両側で
 * 同じ値を push するので false not_equal は生まない)。「変更が workload に伝播しないなら equal verdict」のは正しい。
 *
 * before↔after の stmt 対応は binding 名 + occurrence 番号 (`unit.bindingsOccurrence`) で一意化する
 * (同名 binding が複数あっても誤マッチしない、Copilot review #2)。
 *
 * 関連: fallback 経路 (`fallback.ts:extractFromScripts/extractFromServerFiles`) は f1 / test が規約外の
 * issue 用安全弁で、target_side=both / is_workload_reachable=false の degenerate 経路。
 */

const STMT_BODY_PLACEHOLDER = "$BODY$";

/**
 * 前提 (呼び出し側 = `pipeline.ts:appendChangeUnitCandidates` で保証):
 *  - `f1Decomposition.wrapperKind === "top-level"` (angular wrapper は pipeline 側で先弾き)
 *  - `unit.bindings.length > 0` (空 bindings は pipeline 側で `NO_FN_UNIT` 先弾き)
 *
 * `graph` は pipeline が `buildCallGraph(beforeAst, [f1])` で作った参照グラフ。reachable fn の選別に使う。
 *
 * excluded marker を返すケース:
 *  - after-AST に対応 stmt 無し (削除 / rename / occurrence 数の前後不一致) → `FN_RENAMED_OR_REMOVED`
 *    (reason 名は fn 由来だが「after に対応するものが無い」の意味で stmt 側にも再利用、改名は別 PR)
 */
export function buildChangedStmtCandidate(
  unit: StmtChangeUnit,
  _libBeforeSrc: string,
  libAfterSrc: string,
  f1Decomposition: F1Decomposition,
  graph: CallGraph,
): PreprocessingCandidate {
  let afterAst: File;
  try {
    afterAst = parse(libAfterSrc);
  } catch {
    return buildExcludedChangedStmtCandidate(SELAKOVIC_EXCLUSION_REASON.FN_RENAMED_OR_REMOVED);
  }

  const afterStmt = findAfterStmtByBindingsAndOccurrence(afterAst, unit.bindings, unit.bindingsOccurrence);
  const stmtSpan = afterStmt === null ? null : nodeSpan(afterStmt);
  if (afterStmt === null || stmtSpan === null) {
    return buildExcludedChangedStmtCandidate(SELAKOVIC_EXCLUSION_REASON.FN_RENAMED_OR_REMOVED);
  }

  // changed stmt を $BODY$ で穴あき + reachable fn 群を observer 化 を 1 パスで適用する。
  const edits: SpanEdit[] = [{ start: stmtSpan.start, end: stmtSpan.end, replacement: STMT_BODY_PLACEHOLDER }];
  for (const fnSpan of reachableFnBodySpans(afterAst, graph)) {
    // changed stmt 穴と重なる fn body は計装しない ($BODY$ 置換が優先、通常 stmt は fn 外なので重ならない)。
    if (fnSpan.end <= stmtSpan.start || fnSpan.start >= stmtSpan.end) {
      edits.push({
        start: fnSpan.start,
        end: fnSpan.end,
        replacement: wrapBodyWithObserver(libAfterSrc.slice(fnSpan.start, fnSpan.end)),
      });
    }
  }

  const holedLib = applySpanEdits(libAfterSrc, edits);
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
 * `afterAst` から、workload (`graph` の workload root) が (推移的に) 到達可能な named fn の本体 (BlockStatement)
 * span を集める。入れ子 fn は外側のみ残す (= span が他に内包されるものを除外。`applySpanEdits` の overlap-free
 * 前提を満たす。内側 fn は外側 body 文字列の一部として保持される)。
 */
function reachableFnBodySpans(afterAst: File, graph: CallGraph): Array<{ start: number; end: number }> {
  const spans: Array<{ start: number; end: number }> = [];
  walkNodes(afterAst, ({ node, ancestors }) => {
    if (!FN_TYPES.has(node.type)) return;
    const name = functionBindingName(ancestors, node);
    if (name === null || !isReachedByAnyWorkload(graph, name)) return;
    const body = (node as unknown as { body?: Node }).body;
    if (body === undefined || (body as { type?: string }).type !== "BlockStatement") return;
    const span = nodeSpan(body);
    if (span !== null) spans.push(span);
  });
  // 内包される span を除外して overlap-free にする (外側 fn を残す)。
  return spans.filter((s) => !spans.some((o) => (o.start < s.start && s.end <= o.end) || (o.start <= s.start && s.end < o.end)));
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
 * `afterAst` の block 直下 (Program / BlockStatement) の文を document 順に走査し、`statementBindings` が
 * `bindings` と sorted equal な文のうち **`occurrence` 番目 (0-based)** を返す。見つからなければ null。
 *
 * `change-units.ts:computeStmtOccurrences` と同じ走査順・filter を使うので、before で k 番目だった文は
 * after でも k 番目で対応する (同名 binding 複数でも誤マッチしない、Copilot review #2)。before/after で
 * 同名 binding 文の数が違って k 番目が存在しない場合は null (= rename/削除相当の DROP)。
 */
function findAfterStmtByBindingsAndOccurrence(
  afterAst: File,
  bindings: readonly string[],
  occurrence: number,
): Node | null {
  const target = [...bindings].sort().join("|");
  let seen = 0;
  let found: Node | null = null;
  walkNodes(afterAst, ({ node, ancestors }) => {
    if (found !== null) return;
    const parent = ancestors[ancestors.length - 1];
    const parentType = (parent as unknown as { type?: string } | undefined)?.type;
    if (parentType !== "Program" && parentType !== "BlockStatement") return;
    const b = statementBindings(node);
    if (b.length === 0) return;
    if ([...b].sort().join("|") !== target) return;
    if (seen === occurrence) found = node;
    seen++;
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
  const { buildCallGraph } = await import("../../../common/reachability");

  const inline = `var f1 = function () { lib.foo(); };\nvar a = execute(f1, 10);`;
  const libBefore = `var VERSION = '1.0';\nvar lib = {};\nlib.foo = function () { return VERSION; };`;
  const libAfter = `var VERSION = '2.0';\nvar lib = {};\nlib.foo = function () { return VERSION; };`;

  const stmtUnitFor = (before: string, after: string): StmtChangeUnit => {
    const cu = findChangeUnits(before, after);
    const u = cu.units.find((x): x is StmtChangeUnit => x.kind === "stmt");
    if (!u) throw new Error("no stmt unit");
    return u;
  };

  // pipeline と同じ手順で call graph を作る (beforeAst + f1 を workload root に)。
  const graphFor = (before: string, after: string, f1d: F1Decomposition): CallGraph => {
    const cu = findChangeUnits(before, after);
    return buildCallGraph(cu.beforeAst, [
      { name: "f1", body: [...f1d.preWorkloadStatements, ...f1d.f1Body.body] },
    ]);
  };

  describe("buildChangedStmtCandidate (in-source)", () => {
    it("module-level の var VERSION 変更 → changed stmt は $BODY$ 1 個 / reachable な lib.foo は observer 化", () => {
      const f1d = extractF1(inline)!;
      const unit = stmtUnitFor(libBefore, libAfter);
      const graph = graphFor(libBefore, libAfter, f1d);
      const r = buildChangedStmtCandidate(unit, libBefore, libAfter, f1d, graph);

      expect(r.candidate_excluded).toBeUndefined();
      expect(r.candidate_meta.target_side).toBe(TARGET_SIDE.LIB);
      expect(r.candidate_meta.is_workload_reachable).toBe(true);

      // changed stmt の位置に $BODY$ が厳密 1 個 (observer は $BODY$ を使わないので個数は変わらない)
      expect(r.setup).toContain("$BODY$");
      expect((r.setup!.match(/\$BODY\$/g) ?? []).length).toBe(1);
      // reachable な lib.foo は observer ラッパで計装され、元 body (return VERSION;) は保持される
      expect(r.setup).toContain("__OBS_R__");
      expect(r.setup).toContain("__OBS__.push");
      expect(r.setup).toContain("return VERSION;");
      // 変更前/後 stmt のリテラルは setup に残らない (穴に置換されたため)
      expect(r.setup).not.toContain("'1.0'");
      expect(r.setup).not.toContain("'2.0'");

      // slow / fast は裸 stmt (観測足場は load しない)
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
      const graph = graphFor(libBefore, libAfter, f1d);
      const libAfterDeleted = `var OTHER = 'x';\nvar lib = {};\nlib.foo = function () { return OTHER; };`;
      const r = buildChangedStmtCandidate(unit, libBefore, libAfterDeleted, f1d, graph);
      expect(r.candidate_excluded).toBe(SELAKOVIC_EXCLUSION_REASON.FN_RENAMED_OR_REMOVED);
      expect(r.setup).toBeUndefined();
    });

    it("同名 binding 複数: occurrence 番号で正しい after stmt を選ぶ (Copilot review #2)", () => {
      // var X が 2 回宣言され、2 回目だけ変更。before の occurrence=1 の文に対応する after の 2 回目を hole すべき。
      const before = `var X = 1;\nvar X = 'foo';\nvar lib = {};\nlib.foo = function () { return X; };`;
      const after = `var X = 1;\nvar X = 'bar';\nvar lib = {};\nlib.foo = function () { return X; };`;
      const f1d = extractF1(`var f1 = function () { lib.foo(); };`)!;
      const unit = stmtUnitFor(before, after);
      expect(unit.bindingsOccurrence).toBe(1); // 2 回目が変更対象
      const graph = graphFor(before, after, f1d);
      const r = buildChangedStmtCandidate(unit, before, after, f1d, graph);

      expect(r.candidate_excluded).toBeUndefined();
      // fast は after の 2 回目 (= 'bar')、誤って 1 回目 ('var X = 1') を拾っていないこと
      expect(r.fast).toContain("'bar'");
      expect(r.fast).not.toContain("= 1");
      // setup には after の 1 回目 (var X = 1) が残り、2 回目が $BODY$ で穴あき
      expect(r.setup).toContain("var X = 1;");
      expect(r.setup).not.toContain("'bar'");
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
