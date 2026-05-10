/**
 * 対象: ADR-0011 Tier 2 の段1 役割分解 (f1-extract / test-extract) + 段2 作用点ルーティング
 *       (aspect-routing / lib-diff / case-split) + `extract()` の (setup, slow, fast) 組み立て。
 * 観点: 計測ハーネスを剥がして `f1`/`test()` body を slow/fast の母集団に取り、lib と body の
 *       実コード差で A / B / A+B / fallback に振り分け、A+B は ADR-0014 で 2 candidate に分割する契約。
 */
import { describe, expect, it } from "vitest";

import {
  ASPECT,
  CANDIDATE_KIND,
} from "../../src/contracts/preprocessing-contracts";
import { extract } from "../../src/preprocessing/selakovic";
import { routeAspect, statementsChanged } from "../../src/preprocessing/selakovic/aspect-routing";
import { isIndependent } from "../../src/preprocessing/selakovic/case-split";
import { extractF1 } from "../../src/preprocessing/selakovic/f1-extract";
import { diffLibPair } from "../../src/preprocessing/selakovic/lib-diff";
import { extractTest } from "../../src/preprocessing/selakovic/test-extract";
import { parse } from "../../src/ast/parser";

describe("f1-extract", () => {
  it("top-level f1 を役割分解する (計測ハーネスを harness に分離)", () => {
    const src = `
      var obj = {};
      for (var i = 0; i < 100; i++) obj[i] = i;
      var keys = Object.keys(obj);
      var f1 = function () { for (var i = 0; i < keys.length; i++) keys[i] % 2 === 0; };
      var a = execute(f1, 10);
      var mean = jStat(a).mean();
      console.log(mean);
      $.ajax({ url: 'x', data: JSON.stringify({ mark: 0, mean: mean }) });
    `;
    const d = extractF1(src);
    expect(d).not.toBeNull();
    expect(d?.wrapperKind).toBe("top-level");
    expect(d?.angular).toBeUndefined();
    // preF1 = var obj / for / var keys の 3 つ (harness は除外)
    expect(d?.preF1Statements).toHaveLength(3);
    // harness = execute / mean / console.log / $.ajax の 4 つ
    expect(d?.harnessStatements).toHaveLength(4);
  });

  it("Angular controller-wrapper の f1 を役割分解する", () => {
    const src = `
      var app = angular.module("myApp", []);
      app.controller("Ctrl", function ($scope, $http) {
        var keys = [1, 2, 3];
        var f1 = function () { keys.length; };
        var a = execute(f1, 10);
      });
    `;
    const d = extractF1(src);
    expect(d?.wrapperKind).toBe("angular-controller-wrapper");
    expect(d?.angular?.moduleName).toBe("myApp");
    expect(d?.angular?.ctrlName).toBe("Ctrl");
    expect(d?.angular?.ctrlParams).toEqual(["$scope", "$http"]);
    expect(d?.preF1Statements).toHaveLength(1); // var keys
    expect(d?.harnessStatements).toHaveLength(1); // execute(f1, 10)
  });

  it("f1 が無いと null (= フォールバック対象)", () => {
    expect(extractF1("function g() { return 1; }")).toBeNull();
  });

  it("parse できないソースは null", () => {
    expect(extractF1("var f1 = function () {")).toBeNull();
  });
});

describe("test-extract", () => {
  it("test_case IIFE から test() body とパラメタを取り出す", () => {
    const src = `
      (function () {
        function init() { return { x: 1 }; }
        function setupTest(initResult) { return { y: initResult.x }; }
        function test(initResult, setupTestResult) { return initResult.x + setupTestResult.y; }
        exports.init = init; exports.setupTest = setupTest; exports.test = test;
      })();
    `;
    const d = extractTest(src);
    expect(d).not.toBeNull();
    expect(d?.testParams).toEqual(["initResult", "setupTestResult"]);
  });

  it("exports.test = function(){} 形式も拾う", () => {
    const src = `(function () { exports.test = function (a, b) { return a; }; })();`;
    expect(extractTest(src)?.testParams).toEqual(["a", "b"]);
  });

  it("test() が無いと null", () => {
    expect(extractTest("(function () { exports.init = function () {}; })();")).toBeNull();
  });
});

describe("lib-diff", () => {
  it("byte 一致は変化なし", () => {
    const same = { "a.js": "function f() { return 1; }" };
    expect(diffLibPair(same, { "a.js": "function f() { return 1; }" }).hasRealChange).toBe(false);
  });

  it("実コード行の変化を検出し、近傍の関数名を拾う", () => {
    const r = diffLibPair(
      { "a.js": "function ngRepeatAction() {\n  return index % 2 == 0;\n}" },
      { "a.js": "function ngRepeatAction() {\n  return index & 1 == 0;\n}" },
    );
    expect(r.hasRealChange).toBe(true);
    expect(r.changedFiles).toEqual(["a.js"]);
    expect(r.changedFunctionNames.has("ngRepeatAction")).toBe(true);
  });

  it("license header / version 文字列だけの差は変化なし扱い", () => {
    const r = diffLibPair(
      { "a.js": "/* @license AngularJS v1.3.18 */\nfunction f() { return 1; }" },
      { "a.js": "/* @license AngularJS v1.3.20 */\nfunction f() { return 1; }" },
    );
    expect(r.hasRealChange).toBe(false);
  });
});

describe("aspect-routing", () => {
  it("routeAspect: A / B / A+B / fallback", () => {
    expect(routeAspect(true, false)).toBe(ASPECT.LIB);
    expect(routeAspect(false, true)).toBe(ASPECT.BODY);
    expect(routeAspect(true, true)).toBe(ASPECT.BOTH);
    expect(routeAspect(false, false)).toBe(ASPECT.FALLBACK);
  });

  it("statementsChanged: 整形差は変化なし、意味論差は変化あり", () => {
    const a = parse("x % 2 === 0;").program.body;
    const b = parse("x  %  2  ===  0;").program.body; // 整形だけ違う
    const c = parse("x & 1 === 0;").program.body; // 意味論が違う
    expect(statementsChanged(a, b)).toBe(false);
    expect(statementsChanged(a, c)).toBe(true);
  });
});

describe("case-split (ADR-0014)", () => {
  it("lib の変更関数名集合が空なら independent (= split する)", () => {
    expect(isIndependent(parse("a + b;").program.body, new Set())).toBe(true);
  });

  it("body の参照 identifier と lib 変更関数名が交差すれば co-evolution の疑い (= split しない)", () => {
    expect(isIndependent(parse("foo(x);").program.body, new Set(["foo"]))).toBe(false);
  });

  it("交差しなければ independent", () => {
    expect(isIndependent(parse("foo(x);").program.body, new Set(["bar"]))).toBe(true);
  });
});

describe("extract — client (top-level f1)", () => {
  const inlineBefore = `
    var keys = [1, 2, 3];
    var f1 = function () { for (var i = 0; i < keys.length; i++) keys[i] % 2 === 0; };
    var a = execute(f1, 10);
  `;
  const inlineAfter = `
    var keys = [1, 2, 3];
    var f1 = function () { for (var i = 0; i < keys.length; i++) keys[i] & 1 === 0; };
    var a = execute(f1, 10);
  `;

  it("lib なし + body 変化 → aspect B, 1 candidate, body は IIFE で包まれる", () => {
    const results = extract({
      kind: "client",
      before_inline: inlineBefore,
      after_inline: inlineAfter,
      lib_before_files: {},
      lib_after_files: {},
      lib_kind: null,
      lib_referenced_by_workload: false,
    });
    expect(results).toHaveLength(1);
    const r = results[0]!;
    expect(r.aspect).toBe(ASPECT.BODY);
    expect(r.candidate_kind).toBe(CANDIDATE_KIND.SINGLE);
    expect(r.enclosure_type).toBe("f1-body");
    expect(r.slow).toContain("(function () {");
    expect(r.slow).toContain("% 2 === 0");
    expect(r.fast).toContain("& 1 === 0");
    expect(r.setup).toContain("var keys = [1, 2, 3]");
    expect(r.setup).not.toContain("execute"); // 計測ハーネスは setup に残らない
  });

  it("lib 変化 + body 変化 → aspect A+B, 2 candidate (lib / body) に分割", () => {
    const results = extract({
      kind: "client",
      before_inline: inlineBefore,
      after_inline: inlineAfter,
      lib_before_files: { "lib.js": "function helper() { return index % 2 == 0; }" },
      lib_after_files: { "lib.js": "function helper() { return index & 1 == 0; }" },
      lib_kind: "file",
      lib_referenced_by_workload: false,
    });
    expect(results).toHaveLength(2);
    expect(results.map((r) => r.aspect)).toEqual([ASPECT.BOTH, ASPECT.BOTH]);
    expect(results.map((r) => r.candidate_kind).sort()).toEqual([CANDIDATE_KIND.BODY, CANDIDATE_KIND.LIB]);
  });

  it("f1 が無い inline は fallback (Tier 1 の素の top-level diff)", () => {
    const results = extract({
      kind: "client",
      before_inline: "function g() { return arr[0]; }",
      after_inline: "function g() { return arr[1]; }",
      lib_before_files: {},
      lib_after_files: {},
      lib_kind: null,
      lib_referenced_by_workload: false,
    });
    expect(results[0]?.aspect).toBe(ASPECT.FALLBACK);
  });
});

describe("extract — server (test_case)", () => {
  it("test() body 変化 → aspect B, runnable program を slow/fast に, jsdom hint", () => {
    const before = `(function () { function init() { return 1; } function test(i) { return i % 2; } exports.init = init; exports.test = test; })();`;
    const after = `(function () { function init() { return 1; } function test(i) { return i & 1; } exports.init = init; exports.test = test; })();`;
    const results = extract({
      kind: "server",
      before_test_case: before,
      after_test_case: after,
      lib_before_files: {},
      lib_after_files: {},
      lib_kind: null,
    });
    expect(results).toHaveLength(1);
    const r = results[0]!;
    expect(r.layout).toBe("server");
    expect(r.aspect).toBe(ASPECT.BODY);
    expect(r.environment).toBe("jsdom");
    expect(r.enclosure_type).toBe("server-test-case");
    expect(r.slow).toContain("i % 2");
    expect(r.fast).toContain("i & 1");
    expect(r.slow).toContain("exports.test"); // test_case 全文が runnable に含まれる
  });

  it("test_case が無いと fallback (lib top-level diff)", () => {
    const results = extract({
      kind: "server",
      before_test_case: null,
      after_test_case: null,
      lib_before_files: { "x.js": "module.exports = function () { return 1; };" },
      lib_after_files: { "x.js": "module.exports = function () { return 2; };" },
      lib_kind: "file",
    });
    expect(results[0]?.aspect).toBe(ASPECT.FALLBACK);
  });
});
