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

export function buildAngularRunnable(opts: AngularRunnableOptions): string {
  const wrappedParams = opts.ctrlParams.length > 0 ? [...opts.ctrlParams] : ["$scope"];
  const params = wrappedParams.join(", ");
  const scopeParam = wrappedParams[0] ?? "$scope";
  const moduleNameJson = JSON.stringify(opts.moduleName);
  const ctrlNameJson = JSON.stringify(opts.ctrlName);
  return [
    "(function () {",
    "// ---- library under test ----",
    opts.libSource,
    ";",
    "// ---- bootstrap (reconstructed module/controller, measurement harness stripped) ----",
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
    "// ---- run f1 once + capture observables ----",
    "var __selakovic_ret = globalThis.__selakovic_f1();",
    "var __selakovic_scopeState = {};",
    "try { for (var __selakovic_k in globalThis.__selakovic_scope) { if (__selakovic_k.charAt(0) !== '$') { try { __selakovic_scopeState[__selakovic_k] = JSON.stringify(globalThis.__selakovic_scope[__selakovic_k]); } catch (e) { __selakovic_scopeState[__selakovic_k] = '<<unserializable>>'; } } } } catch (e) {}",
    "return JSON.stringify({ f1Return: (__selakovic_ret === undefined ? '<<undefined>>' : __selakovic_ret), scopeState: __selakovic_scopeState });",
    "})()",
  ].join("\n");
}

// 判断: ai-guide/adr/0007-in-source-testing-internal-helpers.md
if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;

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
}
