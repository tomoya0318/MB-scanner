import {
  TARGET_SIDE,
  type PreprocessingCandidate,
} from "../../../../contracts/preprocessing-contracts";
import { wrapObservedWorkload } from "../../../../codegen/placeholder";
import { wrapBoundaryVarsStatement } from "../recorder-hooks";

/**
 * Angular controller-wrapper の `f1` を「lib を load → module/controller を再構成 (計測ハーネス除去済)
 * → controller を実体化 → f1() を 1 回実行 → 観測値を return」する自己完結 IIFE に組み立てる
 * (ADR-0011 §段2)。
 *
 * sandbox executor の body として実行される前提 (= 最後の式の完了値が return_value oracle に乗る)。
 * f1 body 内のループ反復回数は書き換えない (ADR-0017)。controller fn 内で f1 定義後・呼び出し前に
 * `globalThis.__recorder` があれば注入 service (= ctrlParams) を記録 Proxy で包む (C6 — `recorder-hooks.ts`)。
 * `globalThis.__selakovic_scope` は wrap 前の生 scope を保持 (scopeState の snapshot で trace を汚さないため)。
 */
export interface AngularRunnableOptions {
  /** load する lib 全文 (`<lib>_before.js` or `<lib>_after.js`)。 */
  readonly libSource: string;
  readonly moduleName: string;
  readonly ctrlName: string;
  readonly ctrlParams: readonly string[];
  /** controller body 内で f1 定義より前の非ハーネス statement のコード。 */
  readonly preWorkloadCode: string;
  /** f1 の body のコード (外側の `{}` を含まない statement 列)。 */
  readonly f1BodyCode: string;
}

/**
 * module/controller を再構成し `globalThis.__selakovic_f1` を定義する登録文 +
 * injector 起動 + controller 実体化までの bootstrap 行を組み立てる
 * (`buildAngularRunnable` の自己完結 IIFE と `assembleAngularChangedFn` の setup で共有)。
 *
 * 実体化 (`$controller(...)`) で controller fn が走り、preWorkload 実行・`var f1` 定義・
 * `globalThis.__selakovic_f1` への束縛・注入 service の記録 Proxy wrap (C6) が済む。
 * f1 の **呼び出し** は含まない (= 呼び出し側が観測戦略に応じて付け足す)。
 */
function buildAngularBootstrapLines(opts: {
  readonly moduleName: string;
  readonly ctrlName: string;
  readonly ctrlParams: readonly string[];
  readonly preWorkloadCode: string;
  readonly f1BodyCode: string;
}): readonly string[] {
  const wrappedParams = opts.ctrlParams.length > 0 ? [...opts.ctrlParams] : ["$scope"];
  const params = wrappedParams.join(", ");
  const scopeParam = wrappedParams[0] ?? "$scope";
  const moduleNameJson = JSON.stringify(opts.moduleName);
  const ctrlNameJson = JSON.stringify(opts.ctrlName);
  return [
    `var __selakovic_app = angular.module(${moduleNameJson}, []);`,
    `__selakovic_app.controller(${ctrlNameJson}, function (${params}) {`,
    opts.preWorkloadCode,
    ";",
    "var f1 = function () {",
    opts.f1BodyCode,
    "};",
    `globalThis.__selakovic_f1 = f1; globalThis.__selakovic_scope = ${scopeParam};`,
    wrapBoundaryVarsStatement(wrappedParams.map((p) => [p, p] as const)),
    "});",
    `var __selakovic_inj = angular.injector(['ng', ${moduleNameJson}]);`,
    "var __selakovic_root = __selakovic_inj.get('$rootScope').$new();",
    `__selakovic_inj.get('$controller')(${ctrlNameJson}, { $scope: __selakovic_root });`,
  ];
}

export function buildAngularRunnable(opts: AngularRunnableOptions): string {
  return [
    "(function () {",
    "// ---- library under test ----",
    opts.libSource,
    ";",
    "// ---- bootstrap (reconstructed module/controller, measurement harness stripped) ----",
    ...buildAngularBootstrapLines(opts),
    "// ---- run f1 once + capture observables ----",
    "var __selakovic_ret = globalThis.__selakovic_f1();",
    "var __selakovic_scopeState = {};",
    "try { for (var __selakovic_k in globalThis.__selakovic_scope) { if (__selakovic_k.charAt(0) !== '$') { try { __selakovic_scopeState[__selakovic_k] = JSON.stringify(globalThis.__selakovic_scope[__selakovic_k]); } catch (e) { __selakovic_scopeState[__selakovic_k] = '<<unserializable>>'; } } } } catch (e) {}",
    "return JSON.stringify({ f1Return: (__selakovic_ret === undefined ? '<<undefined>>' : __selakovic_ret), scopeState: __selakovic_scopeState });",
    "})()",
  ].join("\n");
}

/**
 * Angular controller-wrapper の changed-fn candidate を組む (placeholder substitution model、ADR-0023 §4 値契約、
 * 案 C' = spike 順 2-0)。`buildChangedFnCandidate` (`strategies/changed-fn.ts`) の wrapperKind dispatch から
 * 呼ばれる。hole 化 / body slice / param 検査の共通処理は呼び出し側で済み、ここでは「Angular controller
 * 実行容器にどう組むか」だけを担う (wrappers レイヤの責務)。
 *
 * top-level changed-fn (`assembleTopLevelChangedFn`) との違いは「変更関数を走らせるのに Angular の
 * module/controller bootstrap が要る」点だけ。bootstrap を **setup (状態構築) と workload (観測実行) に分割**
 * して placeholder model を満たす:
 *  - `setup` = `holedLib` (変更関数 body を観測ハーネス入り `{ $BODY$ }` で置換済、`$BODY$` 1 個) +
 *    bootstrap (module/controller 登録 + injector 起動 + 実体化 = `globalThis.__selakovic_f1` を定義)。
 *    実体化は f1 を **呼ばない** ので、preWorkload / 実体化中に変更関数が呼ばれた観測値は workload 先頭の
 *    `__OBS__=[]` reset で破棄され、純粋に f1 呼び出しの観測だけが完了値に乗る (top-level とセマンティクス整合)。
 *  - `before` / `after` = 変更前 / 後 body の裸断片 (top-level と同一)。
 *  - `workload` = `wrapObservedWorkload("globalThis.__selakovic_f1();")` (= `__OBS__=[]` reset → f1 1 回呼び出し
 *    → `JSON.stringify(__OBS__)` 完了値返却)。f1 が観測ハーネス入り lib 関数を呼ぶことで `__OBS__` に push される。
 *
 * `angular.ctrlMethod` は controller 固定再構成では使わない (`buildAngularRunnable` と同様)。
 */
export interface AssembleAngularChangedFnArgs {
  /** 変更関数 body を観測ハーネス入り `{ $BODY$ }` で置換済の lib 全文 (`$BODY$` 厳密 1 個)。 */
  readonly holedLib: string;
  readonly before: string;
  readonly after: string;
  readonly preWorkloadCode: string;
  /** f1 の body のコード (外側の `{}` を含まない statement 列)。controller 内の `var f1` に埋まる。 */
  readonly f1BodyCode: string;
  readonly moduleName: string;
  readonly ctrlName: string;
  readonly ctrlParams: readonly string[];
  readonly enclosureNodeType: string;
  readonly beforeNodeCount: number;
  readonly afterNodeCount: number;
}

export function assembleAngularChangedFn(args: AssembleAngularChangedFnArgs): PreprocessingCandidate {
  const bootstrap = buildAngularBootstrapLines({
    moduleName: args.moduleName,
    ctrlName: args.ctrlName,
    ctrlParams: args.ctrlParams,
    preWorkloadCode: args.preWorkloadCode,
    f1BodyCode: args.f1BodyCode,
  });
  const setup = [args.holedLib, bootstrap.join("\n")].join("\n;\n");
  return {
    setup,
    before: args.before,
    after: args.after,
    workload: wrapObservedWorkload("globalThis.__selakovic_f1();"),
    enclosure_node_type: args.enclosureNodeType,
    before_node_count: args.beforeNodeCount,
    after_node_count: args.afterNodeCount,
    candidate_meta: { adapter: "selakovic", target_side: TARGET_SIDE.LIB, is_workload_reachable: true },
  };
}

// 判断: ai-guide/adr/0007-in-source-testing-internal-helpers.md
if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;
  const { parse } = await import("../../../../ast/parser");
  const { substituteBody, declareObservationGlobal } = await import("../../../../codegen/placeholder");

  const base = {
    libSource: "/* lib */ var __LIB_MARKER__ = 1;",
    moduleName: "myApp",
    ctrlName: "Ctrl",
    ctrlParams: ["$scope", "$http"] as const,
    preWorkloadCode: "var __PRE_WORKLOAD_MARKER__ = 2;",
    f1BodyCode: "var __F1_BODY_MARKER__ = 3;",
  };

  describe("buildAngularRunnable (in-source)", () => {
    it("自己完結 IIFE に lib / module・controller 再構成 / preWorkload / f1 body を埋め込む", () => {
      const code = buildAngularRunnable({ ...base, ctrlParams: [...base.ctrlParams] });
      expect(code.startsWith("(function () {")).toBe(true);
      expect(code.trimEnd().endsWith("})()")).toBe(true);
      expect(code).toContain(base.libSource); // 測定対象 lib
      expect(code).toContain('angular.module("myApp", []);'); // module 再構成
      expect(code).toContain('.controller("Ctrl", function ($scope, $http) {'); // ctrl 再構成 (params join)
      expect(code).toContain(base.preWorkloadCode); // f1 より前の非ハーネス statement
      expect(code).toContain(`var f1 = function () {\n${base.f1BodyCode}\n};`); // f1 body は反復回数そのまま (ADR-0013)
      expect(code).toContain("__selakovic_inj.get('$controller')(\"Ctrl\", { $scope: __selakovic_root });"); // 実体化
      // f1 定義後・呼び出し前に注入 service (ctrlParams) を記録 Proxy で包む (C6)
      expect(code).toContain('$scope = globalThis.__recorder.wrap($scope, "$scope", { recurse: true });');
      expect(code).toContain('$http = globalThis.__recorder.wrap($http, "$http", { recurse: true });');
      // 計測ハーネス (execute / $.ajax / mark) は一切埋め込まれない
      expect(code).not.toContain("execute");
      expect(code).not.toContain("$.ajax");
    });

    it("scope の観測には ctrlParams の先頭 (= $scope 相当) を使う", () => {
      const code = buildAngularRunnable({ ...base, ctrlParams: ["$rootScopeAlias", "$timeout"] });
      expect(code).toContain("function ($rootScopeAlias, $timeout) {");
      expect(code).toContain("globalThis.__selakovic_scope = $rootScopeAlias;");
    });

    it("ctrlParams が空なら $scope をフォールバックに使う", () => {
      const code = buildAngularRunnable({ ...base, ctrlParams: [] });
      expect(code).toContain('.controller("Ctrl", function ($scope) {');
      expect(code).toContain("globalThis.__selakovic_scope = $scope;");
    });

    it("module / controller 名は JSON.stringify でエスケープして埋める", () => {
      const code = buildAngularRunnable({ ...base, moduleName: 'a"pp', ctrlName: "C\\tl" });
      expect(code).toContain('angular.module("a\\"pp", []);');
      expect(code).toContain('.controller("C\\\\tl", function');
      expect(code).toContain("__selakovic_inj = angular.injector(['ng', \"a\\\"pp\"]);");
    });
  });

  // changed-fn (placeholder substitution model) 経路。observation は __OBS__ (戻り値観測) で、
  // bootstrap を setup (状態構築) と workload (f1 呼び出し) に分割する (ADR-0023 §順 2-1 案 C')。
  describe("assembleAngularChangedFn (in-source)", () => {
    // 変更関数 body を観測ハーネス入り `{ $BODY$ }` で置換済の lib (= changed-fn.ts の holedLib 相当を手組み)。
    const holedLib =
      "var lib = {};\nlib.norm = function (x) { let __OBS_R__ = (function () { $BODY$ }).apply(this, arguments); __OBS__.push(0); return __OBS_R__; };";
    const baseArgs = {
      holedLib,
      before: "return x % 2 === 0;",
      after: "return (x & 1) === 0;",
      preWorkloadCode: "",
      f1BodyCode: "lib.norm(7); lib.norm(8);",
      moduleName: "benchApp",
      ctrlName: "BenchCtrl",
      ctrlParams: ["$scope"] as const,
      enclosureNodeType: "FunctionExpression",
      beforeNodeCount: 5,
      afterNodeCount: 5,
    };

    it("setup = holedLib + bootstrap ($BODY$ 1 個)、before/after は裸 body、workload は f1 呼び出し", () => {
      const r = assembleAngularChangedFn({ ...baseArgs, ctrlParams: [...baseArgs.ctrlParams] });
      expect(r.candidate_excluded).toBeUndefined();
      expect(r.candidate_meta.target_side).toBe(TARGET_SIDE.LIB);
      expect(r.candidate_meta.is_workload_reachable).toBe(true);
      expect(r.enclosure_node_type).toBe("FunctionExpression");
      // setup: holedLib (観測ハーネス + $BODY$ 厳密 1 個) + bootstrap (controller 内に f1 body 展開)
      expect((r.setup!.match(/\$BODY\$/g) ?? []).length).toBe(1);
      expect(r.setup).toContain("let __OBS_R__");
      expect(r.setup).toContain('angular.module("benchApp", []);');
      expect(r.setup).toContain('.controller("BenchCtrl", function ($scope) {');
      expect(r.setup).toContain("var f1 = function () {");
      expect(r.setup).toContain("lib.norm(7); lib.norm(8);"); // f1 body は controller 内 (= setup)
      expect(r.setup).toContain("globalThis.__selakovic_f1 = f1;");
      expect(r.setup).toContain("__selakovic_inj.get('$controller')(\"BenchCtrl\", { $scope: __selakovic_root });");
      // before / after は裸 body 断片 (観測足場無し、top-level と同一)
      expect(r.before).toBe(baseArgs.before);
      expect(r.after).toBe(baseArgs.after);
      expect(r.before).not.toContain("__OBS_R__");
      // workload = __OBS__ reset → f1 1 回呼び出し → JSON.stringify
      expect(r.workload).toContain("__OBS__ = [];");
      expect(r.workload).toContain("globalThis.__selakovic_f1();");
      expect(r.workload).toContain("return JSON.stringify(__OBS__);");
      expect(r.workload).not.toContain("globalThis.__OBS");
      // sandbox 投入直前形 (substituteBody(setup, before) + __OBS__ 宣言 prepend) が valid JS
      expect(() => parse(declareObservationGlobal(substituteBody(r.setup!, r.before!)))).not.toThrow();
      expect(() => parse(declareObservationGlobal(substituteBody(r.setup!, r.after!)))).not.toThrow();
      // workload も単独で valid な式
      expect(() => parse(`var _ = ${r.workload!};`)).not.toThrow();
    });

    it("$scope.$eval を含む f1 body でも setup が組め、substituteBody 後に valid JS (issue_10351 相当)", () => {
      const r = assembleAngularChangedFn({
        ...baseArgs,
        ctrlParams: ["$scope"],
        f1BodyCode: "$scope.$eval('1 + 1'); lib.norm(1);",
      });
      expect(r.setup).toContain("$scope.$eval('1 + 1');");
      expect((r.setup!.match(/\$BODY\$/g) ?? []).length).toBe(1);
      expect(() => parse(declareObservationGlobal(substituteBody(r.setup!, r.after!)))).not.toThrow();
    });

    it("ctrlParams が空なら $scope をフォールバックに使う (buildAngularRunnable と同挙動)", () => {
      const r = assembleAngularChangedFn({ ...baseArgs, ctrlParams: [] });
      expect(r.setup).toContain('.controller("BenchCtrl", function ($scope) {');
    });
  });
}
