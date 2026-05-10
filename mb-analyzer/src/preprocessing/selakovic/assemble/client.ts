import {
  CANDIDATE_KIND,
  LAYOUT_KIND,
  type CandidateKind,
  type ExecutionEnvironmentHint,
  type PreprocessingResult,
} from "../../../contracts/preprocessing-contracts";
import { statementsToCode } from "../../common/setup-cleanup";
import type { F1Decomposition } from "../decompose/f1";
import { buildAngularRunnable } from "./angular";

/**
 * clientIssues の `(setup, slow, fast)` candidate を作用点 (A / B / A+B) × wrapper kind
 * (top-level f1 / Angular controller-wrapper) で組み立てる (ADR-0011 §段2 / ADR-0014)。
 * `f1` body 内のループ反復回数は書き換えない (ADR-0017)。
 */

const ENV_JSDOM: ExecutionEnvironmentHint = "jsdom";

/** 作用点 A の lib candidate: lib varies / body fixed@before。 */
export function buildClientLibCandidate(
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
export function buildClientBodyCandidate(
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
export function buildClientCombinedCandidate(
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
