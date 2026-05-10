import { wrapBoundaryVarsStatement } from "./recorder-hooks";

/**
 * server `test_case_*.js` の `(setup, slow, fast)` の slow/fast 部 (= runnable program) を組み立てる。
 *
 * `test_case_*.js` の内容を「module/exports/require を与えて評価 → init()/setupTest()/test() を
 * 実行 → 観測値を JSON で return」する自己完結 IIFE に包む。`require('./<lib>_*.js')` は実行環境
 * (jsdom executor) が `module_base_dir` 起点で解決する (= グローバル `require`)。`test()` を呼ぶ直前に
 * `globalThis.__recorder` があれば `init()`/`setupTest()` の戻り値 (= SUT 由来オブジェクト) を記録 Proxy で
 * 包む (C6 interaction-trace の取得側 — `recorder-hooks.ts`)。注入されなければ素通り。
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
    "return JSON.stringify({ test: (__selakovic_r === undefined ? '<<undefined>>' : __selakovic_r), init: __selakovic_tryJson(__selakovic_i), setup: __selakovic_tryJson(__selakovic_s), exception: __selakovic_ex });",
    "})()",
  ].join("\n");
}
