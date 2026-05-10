/**
 * 対象: createConsoleHook (vm 用の console 差し替えフック) / hookJsdomConsole (jsdom window.console の上書き)
 * 観点: console.log/error/warn/info/debug の呼び出しが method + args の順序込みで sink に記録されること
 * 判定事項:
 *   - createConsoleHook: 5 メソッドそれぞれが sink に push、引数はそのまま保持
 *   - hookJsdomConsole: jsdom window の console を上書きし、呼び出しが同じ sink に記録される
 */
import { describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";
import {
  createConsoleHook,
  hookJsdomConsole,
} from "../../../../../src/equivalence-checker/common/sandbox/capture/console-hook";
import type { ConsoleCall } from "../../../../../src/equivalence-checker/common/sandbox/capture/types";

describe("createConsoleHook", () => {
  it("console.* の呼び出しが method + args で sink に蓄積される", () => {
    const sink: ConsoleCall[] = [];
    const hook = createConsoleHook(sink);
    hook.log("a", 1);
    hook.error({ x: 2 });
    hook.warn("w");
    hook.info("i");
    hook.debug("d");
    expect(sink).toHaveLength(5);
    expect(sink[0]).toEqual({ method: "log", args: ["a", 1] });
    expect(sink[1]?.method).toBe("error");
    expect(sink[4]?.method).toBe("debug");
  });
});

describe("hookJsdomConsole", () => {
  it("jsdom window の console を上書きして呼び出しを記録する", () => {
    const dom = new JSDOM("<!doctype html><html><body></body></html>");
    const consoleObj = dom.window.console as unknown as {
      log: (...args: unknown[]) => void;
      error: (...args: unknown[]) => void;
    };
    const sink: ConsoleCall[] = [];
    hookJsdomConsole(dom, sink);
    consoleObj.log("hello", 42);
    consoleObj.error("oops");
    expect(sink).toHaveLength(2);
    expect(sink[0]).toEqual({ method: "log", args: ["hello", 42] });
    expect(sink[1]?.method).toBe("error");
  });
});
