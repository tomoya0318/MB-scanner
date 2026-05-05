/**
 * 対象: createStabilizedContext (vm context を作り、非決定性 API の遮断・固定化・console 記録 + Proxy-based undefined stub を仕込む)
 * 観点: 2 回の実行で同じ入力から同じ観測値が得られ、未定義 global identifier も ReferenceError を起こさず吸収されること
 * 判定事項:
 *   - Math.random: 決定的シードで同一値列、値域 [0, 1)、互いに異なる
 *   - Date.now / new Date() / performance.now はすべて FROZEN_EPOCH_MS を返す
 *   - setTimeout / setInterval の callback は呼ばれない (timer 実行禁止)
 *   - process / require / eval / Function などの host 逃げ道は stub に化けて no-op に潰れる
 *   - `Function("…")()` は別 realm の本物 Function に解決せず stub を返す (任意コード実行を遮断)
 *   - 任意の未定義 identifier は Proxy stub に解決され、`.prop` / `()` / `new` を全部吸収
 *   - ECMAScript 標準 builtins (Object/Array/Math/JSON 等) は stub に化けない
 *   - 複数 sandbox 間で builtin prototype の汚染 (Object.prototype.poisoned 等) がリークしない
 *   - console.log/error/warn/info/debug は consoleCalls に method+args で蓄積
 *   - baselineKeys に stabilizer 注入済み key が含まれ、new_globals 差分計算の基準点になる
 */
import { describe, expect, it } from "vitest";
import vm from "node:vm";
import { createStabilizedContext } from "../../../src/equivalence-checker/sandbox/stabilizer";

// stabilizer.ts の内部定数と独立に保持。実装値が変わったら本値も追従。
const FROZEN_EPOCH_MS = 0;

describe("createStabilizedContext", () => {
  it("Math.random が同一シードで決定的な値列を返す", () => {
    const first = createStabilizedContext();
    const firstVals = vm.runInContext(
      "[Math.random(), Math.random(), Math.random()]",
      first.context,
    ) as number[];

    const second = createStabilizedContext();
    const secondVals = vm.runInContext(
      "[Math.random(), Math.random(), Math.random()]",
      second.context,
    ) as number[];

    expect(firstVals).toEqual(secondVals);
    expect(new Set(firstVals).size).toBe(3);
    for (const v of firstVals) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it("Date.now / new Date() / performance.now が固定値になる", () => {
    const { context } = createStabilizedContext();
    const res = vm.runInContext(
      "[Date.now(), new Date().getTime(), performance.now()]",
      context,
    ) as number[];
    expect(res).toEqual([FROZEN_EPOCH_MS, FROZEN_EPOCH_MS, FROZEN_EPOCH_MS]);
  });

  it("setTimeout / setInterval の本体は実行されない", () => {
    const { context } = createStabilizedContext();
    const res = vm.runInContext(
      `
      let touched = false;
      setTimeout(() => { touched = true; }, 0);
      setInterval(() => { touched = true; }, 0);
      touched
      `,
      context,
    ) as boolean;
    expect(res).toBe(false);
  });

  it("process / require / eval / Function は stub に化けて host にアクセスしない", () => {
    const { context } = createStabilizedContext();
    // stub は callable な Proxy なので typeof は "function" になる。重要なのは
    // 値が host realm の本物ではなく、副作用を伴わないこと。
    const types = vm.runInContext(
      `[typeof process, typeof require, typeof eval, typeof Function]`,
      context,
    ) as string[];
    expect(types).toEqual(["function", "function", "function", "function"]);

    // require("fs") は実 module を返さず stub のまま。読み書き API も全部吸収される。
    const noEscape = vm.runInContext(
      `
      var fs = require("fs");
      typeof fs.readFileSync === "function" && typeof fs.writeFileSync("x", "y") === "function"
      `,
      context,
    ) as boolean;
    expect(noEscape).toBe(true);

    // eval / Function に渡した文字列はコンパイルも実行もされない (stub の apply は no-op)
    const safeEval = vm.runInContext(
      `
      var sentinel = 0;
      eval("sentinel = 42");
      Function("sentinel = 42")();
      sentinel
      `,
      context,
    ) as number;
    expect(safeEval).toBe(0);

    // Function が builtin fall-through 経由で別 realm の本物 Function に解決していないことを
    // 直接検証: 本物なら `Function("return 42")()` は number 42 を返す。stub なら stub (function)
    // が返る。ここを number にしない (= 真の Function 経路を塞ぐ) のが今回の security 契約。
    const fnCallResult = vm.runInContext(`typeof Function("return 42")()`, context) as string;
    expect(fnCallResult).toBe("function");
  });

  it("複数 sandbox 間で builtin prototype が汚染リークしない", () => {
    // sandbox A で Object.prototype に書き込もうとした後、別 sandbox B で観測する。
    // builtin pool が共有されていても凍結されていれば書き込みは silently 失敗 (or throw) し、
    // どちらにせよ sandbox B から poisoned が見えてはいけない。
    const a = createStabilizedContext();
    vm.runInContext(
      `
      try { Object.prototype.poisoned = 1; } catch (_) { /* frozen なら throw もありうる */ }
      try { Array.prototype.poisoned = 1; } catch (_) {}
      `,
      a.context,
    );

    const b = createStabilizedContext();
    const leaked = vm.runInContext(
      `[({}).poisoned, [].poisoned]`,
      b.context,
    ) as unknown[];
    expect(leaked).toEqual([undefined, undefined]);
  });

  it("未定義 identifier は ReferenceError を起こさず stub に化ける", () => {
    const { context } = createStabilizedContext();
    const res = vm.runInContext(
      `
      [
        typeof angular,
        typeof Ember,
        typeof execute,
        typeof window,
        typeof document,
      ]
      `,
      context,
    ) as string[];
    expect(res).toEqual(["function", "function", "function", "function", "function"]);
  });

  it("stub のプロパティ / 呼び出し / new はすべて吸収される (chain access)", () => {
    const { context } = createStabilizedContext();
    const ok = vm.runInContext(
      `
      // jsperf 慣習: var a = execute(f1, 10);
      var a = execute(function () {}, 10);
      // angular DSL: フレームワーク状態の連鎖呼び出し
      angular.module("x", []).controller("Y", function () {});
      // 動的 require + new
      var Cls = require("./foo").Bar;
      var inst = new Cls();
      // 全段階で throw しなければ true
      typeof a === "function" && typeof inst === "function"
      `,
      context,
    ) as boolean;
    expect(ok).toBe(true);
  });

  it("await stub が無限ループせずに stub を返す (then 抑制)", async () => {
    const { context } = createStabilizedContext();
    const promise = vm.runInContext(
      `(async () => { var x = await foo.bar(); return typeof x; })()`,
      context,
    ) as Promise<string>;
    const result = await promise;
    expect(result).toBe("function");
  });

  it("stub の型変換が定義されており String / + に耐える", () => {
    const { context } = createStabilizedContext();
    const res = vm.runInContext(
      `[String(angular), Number(execute), \`\${require}\`.startsWith("[stub:")]`,
      context,
    ) as [string, number, boolean];
    expect(res[0]).toMatch(/^\[stub:/);
    expect(res[1]).toBe(0);
    expect(res[2]).toBe(true);
  });

  it("ECMAScript 標準 builtins は stub に化けず本物が解決される", () => {
    const { context } = createStabilizedContext();
    const res = vm.runInContext(
      `
      [
        typeof Object,
        typeof Array,
        Array.isArray([1, 2, 3]),
        Math.max(3, 7),
        JSON.stringify({ a: 1 }),
        new Set([1, 2, 2, 3]).size,
        typeof Promise,
        new Error("x").message,
      ]
      `,
      context,
    ) as unknown[];
    expect(res).toEqual([
      "function", "function", true, 7, '{"a":1}', 3, "function", "x",
    ]);
  });

  it("console.log / error 等の呼び出しは consoleCalls に蓄積される", () => {
    const { context, consoleCalls } = createStabilizedContext();
    vm.runInContext(
      `
      console.log("a", 1);
      console.error({x: 2});
      console.warn("w");
      console.info("i");
      console.debug("d");
      `,
      context,
    );
    expect(consoleCalls).toHaveLength(5);
    expect(consoleCalls[0]).toEqual({ method: "log", args: ["a", 1] });
    expect(consoleCalls[1]?.method).toBe("error");
    expect(consoleCalls[4]?.method).toBe("debug");
  });

  it("baselineKeys で stabilizer 注入済み key が追跡できる", () => {
    const { baselineKeys } = createStabilizedContext();
    // 注入: console, Math, Date, timer 系, performance
    for (const k of ["console", "Math", "Date", "setTimeout", "setInterval", "performance"]) {
      expect(baselineKeys.has(k)).toBe(true);
    }
    // 注入していない: process / require / eval / Function は stub fallback で吸収するので
    // baseline には載せない
    for (const k of ["process", "require", "eval", "Function"]) {
      expect(baselineKeys.has(k)).toBe(false);
    }
  });
});
