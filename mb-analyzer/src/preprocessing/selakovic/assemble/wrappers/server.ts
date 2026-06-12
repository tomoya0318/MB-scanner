import { wrapBoundaryVarsStatement } from "../recorder-hooks";

/**
 * server `test_case_*.js` の `(setup, before, after)` の before/after 部 (= runnable program) を組み立てる。
 *
 * `test_case_*.js` の内容を「module/exports/require を与えて評価 → init()/setupTest()/test() を
 * 実行 → 観測値を JSON で return」する自己完結 IIFE に包む。`require('./<lib>_*.js')` は実行環境
 * (jsdom executor) が `module_base_dir` 起点で解決する (= グローバル `require`)。`test()` を呼ぶ直前に
 * `globalThis.__recorder` があれば `init()`/`setupTest()` の戻り値 (= SUT 由来オブジェクト) を記録 Proxy で
 * 包む (C6 interaction-trace の取得側 — `recorder-hooks.ts`)。注入されなければ素通り。
 *
 * init/setupTest/test のどれかが throw したら、観測値 envelope を return せず**元の失敗を表す例外を
 * 投げ直す**。envelope (`{test:'<<undefined>>', ..., exception:{...}}`) を return 値として晒すと、
 * 両側が同じエラーで落ちたとき「両側が同じ envelope を返した = equal」と等価判定が誤認する
 * (ADR-0018 の positive-evidence 規則を欺く)。投げ直せば `capture.exception` が立ち、exception oracle で
 * 比較される → 両側同じく落ちたなら inconclusive(both-sides-threw) / 別々に落ちたなら not_equal、と正しく扱える。
 */
export function buildServerRunnable(testCaseSource: string): string {
  return [
    "(function () {",
    "var __selakovic_module = { exports: {} };",
    "var __selakovic_require = (typeof require === 'function') ? require : function () { return {}; };",
    "(function (module, exports, require) {",
    testCaseSource,
    "})(__selakovic_module, __selakovic_module.exports, __selakovic_require);",
    "var __selakovic_exp = __selakovic_module.exports;",
    "var __selakovic_tryJson = function (v) { try { return JSON.stringify(v); } catch (e) { return '<<unserializable>>'; } };",
    "var __selakovic_i, __selakovic_s, __selakovic_r, __selakovic_ex = null;",
    "try {",
    "  __selakovic_i = (typeof __selakovic_exp.init === 'function') ? __selakovic_exp.init() : undefined;",
    "  __selakovic_s = (typeof __selakovic_exp.setupTest === 'function') ? __selakovic_exp.setupTest(__selakovic_i) : undefined;",
    "  " + wrapBoundaryVarsStatement([["__selakovic_i", "init"], ["__selakovic_s", "setup"]]),
    "  __selakovic_r = (typeof __selakovic_exp.test === 'function') ? __selakovic_exp.test(__selakovic_i, __selakovic_s) : undefined;",
    "} catch (e) {",
    "  __selakovic_ex = { name: (e && e.name) || 'Error', message: (e && e.message) || String(e) };",
    "}",
    "if (__selakovic_ex !== null) { var __selakovic_err = new Error(__selakovic_ex.message); __selakovic_err.name = __selakovic_ex.name; throw __selakovic_err; }",
    "return JSON.stringify({ test: (__selakovic_r === undefined ? '<<undefined>>' : __selakovic_r), init: __selakovic_tryJson(__selakovic_i), setup: __selakovic_tryJson(__selakovic_s), exception: null });",
    "})()",
  ].join("\n");
}

// 判断: ai-guide/adr/0007-in-source-testing-internal-helpers.md
if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;

  describe("buildServerRunnable (in-source)", () => {
    it("test_case を module/exports/require 付き IIFE で評価し観測値 envelope を return する", () => {
      const code = buildServerRunnable("exports.test = function () { return 42; };");
      expect(code.startsWith("(function () {")).toBe(true);
      expect(code.trimEnd().endsWith("})()")).toBe(true);
      expect(code).toContain("exports.test = function () { return 42; };");
      expect(code).toContain("__selakovic_exp.init");
      expect(code).toContain("__selakovic_exp.setupTest(__selakovic_i)");
      expect(code).toContain("__selakovic_exp.test(__selakovic_i, __selakovic_s)");
      expect(code).toContain('JSON.stringify({ test: (__selakovic_r === undefined ? \'<<undefined>>\' : __selakovic_r)');
    });

    it("init/setupTest/test を呼ぶ直前に記録 Proxy で境界オブジェクトを wrap する", () => {
      const code = buildServerRunnable("exports.init = function () { return {}; };");
      expect(code).toContain("typeof globalThis.__recorder === 'object'");
      expect(code).toContain('__selakovic_i = globalThis.__recorder.wrap(__selakovic_i, "init", { recurse: true });');
    });

    it("内部 (init/setupTest/test) が throw したら envelope を返さず元の失敗を re-throw する", () => {
      const code = buildServerRunnable("exports.init = function () { throw new Error('boom'); };");
      // catch で握りつぶした後、__selakovic_ex があれば名前/メッセージを引き継いだ Error を投げ直す
      expect(code).toContain("if (__selakovic_ex !== null) { var __selakovic_err = new Error(__selakovic_ex.message); __selakovic_err.name = __selakovic_ex.name; throw __selakovic_err; }");
      // 成功パスの return では exception フィールドは常に null (失敗時はそこに到達しない)
      expect(code).toContain("exception: null });");
      expect(code).not.toContain("exception: __selakovic_ex");
    });
  });
}
