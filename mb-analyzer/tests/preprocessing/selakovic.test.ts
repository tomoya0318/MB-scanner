/**
 * 対象: ADR-0011 Tier 2 の公開 API `preprocess()` — `(setup, slow, fast)` 組み立ての契約。
 * 観点: 計測ハーネスを剥がして `f1`/`test()` body を slow/fast の母集団に取り、lib と body の
 *       実コード差で A / B / A+B / fallback に振り分け、A+B は ADR-0014 で independent なら 2 candidate、
 *       co-evolution の疑いなら 1 candidate にする。wrapper kind (top-level / Angular controller) と
 *       ADR-0013 (反復回数は書き換えない) も合わせて確認する。
 * 判定事項 (= ADR-0011 §段2 ルーティング × wrapper kind × ADR-0013):
 *   - client / 作用点 A (lib 変化・body 不変)            → 1 candidate (single, aspect A), lib varies / body fixed@before, enclosure = lib-file
 *   - client / 作用点 B (lib 不変・body 変化)            → 1 candidate (single, aspect B), body は IIFE 包み, setup に計測ハーネス残らない, enclosure = f1-body
 *   - client / 作用点 A+B independent                  → 2 candidate (candidate_kind = lib / body)
 *   - client / 作用点 A+B co-evolution の疑い            → 1 candidate (single, aspect A+B), enclosure = lib-file+f1-body
 *   - client / Angular controller-wrapper の f1         → angular bootstrap runnable (module/controller 再構成 + f1() 1 回実行), enclosure = angular-controller-wrapper
 *   - client / `f1` body 内のループ反復回数 (ADR-0011 §段1) → 書き換えない (`for (i < 50000)` がそのまま slow/fast に乗る。縮小は ADR-0017 の sandbox 側 transform)
 *   - client / `f1` 不在 (規約外フォーマット)            → fallback (Tier 1 素の top-level diff, aspect = fallback)
 *   - server / 作用点 B (`test()` body 変化)             → 1 candidate, test_case 全文を runnable program 化, environment = jsdom
 *   - server / 作用点 A (lib 変化・`test()` 不変)         → 1 candidate (aspect A), init() の require が _before↔_after で切替
 *   - server / `test_case_*.js` 不在                    → fallback (lib top-level diff, aspect = fallback)
 *
 * モジュール単位の役割分解・ルーティング (extractF1 / extractTest / diffLibPair / routeAspect /
 * isIndependent / runnable builder 等) は各ファイルの in-source testing (`if (import.meta.vitest)` ブロック) 参照
 * — ADR-0007 (export していない = モジュール内共有ヘルパは in-source)。
 */
import { describe, expect, it } from "vitest";

import { ASPECT, CANDIDATE_KIND } from "../../src/contracts/preprocessing-contracts";
import { preprocess } from "../../src/preprocessing/selakovic";

describe("preprocess — client / top-level f1", () => {
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

  it("作用点 B: lib なし・body 変化 → aspect B, 1 candidate, body は IIFE 包み, setup に計測ハーネス残らない", () => {
    const results = preprocess({
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

  it("作用点 A: lib 変化・body 不変 → aspect A, 1 candidate (single), lib varies / body fixed@before", () => {
    const results = preprocess({
      kind: "client",
      before_inline: inlineBefore,
      after_inline: inlineBefore, // inline (f1 body + preF1) は不変、lib だけが変わる
      lib_before_files: { "lib.js": "function helper() {\n  return index % 2 == 0;\n}" },
      lib_after_files: { "lib.js": "function helper() {\n  return index & 1 == 0;\n}" },
      lib_kind: "file",
      lib_referenced_by_workload: true,
    });
    expect(results).toHaveLength(1);
    const r = results[0]!;
    expect(r.aspect).toBe(ASPECT.LIB);
    expect(r.candidate_kind).toBe(CANDIDATE_KIND.SINGLE);
    expect(r.enclosure_type).toBe("lib-file");
    expect(r.setup).toBe(""); // lib が runnable 本体に入るので setup は空
    expect(r.slow).toContain("index % 2 == 0"); // lib_before
    expect(r.fast).toContain("index & 1 == 0"); // lib_after
    expect(r.slow).toContain("keys[i] % 2 === 0"); // f1 body — slow/fast 両側とも before のまま固定
    expect(r.fast).toContain("keys[i] % 2 === 0");
  });

  it("作用点 A+B co-evolution: body の参照 identifier が lib 変更関数名と交差 → 1 candidate (single, A+B)", () => {
    const results = preprocess({
      kind: "client",
      before_inline: `
        var data = [1, 2, 3];
        var f1 = function () { ngRepeatAction(data, 0); };
        var a = execute(f1, 10);
      `,
      after_inline: `
        var data = [1, 2, 3];
        var f1 = function () { ngRepeatAction(data, 1); };
        var a = execute(f1, 10);
      `,
      lib_before_files: { "lib.js": "function ngRepeatAction(arr, k) {\n  return arr[k] % 2 == 0;\n}" },
      lib_after_files: { "lib.js": "function ngRepeatAction(arr, k) {\n  return arr[k] & 1 == 0;\n}" },
      lib_kind: "file",
      lib_referenced_by_workload: true,
    });
    expect(results).toHaveLength(1);
    const r = results[0]!;
    expect(r.aspect).toBe(ASPECT.BOTH);
    expect(r.candidate_kind).toBe(CANDIDATE_KIND.SINGLE);
    expect(r.enclosure_type).toBe("lib-file+f1-body");
    expect(r.slow).toContain("ngRepeatAction(data, 0)"); // body も
    expect(r.fast).toContain("ngRepeatAction(data, 1)");
    expect(r.slow).toContain("arr[k] % 2 == 0"); // lib も同時に変わる
    expect(r.fast).toContain("arr[k] & 1 == 0");
  });

  it("ループ反復回数は書き換えない (ADR-0011 §段1): for (i < 50000) がそのまま slow/fast に乗る", () => {
    const results = preprocess({
      kind: "client",
      before_inline: `
        var arr = [];
        var f1 = function () { for (var i = 0; i < 50000; i++) arr.push(i); };
        var a = execute(f1, 10);
      `,
      after_inline: `
        var arr = [];
        var f1 = function () { for (var i = 0; i < 50000; i++) arr.unshift(i); };
        var a = execute(f1, 10);
      `,
      lib_before_files: {},
      lib_after_files: {},
      lib_kind: null,
      lib_referenced_by_workload: false,
    });
    expect(results).toHaveLength(1);
    const r = results[0]!;
    expect(r.aspect).toBe(ASPECT.BODY);
    expect(r.slow).toMatch(/i\s*<\s*50000/); // 反復上限は原文どおり — 縮小は等価検証 sandbox の iteration-cap transform (ADR-0017) に委ねる
    expect(r.fast).toMatch(/i\s*<\s*50000/);
    expect(r.slow).toContain("arr.push");
    expect(r.fast).toContain("arr.unshift");
    expect(r.setup).toContain("var arr = []"); // preF1 statement は setup へ
    expect(r.setup).not.toContain("execute");
  });

  it("f1 が無い inline は fallback (Tier 1 の素の top-level diff)", () => {
    const results = preprocess({
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

  it("作用点 A+B independent: body の参照 identifier が lib 変更関数名と交差しない → 2 candidate (lib / body)", () => {
    const results = preprocess({
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
});

describe("preprocess — client / Angular controller-wrapper", () => {
  const wrap = (cmp: string): string => `
    var app = angular.module("benchApp", []);
    app.controller("BenchCtrl", function ($scope) {
      var keys = [1, 2, 3];
      var f1 = function () { for (var i = 0; i < keys.length; i++) keys[i] ${cmp} 0; };
      var a = execute(f1, 10);
      var mean = jStat(a).mean();
    });
  `;

  it("f1 が app.controller(...) 内 → module/controller を再構成し f1() を 1 回実行する自己完結 runnable", () => {
    const results = preprocess({
      kind: "client",
      before_inline: wrap("% 2 ==="),
      after_inline: wrap("& 1 ==="),
      lib_before_files: {},
      lib_after_files: {},
      lib_kind: null,
      lib_referenced_by_workload: false,
    });
    expect(results).toHaveLength(1);
    const r = results[0]!;
    expect(r.aspect).toBe(ASPECT.BODY);
    expect(r.candidate_kind).toBe(CANDIDATE_KIND.SINGLE);
    expect(r.enclosure_type).toBe("angular-controller-wrapper");
    expect(r.environment).toBe("jsdom");
    expect(r.setup).toBe("");
    expect(r.slow).toContain('angular.module("benchApp", [])');
    expect(r.slow).toContain('.controller("BenchCtrl", function ($scope) {');
    expect(r.slow).toContain("globalThis.__selakovic_f1 = f1");
    expect(r.slow).toContain("% 2");
    expect(r.fast).toContain("& 1");
    expect(r.slow).not.toContain("execute"); // 計測ハーネスは bootstrap に混ざらない
    expect(r.slow).not.toContain("jStat");
  });
});

describe("preprocess — server (test_case)", () => {
  it("作用点 B: test() body 変化 → aspect B, runnable program を slow/fast に, jsdom hint", () => {
    const before = `(function () { function init() { return 1; } function test(i) { return i % 2; } exports.init = init; exports.test = test; })();`;
    const after = `(function () { function init() { return 1; } function test(i) { return i & 1; } exports.init = init; exports.test = test; })();`;
    const results = preprocess({
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

  it("作用点 A: lib 変化・test() body 不変 → aspect A, init() の require が _before↔_after で切替", () => {
    const before = `(function () { function init() { return require('./mylib_before'); } function test(lib) { return lib.compute(3); } exports.init = init; exports.test = test; })();`;
    const after = `(function () { function init() { return require('./mylib_after'); } function test(lib) { return lib.compute(3); } exports.init = init; exports.test = test; })();`;
    const results = preprocess({
      kind: "server",
      before_test_case: before,
      after_test_case: after,
      lib_before_files: { "mylib.js": "module.exports = { compute: function (x) {\n  return x * 2;\n} };" },
      lib_after_files: { "mylib.js": "module.exports = { compute: function (x) {\n  return x << 1;\n} };" },
      lib_kind: "file",
    });
    expect(results).toHaveLength(1);
    const r = results[0]!;
    expect(r.layout).toBe("server");
    expect(r.aspect).toBe(ASPECT.LIB);
    expect(r.candidate_kind).toBe(CANDIDATE_KIND.SINGLE);
    expect(r.enclosure_type).toBe("server-test-case");
    expect(r.slow).toContain("require('./mylib_before')");
    expect(r.fast).toContain("require('./mylib_after')");
    expect(r.slow).toContain("lib.compute(3)"); // test() body は両側同じ
    expect(r.fast).toContain("lib.compute(3)");
  });

  it("test_case が無いと fallback (lib top-level diff)", () => {
    const results = preprocess({
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
