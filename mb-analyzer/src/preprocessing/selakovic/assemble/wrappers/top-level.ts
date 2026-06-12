import {
  TARGET_SIDE,
  type PreprocessingCandidate,
  type TargetSide,
} from "../../../../contracts/preprocessing-contracts";
import { wrapObservedWorkload } from "../../../../codegen/placeholder";
import { statementsToCode } from "../../../common/setup-cleanup";
import type { F1Decomposition } from "../../decompose/f1";
import { buildAngularRunnable } from "./angular";
import { wrapClientLibGlobalsStatement } from "../recorder-hooks";

/**
 * clientIssues の `(setup, before, after)` candidate を作用点 (lib / workload / lib+workload) × wrapper kind
 * (top-level f1 / Angular controller-wrapper) で組み立てる (ADR-0011 §段2 / ADR-0014)。
 * `f1` body 内のループ反復回数は書き換えない (ADR-0017)。
 *
 * `aspect: lib` (lib 内 patch) の pruning 向け小 candidate (`changed-fn`) は `buildChangedFnCandidate` が担当する。
 *
 * 戻り値は ADR-0024 の base + adapter_meta 構造 (`enclosure_node_type` は client 系経路では null = 戦略
 * ラベル "lib-file" 等は assemble_path 相当を adapter_meta から派生で識別)。
 */

/** 作用点 lib の embedded lib candidate: lib varies / workload body fixed@before (lib 全文を before/after に丸ごと埋める)。 */
export function buildClientLibCandidate(
  f1Before: F1Decomposition,
  libSourceBefore: string,
  libSourceAfter: string,
  targetSide: TargetSide,
): PreprocessingCandidate {
  const preWorkload = statementsToCode([...f1Before.preWorkloadStatements]);
  if (f1Before.wrapperKind === "angular-controller-wrapper" && f1Before.angular !== undefined) {
    const a = f1Before.angular;
    return {
      setup: "",
      before: buildAngularRunnable({ libSource: libSourceBefore, moduleName: a.moduleName, ctrlName: a.ctrlName, ctrlParams: a.ctrlParams, preWorkloadCode: preWorkload, f1BodyCode: f1BodyRaw(f1Before) }),
      after: buildAngularRunnable({ libSource: libSourceAfter, moduleName: a.moduleName, ctrlName: a.ctrlName, ctrlParams: a.ctrlParams, preWorkloadCode: preWorkload, f1BodyCode: f1BodyRaw(f1Before) }),
      candidate_meta: { adapter: "selakovic", target_side: targetSide, is_workload_reachable: false },
    };
  }
  return {
    setup: "",
    before: flatRunnable(libSourceBefore, preWorkload, f1BodyWrapped(f1Before), clientRecorderHook(libSourceBefore)),
    after: flatRunnable(libSourceAfter, preWorkload, f1BodyWrapped(f1Before), clientRecorderHook(libSourceAfter)),
    candidate_meta: { adapter: "selakovic", target_side: targetSide, is_workload_reachable: false },
  };
}

/** 作用点 workload の body candidate: workload body varies / lib fixed@before。 */
export function buildClientBodyCandidate(
  f1Before: F1Decomposition,
  f1After: F1Decomposition,
  libSourceBefore: string,
  libNeededInSetup: boolean,
  targetSide: TargetSide,
): PreprocessingCandidate {
  const preWorkload = statementsToCode([...f1Before.preWorkloadStatements]);
  if (f1Before.wrapperKind === "angular-controller-wrapper" && f1Before.angular !== undefined) {
    const a = f1Before.angular;
    return {
      setup: "",
      before: buildAngularRunnable({ libSource: libSourceBefore, moduleName: a.moduleName, ctrlName: a.ctrlName, ctrlParams: a.ctrlParams, preWorkloadCode: preWorkload, f1BodyCode: f1BodyRaw(f1Before) }),
      after: buildAngularRunnable({ libSource: libSourceBefore, moduleName: a.moduleName, ctrlName: a.ctrlName, ctrlParams: a.ctrlParams, preWorkloadCode: preWorkload, f1BodyCode: f1BodyRaw(f1After) }),
      candidate_meta: { adapter: "selakovic", target_side: targetSide, is_workload_reachable: false },
    };
  }
  const setupParts: string[] = [];
  if (libNeededInSetup && libSourceBefore.length > 0) setupParts.push(libSourceBefore);
  if (preWorkload.length > 0) setupParts.push(preWorkload);
  return {
    setup: setupParts.join("\n;\n"),
    before: f1BodyWrapped(f1Before),
    after: f1BodyWrapped(f1After),
    candidate_meta: { adapter: "selakovic", target_side: targetSide, is_workload_reachable: false },
  };
}

/** lib+workload co-evolution の疑い: lib も workload body も同時に変える 1 candidate (target_side=both)。 */
export function buildClientCombinedCandidate(
  f1Before: F1Decomposition,
  f1After: F1Decomposition,
  libSourceBefore: string,
  libSourceAfter: string,
): PreprocessingCandidate {
  const preWorkload = statementsToCode([...f1Before.preWorkloadStatements]);
  if (f1Before.wrapperKind === "angular-controller-wrapper" && f1Before.angular !== undefined) {
    const a = f1Before.angular;
    return {
      setup: "",
      before: buildAngularRunnable({ libSource: libSourceBefore, moduleName: a.moduleName, ctrlName: a.ctrlName, ctrlParams: a.ctrlParams, preWorkloadCode: preWorkload, f1BodyCode: f1BodyRaw(f1Before) }),
      after: buildAngularRunnable({ libSource: libSourceAfter, moduleName: a.moduleName, ctrlName: a.ctrlName, ctrlParams: a.ctrlParams, preWorkloadCode: preWorkload, f1BodyCode: f1BodyRaw(f1After) }),
      candidate_meta: { adapter: "selakovic", target_side: TARGET_SIDE.BOTH, is_workload_reachable: false },
    };
  }
  return {
    setup: "",
    before: flatRunnable(libSourceBefore, preWorkload, f1BodyWrapped(f1Before), clientRecorderHook(libSourceBefore)),
    after: flatRunnable(libSourceAfter, preWorkload, f1BodyWrapped(f1After), clientRecorderHook(libSourceAfter)),
    candidate_meta: { adapter: "selakovic", target_side: TARGET_SIDE.BOTH, is_workload_reachable: false },
  };
}

/**
 * `[libSource]\n;\n[recorderHook]\n[preWorkload]\n;\n[bodyCode]` を 1 つの実行可能スクリプトに連結する (top-level f1 用)。
 * `recorderHook` は `lib-file` 系で `globalThis.__recorder` があれば lib グローバルを記録 Proxy で包む文
 * (`recorder-hooks.ts`)。lib を持たない場合は空文字を渡す。
 */
function flatRunnable(libSource: string, preWorkloadCode: string, bodyCode: string, recorderHook = ""): string {
  const parts: string[] = [];
  if (libSource.length > 0) {
    parts.push(libSource);
    parts.push(";");
  }
  if (recorderHook.length > 0) parts.push(recorderHook);
  if (preWorkloadCode.length > 0) {
    parts.push(preWorkloadCode);
    parts.push(";");
  }
  parts.push(bodyCode);
  return parts.join("\n");
}

/** `flatRunnable` の `recorderHook` 引数。lib があれば lib グローバルを wrap する文、無ければ空文字。 */
function clientRecorderHook(libSource: string): string {
  return libSource.length > 0 ? wrapClientLibGlobalsStatement() : "";
}

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

/**
 * top-level f1 の changed-fn candidate を組む (placeholder substitution model、ADR-0023 §4 値契約)。
 * `buildChangedFnCandidate` (`strategies/changed-fn.ts`) の wrapperKind dispatch から呼ばれる。
 * hole 化 / body slice / param 検査の共通処理は呼び出し側で済み、ここでは「top-level の実行容器に
 * どう組むか」だけを担う (wrappers レイヤの責務)。
 *
 *  - `setup` = `holedLib` (変更関数 body を観測ハーネス入り `{ $BODY$ }` で置換済、`$BODY$` 1 個) +
 *    `preWorkloadCode` を `\n;\n` 結合。
 *  - `before` / `after` = 変更前 / 後 body の裸 statementsToCode 出力 (= 観測足場無し)。
 *  - `workload` = `wrapObservedWorkload(f1BodyCode)` (= `__OBS__=[]` reset → f1 body 実行 →
 *    `JSON.stringify(__OBS__)` 完了値返却)。
 */
export interface AssembleTopLevelChangedFnArgs {
  readonly holedLib: string;
  readonly preWorkloadCode: string;
  readonly before: string;
  readonly after: string;
  readonly f1BodyCode: string;
  readonly enclosureNodeType: string;
  readonly beforeNodeCount: number;
  readonly afterNodeCount: number;
}

export function assembleTopLevelChangedFn(args: AssembleTopLevelChangedFnArgs): PreprocessingCandidate {
  const setup = [args.holedLib, args.preWorkloadCode].filter((s) => s.length > 0).join("\n;\n");
  return {
    setup,
    before: args.before,
    after: args.after,
    workload: wrapObservedWorkload(args.f1BodyCode),
    enclosure_node_type: args.enclosureNodeType,
    // node count は「pruning が削る対象 = 変更関数の本体」のサイズ (inline 全文サイズ ≠ embedded の値)。
    before_node_count: args.beforeNodeCount,
    after_node_count: args.afterNodeCount,
    candidate_meta: { adapter: "selakovic", target_side: TARGET_SIDE.LIB, is_workload_reachable: true },
  };
}
