/**
 * 対象: ADR-0011 Tier 2 の公開 API `preprocess()` — 1 issue → 1 IssueResult (内部に candidates: list) の契約 (ADR-0024)。
 * 観点: 計測ハーネスを剥がして `f1`/`test()` body を slow/fast の母集団に取り、lib と body の
 *       実コード差で lib / workload / lib+workload / fallback に振り分け、A+B は ADR-0014 で independent なら 2 candidate、
 *       co-evolution の疑いなら 1 candidate にする。wrapper kind (top-level / Angular controller) と
 *       ADR-0013 (反復回数は書き換えない) も合わせて確認する。
 *
 * ADR-0024 で旧 `candidate_kind` / `enclosure_type` (戦略ラベル) / `aspect` (issue level) /
 * `environment` を adapter_meta / target_side / is_workload_reachable / enclosure_node_type に再構成。
 */
import { describe, expect, it } from "vitest";

import {
  ASPECT,
  LAYOUT_KIND,
  SELAKOVIC_EXCLUSION_REASON,
  TARGET_SIDE,
  WRAPPER_KIND,
} from "../../src/contracts/preprocessing-contracts";
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

  it("作用点 workload: lib なし・body 変化 → aspect=workload, 1 candidate (target_side=workload), body は IIFE 包み, setup に計測ハーネス残らない", () => {
    const result = preprocess({
      kind: "client",
      before_inline: inlineBefore,
      after_inline: inlineAfter,
      lib_before_files: {},
      lib_after_files: {},
      lib_kind: null,
      lib_referenced_by_workload: false,
    });
    expect(result.candidate_count).toBe(1);
    expect(result.issue_meta?.aspect).toBe(ASPECT.WORKLOAD);
    expect(result.issue_meta?.layout).toBe(LAYOUT_KIND.CLIENT);
    expect(result.issue_meta?.wrapper_kind).toBe(WRAPPER_KIND.TOP_LEVEL);
    const c = result.candidates[0]!;
    expect(c.candidate_meta.target_side).toBe(TARGET_SIDE.WORKLOAD);
    expect(c.candidate_meta.is_workload_reachable).toBe(false);
    expect(c.slow).toContain("(function () {");
    expect(c.slow).toContain("% 2 === 0");
    expect(c.fast).toContain("& 1 === 0");
    expect(c.setup).toContain("var keys = [1, 2, 3]");
    expect(c.setup).not.toContain("execute"); // 計測ハーネスは setup に残らない
  });

  it("作用点 lib: lib 変化・body 不変 + f1 が変更 lib 関数を呼ばない → embedded #0 + change-not-exercised marker #1", () => {
    const result = preprocess({
      kind: "client",
      before_inline: inlineBefore,
      after_inline: inlineBefore,
      lib_before_files: {
        "lib.js": "var helpers = {};\nhelpers.even = function (index) { return index % 2 == 0; };\nhelpers.label = 'v1';",
      },
      lib_after_files: {
        "lib.js": "var helpers = {};\nhelpers.even = function (index) { return index & 1 == 0; };\nhelpers.label = 'v1';",
      },
      lib_kind: "file",
      lib_referenced_by_workload: true,
    });
    // #0 = embedded (lib 全文)、#1 = workload が helpers.even を呼ばないので change-not-exercised marker
    expect(result.candidate_count).toBe(2);
    expect(result.issue_meta?.aspect).toBe(ASPECT.LIB);

    const embedded = result.candidates[0]!;
    expect(embedded.candidate_meta.target_side).toBe(TARGET_SIDE.LIB);
    expect(embedded.candidate_meta.is_workload_reachable).toBe(false);
    expect(embedded.candidate_excluded).toBeUndefined();
    expect(embedded.setup).toBe(""); // lib が runnable 本体に入るので setup は空
    expect(embedded.slow).toContain("var helpers = {}"); // lib 全文が slow に埋まる
    expect(embedded.slow).toContain("index % 2 == 0"); // lib_before
    expect(embedded.fast).toContain("index & 1 == 0"); // lib_after
    expect(embedded.slow).toContain("keys[i] % 2 === 0"); // f1 body — slow/fast 両側とも before のまま固定
    expect(embedded.fast).toContain("keys[i] % 2 === 0");

    const excluded = result.candidates[1]!;
    expect(excluded.candidate_excluded).toBe(SELAKOVIC_EXCLUSION_REASON.CHANGE_NOT_EXERCISED);
    expect(excluded.candidate_meta.target_side).toBe(TARGET_SIDE.LIB);
    expect(excluded.candidate_meta.is_workload_reachable).toBe(false);
    expect(excluded.setup).toBeUndefined();
    expect(excluded.slow).toBeUndefined();
    expect(excluded.fast).toBeUndefined();
    expect(excluded.before_node_count).toBeUndefined();
    expect(excluded.after_node_count).toBeUndefined();
  });

  it("作用点 lib: f1 が変更 lib 関数を呼ぶ → embedded #0 + changed-fn #1 (4 値契約: setup に観測ハーネス + $BODY$ / slow・fast は裸 body / workload に IIFE)", () => {
    const libBefore = "var slice = [].slice;\nvar lib = {};\nlib.norm = function (x) { return slice.call([x]).length % 2 === 0; };\nlib.unused = function () { return 0; };";
    const libAfter = "var slice = [].slice;\nvar lib = {};\nlib.norm = function (x) { return slice.call([x]).length & 1 === 0; };\nlib.unused = function () { return 0; };";
    const inlineCallsLib = `
      var f1 = function () { for (var i = 0; i < 3; i++) lib.norm(i); };
      var a = execute(f1, 10);
    `;
    const result = preprocess({
      kind: "client",
      before_inline: inlineCallsLib,
      after_inline: inlineCallsLib,
      lib_before_files: { "lib.js": libBefore },
      lib_after_files: { "lib.js": libAfter },
      lib_kind: "file",
      lib_referenced_by_workload: true,
    });
    // #0 = embedded (target_side=lib, is_workload_reachable=false), #1 = changed-fn (target_side=lib, is_workload_reachable=true)
    expect(result.candidate_count).toBe(2);
    expect(result.issue_meta?.aspect).toBe(ASPECT.LIB);
    expect(result.candidates.every((c) => c.candidate_meta.target_side === TARGET_SIDE.LIB)).toBe(true);
    expect(result.candidates.map((c) => c.candidate_meta.is_workload_reachable)).toEqual([false, true]);

    const embedded = result.candidates[0]!;
    expect(embedded.before_node_count).toBeGreaterThan(0);
    expect(embedded.workload).toBeUndefined(); // embedded は旧経路 = workload 無し

    const cf = result.candidates[1]!;
    expect(cf.enclosure_node_type).toBe("FunctionExpression"); // lib.norm = function(){...}

    // setup = lib 全文 (norm body の位置に観測ハーネス + $BODY$ 1 個入り) + preWorkload (空)
    expect(cf.setup).toContain("var slice = [].slice;");
    expect(cf.setup).toContain("var lib = {};");
    expect(cf.setup).toContain("$BODY$");
    expect((cf.setup!.match(/\$BODY\$/g) ?? []).length).toBe(1);
    expect(cf.setup).toContain("lib.unused"); // 変更外の関数は原形のまま残る
    // 観測ハーネスが setup 側に inline 化されている (ADR-0023 D-δ)
    expect(cf.setup).toContain("let __OBS_R__");
    expect(cf.setup).toContain("__OBS__.push");
    expect(cf.setup).toContain("return __OBS_R__;");
    expect(cf.setup).not.toContain("globalThis.__OBS"); // 単独参照 (top-level let __OBS__ を closure 経由)
    // v1 残骸が消えていること
    expect(cf.setup).not.toContain("globalThis.__HOLE__");
    expect(cf.setup).not.toContain("& 1 === 0"); // body は $BODY$ で穴あき、after 本体は残らない

    // slow: 変更前 body (% 2 === 0) の裸 statement 列 (= 観測ハーネス無し、lib 宣言も含まない)
    expect(cf.slow).toContain("% 2 === 0");
    expect(cf.slow).not.toContain("__OBS_R__"); // 観測ハーネスは setup 側に移動
    expect(cf.slow).not.toContain("__OBS__.push");
    expect(cf.slow).not.toContain("var lib = {};");
    expect(cf.slow).not.toContain("lib.norm(i);"); // workload 呼び出しは workload 側に移動

    // fast: 変更後 body (& 1 === 0) の裸 statement 列
    expect(cf.fast).toContain("& 1 === 0");
    expect(cf.fast).not.toContain("__OBS_R__");
    expect(cf.fast).not.toContain("__OBS__.push");

    // workload: __OBS__ を init → workload 呼び出し列 → JSON.stringify(__OBS__) を完了値で返す IIFE
    expect(cf.workload).toContain("(function () {");
    expect(cf.workload).toContain("__OBS__ = [];");
    expect(cf.workload).toContain("lib.norm(i);"); // workload 呼び出しはここに集約
    expect(cf.workload).toContain("return JSON.stringify(__OBS__);");

    expect(cf.before_node_count).toBeGreaterThan(0);
    expect(cf.before_node_count).toBeLessThan(embedded.before_node_count!);
  });

  it("作用点 lib: 混在 (reachable + unreachable の変更関数) → embedded #0 + changed-fn #1 + change-not-exercised marker #2", () => {
    // lib.norm は workload (f1) から呼ばれる reachable な変更関数、lib.dead はどこからも呼ばれない unreachable な変更関数
    const libBefore = "var lib = {};\nlib.norm = function (x) { return x % 2 === 0; };\nlib.dead = function (y) { return y % 3 === 0; };";
    const libAfter = "var lib = {};\nlib.norm = function (x) { return x & 1 === 0; };\nlib.dead = function (y) { return y & 3 === 0; };";
    const inlineCallsLib = `
      var f1 = function () { lib.norm(1); };
      var a = execute(f1, 10);
    `;
    const result = preprocess({
      kind: "client",
      before_inline: inlineCallsLib,
      after_inline: inlineCallsLib,
      lib_before_files: { "lib.js": libBefore },
      lib_after_files: { "lib.js": libAfter },
      lib_kind: "file",
      lib_referenced_by_workload: true,
    });
    expect(result.candidate_count).toBe(3);
    expect(result.issue_meta?.aspect).toBe(ASPECT.LIB);

    const embedded = result.candidates[0]!;
    expect(embedded.candidate_meta.is_workload_reachable).toBe(false);
    expect(embedded.candidate_excluded).toBeUndefined();

    const reachable = result.candidates[1]!;
    expect(reachable.candidate_meta.target_side).toBe(TARGET_SIDE.LIB);
    expect(reachable.candidate_meta.is_workload_reachable).toBe(true);
    expect(reachable.candidate_excluded).toBeUndefined();
    expect(reachable.slow).toContain("% 2 === 0"); // norm の before

    const excluded = result.candidates[2]!;
    expect(excluded.candidate_excluded).toBe(SELAKOVIC_EXCLUSION_REASON.CHANGE_NOT_EXERCISED);
    expect(excluded.candidate_meta.is_workload_reachable).toBe(false);
    expect(excluded.setup).toBeUndefined();
  });

  it("作用点 lib: dep_lib_sources は全候補の setup 先頭に連結される (`<script src>` CDN dep)", () => {
    const libBefore = "var lib = {};\nlib.norm = function (x) { return x % 2 === 0; };";
    const libAfter = "var lib = {};\nlib.norm = function (x) { return x & 1 === 0; };";
    const inlineCallsLib = `
      var f1 = function () { lib.norm(1); };
      var a = execute(f1, 10);
    `;
    const result = preprocess({
      kind: "client",
      before_inline: inlineCallsLib,
      after_inline: inlineCallsLib,
      lib_before_files: { "lib.js": libBefore },
      lib_after_files: { "lib.js": libAfter },
      lib_kind: "file",
      lib_referenced_by_workload: true,
      dep_lib_sources: ["/* jquery 2.1.3 stub */\nvar jQuery = {};", "/* handlebars 1.1.0 stub */\nvar Handlebars = {};"],
    });
    expect(result.candidate_count).toBeGreaterThanOrEqual(2);
    for (const c of result.candidates) {
      expect(c.setup).toContain("/* jquery 2.1.3 stub */");
      expect(c.setup).toContain("/* handlebars 1.1.0 stub */");
      expect(c.setup!.indexOf("jquery 2.1.3 stub")).toBeLessThan(c.setup!.indexOf("handlebars 1.1.0 stub"));
    }
    // embedded の setup は dep だけ (lib は slow/fast 側) / changed-fn の setup は dep + 穴あき lib + preWorkload
    const embedded = result.candidates.find((c) => !c.candidate_meta.is_workload_reachable)!;
    expect(embedded.setup).toMatch(/^\/\* jquery 2\.1\.3 stub \*\//);
    const cf = result.candidates.find((c) => c.candidate_meta.is_workload_reachable)!;
    expect(cf.setup).toMatch(/^\/\* jquery 2\.1\.3 stub \*\//);
    // 4 値契約: dep prefix の後に穴あき lib が来て $BODY$ 1 個を含む
    expect(cf.setup).toContain("$BODY$");
    expect((cf.setup!.match(/\$BODY\$/g) ?? []).length).toBe(1);
    expect(cf.setup).not.toContain("globalThis.__HOLE__"); // v1 残骸が消えている
  });

  it("作用点 lib: 変更が複数 top-level 関数にまたがっても embedded (#0) が出る (unreachable な変更関数は marker として残る)", () => {
    const result = preprocess({
      kind: "client",
      before_inline: inlineBefore,
      after_inline: inlineBefore,
      lib_before_files: { "lib.js": "function helperA() { return a1; }\nfunction helperB() { return b1; }" },
      lib_after_files: { "lib.js": "function helperA() { return a2; }\nfunction helperB() { return b2; }" },
      lib_kind: "file",
      lib_referenced_by_workload: true,
    });
    // embedded #0 + helperA / helperB はどちらも workload (f1) から呼ばれない → change-not-exercised marker x2
    expect(result.candidate_count).toBe(3);
    const embedded = result.candidates[0]!;
    expect(embedded.candidate_meta.target_side).toBe(TARGET_SIDE.LIB);
    expect(embedded.candidate_meta.is_workload_reachable).toBe(false);
    expect(embedded.candidate_excluded).toBeUndefined();
    const excludedMarkers = result.candidates.slice(1);
    expect(excludedMarkers).toHaveLength(2);
    for (const m of excludedMarkers) {
      expect(m.candidate_excluded).toBe(SELAKOVIC_EXCLUSION_REASON.CHANGE_NOT_EXERCISED);
      expect(m.setup).toBeUndefined();
    }
  });

  it("作用点 lib+workload co-evolution: body の参照 identifier が lib 変更関数名と交差 → 1 candidate (target_side=both)", () => {
    const result = preprocess({
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
    expect(result.candidate_count).toBe(1);
    const c = result.candidates[0]!;
    expect(result.issue_meta?.aspect).toBe(ASPECT.BOTH);
    expect(c.candidate_meta.target_side).toBe(TARGET_SIDE.BOTH);
    expect(c.slow).toContain("ngRepeatAction(data, 0)");
    expect(c.fast).toContain("ngRepeatAction(data, 1)");
    expect(c.slow).toContain("arr[k] % 2 == 0");
    expect(c.fast).toContain("arr[k] & 1 == 0");
  });

  it("ループ反復回数は書き換えない (ADR-0011 §段1): for (i < 50000) がそのまま slow/fast に乗る", () => {
    const result = preprocess({
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
    expect(result.candidate_count).toBe(1);
    const c = result.candidates[0]!;
    expect(result.issue_meta?.aspect).toBe(ASPECT.WORKLOAD);
    expect(c.slow).toMatch(/i\s*<\s*50000/);
    expect(c.fast).toMatch(/i\s*<\s*50000/);
    expect(c.slow).toContain("arr.push");
    expect(c.fast).toContain("arr.unshift");
    expect(c.setup).toContain("var arr = []");
    expect(c.setup).not.toContain("execute");
  });

  it("f1 が無い inline は fallback (Tier 1 の素の top-level diff、target_side=both)", () => {
    const result = preprocess({
      kind: "client",
      before_inline: "function g() { return arr[0]; }",
      after_inline: "function g() { return arr[1]; }",
      lib_before_files: {},
      lib_after_files: {},
      lib_kind: null,
      lib_referenced_by_workload: false,
    });
    expect(result.issue_meta?.aspect).toBe(ASPECT.FALLBACK);
    if (result.candidates.length > 0) {
      expect(result.candidates[0]!.candidate_meta.target_side).toBe(TARGET_SIDE.BOTH);
    }
  });

  it("作用点 lib+workload independent: body の参照 identifier が lib 変更関数名と交差しない → lib / workload の 2 candidate (ADR-0014 split) + helper は unreachable で marker", () => {
    const result = preprocess({
      kind: "client",
      before_inline: inlineBefore,
      after_inline: inlineAfter,
      lib_before_files: { "lib.js": "function helper() { return index % 2 == 0; }" },
      lib_after_files: { "lib.js": "function helper() { return index & 1 == 0; }" },
      lib_kind: "file",
      lib_referenced_by_workload: false,
    });
    // #0 lib (embedded) + #1 workload (body) + #2 helper は workload (f1) から呼ばれない → change-not-exercised marker
    expect(result.candidate_count).toBe(3);
    expect(result.issue_meta?.aspect).toBe(ASPECT.BOTH);
    expect(result.candidates.map((c) => c.candidate_meta.target_side)).toEqual([
      TARGET_SIDE.LIB,
      TARGET_SIDE.WORKLOAD,
      TARGET_SIDE.LIB,
    ]);
    const marker = result.candidates[2]!;
    expect(marker.candidate_excluded).toBe(SELAKOVIC_EXCLUSION_REASON.CHANGE_NOT_EXERCISED);
    expect(marker.setup).toBeUndefined();
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

  it("f1 が app.controller(...) 内 → wrapper_kind=angular_controller_wrapper, module/controller を再構成", () => {
    const result = preprocess({
      kind: "client",
      before_inline: wrap("% 2 ==="),
      after_inline: wrap("& 1 ==="),
      lib_before_files: {},
      lib_after_files: {},
      lib_kind: null,
      lib_referenced_by_workload: false,
    });
    expect(result.candidate_count).toBe(1);
    const c = result.candidates[0]!;
    expect(result.issue_meta?.aspect).toBe(ASPECT.WORKLOAD);
    expect(result.issue_meta?.wrapper_kind).toBe(WRAPPER_KIND.ANGULAR_CONTROLLER_WRAPPER);
    expect(c.candidate_meta.target_side).toBe(TARGET_SIDE.WORKLOAD);
    expect(c.setup).toBe("");
    expect(c.slow).toContain('angular.module("benchApp", [])');
    expect(c.slow).toContain('.controller("BenchCtrl", function ($scope) {');
    expect(c.slow).toContain("globalThis.__selakovic_f1 = f1");
    expect(c.slow).toContain("% 2");
    expect(c.fast).toContain("& 1");
    expect(c.slow).not.toContain("execute");
    expect(c.slow).not.toContain("jStat");
  });

  it("作用点 lib: controller 内 f1 が変更 lib 関数を呼ぶ → angular changed-fn candidate に救済 (案 C'、ADR-0023 §順 2-1)", () => {
    const libBefore = "var slice = [].slice;\nvar lib = {};\nlib.norm = function (x) { return slice.call([x]).length % 2 === 0; };";
    const libAfter = "var slice = [].slice;\nvar lib = {};\nlib.norm = function (x) { return slice.call([x]).length & 1 === 0; };";
    const angularCallsLib = `
      var app = angular.module("benchApp", []);
      app.controller("BenchCtrl", function ($scope) {
        var f1 = function () { for (var i = 0; i < 3; i++) lib.norm(i); };
        var a = execute(f1, 10);
      });
    `;
    const result = preprocess({
      kind: "client",
      before_inline: angularCallsLib,
      after_inline: angularCallsLib,
      lib_before_files: { "lib.js": libBefore },
      lib_after_files: { "lib.js": libAfter },
      lib_kind: "file",
      lib_referenced_by_workload: true,
    });
    expect(result.issue_meta?.aspect).toBe(ASPECT.LIB);
    expect(result.issue_meta?.wrapper_kind).toBe(WRAPPER_KIND.ANGULAR_CONTROLLER_WRAPPER);
    // 旧挙動では angular は ANGULAR_WRAPPER_SKIP marker で DROP。本実装で changed-fn (workload_reachable=true) に救済。
    const cf = result.candidates.find((c) => c.candidate_meta.is_workload_reachable === true);
    expect(cf).toBeDefined();
    expect(cf!.candidate_excluded).toBeUndefined();
    expect(cf!.candidate_meta.target_side).toBe(TARGET_SIDE.LIB);
    // setup = holedLib (観測ハーネス + $BODY$ 1 個) + angular bootstrap (module/controller 再構成 + 実体化)
    expect((cf!.setup!.match(/\$BODY\$/g) ?? []).length).toBe(1);
    expect(cf!.setup).toContain("let __OBS_R__");
    expect(cf!.setup).toContain('angular.module("benchApp", []);');
    expect(cf!.setup).toContain('.controller("BenchCtrl", function ($scope) {');
    expect(cf!.setup).toContain("globalThis.__selakovic_f1 = f1;");
    expect(cf!.setup).toContain("__selakovic_inj.get('$controller')");
    // slow / fast は裸 body 断片、workload は f1 1 回呼び出し
    expect(cf!.slow).toContain("% 2 === 0");
    expect(cf!.fast).toContain("& 1 === 0");
    expect(cf!.workload).toContain("__OBS__ = [];");
    expect(cf!.workload).toContain("globalThis.__selakovic_f1();");
    expect(cf!.workload).toContain("return JSON.stringify(__OBS__);");
    // ANGULAR_WRAPPER_SKIP marker はもう出ない
    expect(result.candidates.some((c) => c.candidate_excluded === "angular-wrapper-skip")).toBe(false);
  });

  it("作用点 lib: controller 内 f1 が読む module-level binding の差 (stmt unit) → changed-stmt は top-level 前提なので angular は marker 止まり (Copilot #2 回帰防止)", () => {
    // changed-stmt 経路 (no-fn-unit rescue) は top-level wrapper 前提。angular の stmt unit を通すと
    // controller-scoped preWorkload/$scope を top-level で実行する invalid candidate になるため、
    // pipeline が ANGULAR_WRAPPER_SKIP marker で先弾くことを担保する。
    const libBefore = "var KEY = 'foo';\nvar lib = {};\nlib.get = function () { return KEY; };";
    const libAfter = "var KEY = 'bar';\nvar lib = {};\nlib.get = function () { return KEY; };";
    const angularReadsBinding = `
      var app = angular.module("benchApp", []);
      app.controller("BenchCtrl", function ($scope) {
        var f1 = function () { lib.get(); };
        var a = execute(f1, 10);
      });
    `;
    const result = preprocess({
      kind: "client",
      before_inline: angularReadsBinding,
      after_inline: angularReadsBinding,
      lib_before_files: { "lib.js": libBefore },
      lib_after_files: { "lib.js": libAfter },
      lib_kind: "file",
      lib_referenced_by_workload: true,
    });
    expect(result.issue_meta?.wrapper_kind).toBe(WRAPPER_KIND.ANGULAR_CONTROLLER_WRAPPER);
    // stmt unit (var KEY) は marker 止まり = 真の changed-stmt candidate (workload 付き) を作らない
    expect(result.candidates.some((c) => c.candidate_excluded === "angular-wrapper-skip")).toBe(true);
    expect(
      result.candidates.some((c) => c.candidate_meta.is_workload_reachable === true && c.workload != null),
    ).toBe(false);
  });
});

describe("preprocess — server (test_case)", () => {
  it("作用点 workload: test() body 変化 → aspect=workload, target_side=workload, runnable program を slow/fast に", () => {
    const before = `(function () { function init() { return 1; } function test(i) { return i % 2; } exports.init = init; exports.test = test; })();`;
    const after = `(function () { function init() { return 1; } function test(i) { return i & 1; } exports.init = init; exports.test = test; })();`;
    const result = preprocess({
      kind: "server",
      before_test_case: before,
      after_test_case: after,
      lib_before_files: {},
      lib_after_files: {},
      lib_kind: null,
    });
    expect(result.candidate_count).toBe(1);
    const c = result.candidates[0]!;
    expect(result.issue_meta?.layout).toBe(LAYOUT_KIND.SERVER);
    expect(result.issue_meta?.aspect).toBe(ASPECT.WORKLOAD);
    expect(c.candidate_meta.target_side).toBe(TARGET_SIDE.WORKLOAD);
    expect(c.slow).toContain("i % 2");
    expect(c.fast).toContain("i & 1");
    expect(c.slow).toContain("exports.test");
  });

  it("作用点 lib: lib 変化・test() body 不変 → embedded #0 (require 切替) + server-changed-fn candidate を append (ADR-0025、順 3-2)", () => {
    const before = `(function () { function init() { return require('./mylib_before'); } function test(lib) { return lib.compute(3); } exports.init = init; exports.test = test; })();`;
    const after = `(function () { function init() { return require('./mylib_after'); } function test(lib) { return lib.compute(3); } exports.init = init; exports.test = test; })();`;
    const result = preprocess({
      kind: "server",
      before_test_case: before,
      after_test_case: after,
      lib_before_files: { "mylib.js": "module.exports = { compute: function (x) {\n  return x * 2;\n} };" },
      lib_after_files: { "mylib.js": "module.exports = { compute: function (x) {\n  return x << 1;\n} };" },
      lib_kind: "file",
    });
    expect(result.issue_meta?.layout).toBe(LAYOUT_KIND.SERVER);
    expect(result.issue_meta?.aspect).toBe(ASPECT.LIB);
    // embedded #0: 従来どおり test_case 全文 runnable (is_workload_reachable=false、require が _before↔_after で切替)
    const embedded = result.candidates[0]!;
    expect(embedded.candidate_meta.target_side).toBe(TARGET_SIDE.LIB);
    expect(embedded.candidate_meta.is_workload_reachable).toBe(false);
    expect(embedded.slow).toContain("require('./mylib_before')");
    expect(embedded.fast).toContain("require('./mylib_after')");
    expect(embedded.slow).toContain("lib.compute(3)");
    // #1: 変更関数 compute の server-changed-fn candidate (is_workload_reachable=true で small-candidate フィルタを通る)
    const changedFn = result.candidates.find((c) => c.candidate_meta.is_workload_reachable);
    expect(changedFn).toBeDefined();
    expect(changedFn!.candidate_meta.target_side).toBe(TARGET_SIDE.LIB);
    expect((changedFn!.setup!.match(/\$BODY\$/g) ?? []).length).toBe(1);
    expect(changedFn!.setup).toContain("globalThis.__SUT__ = __mapRequire__");
    expect(changedFn!.slow).toContain("x * 2");
    expect(changedFn!.fast).toContain("x << 1");
    // 2 チャネル観測 (戻り値 r + post-state s)
    expect(changedFn!.workload).toContain("return JSON.stringify({ r: __OBS__, s: __walk__(__tc_i__, 0) });");
  });

  it("multi-file lib (index.js entry): 変更ファイル (impl.js) を特定して穴あけ、entry=index.js で map-require 救済 (ADR-0025、順 3-2)", () => {
    const before = `(function () { function init() { return require('./lib_before'); } function test(lib) { return lib.run(); } exports.init = init; exports.test = test; })();`;
    const after = `(function () { function init() { return require('./lib_after'); } function test(lib) { return lib.run(); } exports.init = init; exports.test = test; })();`;
    const result = preprocess({
      kind: "server",
      before_test_case: before,
      after_test_case: after,
      lib_before_files: { "index.js": "module.exports = require('./impl');", "impl.js": "exports.run = function () { return 1; };" },
      lib_after_files: { "index.js": "module.exports = require('./impl');", "impl.js": "exports.run = function () { return 2; };" },
      lib_kind: "dir",
    });
    const changedFn = result.candidates.find((c) => c.candidate_meta.is_workload_reachable);
    expect(changedFn).toBeDefined();
    // 変更ファイル impl.js が穴あけ対象 (__HOLED__)、entry は index.js
    expect(changedFn!.setup).toContain('globalThis.__HOLED__["impl.js"]');
    expect(changedFn!.setup).toContain('globalThis.__SUT__ = __mapRequire__(\'\')("./index");');
    expect(changedFn!.slow).toContain("return 1;");
    expect(changedFn!.fast).toContain("return 2;");
  });

  it("test_case が無いと fallback (lib top-level diff)", () => {
    const result = preprocess({
      kind: "server",
      before_test_case: null,
      after_test_case: null,
      lib_before_files: { "x.js": "module.exports = function () { return 1; };" },
      lib_after_files: { "x.js": "module.exports = function () { return 2; };" },
      lib_kind: "file",
    });
    expect(result.issue_meta?.aspect).toBe(ASPECT.FALLBACK);
  });
});
