/**
 * 対象: ADR-0011 Tier 2 の公開 API `preprocess()` — `(setup, slow, fast)` 組み立ての契約。
 * 観点: 計測ハーネスを剥がして `f1`/`test()` body を slow/fast の母集団に取り、lib と body の
 *       実コード差で lib / workload / lib+workload / fallback に振り分け、A+B は ADR-0014 で independent なら 2 candidate、
 *       co-evolution の疑いなら 1 candidate にする。wrapper kind (top-level / Angular controller) と
 *       ADR-0013 (反復回数は書き換えない) も合わせて確認する。
 * 判定事項 (= ADR-0011 §段2 ルーティング × wrapper kind × ADR-0013):
 *   - client / 作用点 lib (lib 変化・body 不変)            → 1 candidate (single, aspect lib), lib varies / body fixed@before, enclosure = lib-file
 *   - client / 作用点 workload (lib 不変・body 変化)            → 1 candidate (single, aspect workload), body は IIFE 包み, setup に計測ハーネス残らない, enclosure = f1-body
 *   - client / 作用点 lib+workload independent                  → 2 candidate (candidate_kind = lib / body)
 *   - client / 作用点 lib+workload co-evolution の疑い            → 1 candidate (single, aspect lib+workload), enclosure = lib-file+f1-body
 *   - client / Angular controller-wrapper の f1         → angular bootstrap runnable (module/controller 再構成 + f1() 1 回実行), enclosure = angular-controller-wrapper
 *   - client / `f1` body 内のループ反復回数 (ADR-0011 §段1) → 書き換えない (`for (i < 50000)` がそのまま slow/fast に乗る。縮小は ADR-0017 の sandbox 側 transform)
 *   - client / `f1` 不在 (規約外フォーマット)            → fallback (Tier 1 素の top-level diff, aspect = fallback)
 *   - server / 作用点 workload (`test()` body 変化)             → 1 candidate, test_case 全文を runnable program 化, environment = jsdom
 *   - server / 作用点 lib (lib 変化・`test()` 不変)         → 1 candidate (aspect lib), init() の require が _before↔_after で切替
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

  it("作用点 workload: lib なし・body 変化 → aspect workload, 1 candidate, body は IIFE 包み, setup に計測ハーネス残らない", () => {
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
    expect(r.aspect).toBe(ASPECT.WORKLOAD);
    expect(r.candidate_kind).toBe(CANDIDATE_KIND.SINGLE);
    expect(r.enclosure_type).toBe("f1-body");
    expect(r.slow).toContain("(function () {");
    expect(r.slow).toContain("% 2 === 0");
    expect(r.fast).toContain("& 1 === 0");
    expect(r.setup).toContain("var keys = [1, 2, 3]");
    expect(r.setup).not.toContain("execute"); // 計測ハーネスは setup に残らない
  });

  it("作用点 lib: lib 変化・body 不変 + f1 が変更 lib 関数を呼ばない → embedded #0 のみ (changed-fn は Phase 2 reachability で DROP)", () => {
    const results = preprocess({
      kind: "client",
      before_inline: inlineBefore, // f1 body = keys[i] % 2 === 0 — lib (helpers.even) を一度も呼んでいない
      after_inline: inlineBefore, // inline (f1 body + preWorkload) は不変、lib だけが変わる
      lib_before_files: {
        "lib.js": "var helpers = {};\nhelpers.even = function (index) { return index % 2 == 0; };\nhelpers.label = 'v1';",
      },
      lib_after_files: {
        "lib.js": "var helpers = {};\nhelpers.even = function (index) { return index & 1 == 0; };\nhelpers.label = 'v1';",
      },
      lib_kind: "file",
      lib_referenced_by_workload: true,
    });
    expect(results).toHaveLength(1); // changed-fn は出ない: f1 が helpers.even を (推移的にも) 呼ばないので reachability で DROP
    const embedded = results[0]!;
    expect(embedded.aspect).toBe(ASPECT.LIB);
    expect(embedded.candidate_kind).toBe(CANDIDATE_KIND.SINGLE);
    expect(embedded.enclosure_type).toBe("lib-file");
    expect(embedded.setup).toBe(""); // lib が runnable 本体に入るので setup は空
    expect(embedded.slow).toContain("var helpers = {}"); // lib 全文が slow に埋まる
    expect(embedded.slow).toContain("index % 2 == 0"); // lib_before
    expect(embedded.fast).toContain("index & 1 == 0"); // lib_after
    expect(embedded.slow).toContain("keys[i] % 2 === 0"); // f1 body — slow/fast 両側とも before のまま固定
    expect(embedded.fast).toContain("keys[i] % 2 === 0");
  });

  it("作用点 lib: f1 が変更 lib 関数を呼ぶ → embedded #0 + changed-fn #1 (lambda-lift + 観測する形)", () => {
    const libBefore = "var slice = [].slice;\nvar lib = {};\nlib.norm = function (x) { return slice.call([x]).length % 2 === 0; };\nlib.unused = function () { return 0; };";
    const libAfter = "var slice = [].slice;\nvar lib = {};\nlib.norm = function (x) { return slice.call([x]).length & 1 === 0; };\nlib.unused = function () { return 0; };";
    const inlineCallsLib = `
      var f1 = function () { for (var i = 0; i < 3; i++) lib.norm(i); };
      var a = execute(f1, 10);
    `;
    const results = preprocess({
      kind: "client",
      before_inline: inlineCallsLib,
      after_inline: inlineCallsLib, // inline は不変、lib だけが変わる (aspect lib)
      lib_before_files: { "lib.js": libBefore },
      lib_after_files: { "lib.js": libAfter },
      lib_kind: "file",
      lib_referenced_by_workload: true,
    });
    // #0 = embedded (lib 全文 slow/fast)、#1 = changed-fn (lib.norm を取り出した小候補)。lib.unused は変わってないので候補にならない。
    expect(results).toHaveLength(2);
    expect(results.map((r) => r.candidate_kind)).toEqual([CANDIDATE_KIND.SINGLE, CANDIDATE_KIND.CHANGED_FN]);
    expect(results.every((r) => r.aspect === ASPECT.LIB)).toBe(true);

    const embedded = results[0]!;
    expect(embedded.enclosure_type).toBe("lib-file");
    expect(embedded.before_node_count).toBeGreaterThan(0);

    const cf = results[1]!;
    expect(cf.candidate_kind).toBe(CANDIDATE_KIND.CHANGED_FN);
    expect(cf.enclosure_type).toBe("FunctionExpression"); // lib.norm = function(){...}
    // setup = lib 全文 (norm だけ穴あき + ガード + after 本体インライン fallback) + preWorkload (空)
    expect(cf.setup).toContain("var slice = [].slice;");
    expect(cf.setup).toContain("var lib = {};");
    expect(cf.setup).toContain("globalThis.__HOLE__.call(this, slice, x)"); // 内部依存 slice が lambda-lift で引数化
    expect(cf.setup).toContain("& 1 === 0"); // after 本体はインライン fallback として残る
    // slow = __HOLE__ に変更前の本体 (% 2 === 0) + 観測ラッパ + workload (lib.norm を呼ぶ)
    expect(cf.slow).toContain("function (slice, x)");
    expect(cf.slow).toContain("% 2 === 0");
    expect(cf.slow).toContain("globalThis.__OBS");
    expect(cf.slow).toContain("lib.norm(i);");
    expect(cf.slow).not.toContain("var lib = {};"); // lib は setup 側、slow には入らない
    // fast = __HOLE__ に変更後の本体
    expect(cf.fast).toContain("& 1 === 0");
    expect(cf.fast).toContain("lib.norm(i);");
    // node count は変更関数本体のサイズ — embedded (= inline 全文) より小さい
    expect(cf.before_node_count).toBeGreaterThan(0);
    expect(cf.before_node_count).toBeLessThan(embedded.before_node_count!);
  });

  it("作用点 lib: dep_lib_sources は全候補の setup 先頭に連結される (`<script src>` CDN dep)", () => {
    const libBefore = "var lib = {};\nlib.norm = function (x) { return x % 2 === 0; };";
    const libAfter = "var lib = {};\nlib.norm = function (x) { return x & 1 === 0; };";
    const inlineCallsLib = `
      var f1 = function () { lib.norm(1); };
      var a = execute(f1, 10);
    `;
    const results = preprocess({
      kind: "client",
      before_inline: inlineCallsLib,
      after_inline: inlineCallsLib,
      lib_before_files: { "lib.js": libBefore },
      lib_after_files: { "lib.js": libAfter },
      lib_kind: "file",
      lib_referenced_by_workload: true,
      dep_lib_sources: ["/* jquery 2.1.3 stub */\nvar jQuery = {};", "/* handlebars 1.1.0 stub */\nvar Handlebars = {};"],
    });
    expect(results.length).toBeGreaterThanOrEqual(2); // embedded #0 + changed-fn #1
    for (const r of results) {
      // 全候補の setup 先頭に dep が <script> 順で入る
      expect(r.setup).toContain("/* jquery 2.1.3 stub */");
      expect(r.setup).toContain("/* handlebars 1.1.0 stub */");
      expect(r.setup!.indexOf("jquery 2.1.3 stub")).toBeLessThan(r.setup!.indexOf("handlebars 1.1.0 stub"));
    }
    // embedded の setup は dep だけ (lib は slow/fast 側) / changed-fn の setup は dep + 穴あき lib + preWorkload
    const embedded = results.find((r) => r.candidate_kind === CANDIDATE_KIND.SINGLE)!;
    expect(embedded.setup).toMatch(/^\/\* jquery 2\.1\.3 stub \*\//);
    const cf = results.find((r) => r.candidate_kind === CANDIDATE_KIND.CHANGED_FN)!;
    expect(cf.setup).toMatch(/^\/\* jquery 2\.1\.3 stub \*\//);
    expect(cf.setup).toContain("globalThis.__HOLE__.call"); // dep の後に穴あき lib も来る
  });

  it("作用点 lib: 変更が複数 top-level 関数にまたがっても embedded (#0) が出る", () => {
    const results = preprocess({
      kind: "client",
      before_inline: inlineBefore,
      after_inline: inlineBefore,
      lib_before_files: { "lib.js": "function helperA() { return a1; }\nfunction helperB() { return b1; }" },
      lib_after_files: { "lib.js": "function helperA() { return a2; }\nfunction helperB() { return b2; }" },
      lib_kind: "file",
      lib_referenced_by_workload: true,
    });
    expect(results).toHaveLength(1);
    expect(results[0]!.candidate_kind).toBe(CANDIDATE_KIND.SINGLE);
    expect(results[0]!.enclosure_type).toBe("lib-file");
  });

  it("作用点 lib+workload co-evolution: body の参照 identifier が lib 変更関数名と交差 → 1 candidate (single, A+B)", () => {
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
    expect(r.aspect).toBe(ASPECT.WORKLOAD);
    expect(r.slow).toMatch(/i\s*<\s*50000/); // 反復上限は原文どおり — 縮小は等価検証 sandbox の iteration-cap transform (ADR-0017) に委ねる
    expect(r.fast).toMatch(/i\s*<\s*50000/);
    expect(r.slow).toContain("arr.push");
    expect(r.fast).toContain("arr.unshift");
    expect(r.setup).toContain("var arr = []"); // preWorkload statement は setup へ
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

  it("作用点 lib+workload independent: body の参照 identifier が lib 変更関数名と交差しない → lib / body の 2 candidate (ADR-0014 split)", () => {
    // 注: Phase 2b-ii で lib 側にも changed-fn 候補が追加される予定。
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
    expect(results.map((r) => r.candidate_kind)).toEqual([CANDIDATE_KIND.LIB, CANDIDATE_KIND.BODY]);
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
    expect(r.aspect).toBe(ASPECT.WORKLOAD);
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
  it("作用点 workload: test() body 変化 → aspect workload, runnable program を slow/fast に, jsdom hint", () => {
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
    expect(r.aspect).toBe(ASPECT.WORKLOAD);
    expect(r.environment).toBe("jsdom");
    expect(r.enclosure_type).toBe("server-test-case");
    expect(r.slow).toContain("i % 2");
    expect(r.fast).toContain("i & 1");
    expect(r.slow).toContain("exports.test"); // test_case 全文が runnable に含まれる
  });

  it("作用点 lib: lib 変化・test() body 不変 → aspect lib, init() の require が _before↔_after で切替", () => {
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
