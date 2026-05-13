/**
 * `console.*` の呼出列を記録する instrumentation (C3 = external-observation oracle の取得側)。
 * vm context 用には差し替え用オブジェクトを生成し、jsdom 用には既存 `window.console` を上書きする。
 */
import type { JSDOM } from "jsdom";

import type { ConsoleCall, ConsoleMethod } from "./types";

const CONSOLE_METHODS: readonly ConsoleMethod[] = ["log", "error", "warn", "info", "debug"];

/** vm sandbox に `console` として渡すフック。各メソッドが `sink` に push する。 */
export function createConsoleHook(sink: ConsoleCall[]): Record<ConsoleMethod, (...args: unknown[]) => void> {
  const hook = {} as Record<ConsoleMethod, (...args: unknown[]) => void>;
  for (const method of CONSOLE_METHODS) {
    hook[method] = (...args: unknown[]) => {
      sink.push({ method, args });
    };
  }
  return hook;
}

/** jsdom window の `console.*` を `sink` に push するフックで上書きする。 */
export function hookJsdomConsole(dom: JSDOM, sink: ConsoleCall[]): void {
  const console = dom.window.console as unknown as Record<string, (...args: unknown[]) => void>;
  for (const method of CONSOLE_METHODS) {
    console[method] = (...args: unknown[]) => {
      sink.push({ method, args });
    };
  }
}

// 判断: ai-guide/adr/0007-in-source-testing-internal-helpers.md
if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;
  // 観点: console.log/error/warn/info/debug の呼び出しが method + args (順序込み) で sink に記録されること。

  describe("createConsoleHook (in-source)", () => {
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

  describe("hookJsdomConsole (in-source)", () => {
    it("jsdom window の console を上書きして呼び出しを同じ sink に記録する", () => {
      const sink: ConsoleCall[] = [];
      const fakeDom = { window: { console: {} } } as unknown as JSDOM;
      hookJsdomConsole(fakeDom, sink);
      const consoleObj = fakeDom.window.console as unknown as {
        log: (...args: unknown[]) => void;
        error: (...args: unknown[]) => void;
      };
      consoleObj.log("hello", 42);
      consoleObj.error("oops");
      expect(sink).toHaveLength(2);
      expect(sink[0]).toEqual({ method: "log", args: ["hello", 42] });
      expect(sink[1]?.method).toBe("error");
    });
  });
}
